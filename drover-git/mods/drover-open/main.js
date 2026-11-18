// Open with: a chooser for a link, a path or a piece of text.
// Props: { target?, cwd?, on?, pane?, ask?, mode?: "search" | "editors", query? }.
//   target: the text to open. Without it the clipboard is read (and read again on the
//           "drover-open.clipboard" key command while open).
//   cwd/on/pane: where the text came from (relative paths resolve against cwd; on = machine).
//   ask: always show the chooser, even when a choice is set to "always".
//   mode "editors": "Open in", only the installed editors (and the system app) for a local folder or file.
// ↑/↓ move, Enter runs, 1–9 run that row, A toggles "always", Esc closes.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import {
  props, run, exec, closeOverlay, openOverlay, notify, theme, focused, panes, spaces, home, appHome, window as hostWindow,
  readTextFile, writeTextFile, nextCommand, shared, setShared,
} from "herdr";
import * as fs from "fs/promises";
import { stripControl, redact, denyReason } from "./lib/guard.js";
import { tilde, basename } from "./lib/paths.js";
import { resolveIcon } from "./lib/icons.js";
import {
  EDITOR_KEY, detect, detectCli, whichArgv, whichHits, editorPlatform, listingProbe, lsEntries, editorCache, editorByName, editorOfAction, isEditorAction, editorOpenArgv,
} from "./lib/editors.js";
import {
  parseTarget, actionsFor, prefKey, displayUrl, urlHost, searchQueryFor, revealFolder, systemOpenArgv, systemRevealArgv, infoRisk, finderLabel, missingOpener, explorerProblem,
  describeLocation, reselect, MAX_TEXT,
} from "./classify.js";
import { loadPrefs, savePrefs, withChoice, forgetAll } from "./prefs.js";
import { rgArgv, grepArgv, cleanQuery, parseResults, outcome, MAX_RESULTS } from "./search.js";

const MOD = "drover-open";
const UI = (name) => `mods/${MOD}/ui/${name}.svg`;
const KIND_WORDS = { url: "links", file: "files", dir: "folders", text: "text" };
// Prints the type (d, f or n) and the resolved path of $1. The path is an argument, never part of the script.
const CHECK_SCRIPT =
  'p=$1; if [ -d "$p" ]; then t=d; elif [ -e "$p" ]; then t=f; else t=n; fi; ' +
  'r=$(realpath -- "$p" 2>/dev/null || readlink -f -- "$p" 2>/dev/null || printf %s "$p"); ' +
  'if [ "$t" = f ] && [ -x "$p" ]; then x=x; else x=-; fi; printf "%s\\n%s\\n%s\\n" "$t" "$r" "$x"';
// A key command reaches every open copy; the first to claim it within this window acts, the others do nothing.
const CLAIM_KEY = "drover-open.clipboard-claim";
const CLAIM_MS = 400;

const safe = (fn, fallback = null) => { try { const v = fn(); return v === undefined ? fallback : v; } catch (e) { return fallback; } };
// Text that may be shown: secrets masked, control characters dropped, bounded.
const shown = (text, max = 240) => stripControl(redact(String(text ?? "")).text).slice(0, max);
const errText = (e) => shown(e?.message || e || "failed", 200);
const prefsFile = () => `${appHome()}/data/${MOD}/prefs.json`;
// Installed editors, looked up at most every 10 minutes for this mod's lifetime.
const editors = editorCache();
// fs.stat can't see outside home, so editor apps are found by listing their folders (argv, local).
const lsDir = async (dir) => { const r = await exec("ls", ["-1", dir], { timeout: 5000 }); return r?.code === 0 ? lsEntries(r.stdout) : new Set(); };
// Linux: the editor launchers on PATH, from one `which` call; no `which` finds none.
const whichFound = async () => {
  try { const [c, a] = whichArgv(); const r = await exec(c, a, { timeout: 5000 }); return whichHits(r?.stdout); } catch (e) { return new Set(); }
};
const loadEditors = (ctx) => (ctx.platform === "linux"
  ? whichFound().then((found) => detectCli((cli) => found.has(cli), ctx.platform))
  : detect(listingProbe(lsDir), ctx.home, ctx.platform));
