// File viewer/editor pane: props {path, line?, on?}. Markdown preview, code/text editor, images,
// windowed read-only view for large files, CAS save with conflict handling and draft autosave.
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, Scrollbar, v_virtual_list, VirtualListScrollHandle, InputState, Input } from "gpui-base";
import { props, focused, panes, exec, readTextFile, writeTextFile, watchFolder, theme, settings, appHome, home, run, openOverlay, shared, setShared, nextCommand, window } from "herdr";
import * as fs from "fs/promises";
import { MAX_BYTES, utf8Length, isBinary } from "./lib/lang.js";
import { denyReason, stripControl } from "./lib/guard.js";
import { resolveIcon, iconPath } from "./lib/icons.js";
import { tilde, parent } from "./lib/paths.js";
import {
  IMAGE_MAX, WINDOW_LINES, LINK_KEY, normalizeTarget, nameOf, extOf, kindOf, languageOf, redactInfo, parseCount, readOnlyReason,
  splitLines, lineWindow, parseLineInput, classifyLink, displayUrl, linkMode, draftName, cachePrefix, cacheName, draftOffer, makeDraft,
  formatBytes, ago, saveErrorKind, shortError, lineTotal, launchRisk, revealLabel, revealArgv, openArgv, openerWorked, openError, readError, explorerProblem,
  windowsParts, winLinkArgv, WIN_LINK_PLAIN, WIN_LINK_MARK, fnv1a, notFound,
} from "./model.js";
import { lineDiff } from "./diff.js";
import {
  RELOAD_MS, RELOAD_LARGE_MS, POLL_MS, MISSING_RETRY_MS, REARM_MS, RELOADED_MS, OPEN_KEY, SLOTS_KEY, SLOTS_MAX, OPEN_CHECK_MS, ACK_BY_MS, RESULTS, TEXT,
  held, reloadAction, watchDir, batchHits, batchNames, openMessage, planOpen, withSlot, slotStart, validSlot, parseCksum, pollDelay, checkDelay, clampRange, nextRearm,
} from "./reload.js";
import { TYPE, mono, metaColor, panelHeader, emptyState, button, iconButton } from "./lib/panel-ui.js";

const MOD = "drover-viewer";
const WINDOW_BYTES = 4 * 1024 * 1024;
const RASTER_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const UI = (name) => `mods/${MOD}/ui/${name}.svg`;
const MODE_LABEL = { preview: "Preview", source: "Source", edit: "Editor", lines: "Lines", image: "Image" };
// The Windows block's message for a path through a link or junction: a live reload drops the file on it.
const LINKED = "This path goes through a link or junction, which could lead to a credential file, so it is not opened.";
// Statuses whose file passed the gate and is shown: a click on the same file there needs no new load.
const SHOWN = ["text", "large", "image", "binary", "info"];
// Copies share module scope: the copy the user touched last, and which pane each copy is in.
let active = null;
const claims = new Map();
const dataDir = () => `${appHome()}/data/${MOD}`;
const platform = () => window()?.platform ?? "macos";
// Windows has no exec bit: there, launch risk goes by the extension alone.
const isExecutable = async (p) => platform() !== "windows" && (await exec("test", ["-x", p], { timeout: 5000 }).catch(() => ({ code: 1 }))).code === 0;
const visible = (s) => stripControl(s).replace(/\t/g, "    ");

