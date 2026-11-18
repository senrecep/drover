// The agents list as a rail: when the sidebar is narrower than RAIL_BELOW (folded, or dragged narrow),
// one icon cell per agent with its status as a corner dot, and a thin line between groups. Names,
// status and space live in each cell's tooltip.
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { namer } from "./name.js";
import { focusAgent } from "./zoom.js";
import { programIcon } from "./program.js";
import { sidebarParts } from "./sidebar.js";
import { SECTION, RANK } from "./rows.js";

export const RAIL_BELOW = 160;
export const RAIL_CELL = 32;
const CELL_H = 26;
const FALLBACK_ICON = "mods/workspace-chrome/terminal.svg";
const DOTTED = new Set(["working", "blocked", "done"]);

// It goes by the sidebar's width, not a flag. No sidebar in the layout reads as wide.
export const narrow = (root) => (sidebarParts(root).rail?.size?.px ?? Infinity) < RAIL_BELOW;

const centered = (el) => h_flex().w_full().flex_none().justify_center().child(el);

/**
 * The rail's cells, top to bottom. Every group's agents show, folded or not: nothing in the rail can
 * unfold a group, and an idle group starts folded.
 * @param {any} view @param {any} t @param {{ groups: any[], viewing: (a: any) => boolean, shownStatus: (a: any) => string }} data
 */
export function railCells(view, t, { groups, viewing, shownStatus }) {
  const label = namer();
  const cell = (a) => {
    const st = shownStatus(a);
    const on = viewing(a);
    const word = SECTION[RANK[st]] ?? "Unknown";
    const name = label(a) || a.program?.name || a.address;
    const tip = [name, word, a.space_name].filter(Boolean).join(" · ");
    const pic = programIcon(a.program, 16, t.foreground) ?? svg(FALLBACK_ICON).size(16).flex_none().text_color(t.muted);
    return centered(h_flex().id(`ag-${a.address}`).relative().w(RAIL_CELL).h(CELL_H).flex_none()
      .items_center().justify_center().rounded(6).cursor_pointer()
      .role("button").tooltip(tip).accessibility_label(tip)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => focusAgent(a.address))
      .child(pic)
      .when(DOTTED.has(st), (el) => el.child(div().absolute().right(3).bottom(2).size(st === "blocked" ? 8 : 7).rounded_full()
        .border_1().border_color(t.chrome).bg(t[st] ?? t.dim))));
  };
  return groups.flatMap((g, i) => [
    ...(i > 0 ? [centered(div().id(`rail-gap-${g.id}`).w(20).h(1).my(4).flex_none().bg(t.border))] : []),
    ...g.members.map(cell),
  ]);
}