// exec rejects with this when the program is not installed.
const notFound = (e) => /program not found/i.test(String(e?.message || e || ""));
// The system opener (open, xdg-open, explorer.exe), local only. -> { ok, error? }
async function runOpener(cmd, args, platform) {
  let r;
  try {
    r = await exec(cmd, args, { timeout: 15000 });
  } catch (e) {
    if (notFound(e)) return { ok: false, error: missingOpener(cmd) };
    throw e;
  }
  // explorer.exe reports 1 even when it opened the file
  if (r.code !== 0 && platform !== "windows") return { ok: false, error: `${cmd} failed: ${shown((r.stderr || r.stdout || `exit ${r.code}`).trim(), 160)}` };
  return { ok: true };
}
const lastEditor = () => { const v = safe(() => shared(EDITOR_KEY), null); return typeof v === "string" && editorByName(v) ? v : null; };

function claimPress() {
  const now = Date.now(), cur = safe(() => shared(CLAIM_KEY), null);
  if (cur && typeof cur.at === "number" && now - cur.at >= 0 && now - cur.at < CLAIM_MS) return false;
  safe(() => setShared(CLAIM_KEY, { at: now }));
  return true;
}
// The clipboard chooser as its own dialog (no target: it reads the clipboard; ask: never runs "always" silently).
export const openClipboardChooser = () => openOverlay({ mod: MOD, kind: "dialog", width: 420, height: 380, props: { ask: true } });

// Where the text came from: the pane, its folder and its machine.
export function sourceContext(p) {
  const f = safe(() => focused(), null) || {};
  const all = safe(() => panes(), []) || [];
  const pane = typeof p?.pane === "string" && p.pane ? p.pane : f.pane || null;
  const row = pane ? all.find((x) => x.pane === pane) : null;
  const cwd = typeof p?.cwd === "string" && p.cwd.startsWith("/") ? p.cwd : row?.cwd || f.cwd || null;
  let on = null;
  if (p && Object.prototype.hasOwnProperty.call(p, "on")) on = typeof p.on === "string" && p.on ? p.on : null;
  else {
    const spaceId = f.space || null;
    const space = spaceId ? (safe(() => spaces(), []) || []).find((s) => s.id === spaceId) : null;
    on = space?.machine || null;
  }
  return { pane, cwd, on, home: safe(() => home(), "") || "", platform: safe(() => hostWindow().platform, "macos") };
}

