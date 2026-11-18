// Context menus (Herdr's items). Opened as a popup with
// props { tab: "pane" | "tab" | "space" | "global", target }.
// ↑/↓ move, Enter runs, Esc closes. An item is [label, command, args];
// a command "worktree" opens the worktree dialog instead.
//
// drover-terminal-menu: a copy of Herdr's shipped `menu` mod (Apache-2.0, see NOTICE),
// with "Open selection…" added to the pane menu: the terminal's selection goes to
// drover-open, and the clipboard is put back as it was.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, keys, terminals, spaces, panes, exec, window } from "herdr";
import { stripControl } from "./lib/guard.js";

const OPEN_SELECTION = "drover-open.selection";
const MAX_SELECTION = 4096;
// How long terminal.copy gets to land in the clipboard.
const COPY_WAIT_MS = 1500;
const COPY_POLL_MS = 30;

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A space's checkout: "main" (a repo's own), "linked" (a worktree), or null.
async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

function items(p, git) {
  p = p ?? {};
  const tg = p.target ?? {};
  switch (p.tab) {
    case "pane": {
      // A kept sub-agent can go back under its parent, still running.
      const all = terminals();
      const term = all.find((t) => t.address === tg.terminal);
      const parent = term?.parent && all.find((t) => t.address === term.parent);
      // Once they go to the program, Shift+right-click still opens this menu.
      const toProgram = term?.labels?.["herdr.right-click"] === "program";
      // A terminal shown outside a tab (a layout terminal block, a window) has
      // no pane to split, zoom or close: its pane is the block's id.
      const inTab = panes().some((pane) => pane.pane === tg.pane);
      return [
        ...(term || inTab ? [["Open selection…", OPEN_SELECTION, { pane: tg.pane, terminal: tg.terminal }]] : []),
        ...(inTab
          ? [
              ["Split right", "pane.split", { direction: "right", pane: tg.pane }],
              ["Split down", "pane.split", { direction: "down", pane: tg.pane }],
              ["Zoom", "pane.zoom", { pane: tg.pane }],
            ]
          : []),
        ...(term
          ? [
              toProgram
                ? ["Use Herdr right-click menu", "terminal.right_click", { terminal: term.address, to: "menu" }]
                : ["Send right-clicks to pane", "terminal.right_click", { terminal: term.address, to: "program" }],
            ]
          : []),
        ...(parent ? [[`Send back to ${parent.name || parent.address}`, "terminal.park", { terminal: term.address }]] : []),
        ...(inTab ? [["Close pane", "pane.close", { pane: tg.pane }]] : []),
      ];
    }
    case "tab":
      return [
        ["Rename", "tab.rename", { id: tg.id }],
        ["New tab", "tab.new", { space: tg.space }],
        ["Close", "tab.close", { id: tg.id }],
      ];
    case "space":
      return [
        ["Rename", "space.rename", { id: tg.id }],
        ...(git ? [["New worktree", "worktree", { space: tg.id, action: "new" }], ["Open worktree", "worktree", { space: tg.id, action: "open" }]] : []),
        ...(git === "linked" ? [["Remove worktree", "worktree", { space: tg.id, action: "remove" }]] : []),
        ["Close", "space.close", { id: tg.id }],
      ];
    default:
      return [
        ["New space", "space.new", {}],
        ["Keybinds", "app.help", {}],
        ["Theme: graphite", "app.theme", { name: "graphite" }],
        ["Theme: ink", "app.theme", { name: "ink" }],
        ["Theme: moss", "app.theme", { name: "moss" }],
        ["Theme: atom one dark", "app.theme", { name: "atom-one-dark" }],
      ];
  }
}

function menuIcon(command) {
  if (command === OPEN_SELECTION) return "mods/drover-terminal-menu/ui/text-select.svg";
  const name = command.endsWith(".close") ? "x" : command.endsWith(".rename") ? "square-pen" : command.endsWith(".new") ? "plus" : command === "worktree" ? "git-branch" : command === "app.help" ? "terminal" : command === "app.theme" ? "settings" : command === "pane.split" ? "panel-right" : command === "pane.zoom" ? "square" : "terminal";
  return `mods/workspace-chrome/${name}.svg`;
}

// Where the clicked terminal lives: its folder, its machine and its pane.
export function selectionSource(target) {
  const tg = target ?? {};
  const all = panes();
  const row = all.find((p) => p.pane === tg.pane) || all.find((p) => p.terminal && p.terminal === tg.terminal);
  const term = terminals().find((t) => t.address === tg.terminal);
  const cwd = row?.cwd || term?.cwd || null;
  const space = row?.tab ? spaces().find((s) => (s.tabs ?? []).some((t) => t.id === row.tab)) : null;
  return { pane: row?.pane || null, cwd: typeof cwd === "string" && cwd.startsWith("/") ? cwd : null, on: space?.machine || null };
}

