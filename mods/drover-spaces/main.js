// drover-spaces: the sidebar's spaces with each space's open tabs beneath it, and the agents in
// each tab with how long they have been in their status. Click a space or tab to show it, right-click
// for its menu, fold a space (or a machine) with its chevron. A tab split into panes lists each pane
// beneath it (click one to focus it) and folds like a space. Keyboard: ↑/↓ move, ←/→ fold, Enter.
// The model (rows, folding, ages) is pure and lives in lib/tree.js. Each space leads with its
// project type's icon (lib/projtype.js), read from one `ls -A` of its folder, cached per folder.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { spaces, agents, panes, machines, run, openOverlay, theme, exec, nextCommand, layout, shared, setShared, props as hostProps } from "herdr";
import { TYPE, SPACE, mono, metaColor, emptyState, iconButton } from "./lib/panel-ui.js";
import { projectType, parseListing, typeIcon, typeLabel, typeKey, needsLook, TYPE_TTL } from "./lib/projtype.js";
import { STACK_ID, VIEWS, activeView, agentBadge, sortOf, nextSort, findNode } from "./lib/strip.js";
import { initial, formatAge, machineOf, reconcileAges, tabChangedAt, pruneKeys, flattenRows, foldable, keyAction } from "./lib/tree.js";

const STORE = { folded: "folded", ages: "ages" };
const INDENT = 14;
const AGE_GRACE = 30000;
const BRANCH_GIVE = 1000;
const BRANCH_MIN = 24;
const STATUS_WORD = { working: "Working", blocked: "Needs you", done: "Done", idle: "Idle" };
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const SPLIT_ICON = "mods/drover-spaces/icons/split.svg";
// Folded (or dragged) narrower than this, the sidebar draws a rail of icon cells: it goes by the
// sidebar's width, so a fold and a drag both land here. No sidebar in the layout reads as wide.
const RAIL_BELOW = 160;
const RAIL_CELL = 32;
const VIEW_ICON = { spaces: "folder", agents: "terminal" };
const LOUD = new Set(["working", "blocked", "done"]);
const narrow = () => (findNode(layout(), "sidebar")?.size?.px ?? Infinity) < RAIL_BELOW;
// A rail cell, centered in the full width so it sits in the middle at any rail width.
const railCell = (el) => h_flex().w_full().flex_none().justify_center().child(el);
// A status dot over a cell's corner, inside the cell's bounds.
const cornerDot = (color, t, size = 7) => div().absolute().right(3).bottom(2).size(size).rounded_full()
  .border_1().border_color(t.chrome).bg(color);

