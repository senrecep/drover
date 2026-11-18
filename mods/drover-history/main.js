// drover-history: past agent sessions (Claude Code, Codex, Pi) for the active space, searchable;
// click or Enter resumes one in a new tab. A block in the drover layout's panel-body stack.
//
// indexer.py keeps a full-text index under <appHome>/data/drover-history/. It runs only while
// this panel is the one on screen (a hidden stack child stays mounted and its timers keep
// ticking, so every tick asks layout()), one run at a time: 1.5 s apart while the first index
// is being built, then once a minute (unchanged transcripts are skipped).
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { exec, run, spaces, panes, home, appHome, layout, shared, setShared, theme, window } from "herdr";
import { TYPE, SPACE, mono, metaColor, panelHeader, iconButton, emptyState } from "./lib/panel-ui.js";
import {
  MOD, SCOPE_KEY, agentLabel, agentColor, normalizeScope, historyShown, scopeOf, updateCall, queryCall,
  parseOut, statusText, resumePlan, shapeRow, moveSel, presentAgents,
  pythonCandidates, probeOk, noPythonText, spaceScopeWorks,
} from "./lib/history.js";

const UI = (name) => `mods/${MOD}/ui/${name}.svg`;
const SCRIPT = () => `${appHome()}/mods/${MOD}/indexer.py`;
const BUDGET = 8;           // seconds of indexing per run
const TICK = 1000;          // how often the view checks whether it is on screen
const BUILDING_GAP = 1500;  // between runs while the index is incomplete
const IDLE_GAP = 60_000;    // between runs once it is complete
const DEBOUNCE = 250;
const LIMIT = 100;
const platform = () => { try { return window()?.platform ?? "macos"; } catch { return "macos"; } };