// Copies the terminal's selection and puts the clipboard back. -> the selected text, or null.
// A clipboard that held text gets that text back; one that held something else (an image)
// cannot be read here, so it ends up holding the selection.
export async function copySelection(cx, target) {
  const tg = target ?? {};
  const prev = cx.read_from_clipboard();
  const hadText = typeof prev === "string";
  const mark = `drover-terminal-menu:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  if (hadText) cx.write_to_clipboard(mark);
  // terminal.copy acts on the focused terminal: focus the clicked one first.
  if (panes().some((p) => p.pane === tg.pane)) run("pane.focus", { pane: tg.pane });
  else if (tg.terminal) run("pane.focus", { terminal: tg.terminal });
  let got = null;
  try {
    run("terminal.copy");
    for (let waited = 0; waited <= COPY_WAIT_MS; waited += COPY_POLL_MS) {
      const now = cx.read_from_clipboard();
      if (typeof now === "string" && now !== mark && (hadText || now !== "")) { got = now; break; }
      await cx.sleep(COPY_POLL_MS);
    }
  } finally {
    // Put the old text back only while the clipboard still holds what this copy put there:
    // the marker, or the selection it read. Anything else was copied by the user meanwhile.
    if (hadText) {
      const cur = cx.read_from_clipboard();
      if (cur === mark || (got != null && cur === got)) cx.write_to_clipboard(prev);
    }
  }
  if (got == null || !got.trim()) return null;
  return stripControl(got.replace(/\r\n?/g, "\n")).slice(0, MAX_SELECTION);
}

// The key bound to a command, for the hint on the right.
function shortcut(name, args) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  const value = args && Object.values(args)[0];
  const list = keys().filter((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  let platform = "macos";
  try { platform = window()?.platform ?? "macos"; } catch { /* no window yet: macOS */ }
  // secondary is Cmd on macOS and Ctrl elsewhere; show the key the user presses.
  return (pickBinding(list, platform)?.keys ?? "").replace(/\bsecondary\b/g, platform === "macos" ? "cmd" : "ctrl");
}

// keys.json can bind one command twice: a macOS chord and a Linux and Windows one. The one for this
// platform: on macOS one held with cmd or secondary, elsewhere one with no cmd, super or win
// (secondary is ctrl there); else the first.
export function pickBinding(list, platform) {
  const held = (b) => String(b?.keys ?? "").trim().split(/\s+/).flatMap((s) => s.split("-").slice(0, -1)).map((m) => m.toLowerCase());
  const cmd = (m) => m === "cmd" || m === "super" || m === "win";
  const fits = platform === "macos" ? (b) => held(b).some((m) => cmd(m) || m === "secondary") : (b) => !held(b).some(cmd);
  return list.find(fits) ?? list[0] ?? null;
}

export default class Menu extends View {
  init(_props, cx) {
    this.at = 0;
    this.git = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props();
    const space = p?.tab === "space" && spaces().find((s) => s.id === p.target?.id);
    const folder = space && place(space);
    if (folder)
      cx.spawn(async (cx) => {
        this.git = await checkout(folder, space.machine).catch(() => null);
        cx.notify();
      });
  }

  // Reads the selection while the menu is still open (closing it would stop this task).
  openSelection(cx) {
    if (this.grabbing) return;
    this.grabbing = true;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const p = props() ?? {};
      let text = null;
      try {
        text = await copySelection(cx, p.target);
      } catch (e) {
        text = null;
      }
      this.grabbing = false;
      if (!text) {
        this.note = "Select some text in the terminal first.";
        cx.notify();
        return;
      }
      const from = selectionSource(p.target);
      closeOverlay(p.overlay);
      openOverlay({
        mod: "drover-open", kind: "popup", at: "pointer", width: 380, height: 340,
        props: { target: text, ...(from.cwd ? { cwd: from.cwd } : {}), ...(from.pane ? { pane: from.pane } : {}), ...(from.on ? { on: from.on } : {}) },
      });
    });
  }

  choose(i, cx) {
    const it = items(props(), this.git)[i];
    if (!it) return;
    if (it[1] === OPEN_SELECTION) return this.openSelection(cx);
    closeOverlay(props()?.overlay);
    if (it[1] === "worktree") openOverlay({ mod: "worktree", kind: "dialog", ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: it[2] });
    else run(it[1], it[2]);
  }

  render(cx) {
    const t = theme();
    const list = items(props(), this.git);
    return v_flex()
      .id("menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(
        list.map((it, i) =>
          v_flex()
            .when(i > 0 && (it[1].endsWith(".close") || it[1] === "app.help" || list[i - 1][1] === OPEN_SELECTION || (it[1] === "app.theme" && list[i - 1][1] !== "app.theme")), el => el.child(div().mx(7).my(4).h(1).bg(t.border)))
            .child(h_flex()
            .id(`mi-${i}`)
            .h(31)
            .px(8)
            .gap(9)
            .rounded(7)
            .items_center()
            .justify_between()
            .text_color(t.foreground)
            .when(i === this.at, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.choose(i, cx))
            .child(svg(menuIcon(it[1])).size(14).flex_none().text_color(t.muted))
            .child(div().flex_1().child(it[1] === OPEN_SELECTION && this.grabbing ? "Reading selection…" : it[0]))
            .child(div().text_size(11).text_color(t.dim).child(shortcut(it[1], it[2])))),
        ),
      )
      .when(!!this.note, (el) => el.child(div().id("menu-note").px(8).py(4).text_size(11.5).text_color(t.blocked).child(this.note)));
  }
}
