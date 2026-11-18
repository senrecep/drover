// Agents: the setup of every coding-agent CLI installed on this computer (Claude Code and its
// cc-mirror variants, Codex, Gemini CLI, Antigravity, Kimi, Kilo, OpenCode, Cursor, Copilot and
// skills-only folders), global and for the focused space's folder. A full-page view; place "none".
//
// Reads outside its folder (through probe.py only, read-only, structure and names only, never env,
// headers, arguments, tokens, keys or provider blocks; credential files and databases are refused):
//   ~/.claude, ~/.claude.json, ~/.cc-mirror/*/config and variant.json (name only), ~/.codex,
//   ~/.agents/skills, ~/.gemini (settings.json, GEMINI.md, agents, skills, commands, extensions),
//   ~/.gemini/antigravity (mcp_config.json, skills), ~/.antigravity/extensions (folder names),
//   ~/.kimi-code or ~/.kimi, ~/.config/kilo, ~/.kilo, ~/.kilocode, ~/.config/opencode, ~/.opencode,
//   ~/.cursor, ~/.copilot, ~/.qwen, ~/.grok, ~/.iflow, ~/.qoder, ~/.config/crush (skills),
//   the focused folder's agent files (CLAUDE.md, AGENTS.md, GEMINI.md, .mcp.json, .claude, .codex,
//   .gemini, .agent, .kilo, .kilocode, .opencode, .cursor, .github), and today's Claude-family and
//   Codex transcripts for context and cost, and all Claude Code (~/.claude/projects) and Codex
//   (~/.codex/sessions, ~/.codex/archived_sessions) transcripts for usage numbers only (timestamp, model,
//   token counts). Binaries are only checked for existence, never run.
// Programs it runs: python3 -I probe.py (reading and parsing) and git rev-parse (read-only, no
// optional locks or fsmonitor) to find the focused folder's repository root.
// Writes only its own hidden caches (.cost-cache-<agent>.json) beside probe.py, and its usage store and
// aggregate cache (usage-store.json, tokens-cache.json: hashed keys and numbers, no paths or text) in
// ~/.config/herdr-app/data/drover-agents.
// Usage: token aggregates from probe.py's own incremental collector, printed as numbers only.
// The file viewer asks probe.py for a listed item by index, never a path.

import { View, div, svg } from "gpui-kit";
import { TYPE, SPACE, mono, metaColor, chip, button as kitButton, iconButton, panelHeader, emptyState } from "./lib/panel-ui.js";
import { v_flex, h_flex, Editor, EditorState, ScrollHandle } from "gpui-base";
import { exec, spaces, panes, focused, terminals, theme, home, appHome, props, readTextFile, settings, window, layout, nextCommand } from "herdr";
import {
  mergePrices, formatTokens, formatUsd, contextView, tildify, shortPath, gitArgs, rootFor, modelRows,
  GROUPS, countSummary, pickAgent, stepAgent, itemDetail, parseCommand,
  tokensAdapter, dayLabel, percent1, heatWeeks, sizeLabel, visibleIn, narrow, navKey,
} from "./lib/parse.js";

const MOD = "drover-agents";
const PROBE = () => `${appHome()}/mods/${MOD}/probe.py`;
const LIST_EVERY = 60_000;
const SESSION_EVERY = 30_000;
const TOKENS_EVERY = 60_000; // the probe answers from its cache until a transcript changes
const VIEW_KINDS = new Set(["instructions", "skills", "agents", "commands"]);
const LANG = { md: "markdown", mdc: "markdown", toml: "toml" };
const SHOW = 10; // rows per group before "show all"
const ICON = Object.fromEntries(["refresh", "back", "close"].map((n) => [n, `mods/${MOD}/ui/${n}.svg`]));
ICON.down = `mods/${MOD}/ui/chevron-down.svg`;
ICON.right = `mods/${MOD}/ui/chevron-right.svg`;
// Enter or Space on a focused row runs its action, so a tab_index'd div acts as a button.
const press = (el, fn) => el.role("button").tab_index(0).on_key_down((e, cx) => {
  if (e.key === "enter" || e.key === "space") { cx.stop_propagation(); fn(cx); cx.notify(); }
});

// The kit's chip fills with t.raised, which is about the selected row's own fill; on that row the chip
// is drawn on the page background with a border so it stays a visible pill.
const selectedChip = (text, t) => div().flex_none().max_w("100%").truncate().px(6).py(1).rounded(4).bg(t.background)
  .border_1().border_color(t.border).text_size(TYPE.xs).text_color(metaColor(t, t.background)).child(String(text));