export default class extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.query = InputState.new({ value: "", placeholder: "Search sessions" });
    this.query.on("change", (_e, cx) => this.queueLoad(cx));
    this.query.on("submit", (_e, cx) => this.resumeAt(this.sel, cx));
    this.query.on("focus", (_e, cx) => { this.queryFocused = true; cx.notify(); });
    this.query.on("blur", (_e, cx) => { this.queryFocused = false; cx.notify(); });
    this.agent = "all";
    this.rows = [];
    this.counts = {};
    this.hint = null;
    this.sel = 0;
    this.hover = null;
    this.index = null;       // last update answer: { done, indexed, total, ... }
    this.error = null;       // one-line indexer error
    this.noPython = false;
    this.loaded = false;
    this.loading = false;
    this.note = null;        // { text, bad, at }
    this.seq = 0;            // load sequence: a slow older answer never replaces a newer one
    this.typed = 0;          // debounce sequence
    this.updating = false;
    this.nextRun = 0;
    this.shown = false;
    this.scopeSeen = null;
    this.lastResume = 0;
    cx.timer.every(TICK, (cx) => this.tick(cx));
    this.tick(cx);
  }

  visible() {
    try { return window().active !== false && historyShown(layout()); } catch { return false; }
  }

  scope() { return normalizeScope(shared(SCOPE_KEY)); }

  where() {
    let s;
    try { s = scopeOf(spaces(), panes(), home()); } catch { s = { space: null, remote: false, cwds: [], exact: [] }; }
    return s;
  }

  tick(cx) {
    const shown = this.visible();
    if (!shown) { this.shown = false; return; }
    const w = this.where();
    const key = `${this.scope()}|${w.space?.id ?? ""}|${w.cwds.join("\n")}|${w.exact.join("\n")}`;
    if (!this.shown || key !== this.scopeSeen) { this.shown = true; this.scopeSeen = key; this.load(cx); }
    if (!this.updating && !this.noPython && Date.now() >= this.nextRun) this.update(cx);
  }

  update(cx) {
    this.updating = true;
    cx.spawn(async (cx) => {
      let more = false;
      try {
        if (!(await this.pythonReady())) { this.noPython = true; return; }
        const [cmd, args] = updateCall(SCRIPT(), appHome(), BUDGET, this.py(), platform());
        const out = parseOut(await exec(cmd, args, { timeout: (BUDGET + 20) * 1000 }));
        if (out.error) this.error = out.error;
        else {
          this.error = null;
          this.index = out;
          more = out.done === false;
          if (out.processed > 0 || out.removed > 0 || !this.loaded) await this.fetch(cx);
        }
      } catch {
        // exec rejects when python can't start, and also when a run outlives its timeout.
        if (await this.pythonMissing()) this.noPython = true;
        else this.error = "Indexing run timed out";
      } finally {
        this.updating = false;
        this.nextRun = Date.now() + (more ? BUILDING_GAP : IDLE_GAP);
        cx.notify();
      }
    });
  }

  /** The python runs use: the one a probe found, else the platform's first choice. */
  py() { return this.python ?? pythonCandidates(platform())[0]; }

  /** Whether python can't be started at all (as opposed to a run that timed out). Keeps the one that runs. */
  async pythonMissing() {
    const p = platform();
    for (const py of pythonCandidates(p)) {
      try {
        if (probeOk(p, await exec(py[0], [...py[1], "-I", "-c", ""], { timeout: 10_000 }))) { this.python = py; return false; }
      } catch { /* not this one */ }
    }
    return true;
  }

  /** Windows has more than one name for python: pick one before the first run. Elsewhere python3 is run as is. */
  async pythonReady() {
    if (this.python || platform() !== "windows") return true;
    return !(await this.pythonMissing());
  }

  queueLoad(cx) {
    const n = ++this.typed;
    cx.timer.after(DEBOUNCE, (cx) => { if (n === this.typed) { this.sel = 0; this.load(cx); } });
  }

  load(cx) { cx.spawn(async (cx) => { await this.fetch(cx); }); }

  async fetch(cx) {
    const n = ++this.seq;
    const w = this.where();
    const scope = this.scope();
    if (scope === "space" && (w.remote || !w.space || (!w.cwds.length && !w.exact.length))) {
      this.rows = []; this.counts = {}; this.hint = null; this.loaded = true; cx.notify();
      return;
    }
    this.loading = true;
    cx.notify();
    try {
      if (!(await this.pythonReady())) { if (n === this.seq) this.noPython = true; return; }
      const [cmd, args] = queryCall(SCRIPT(), appHome(), {
        query: this.query.value(), cwds: scope === "space" ? w.cwds : null, exact: scope === "space" ? w.exact : null,
        limit: LIMIT, agent: this.agent,
      }, this.py());
      const out = parseOut(await exec(cmd, args, { timeout: 30_000 }));
      if (n !== this.seq) return;
      if (out.error) { this.error = out.error; return; }
      this.noPython = false;
      this.error = null;
      const now = Date.now(), homeDir = home();
      this.rows = (out.rows ?? []).map((r) => shapeRow(r, { homeDir, now }));
      this.counts = out.agents ?? {};
      this.hint = out.hint ?? null;
      this.sel = Math.min(this.sel, Math.max(this.rows.length - 1, 0));
      this.loaded = true;
    } catch {
      if (n === this.seq) {
        const missing = await this.pythonMissing();
        if (n === this.seq) {
          if (missing) this.noPython = true;
          else this.error = "Reading the session index timed out";
        }
      }
    } finally {
      if (n === this.seq) { this.loading = false; cx.notify(); }
    }
  }

  say(text, bad, cx) {
    const at = Date.now();
    this.note = { text, bad, at };
    cx.timer.after(bad ? 6000 : 3000, (cx) => { if (this.note?.at === at) { this.note = null; cx.notify(); } });
    cx.notify();
  }

  setScope(scope, cx) {
    setShared(SCOPE_KEY, scope);
    this.sel = 0;
    this.scopeSeen = null; // the next tick reloads; load now so the click answers at once
    this.load(cx);
  }

  setAgent(agent, cx) {
    this.agent = agent;
    this.sel = 0;
    this.load(cx);
  }

  clearQuery(cx) {
    this.query.set_value("");
    this.typed++;
    this.sel = 0;
    this.load(cx);
  }

  resumeAt(i, cx) {
    const row = this.rows[i];
    if (!row) return;
    // Enter can reach both the input's submit and the panel's key handler: one tab per press.
    const now = Date.now();
    if (now - this.lastResume < 800) return;
    this.lastResume = now;
    this.sel = i;
    cx.spawn(async (cx) => {
      let exists = row.exists;
      if (row.cwd) {
        try { exists = (await exec("test", ["-d", row.cwd], { timeout: 5000 })).code === 0; } catch { exists = false; }
      }
      const plan = resumePlan(row, spaces(), exists);
      if (!plan.ok) { this.say(plan.reason, true, cx); return; }
      run("tab.new", plan.args);
      this.say(`Resuming in a new tab: ${row.title}`, false, cx);
    });
  }

  copyId(row, cx) {
    cx.write_to_clipboard(row.id);
    this.say("Copied session id", false, cx);
  }

  onKey(e, cx) {
    const k = e.key;
    if (k === "down" || k === "up") {
      this.sel = moveSel(this.sel, k === "down" ? 1 : -1, this.rows.length);
      if (this.rows.length) this.scroll.scroll_to_item(this.sel);
    } else if (k === "enter") this.resumeAt(this.sel, cx);
    else if (k === "escape" && this.query.value()) this.clearQuery(cx);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // ---------- render ----------

  toggle({ id, label, active, onClick }, t) {
    return h_flex().id(id).h(22).px(8).flex_none().items_center().rounded(5).cursor_pointer()
      .role("radio_button").accessibility_label(active ? `${label}, selected` : label).tab_index(0)
      .text_size(TYPE.xs).font_medium()
      .text_color(active ? t.foreground : metaColor(t))
      .when(active, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover)).focus((s) => s.border_1().border_color(t.accent))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); cx.notify(); })
      .on_key_down((e, cx) => { if (e.key === "enter" || e.key === "space") { cx.stop_propagation(); onClick(cx); cx.notify(); } })
      .child(label);
  }

  row(r, i, t) {
    const selected = i === this.sel;
    const showCopy = selected || this.hover === r.key;
    const label = `${agentLabel(r.agent)}: ${r.title}. ${r.meta}`;
    return v_flex().id(`hist-row-${i}`).flex_none().px(8).py(5).gap(1).rounded(6).cursor_pointer()
      .role("list_item").accessibility_label(label)
      .when(selected, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_hover((h, cx) => {
        const next = h ? r.key : this.hover === r.key ? null : this.hover;
        if (next !== this.hover) { this.hover = next; cx.notify(); }
      })
      .on_click((_e, cx) => { this.handle.focus(); this.resumeAt(i, cx); })
      .child(h_flex().h(20).gap(6).items_center()
        .child(div().size(8).flex_none().rounded(4).bg(agentColor(r.agent, t)).accessibility_label(agentLabel(r.agent)))
        .child(div().flex_1().min_w(0).truncate().text_size(TYPE.sm).text_color(t.foreground).child(r.title))
        .child(div().w(SPACE.HIT).h(20).flex_none().flex().items_center().justify_center()
          .when(showCopy, (el) => el.child(iconButton({ id: `hist-copy-${i}`, icon: UI("copy"), label: "Copy session id",
            onClick: (cx) => this.copyId(r, cx) }, t)))))
      .child(mono(div().pl(14).truncate().text_size(TYPE.xs).text_color(metaColor(t, selected ? t.selected : t.background)).child(r.meta)))
      .when(Boolean(r.snippet), (el) => el.child(h_flex().id(`hist-snip-${i}`).pl(14).min_w(0).overflow_hidden().text_size(TYPE.xs)
        .when(Boolean(r.snippet.pre), (el) => el.child(div().flex_none().whitespace_nowrap().text_color(metaColor(t)).child(r.snippet.pre)))
        .when(Boolean(r.snippet.hit), (el) => el.child(div().flex_none().px(2).rounded(3).bg(t.raised).font_semibold().text_color(t.foreground).child(r.snippet.hit)))
        .child(div().flex_1().min_w(0).truncate().text_color(metaColor(t)).child(r.snippet.post || ""))));
  }

  body(t) {
    const w = this.where(), scope = this.scope(), q = this.query.value().trim();
    const showAll = { id: "hist-show-all", label: "Show all", onClick: (cx) => this.setScope("all", cx) };
    if (this.noPython) return emptyState({ id: "hist-no-python", tone: "error", icon: UI("history"), ...noPythonText(platform()),
      action: { id: "hist-retry", label: "Retry", onClick: (cx) => { this.noPython = false; this.nextRun = 0; this.load(cx); } } }, t);
    if (this.error) return emptyState({ id: "hist-error", tone: "error", icon: UI("history"), title: "Couldn't read the session index",
      body: String(this.error).split("\n")[0].slice(0, 160),
      action: { id: "hist-retry", label: "Retry", onClick: (cx) => { this.error = null; this.nextRun = 0; this.load(cx); } } }, t);
    if (scope === "space" && w.remote) return emptyState({ id: "hist-remote", icon: UI("history"), title: "This space is on another machine",
      body: "History lists sessions from this computer. Show all to see them.", action: showAll }, t);
    if (scope === "space" && !spaceScopeWorks(platform())) return emptyState({ id: "hist-space-windows", icon: UI("history"),
      title: "This space works on macOS and Linux", body: "On Windows, History can't match sessions to a space's folders. Show all to see them.", action: showAll }, t);
    if (!this.rows.length) {
      if (!this.loaded) return emptyState({ id: "hist-loading", icon: UI("history"), title: "Loading sessions…" }, t);
      if (q && !this.hint) return emptyState({ id: "hist-no-match", icon: UI("search"), title: "No matches",
        body: scope === "space" ? `Nothing in this space matches "${q.slice(0, 60)}".` : `No session matches "${q.slice(0, 60)}".`,
        action: scope === "space" ? { ...showAll, label: "Search all" } : undefined }, t);
      const building = this.index?.done === false;
      return emptyState({ id: "hist-empty", icon: UI("history"), title: building ? "Indexing sessions…" : "No sessions yet",
        body: scope === "space"
          ? "Claude Code, Codex and Pi sessions started in this space's folders show up here."
          : "Claude Code, Codex and Pi sessions on this computer show up here.",
        action: scope === "space" ? showAll : undefined }, t);
    }
    return v_flex().id("hist-list").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).px(4).py(4).gap(1)
      .role("list").accessibility_label("Sessions")
      .children(this.rows.map((r, i) => this.row(r, i, t)));
  }

  render(cx) {
    const t = theme();
    const scope = this.scope();
    const agents = presentAgents(this.counts);
    const status = statusText(this.index);
    const q = this.query.value();
    const header = panelHeader({ id: "hist-header", title: "History", meta: this.loaded ? this.rows.length : undefined,
      busy: this.loading || this.updating && this.index?.done === false,
      actions: [{ id: "hist-refresh", icon: UI("refresh"), label: "Refresh", onClick: (cx) => { this.nextRun = 0; this.load(cx); } }] }, t);
    const filters = h_flex().id("hist-filters").flex_none().px(SPACE.PX).pt(SPACE.GAP).gap(4).items_center().flex_wrap()
      .child(this.toggle({ id: "hist-scope-space", label: "This space", active: scope === "space", onClick: (cx) => this.setScope("space", cx) }, t))
      .child(this.toggle({ id: "hist-scope-all", label: "All", active: scope === "all", onClick: (cx) => this.setScope("all", cx) }, t))
      .when(agents.length > 1 || this.agent !== "all", (el) => el
        .child(div().w(1).h(14).mx(4).flex_none().bg(t.border))
        .child(this.toggle({ id: "hist-agent-all", label: "All agents", active: this.agent === "all", onClick: (cx) => this.setAgent("all", cx) }, t))
        .children([...new Set([...agents, ...(this.agent !== "all" ? [this.agent] : [])])].map((a) =>
          this.toggle({ id: `hist-agent-${a}`, label: agentLabel(a), active: this.agent === a, onClick: (cx) => this.setAgent(a, cx) }, t))));
    const search = h_flex().id("hist-search").h(30).flex_none().mx(SPACE.PX).mt(SPACE.GAP).px(8).gap(6).items_center().rounded(7).border_1()
      .border_color(this.queryFocused ? t.accent : t.border).bg(t.background)
      .child(svg(UI("search")).size(13).flex_none().text_color(metaColor(t)))
      .child(div().flex_1().min_w(0).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.query).h(24).text_size(TYPE.sm)))
      .when(Boolean(q), (el) => el.child(iconButton({ id: "hist-clear", icon: UI("close"), label: "Clear search", onClick: (cx) => this.clearQuery(cx) }, t)));
    const line = (id, text, color) => mono(div().id(id).flex_none().px(SPACE.PX).pt(6).truncate().text_size(TYPE.xs).text_color(color).child(text));
    return v_flex().id("drover-history").size_full().bg(t.background).text_color(t.foreground).text_size(TYPE.sm)
      .track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx))
      .child(header)
      .child(filters)
      .child(search)
      .when(Boolean(status), (el) => el.child(line("hist-status", status, metaColor(t))))
      .when(Boolean(this.hint), (el) => el.child(line("hist-hint", this.hint, metaColor(t))))
      .when(Boolean(this.note), (el) => el.child(div().id("hist-note").flex_none().px(SPACE.PX).pt(6).truncate().text_size(TYPE.xs)
        .text_color(this.note.bad ? t.blocked : metaColor(t)).role("status").child(this.note.text)))
      .child(v_flex().flex_1().min_h(0).pt(4).child(this.body(t)));
  }
}