const load = (key, fallback) => {
  try { const v = JSON.parse(localStorage.getItem(key) ?? "null"); return v ?? fallback; } catch { return fallback; }
};
const save = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable: state lives for this run */ }
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default class DroverSpaces extends View {
  init(props, cx) {
    // {strip: true}: the sidebar's Spaces | Agents switch; {tabbed: true}: the list under it, no header.
    const p = hostProps?.() ?? props;
    this.props = p && typeof p === "object" ? p : {};
    this.h = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    const folded = load(STORE.folded, []);
    this.folded = new Set(Array.isArray(folded) ? folded.filter((k) => typeof k === "string") : []);
    const ages = load(STORE.ages, {});
    this.ages = ages && typeof ages === "object" && !Array.isArray(ages) ? ages : {};
    this.openSettled = new Set();
    this.started = Date.now();
    this.cursor = null;
    this.rows = [];
    // Project types by (machine, folder): { type, at }; looks in flight are in `looking`.
    this.types = new Map();
    this.looking = new Set();
    // Ages are shown in minutes at best: one redraw a minute, and only with agents listed.
    cx.timer.every(60000, (cx) => { if (agents().length) cx.notify(); });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if ((typeof c === "string" ? c : c?.name) === "focus") this.h.focus();
        cx.notify();
      }
    });
  }

  // ---------- state ----------

  // A machine's lists are complete once its layout is ready; nothing is pruned while any loads.
  // A machine missing from machines() counts as not ready.
  pruner() {
    const ms = machines();
    if (ms.some((m) => m.layout === "loading")) return () => false;
    const ready = new Set(ms.filter((m) => m.layout === "ready").map((m) => m.name ?? null));
    return (id) => ready.has(machineOf(id));
  }

  sync(sp, ags) {
    const canPrune = this.pruner();
    // Agents can arrive after the layouts on a cold start: ages wait AGE_GRACE before any prune,
    // so a restart keeps "since first seen" instead of wiping it.
    const settled = Date.now() - this.started >= AGE_GRACE;
    // Seeded from each tab's changed_at, done and idle as one: the same ages drover-agent-tree shows.
    const { ages, changed } = reconcileAges(this.ages, ags, Date.now(), settled ? canPrune : () => false, tabChangedAt(sp));
    this.ages = ages;
    if (changed) save(STORE.ages, ages);
    const kept = pruneKeys(this.folded, sp.flatMap((s) => [s.id, ...(s.tabs ?? []).map((t) => t.id)]), canPrune);
    if (kept !== this.folded) { this.folded = kept; save(STORE.folded, [...kept]); }
  }

  toggle(row, cx) {
    if (row.kind === "settled") {
      const id = row.space.id;
      this.openSettled.has(id) ? this.openSettled.delete(id) : this.openSettled.add(id);
    } else {
      this.folded.has(row.key) ? this.folded.delete(row.key) : this.folded.add(row.key);
      save(STORE.folded, [...this.folded]);
    }
    cx.notify();
  }

  activate(row, cx) {
    if (row.kind === "space") run("space.select", { id: row.space.id });
    else if (row.kind === "tab") {
      if (!row.space.active) run("space.select", { id: row.space.id });
      run("tab.select", { id: row.tab.id });
    } else if (row.kind === "pane") this.focusPane(row);
    else if (row.kind === "agent") run("agent.focus", { terminal: row.agent.address });
    else if (row.kind === "empty") { if (row.online) run("space.new", row.machine ? { machine: row.machine } : {}); }
    else if (foldable(row)) this.toggle(row, cx);
  }

  // Shows the pane's space and tab first when they are not, then focuses the pane.
  focusPane(row) {
    if (!row.space.active) run("space.select", { id: row.space.id });
    if (!row.tab.active) run("tab.select", { id: row.tab.id });
    run("pane.focus", { pane: row.pane.pane });
  }

  key(e, cx) {
    if (e.key === "escape") {
      if (this.cursor === null) return;
      this.cursor = null;
    } else {
      const act = keyAction(this.rows, this.cursor, e.key);
      if (!act) return;
      this.cursor = act.cursor;
      if (act.toggle && !this.rail) this.toggle(act.toggle, cx);
      if (act.activate && (!this.rail || act.activate.kind === "space")) this.activate(act.activate, cx);
      const i = this.rows.findIndex((r) => r.key === this.cursor);
      if (i >= 0) this.scroll.scroll_to_item(i);
    }
    cx.stop_propagation();
    cx.notify();
  }

  // ---------- pieces ----------

  // A row's frame: indent, height, hover, the keyboard cursor and the shown one.
  frame(row, t, { selected = false, h = SPACE.ROW_H } = {}) {
    const cursor = this.cursor === row.key && this.h.is_focused();
    return h_flex().id(`row-${row.key}`).h(h).flex_none().pl(6 + row.depth * INDENT).pr(8).gap(6).items_center().rounded(6)
      .cursor_pointer()
      .when(selected, (el) => el.bg(t.selected))
      .when(!selected && cursor, (el) => el.bg(t.hover))
      .when(selected && cursor, (el) => el.border_1().border_color(t.accent))
      .when(!selected, (el) => el.hover((s) => s.bg(t.hover)))
      .on_mouse_down("left", () => { this.cursor = row.key; });
  }

  chevron(row, open, t, label) {
    return div().id(`fold-${row.key}`).w(12).flex_none().text_size(TYPE.xs).text_color(t.dim)
      .role("button").accessibility_label(label).tooltip(label)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.toggle(row, cx); })
      .child(open ? "▾" : "▸");
  }

  // Looks once at each space's folder (on its machine) for the names that tell its project type.
  // A folder is looked at again only after TYPE_TTL; a failed look counts as a look (plain folder).
  // An empty folder is that machine's home: a plain folder, nothing to run.
  // `places`: {machine, folder} for each space and each tab's terminal folder.
  lookTypes(places, cx) {
    const now = Date.now();
    // Forget looks long past their TTL so folders visited once don't pile up.
    for (const [key, seen] of this.types) if (now - seen.at > 2 * TYPE_TTL) this.types.delete(key);
    for (const { machine, folder } of places) {
      if (!folder) continue;
      const key = typeKey(machine, folder);
      if (this.looking.has(key) || !needsLook(this.types.get(key), now)) continue;
      this.looking.add(key);
      cx.spawn(async (cx) => {
        let type = "folder";
        try {
          const r = await exec("ls", ["-A", "--", folder], { on: machine, timeout: 5000 });
          if (r.code === 0) type = projectType(parseListing(r.stdout));
        } catch { /* unreachable machine or missing folder: a plain folder */ }
        this.types.set(key, { type, at: Date.now() });
        this.looking.delete(key);
        cx.notify();
      });
    }
  }

  // A space with no folder of its own (the machine's home) takes its first tab's terminal folder.
  spaceFolder(s) {
    return s.folder || this.firstCwd?.get(s.id) || null;
  }

  typeIconFor(machine, folder, size = 16) {
    const type = folder ? this.types.get(typeKey(machine, folder))?.type ?? "folder" : "folder";
    const label = typeLabel(type);
    return h_flex().size(size + 2).flex_none().items_center().justify_center().tooltip(label).accessibility_label(label)
      .child(image(typeIcon(type)).size(size).flex_none());
  }

  spaceIcon(s) {
    return this.typeIconFor(s.machine, this.spaceFolder(s));
  }

  // A row's name and its branch share the room; the branch gives way first. The name takes its own
  // width (basis auto, flex_1 would start it at zero) and shrinks only once the branch is down to its
  // minimum: the branch shrinks BRANCH_GIVE times as fast.
  name(el) {
    return el.flex_auto().min_w(0).truncate();
  }

  branch(text, max, t, on) {
    return mono(div().flex_initial().flex_shrink(BRANCH_GIVE).min_w(BRANCH_MIN).max_w(max).truncate()
      .text_size(TYPE.xs).text_color(metaColor(t, on)).tooltip(text).child(text));
  }

  count(n, t, label, on) {
    return mono(div().flex_none().text_size(TYPE.xs).text_color(metaColor(t, on)).tooltip(label).accessibility_label(label).child(String(n)));
  }

  machineRow(row, t) {
    const m = row.machine;
    const name = m ?? "This computer";
    const state = row.online ? "online" : "offline";
    return this.frame(row, t, { h: 24 })
      .on_click((_e, cx) => this.toggle(row, cx))
      .child(this.chevron(row, !row.folded, t, row.folded ? `Show ${name}` : `Hide ${name}`))
      .child(svg(ICON(m ? "server" : "monitor")).size(13).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_size(TYPE.xs).font_semibold().text_color(metaColor(t, t.chrome)).child(name))
      .when(!row.online, (el) => el.child(div().flex_none().text_size(TYPE.xs).text_color(metaColor(t, t.chrome)).child("offline")))
      .child(div().size(6).flex_none().rounded(3).bg(row.online ? t.ansi2 : t.dim).tooltip(`${name} is ${state}`).accessibility_label(state))
      .when(row.folded, (el) => el.child(this.count(row.count, t, plural(row.count, "space"), t.chrome)));
  }

  spaceRow(row, t, activeTabShown) {
    const s = row.space;
    const selected = s.active && !activeTabShown;
    const on = selected ? t.selected : t.chrome;
    const loud = row.folded && (s.status === "blocked" || s.status === "done");
    return this.frame(row, t, { selected })
      .on_click(() => run("space.select", { id: s.id }))
      .on_mouse_down("right", () => openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: s.id } } }))
      .child(this.chevron(row, !row.folded, t, row.folded ? `Show ${s.name}'s tabs` : `Hide ${s.name}'s tabs`))
      .child(this.spaceIcon(s))
      .child(this.name(div().text_size(TYPE.sm).text_color(t.foreground).when(s.active, (el) => el.font_semibold()).child(s.name)))
      .when(loud, (el) => el.child(div().flex_none().text_size(TYPE.xs).text_color(t[s.status] ?? t.unknown)
        .tooltip(STATUS_WORD[s.status]).accessibility_label(STATUS_WORD[s.status]).child("●")))
      .when(Boolean(s.branch), (el) => el.child(this.branch(s.branch, 120, t, on)))
      .child(this.count(row.tabs, t, plural(row.tabs, "tab"), on));
  }

  tabRow(row, t) {
    const { space: s, tab } = row;
    const selected = s.active && tab.active;
    const on = selected ? t.selected : t.chrome;
    // The dot is drawn only while an agent reports a status; an idle tab shows none.
    const word = STATUS_WORD[tab.status] ?? String(tab.status);
    const dot = () => div().w(12).flex_none().text_size(TYPE.xs).text_color(t[tab.status] ?? t.unknown)
      .tooltip(word).accessibility_label(word).child("●");
    const panesLabel = plural(row.paneCount, "pane");
    return this.frame(row, t, { selected })
      .on_click((_e, cx) => this.activate(row, cx))
      // drover's menu, whose Close asks twice when an agent in the tab is busy.
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "drover-terminal-menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: tab.id, space: s.id } } }); })
      // Split tabs lead with their fold chevron, others with a spacer of its width so the icons line up;
      // every tab then shows its terminal folder's project type.
      .when(row.split, (el) => el.child(this.chevron(row, !row.folded, t, row.folded ? `Show ${tab.name}'s panes` : `Hide ${tab.name}'s panes`)))
      .when(!row.split, (el) => el.child(div().w(12).flex_none()))
      .child(this.typeIconFor(s.machine, row.cwd || this.spaceFolder(s), 14))
      .child(this.name(div().text_size(TYPE.sm).text_color(t.foreground).when(selected, (el) => el.font_semibold())
        .when(tab.settled, (el) => el.text_color(metaColor(t, on))).child(tab.name)))
      .when(Boolean(row.branch), (el) => el.child(this.branch(row.branch, 110, t, on)))
      // The agent status dot sits on the right (an open split tab's panes show it instead).
      .when(Boolean(tab.status) && !(row.split && !row.folded), (el) => el.child(dot()))
      .when(row.paneCount > 1, (el) => el.child(svg(SPLIT_ICON).size(12).flex_none().text_color(metaColor(t, on)).tooltip(`Split into ${panesLabel}`).accessibility_label(`Split into ${panesLabel}`)))
      .child(this.count(row.paneCount, t, panesLabel, on));
  }

  paneRow(row, t) {
    const { pane: p, agent: a } = row;
    const word = row.status ? (STATUS_WORD[row.status] ?? row.status) : "No agent";
    const since = a ? this.ages[a.address]?.since : null;
    const age = Number.isFinite(since) ? formatAge(Date.now() - since) : null;
    const tip = [row.label, row.folder, row.branch, a ? `${word}${age ? ` for ${age}` : ""}` : null].filter(Boolean).join(" · ");
    // The pane that has the keyboard in the shown tab reads in the foreground color.
    const current = row.space.active && row.tab.active && Boolean(p.focused);
    return this.frame(row, t, { h: 22 })
      .on_click((_e, cx) => this.activate(row, cx))
      .tooltip(tip)
      .child(div().w(12).flex_none().text_size(TYPE.xs).text_color(row.status ? (t[row.status] ?? t.unknown) : t.dim)
        .accessibility_label(word).child(row.status ? "●" : "○"))
      .child(this.name(div().text_size(TYPE.xs).text_color(current ? t.foreground : metaColor(t, t.chrome)).child(row.label)))
      .when(Boolean(row.folder), (el) => el.child(mono(div().flex_initial().flex_shrink(BRANCH_GIVE).min_w(BRANCH_MIN).max_w(90).truncate()
        .text_size(TYPE.xs).text_color(metaColor(t, t.chrome)).child(row.folder))))
      .when(Boolean(row.branch), (el) => el.child(this.branch(row.branch, 100, t, t.chrome)))
      .when(Boolean(age), (el) => el.child(mono(div().flex_none().text_size(TYPE.xs).text_color(metaColor(t, t.chrome)).accessibility_label(`${word} for ${age}`).child(age))));
  }

  agentIcon(a, t) {
    const p = a.program ?? {};
    const tint = t[a.status] ?? t.unknown;
    if (p.icon) return p.tint ? svg(p.icon).size(12).flex_none().text_color(tint) : image(p.icon).w(12).h(12).flex_none();
    return div().w(12).flex_none().text_size(TYPE.xs).font_semibold().text_color(tint).child(initial(p.name || a.app || "?"));
  }

  agentRow(row, t) {
    const a = row.agent;
    const since = this.ages[a.address]?.since ?? Date.now();
    const age = formatAge(Date.now() - since);
    const title = a.title || a.program?.name || a.app || "Agent";
    const word = STATUS_WORD[a.status] ?? a.status;
    return this.frame(row, t, { h: 22 })
      .on_click(() => run("agent.focus", { terminal: a.address }))
      .tooltip(`${a.program?.name ?? "Agent"} · ${word} for ${age}`)
      // The same 12-wide lead as a chevron, so the icon sits inside its tab's, not left of it.
      .child(div().w(12).flex_none())
      .child(this.agentIcon(a, t))
      .child(div().flex_1().min_w(0).truncate().text_size(TYPE.xs).text_color(metaColor(t, t.chrome)).child(title))
      .child(mono(div().flex_none().text_size(TYPE.xs).text_color(metaColor(t, t.chrome)).accessibility_label(`${word} for ${age}`).child(age)));
  }

  settledRow(row, t) {
    const label = `${plural(row.count, "tab")} put away`;
    return this.frame(row, t, { h: 22 })
      .on_click((_e, cx) => this.toggle(row, cx))
      .child(this.chevron(row, row.open, t, row.open ? "Hide put-away tabs" : "Show put-away tabs"))
      .child(div().flex_1().min_w(0).truncate().text_size(TYPE.xs).text_color(metaColor(t, t.chrome)).child(label));
  }

  // A connected machine with no spaces: a quiet line that opens one there (offline: just the line).
  emptyRow(row, t) {
    const name = row.machine ?? "this computer";
    const label = row.online ? `New space on ${name}` : "No spaces";
    return this.frame(row, t, { h: 22 })
      .when(row.online, (el) => el.on_click((_e, cx) => this.activate(row, cx)))
      .when(!row.online, (el) => el.cursor_default())
      .child(div().w(12).flex_none())
      .when(row.online, (el) => el.child(svg(ICON("plus")).size(12).flex_none().text_color(metaColor(t, t.chrome))))
      .child(div().flex_1().min_w(0).truncate().text_size(TYPE.xs).text_color(metaColor(t, t.chrome))
        .tooltip(label).accessibility_label(label).child(row.online ? "New space" : "No spaces"));
  }


  // ---------- rail ----------

  // A machine in the rail: its icon with a connected dot, the name and state in the tooltip.
  machineCell(row, t) {
    const m = row.machine;
    const name = m ?? "This computer";
    const label = `${name} · ${row.online ? "connected" : "offline"}`;
    return railCell(h_flex().id(`row-${row.key}`).relative().w(RAIL_CELL).h(24).mt(4).flex_none()
      .items_center().justify_center().rounded(6).cursor_default()
      .tooltip(label).accessibility_label(label)
      .child(svg(ICON(m ? "server" : "monitor")).size(13).flex_none().text_color(t.muted))
      .child(cornerDot(row.online ? t.ansi2 : t.dim, t, 6)));
  }

  // A space in the rail: its project icon, a dot while an agent in it works or waits, shown as selected
  // when it is the active space. Name, branch and tab count are in the tooltip.
  spaceCell(row, t) {
    const s = row.space;
    const type = this.spaceFolder(s) ? this.types.get(typeKey(s.machine, this.spaceFolder(s)))?.type ?? "folder" : "folder";
    const label = [s.name, s.branch, plural(row.tabs, "tab"), LOUD.has(s.status) ? STATUS_WORD[s.status] : null].filter(Boolean).join(" · ");
    const cursor = this.cursor === row.key && this.h.is_focused();
    return railCell(h_flex().id(`row-${row.key}`).relative().w(RAIL_CELL).h(SPACE.ROW_H).flex_none()
      .items_center().justify_center().rounded(6).cursor_pointer()
      .role("button").tooltip(label).accessibility_label(label)
      .when(s.active, (el) => el.bg(t.selected))
      .when(!s.active && cursor, (el) => el.bg(t.hover))
      .when(s.active && cursor, (el) => el.border_1().border_color(t.accent))
      .when(!s.active, (el) => el.hover((st) => st.bg(t.hover)))
      .on_mouse_down("left", () => { this.cursor = row.key; })
      .on_click(() => run("space.select", { id: s.id }))
      .on_mouse_down("right", () => openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: s.id } } }))
      .child(image(typeIcon(type)).size(16).flex_none())
      .when(LOUD.has(s.status), (el) => el.child(cornerDot(t[s.status] ?? t.unknown, t))));
  }

  // The rail's list: machines and spaces only, every space shown whatever is folded (nothing in the
  // rail can unfold it). Tabs, panes and agents wait for the wide list.
  railBody(rows, loading, t) {
    if (loading) {
      return [railCell(h_flex().id("rail-loading").w(RAIL_CELL).h(SPACE.ROW_H).items_center().justify_center()
        .tooltip("Reading spaces").accessibility_label("Reading spaces")
        .child(svg(ICON("spinner")).size(14).flex_none().text_color(t.dim).spin(900)))];
    }
    if (!rows.length) {
      return [railCell(h_flex().id("rail-new").w(RAIL_CELL).h(SPACE.ROW_H).items_center().justify_center().rounded(6)
        .cursor_pointer().hover((st) => st.bg(t.hover)).role("button").tooltip("New space").accessibility_label("New space")
        .on_click(() => run("space.new"))
        .child(svg(ICON("plus")).size(14).flex_none().text_color(metaColor(t, t.chrome))))];
    }
    return rows.map((r) => (r.kind === "machine" ? this.machineCell(r, t) : this.spaceCell(r, t)));
  }

  // The strip in the rail: one cell for the shown view; a click shows the other. While Spaces shows,
  // a dot says an agent works, waits or is done.
  railStrip(t, shown, count) {
    const v = VIEWS.find((x) => x.id === shown) ?? VIEWS[0];
    const other = VIEWS.find((x) => x.id !== v.id);
    const total = { spaces: spaces().length, agents: agents().length };
    const label = `${v.label} (${total[v.id]})`;
    const badge = count.agents.status;
    return h_flex().id("drover-strip").size_full().items_center().justify_center().bg(t.chrome).role("tab_list")
      .child(h_flex().id(`view-${v.id}`).relative().w(RAIL_CELL).h(24).flex_none().items_center().justify_center()
        .rounded(6).cursor_pointer().bg(t.selected)
        .role("tab").tooltip(label).accessibility_label(`${label}. Show ${other.label.toLowerCase()}`)
        .on_click((_e, cx) => { run("layout.select", { stack: STACK_ID, child: other.id }); cx.notify(); })
        .child(svg(ICON(VIEW_ICON[v.id])).size(14).flex_none().text_color(t.foreground))
        .when(v.id === "spaces" && Boolean(badge), (el) => el.child(cornerDot(t[badge] ?? t.unknown, t, 6))));
  }

  // ---------- render ----------

  // The strip over the sidebar's lists: one tab per view of the layout's stack, then the shown
  // view's action (a new space; the agents' sort). Agents carries its most urgent count while hidden.
  renderStrip() {
    const t = theme();
    const shown = activeView(layout());
    const badge = agentBadge(agents());
    const count = { spaces: { status: null, count: spaces().length }, agents: badge };
    if (narrow()) return this.railStrip(t, shown, count);
    const tab = (v) => {
      const on = v.id === shown;
      const c = count[v.id];
      const word = c.status ? STATUS_WORD[c.status] : null;
      const label = `${v.label}${c.count ? `, ${word ? `${c.count} ${word.toLowerCase()}` : c.count}` : ""}`;
      return h_flex().id(`view-${v.id}`).h(24).px(8).gap(6).flex_none().items_center().rounded(6).cursor_pointer()
        .role("tab").accessibility_label(label).tooltip(label)
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => { if (!on) run("layout.select", { stack: STACK_ID, child: v.id }); cx.notify(); })
        .child(div().text_size(TYPE.sm).font_semibold().text_color(on ? t.foreground : metaColor(t, t.chrome)).child(v.label))
        .when(Boolean(c.status), (el) => el.child(div().size(6).flex_none().rounded(3).bg(t[c.status] ?? t.unknown)))
        .when(c.count > 0, (el) => el.child(mono(div().text_size(TYPE.xs)
          .text_color(c.status === "blocked" ? t.blocked : metaColor(t, on ? t.selected : t.chrome)).child(String(c.count)))));
    };
    const sort = sortOf(shared("agents.sort"));
    const next = nextSort(sort.id);
    const action = shown === "agents"
      ? iconButton({ id: "agents-sort", icon: ICON(sort.icon), label: `Sorted: ${sort.label}. Sort ${next.label.toLowerCase()}`, onClick: () => setShared("agents.sort", next.id) }, t)
      : iconButton({ id: "spaces-new", icon: ICON("plus"), label: "New space", onClick: () => run("space.new") }, t);
    return h_flex().id("drover-strip").size_full().px(6).gap(2).items_center().bg(t.chrome).role("tab_list")
      .children(VIEWS.map(tab))
      .child(div().flex_1())
      .child(action);
  }

  render(cx) {
    if (this.props.strip) return this.renderStrip();
    const t = theme();
    const sp = spaces();
    const ags = agents();
    this.sync(sp, ags);
    const rail = narrow();
    this.rail = rail;
    const ms = machines();
    const online = (m) => ms.find((x) => (x.name ?? null) === m)?.layout === "ready";
    // Every machine shows, even one with no spaces yet (offline: marked so); temporary ones are the app's own.
    const known = ms.filter((m) => !m.temporary).map((m) => m.name ?? null);
    const rows = flattenRows({ spaces: sp, agents: ags, panes: panes(), folded: rail ? new Set() : this.folded, openSettled: this.openSettled, online, machines: known });
    const firstCwd = new Map();
    for (const r of rows) if (r.kind === "tab" && r.cwd && !firstCwd.has(r.space.id)) firstCwd.set(r.space.id, r.cwd);
    this.firstCwd = firstCwd;
    this.lookTypes([
      ...sp.map((s) => ({ machine: s.machine, folder: this.spaceFolder(s) })),
      ...rows.filter((r) => r.kind === "tab").map((r) => ({ machine: r.space.machine, folder: r.cwd })),
    ], cx);
    this.rows = rail ? rows.filter((r) => r.kind === "machine" || r.kind === "space") : rows;
    if (this.cursor !== null && !this.rows.some((r) => r.key === this.cursor)) this.cursor = null;
    const activeTabShown = new Set(rows.filter((r) => r.kind === "tab" && r.space.active && r.tab.active).map((r) => r.space.id));
    // Machine headers draw even with no spaces anywhere; the empty state is for a lone machine with none.
    const loading = !rows.length && ms.some((m) => m.layout === "loading");

    const draw = (r) => {
      switch (r.kind) {
        case "machine": return this.machineRow(r, t);
        case "space": return this.spaceRow(r, t, activeTabShown.has(r.space.id));
        case "tab": return this.tabRow(r, t);
        case "pane": return this.paneRow(r, t);
        case "agent": return this.agentRow(r, t);
        case "settled": return this.settledRow(r, t);
        case "empty": return this.emptyRow(r, t);
        default: return null;
      }
    };
    const body = rail ? this.railBody(this.rows, loading, t) : loading
      ? [div().px(SPACE.PX).py(6).text_size(TYPE.sm).text_color(metaColor(t, t.chrome)).child("Reading spaces…")]
      : rows.length
        ? rows.map(draw)
        : [emptyState({ title: "No spaces", body: "A space holds the tabs for one piece of work.", action: { label: "New space", onClick: () => run("space.new") } }, t)];

    return v_flex().id("drover-spaces").size_full().min_h(0).bg(t.chrome).text_size(TYPE.md)
      .track_focus(this.h).on_key_down((e, cx) => this.key(e, cx))
      .when(!this.props.tabbed && rail, (root) => root.child(h_flex().h(28).flex_none().items_center().justify_center()
        .child(iconButton({ id: "spaces-new", icon: ICON("plus"), label: "New space", onClick: () => run("space.new") }, t))))
      .when(!this.props.tabbed && !rail, (root) => root.child(h_flex().h(28).flex_none().px(SPACE.PX).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(TYPE.xs).font_semibold().text_color(metaColor(t, t.chrome)).child("Spaces"))
        .child(iconButton({ id: "spaces-new", icon: ICON("plus"), label: "New space", onClick: () => run("space.new") }, t))))
      .child(v_flex().id("drover-spaces-list").flex_1().min_h(0).px(rail ? 0 : 6).pb(10).when(rail, (el) => el.gap(2)).overflow_y_scrollbar().track_scroll(this.scroll)
        .children(body));
  }
}