export default class DroverOpen extends View {
  init(_props, cx) {
    const p = props() || {};
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.actScroll = ScrollHandle.new();
    this.ctx = sourceContext(p);
    this.overlay = typeof p.overlay === "string" ? p.overlay : null;
    this.fromProps = typeof p.target === "string";
    this.ask = p.ask === true;
    this.editorsMode = p.mode === "editors";
    this.editors = (editorPlatform(this.ctx.platform) && editors.peek(Date.now())) || [];
    this.at = 0;
    this.navigated = false; // the user moved the selection with the arrow keys: list updates keep it
    this.always = false;
    this.alwaysTouched = false;
    this.prefs = { version: 1 };
    this.prefsRaw = null;
    this.prefsReady = false;
    this.busy = false;
    this.status = null; // { level: "info" | "error" | "success", text }
    this.gen = 0;
    this.autoDone = false;
    // search
    this.input = InputState.new({ placeholder: "Search in files…", value: typeof p.query === "string" ? cleanQuery(p.query) : "" });
    this.input.on("submit", (_e, cx) => this.submitSearch(cx));
    this.results = null;
    this.searching = false;
    this.searchGen = 0;
    this.searchMsg = null;
    this.lastQuery = null;
    this.rat = 0;

    if (p.mode === "search") {
      this.mode = "search";
      this.target = null;
      this.input.focus();
      if (cleanQuery(this.input.value())) cx.spawn(async (cx) => this.runSearch(cx));
    } else {
      this.mode = "choose";
      this.handle.focus();
      this.setTarget(this.fromProps ? p.target : this.readClipboard(cx), cx);
    }

    if (editorPlatform(this.ctx.platform)) {
      cx.spawn(async (cx) => {
        const list = await editors.get(Date.now(), () => loadEditors(this.ctx));
        // Rows arrive late: keep the row the user moved to, else start over at the preferred one.
        const prevId = this.mode === "choose" ? this.actions()[this.at]?.id : null;
        this.editors = Array.isArray(list) ? list : [];
        if (this.navigated) this.at = reselect(this.actions(), prevId);
        else {
          this.at = 0;
          this.applyPrefs();
        }
        cx.notify();
      });
    }

    cx.spawn(async (cx) => {
      const r = await loadPrefs((f) => readTextFile(f), prefsFile());
      this.prefs = r.prefs;
      this.prefsRaw = r.raw;
      this.prefsReady = true;
      this.applyPrefs();
      this.maybeAuto(cx);
      cx.notify();
    });

    // A key bound to "drover-open.clipboard": a clipboard chooser reads the clipboard again; any other copy
    // (a caller's chooser, the search dialog) opens a clipboard chooser itself. Only one copy acts per press.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c !== "clipboard" || !claimPress()) continue;
        if (this.mode === "choose" && !this.fromProps) {
          this.setTarget(this.readClipboard(cx), cx);
          this.handle.focus();
        } else openClipboardChooser();
        cx.notify();
      }
    });
  }

  readClipboard(cx) {
    const text = safe(() => cx.read_from_clipboard(), undefined);
    this.clipboardEmpty = typeof text !== "string";
    return typeof text === "string" ? text : "";
  }

  // A new thing to open: classify it and, for a path, look it up.
  setTarget(raw, cx) {
    this.raw = String(raw ?? "").replace(/\r/g, "").slice(0, MAX_TEXT);
    this.target = parseTarget(this.raw, { home: this.ctx.home, cwd: this.ctx.cwd });
    this.info = this.target.kind === "path" ? (this.target.candidates.length ? { status: "checking" } : { status: "unresolved" }) : {};
    this.status = null;
    this.at = 0;
    this.navigated = false;
    const gen = ++this.gen;
    // "Open in" for another machine runs nothing there, not even the lookup: its rows are all disabled.
    const remoteEditors = this.editorsMode && this.ctx.on;
    if (remoteEditors && this.target.kind === "path") this.info = { status: "remote", abs: this.target.candidates[0] || null };
    else if (this.target.kind === "path" && this.target.candidates.length) cx.spawn(async (cx) => this.lookUp(gen, cx));
    this.applyPrefs();
  }

  async lookUp(gen, cx) {
    const t = this.target;
    let info = null;
    for (const cand of t.candidates) {
      let r;
      try {
        r = await exec("sh", ["-c", CHECK_SCRIPT, MOD, cand], { on: this.ctx.on, timeout: 8000 });
      } catch (e) {
        // Windows has no sh unless Git for Windows' usr\bin is on PATH.
        const error = notFound(e) && !this.ctx.on && this.ctx.platform === "windows" ? "Checking a path needs sh. Install Git for Windows and put its usr\\bin on PATH." : `Could not check this path: ${errText(e)}`;
        info = { status: "error", abs: cand, error };
        break;
      }
      if (gen !== this.gen) return;
      if (r.code !== 0) { info = { status: "error", abs: cand, error: `Could not check this path (exit ${r.code}).` }; continue; }
      const [type, real, exe] = String(r.stdout || "").split("\n");
      if (type === "d" || type === "f") {
        const deny = denyReason(cand) || (real ? denyReason(real) : null);
        info = { status: type === "d" ? "dir" : "file", abs: cand, real: real || cand, deny, exec: exe === "x" };
        break;
      }
      if (!info || info.status !== "error") info = { status: "missing", abs: t.candidates[0] };
    }
    if (gen !== this.gen) return;
    const prevId = this.actions()[this.at]?.id;
    this.info = info || { status: "missing", abs: t.candidates[0] };
    this.at = this.navigated ? reselect(this.actions(), prevId) : 0;
    this.applyPrefs();
    this.maybeAuto(cx);
    cx.notify();
  }

  actions() {
    return actionsFor(this.target, this.info, {
      cwd: this.ctx.cwd, on: this.ctx.on, platform: this.ctx.platform, editors: this.editors, mode: this.editorsMode ? "editors" : undefined,
    });
  }
  // "Open in" remembers the editor (shared key), not a per-kind choice: no "always" there.
  kindKey() {
    return this.editorsMode ? null : prefKey(this.target, this.info);
  }

  // Preselect the remembered choice and show its "always" state.
  applyPrefs() {
    if (this.mode !== "choose" || this.navigated) return;
    if (this.editorsMode) {
      const name = lastEditor();
      const i = name ? this.actions().findIndex((a) => a.editor === name && !a.disabled) : -1;
      if (i >= 0) this.at = i;
      return;
    }
    if (!this.prefsReady) return;
    const k = this.kindKey();
    const pref = k ? this.prefs[k] : null;
    if (!this.alwaysTouched) this.always = !!pref?.always;
    if (pref?.last) {
      const i = this.actions().findIndex((a) => a.id === pref.last && !a.disabled);
      if (i >= 0) this.at = i;
    }
  }

  // "Always" runs the remembered choice without asking, only for a target handed in by a caller.
  maybeAuto(cx) {
    if (this.autoDone || !this.fromProps || this.ask || this.editorsMode || this.mode !== "choose" || !this.prefsReady) return;
    if (this.info?.status === "checking") return;
    this.autoDone = true;
    const k = this.kindKey();
    const pref = k ? this.prefs[k] : null;
    if (!pref?.always) return;
    const item = this.actions().find((a) => a.id === pref.last && !a.disabled);
    if (!item) return;
    cx.spawn(async (cx) => {
      const ok = await this.perform(item.id, cx, { remember: false });
      if (ok)
        safe(() => notify({ title: item.label, body: `Done without asking: "always" is on for ${KIND_WORDS[k]}. Open the chooser from the clipboard to change it.`, level: "info", timeout: 5000 }));
    });
  }

  // Runs one action. -> true when it ran.
  async perform(id, cx, { remember = true } = {}) {
    const item = this.actions().find((a) => a.id === id);
    if (!item || item.disabled || this.busy) return false;
    this.busy = true;
    this.status = null;
    cx.notify();
    let res;
    try {
      res = await this.execute(id, cx);
    } catch (e) {
      res = { ok: false, error: errText(e) };
    }
    if (!res.ok) {
      this.busy = false;
      this.status = { level: "error", text: res.error };
      cx.notify();
      return false;
    }
    const k = this.kindKey();
    if (remember && k && !isEditorAction(id)) await this.remember(k, id, this.always);
    this.busy = false;
    if (res.stay) { cx.notify(); return true; }
    this.finish(cx, `${item.label}: done.`);
    return true;
  }

  async remember(k, id, always) {
    await this.ensureDataDir();
    const r = await savePrefs((f) => readTextFile(f), (f, t, e) => writeTextFile(f, t, e), prefsFile(), this.prefsRaw, (cur) => withChoice(cur, k, id, always));
    if (r.ok) { this.prefs = r.prefs; this.prefsRaw = r.raw; }
    else this.saveError = r.error;
    return r.ok;
  }

  async forget(cx) {
    await this.ensureDataDir();
    const r = await savePrefs((f) => readTextFile(f), (f, t, e) => writeTextFile(f, t, e), prefsFile(), this.prefsRaw, () => forgetAll());
    if (r.ok) {
      this.prefs = r.prefs;
      this.prefsRaw = r.raw;
      this.always = false;
      this.alwaysTouched = false;
      this.status = { level: "success", text: "Remembered choices cleared." };
    } else this.status = { level: "error", text: `Could not save: ${shown(r.error, 160)}` };
    cx.notify();
  }

  async ensureDataDir() {
    try {
      await fs.mkdir(`${appHome()}/data/${MOD}`, { recursive: true });
    } catch (e) {
      // already there, or the write below reports the real problem
    }
  }

  finish(cx, message) {
    if (this.overlay) closeOverlay(this.overlay);
    else {
      this.status = { level: "success", text: message };
      cx.notify();
    }
  }

  // The pane to open beside: the one the text came from, else the focused one.
  besidePane() {
    const ids = (safe(() => panes(), []) || []).map((x) => x.pane);
    if (this.ctx.pane && ids.includes(this.ctx.pane)) return this.ctx.pane;
    const f = safe(() => focused()?.pane, null);
    return f && ids.includes(f) ? f : null;
  }
  beside(mod, modProps, name) {
    const pane = this.besidePane();
    if (pane) run("pane.split", { direction: "right", pane, mod, props: modProps });
    else run("tab.new", { name, mod, props: modProps });
  }
  withOn(o) {
    return this.ctx.on ? { ...o, on: this.ctx.on } : o;
  }
  fileProps() {
    const t = this.target, i = this.info;
    return this.withOn({ file: i.abs, ...(t.line ? { line: t.line } : {}), ...(t.col ? { col: t.col } : {}) });
  }

  async execute(id, cx) {
    const t = this.target, i = this.info || {};
    const name = shown(basename(i.abs || t.written || "") || "file", 60);
    switch (id) {
      case "browser": {
        const url = t.url;
        if (!url || !/^https?:\/\/[^\s/?#]+/i.test(url)) return { ok: false, error: "Only http and https links open in the browser." };
        cx.open_url(url);
        return { ok: true };
      }
      case "copyLink":
        cx.write_to_clipboard(t.url);
        return { ok: true };
      case "copyText":
        cx.write_to_clipboard(this.raw);
        return { ok: true };
      case "copyPath":
        cx.write_to_clipboard(i.abs || t.candidates?.[0] || t.written);
        return { ok: true };
      case "viewer":
        this.beside("drover-viewer", this.fileProps(), name);
        return { ok: true };
      case "tab":
        if (i.status === "dir") run("tab.new", { name, mod: "drover-files", props: this.withOn({ folder: i.abs }) });
        else run("tab.new", { name, mod: "drover-viewer", props: this.fileProps() });
        return { ok: true };
      case "files":
        this.beside("drover-files", this.withOn({ folder: i.abs }), name);
        return { ok: true };
      case "reveal":
        this.beside("drover-files", this.withOn({ folder: revealFolder(i), reveal: i.abs }), shown(basename(revealFolder(i)), 60));
        return { ok: true };
      case "system": {
        if (this.ctx.on) return { ok: false, error: "The system app opens files on this machine only." };
        if (i.deny) return { ok: false, error: `Refused: ${i.deny}` };
        const risk = infoRisk(i, this.ctx.platform);
        if (risk) return { ok: false, error: `Not opened: ${risk}. Use ${finderLabel(this.ctx.platform)} instead.` };
        const comma = explorerProblem(this.ctx.platform, i.abs);
        if (comma) return { ok: false, error: comma };
        const [cmd, args] = systemOpenArgv(this.ctx.platform, i.abs);
        return runOpener(cmd, args, this.ctx.platform);
      }
      case "finder": {
        if (this.ctx.on) return { ok: false, error: "The file manager shows files on this machine only." };
        const comma = explorerProblem(this.ctx.platform, i.abs);
        if (comma) return { ok: false, error: comma };
        const [cmd, args] = systemRevealArgv(this.ctx.platform, i.abs);
        return runOpener(cmd, args, this.ctx.platform);
      }
      case "search":
        return this.startSearch(searchQueryFor(t), cx);
      default:
        if (isEditorAction(id)) return this.openInEditor(editorOfAction(id), i);
        return { ok: false, error: "Unknown action." };
    }
  }

  // `open -a <App> <path>` (macOS) or `<cli> <path>` (Linux): argv only, local only, never a protected path.
  // The choice is remembered for the top bar.
  async openInEditor(editor, i) {
    const found = editor ? this.editors.find((e) => e.id === editor.id) : null;
    if (!found) return { ok: false, error: "That editor is not installed." };
    if (this.ctx.on) return { ok: false, error: "Editors open folders on this machine only." };
    if (i.deny) return { ok: false, error: `Refused: ${i.deny}` };
    if (i.status !== "dir" && i.status !== "file") return { ok: false, error: "Nothing to open here." };
    const [cmd, args] = editorOpenArgv(editor.name, i.abs, { platform: this.ctx.platform, cli: found.cli });
    let r;
    try {
      r = await exec(cmd, args, { timeout: 15000 });
    } catch (e) {
      if (notFound(e)) return { ok: false, error: `${editor.name}: ${cmd} is no longer on PATH.` };
      throw e;
    }
    if (r.code !== 0) return { ok: false, error: `${editor.name} did not open: ${shown((r.stderr || r.stdout || `exit ${r.code}`).trim(), 160)}` };
    safe(() => setShared(EDITOR_KEY, editor.name));
    return { ok: true };
  }

  // A popup is too small for results: open a search dialog in its place.
  startSearch(query, cx) {
    if (!this.ctx.cwd) return { ok: false, error: "No folder to search in." };
    if (this.overlay) {
      openOverlay({
        mod: MOD, kind: "dialog", width: 680, height: 520,
        props: this.withOn({ mode: "search", query: cleanQuery(query), cwd: this.ctx.cwd, ...(this.ctx.pane ? { pane: this.ctx.pane } : {}) }),
      });
      return { ok: true };
    }
    this.mode = "search";
    this.input.set_value(cleanQuery(query));
    this.input.focus();
    cx.spawn(async (cx) => this.runSearch(cx));
    return { ok: true, stay: true };
  }

  submitSearch(cx) {
    const q = cleanQuery(this.input.value());
    if (q && q === this.lastQuery && this.results?.length && !this.searching) this.openResult(this.rat, cx);
    else cx.spawn(async (cx) => this.runSearch(cx));
  }

  async runSearch(cx) {
    const q = cleanQuery(this.input.value());
    const folder = this.ctx.cwd;
    if (!q) { this.searchMsg = { level: "info", text: "Type something to search for." }; cx.notify(); return; }
    if (!folder) { this.searchMsg = { level: "error", text: "No folder to search in." }; cx.notify(); return; }
    const gen = ++this.searchGen;
    this.searching = true;
    this.lastQuery = q;
    this.results = [];
    this.rat = 0;
    this.searchMsg = null;
    cx.notify();
    const opts = { cwd: folder, on: this.ctx.on, timeout: 15000 };
    let res = null, withColumn = true, failure = null;
    try {
      const [c, a] = rgArgv(q);
      res = await exec(c, a, opts);
      if (outcome(res) === "missing") res = null;
    } catch (e) {
      res = null;
    }
    if (!res) {
      withColumn = false;
      try {
        const [c, a] = grepArgv(q);
        res = await exec(c, a, opts);
      } catch (e) {
        failure = notFound(e) ? "neither rg nor grep was found. Install ripgrep." : errText(e);
      }
    }
    if (gen !== this.searchGen) return;
    this.searching = false;
    const kind = outcome(res);
    if (failure || kind === "error" || kind === "missing") {
      this.results = [];
      this.searchMsg = { level: "error", text: failure ? `Search failed: ${failure}` : `Search failed: ${shown((res?.stderr || "").trim().split("\n")[0] || `exit ${res?.code}`, 160)}` };
    } else if (kind === "none") {
      this.results = [];
      this.searchMsg = { level: "info", text: "No matches." };
    } else {
      const { results, dropped } = parseResults(res.stdout, folder, withColumn);
      this.results = results;
      const more = results.length >= MAX_RESULTS ? ` (first ${MAX_RESULTS})` : "";
      const hidden = dropped ? `, ${dropped} in protected files hidden` : "";
      this.searchMsg = { level: "info", text: `${results.length} match${results.length === 1 ? "" : "es"}${more}${hidden}` };
    }
    cx.notify();
  }

  openResult(i, cx) {
    const r = this.results?.[i];
    if (!r) return;
    const name = shown(basename(r.file), 60);
    this.beside("drover-viewer", this.withOn({ file: r.file, line: r.line, ...(r.col ? { col: r.col } : {}) }), name);
    this.finish(cx, `Opened ${name}.`);
  }

  // ---- display ----

  title() {
    const t = this.target, i = this.info || {};
    if (this.editorsMode && t && t.kind !== "empty") return "Open in";
    if (!t || t.kind === "empty") return this.clipboardEmpty ? "The clipboard holds no text" : "Nothing to open";
    if (t.kind === "url") return displayUrl(t.url);
    if (t.kind === "path") return shown(tilde(i.abs || t.candidates[0] || t.written, this.ctx.home) + describeLocation(t.line, t.col));
    return shown(t.query);
  }
  subtitle() {
    const t = this.target, i = this.info || {};
    const where = this.ctx.on ? ` on ${shown(this.ctx.on, 40)}` : "";
    if (!t || t.kind === "empty") return this.fromProps ? "Select some text first." : "Copy a link, a path or some text, then read the clipboard again.";
    if (t.kind === "url") return `Link · ${shown(urlHost(t.url), 80)}`;
    if (t.kind === "text") return t.multiline ? "Text · first line is searched" : "Text";
    if (this.editorsMode) {
      const where2 = shown(tilde(i.abs || t.candidates?.[0] || t.written, this.ctx.home), 160);
      if (this.ctx.on) return `${where2} on ${shown(this.ctx.on, 40)}`;
      return where2;
    }
    switch (i.status) {
      case "checking": return `Checking${where}…`;
      case "file": return `File${where}`;
      case "dir": return `Folder${where}`;
      case "missing": return `Not found${where}`;
      case "unresolved": return "Relative path, but no folder is known";
      default: return `Path${where}`;
    }
  }
  notice() {
    const i = this.info || {};
    if (this.editorsMode) {
      if (this.ctx.on) return { level: "info", text: "Editors open folders on this machine only: this space is on another machine." };
      if (!editorPlatform(this.ctx.platform)) return { level: "info", text: "Opening in an editor works on macOS and Linux only." };
      if (!this.editors.length && i.status !== "checking") {
        return { level: "info", text: this.ctx.platform === "linux" ? "No supported editor found on PATH (code, cursor, zed, subl, windsurf, codium)." : "No supported editor found in Applications." };
      }
    }
    if (i.deny) return { level: "error", text: `Protected (${i.deny}): it can be revealed or copied, not opened.` };
    if (i.status === "error") return { level: "error", text: i.error };
    if (i.status === "missing") return { level: "info", text: "Nothing at this path. Search for its name instead?" };
    if (this.saveError) return { level: "error", text: `Choice not remembered: ${shown(this.saveError, 120)}` };
    return null;
  }
  headerIcon(t) {
    const tg = this.target, i = this.info || {};
    const plain = (name) => svg(UI(name)).size(18).flex_none().text_color(t.muted);
    if (!tg || tg.kind === "empty") return plain("clipboard");
    if (tg.kind === "url") return plain("globe");
    if (tg.kind === "text") return plain("search");
    if (i.status === "file" || i.status === "dir") return image(resolveIcon(MOD, i.status === "dir", basename(i.abs))).size(18).flex_none();
    if (i.status === "checking") return plain("folder-search");
    return plain("alert");
  }
  levelColor(t, level) {
    return level === "error" ? t.blocked : level === "success" ? t.done : t.muted;
  }

  onKey(e, cx) {
    const m = e.modifiers || {};
    if (m.control || m.platform || m.alt || m.function) return;
    if (this.mode === "search") {
      const n = this.results?.length || 0;
      if (!n) return;
      if (e.key === "down") this.rat = (this.rat + 1) % n;
      else if (e.key === "up") this.rat = (this.rat + n - 1) % n;
      else return;
      this.scroll.scroll_to_item(this.rat);
      cx.notify();
      return;
    }
    const list = this.actions();
    if (e.key === "escape") {
      if (this.overlay) closeOverlay(this.overlay);
      return;
    }
    if (e.key === "a") return this.toggleAlways(cx);
    if (!list.length) {
      if (e.key === "enter" && !this.fromProps) this.reread(cx);
      return;
    }
    if (e.key === "down") this.at = (this.at + 1) % list.length;
    else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
    else if (e.key === "enter") return this.choose(this.at, cx);
    else if (/^[1-9]$/.test(e.key)) return this.choose(Number(e.key) - 1, cx);
    else return;
    this.navigated = true;
    this.actScroll.scroll_to_item(this.at);
    cx.notify();
  }
  choose(i, cx) {
    const item = this.actions()[i];
    if (!item) return;
    this.at = i;
    if (item.disabled) {
      this.status = { level: "info", text: `${item.label}: ${item.disabled}.` };
      cx.notify();
      return;
    }
    cx.spawn(async (cx) => this.perform(item.id, cx));
  }
  toggleAlways(cx) {
    if (!this.kindKey()) return;
    this.always = !this.always;
    this.alwaysTouched = true;
    cx.notify();
  }
  reread(cx) {
    this.setTarget(this.readClipboard(cx), cx);
    this.handle.focus();
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const root = v_flex()
      .id("drover-open")
      .track_focus(this.handle)
      .size_full()
      .min_h(0)
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(12.8)
      .on_key_down((e, cx) => this.onKey(e, cx));
    return this.mode === "search" ? root.child(this.renderSearch(t)) : root.child(this.renderChooser(t));
  }

  renderChooser(t) {
    const list = this.actions();
    const k = this.kindKey();
    const pref = k ? this.prefs[k] : null;
    const note = this.status || this.notice();
    return v_flex()
      .flex_1()
      .min_h(0)
      .p(8)
      .gap(6)
      .child(
        h_flex()
          .id("header")
          .gap(10)
          .px(6)
          .py(4)
          .items_center()
          .child(this.headerIcon(t))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .child(div().id("title").truncate().font_semibold().child(this.title()))
              .child(div().id("subtitle").truncate().text_size(11.5).text_color(t.muted).child(this.subtitle())),
          ),
      )
      .child(div().mx(4).h(1).bg(t.border))
      .when(list.length > 0, (el) =>
        el.child(
          v_flex()
            .id("actions")
            // A scroll box has no height of its own: a popup sized to its content would draw it 0 tall.
            .h(Math.min(list.length, 8) * 32)
            .min_h(0)
            .flex_shrink(1)
            .overflow_y_scrollbar()
            .track_scroll(this.actScroll)
            .gap(1)
            .children(
              list.map((a, i) =>
                h_flex()
                  .id(`act-${a.id}`)
                  .h(31)
                  .px(8)
                  .gap(9)
                  .rounded(7)
                  .items_center()
                  .text_color(a.disabled ? t.dim : t.foreground)
                  .when(i === this.at, (s) => s.bg(t.selected))
                  .when(!a.disabled, (s) => s.hover((h) => h.bg(t.hover)))
                  .on_click((_e, cx) => this.choose(i, cx))
                  .child(svg(UI(a.icon)).size(14).flex_none().text_color(a.disabled ? t.dim : t.muted))
                  .child(div().flex_1().truncate().child(a.label))
                  .when(!!a.disabled, (s) => s.child(div().text_size(11).text_color(t.dim).truncate().child(a.disabled)))
                  .when(!a.disabled && (a.editor ? a.editor === lastEditor() : pref?.last === a.id), (s) => s.child(div().text_size(11).text_color(t.dim).child("last")))
                  .when(i < 9, (s) => s.child(div().w(14).text_size(11).text_color(t.dim).child(String(i + 1)))),
              ),
            ),
        ),
      )
      .when(list.length === 0 && !this.fromProps, (el) =>
        el.child(
          h_flex()
            .id("reread")
            .h(31)
            .px(8)
            .gap(9)
            .rounded(7)
            .items_center()
            .bg(t.selected)
            .hover((h) => h.bg(t.hover))
            .on_click((_e, cx) => this.reread(cx))
            .child(svg(UI("clipboard")).size(14).flex_none().text_color(t.muted))
            .child(div().flex_1().child("Read the clipboard again")),
        ),
      )
      .when(!!note, (el) => el.child(div().id("note").px(8).text_size(11.5).text_color(this.levelColor(t, note.level)).child(shown(note.text, 240))))
      .child(div().flex_1())
      .child(
        h_flex()
          .id("footer")
          .px(6)
          .gap(8)
          .items_center()
          .justify_between()
          .when(!this.editorsMode, (el) => el.child(
            h_flex()
              .id("always")
              .gap(7)
              .items_center()
              .text_size(11.5)
              .text_color(k ? t.foreground : t.dim)
              .when(!!k, (s) => s.on_click((_e, cx) => this.toggleAlways(cx)))
              .child(
                div()
                  .size(14)
                  .flex_none()
                  .rounded(3)
                  .border_1()
                  .border_color(this.always && k ? t.accent : t.input)
                  .when(this.always && !!k, (s) => s.bg(t.accent).child(svg(UI("check")).size(12).text_color(t.accent_foreground)))
                  .items_center()
                  .justify_center(),
              )
              .child(k ? `Always do this for ${KIND_WORDS[k]}` : "Always do this"),
          ))
          .when(!this.editorsMode && this.prefsHasChoices(), (el) =>
            el.child(
              div()
                .id("forget")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click((_e, cx) => cx.spawn(async (cx) => this.forget(cx)))
                .child("Forget choices"),
            ),
          ),
      );
  }

  prefsHasChoices() {
    return ["url", "file", "dir", "text"].some((k) => this.prefs[k]);
  }

  renderSearch(t) {
    const results = this.results || [];
    const folder = this.ctx.cwd ? shown(tilde(this.ctx.cwd, this.ctx.home), 120) : "no folder";
    return v_flex()
      .flex_1()
      .min_h(0)
      .p(8)
      .gap(6)
      .child(
        h_flex()
          .id("search-bar")
          .h(34)
          .px(8)
          .gap(8)
          .items_center()
          .rounded(8)
          .border_1()
          .border_color(t.accent)
          .bg(t.background)
          .child(svg(UI("search")).size(14).flex_none().text_color(t.muted))
          .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground))
          .when(!!this.target, (el) =>
            el.child(
              div()
                .id("back")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click((_e, cx) => { this.mode = "choose"; this.handle.focus(); cx.notify(); })
                .child("Back"),
            ),
          ),
      )
      .child(
        h_flex()
          .id("search-info")
          .px(4)
          .gap(8)
          .justify_between()
          .text_size(11)
          .text_color(t.dim)
          .child(div().truncate().child(`in ${folder}${this.ctx.on ? ` on ${shown(this.ctx.on, 40)}` : ""}`))
          .child(
            div()
              .id("search-status")
              .flex_none()
              .text_color(this.searchMsg ? this.levelColor(t, this.searchMsg.level) : t.dim)
              .child(this.searching ? "Searching…" : this.searchMsg ? shown(this.searchMsg.text, 160) : "Enter searches"),
          ),
      )
      .child(
        v_flex()
          .id("results")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .track_scroll(this.scroll)
          .children(
            results.map((r, i) =>
              v_flex()
                .id(`res-${i}`)
                .px(8)
                .py(4)
                .rounded(6)
                .when(i === this.rat, (s) => s.bg(t.selected))
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => this.openResult(i, cx))
                .child(
                  h_flex()
                    .gap(6)
                    .items_center()
                    .child(image(resolveIcon(MOD, false, basename(r.file))).size(13).flex_none())
                    .child(div().truncate().text_size(12).child(shown(r.rel, 160)))
                    .child(div().flex_none().text_size(11).text_color(t.dim).child(describeLocation(r.line, r.col))),
                )
                .child(div().truncate().text_size(11.5).text_color(t.muted).child(r.text || " ")),
            ),
          ),
      )
      .when(!!this.status, (el) => el.child(div().id("note").px(8).text_size(11.5).text_color(this.levelColor(t, this.status.level)).child(shown(this.status.text, 240))));
  }
}

