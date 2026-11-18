import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Popover, Input } from "gpui-base";
import { spaces, machines, shared, run, props, openOverlay } from "herdr";
import { projectMark } from "./project.js";
import { glow, tip } from "./tip.js";
import { stop, pressed, justClosed } from "./focus.js";
import { step, scrollList } from "./list.js";
import { FIRST } from "./row-model.js";
import { TYPE, metaColor, panelHeader } from "./lib/panel-ui.js";

// The space filter's rows, flush, and how many show before the list scrolls.
const SCOPE_ROW = 32, SCOPE_SHOWN = 9;

export function inboxMatches(view) {
  const q = view.search.value().toLowerCase();
  return [{ id: null, name: "All spaces" }, ...spaces()].filter((s) => s.name.toLowerCase().includes(q));
}

// A click shows that space alone; shift-click adds or removes it and keeps the menu open.
export function pickInboxSpace(view, s, shift, cx) {
  if (!s) return;
  view.scope = !s.id ? [] : !shift ? [s.id] : view.scope.includes(s.id) ? view.scope.filter((id) => id !== s.id) : [...view.scope, s.id];
  localStorage.setItem("scope", JSON.stringify(view.scope));
  // A new scope starts the settled tail over.
  view.limit = FIRST;
  if (!shift) view.scopeOpen = false;
  cx.notify();
}

