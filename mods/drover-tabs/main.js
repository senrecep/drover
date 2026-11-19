// drover-tabs: the tab bar, cloned from the shipped `tabs`, with the side panel's controls.
//
// Two kinds of copy (props decide):
// - the bar (a layout block): tabs, the pinned panel buttons, and "Panels", which opens the popup.
//   Clicking an open panel's button closes the panel. Answers the key command drover-tabs.panels.
//   A tab's x and the drover-tabs.close key ask twice when an agent in the tab is busy (close-guard.js).
// - the popup (an overlay: openOverlay from the bar, or mod.open drover-tabs): every child of the
//   `panel-body` stack in groups; a row opens or closes its panel, the pin adds or removes its
//   toolbar button. Pins are the shared key drover-tabs.pinned.
// - the new-tab menu (an overlay with props.role "new", from the bar's "▾"): Shell, the installed
//   known agents, and the user's templates (shared key drover-tabs.templates: ["prog", {name, argv}]).
// The bar also shows a "+N −M" diff chip (git diff --shortstat HEAD in the space's live folder,
// at most every 5 s and on space/tab change; clicking it toggles Changes) and a centered
// "space ⎇ branch" title that hides first when the tabs need the room.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, ScrollHandle, InputState, Input, Scrollbar } from "gpui-base";
import { spaces, panes, run, openOverlay, closeOverlay, theme, window, shared, setShared, layout, settings, props, nextCommand, exec, knownAgents, keys, focused, home, agents, terminals, notify } from "herdr";
import { CONFIRM_MS, activeTabId, closePlan, press, liveArm } from "./close-guard.js";
import {
  PINS_KEY, findNode, describe, panelIds, groupPanels, openPanel, toggleCommands, normalizePins,
  togglePin, popupHeight, popupMaxHeight, keyIgnored,
} from "./logic.js";
import { TYPE, iconButton, button as textButton, metaColor, sectionLabel, emptyState, diffStat, mono } from "./lib/panel-ui.js";
import {
  TEMPLATES_KEY, DIFF_INTERVAL, liveFolder, diffKey, shouldRefresh, diffFromResult, contextTitle, titleFits,
  templateRows, newTabArgs, templatesHeight,
  EDITOR_KEY, openInSource, editorAppPaths, openInOverlay, openInPlan, openInTip, pickBinding,
} from "./lib/topbar.js";

const MOD = "drover-tabs";
const POPUP_W = 300;
// The filter field and its gap above the popup list.
const FILTER_H = 36;
const POPUP_MAX_H = 780;
// Where the popup starts when no button place is known (mod.json's overlay offset), and the gap
// kept under it.
const POPUP_TOP = 44;
const POPUP_MARGIN = 12;

// The main window's height in logical px. herdr's window() has no size and viewport_size is legal only
// in render, so the toolbar (drawn in the main window) measures it there and keeps it for the popup,
// which may draw in a window of its own. Unknown stays undefined.
const WIN_H_KEY = "windowHeight";
function measureWindow() {
  let h;
  try { h = globalThis.window?.viewport_size?.()?.height / (Number(settings()?.zoom) || 1); } catch { h = undefined; }
  if (!(h > 0)) return;
  try { if (Number(localStorage.getItem(WIN_H_KEY)) !== Math.round(h)) localStorage.setItem(WIN_H_KEY, String(Math.round(h))); } catch { /* cap stays 780 */ }
}
function windowHeight() {
  try { const h = Number(localStorage.getItem(WIN_H_KEY)); return h > 0 ? h : undefined; } catch { return undefined; }
}
// The popup's tallest height in logical px: 780, or less so it fits the window under `top` (logical px).
function popupMax(top) {
  return popupMaxHeight(windowHeight(), top, POPUP_MARGIN, POPUP_MAX_H);
}

const runAll = (commands) => { for (const [name, args] of commands) run(name, args); };
const TEMPLATES_W = 240;
// A pressed control's top-left and size in window coordinates (press position minus its position in it),
// or null before the first paint.
const anchorOf = (e, w, h) => {
  const p = e?.position, l = e?.local_position;
  return p && l ? { x: p.x - l.x, y: p.y - l.y, w: e.bounds?.width ?? w, h: e.bounds?.height ?? h } : null;
};
// "Open in": the focused space (else the active one), its folder and machine.
function openInTarget() {
  let f = null;
  try { f = focused(); } catch { f = null; }
  return openInSource(spaces(), f);
}
// fs.stat can't see outside home (e.g. /Applications), so ask `test -d` instead (argv, local).
const isDir = async (p) => { try { return (await exec("test", ["-d", p], { timeout: 3000 }))?.code === 0; } catch { return false; } };