async function probe(args) {
  const r = await exec("python3", ["-I", PROBE(), ...args], { timeout: 60_000 });
  const data = JSON.parse(r.stdout.trim() || "{}");
  if (r.code !== 0 || data.error) throw new Error("probe");
  return data;
}

async function git(args, cwd) {
  const r = await exec("git", gitArgs(args), { cwd, timeout: 15_000 });
  return r.code === 0 ? r.stdout : null;
}

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch { /* storage unavailable: keep it for this copy */ }
  },
};

// The focused space, its folder, and the focused pane's folder and foreground process.
function target() {
  const f = focused();
  const space = spaces().find((s) => s.id === f?.space) ?? spaces().find((s) => s.active) ?? null;
  const pane = panes().find((p) => p.pane === f?.pane) ?? null;
  const cwd = f?.cwd ?? pane?.cwd ?? space?.folder ?? "";
  const term = f?.terminal ? terminals().find((t) => t.address === f.terminal) : null;
  const pid = term?.foreground?.pid ?? null;
  return { space, cwd, pid, folder: space?.folder || cwd || "" };
}

export default class Agents extends View {
  init(_props, cx) {
    this.data = null; // { agents, folders, note } | { failed: true }
    this.selected = store.get("agent", null);
    this.session = null; // per agent id: probe session output
    this.sessionFor = null;
    this.expanded = new Set();
    this.collapsed = new Set(store.get("collapsed", []));
    this.gitRoot = null;
    this.prices = mergePrices();
    this.busy = { list: false, session: false, tokens: false };
    this.tokens = {}; // adapter → { data, at } | { failed, at }
    this.listFolders = []; // the raw folders the list was read for (data.folders is tildified)
    this.view = null; // the file viewer: { agent, which, kind, index, name, data?, error?, loading }
    this.code = null; // its read-only EditorState
    this.width = 0; // measured width of the page; narrow() stacks list and detail into one column
    this.page = "list"; // narrow only: "list" or "detail" (the detail has a back control)
    this.h = cx.focus_handle();
    this.scroll = ScrollHandle.new(); // the sidebar list, so the selected row stays in view
    this.key = null;
    this.listAt = 0;
    this.sessionAt = 0;
    cx.timer.every(1000, (cx) => this.tick(cx));
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${appHome()}/mods/${MOD}/config.json`).catch(() => null);
      let cfg = null;
      try {
        cfg = text ? JSON.parse(text) : null;
      } catch {
        cfg = null;
      }
      this.prices = mergePrices(cfg, props()?.prices ? { prices: props().prices } : null);
      cx.notify();
    });
    // keys.json or `herdr-app do drover-agents.<cmd>`: next, prev, select:<id>, refresh.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = parseCommand(await nextCommand());
        if (!c) continue;
        if (c.action === "refresh") this.refresh(cx);
        else if (c.action === "select") this.select(c.id, cx);
        else if (c.action === "close") this.closeView(cx);
        else if (c.action === "open") {
          const a = this.current();
          const it = a?.[c.which]?.[c.kind]?.[c.index];
          if (a && it?.view) this.openItem(a, c.which, c.kind, c.index, it.name, cx);
        }
        else this.select(stepAgent(this.data?.agents, this.current()?.id, c.action === "next" ? 1 : -1), cx);
        cx.notify();
      }
    });
    this.tick(cx);
  }

  // Shown only when the Agents page is the active page (or when not inside the pages stack).
  visible() {
    // An overlay copy is on screen while it is open. A layout copy is not when its panel is hidden
    // or another panel-body child is the active one.
    return window()?.active !== false && (Boolean(props()?.overlay) || visibleIn(layout(), MOD));
  }

  // Every second: a new space or folder re-reads the list; timers only while the page is visible.
  tick(cx) {
    const t = target();
    const key = `${t.space?.id}|${t.folder}|${t.cwd}|${t.pid}`;
    const folderChanged = !this.key || this.key.split("|").slice(0, 2).join("|") !== key.split("|").slice(0, 2).join("|");
    const paneChanged = key !== this.key;
    this.key = key;
    if (folderChanged) this.loadList(cx);
    else if (this.visible() && Date.now() - this.listAt >= LIST_EVERY) this.loadList(cx);
    if (paneChanged || (this.visible() && Date.now() - this.sessionAt >= SESSION_EVERY)) this.loadSession(cx);
    this.loadTokens(cx);
  }

  refresh(cx) {
    this.loadList(cx, true);
    this.sessionAt = 0;
    this.loadSession(cx);
  }

  remote() {
    return Boolean(target().space?.machine);
  }

  current() {
    const agents = this.data?.agents ?? [];
    const id = pickAgent(agents, this.selected);
    return agents.find((a) => a.id === id) ?? null;
  }

  select(id, cx) {
    if (!id || id === this.selected) return;
    this.selected = id;
    store.set("agent", id);
    this.sessionAt = 0;
    this.loadSession(cx);
    this.loadTokens(cx);
    if (this.view && this.view.agent !== id) this.closeView(cx);
    cx.notify();
  }

  // Tokens aggregates for the shown agent's adapter: only while the page is visible, at most once a minute.
  loadTokens(cx, force = false) {
    const adapter = tokensAdapter(this.current()?.id);
    if (!adapter || this.busy.tokens || this.remote() || !this.visible()) return;
    const prev = this.tokens[adapter];
    if (!force && prev && Date.now() - prev.at < TOKENS_EVERY) return;
    this.busy.tokens = true;
    cx.spawn(async (cx) => {
      try {
        this.tokens[adapter] = { data: await probe(["tokens", adapter]), at: Date.now() };
      } catch {
        this.tokens[adapter] = { failed: true, at: Date.now() };
      } finally {
        this.busy.tokens = false;
      }
      cx.notify();
    });
  }

  // The viewer: probe.py resolves the file from its own listing (agent, scope, kind, index, name).
  openItem(a, which, kind, index, name, cx) {
    if (!VIEW_KINDS.has(kind) || this.remote()) return;
    const req = { agent: a.id, which, kind, index, name, loading: true };
    this.view = req;
    if (this.visible()) this.h.focus(); // never take the keyboard from a terminal on another page
    const folders = which === "project" ? this.listFolders.flatMap((f) => ["--folder", f]) : [];
    cx.spawn(async (cx) => {
      let data = null;
      try {
        data = await probe(["read", a.id, `${which}.${kind}`, String(index), "--name", String(name), ...folders]);
      } catch {
        data = null;
      }
      if (this.view !== req) return; // closed or replaced meanwhile
      this.code?.release();
      this.code = data ? EditorState.new({ language: LANG[data.ext] ?? "text", value: String(data.content ?? ""), readonly: true, soft_wrap: true,
        line_numbers: true, folding: false, font_family: settings().font_family ?? "JetBrains Mono", font_size: 12,
        syntax: { keyword: theme().ansi5, string: theme().ansi2, comment: theme().dim, function: theme().ansi4, type: theme().ansi3, number: theme().ansi1, constant: theme().ansi6 } }) : null;
      this.view = { ...req, loading: false, data, error: data ? null : "This file can't be shown." };
      cx.notify();
    });
    cx.notify();
  }

  closeView(cx) {
    if (!this.view) return;
    this.view = null;
    this.code?.release();
    this.code = null;
    cx.notify();
  }

  // The probe returns the path with the home folder as "~"; only a whole absolute path is opened.
  openInEditor(path) {
    const full = path.startsWith("~/") ? home() + path.slice(1) : path;
    if (!full.startsWith("/") || full.includes("…")) return;
    exec("open", ["-t", full]).catch(() => null);
  }

  loadList(cx) {
    if (this.busy.list || this.remote()) return;
    this.busy.list = true;
    this.listAt = Date.now();
    const key = this.key;
    cx.spawn(async (cx) => {
      try {
        const t = target();
        const root = t.folder ? await git(["rev-parse", "--show-toplevel"], t.folder).catch(() => null) : null;
        this.gitRoot = rootFor(t.folder, root?.trim() || null);
        const folders = [...new Set([t.folder, this.gitRoot].filter(Boolean))];
        const data = await probe(["list", ...folders.flatMap((f) => ["--folder", f])]);
        if (key === this.key || !this.data) {
          this.data = data;
          this.listFolders = folders;
        }
        if (!this.sessionFor) this.loadSession(cx);
      } catch {
        this.data = this.data?.agents ? this.data : { failed: true };
      } finally {
        this.busy.list = false;
      }
      cx.notify();
    });
  }

  loadSession(cx) {
    const a = this.current();
    if (!a || this.busy.session || this.remote()) return;
    if (!a.sessions) {
      this.session = null;
      this.sessionFor = a.id;
      return;
    }
    this.busy.session = true;
    this.sessionAt = Date.now();
    const t = target();
    cx.spawn(async (cx) => {
      try {
        const args = ["session", "--agent", a.id, "--cwd", t.cwd, "--prices", JSON.stringify(this.prices)];
        if (t.pid) args.push("--pid", String(t.pid));
        const s = await probe(args);
        if (this.current()?.id === a.id) {
          this.session = s;
          this.sessionFor = a.id;
        }
      } catch {
        this.session = { failed: true };
        this.sessionFor = a.id;
      } finally {
        this.busy.session = false;
      }
      if (this.current()?.id !== a.id) this.loadSession(cx);
      cx.notify();
    });
  }

  toggle(key, cx) {
    if (this.expanded.has(key)) this.expanded.delete(key);
    else this.expanded.add(key);
    cx.notify();
  }

  // ---------- drawing ----------

  render() {
    const t = theme();
    const agents = this.data?.agents ?? [];
    const a = this.current();
    const small = narrow(this.width);
    const detail = v_flex().id("agents-detail").flex_1().min_w(0).h_full().overflow_y_scrollbar().px(small ? SPACE.PX : 20).pt(14).pb(24).gap(16)
      .when(this.remote(), (el) => el.child(emptyState({ id: "agents-remote", title: "Remote space", body: "Agent files are read on this computer only." }, t)))
      .when(!this.remote() && !this.data, (el) => el.child(this.dim(t, "Reading agent folders…")))
      .when(!this.remote() && Boolean(this.data?.failed), (el) => el.child(emptyState({ id: "agents-failed", tone: "error", title: "Could not read the agent folders", body: "Try Refresh. If it keeps failing, check that python3 is installed." }, t)))
      .when(!this.remote() && Boolean(this.data?.agents) && !a, (el) => el.child(emptyState({ id: "agents-none", title: "No coding agents found", body: "No agent setup was found on this computer or in this folder." }, t)))
      .when(!this.remote() && Boolean(a), (el) => el.children(this.detail(t, a)));
    let body;
    if (!small) {
      body = h_flex().flex_1().min_h(0).items_start()
        .child(this.sidebar(t, agents, a, false))
        .child(detail)
        .when(Boolean(this.view), (el) => el.child(this.viewer(t, false)));
    } else if (this.view) {
      body = h_flex().flex_1().min_h(0).child(this.viewer(t, true));
    } else if (this.page === "detail" && a) {
      body = v_flex().flex_1().min_h(0).child(detail);
    } else if (!agents.length) {
      body = h_flex().flex_1().min_h(0).items_start().child(detail);
    } else {
      body = h_flex().flex_1().min_h(0).items_start().child(this.sidebar(t, agents, a, true));
    }
    return v_flex().id("agents-root").size_full().bg(t.background).text_color(t.foreground).text_size(TYPE.sm)
      .track_focus(this.h)
      .on_size_change((size, cx) => {
        const was = narrow(this.width);
        this.width = size.width;
        if (narrow(size.width) !== was) cx.notify();
      })
      .on_key_down((e, cx) => {
        const act = navKey({ key: e.key, ids: agents.map((x) => x.id), current: a?.id ?? null, small, page: this.page, viewOpen: Boolean(this.view) });
        if (!act) return;
        cx.stop_propagation();
        if (act.closeView) this.closeView(cx);
        if (act.select) {
          this.select(act.select, cx);
          const at = agents.findIndex((x) => x.id === act.select);
          if (at >= 0) this.scroll.scroll_to_item(at + (this.data?.folders?.[0] || this.data?.note ? 1 : 0));
        }
        if (act.page) this.page = act.page;
        cx.notify();
      })
      .child(this.header(t, agents.length, small, a))
      .child(body);
  }

  viewer(t, full) {
    const v = this.view;
    const d = v.data;
    const path = d?.path ?? "";
    const canOpen = Boolean(d) && (path.startsWith("~/") || path.startsWith("/")) && !path.includes("…");
    const m = metaColor(t, t.surface);
    const trunc = Boolean(d?.truncated);
    return v_flex().id("agents-viewer").when(full, (el) => el.flex_1()).when(!full, (el) => el.flex_none().w("45%")).h_full().min_w(0).border_l_1().border_color(t.border).bg(t.surface)
      .child(h_flex().flex_none().h(SPACE.HEADER_H).px(SPACE.PX).gap(SPACE.GAP).items_center().border_b_1().border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(TYPE.md).font_semibold().child(d?.name ?? v.name))
        .child(chip(v.kind, t))
        .when(canOpen, (el) => el.child(kitButton({ id: "viewer-open", label: "Open in editor", onClick: () => this.openInEditor(path) }, t)))
        .child(iconButton({ id: "viewer-close", icon: ICON.close, label: "Close", onClick: (cx) => this.closeView(cx) }, t)))
      .child(h_flex().flex_none().px(SPACE.PX).py(6).gap(8).items_center().min_w(0).text_size(TYPE.xs).text_color(m)
        .when(v.loading || !d, (el) => el.child(div().child(v.loading ? "Reading…" : " ")))
        .when(!v.loading && Boolean(d), (el) => el
          .child(mono(div().id("viewer-path").flex_1().min_w(0).truncate().tooltip(path).child(shortPath(path, 56))))
          .child(mono(div().flex_none().child(sizeLabel(d.size))))
          .when(trunc, (e2) => e2.child(div().flex_none().text_color(t.ansi3 ?? t.working).child("Truncated at 256 KB")))))
      .child(this.code && d
        ? Editor.new(this.code).flex_1().min_h(0)
        : div().p(14).text_color(v.error ? t.blocked : m).child(v.error ?? "Reading…"));
  }

  header(t, n, small, a) {
    const busy = this.busy.list || this.busy.session;
    const refresh = { id: "agents-refresh", icon: ICON.refresh, label: "Refresh", onClick: (cx) => this.refresh(cx) };
    if (small && this.page === "detail" && a && !this.view) {
      // Detail view: the back control is the header's leading action and the agent is its title.
      return h_flex().id("agents-header").h(SPACE.HEADER_H).flex_none().px(SPACE.PX).gap(SPACE.GAP).items_center()
        .border_b_1().border_color(t.border).role("toolbar").accessibility_label(a.name)
        .child(iconButton({ id: "agents-back", icon: ICON.back, label: "Back to agents", onClick: (cx) => { this.page = "list"; cx.notify(); } }, t))
        .child(div().flex_1().min_w(0).truncate().text_size(TYPE.md).font_semibold().text_color(t.foreground).child(a.name))
        .when(busy, (el) => el.child(div().text_size(TYPE.xs).text_color(metaColor(t)).accessibility_label("Loading")
          .frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
        .child(iconButton(refresh, t));
    }
    return panelHeader({ id: "agents-header", title: "Agents", meta: this.data?.agents ? `${n} detected` : undefined, busy, actions: [refresh] }, t);
  }

  // The focused project folder, tail-preserving, as data (mono).
  folderRow(t) {
    const f = this.data?.folders?.[0];
    return h_flex().flex_none().px(8).pb(6).gap(6).items_center().min_w(0).text_size(TYPE.xs).text_color(metaColor(t, t.surface))
      .child(div().flex_none().child("Project"))
      .child(f
        ? mono(div().id("agents-folder").flex_1().min_w(0).truncate().tooltip(f).child(shortPath(f, 40)))
        : div().flex_1().min_w(0).truncate().child("Home folder"));
  }

  sidebar(t, agents, a, full) {
    const m = metaColor(t, t.surface);
    return v_flex().id("agents-list").when(full, (el) => el.flex_1().min_w(0)).when(!full, (el) => el.flex_none().w(264).border_r_1()).h_full().overflow_y_scrollbar().track_scroll(this.scroll).border_color(t.border).bg(t.surface).py(8).px(8).gap(2)
      .when(Boolean(this.data?.folders?.[0] || this.data?.note), (el) => el.child(this.folderRow(t)))
      .children(agents.map((x) => {
        const on = x.id === a?.id;
        const pick = (cx) => {
          this.select(x.id, cx);
          if (full) this.page = "detail";
          cx.notify();
        };
        return press(v_flex().id(`agent-${x.id}`).flex_none().min_h(SPACE.ROW_H).px(8).py(6).gap(2).rounded(6).cursor_pointer()
          .when(on, (el) => el.bg(t.selected))
          .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
          .focus((s) => s.bg(t.hover).border_1().border_color(t.accent))
          .on_click((_e, cx) => pick(cx))
          .child(h_flex().gap(8).items_center().min_w(0)
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(x.name))
            .child(on ? selectedChip(x.kind, t) : chip(x.kind, t)))
          .child(div().truncate().text_size(TYPE.xs).text_color(m).child(x.error ? "unreadable" : countSummary(x.counts))), pick);
      }));
  }

  // Secondary 12 (TYPE.sm) text in a readable meta color (never t.dim, which fails contrast).
  dim(t, text, on) {
    return div().text_size(TYPE.sm).text_color(metaColor(t, on ?? t.background)).child(text);
  }

  // A section or card heading that folds its body; the state is remembered across sessions.
  isOpen(key) {
    return !this.collapsed.has(key);
  }

  toggleSection(key, cx) {
    if (this.collapsed.has(key)) this.collapsed.delete(key);
    else this.collapsed.add(key);
    store.set("collapsed", [...this.collapsed]);
    cx.notify();
  }

  foldHead(t, key, title, right, { size = TYPE.sm, on = t.background, titleMono = false } = {}) {
    const open = this.isOpen(key);
    const m = metaColor(t, on);
    const name = div().flex_none().text_size(size).font_semibold().text_color(t.foreground).child(title);
    const pressToggle = (cx) => this.toggleSection(key, cx);
    return press(h_flex().id(`fold-${key}`).flex_none().min_h(SPACE.ROW_H).gap(6).items_center().min_w(0).px(4).mx(-4).rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).focus((s) => s.bg(t.hover).border_1().border_color(t.accent))
      .tooltip(open ? `Collapse ${title}` : `Expand ${title}`)
      .on_click((_e, cx) => pressToggle(cx))
      .child(svg(open ? ICON.down : ICON.right).size(12).flex_none().text_color(m))
      .child(titleMono ? mono(name) : name)
      .child(right ?? div())
      , pressToggle);
  }

  detail(t, a) {
    const out = [this.agentHead(t, a), this.sessionCard(t, a)];
    const usage = this.usageCard(t, a);
    if (usage) out.push(usage);
    if (a.error) {
      out.push(emptyState({ id: "agent-error", tone: "error", title: "Could not read this agent", body: "Its configuration files could not be read." }, t));
      return out;
    }
    out.push(this.scope(t, a, "global", "Global", a.roots));
    if (a.kind === "skills only") return out;
    if (a.project) out.push(this.scope(t, a, "project", "Project", this.data?.folders ?? []));
    else out.push(this.scope(t, a, "project", "Project", [], this.data?.note ?? (a.projectError ? "Could not read the project files." : "No focused folder.")));
    return out;
  }

  agentHead(t, a) {
    const meta = [
      ["Binary", a.binary, "not found at the known paths"],
      ["Model", a.model, "not set (or not a plain id)"],
    ];
    return v_flex().flex_none().gap(8)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(TYPE.md).font_semibold().child(a.name))
        .child(chip(a.kind, t, { color: t.accent })))
      .child(h_flex().flex_wrap().gap(16).children(meta.map(([k, v, none]) => h_flex().gap(6).min_w(0)
        .child(div().text_color(metaColor(t)).child(k))
        .child(v ? mono(div().min_w(0).truncate().text_color(t.foreground).child(v)) : div().text_color(metaColor(t)).child(none)))));
  }

  card(t) {
    return v_flex().flex_none().gap(6).p(SPACE.PX).rounded(6).bg(t.surface).border_1().border_color(t.border);
  }

  sessionCard(t, a) {
    const on = t.surface;
    const m = metaColor(t, on);
    const card = this.card(t)
      .child(this.foldHead(t, "session", "Session · focused pane", div().flex_1().text_size(TYPE.xs).text_color(m).text_right().child(a.sessions ? "estimate" : ""), { on }));
    if (!this.isOpen("session")) return card;
    if (!a.sessions) return card.child(this.dim(t, "Sessions are not supported for this agent.", on));
    const s = this.sessionFor === a.id ? this.session : null;
    if (this.remote()) return card.child(this.dim(t, "Remote space: not read.", on));
    if (!s) return card.child(this.dim(t, "Reading…", on));
    if (s.failed) return card.child(this.dim(t, "Could not read the transcripts.", on));
    if (s.unsupported) return card.child(this.dim(t, "No transcripts folder for this agent.", on));
    const v = contextView(s.context);
    if (v) {
      const level = v.fill >= 0.85 ? t.blocked : v.fill >= 0.65 ? t.ansi3 ?? t.working : t.accent;
      card.child(h_flex().gap(12).items_center()
        .child(mono(div().flex_none().child(v.pct)))
        .child(div().flex_1().h(4).rounded(2).bg(t.raised)
          .child(div().h_full().rounded(2).bg(level).w(`${Math.max(1, Math.round(v.fill * 100))}%`)))
        .child(mono(div().flex_none().text_color(m).child(v.detail))));
      card.child(h_flex().gap(6).min_w(0).text_size(TYPE.xs).text_color(m)
        .child(mono(div().flex_none().max_w("60%").truncate().child(s.context.model ?? "model unknown")))
        .child(div().min_w(0).truncate().child(s.how ? `· ${s.how}` : "")));
    } else {
      card.child(this.dim(t, s.session ? "No usage in this session's transcript yet." : `No ${a.sessions === "codex" ? "Codex rollout today" : "session"} for the focused folder.`, on));
    }
    card.child(h_flex().flex_wrap().gap(10).pt(2)
      .when(Boolean(s.sessionCost), (el) => el.child(this.costBlock(t, "This session", s.sessionCost, `${a.id}-cost-s`)))
      .child(this.costBlock(t, `Today (${s.files} file${s.files === 1 ? "" : "s"})`, s.today, `${a.id}-cost-t`)));
    return card;
  }

  // Token totals for this agent; omitted when its adapter has none.
  usageCard(t, a) {
    const adapter = tokensAdapter(a.id);
    if (!adapter) return null;
    const ins = this.tokens[adapter];
    const data = ins?.data && !ins.data.absent ? ins.data : null;
    if (!data && ins) return null; // nothing to show (absent adapters stay quiet)
    const on = t.surface;
    const card = this.card(t).gap(10)
      .child(this.foldHead(t, "usage", "Usage", div().flex_1(), { on }));
    if (!this.isOpen("usage")) return card;
    if (data) card.child(this.tokensBlock(t, data));
    else card.child(this.dim(t, "Reading token totals…", on));
    return card;
  }

  label(t, text) {
    return div().text_size(TYPE.xs).font_semibold().text_color(metaColor(t, t.surface)).child(text);
  }

  stat(t, label, value, sub) {
    return v_flex().flex_none().min_w(118).gap(2)
      .child(this.label(t, label))
      .child(mono(div().text_size(TYPE.lg).text_color(t.foreground).child(value)))
      .child(mono(div().text_size(TYPE.xs).text_color(metaColor(t, t.surface)).child(sub || " ")));
  }

  tokensBlock(t, d) {
    const m = metaColor(t, t.surface);
    const weeks = heatWeeks(d.days);
    const shade = [0, 0.3, 0.55, 0.8, 1];
    const top = d.models ?? [];
    const max = Math.max(1, ...top.map((x) => x.tokens));
    return v_flex().gap(10)
      .child(h_flex().gap(8).items_center()
        .child(this.label(t, "Tokens"))
        .child(div().text_size(TYPE.xs).text_color(m).child(`${formatTokens(d.sessions)} sessions · ${d.activeDays ?? 0} active days`)))
      .child(h_flex().flex_wrap().gap(18)
        .child(this.stat(t, "Lifetime tokens", formatTokens(d.total), `in ${formatTokens(d.input)} · out ${formatTokens(d.output)}`))
        .child(this.stat(t, "Peak day", d.peak ? formatTokens(d.peak.tokens) : "—", d.peak ? dayLabel(d.peak.day) : ""))
        .child(this.stat(t, "Today", formatTokens(d.today), ""))
        .child(this.stat(t, "Cache hit", percent1(d.cacheHit), `read ${formatTokens(d.cacheRead)}`)))
      .child(h_flex().flex_wrap().items_start().gap(24)
        .child(v_flex().flex_none().gap(4)
          .child(this.label(t, "Last 12 weeks"))
          .child(h_flex().gap(2).children(weeks.map((w) => v_flex().gap(2).children(w.map((lv) =>
            div().w(9).h(9).rounded(2).bg(lv ? t.accent : t.raised).opacity(lv ? shade[lv] : 1)))))))
        .when(top.length > 0, (el) => el.child(v_flex().flex_1().min_w(220).max_w(420).gap(3)
          .child(this.label(t, "Top models"))
          .children(top.map((x) => h_flex().gap(8).items_center().text_size(TYPE.xs)
            .child(mono(div().flex_none().w(150).truncate().text_color(m).child(x.model)))
            .child(div().flex_1().h(3).rounded(2).bg(t.raised)
              .child(div().h_full().rounded(2).bg(t.accent).opacity(0.7).w(`${Math.max(1, Math.round((x.tokens / max) * 100))}%`)))
            .child(mono(div().flex_none().w(52).text_right().text_color(t.foreground).child(formatTokens(x.tokens)))))))));
  }

  costBlock(t, label, block, id) {
    const m = metaColor(t, t.surface);
    const rows = modelRows(block);
    const open = this.expanded.has(id);
    const toggle = (cx) => this.toggle(id, cx);
    return v_flex().flex_none().when(narrow(this.width), (el) => el.w_full()).when(!narrow(this.width), (el) => el.w(320)).gap(2)
      .child(press(h_flex().id(id).h(SPACE.HIT).px(6).gap(8).items_center().rounded(6).cursor_pointer().hover((el) => el.bg(t.hover))
        .focus((s) => s.bg(t.hover).border_1().border_color(t.accent))
        .on_click((_e, cx) => toggle(cx))
        .child(div().w(12).flex_none().child(rows.length ? svg(open ? ICON.down : ICON.right).size(12).text_color(m) : div()))
        .child(div().flex_1().text_color(m).child(label))
        .child(mono(div().text_size(TYPE.xs).text_color(m).child(block ? `${formatTokens(block.tokens)} tok` : "")))
        .child(mono(div().text_color(t.foreground).child(block ? formatUsd(block.cost) : "—"))), toggle))
      .when(open, (el) => el.children(rows.map((r) => h_flex().pl(24).pr(6).gap(8).text_size(TYPE.xs)
        .child(mono(div().flex_1().min_w(0).truncate().text_color(m).child(r.model)))
        .child(mono(div().flex_none().text_color(m).child(formatTokens(r.tokens))))
        .child(mono(div().flex_none().w(56).text_right().text_color(t.foreground).child(formatUsd(r.cost)))))));
  }

  // A top-level section (Global / Project): collapsible, with its folders as mono data on the heading.
  scope(t, a, which, title, folders, note) {
    const g = a[which] ?? {};
    const key = `${a.id}:${which}`;
    const full = GROUPS.filter((x) => (g[x.id] ?? []).length > 0);
    const empty = GROUPS.filter((x) => !(g[x.id] ?? []).length);
    const paths = folders.map((f) => tildify(f, home()));
    const sub = paths.length ? mono(div().flex_1().min_w(0).truncate().text_size(TYPE.xs).text_color(metaColor(t)).tooltip(paths.join("\n")).child(paths.map((p) => shortPath(p, 36)).join("  ·  "))) : div().flex_1();
    const sec = v_flex().flex_none().gap(8)
      .child(h_flex().pb(4).border_b_1().border_color(t.border).child(this.foldHead(t, key, title, sub, { size: TYPE.md }).flex_1().min_w(0)));
    if (!this.isOpen(key)) return sec;
    if (note) return sec.child(this.dim(t, note));
    return sec
      .when(!full.length, (el) => el.child(this.dim(t, "Nothing configured here.")))
      .child(h_flex().flex_wrap().items_start().gap(12).children(full.map((x) => this.groupCard(t, a, which, x, g[x.id]))))
      .when(full.length > 0 && empty.length > 0, (el) => el.child(this.dim(t, `None: ${empty.map((x) => x.label).join(", ")}`)));
  }

  groupCard(t, a, which, grp, items) {
    const key = `${a.id}:${which}:${grp.id}`;
    const on0 = t.surface;
    const m = metaColor(t, on0);
    const all = this.expanded.has(key);
    const shown = all ? items : items.slice(0, SHOW);
    const fold = this.isOpen(`g:${key}`);
    const card = v_flex().id(`g-${key}`).flex_none().when(narrow(this.width), (el) => el.w_full()).when(!narrow(this.width), (el) => el.w(380)).min_w(0).p(10).gap(4).rounded(6).bg(t.surface).border_1().border_color(t.border)
      .child(this.foldHead(t, `g:${key}`, grp.label, mono(div().flex_1().text_size(TYPE.xs).text_color(m).text_right().child(String(items.length))), { on: on0 }));
    if (!fold) return card;
    return card
      .children(shown.map((it, i) => {
        const detail = itemDetail(grp.id, it);
        const open = Boolean(it.view) && VIEW_KINDS.has(grp.id);
        const on = open && this.view?.agent === a.id && this.view.which === which && this.view.kind === grp.id && this.view.index === i;
        const go = (cx) => this.openItem(a, which, grp.id, i, it.name, cx);
        const name = div().flex_none().max_w(grp.id === "instructions" ? 260 : 170).truncate().text_color(t.foreground).child(it.name);
        const row = h_flex().id(`i-${key}-${i}`).gap(8).min_w(0).min_h(SPACE.ROW_H).items_center().mx(-4).px(4).rounded(6)
          .when(on, (el) => el.bg(t.selected))
          .child(grp.id === "instructions" ? mono(name) : name)
          .child(div().flex_1().min_w(0).truncate().text_size(TYPE.xs).text_color(m).child(detail));
        return open && !on
          ? press(row.cursor_pointer().hover((s) => s.bg(t.hover)).focus((s) => s.bg(t.hover).border_1().border_color(t.accent)).on_click((_e, cx) => go(cx)), go)
          : row;
      }))
      .when(items.length > SHOW, (el) => el.child(press(div().id(`more-${key}`).min_h(SPACE.HIT).flex().items_center().text_size(TYPE.xs).text_color(t.accent).cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => this.toggle(key, cx))
        .child(all ? "Show fewer" : `Show all ${items.length}`), (cx) => this.toggle(key, cx))));
  }
}
