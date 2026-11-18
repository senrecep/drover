// drover-files: a file browser that follows the focused terminal, opens files in drover-viewer and manages them.
// Derived from Herdr's shipped "files" mod (Apache-2.0); see NOTICE for what changed.
// One class, three roles: the panel (default), its right-click menu (props.menu, a popup) and a name prompt (props.ask, a dialog).
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input } from "gpui-base";
import { spaces, panes, focused, readTextFile, watchFolder, theme, settings, home, props, shared, setShared, openOverlay, closeOverlay, nextCommand } from "herdr";
import { resolveIcon } from "./lib/icons.js";
import { TYPE, mono, metaColor, panelHeader, iconButton, button, emptyState } from "./lib/panel-ui.js";
import { redact, stripControl } from "./lib/guard.js";
import { langFor, isBinary, sizeGuard } from "./lib/lang.js";
import { isIgnored, needsCheck, forget } from "./lib/ignored.js";
import {
  MOD, PER_FOLDER, TOTAL, SHARED, fresh, absOf, rowLock, flatten, loadedPaths, ancestors, step, sortEntries,
  pickLocation, expandFolder, displayRoot, rel as relOf, filterIndex, lockReason, menuItems, menuHeight, basename, parent, isInside,
} from "./model.js";
import {
  platform, listFolder, buildIndex, gitMarks, ignoredIn, openCheck, viewerInstalled, openInViewer, openSystem, reveal,
  trashAvailable, moveToTrash, newFile, newFolder, renameEntry,
} from "./ops.js";

const UI = (name) => `mods/${MOD}/ui/${name}.svg`;
const LOCK = `mods/${MOD}/icons/lock.svg`;
const firstLine = (e) => stripControl(String(e?.message ?? e)).split("\n")[0].slice(0, 200);
const MARKS = { A: "Added or untracked", M: "Modified", D: "Deleted", U: "Merge conflict" };
const noiseShown = () => Boolean(shared(SHARED.noise)?.value);