// Herdr's lists for the close guard; a list that throws is null, which the guard counts as busy.
function closeData() {
  const read = (f) => { try { return f(); } catch { return null; } };
  return { spaces: read(spaces), panes: read(panes), agents: read(agents), terminals: read(terminals) };
}

// The active space, its shown tab, and where its diff is read.
function diffTarget() {
  const space = spaces().find(p => p.active) ?? null;
  const tab = space?.tabs?.find(x => x.active);
  const cwd = liveFolder(space, panes());
  return { space, cwd, key: diffKey(space, tab?.id, cwd) };
}

export default class Tabs extends View {
  init(_props, cx) {
    this.popup = Boolean(props()?.overlay);
    this.templates = this.popup && props()?.role === "new";
    if (this.templates) { this.initTemplates(cx); return; }
    if (this.popup) { this.initPopup(cx); return; }
    this.pressed = null;
    this.panelsBtn = null;
    this.newBtn = null;
    this.openInBtn = null;
    this.hoverTab = null;
    this.titleW = 0;
    this.diff = null;
    this.diffState = {};
    cx.timer.every(DIFF_INTERVAL, (cx) => this.refreshDiff(cx));
    this.refreshDiff(cx);
    this.scroll = ScrollHandle.new();
    try { this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}") ?? {}; } catch { this.panels = {}; }
    // drover-tabs.panels (a key): the popup where mod.json's overlay puts it. mod.open toggles.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        // Under the Panels button once its place is known (a click or hover cached it), else where mod.json puts it.
        if (c === "panels") { if (this.panelsBtn) this.openPopup(); else run("mod.open", { name: MOD }); }
        // drover-tabs.open-in (a key): the "Open in" popup, as the ▾ does.
        else if (c === "open-in") this.openEditors();
        // drover-tabs.close (a key): the shown tab, asking for a second press when an agent in it is busy.
        else if (c === "close") this.closeByKey();
        cx.notify();
      }
    });
  }

  // The tab's x: closes at once, or arms when an agent in the tab is working or needs the user;
  // a second click within CONFIRM_MS (not the same double click) closes it.
  closeByClick(id, cx) {
    const now = Date.now();
    const r = press(liveArm(this.clickArm, now), closePlan(id, closeData(), "Click"), now);
    this.clickArm = r.armed;
    if (r.action === "fire") run(...r.command);
    else if (r.action === "arm") {
      const armed = r.armed;
      cx.timer.after(CONFIRM_MS + 50, (cx) => { if (this.clickArm === armed) { this.clickArm = null; cx.notify(); } });
    }
    cx.notify();
  }

  // The close key: the same rules, said in a toast.
  closeByKey() {
    const now = Date.now();
    // The key has no held flag: a repeat stream, or a press too soon after arming, is not a second press.
    const last = this.keyLastAt ?? null;
    this.keyLastAt = now;
    if (keyIgnored(liveArm(this.keyArm, now)?.at ?? null, last, now)) return;
    const data = closeData();
    const r = press(liveArm(this.keyArm, now), closePlan(activeTabId(data.spaces), data, "Press"), now);
    this.keyArm = r.armed;
    if (r.action === "fire") run(...r.command);
    else if (r.action === "arm") notify({ title: "Press again to close this tab", body: r.armed.text, level: "warning", timeout: CONFIRM_MS });
  }

  // The popup, sized to the panels this layout has: right-aligned under the Panels button when its
  // place is known, else at the pointer.
  openPopup() {
    const groups = groupPanels(layout());
    const rows = groups.reduce((n, g) => n + g.items.length, 0);
    const b = this.panelsBtn;
    const zoom = Number(settings()?.zoom) || 1;
    const max = popupMax(b ? (b.y + b.h + 4) / zoom : POPUP_TOP);
    openOverlay({
      mod: MOD, kind: "popup", props: { role: "panels", maxHeight: max }, width: POPUP_W, height: Math.min(max, popupHeight(groups.length, rows) + FILTER_H),
      ...(b ? { at: { x: Math.max(8, b.x + b.w - POPUP_W), y: b.y + b.h + 4 } } : {}),
    });
  }

  // The Panels button's top-left in window coordinates: the press position minus its position in the button.
  // local_position can be missing before the first paint: then nothing is cached and the pointer is the anchor.
  rememberPanelsButton(e) {
    const a = anchorOf(e, 24, 24);
    if (a) this.panelsBtn = a;
  }

  // The diff chip's numbers: git asked at most every DIFF_INTERVAL, at once on a new space/tab/folder,
  // never two at a time. Errors (not a repo, no HEAD, machine away) hide the chip.
  refreshDiff(cx) {
    const { space, cwd, key } = diffTarget();
    if (!shouldRefresh(this.diffState, key, Date.now())) return;
    if (this.diffState.key !== key) this.diff = null;
    if (!cwd) { this.diffState = { key, at: Date.now() }; return; }
    const state = this.diffState = { key, at: Date.now(), busy: true };
    cx.spawn(async (cx) => {
      let d = null;
      try { d = diffFromResult(await exec("git", ["--no-optional-locks", "diff", "--shortstat", "HEAD"], { cwd, on: space.machine, timeout: 10000 })); } catch { d = null; }
      state.busy = false;
      state.at = Date.now();
      if (this.diffState === state) this.diff = d;
      cx.notify();
    });
  }

  // "Open in ▾"'s ▾: drover-open's "Open in" popup for the focused folder (under the button once its place is known).
  openEditors() {
    const { folder, on } = openInTarget();
    if (folder) openOverlay(openInOverlay(folder, on, this.openInBtn));
  }

  // "Open in"'s main part: the remembered editor, when it is still installed and the folder is local; else the popup.
  openInLast(cx) {
    const { folder, on } = openInTarget();
    if (!folder) return;
    const editor = shared(EDITOR_KEY);
    const platform = window()?.platform;
    cx.spawn(async () => {
      let installed = false;
      if (!on && platform === "macos" && typeof editor === "string") {
        for (const p of editorAppPaths(editor, home())) if (await isDir(p)) { installed = true; break; }
      }
      const plan = openInPlan({ folder, on, editor, installed, platform });
      if (!plan) return;
      if (plan.kind === "exec") {
        let r = null;
        try { r = await exec(plan.command, plan.args, { timeout: 15000 }); } catch { r = null; }
        if (r?.code === 0) return;
      }
      this.openEditors();
    });
  }

  // "▾": the new-tab menu under the button, its rows ready (Herdr caches the installed check).
  openTemplates(cx) {
    const space = spaces().find(p => p.active);
    const at = this.newBtn;
    cx.spawn(async () => {
      let known = [];
      try { known = await knownAgents({ on: space?.machine ?? null }); } catch { known = []; }
      const rows = templateRows(known, shared(TEMPLATES_KEY));
      openOverlay({
        mod: MOD, kind: "popup", width: TEMPLATES_W, height: templatesHeight(rows.length),
        props: { role: "new", space: space?.id ?? null, rows },
        ...(at ? { at: { x: Math.max(8, at.x + at.w - 20), y: at.y + at.h + 4 } } : {}),
      });
    });
  }

  initTemplates(cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.cursor = 0; this.done = false;
    this.rows = Array.isArray(props()?.rows) ? props().rows : templateRows([], shared(TEMPLATES_KEY));
  }

  startTemplate(row) {
    if (!row || this.done) return;
    this.done = true;
    run("tab.new", newTabArgs(row, props()?.space));
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
  }

  templatesKey(e, cx) {
    const n = this.rows.length;
    if ((e.key === "down" || e.key === "up") && n) this.cursor = (this.cursor + (e.key === "down" ? 1 : n - 1)) % n;
    else if (e.key === "enter") this.startTemplate(this.rows[this.cursor]);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  renderTemplates() {
    const t = theme();
    const hint = metaColor(t, t.popover);
    const row = (r, i) => {
      const cur = i === this.cursor;
      const icon = r.icon
        ? (r.tint ? svg(r.icon).size(14).flex_none().text_color(t.muted) : image(r.icon).size(14).flex_none())
        : r.argv
          ? svg("mods/drover-tabs/icons/bot.svg").size(14).flex_none().text_color(t.muted)
          : mono(div().w(14).flex_none().text_size(TYPE.xs).text_color(t.muted).child(">_"));
      return h_flex().id(`tpl-${r.id}`).h(30).px(8).gap(8).items_center().rounded(6).flex_none()
        .bg(cur ? t.hover : t.popover).text_color(cur ? t.foreground : t.muted).text_size(TYPE.sm)
        .hover(s => s.bg(t.hover).text_color(t.foreground))
        .accessibility_label(`New ${r.name} tab`)
        .on_hover((h, cx) => { if (h && this.cursor !== i) { this.cursor = i; cx.notify(); } })
        .on_click(() => this.startTemplate(r))
        .child(icon)
        .child(div().flex_1().min_w(0).truncate().child(r.name))
        .when(Boolean(r.argv), el => el.child(mono(div().max_w(90).truncate().flex_none().text_size(TYPE.xs).text_color(hint).child(r.argv.join(" ")))));
    };
    return v_flex().id("templates-popup").track_focus(this.handle).on_key_down((e, cx) => this.templatesKey(e, cx))
      .w_full().bg(t.popover).p(6).gap(0)
      .child(h_flex().h(30).px(8).items_center().justify_between().flex_none()
        .child(div().text_size(TYPE.md).font_semibold().text_color(t.foreground).child("New tab"))
        .child(div().text_size(TYPE.xs).text_color(hint).child("Esc")))
      .child(v_flex().id("templates-list").flex_1().min_h(0).overflow_y_scroll().children(this.rows.map(row)));
  }

  initPopup(cx) {
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.query = ""; this.cursor = 0; this.done = false; this.filterFocused = false;
    this.filter = InputState.new({ value: "", placeholder: "Filter panels" });
    this.filter.on("change", (_e, cx) => { this.query = this.filter.value(); this.cursor = 0; cx.notify(); });
    this.filter.on("submit", (_e, cx) => this.activate(this.visible()[this.cursor], cx));
    this.filter.on("focus", () => { this.filterFocused = true; });
    this.filter.on("blur", () => { this.filterFocused = false; });
    this.filter.focus();
    cx.timer.after(300, () => this.filter.focus());
  }

  // The panels the filter keeps (case-insensitive substring of label or group), in group order.
  filteredGroups() {
    const q = (this.query ?? "").trim().toLowerCase();
    const groups = groupPanels(layout());
    if (!q) return groups;
    return groups
      .map(g => ({ ...g, items: g.items.filter(d => d.label.toLowerCase().includes(q) || g.group.toLowerCase().includes(q)) }))
      .filter(g => g.items.length > 0);
  }

  visible() { return this.filteredGroups().flatMap(g => g.items); }

  // A row opens or closes its panel and the popup goes away (once, even if Enter and a click race).
  activate(d, _cx) {
    if (!d || this.done) return;
    this.done = true;
    runAll(toggleCommands(layout(), d.id));
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
  }

  popupKey(e, cx) {
    const k = e.key, n = this.visible().length;
    if (k === "down" || k === "up") {
      if (n) {
        this.cursor = (this.cursor + (k === "down" ? 1 : n - 1)) % n;
        // Keep the cursor's group in view: the list scrolls when it is taller than the popup.
        let seen = 0;
        const gi = this.filteredGroups().findIndex(g => (seen += g.items.length) > this.cursor);
        if (gi >= 0) this.scroll.scroll_to_item(gi);
      }
    }
    else if (k === "enter") { if (this.filterFocused) return; this.activate(this.visible()[this.cursor], cx); }
    else if (k === "escape") { if (!this.query) return; this.filter.set_value(""); this.query = ""; this.cursor = 0; }
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  // Every child of panel-body is a valid choice.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    try { localStorage.setItem("panels", JSON.stringify(this.panels)); } catch { /* kept for this copy */ }
  }

  render(cx) {
    if (this.templates) return this.renderTemplates();
    if (!this.popup) measureWindow();
    return this.popup ? this.renderPopup() : this.renderBar(cx);
  }

  renderPopup() {
    const t = theme();
    const root = layout();
    const open = openPanel(root);
    const ids = panelIds(root);
    const stored = shared(PINS_KEY);
    const pins = new Set(normalizePins(stored, ids));
    const groups = this.filteredGroups();
    const flat = groups.flatMap(g => g.items);
    if (this.cursor >= flat.length) this.cursor = Math.max(0, flat.length - 1);
    const hint = metaColor(t, t.popover);
    const row = (d) => {
      const on = open === d.id, pinned = pins.has(d.id), cur = flat[this.cursor]?.id === d.id;
      return h_flex().id(`row-${d.id}`).h(30).px(8).gap(8).items_center().rounded(6).flex_none()
        .bg(cur ? t.hover : on ? t.selected : t.popover).text_color(on || cur ? t.foreground : t.muted).text_size(TYPE.sm)
        .hover(s => s.bg(on ? t.selected : t.hover).text_color(t.foreground))
        .accessibility_label(`${on ? "Close" : "Open"} ${d.label}`)
        .on_click((_e, cx) => this.activate(d, cx))
        .child(svg(d.icon).size(14).flex_none())
        .child(div().flex_1().min_w(0).truncate().child(d.label))
        .when(on, el => el.child(div().text_size(TYPE.xs).text_color(hint).flex_none().child("Open")))
        .child(iconButton({
          id: `pin-${d.id}`, icon: `mods/drover-tabs/icons/${pinned ? "pin" : "pin-off"}.svg`, active: pinned,
          label: pinned ? `Unpin ${d.label} from the toolbar` : `Pin ${d.label} to the toolbar`,
          onClick: (cx) => { setShared(PINS_KEY, togglePin(shared(PINS_KEY), d.id)); cx.notify(); },
        }, t));
    };
    // A popup takes its content's height: give it one, so the list can scroll inside it.
    const all = groupPanels(root);
    const rows = all.reduce((n, g) => n + g.items.length, 0);
    // Under the button the opener's cap (its real top); from a key, mod.json's top. Both use the main window's height.
    const given = Number(props()?.maxHeight);
    const max = Math.min(given > 0 ? given : POPUP_MAX_H, popupMax(POPUP_TOP));
    const wanted = popupHeight(all.length, rows) + FILTER_H;
    const overflow = wanted > max;
    const empty = all.length === 0
      ? emptyState({ id: "panels-none", title: "No panels", body: "This layout has no panel area." }, t)
      : emptyState({ id: "panels-nomatch", title: "No matches", body: `Nothing matches "${this.query.trim()}".`,
        action: { id: "panels-clear", label: "Clear filter", onClick: (cx) => { this.filter.set_value(""); this.query = ""; cx.notify(); } } }, t);
    return v_flex().id("panels-popup").track_focus(this.handle).on_key_down((e, cx) => this.popupKey(e, cx))
      .w_full().h(Math.min(max, wanted)).bg(t.popover).p(6).gap(2)
      .child(h_flex().h(30).px(8).items_center().justify_between().flex_none()
        .child(div().text_size(TYPE.md).font_semibold().text_color(t.foreground).child("Panels"))
        .child(div().text_size(TYPE.xs).text_color(hint).child("Esc")))
      .child(div().flex_none().h(FILTER_H - 4).px(4).child(Input.new(this.filter).h(28).px(10).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(TYPE.sm).text_color(t.foreground)))
      .child(v_flex().relative().flex_1().min_h(0)
        .child(v_flex().id("panels-list").size_full().overflow_y_scroll().track_scroll(this.scroll).gap(1)
          .children(groups.length
            ? groups.map(g => v_flex().id(`group-${g.group}`).gap(1).flex_none()
              .child(h_flex().px(8).child(sectionLabel(g.group, t)))
              .children(g.items.map(row)))
            : [empty]))
        .when(overflow, el => el.child(Scrollbar.vertical("panels-list").mode("always").absolute().inset_0())))
      // Shown only when the list is taller than the popup: the scrollbar can be thin or hidden.
      .when(overflow, el => el.child(div().flex_none().h(18).flex().items_center().justify_center().text_size(TYPE.xs).text_color(hint).child("Scroll for more \u2193")));
  }

  renderBar(cx) {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    // A new space, tab or folder asks git at once (throttled; the timer covers the rest).
    const target = diffTarget();
    if (target.key !== this.diffState.key && cx?.spawn) this.refreshDiff(cx);
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, tip, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).accessibility_label(tip).on_mouse_down("left", stop).on_click(action).child(label);
    // Tabs: the active one carries a 2 px accent underline over a light fill; × shows on hover and on the active tab.
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      // An armed x (a busy tab's first click) stays shown, colored, and says what will end.
      const armed = liveArm(this.clickArm, Date.now())?.tab === c.id ? this.clickArm : null;
      const showClose = c.active || this.hoverTab === c.id || Boolean(armed);
      const closeTip = armed ? armed.text : "Close tab";
      return h_flex().id(`tab-${c.id}`).h(29).pl(10).pr(6).gap(7).rounded_t(6).items_center().flex_none().text_size(TYPE.sm)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border_b_2().border_color(c.active ? t.accent : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_hover((h, cx) => {
          const next = h ? c.id : this.hoverTab === c.id ? null : this.hoverTab;
          if (next !== this.hoverTab) { this.hoverTab = next; cx.notify(); }
        })
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        // drover's menu, whose Close asks twice for a busy tab.
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "drover-terminal-menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        // The × keeps its 16 px slot either way, so hovering never shifts the tabs.
        .child(div().id(`close-${c.id}`).size(16).flex_none().flex().items_center().justify_center().rounded(4)
          .when(showClose && !armed, el => el.text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)))
          .when(Boolean(armed), el => el.text_color(t.blocked).bg(t.blocked + "26"))
          .when(showClose, el => el
            .tooltip(closeTip).accessibility_label(closeTip).on_mouse_down("left", stop)
            .on_click((_e, cx) => { cx.stop_propagation(); this.closeByClick(c.id, cx); })
            .child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = findNode(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = findNode(root, "panel"), body = findNode(root, "panel-body");
    const ids = panelIds(root);
    this.syncPanel(space, panel, body, ids);
    const open = openPanel(root);
    const pins = normalizePins(shared(PINS_KEY), ids);
    // The diff chip stands in for the Changes button while it shows (same action).
    const diff = this.diffState.key === target.key ? this.diff : null;
    const chipToggles = Boolean(diff) && ids.includes("changes");
    const pinned = chipToggles ? pins.filter(id => id !== "changes") : pins;
    const panelButton = (id) => {
      const d = describe(findNode(body, id) ?? { id });
      const on = open === id;
      return iconButton({ id: `panel-${id}`, icon: d.icon, active: on, label: on ? `Close ${d.label}` : `Open ${d.label}`,
        onClick: () => runAll(toggleCommands(layout(), id)) }, t);
    };
    const changesOn = open === "changes";
    const diffChip = () => {
      const tip = `${diff.files} file${diff.files === 1 ? "" : "s"} changed${chipToggles ? (changesOn ? " · Close Changes" : " · Open Changes") : ""}`;
      return h_flex().id("diff-chip").h(24).px(6).flex_none().items_center().rounded(6)
        .bg(chipToggles && changesOn ? t.selected : t.chrome).tooltip(tip)
        .when(chipToggles, el => el.cursor_pointer().hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
          .on_click((_e, cx) => { cx.stop_propagation(); runAll(toggleCommands(layout(), "changes")); }))
        .child(diffStat({ added: diff.added, removed: diff.removed, id: "diff-stat" }, t));
    };
    // "Panels" is lit while an unpinned panel is open (or Changes behind the chip): the open panel always has a lit control.
    const unpinnedOpen = open !== null && !pinned.includes(open) && !(chipToggles && changesOn);
    const openLabel = unpinnedOpen ? describe(findNode(body, open) ?? { id: open }).label : null;
    const panelsKey = pickBinding(keys().filter(k => k.action === `${MOD}.panels`), w?.platform ?? "macos")?.keys
      ?.replace(/\bsecondary\b/g, (w?.platform ?? "macos") === "macos" ? "cmd" : "ctrl");
    const panelsTip = `${openLabel ? `${openLabel} is open · ` : ""}All panels${panelsKey ? ` (${panelsKey})` : ""}`;
    const title = contextTitle(space);
    const openIn = openInTarget();
    const openInKey = pickBinding(keys().filter(k => k.action === `${MOD}.open-in`), w?.platform ?? "macos")?.keys
      ?.replace(/\bsecondary\b/g, (w?.platform ?? "macos") === "macos" ? "cmd" : "ctrl");
    const showTitle = Boolean(title) && titleFits(this.titleW);
    // Measured tab widths by tab id; tabs that are gone drop out.
    this.tabW ??= new Map();
    for (const id of [...this.tabW.keys()]) if (!shown.some(x => x.id === id)) this.tabW.delete(id);
    const tabsW = shown.length > 0 && shown.every(x => this.tabW.get(x.id) > 0)
      ? shown.reduce((a, x) => a + this.tabW.get(x.id), 0) + 2 * (shown.length - 1) : 0;
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      // The tabs take their own width and shrink (then scroll) only once the title's room is gone.
      .child(h_flex().id("tab-scroll").when(tabsW > 0, el => el.w(tabsW)).flex_grow(0).flex_shrink(1).min_w(0).h_full().items_end().gap(2).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        // A scroll box stretches to the free width: pin it to the tabs' measured width so the title keeps the middle.
        .children(shown.map((x, i) => div().id(`tabw-${x.id}`).flex_none().h_full().flex().items_end()
          .on_size_change((size, cx) => { const wv = Math.ceil(size?.width ?? 0); if (wv !== this.tabW.get(x.id)) { this.tabW.set(x.id, wv); cx.notify(); } })
          .child(item(x, i, shown)))))
      // "+": a shell tab here. "▾": the templates menu.
      .child(h_flex().flex_none().items_center()
        .child(iconButton({ id: "tab-new", icon: "+", label: "New shell tab", onClick: () => run("tab.new", newTabArgs({ argv: null }, space?.id)) }, t))
        .child(div().id("tab-new-menu").w(14).h(24).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
          .text_size(TYPE.xs).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip("New tab from template").accessibility_label("New tab from template")
          .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); const a = anchorOf(e, 14, 24); if (a) this.newBtn = a; })
          .on_click((_e, cx) => { cx.stop_propagation(); this.openTemplates(cx); })
          .child("▾")))
      // "Open in ▾": the focused folder in the last editor; ▾ (and the drover-tabs.open-in key) picks one.
      .when(Boolean(openIn.folder), el => el.child(h_flex().id("open-in").flex_none().items_center().ml(4)
        .child(textButton({ id: "open-in-last", label: "Open in", tooltip: openInTip(shared(EDITOR_KEY), openIn.on), onClick: (cx) => this.openInLast(cx) }, t))
        .child(div().id("open-in-menu").w(14).h(24).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
          .text_size(TYPE.xs).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip(openInKey ? `Open in… (${openInKey})` : "Open in…").accessibility_label("Choose an editor")
          .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); const a = anchorOf(e, 14, 24); if (a) this.openInBtn = a; })
          .on_click((_e, cx) => { cx.stop_propagation(); this.openEditors(); })
          .child("▾"))))
      // The free middle: "space ⎇ branch", centered; it truncates first and hides when narrower than TITLE_MIN_W.
      .child(h_flex().id("context-title").flex_1().min_w(0).h_full().px(8).items_center().justify_center().overflow_hidden()
        .on_size_change((size, cx) => { const wv = Math.round(size?.width ?? 0); if (wv !== this.titleW) { this.titleW = wv; cx.notify(); } })
        .when(showTitle, el => el.child(h_flex().min_w(0).gap(6).items_center().text_size(TYPE.sm).text_color(metaColor(t, t.chrome))
          .accessibility_label(title.branch ? `${title.name} on ${title.branch}` : title.name)
          .child(div().min_w(0).flex_shrink(1).truncate().text_color(t.foreground).child(title.name))
          .when(Boolean(title.branch), el => el
            .child(svg("mods/drover-tabs/icons/git-branch.svg").size(12).flex_none())
            .child(mono(div().min_w(0).flex_shrink(1).truncate().child(title.branch)))))))
      .when(Boolean(diff), el => el.child(diffChip()))
      .children(pinned.map(panelButton))
      .when(ids.length > 0, el => el.child(div().id("panels-menu").size(24).flex_none().flex().items_center().justify_center().rounded(6)
        .bg(unpinnedOpen ? t.selected : t.chrome).text_color(unpinnedOpen ? t.foreground : t.muted)
        .cursor_pointer().hover(s => s.bg(t.hover)).on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.rememberPanelsButton(e); })
        .tooltip(panelsTip).accessibility_label("All panels")
        .on_click(() => this.openPopup())
        .child(svg("mods/drover-tabs/icons/panel-right.svg").size(14))))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/drover-tabs/win-min.svg").size(16) : "−", "Minimize", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/drover-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", w.maximized ? "Restore" : "Maximize", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/drover-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), "Close window", () => run("window.close"))));
  }
}