export default class Viewer extends View {
  init(_props, cx) {
    this.id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    this.history = [];
    this.gen = 0;
    this.chooser = false;
    this.lineHandle = VirtualListScrollHandle.new();
    this.goto = InputState.new({ placeholder: "Go to line" });
    this.goto.on("submit", (_e, cx) => { this.gotoLine(this.goto.value(), cx); cx.notify(); });
    this.watchGen = 0;
    active = this.id;
    this.claim();
    // Preview reuse: only a viewer split with a slot id listens for open messages; one without stays pinned.
    const p = props() ?? {};
    this.slot = validSlot(p.slot) ? p.slot : null;
    this.preview = Boolean(this.slot) && p.preview === true;
    this.lastSeq = 0;
    let start = p;
    if (this.slot) {
      // A retarget survives a restart: the slot entry names the file shown last, and it goes through the same gate.
      const s = slotStart(shared(SLOTS_KEY), this.slot);
      if (s) { start = { path: s.path, on: s.on }; this.preview = s.preview; this.lastSeq = s.seq; }
    }
    this.ackSeq = this.lastSeq;
    // What the slot entry last said (or what drover-files split this pane with): a write happens only when it changes.
    this.sent = { dirty: false, preview: this.preview, result: null };
    this.open(normalizeTarget(start, home(), platform()), cx);
    cx.timer.every(1500, (cx) => { if (this.draftDue) cx.spawn(async (cx) => { await this.flushDraft(); cx.notify(); }); });
    if (this.slot) cx.timer.every(OPEN_CHECK_MS, (cx) => this.checkOpen(cx));
    cx.spawn(async (cx) => {
      try { this.chooser = await fs.exists(`${appHome()}/mods/drover-open/main.js`); } catch (e) { this.chooser = false; }
      cx.notify();
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (this.closed) return;
        this.command(c, cx);
        cx.notify();
      }
    });
  }

  // Learns this copy's pane while it is the focused viewer pane nobody else has claimed.
  claim() {
    if (this.pane) return;
    const f = focused();
    if (!f?.pane || claims.has(f.pane)) return;
    if (panes().find((p) => p.pane === f.pane)?.mod !== MOD) return;
    claims.set(f.pane, this.id);
    this.pane = f.pane;
  }

  // Key commands reach every shown copy: only the focused (else most recently used) one acts.
  shouldAct() {
    const f = focused(), owner = f?.pane ? claims.get(f.pane) : undefined;
    return owner ? owner === this.id : active === this.id;
  }

  command(c, cx) {
    if (c === "focus" || !this.shouldAct()) return;
    if (c === "save") cx.spawn(async (cx) => { await this.save(cx); cx.notify(); });
    else if (c === "toggle") this.toggleMode();
    else if (c === "revert") this.revert(cx);
    else if (c === "reload") cx.spawn(async (cx) => { await this.reload(cx); cx.notify(); });
    else if (c === "back") this.back(cx);
    else if (c === "keep-open") this.keepOpen();
  }

  reset(target) {
    this.stopWatch();
    this.editor?.release();
    this.editor = null;
    this.gen++;
    this.target = target;
    this.status = target.error ? "empty" : "loading";
    this.message = target.error ?? null;
    this.real = target.path ?? null;
    this.kind = target.path ? kindOf(target.path) : null;
    this.bytes = null; this.total = null; this.exe = false; this.disk = null; this.expected = null; this.shown = null;
    this.ro = null; this.redacted = 0; this.modes = []; this.mode = null; this.dirty = false;
    this.conflict = null; this.diff = null; this.offer = null; this.note = null; this.error = null;
    this.confirmRevert = false; this.lines = null; this.win = null; this.image = null; this.draftDue = false;
    this.fit = target.path ? extOf(target.path) === "svg" : false;
    this.focusLine = null; this.scrollPending = null; this.previewText = null; this.previewRev = (this.previewRev ?? 0) + 1;
    // Live reload state: the on-disk change banner, a deleted file, a path that now leads elsewhere, the remote poll.
    this.outside = null; this.gone = false; this.away = false; this.flash = false; this.dismissed = null; this.paused = false;
    this.checking = false; this.recheck = false; this.named = false; this.checkTimer = null; this.lastCheck = null;
    this.sig = undefined; this.sizeOnly = false; this.pollFails = 0; this.seenBytes = null;
  }

  open(target, cx, pre) {
    this.reset(target);
    if (!target.error) {
      const gen = this.gen;
      cx.spawn(async (cx) => { await this.load(gen, pre); if (this.live(gen)) { this.startWatch(cx); this.syncSlot(); } cx.notify(); });
    } else this.syncSlot();
  }

  live(gen) { return gen === this.gen && !this.closed; }

  // The checks every read goes through: the first load, each live reload, and a preview retarget before it happens.
  // Credential names, links, then the size. `target` defaults to the shown one. -> {ok: true, real, bytes} or
  // {status, message, real?, link?}; null once the view moved on.
  // pathGate runs on a probe that inherits from this view, so the shared Windows block's writes to this.status and
  // this.message land on the probe: a failed check never touches the shown file.
  async gate(gen, target = this.target) {
    const probe = Object.create(this);
    probe.target = target;
    const g = await this.pathGate.call(probe, gen);
    if (!this.live(gen)) return null;
    if (Object.prototype.hasOwnProperty.call(probe, "status")) return { status: probe.status, message: probe.message ?? null, link: probe.message === LINKED };
    return g ?? null;
  }

  // Called with `this` set to a probe (see gate). The Windows block below is byte-identical to the pre-wave-2 copy.
  async pathGate(gen) {
    const t = this.target, on = t.on;
    try {
      // A link opened from a file skips normalizeTarget, so local Windows trims the parts here too.
      const win = !on && platform() === "windows";
      const w = win ? windowsParts(t.path) : null;
      if (win && !w) { this.status = "error"; this.message = "Not opened: the path must be a full drive path such as C:\\Users\\you\\notes.txt"; return; }
      if (w?.error) { this.status = "error"; this.message = "Not opened: the path has " + w.error; return; }
      const path = w ? w.path : t.path;
      let why = denyReason(path);
      if (why) { this.status = "denied"; this.message = why; return; }
      let real = path;
      // Git for Windows' realpath answers in its own /c/... form, which the host can't read: keep the lexical path there.
      if (!win) {
        try {
          const r = await exec("realpath", [path], { on, timeout: 5000 });
          const out = r.code === 0 ? r.stdout.trim() : "";
          if (out.startsWith("/") && !out.includes("\n")) real = out;
        } catch (e) { /* lexical path stands */ }
      } else {
        // Without realpath a link or junction could lead to a credential file unseen, so it is refused, and so is a path
        // the check couldn't finish on.
        const r = await exec(...winLinkArgv(path), { timeout: 15000 }).catch(() => null);
        if (!this.live(gen)) return;
        const out = r?.code === 0 ? String(r.stdout ?? "").trim() : "";
        if (out !== WIN_LINK_PLAIN) {
          this.status = "error";
          this.message = out === WIN_LINK_MARK ? "This path goes through a link or junction, which could lead to a credential file, so it is not opened." : "Couldn't check this path for links, so it is not opened.";
          return;
        }
      }
      if (!this.live(gen)) return null;
      why = denyReason(real);
      if (why) return { status: "denied", message: why, moved: real };
      const wc = await exec("wc", ["-c", real], { on, timeout: 10000 });
      if (!this.live(gen)) return null;
      if (wc.code !== 0) {
        const err = String(wc.stderr || "");
        const status = /no such file/i.test(err) ? "missing" : /is a directory/i.test(err) ? "folder" : "error";
        return { status, real, message: status === "error" ? (/permission/i.test(err) ? "Permission denied" : "Can't read this file") : null };
      }
      return { ok: true, real, bytes: parseCount(wc.stdout) };
    } catch (e) {
      this.status = "error"; this.message = readError(e, platform(), on);
      return null;
    }
  }

  // `pre` is a gate result the caller already has for this target (a preview retarget checks before it changes anything).
  async load(gen, pre) {
    const t = this.target, on = t.on;
    try {
      const g = pre ?? await this.gate(gen);
      if (!g || !this.live(gen)) return;
      if (g.real) { this.real = g.real; this.kind = kindOf(g.real); }
      if (!g.ok) { this.status = g.status; this.message = g.message; return; }
      const real = g.real;
      this.bytes = g.bytes;
      this.exe = on ? false : await isExecutable(real);
      if (!this.live(gen)) return;
      if (this.kind === "image") return await this.loadImage(gen);
      if (this.bytes > MAX_BYTES) return await this.loadWindow(gen, t.line || 1);
      let text;
      try { text = await readTextFile(real, { on }); }
      catch (e) {
        if (!this.live(gen)) return;
        const m = shortError(e);
        if (/utf-?8/i.test(m)) { this.status = "binary"; return; }
        if (/exceeds 1 MiB/i.test(m)) return await this.loadWindow(gen, t.line || 1);
        this.status = "error"; this.message = m;
        return;
      }
      if (!this.live(gen)) return;
      if (text === null) { this.status = "missing"; return; }
      if (isBinary(text)) { this.status = "binary"; return; }
      this.setText(text);
      this.status = "text";
      this.modes = this.kind === "markdown" ? ["preview", "source"] : ["edit", "lines"];
      if (this.kind === "markdown") this.setMode("preview");
      else if (t.line) { this.focusLine = t.line; this.setMode("lines"); }
      else this.setMode("edit");
      await this.readDraft(gen);
    } catch (e) {
      if (this.live(gen)) { this.status = "error"; this.message = readError(e, platform(), on); }
    }
  }

  setText(text) {
    const r = redactInfo(text);
    this.disk = text; this.expected = text; this.shown = r.text; this.redacted = r.count;
    this.ro = readOnlyReason({ on: this.target.on, redacted: r.count, bytes: this.bytes, text });
    this.dirty = false;
    this.makeEditor();
  }

  makeEditor() {
    this.editor?.release();
    const t = theme(), value = this.ro ? this.shown : this.disk, plain = languageOf(this.real) === "plain";
    const state = EditorState.new({
      language: languageOf(this.real), value, readonly: Boolean(this.ro), soft_wrap: plain,
      font_family: settings().font_family, font_size: TYPE.md,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
    });
    if (!this.ro && state.value() !== value) {
      // The editor would change the text (line endings, encoding): saving would rewrite it.
      state.release();
      this.ro = readOnlyReason({ roundTrip: false });
      return this.makeEditor();
    }
    state.on("change", (_e, cx) => this.changed(cx));
    state.on("focus", () => { active = this.id; this.claim(); });
    this.editor = state;
  }

  changed(cx) {
    if (!this.editor || this.ro) return;
    const dirty = this.editor.value() !== this.disk;
    // A clean buffer that stays clean (a live reload putting the disk text in) is not an edit.
    if (!dirty && !this.dirty) return;
    this.dirty = dirty;
    this.draftDue = true;
    this.confirmRevert = false;
    this.note = null;
    // Any edit keeps a preview open: it is pinned from here on.
    if (dirty) this.preview = false;
    this.syncSlot();
    cx.notify();
  }

  setMode(m) {
    if (!this.modes.includes(m)) return;
    this.mode = m;
    const current = this.editor ? this.editor.value() : this.disk ?? "";
    if (m === "preview") { this.previewText = this.ro ? this.shown : redactInfo(current).text; this.previewRev++; }
    if (m === "lines" && this.status !== "large") {
      this.lines = splitLines(visible(this.ro ? this.shown : redactInfo(current).text));
      this.win = null;
      if (this.focusLine) { this.focusLine = Math.min(this.focusLine, Math.max(1, this.lines.length)); this.scrollPending = this.focusLine - 1; }
    }
  }

  toggleMode() {
    if (this.modes.length < 2 || this.diff) return;
    this.setMode(this.modes[(this.modes.indexOf(this.mode) + 1) % this.modes.length]);
  }

  async loadImage(gen) {
    if (this.target.on) { this.status = "info"; this.message = "Image previews work for files on this machine"; return; }
    if (this.bytes > IMAGE_MAX) { this.status = "info"; this.message = `Image is ${formatBytes(this.bytes)}; previews stop at ${formatBytes(IMAGE_MAX)}`; return; }
    if (extOf(this.real) !== "svg") {
      // An image extension on content that is not an image would render blank: show the binary card instead.
      let mime = null;
      try { const r = await exec("file", ["-b", "--mime-type", this.real], { timeout: 10000 }); if (r.code === 0) mime = String(r.stdout).trim().toLowerCase(); } catch (e) { mime = null; }
      if (!this.live(gen)) return;
      if (mime && !RASTER_MIME.has(mime)) { this.status = "binary"; return; }
    }
    await this.copyImage();
    if (!this.live(gen)) return;
    this.status = "image";
    this.modes = ["image"];
    this.mode = "image";
    if (extOf(this.real) === "svg" && this.bytes <= MAX_BYTES) {
      let text = null;
      try { text = await readTextFile(this.real); } catch (e) { text = null; }
      if (!this.live(gen)) return;
      if (typeof text === "string" && !isBinary(text)) {
        this.setText(text);
        this.modes = ["image", "source"];
        await this.readDraft(gen);
      }
    }
  }

  // image() only loads appHome-relative paths: copy under data/, a new name each time so it refreshes.
  async copyImage() {
    const dir = `${dataDir()}/cache`, prefix = cachePrefix(this.real, null), name = cacheName(this.real, null, Date.now(), extOf(this.real));
    await fs.mkdir(dir, { recursive: true });
    const r = await exec("cp", [this.real, `${dir}/${name}`], { timeout: 20000 });
    if (r.code !== 0) throw new Error("Can't copy the image for a preview");
    for (const f of await fs.readdir(dir)) if (f.startsWith(prefix) && f !== name) { try { await fs.unlink(`${dir}/${f}`); } catch (e) { /* in use or gone */ } }
    this.image = `data/${MOD}/cache/${name}`;
  }

  // Large files: a read-only window of lines around `line` (or from `start`), via sed.
  async loadWindow(gen, line, start) {
    const on = this.target.on;
    this.ro = readOnlyReason({ bytes: Math.max(this.bytes ?? 0, MAX_BYTES + 1) });
    if (this.total == null) {
      const r = await exec("wc", ["-l", this.real], { on, timeout: 20000 });
      if (!this.live(gen)) return;
      const tail = await exec("tail", ["-c", "1", this.real], { on, timeout: 10000 }).catch(() => null);
      if (!this.live(gen)) return;
      this.total = Math.max(1, lineTotal(parseCount(r.stdout) ?? 0, tail?.code === 0 ? String(tail.stdout) : null));
    }
    const w = start ? { start: Math.max(1, start), end: Math.min(this.total, Math.max(1, start) + WINDOW_LINES - 1) } : lineWindow(line, this.total);
    const r = await exec("sh", ["-c", 'sed -n "$1,$2p" "$3" | head -c "$4"', MOD, String(w.start), String(w.end), this.real, String(WINDOW_BYTES)], { on, timeout: 20000 });
    if (!this.live(gen)) return;
    if (r.code !== 0) { this.status = "error"; this.message = "Can't read this file"; return; }
    if (isBinary(r.stdout)) { this.status = "binary"; return; }
    const red = redactInfo(r.stdout);
    this.redacted = red.count;
    this.lines = splitLines(visible(red.text));
    this.win = { start: w.start, end: w.start + Math.max(0, this.lines.length - 1) };
    this.status = "large";
    this.modes = ["lines"];
    this.mode = "lines";
    const target = start ? w.start : Math.min(Math.max(1, line), this.win.end);
    this.focusLine = start ? null : target;
    this.scrollPending = target - w.start;
  }

  gotoLine(value, cx) {
    const n = parseLineInput(value);
    if (!n) { this.note = "Enter a line number"; return; }
    if (this.status === "large") {
      if (this.win && n >= this.win.start && n <= this.win.end) { this.focusLine = n; this.scrollPending = n - this.win.start; return; }
      const gen = this.gen;
      cx.spawn(async (cx) => { try { await this.loadWindow(gen, n); } catch (e) { this.error = readError(e, platform(), this.target.on); } cx.notify(); });
      return;
    }
    if (!this.modes.includes("lines")) { this.note = "Line view isn't available for this file"; return; }
    this.focusLine = n;
    this.setMode("lines");
  }

  page(dir, cx) {
    if (this.status !== "large" || !this.win) return;
    const start = dir < 0 ? Math.max(1, this.win.start - WINDOW_LINES) : this.win.end + 1;
    if (start === this.win.start || start > this.total) return;
    const gen = this.gen;
    cx.spawn(async (cx) => { try { await this.loadWindow(gen, start, start); } catch (e) { this.error = readError(e, platform(), this.target.on); } cx.notify(); });
  }

  async readDraft(gen) {
    if (this.ro || !this.editor || this.target.on) return;
    try {
      const raw = await fs.readFile(`${dataDir()}/drafts/${draftName(this.real, null)}`, "utf8");
      if (this.live(gen)) this.offer = draftOffer(JSON.parse(raw), this.real, null, this.disk);
    } catch (e) { /* no draft */ }
  }

  async flushDraft() {
    if (!this.draftDue || !this.editor || this.ro || !this.real || this.target.on) return;
    this.draftDue = false;
    const text = this.editor.value(), dir = `${dataDir()}/drafts`, file = `${dir}/${draftName(this.real, null)}`;
    try {
      if (text === this.disk) { if (await fs.exists(file)) await fs.unlink(file); }
      else { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(file, JSON.stringify(makeDraft(this.real, null, text, this.disk, Date.now()))); }
    } catch (e) { this.error = "Draft autosave failed"; }
  }

  async deleteDraft() {
    if (!this.real) return;
    const file = `${dataDir()}/drafts/${draftName(this.real, null)}`;
    try { if (await fs.exists(file)) await fs.unlink(file); } catch (e) { /* gone already */ }
  }

  async save(cx) {
    // A path that now leads somewhere else is never written through.
    if (!this.editor || this.ro || this.saving || this.target.on || this.away) return;
    const text = this.editor.value();
    if (utf8Length(text) > MAX_BYTES) { this.error = "Can't save: the text is larger than 1 MiB"; return; }
    this.saving = true;
    cx.notify();
    try {
      await writeTextFile(this.real, text, this.expected);
      this.disk = text; this.expected = text; this.dirty = false; this.conflict = null; this.diff = null; this.offer = null;
      this.error = null; this.confirmRevert = false; this.draftDue = false; this.note = "Saved";
      this.outside = null; this.gone = false; this.dismissed = null;
      this.shown = redactInfo(text).text;
      if (this.mode === "preview" || this.mode === "lines") this.setMode(this.mode);
      await this.deleteDraft();
      if (this.status === "image") { try { await this.copyImage(); } catch (e) { this.error = readError(e, platform(), null); } }
    } catch (e) {
      const kind = saveErrorKind(e);
      if (kind === "conflict") { this.conflict = { kept: false }; this.draftDue = true; }
      else if (kind === "size") this.error = "Can't save: larger than 1 MiB";
      else this.error = `Save failed: ${shortError(e)}`;
    } finally { this.saving = false; }
    if (this.conflict) this.outside = null; // the conflict banner says it already
    this.syncSlot();
    // A change seen while saving is looked at now; our own write compares equal to the new disk text.
    if (this.recheck) { this.recheck = false; this.queueCheck(cx, this.watchGen, RELOAD_MS); }
  }

  // Reload discards the buffer, so it is kept as a draft first (offered again after loading).
  async reload(cx) {
    if (this.dirty && this.editor && !this.ro) { this.draftDue = true; await this.flushDraft(); }
    this.open(this.target, cx);
  }

  // Keep my draft: take the current disk text as the new base, so the next Save replaces it.
  async keepDraft() {
    try {
      const fresh = await readTextFile(this.real);
      if (fresh !== null && (isBinary(fresh) || redactInfo(fresh).count)) { this.error = "The file on disk now holds content this viewer won't overwrite. Reload to review it."; return; }
      this.expected = fresh;
      this.disk = fresh ?? "";
      this.dirty = this.editor ? this.editor.value() !== this.disk : false;
      this.conflict = { kept: true };
      this.diff = null;
    } catch (e) { this.error = `Can't read the file: ${shortError(e)}`; }
  }

  async showDiff() {
    try {
      const fresh = await readTextFile(this.real);
      this.diff = lineDiff(redactInfo(fresh ?? "").text, redactInfo(this.editor ? this.editor.value() : "").text);
    } catch (e) { this.error = `Can't read the file for a diff: ${shortError(e)}`; }
  }

  revert(cx) {
    if (!this.editor || this.ro || !this.dirty) return;
    if (!this.confirmRevert) {
      this.confirmRevert = true;
      cx.timer.after(4000, (cx) => { this.confirmRevert = false; cx.notify(); });
      return;
    }
    this.confirmRevert = false;
    this.editor.set_value(this.disk);
    this.dirty = false;
    this.draftDue = false;
    this.offer = null;
    this.syncSlot();
    cx.spawn(async (cx) => { await this.deleteDraft(); cx.notify(); });
  }

  restoreDraft() {
    if (!this.offer || !this.editor || this.ro) return;
    this.editor.set_value(this.offer.text);
    this.dirty = this.offer.text !== this.disk;
    this.offer = null;
    this.draftDue = true;
    if (this.dirty) this.preview = false;
    this.syncSlot();
    this.setMode(this.modes.includes("source") ? "source" : "edit");
  }

  back(cx) {
    if (!this.history.length) return;
    const prev = this.history.pop();
    cx.spawn(async (cx) => {
      if (this.dirty) { this.draftDue = true; await this.flushDraft(); }
      this.open(prev, cx);
      cx.notify();
    });
  }

  openWeb(url, cx) {
    if (linkMode(shared(LINK_KEY)) === "chooser" && this.chooser) {
      try { openOverlay({ mod: "drover-open", kind: "popup", at: "pointer", props: { target: url, kind: "url" } }); return; }
      catch (e) { /* chooser missing: system browser */ }
    }
    try { cx.open_url(url); this.note = `Opened ${displayUrl(url)}`; }
    catch (e) { this.error = "Couldn't open the link"; }
  }

  onLink(url, cx) {
    const l = classifyLink(url, this.real ? parent(this.real) : null, this.target.on ? null : home());
    if (l.kind === "web") this.openWeb(l.url, cx);
    else if (l.kind === "ignore") this.note = l.reason === "unsupported link" ? "Only web links and files open from here" : null;
    else {
      // Local Windows: only a full drive path, with every part trimmed before the credential check.
      const w = !this.target.on && platform() === "windows" ? windowsParts(l.path) : undefined;
      const why = w === null ? "path that is not a full drive path" : w?.error ? "path with " + w.error : denyReason(w ? w.path : l.path);
      if (why) this.error = `Refused to open a ${why}`;
      else if (this.dirty) {
        // The buffer stays here; the linked file opens beside it.
        const p = { path: l.path };
        if (l.line) p.line = l.line;
        if (this.target.on) p.on = this.target.on;
        run("pane.split", { direction: "right", mod: MOD, props: p });
      } else {
        this.history.push(this.target);
        this.open({ path: l.path, line: l.line, on: this.target.on }, cx);
      }
    }
    cx.notify();
  }

  // Why "Open in app" would run the file instead of showing it (scripts, launchers, executables), else null.
  launchRisk() { return this.real ? launchRisk(this.real, { dir: this.status === "folder", executable: Boolean(this.exe), platform: platform() }) : null; }
  systemLabel() { return this.launchRisk() ? revealLabel(platform()) : "Open in app"; }

  openSystem(cx) {
    const p = this.real;
    if (!p || this.target.on || denyReason(p)) return;
    const os = platform();
    const comma = explorerProblem(os, p);
    if (comma) { this.error = comma; cx.notify(); return; }
    cx.spawn(async (cx) => {
      try {
        // The exec bit is read again at click time: it may have changed since the file loaded.
        if (this.status !== "folder") this.exe = await isExecutable(p);
        if (this.launchRisk()) {
          const r = await exec(...revealArgv(os, p, this.status === "folder"), { timeout: 10000 });
          if (!openerWorked(os, r.code)) this.error = "The system couldn't show this file";
          else this.note = `Not opened (${this.launchRisk()}): shown in the file manager instead`;
        } else {
          const r = await exec(...openArgv(os, p), { timeout: 10000 });
          if (!openerWorked(os, r.code)) this.error = "The system couldn't open this file";
        }
      } catch (e) { this.error = openError(e, os); }
      cx.notify();
    });
  }

  copyPath(cx) {
    const p = this.real || this.target.path;
    if (!p) return;
    cx.write_to_clipboard(p);
    this.note = "Path copied";
    cx.notify();
  }

  // ---------- live reload ----------

  // Watched: a file that loaded fine, never a refused one, never the viewer's own image cache.
  watchable() {
    if (this.closed || !this.real || this.target.error) return false;
    if (!["text", "large", "image"].includes(this.status)) return false;
    if (denyReason(this.real) || denyReason(this.target.path)) return false;
    const own = dataDir().replace(/\\/g, "/") + "/", real = String(this.real).replace(/\\/g, "/");
    return this.target.on ? true : !real.startsWith(own);
  }

  watching(wg) { return wg === this.watchGen && !this.closed; }

  stopWatch() {
    this.watchGen = (this.watchGen ?? 0) + 1;
    const w = this.watch;
    this.watch = null;
    try { this.checkTimer?.cancel(); } catch (e) { /* done already */ }
    this.checkTimer = null;
    try { w?.cancel(); } catch (e) { /* settled already */ }
  }

  startWatch(cx) {
    this.stopWatch();
    if (!this.watchable()) return;
    const wg = this.watchGen;
    this.paused = false;
    if (this.target.on) { cx.spawn(async (cx) => { await this.pollRemote(cx, wg); cx.notify(); }); return; }
    const dir = watchDir(this.real);
    cx.spawn(async (cx) => {
      // The first arm looks at the file once.
      let first = true, rearm = REARM_MS;
      for (;;) {
        if (!this.watching(wg)) return;
        let w;
        try { w = watchFolder(dir); } catch (e) { this.pollLocal(cx, wg); return; }
        this.watch = w;
        if (first) { this.queueCheck(cx, wg, RELOAD_MS); first = false; }
        let batch;
        try { batch = await w; } catch (e) {
          // Linux limits, the 64-watch cap, an ignored folder: poll instead.
          if (this.watching(wg)) this.pollLocal(cx, wg);
          return;
        }
        if (!this.watching(wg)) return;
        if (!Array.isArray(batch) || !batch.length) {
          // Released without our cancel: the host reclaimed it. Watch again after a pause that doubles up to the poll
          // interval, and run no check: a host that reclaims idle watches every second would otherwise run the full
          // gate every second. A change inside the pause leaves the view stale until the next hit; saves compare
          // against the text they loaded, so a stale buffer still can't overwrite it.
          await cx.sleep(rearm);
          rearm = nextRearm(rearm);
          continue;
        }
        rearm = REARM_MS;
        if (batchHits(batch, this.real)) {
          if (batchNames(batch, this.real)) this.named = true;
          this.queueCheck(cx, wg, this.status === "large" ? RELOAD_LARGE_MS : RELOAD_MS);
        }
      }
    });
  }

  // Local fallback: look every few seconds (a full check compares text, or size for large files).
  pollLocal(cx, wg) {
    if (!this.watching(wg)) return;
    this.queueCheck(cx, wg, RELOAD_MS);
    cx.timer.after(POLL_MS, (cx) => this.pollLocal(cx, wg));
  }

  // One pending check at a time: hits inside the wait fold into it, and checks keep a gap between them.
  queueCheck(cx, wg, base) {
    if (!this.watching(wg)) return;
    if (this.checking || this.saving) { this.recheck = true; return; }
    if (this.checkTimer) return;
    this.checkTimer = cx.timer.after(checkDelay(base, this.lastCheck, Date.now()), (cx) => {
      this.checkTimer = null;
      cx.spawn(async (cx) => { await this.check(cx, wg); cx.notify(); });
    });
  }

  async check(cx, wg) {
    if (!this.watching(wg)) return;
    if (this.checking || this.saving) { this.recheck = true; return; }
    this.checking = true;
    this.recheck = false;
    try { await this.checkOnce(cx, wg); }
    catch (e) { /* fail closed: nothing changes, the next hit looks again */ }
    finally {
      this.checking = false;
      this.lastCheck = Date.now();
      if (this.recheck && this.watching(wg)) { this.recheck = false; this.queueCheck(cx, wg, RELOAD_MS); }
    }
  }

  async checkOnce(cx, wg) {
    const gen = this.gen, on = this.target.on;
    const ok = () => this.watching(wg) && this.live(gen);
    const named = this.named;
    this.named = false;
    let g = await this.gate(gen);
    if (!g || !ok()) return;
    if (g.status === "missing" || g.status === "folder") {
      // An atomic rename save removes the file for a moment: look once more before calling it gone.
      await cx.sleep(MISSING_RETRY_MS);
      if (!ok()) return;
      g = await this.gate(gen);
      if (!g || !ok()) return;
    }
    // Now refused, or resolving somewhere else: stop watching and keep nothing that could be saved there.
    if (g.status === "denied" || g.link) return this.leave();
    if (g.status === "missing" || g.status === "folder") return this.fileGone();
    if (!g.ok) return; // a check that failed for another reason changes nothing
    if (g.real !== this.real) return this.leave();
    if (this.status === "missing") { this.open(this.target, cx); return; } // it came back
    this.gone = false;
    if (!on) { this.exe = await isExecutable(g.real); if (!ok()) return; }
    if (this.status === "large") return this.largeChanged(g.bytes);
    if (this.status === "image" && !this.editor) {
      if (named || g.bytes !== this.bytes) { this.bytes = g.bytes; await this.copyImage(); }
      return;
    }
    if (g.bytes > MAX_BYTES) return this.largeChanged(g.bytes);
    let text;
    try { text = await readTextFile(g.real, { on }); }
    catch (e) {
      if (!ok()) return;
      const m = shortError(e);
      if (/utf-?8/i.test(m)) return this.becameBinary(g.bytes);
      if (/exceeds 1 MiB/i.test(m)) return this.largeChanged(g.bytes);
      return;
    }
    if (!ok()) return;
    if (text === null) return this.fileGone();
    if (isBinary(text)) return this.becameBinary(g.bytes);
    this.applyText(text, g.bytes, cx);
  }

  // A change the buffer can take, keep beside it, or ignore.
  applyText(text, bytes, cx) {
    if (text === this.disk) { this.outside = null; return; }
    const r = redactInfo(text), ro = readOnlyReason({ on: this.target.on, redacted: r.count, bytes, text });
    const s = { dirty: this.dirty, saving: this.saving, conflict: this.conflict, outside: this.outside, offer: this.offer };
    const action = reloadAction({ ...s, same: false, roChanged: ro !== this.ro });
    if (action === "banner") {
      const sum = fnv1a(text);
      if (this.dismissed === sum || this.conflict) return;
      this.outside = { sum };
      return;
    }
    this.disk = text; this.expected = text; this.shown = r.text; this.redacted = r.count; this.bytes = bytes;
    this.outside = null; this.dismissed = null;
    if (action === "rebuild" || !this.editor) { this.ro = ro; this.makeEditor(); }
    else {
      // Same read-only state: the value changes in place and the cursor stays where it can.
      let range = null;
      try { range = clampRange(this.editor.selected_range(), (this.ro ? this.shown : text).length); } catch (e) { range = null; }
      this.editor.set_value(this.ro ? this.shown : text);
      if (range) { try { this.editor.set_selected_range(range); } catch (e) { /* cursor stays at the start */ } }
    }
    if (this.mode === "preview" || this.mode === "lines") this.setMode(this.mode);
    if (this.status === "image") this.copyImage().catch(() => { this.error = "Can't copy the image for a preview"; });
    this.flash = true;
    const gen = this.gen;
    try { this.flashTimer?.cancel(); } catch (e) { /* done already */ }
    this.flashTimer = cx.timer.after(RELOADED_MS, (cx) => { if (this.gen === gen) this.flash = false; cx.notify(); });
  }

  // Large-file window mode never reloads by itself: a size change only shows the banner.
  largeChanged(bytes) {
    if (bytes === (this.seenBytes ?? this.bytes)) return;
    this.seenBytes = bytes;
    this.outside = { large: true };
  }

  becameBinary(bytes) {
    if (held(this)) { this.outside = { binary: true }; return; }
    this.stopWatch();
    this.editor?.release();
    this.editor = null;
    this.bytes = bytes; this.status = "binary"; this.modes = []; this.mode = null; this.lines = null; this.image = null;
  }

  fileGone() {
    const s = { dirty: this.dirty, saving: this.saving, conflict: this.conflict, outside: this.outside, offer: this.offer };
    if (reloadAction({ ...s, missing: true }) === "missing-banner") { this.gone = true; return; }
    // Clean: the missing card, and the watch stays so the file comes back when it is recreated.
    this.editor?.release();
    this.editor = null;
    this.status = "missing"; this.message = null; this.modes = []; this.mode = null; this.lines = null; this.image = null;
    this.outside = null; this.gone = false; this.diff = null;
  }

  leave() {
    this.stopWatch();
    if (held(this) || this.gone) { this.away = true; this.outside = null; return; }
    this.editor?.release();
    this.editor = null;
    this.status = "error"; this.message = TEXT.away; this.modes = []; this.mode = null; this.lines = null; this.image = null;
    this.outside = null; this.gone = false; this.diff = null; this.disk = null; this.expected = null; this.shown = null;
  }

  // Remote files: a checksum (or the size) every few seconds; slower after failures, paused after many.
  async pollRemote(cx, wg) {
    if (!this.watching(wg)) return;
    const sig = await this.remoteSig().catch(() => null);
    if (!this.watching(wg)) return;
    if (sig === null) this.pollFails++;
    else {
      this.pollFails = 0;
      const changed = this.sig !== undefined && sig !== this.sig;
      this.sig = sig;
      if (changed) await this.check(cx, wg);
    }
    if (!this.watching(wg)) return;
    const delay = pollDelay(this.pollFails);
    if (delay === null) { this.paused = true; return; }
    cx.timer.after(delay, (cx) => cx.spawn(async (cx) => { await this.pollRemote(cx, wg); cx.notify(); }));
  }

  // "crc:size" from cksum for text up to 1 MiB, else "size:n" from wc. Without cksum (a Windows remote) the size is used.
  // A non-zero exit is a state too ("gone"), so a deleted file is noticed. Only these values are kept.
  async remoteSig() {
    const on = this.target.on, real = this.real;
    if (!this.sizeOnly && this.status === "text" && (this.bytes ?? 0) <= MAX_BYTES) {
      try {
        const r = await exec("cksum", [real], { on, timeout: 4000 });
        if (r.code !== 0) return "gone";
        const s = parseCksum(r.stdout);
        if (s) return "sum:" + s;
        this.sizeOnly = true;
      } catch (e) {
        if (!notFound(e)) throw e;
        this.sizeOnly = true;
      }
    }
    const r = await exec("wc", ["-c", real], { on, timeout: 4000 });
    if (r.code !== 0) return "gone";
    const n = parseCount(r.stdout);
    return n === null || n === undefined ? null : "size:" + n;
  }

  retryRemote(cx) {
    this.paused = false;
    this.pollFails = 0;
    this.startWatch(cx);
  }

  reloadFromDisk(cx) { this.outside = null; cx.spawn(async (cx) => { await this.reload(cx); cx.notify(); }); }

  dismissOutside() {
    if (this.outside?.sum) this.dismissed = this.outside.sum;
    this.outside = null;
  }

  // ---------- preview reuse ----------

  // The slot's entry is written on a handled message and when the dirty or preview flag flips, never on a tick.
  syncSlot() {
    if (!this.slot) return;
    const dirty = Boolean(this.dirty);
    if (this.sent.dirty === dirty && this.sent.preview === this.preview) return;
    this.writeSlot(this.sent.result);
  }

  // The entry carries the seq of the last message answered (ackSeq), never one still being checked, so drover-files
  // never reads an older result as the answer to its newer message.
  writeSlot(result) {
    if (!this.slot) return;
    const t = this.target ?? {}, p = typeof t.path === "string" ? t.path : null;
    // A refused path is never put into shared state.
    const path = p && !denyReason(p) && !(this.real && denyReason(this.real)) ? p : null;
    const res = RESULTS.includes(result) ? result : null;
    const entry = { path, on: t.on ?? null, preview: this.preview, dirty: Boolean(this.dirty), seq: this.ackSeq, result: res, at: Date.now() };
    try { setShared(SLOTS_KEY, withSlot(shared(SLOTS_KEY), this.slot, entry, SLOTS_MAX)); } catch (e) { return; }
    this.sent = { dirty: entry.dirty, preview: entry.preview, result: res };
  }

  // Answers message `seq`. An older message never answers after a newer one.
  ack(seq, result) {
    if (seq < this.ackSeq) return;
    this.ackSeq = seq;
    this.writeSlot(result);
  }

  // Reads the open message (render and a 300 ms timer). Only notes the seq here; the work runs after this frame.
  checkOpen(cx) {
    if (!this.slot || this.closed || !cx) return;
    const m = openMessage(shared(OPEN_KEY), { slot: this.slot, lastSeq: this.lastSeq, now: Date.now() });
    if (!m) return;
    this.lastSeq = m.seq;
    cx.timer.after(0, (cx) => { this.handleOpen(m, cx); cx.notify(); });
  }

  // A pin with no path pins the shown file. A retarget (or a click on the shown file) answers "ok" only after the
  // gate passes on the new target, and the view changes only then: a denied, missing or linked target, a check that
  // errors, or one that ends after ACK_BY_MS (drover-files has given up and split a new pane) answers "refused" and
  // leaves this viewer as it was. The gate is the fast part (realpath and wc); content renders after the answer.
  handleOpen(m, cx) {
    if (this.closed) return;
    const target = m.path === null ? null : normalizeTarget({ path: m.path, on: m.on, line: m.line }, home(), platform());
    const invalid = Boolean(target?.error), denied = Boolean(target) && !invalid && Boolean(denyReason(target.path));
    const same = Boolean(target) && !invalid && SHOWN.includes(this.status)
      && target.path === this.target?.path && (target.on ?? null) === (this.target?.on ?? null);
    const plan = planOpen(m, {
      preview: this.preview, same, invalid, denied, dirty: this.dirty, saving: this.saving, conflict: this.conflict,
      outside: this.outside, offer: this.offer, gone: this.gone, away: this.away,
    });
    if (!plan.gate) {
      if (plan.pin) this.preview = false;
      this.ack(m.seq, plan.result);
      return;
    }
    const gen = this.gen;
    cx.spawn(async (cx) => {
      let g = null;
      try { g = await this.gate(gen, plan.retarget ? target : this.target); } catch (e) { g = null; }
      // A newer message answers instead; a closed pane answers nothing.
      if (this.closed || this.lastSeq !== m.seq) return;
      const late = Date.now() > m.at + ACK_BY_MS;
      // Edits, a Keep open click or a navigation made while the gate ran also refuse a retarget.
      const free = !plan.retarget || (this.preview && !held(this));
      if (!g?.ok || late || !this.live(gen) || !free) {
        // Held since the message came (edits, a banner, a draft offer): kept open, as planOpen does for a held viewer.
        if (held(this)) this.preview = false;
        this.ack(m.seq, "refused");
        cx.notify();
        return;
      }
      if (plan.pin) this.preview = false;
      // A preview builds no back stack: the new file replaces this one, and load reuses the gate result.
      if (plan.retarget) this.open(target, cx, g);
      else if (m.line && this.status === "text" && this.modes.includes("lines")) this.gotoLine(String(m.line), cx);
      this.ack(m.seq, plan.result);
      cx.notify();
    });
  }

  keepOpen() {
    if (!this.slot || !this.preview) return;
    this.preview = false;
    this.writeSlot("pinned");
  }

  async close() {
    this.closed = true;
    this.stopWatch();
    if (this.draftDue) { try { await this.flushDraft(); } catch (e) { /* best effort */ } }
    this.editor?.release();
    this.editor = null;
    try { this.flashTimer?.cancel(); } catch (e) { /* done already */ }
    try { this.lineHandle.release(); } catch (e) { /* already released */ }
    for (const [pane, id] of claims) if (id === this.id) claims.delete(pane);
    if (active === this.id) active = null;
  }

  // ---------- rendering ----------

  // Text button (kit): onClick gets cx; the viewer marks itself active first. Only Save is ever primary.
  button(t, id, label, onClick, opts = {}) {
    const on = !("enabled" in opts) || Boolean(opts.enabled);
    const kind = opts.danger && on ? "danger" : opts.primary && on ? "primary" : "secondary";
    const b = button({ id, label, kind, disabled: !on, tooltip: opts.tooltip, onClick: (cx) => { active = this.id; onClick(cx); } }, t);
    return opts.selected ? div().flex_none().rounded(6).bg(t.selected).child(b) : b;
  }

  icon(t, id, icon, label, onClick) {
    return iconButton({ id, icon: UI(icon), label, onClick: (cx) => { active = this.id; onClick(cx); } }, t);
  }

  header(t) {
    const p = this.real || this.target.path, name = p ? nameOf(p) : "Viewer";
    const content = ["text", "image", "large"].includes(this.status);
    const local = Boolean(this.real) && !this.target.on && !denyReason(this.real);
    const meta = this.preview ? TEXT.preview : Boolean(this.ro) && content ? this.ro : undefined;
    const actions = [];
    if (this.status !== "empty") {
      if (content) actions.push({ id: "dv-reload", icon: UI("refresh"), label: "Reload from disk", onClick: (cx) => { active = this.id; cx.spawn(async (cx) => { await this.reload(cx); cx.notify(); }); } });
      if (local && this.status !== "denied") actions.push({ id: "dv-system", icon: UI("open"), label: this.systemLabel(), onClick: (cx) => { active = this.id; this.openSystem(cx); } });
      if (p) actions.push({ id: "dv-copy", icon: UI("copy"), label: "Copy path", onClick: (cx) => { active = this.id; this.copyPath(cx); } });
    }
    return panelHeader({ id: "dv-header", title: name, meta, actions, busy: this.status === "loading" }, t)
      .when(this.preview, (e) => e.child(div().flex_none().pr(8).child(this.button(t, "dv-keep", TEXT.keep, () => this.keepOpen()))));
  }

  pathLine(t) {
    const p = this.real || this.target.path;
    if (!p) return null;
    const icon = denyReason(p) ? iconPath(MOD, "lock") : resolveIcon(MOD, false, nameOf(p));
    const folder = (this.target.on ? `${this.target.on}:` : "") + tilde(parent(p), this.target.on ? "" : home());
    return h_flex().id("dv-path").flex_none().px(12).py(4).gap(8).items_center().text_size(TYPE.xs)
      .child(image(icon).size(14).flex_none())
      .child(mono(div().flex_1().min_w(0).truncate().text_color(metaColor(t))).child(folder))
      .when(this.flash, (e) => e.child(div().id("dv-reloaded").flex_none().text_color(metaColor(t)).child(TEXT.reloaded)))
      .when(this.dirty, (e) => e.child(div().id("dv-dirty").flex_none().text_color(t.accent).child("● Unsaved")));
  }

  toolbar(t) {
    const editable = Boolean(this.editor) && !this.ro;
    const md = this.kind === "markdown" && this.status === "text";
    const back = this.history.length > 0;
    const modes = this.modes.length > 1 && !this.diff;
    if (!back && !modes && !editable && !md) return null;
    return h_flex().id("dv-toolbar").flex_none().flex_wrap().px(12).py(6).gap(6).items_center().border_b(1).border_color(t.border)
      .when(back, (e) => e.child(this.icon(t, "dv-back", "back", "Back", (cx) => this.back(cx))))
      .when(modes, (e) => e.child(h_flex().gap(4).children(this.modes.map((m) =>
        this.button(t, `dv-mode-${m}`, MODE_LABEL[m], () => this.setMode(m), { selected: this.mode === m })))))
      .when(editable, (e) => e
        .child(this.button(t, "dv-save", this.saving ? "Saving…" : this.conflict?.kept ? "Save (replace disk)" : "Save", (cx) => cx.spawn(async (cx) => { await this.save(cx); cx.notify(); }), { primary: true, enabled: (this.dirty || this.conflict?.kept) && !this.saving && !this.away }))
        .when(this.dirty, (e) => e.child(this.button(t, "dv-revert", this.confirmRevert ? "Confirm revert" : "Revert", (cx) => this.revert(cx), { danger: this.confirmRevert }))))
      .child(div().flex_1())
      .when(md, (e) => e.child(this.button(t, "dv-links", linkMode(shared(LINK_KEY)) === "chooser" ? "Links: ask" : "Links: browser", () => setShared(LINK_KEY, linkMode(shared(LINK_KEY)) === "chooser" ? "system" : "chooser"))));
  }

  banner(t, id, color, text, actions = []) {
    return h_flex().id(id).flex_none().flex_wrap().px(12).py(6).gap(8).items_center().border_b(1).border_color(t.border).bg(t.raised)
      .child(div().w(3).h(16).flex_none().rounded(2).bg(color))
      .child(div().flex_1().min_w(120).text_size(TYPE.sm).child(text))
      .children(actions);
  }

  banners(t) {
    const out = [];
    if (this.conflict && !this.conflict.kept) out.push(this.banner(t, "dv-conflict", t.blocked, "The file changed on disk after you opened it. Your edits are kept as a draft.", [
      this.button(t, "dv-conflict-reload", "Reload", (cx) => cx.spawn(async (cx) => { await this.reload(cx); cx.notify(); })),
      this.button(t, "dv-conflict-keep", "Keep my draft", (cx) => cx.spawn(async (cx) => { await this.keepDraft(); cx.notify(); })),
      this.button(t, "dv-conflict-diff", "Show diff", (cx) => cx.spawn(async (cx) => { await this.showDiff(); cx.notify(); })),
    ]));
    if (this.away) out.push(this.banner(t, "dv-away", t.blocked, TEXT.away));
    else if (this.gone) out.push(this.banner(t, "dv-gone", t.blocked, TEXT.gone));
    if (this.outside && !this.conflict && !this.away) {
      const text = this.outside.sum ? TEXT.changed : TEXT.changedLarge;
      out.push(this.banner(t, "dv-outside", t.accent, text, [
        this.button(t, "dv-outside-reload", TEXT.reload, (cx) => this.reloadFromDisk(cx)),
        ...(this.outside.sum ? [this.button(t, "dv-outside-diff", TEXT.diff, (cx) => cx.spawn(async (cx) => { await this.showDiff(); cx.notify(); }))] : []),
        this.button(t, "dv-outside-dismiss", TEXT.dismiss, () => this.dismissOutside()),
      ]));
    }
    if (this.paused) out.push(this.banner(t, "dv-paused", t.blocked, TEXT.paused, [this.button(t, "dv-paused-retry", TEXT.retry, (cx) => this.retryRemote(cx))]));
    if (this.conflict?.kept) out.push(this.banner(t, "dv-kept", t.blocked, "Your draft is kept. Save again to replace the version on disk."));
    if (this.offer) out.push(this.banner(t, "dv-offer", t.accent, `Unsaved draft from ${ago(this.offer.savedAt, Date.now())}${this.offer.stale ? " (the file changed since)" : ""}.`, [
      this.button(t, "dv-offer-restore", "Restore draft", () => this.restoreDraft()),
      this.button(t, "dv-offer-discard", "Discard", (cx) => { this.offer = null; cx.spawn(async (cx) => { await this.deleteDraft(); cx.notify(); }); }),
    ]));
    if (this.redacted > 0 && ["text", "image", "large"].includes(this.status)) out.push(this.banner(t, "dv-redacted", t.blocked,
      `${this.redacted} secret${this.redacted === 1 ? " looks" : "s look"} sensitive and ${this.redacted === 1 ? "is" : "are"} hidden${this.status === "large" ? " in this part" : ""}. Values are never shown; the file opens read-only.`));
    if (this.error) out.push(this.banner(t, "dv-error", t.blocked, this.error, [this.button(t, "dv-error-close", "Dismiss", () => { this.error = null; })]));
    return out;
  }

  card(t, title, body, action) {
    return v_flex().id("dv-card").flex_1().min_h(0).items_center().justify_center()
      .child(emptyState({ id: "dv-empty", title, body }, t))
      .when(Boolean(action), (e) => e.child(div().pb(24).child(action)));
  }

  linesView(t) {
    const lines = this.lines ?? [], base = this.win?.start ?? 1, digits = String(base + lines.length).length;
    const list = mono(div().id("dv-lines-box").flex_1().min_h(0).relative()).text_size(TYPE.sm)
      .child(v_virtual_list("dv-lines", lines.length, 20, (i) => String(base + i), (range) => lines.slice(range.start, range.end).map((l, k) => {
        const n = base + range.start + k;
        return h_flex().h(20).px(8).gap(12).items_center().when(n === this.focusLine, (e) => e.bg(t.selected))
          .child(div().w(digits * 8 + 4).flex_none().text_right().text_color(t.dim).child(String(n)))
          .child(div().flex_1().min_w(0).truncate().child(l || " "));
      })).track_scroll(this.lineHandle).size_full())
      .child(Scrollbar.vertical("dv-lines").absolute().inset_0());
    if (this.scrollPending != null) { this.lineHandle.scroll_to_item(Math.max(0, this.scrollPending), "center"); this.scrollPending = null; }
    const nav = h_flex().id("dv-nav").flex_none().px(12).py(6).gap(8).items_center().border_t(1).border_color(t.border).text_size(TYPE.xs)
      .when(this.status === "large", (e) => e
        .child(this.button(t, "dv-prev", "◀ Prev", (cx) => this.page(-1, cx), { enabled: Boolean(this.win) && this.win.start > 1 }))
        .child(mono(div().text_color(metaColor(t))).child(this.win ? `Lines ${this.win.start.toLocaleString()}–${this.win.end.toLocaleString()} of ${(this.total ?? 0).toLocaleString()} · ${formatBytes(this.bytes)}` : ""))
        .child(this.button(t, "dv-next", "Next ▶", (cx) => this.page(1, cx), { enabled: Boolean(this.win) && this.win.end < (this.total ?? 0) })))
      .when(this.status !== "large", (e) => e.child(mono(div().text_color(metaColor(t))).child(`${lines.length.toLocaleString()} lines`)))
      .child(div().flex_1())
      .child(div().id("dv-goto").w(110).h(24).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.goto).h_full().text_size(TYPE.sm)));
    return v_flex().flex_1().min_h(0).child(list).child(nav);
  }

  diffView(t) {
    const d = this.diff, color = { "+": t.ansi2, "-": t.ansi1, " ": t.foreground, "…": metaColor(t) };
    return v_flex().id("dv-diff").flex_1().min_h(0)
      .child(h_flex().flex_none().px(12).py(6).gap(8).items_center().border_b(1).border_color(t.border).text_size(TYPE.sm)
        .child(mono(div().flex_1()).child(`Disk → your draft: +${d.added} −${d.removed}${d.approximate ? " (too large for a line-by-line match)" : ""}`))
        .child(this.button(t, "dv-diff-close", "Close diff", () => { this.diff = null; })))
      .child(mono(div().flex_1().min_h(0).relative()).text_size(TYPE.sm)
        .child(v_virtual_list("dv-diff-list", d.rows.length, 20, (i) => String(i), (range) => d.rows.slice(range.start, range.end).map((r) =>
          h_flex().h(20).px(8).gap(8).items_center().text_color(color[r.t])
            .when(r.t === "+" || r.t === "-", (e) => e.bg(t.hover))
            .child(div().w(14).flex_none().child(r.t === "…" ? "" : r.t))
            .child(div().flex_1().min_w(0).truncate().child(visible(r.text) || " ")))).size_full())
        .child(Scrollbar.vertical("dv-diff-list").absolute().inset_0()));
  }

  body(t) {
    const local = Boolean(this.real) && !this.target.on;
    const sys = () => this.button(t, "dv-card-system", this.systemLabel(), (cx) => this.openSystem(cx));
    const copy = () => this.button(t, "dv-card-copy", "Copy path", (cx) => this.copyPath(cx));
    const way = () => (local ? sys() : copy());
    switch (this.status) {
      case "empty": return this.card(t, this.message === "No file" ? "No file" : this.message, this.message === "No file" ? "Open a file in this pane with props {path, line?}." : "Paths must be absolute (or start with ~).");
      case "loading": return div().id("dv-loading").flex_none().px(12).py(8).text_size(TYPE.sm).text_color(metaColor(t)).child(`Reading ${this.real ? nameOf(this.real) : "the file"}…`);
      case "denied": return this.card(t, "This file stays closed", `It looks like a ${this.message}. The viewer never opens credential or key files.`, copy());
      case "missing": return this.card(t, "File not found", "It may have been moved or deleted.", copy());
      case "folder": return this.card(t, "This is a folder", null, way());
      case "binary": return this.card(t, "Binary file", `${formatBytes(this.bytes)} · no text preview`, way());
      case "info": return this.card(t, nameOf(this.real), this.message, way());
      case "error": return this.card(t, "Can't open this file", this.message, copy());
      default: break;
    }
    if (this.diff) return this.diffView(t);
    if (this.mode === "lines") return this.linesView(t);
    if (this.mode === "preview") return div().id("dv-preview").flex_1().min_h(0).px(20).py(14)
      .child(TextView.markdown(`dv-md-${this.previewRev}`, this.previewText ?? "").on_link_click((url, cx) => this.onLink(url, cx)).selectable().scrollable().size_full());
    if (this.mode === "image") return v_flex().id("dv-image").flex_1().min_h(0).p(16).gap(8)
      .child(div().id("dv-image-box").flex_1().min_h(0).flex().items_center().justify_center().overflow_hidden()
        .child(this.fit ? image(this.image).size_full() : image(this.image).max_w_full().max_h_full()))
      .child(h_flex().flex_none().gap(8).items_center().text_size(TYPE.xs).text_color(metaColor(t))
        .child(mono(div().flex_1()).child(`${extOf(this.real).toUpperCase()} · ${formatBytes(this.bytes)}`))
        .child(this.button(t, "dv-fit", this.fit ? "Actual size" : "Fit to pane", () => { this.fit = !this.fit; })));
    if (this.editor) return Editor.new(this.editor).flex_1().min_h(0);
    return this.card(t, "Nothing to show", null);
  }

  render(cx) {
    this.checkOpen(cx);
    const t = theme(), path = this.pathLine(t), bar = this.status === "empty" ? null : this.toolbar(t);
    return v_flex().id("dv").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(TYPE.md)
      .on_mouse_down("left", () => { active = this.id; this.claim(); })
      .child(this.header(t))
      .when(Boolean(path), (e) => e.child(path))
      .when(Boolean(bar), (e) => e.child(bar))
      .children(this.banners(t))
      .child(this.body(t))
      .when(Boolean(this.note), (e) => e.child(div().id("dv-note").flex_none().px(12).py(4).text_size(TYPE.xs).text_color(metaColor(t)).child(this.note)));
  }
}