export function inboxTop(view, t, model) {
  const { sp, ps, scope } = model;
  const lit = (id, color) => view.hot === id ? t.foreground : color;
  // A space's mark, as the spaces list draws it.
  const avatar = (id, name, size) => projectMark(sp.find((s) => s.id === id) ?? { name: name ?? "" }, size, t, ps);
  // The top row: search on the left, then the space filter, new space and new tab.
  const asks = props()?.newMenu && machines().length > 1;
  // The filter shows what it filters to: one avatar, two overlapping, or the plain filter icon.
  const scoped = sp.filter((s) => scope.includes(s.id)), found = view.matches();
  const choice = (s, i) => {
    const on = s.id ? scope.includes(s.id) : scope.length === 0;
    // Selection is a check badge on the icon.
    return h_flex().id(`scope-${s.id ?? "all"}`).h(SCOPE_ROW).px(8).gap(8).flex_none().items_center().rounded(4)
      .when(i === view.scopeAt, (el) => el.bg(t.selected))
      .on_hover((over, cx) => { if (over && view.scopeAt !== i) { view.scopeAt = i; cx.notify(); } })
      .role("button").accessibility_label(s.name)
      .on_click((e, cx) => view.pick(s, e.modifiers.shift, cx))
      .child(div().relative().flex_none()
        .child(s.id ? avatar(s.id, s.name, 16) : svg("mods/drover-inbox/icons/folder.svg").size(16).text_color(t.muted))
        // A 12px badge with a 2px ring outside it; a border here is inside, so 16 and 2 further out.
        .when(on, (el) => el.child(h_flex().absolute().right(-6).bottom(-6).size(16).rounded_full().bg(t.accent)
          .border(2).border_color(t.popover).items_center().justify_center()
          .child(svg("mods/drover-inbox/icons/check.svg").size(8).text_color("#ffffff")))))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(s.name));
  };
  // From the button's left edge, 288 wide, out over the work column; radius 8 and rows' 4, inset 4.
  const filter = Popover.new("inbox-scope-menu").anchor("top_left").open(view.scopeOpen)
    .on_open_change((open, cx) => {
      view.scopeOpen = open;
      if (open) {
        view.scopeAt = 0;
        view.search.set_value("");
        view.search.focus();
      }
      cx.notify();
    })
    .trigger(stop(view, t, "inbox-scope", h_flex().id("inbox-scope").size(28).flex_none().items_center().justify_center().rounded(8)
      .hover((s) => s.bg(t.hover)).on_hover(glow(view, "inbox-scope"))
      .role("button").accessibility_label(scoped.length ? `Filter by space: ${scoped.map((s) => s.name).join(", ")}` : "Filter by space")
      .child(scoped.length > 1
        // The second mark overlaps by 4 with a 2px ring of the sidebar's color.
        ? h_flex().children(scoped.slice(0, 2).map((s, i) => i === 0 ? avatar(s.id, s.name, 14)
          : h_flex().flex_none().ml(-6).rounded(6).border(2).border_color(t.chrome).child(avatar(s.id, s.name, 14))))
        : scoped.length
          ? avatar(scoped[0].id, scoped[0].name, 16)
          : svg("mods/drover-inbox/icons/list-filter.svg").size(16).text_color(lit("inbox-scope", t.muted))), 8))
    .content(v_flex().id("inbox-scope-panel").w(288).mt(4).p(4).rounded(8)
      .bg(t.popover).border_1().border_color(t.border).shadow_lg().text_size(TYPE.md)
      .on_key_down((e, cx) => {
        const to = step(e, view.scopeAt, view.matches().length);
        if (to < 0) return;
        view.scopeAt = to;
        cx.stop_propagation();
        cx.notify();
      })
      // The search field: 12 in and 10 down less the 1 it shifts up, a 26 field, 6 to the rule. Its text starts 20 from
      // the icon, 4 before the names, and inside the button's left edge as the panel hangs from it.
      .child(h_flex().mx(8).mt(5).h(33).pb(6).gap(4).flex_none().items_center().border_b_1().border_color(t.border)
        .child(svg("mods/drover-inbox/icons/search.svg").size(16).flex_none().text_color(t.dim))
        .child(Input.new(view.search).flex_1().h_full().text_size(TYPE.md).text_color(t.foreground)))
      .child(div().pt(5).flex_none()
        .when(found.length > 0, (el) => el.child(scrollList(view, "inbox-scope-list", { count: found.length, row: SCOPE_ROW, at: view.scopeAt, height: Math.min(found.length, SCOPE_SHOWN) * SCOPE_ROW,
          draw: (i) => choice(found[i], i), wheeled: (keep) => { view.scopeAt = keep; } })))
        .when(found.length === 0, (el) => el.child(div().p(8).text_center().line_height("20px").text_color(metaColor(t, t.popover)).child("No matching spaces.")))));
  // The header names the panel and carries the two creating actions; Search and the space filter are a body row under it.
  const nope = [...model.pinned, ...model.out, ...model.busyRows].filter((a) => model.state(a) === "blocked").length;
  const newSpace = (cx) => {
    view.hot = null;
    // The layout's menu asks which machine, as its mod.json places it; the shipped one can't, so docked alone it's the active space's.
    const closing = justClosed(view, `${props()?.newMenu}.pickClosed`);
    if (!asks) run("space.new");
    else if (!closing) openOverlay({ mod: props().newMenu, kind: "popup", frame: "none", at: /** @type {any} */ ("top"), offset: 96, width: 576, height: 420, props: { pick: true } });
    cx.notify();
  };
  const newTab = (cx) => { view.hot = null; const menu = props()?.newMenu ?? "new-menu"; if (!justClosed(view, `${menu}.closed`)) run("mod.open", { name: menu }); cx.notify(); };
  const header = panelHeader({ title: "Inbox", meta: nope > 0 ? `${nope} need${nope === 1 ? "s" : ""} you` : undefined, actions: [
    { id: "inbox-new-space", icon: "mods/drover-inbox/icons/folder-plus.svg", label: "New space", onClick: newSpace },
    { id: "inbox-new-tab", icon: "mods/drover-inbox/icons/square-pen.svg", label: "New tab", onClick: newTab },
  ] }, t);
  const find = h_flex().id("inbox-filter-row").h(32).px(8).gap(4).flex_none().items_center()
    // A button that opens Go to, sized as a field.
    .child(stop(view, t, "inbox-search", h_flex().id("inbox-search").flex_1().h(32).px(8).gap(8).items_center().rounded(6).text_size(TYPE.sm).font_medium()
      .text_color(lit("inbox-search", metaColor(t, t.chrome))).hover((s) => s.bg(t.hover)).on_hover(glow(view, "inbox-search")).on_mouse_down("left", () => pressed(view))
      // Each opens over its button, before the pointer can report leaving it.
      .role("button").accessibility_label("Search").on_click((_e, cx) => { view.hot = null; const picker = props()?.picker ?? "picker"; if (!justClosed(view, `${picker}.closed`)) run("mod.open", { name: picker }); cx.notify(); })
      .child(svg("mods/drover-inbox/icons/search.svg").size(16).flex_none().text_color(lit("inbox-search", metaColor(t, t.chrome))))
      .child(div().child("Search"))))
    .child(tip(view, t, "inbox-scope", "Filter by space", filter, { off: view.scopeOpen, hint: "Shift+click to pick several", below: true }));
  return v_flex().id("inbox-top").flex_none().child(header).child(find);
}
