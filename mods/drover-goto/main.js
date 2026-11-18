// Go to anything: one search field over spaces, tabs, agents, the side panel's
// panels, and the drover mods' commands. Enter goes there.
//
// Two kinds of copy:
// - a layout block (a 0 px block in the status row is enough): runs the key command
//   drover-goto.open. Draws nothing.
// - an overlay (mod.open drover-goto, or the one the block opens): the dialog.
//
// Enter only selects (space, tab, layout page, panel tab) or runs a drover mod's own
// command. No text goes to a terminal, nothing is closed or deleted, no program runs.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import {
  run, props, theme, settings, spaces, agents, layout, nextCommand, openOverlay, closeOverlay,
  appHome, readTextFile, writeTextFile,
} from "herdr";
import * as fs from "fs/promises";
import { buildItems, rank, commandsFor, pushRecent, readRecent, writeRecent, segments, move } from "./logic.js";

const MOD = "drover-goto";
const ROW_H = 40;
// No change notification in the API: the open overlay checks the data this often.
const REFRESH_MS = 400;
const DIR = () => `${appHome()}/data/${MOD}`;
const FILE = () => `${DIR()}/recent.json`;

const KIND_LABEL = { space: "Space", tab: "Tab", agent: "Agent", panel: "Panel", command: "Command" };
const KIND_ICON = {
  space: "mods/workspace-chrome/folder.svg",
  tab: "mods/workspace-chrome/square.svg",
  agent: "mods/drover-tabs/icons/bot.svg",
  panel: "mods/workspace-chrome/panel-right.svg",
  command: "mods/workspace-chrome/terminal.svg",
};

/** Puts the item first in the recents file: read, change, write against the read text; one retry. */
async function remember(id) {
  await fs.mkdir(DIR(), { recursive: true }).catch(() => {});
  for (let attempt = 0; ; attempt++) {
    const raw = await readTextFile(FILE());
    try {
      await writeTextFile(FILE(), writeRecent(pushRecent(readRecent(raw), id)), raw);
      return;
    } catch (e) {
      if (attempt >= 1) throw e;
    }
  }
}

export default class GoTo extends View {
  init(p, cx) {
    this.overlay = (p ?? props())?.overlay ?? null;
    if (!this.overlay) return this.initBlock(cx);
    this.recent = [];
    this.results = [];
    this.sig = null;
    // The selection is an item id, so it stays on the same item when the list changes.
    this.selectedId = null;
    this.scroll = ScrollHandle.new();
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Go to a space, tab, agent or command…   > commands   @ agents   # tabs" });
    this.input.on("change", (_e, cx) => {
      this.selectedId = null;
      this.refresh();
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.go(cx));
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
    this.refresh();
    // Only the overlay copy runs this, and only while it is open (cancelled in close()).
    this.task = cx.timer.every(REFRESH_MS, (cx) => {
      if (this.refresh()) cx.notify();
    });
    cx.spawn(async (cx) => {
      try {
        this.recent = readRecent(await readTextFile(FILE()));
      } catch {
        // No recents file yet, or it can't be read: start empty.
      }
      this.sig = null;
      this.refresh();
      cx.notify();
    });
  }

  async close() {
    this.task?.cancel();
  }

  // Items and ranking again only when the query, the recents or the data changed. True when they did.
  // Never called from render.
  refresh() {
    const data = { spaces: spaces(), agents: agents(), layout: layout() };
    const query = this.input.value();
    const sig = JSON.stringify([query, this.recent, data]);
    if (sig === this.sig) return false;
    this.sig = sig;
    this.results = rank(buildItems(data), query, this.recent);
    return true;
  }

  // Index of the selected item in the results, or -1.
  selected() {
    return this.results.findIndex((hit) => hit.item.id === this.selectedId);
  }

  // A layout copy: the key command only.
  initBlock(cx) {
    cx.spawn(async () => {
      for (;;) {
        const command = String(await nextCommand());
        if (command === "open") openOverlay({ mod: MOD, kind: "dialog", width: 640, height: 480 });
      }
    });
  }

  // Not close(): that name is the copy's lifecycle hook.
  dismiss() {
    closeOverlay(this.overlay);
  }

  /** Carries out the item shown as selected (the first when none is picked), remembers it, and closes. */
  go(cx) {
    const hit = this.results[Math.max(0, this.selected())];
    if (!hit) return;
    const { item } = hit;
    cx.spawn(async () => {
      try {
        await remember(item.id);
      } catch {
        // Recents are a convenience: never block going there.
      }
      for (const [name, args] of commandsFor(item.action)) run(name, args);
      this.dismiss();
    });
  }

  key(e, cx) {
    const k = e.key;
    const ctrl = Boolean(e.modifiers?.control);
    if (k === "escape") return this.dismiss();
    let by;
    if (k === "down" || (ctrl && k === "n")) by = 1;
    else if (k === "up" || (ctrl && k === "p")) by = -1;
    else return;
    const at = move(Math.max(0, this.selected()), by, this.results.length);
    this.selectedId = this.results[at]?.item.id ?? null;
    this.scroll.scroll_to_item(at);
    cx.stop_propagation();
    cx.notify();
  }

  icon(t, item) {
    const color = item.kind === "agent" ? (t[item.state] ?? t.dim) : t.muted;
    return svg(KIND_ICON[item.kind]).size(15).flex_none().text_color(color);
  }

  title(t, item, positions) {
    const row = h_flex().min_w(0).flex_1().overflow_hidden().whitespace_nowrap().text_size(13);
    for (const s of segments(item.title, positions)) {
      row.child(s.on
        ? div().flex_none().font_semibold().text_color(t.accent).child(s.text)
        : div().flex_none().text_color(t.foreground).child(s.text));
    }
    return row;
  }

  row(t, hit, i, at) {
    const { item, positions } = hit;
    const on = i === at;
    return h_flex().id(`goto-${i}`).h(ROW_H).flex_none().mx(6).px(10).gap(10).items_center().rounded(6)
      .cursor_pointer()
      .when(on, (el) => el.bg(t.selected))
      .hover((s) => s.bg(on ? t.selected : t.hover))
      .on_click((_e, cx) => {
        this.selectedId = item.id;
        this.go(cx);
      })
      .child(this.icon(t, item))
      .child(this.title(t, item, positions))
      .child(div().max_w(260).flex_shrink(1).truncate().text_size(11).text_color(t.dim).child(item.sub))
      .child(div().w(62).flex_none().text_right().text_size(11).text_color(t.dim).child(KIND_LABEL[item.kind]));
  }

  render() {
    if (!this.overlay) return div();
    const t = theme();
    // Read-only: no picked item (or it is gone) shows the first, without storing it.
    const at = Math.max(0, this.selected());
    return v_flex().id("goto").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).pt(12).pb(8).gap(10).bg(t.popover).text_color(t.foreground).text_size(13)
      .font_family(settings().font_family ?? "JetBrains Mono")
      .child(h_flex().h(36).flex_none().mx(6).px(10).gap(8).items_center().rounded(6)
        .border_1().border_color(t.accent).bg(t.background)
        .child(svg("mods/workspace-chrome/search.svg").size(15).flex_none().text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground)))
      .child(v_flex().id("goto-list").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll)
        .when(this.results.length === 0, (el) => el.child(div().px(16).py(8).text_size(12).text_color(t.dim).child("Nothing matches.")))
        .children(this.results.map((hit, i) => this.row(t, hit, i, at))))
      .child(h_flex().px(16).pt(2).gap(12).flex_none().text_size(11).text_color(t.dim)
        .child("↑↓ move").child("Enter go").child("Esc close"));
  }
}