export default class DroverFiles extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.role = p.menu ? "menu" : p.ask ? "ask" : "panel";
    if (this.role === "menu") return this.initMenu(cx);
    if (this.role === "ask") return this.initAsk(cx);
    this.id = `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
    this.fixed = p.folder ? expandFolder(String(p.folder), home()) : null;
    this.badFolder = p.folder && !this.fixed ? "props.folder must be an absolute path or start with ~" : null;
    this.pinned = null; this.last = null;
    this.saved = new Map(); this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.ignored = new Map();   // folder rel -> Set of git-ignored names in it, refreshed with each listing
    this.opened = new Map(); this.selected = null; this.preview = null; this.status = null;
    this.query = ""; this.index = null; this.indexing = false; this.filterTotal = 0;
    this.viewer = true; this.canTrash = "absent";
    // Messages already in shared storage come from before this copy: never act on them.
    this.seenBump = shared(SHARED.bump)?.n ?? null; this.seenAct = shared(SHARED.act)?.at ?? null;
    this.handle = cx.focus_handle();
    this.filter = InputState.new({ value: "", placeholder: "Filter files" });
    this.filter.on("change", (_e, cx) => this.setQuery(this.filter.value(), cx));
    this.filter.on("submit", (_e, cx) => { const r = this.filterRows()[0]; if (r) this.activate(r, cx); });
    this.filter.on("focus", (_e, cx) => { this.filterFocused = true; cx.notify(); });
    this.filter.on("blur", (_e, cx) => { this.filterFocused = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
    cx.spawn(async cx => {
      this.canTrash = await trashAvailable(null).catch(() => "absent");
      this.viewer = await viewerInstalled(Date.now()).catch(() => false);
      cx.notify();
    });
    cx.spawn(async cx => {
      for (;;) {
        const c = await nextCommand();
        this.command(typeof c === "string" ? c : c?.name, cx);
        cx.notify();
      }
    });
  }

  // ---------- panel: where to look ----------

  location() {
    if (this.fixed) return { cwd: this.fixed, on: null, space: null };
    // A bad props.folder shows its error rather than silently following the terminal.
    if (this.badFolder) return { cwd: null, on: null, space: null };
    if (this.pinned) return this.pinned;
    const next = pickLocation({ spaces: spaces(), panes: panes(), focused: focused() }, this.last);
    if (next.cwd) this.last = next;
    return next;
  }
  keyOf(loc) { return JSON.stringify({ cwd: loc.cwd, on: loc.on }); }
  current(context) { return this.context === context && this.keyOf(this.location()) === context.key; }

  command(name, cx) {
    if (name === "focus") this.handle.focus();
    else if (name === "focus-filter") { if (this.claimOnce(SHARED.focusFilter)) this.filter.focus(); }
    else if (name === "toggle-follow") this.toggleFollow(cx);
    else if (name === "toggle-hidden") this.toggleNoise();
    else if (name === "refresh") this.reload(cx);
  }

  toggleFollow(cx) {
    if (this.fixed) return this.say("This browser shows a fixed folder (props.folder)", "info", cx);
    this.pinned = this.pinned ? null : { ...this.location() };
    this.refresh(cx);
  }

  // The hide toggle is shared by every copy; a key command reaches each shown copy, so repeats within 400 ms are one press.
  toggleNoise() {
    const now = Date.now(), cur = shared(SHARED.noise);
    if (cur && typeof cur.at === "number" && now - cur.at >= 0 && now - cur.at < 400) return;
    setShared(SHARED.noise, { value: !noiseShown(), at: now });
  }

  // A key command reaches every shown copy: the first copy to claim it within 400 ms acts, the others do nothing.
  claimOnce(key) {
    const now = Date.now(), cur = shared(key);
    if (cur && typeof cur.at === "number" && now - cur.at >= 0 && now - cur.at < 400) return false;
    setShared(key, { at: now, by: this.id });
    return true;
  }

  say(text, level, cx) {
    const at = Date.now();
    this.status = { text, level, at };
    cx.timer.after(level === "error" ? 9000 : 5000, cx => { if (this.status?.at === at) { this.status = null; cx.notify(); } });
    cx.notify();
  }

  // ---------- panel: loading ----------

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  async loadFolder(path, context) {
    const entries = await listFolder(absOf(context.cwd, path), context.on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, sortEntries(entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used)))));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
    // One git call per listed folder (none inside an ignored folder: its rows inherit the dim color).
    const names = this.entries.get(path).map(e => e.name);
    const ignored = needsCheck(this.ignored, path) ? await ignoredIn(absOf(context.cwd, path), names, context.on) : new Set();
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    if (ignored) this.ignored.set(path, ignored);   // null: git gave no answer this time; keep the last one
  }

  // force: list again even when nothing moved (after a change made here).
  refresh(cx, force) {
    const loc = this.location(), next = this.keyOf(loc);
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, selected: this.selected });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd: loc.cwd, on: loc.on }; this.root = loc.cwd; this.on = loc.on;
      this.entries = new Map(); this.folders = new Set(saved?.folders); this.selected = saved?.selected ?? null;
      this.pending = new Set(); this.marks = {}; this.ignored = new Map(); this.closePreview(); this.watched = null; this.error = null; this.limited = false;
      this.loading = false; this.index = null;
    } else if (force) this.index = null;
    if (!loc.cwd || this.loading) { if (force) this.again = true; return; }
    const context = this.context;
    this.loading = true; this.limited = false; this.again = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context).catch(e => { if (!path) throw e; this.folders.delete(path); this.entries.delete(path); forget(this.ignored, path); });
        }
        const marks = await gitMarks(context.cwd, context.on, TOTAL);
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(context.cwd, cx);
      } catch (e) { if (this.current(context)) this.error = firstLine(e); }
      finally {
        if (this.context === context) this.loading = false;
        if (this.again && this.context === context) this.refresh(cx, true);
        cx.notify();
      }
    });
  }

  reload(cx) { this.index = null; this.refresh(cx, true); }

  toggle(rel, cx) {
    if (this.folders.has(rel)) {
      for (const folder of [...this.folders]) if (folder === rel || folder.startsWith(rel + "/")) { this.folders.delete(folder); this.entries.delete(folder); }
      forget(this.ignored, rel);
    } else {
      const lock = rowLock(absOf(this.root, rel));
      if (lock) return this.say(`Not opened: ${lock}`, "warning", cx);
      this.folders.add(rel);
      this.load(rel, cx);
    }
    cx.notify();
  }

  load(rel, cx) {
    if (this.entries.has(rel) || this.pending.has(rel)) return;
    const context = this.context;
    this.pending.add(rel);
    cx.spawn(async cx => {
      try { await this.loadFolder(rel, context); }
      catch (e) { if (this.current(context)) { this.folders.delete(rel); this.say(firstLine(e), "error", cx); } }
      finally { if (this.context === context) this.pending.delete(rel); cx.notify(); }
    });
  }

  // Shows a path that was just made or renamed: opens its folders and selects it.
  revealRel(abs, cx) {
    const r = this.root && relOf(this.root, abs);
    if (!r || r === ".") return this.reload(cx);
    for (const a of ancestors(r)) if (!this.folders.has(a) && !rowLock(absOf(this.root, a))) this.folders.add(a);
    this.selected = r;
    this.reload(cx);
  }

  // ---------- panel: opening files ----------

  activate(row, cx) {
    this.selected = row.rel;
    if (row.dir) {
      if (row.flat) {
        if (rowLock(absOf(this.root, row.rel))) return this.say(`Not opened: ${rowLock(absOf(this.root, row.rel))}`, "warning", cx);
        this.clearQuery(cx);
        for (const a of [...ancestors(row.rel), row.rel]) this.folders.add(a);
        return this.reload(cx);
      }
      return this.toggle(row.rel, cx);
    }
    this.openFile(absOf(this.root, row.rel), cx);
  }

  openFile(abs, cx) {
    const lock = lockReason(abs);
    if (lock) return this.say(`Not opened: ${lock}`, "warning", cx);
    const on = this.on, context = this.context;
    cx.spawn(async cx => {
      try {
        const check = await openCheck(abs, on);
        if (!check.ok) return this.say(`Not opened: ${check.why}`, "warning", cx);
        this.viewer = await viewerInstalled(Date.now()).catch(() => false);
        if (this.viewer) {
          const r = await openInViewer(abs, on, this.opened, ms => cx.sleep(ms));
          if (r.how === "unknown") this.say("Asked drover-viewer to open it; no new pane showed up", "warning", cx);
          return;
        }
        if (this.context === context) this.showPreview(abs, cx);
      } catch (e) { this.say(firstLine(e), "error", cx); }
      finally { cx.notify(); }
    });
  }

  closePreview() { this.preview?.code?.release(); this.preview = null; }

  // Fallback when drover-viewer is not installed: the shipped mod's read-only preview, with secrets masked.
  showPreview(abs, cx) {
    this.closePreview();
    const preview = this.preview = { abs, code: null, error: null, note: null };
    const on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(abs, { on });
        if (this.preview !== preview) return;
        if (text === null) { preview.error = "This file is no longer available"; return; }
        if (isBinary(text)) { preview.error = "Binary file · no text preview"; return; }
        const size = sizeGuard(text);
        if (!size.ok) { preview.error = `Not previewed: ${size.reason}`; return; }
        const clean = redact(text);
        preview.note = clean.redacted ? "secrets are masked" : null;
        const t = theme();
        preview.code = EditorState.new({ language: langFor(abs), readonly: true, value: clean.text,
          font_family: settings().font_family, font_size: TYPE.sm,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.preview === preview) preview.error = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // ---------- panel: filter ----------

  setQuery(q, cx) {
    this.query = String(q || "").trim();
    if (this.query && !this.index && !this.indexing && this.root) {
      const context = this.context, noise = noiseShown();
      this.indexing = true;
      cx.spawn(async cx => {
        try {
          const r = await buildIndex(context.cwd, context.on, noise);
          if (this.context === context) this.index = { ...r, noise };
        } catch (e) { if (this.context === context) this.index = { paths: [], truncated: false, noise, error: firstLine(e) }; }
        finally { this.indexing = false; cx.notify(); }
      });
    }
    cx.notify();
  }

  clearQuery(cx) { this.query = ""; this.filter.set_value(""); cx.notify(); }

  filterRows() {
    const noise = noiseShown();
    if (this.index && this.index.noise !== noise && !this.indexing) this.index = null;
    const source = this.index && !this.index.error ? this.index.paths : loadedPaths(this.entries, noise);
    const { rows, total } = filterIndex(source, this.query, 300);
    this.filterTotal = total;
    return rows.map(r => ({ rel: r.path, name: basename(r.path), dir: r.dir, depth: 0, open: false, flat: true }));
  }

  // ---------- panel: menu ----------

  openMenu(row, cx) {
    cx.stop_propagation();
    if (!this.root) return;
    const rel = row ? row.rel : "";
    if (row) this.selected = rel;
    const abs = absOf(this.root, rel), dir = row ? row.dir : true;
    const spec = { dir, isRoot: !row, name: basename(abs), locked: lockReason(abs), remote: Boolean(this.on), platform: platform(), canTrash: this.canTrash,
      viewer: this.viewer, fixed: Boolean(this.fixed), pinned: Boolean(this.pinned) };
    const items = menuItems(spec);
    openOverlay({ mod: MOD, kind: "popup", width: 260, height: menuHeight(items),
      props: { menu: true, panel: this.id, abs, rel, root: this.root, on: this.on, spec } });
    cx.notify();
  }

  // A choice sent back from this panel's menu.
  onAct(act, cx) {
    if (act.id === "viewer") this.openFile(act.abs, cx);
    else if (act.id === "pin-here") { this.pinned = { cwd: act.abs, on: this.on, space: null }; this.refresh(cx); }
  }

  // ---------- panel: render ----------

  checkShared(cx) {
    const bump = shared(SHARED.bump);
    if (bump?.n && bump.n !== this.seenBump) {
      this.seenBump = bump.n;
      if (typeof bump.reveal === "string" && this.root && isInside(this.root, bump.reveal)) this.revealRel(bump.reveal, cx);
      else this.reload(cx);
    }
    const act = shared(SHARED.act);
    if (act && act.at !== this.seenAct) {
      this.seenAct = act.at;
      if (act.panel === this.id && fresh(act, Date.now()) && typeof act.abs === "string") { setShared(SHARED.act, null); this.onAct(act, cx); }
    }
  }

  key(e, cx) {
    const rows = this.query ? this.filterRows() : flatten(this.entries, this.folders, noiseShown());
    const k = e.key, r = rows.find(r => r.rel === this.selected);
    if (k === "down" || k === "up") this.selected = step(rows, this.selected, k === "down" ? 1 : -1);
    else if (k === "enter") { if (r) this.activate(r, cx); }
    else if (k === "right") { if (r?.dir && !r.open && !r.flat) this.toggle(r.rel, cx); }
    else if (k === "left") {
      if (r?.dir && r.open) this.toggle(r.rel, cx);
      else if (r && r.rel.includes("/") && !r.flat) this.selected = r.rel.slice(0, r.rel.lastIndexOf("/"));
    }
    else if (k === "escape") { if (this.preview) this.closePreview(); else if (this.query) this.clearQuery(cx); else return; }
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  row(r, t) {
    const abs = absOf(this.root, r.rel), lock = rowLock(abs), mark = this.marks[abs], dim = lock || isIgnored(this.ignored, r.rel);
    const icon = lock ? LOCK : resolveIcon(MOD, r.dir, r.name, { open: r.open });
    return h_flex().id(`row-${r.rel}`).h(26).flex_none().pl(8 + r.depth * 16).pr(8).gap(6).items_center().rounded(6).cursor_pointer()
      .when(r.rel === this.selected, el => el.bg(t.hover)).hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { this.handle.focus(); this.activate(r, cx); })
      .on_mouse_down("right", (_e, cx) => this.openMenu(r, cx))
      .child(r.dir && !r.flat ? svg(UI(`chevron-${r.open ? "down" : "right"}`)).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
      .child(image(icon).size(16).flex_none())
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(TYPE.sm).text_color(dim ? metaColor(t) : t.foreground).child(r.name))
        .when(Boolean(r.flat && r.rel.includes("/")), el => el.child(mono(div().truncate().text_size(TYPE.xs).text_color(metaColor(t)).child(r.rel.slice(0, r.rel.lastIndexOf("/")))))))
      .when(Boolean(lock), el => el.tooltip(`Locked: ${lock}`))
      .when(Boolean(mark), el => el.child(mono(div().text_size(TYPE.xs).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked)
        .tooltip(MARKS[mark] ?? mark).accessibility_label(MARKS[mark] ?? mark).child(mark))));
  }

  render(cx) {
    if (this.role === "menu") return this.renderMenu();
    if (this.role === "ask") return this.renderAsk();
    if (this.keyOf(this.location()) !== this.context?.key) this.refresh(cx);
    this.checkShared(cx);
    const t = theme(), noise = noiseShown();
    const where = this.root ? (this.on ? `${this.on}: ` : "") + displayRoot(this.root, home()) : "";
    const actions = [
      ...(this.fixed ? [] : [{ id: "df-follow", icon: UI(this.pinned ? "pin" : "follow"), label: this.pinned ? "Follow the focused terminal" : "Pin to this folder",
        active: Boolean(this.pinned), onClick: cx => this.toggleFollow(cx) }]),
      { id: "df-noise", icon: UI(noise ? "eye" : "eye-off"), label: noise ? "Hide .git and node_modules" : "Show hidden files", active: noise, onClick: () => this.toggleNoise() },
      { id: "df-refresh", icon: UI("refresh"), label: "Refresh", onClick: cx => this.reload(cx) },
    ];
    const header = panelHeader({ id: "df-header", title: "Files", meta: where, actions, busy: Boolean(this.loading) }, t);
    const usable = Boolean(this.root) && !this.badFolder;
    const filterBar = h_flex().h(32).flex_none().mx(8).my(6).px(8).gap(6).items_center().rounded(7).border_1()
      .border_color(this.filterFocused ? t.accent : t.border).bg(t.background)
      .child(svg(UI("search")).size(13).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.filter).h(24).text_size(TYPE.sm).text_color(t.foreground)))
      .when(Boolean(this.query), el => el.child(iconButton({ id: "df-clear", icon: UI("close"), label: "Clear filter", onClick: cx => this.clearQuery(cx) }, t)));

    let body;
    if (this.preview) {
      const pv = this.preview;
      body = v_flex().flex_1().min_h(0)
        .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
          .child(button({ id: "df-back", label: "← Back", onClick: cx => { this.closePreview(); cx.notify(); } }, t))
          .child(mono(div().flex_1().min_w(0).truncate().text_size(TYPE.xs).text_color(metaColor(t)).child(relOf(this.root, pv.abs) ?? pv.abs))))
        .child(div().px(10).py(4).text_size(TYPE.xs).text_color(metaColor(t)).child(`drover-viewer is not installed: read-only preview${pv.note ? ` · ${pv.note}` : ""}`))
        .child(pv.code ? Editor.new(pv.code).flex_1().min_h(0) : div().p(12).text_size(TYPE.sm).text_color(metaColor(t)).child(pv.error || "Reading file…"));
    } else {
      const rows = this.query ? this.filterRows() : flatten(this.entries, this.folders, noise);
      const reading = this.query ? this.indexing : this.loading;
      const note = this.query ? "Searching…" : "Reading files…";
      let state = null;
      if (this.badFolder) state = emptyState({ id: "df-empty", icon: UI("close"), tone: "error", title: "Could not open folder", body: this.badFolder }, t);
      else if (!this.root) state = emptyState({ id: "df-empty", title: "No folder", body: "Focus a terminal to show its folder here." }, t);
      else if (!rows.length && this.error) state = emptyState({ id: "df-empty", icon: UI("close"), tone: "error", title: "Could not read folder", body: this.error }, t);
      else if (!rows.length && this.query && !reading) state = emptyState({ id: "df-empty", title: "No matches", body: `Nothing matches "${this.query}".`,
        action: { id: "df-empty-clear", label: "Clear filter", onClick: cx => this.clearQuery(cx) } }, t);
      else if (!rows.length && !reading) state = emptyState({ id: "df-empty", title: "Empty folder", body: "This folder has no files." }, t);
      const total = this.filterTotal;
      body = v_flex().id("df-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .on_mouse_down("right", (_e, cx) => this.openMenu(null, cx))
        .when(reading && usable, el => el.child(div().px(8).py(4).text_size(TYPE.sm).text_color(metaColor(t)).child(note)))
        .children(rows.map(r => this.row(r, t)))
        .when(Boolean(state), el => el.child(state))
        .when(Boolean(this.error) && rows.length > 0, el => el.child(div().p(8).text_size(TYPE.xs).text_color(t.blocked).child(`Could not read folder: ${this.error}`)))
        .when(Boolean(this.query) && rows.length > 0, el => el.child(div().p(8).text_size(TYPE.xs).text_color(metaColor(t)).child(
          (total > rows.length ? `First ${rows.length} of ${total} matches` : `${total} match${total === 1 ? "" : "es"}`) +
          (this.indexing ? " · searching the whole folder…" : this.index?.error ? " · loaded folders only" : this.index?.truncated ? " · search limited to 20,000 paths" : ""))))
        .when(!this.query && this.limited, el => el.child(div().p(8).text_size(TYPE.xs).text_color(metaColor(t)).child("File list limited to 500 entries per folder and 5,000 total")));
    }
    const st = this.status;
    return v_flex().id("drover-files").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(TYPE.md)
      .child(header).when(usable, el => el.child(filterBar)).child(body)
      .when(Boolean(st), el => el.child(h_flex().flex_none().pl(10).pr(4).py(2).gap(6).items_center().border_t(1).border_color(t.border).text_size(TYPE.xs)
        .text_color(st.level === "error" ? t.blocked : st.level === "warning" ? t.ansi3 : metaColor(t))
        .child(div().flex_1().min_w(0).child(st.text))
        .child(iconButton({ id: "df-status-x", icon: UI("close"), label: "Dismiss", onClick: cx => { this.status = null; cx.notify(); } }, t))));
  }

  // ---------- menu (popup copy) ----------

  initMenu(cx) {
    this.m = props(); this.armed = null; this.busy = null; this.err = null;
    this.items = menuItems(this.m.spec);
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  closeSelf() { closeOverlay(props().overlay); }

  pick(it, cx) {
    if (!it || it.disabled || this.busy) return;
    const m = this.m;
    const send = (id) => { setShared(SHARED.act, { panel: m.panel, id, abs: m.abs, at: Date.now() }); this.closeSelf(); };
    const job = (label, work) => {
      this.busy = label; this.err = null; cx.notify();
      cx.spawn(async cx => {
        try { await work(); this.busy = null; this.closeSelf(); }
        catch (e) { this.busy = null; this.err = firstLine(e); cx.notify(); }
      });
    };
    const ask = (kind) => {
      const folder = m.spec.dir ? m.abs : parent(m.abs);
      openOverlay({ mod: MOD, kind: "dialog", width: 420, height: 236,
        props: { ask: kind, abs: m.abs, folder, root: m.root, name: kind === "rename" ? basename(m.abs) : "" } });
      this.closeSelf();
    };
    switch (it.id) {
      case "viewer": case "pin-here": return send(it.id);
      case "system": return job("Opening…", () => openSystem(m.abs, m.spec.dir, m.on));
      case "reveal": return job("Showing…", () => reveal(m.abs, m.spec.dir, m.on));
      case "copy-path": cx.write_to_clipboard(m.abs); return this.closeSelf();
      case "copy-rel": cx.write_to_clipboard(relOf(m.root, m.abs) ?? m.abs); return this.closeSelf();
      case "new-file": case "new-folder": case "rename": return ask(it.id);
      case "trash": {
        if (this.armed !== "trash") {
          const at = this.armedAt = Date.now();
          this.armed = "trash"; this.err = null;
          cx.timer.after(4000, cx => { if (this.armedAt === at) { this.armed = null; cx.notify(); } });
          return cx.notify();
        }
        return job("Moving to Trash…", async () => {
          await moveToTrash(m.abs, m.root, m.on);
          setShared(SHARED.bump, { n: Date.now(), reveal: null });
        });
      }
      default: return;
    }
  }

  renderMenu() {
    const t = theme(), m = this.m;
    const item = (it) => {
      if (!it) return div().h(1).my(4).mx(6).bg(t.border);
      const armed = it.id === "trash" && this.armed === "trash";
      return h_flex().id(`mi-${it.id}`).h(30).px(10).gap(8).items_center().rounded(6)
        .when(!it.disabled && !armed, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
        .when(armed, el => el.cursor_pointer().bg(t.ansi1))
        .text_color(armed ? t.background : it.disabled ? t.dim : it.danger ? t.ansi1 : t.foreground)
        .on_click((_e, cx) => this.pick(it, cx))
        .when(Boolean(it.why), el => el.tooltip(it.why))
        .child(div().flex_1().min_w(0).truncate().child(armed ? "Click again to move to Trash" : it.label));
    };
    return v_flex().id("df-menu").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.closeSelf(); cx.stop_propagation(); } })
      .w_full().p(5).bg(t.popover).text_size(TYPE.sm).text_color(t.foreground)
      .child(mono(div().px(10).pt(4).pb(5).text_size(TYPE.xs).text_color(metaColor(t, t.popover)).truncate().child(m.rel ? basename(m.abs) : displayRoot(m.root, home()))))
      .children(this.items.map(item))
      .when(Boolean(this.busy || this.err), el => el.child(div().px(10).py(5).text_size(TYPE.xs).text_color(this.err ? t.blocked : metaColor(t, t.popover)).child(this.err || this.busy)));
  }

  // ---------- name prompt (dialog copy) ----------

  initAsk(cx) {
    const p = props();
    this.a = p; this.confirm = null; this.err = null; this.busy = false;
    const name = p.name ?? "", dot = name.lastIndexOf(".");
    this.input = InputState.new({ value: name, placeholder: p.ask === "new-folder" ? "folder name" : "file name" });
    if (name) this.input.set_selected_range({ start: 0, end: dot > 0 ? dot : name.length });
    this.input.on("change", (_e, cx) => { this.confirm = null; this.err = null; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  submit(cx) {
    if (this.busy) return;
    const a = this.a, name = this.input.value();
    this.busy = true; this.err = null; cx.notify();
    cx.spawn(async cx => {
      try {
        let target;
        if (a.ask === "new-file") target = await newFile(a.folder, name, null);
        else if (a.ask === "new-folder") target = await newFolder(a.folder, name, null);
        else {
          // The second click on Replace (same name, already warned) is the overwrite.
          const r = await renameEntry(a.abs, name, this.confirm === name, null);
          if (r.confirm) { this.confirm = name; this.busy = false; cx.notify(); return; }
          target = r.done;
        }
        setShared(SHARED.bump, { n: Date.now(), reveal: target });
        closeOverlay(props().overlay);
      } catch (e) { this.err = firstLine(e); this.busy = false; cx.notify(); }
    });
  }

  renderAsk() {
    const t = theme(), a = this.a;
    const title = a.ask === "rename" ? `Rename ${basename(a.abs)}` : a.ask === "new-file" ? "New file" : "New folder";
    return v_flex().id("df-ask").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(title)).child(div().text_size(TYPE.xs).text_color(metaColor(t, t.popover)).child("Esc")))
      .child(mono(div().pt(6).pb(8).text_size(TYPE.xs).text_color(metaColor(t, t.popover)).truncate().child(`In ${displayRoot(a.ask === "rename" ? parent(a.abs) : a.folder, home())}`)))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(this.err ? t.ansi1 : t.accent).bg(t.background).text_size(TYPE.sm).text_color(t.foreground))
      .child(div().pt(6).min_h(20).text_size(TYPE.xs).text_color(this.err || this.confirm ? t.blocked : metaColor(t, t.popover))
        .child(this.err || (this.confirm ? `A file named ${this.confirm} is already there. Click Replace to overwrite it.` : this.busy ? "Working…" : "")))
      .child(h_flex().pt(10).gap(8).justify_end()
        .child(button({ id: "df-cancel", label: "Cancel", onClick: () => closeOverlay(props().overlay) }, t))
        .child(button({ id: "df-ok", label: this.confirm ? "Replace" : a.ask === "rename" ? "Rename" : "Create", kind: this.confirm ? "danger" : "primary", onClick: cx => this.submit(cx) }, t)));
  }
}
