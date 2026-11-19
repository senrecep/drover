# drover-terminal-menu

Herdr's terminal right-click menu with one more item: Open selection….

It is a copy of the shipped `menu` mod (made with `mod.clone`), so every item the shipped menu
shows is still there. In the pane menu, "Open selection…" comes first:

1. it focuses the clicked terminal and runs `terminal.copy`,
2. reads the copied text and puts the clipboard back the way it was,
3. opens [`drover-open`](../drover-open) at the pointer with that text, the terminal's folder,
   its pane and its machine, so relative paths and `file:line` locations resolve.

With nothing selected the menu stays open and says "Select some text in the terminal first".

## Closing a busy tab

drover's tab bar and Spaces sidebar open this menu's tab menu when you right-click a tab. (The pane
header opens its pane menu, where "Close pane" is not checked.) In the tab menu, Close checks the
tab first:

- If no agent in the tab is working or waiting for you, the tab closes at once. When it is the last
  tab of its space, Herdr still asks before the space goes.
- If one is, the menu stays open. The row turns into "Click again to close" and the line under it
  names what will stop, for example "Click again to close. Claude Code is working and will stop."
  A second click (or Enter) within 6 seconds closes the tab. A double click counts once.
- Sub-agents started from a terminal in the tab count too, and an agent that reported an error
  counts as waiting for you.
- If a new agent starts in the tab before the second click, the menu asks again with the new list.
- If the agent list cannot be read, the tab is treated as busy.

The tab bar's x and the `drover-tabs.close` key follow the same rules. The check lives in
`close-guard.js`, which is the same file in drover-tabs, next to a copy of drover-pane's `tree.js`.

## Turn it on

A layout picks its terminal menu with a root field:

```json
{ "terminal_menu": "drover-terminal-menu" }
```

Without it the layout keeps Herdr's `menu`. A layout that already names another menu loses that
menu's own items when switched.

## Limits

- The clipboard is restored only when it held text. An image or file on the clipboard cannot be read
  by a mod, so after "Open selection…" the clipboard holds the selection instead.
- The selection is copied with `terminal.copy`, which acts on the focused terminal; the menu focuses
  the clicked one first. If the right-click itself clears the selection, there is nothing to copy.
- At most 4096 characters are passed on; control characters are dropped.
- Only the tab menu's Close is guarded. "Close pane" and the space menu's Close still act on one click.
- The key hint next to Close shows the global `tab.close` key. A key bound only in a layout section
  does not show there.

## Platforms

The menus work the same on macOS, Linux and Windows. The space menu asks `git` whether a space is a
worktree, so on a computer without git on PATH its worktree items do not show. When `keys.json`
binds a command twice, once for macOS (`cmd-d`) and once for Linux and Windows (`ctrl-shift-d`),
the menu shows the one for the platform it runs on. A `secondary-...` binding fits all three.

## License

`main.js` derives from Herdr's `menu` mod, Apache License 2.0 (`LICENSE-APACHE`, see `NOTICE`).
The additions are MIT, see the LICENSE file at the repository root.
