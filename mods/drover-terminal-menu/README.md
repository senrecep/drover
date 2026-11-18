# drover-terminal-menu

Herdr's terminal right-click menu with one more item: Open selection….

It is a copy of the shipped `menu` mod (made with `mod.clone`), so every item the shipped menu
shows is still there. In the pane menu, "Open selection…" comes first:

1. it focuses the clicked terminal and runs `terminal.copy`,
2. reads the copied text and puts the clipboard back the way it was,
3. opens [`drover-open`](../drover-open) at the pointer with that text, the terminal's folder,
   its pane and its machine, so relative paths and `file:line` locations resolve.

With nothing selected the menu stays open and says "Select some text in the terminal first".

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

## Platforms

The menus work the same on macOS, Linux and Windows. The space menu asks `git` whether a space is a
worktree, so on a computer without git on PATH its worktree items do not show. When `keys.json`
binds a command twice, once for macOS (`cmd-d`) and once for Linux and Windows (`ctrl-shift-d`),
the menu shows the one for the platform it runs on. A `secondary-...` binding fits all three.

## License

`main.js` derives from Herdr's `menu` mod, Apache License 2.0 (`LICENSE-APACHE`, see `NOTICE`).
The additions are MIT, see the LICENSE file at the repository root.
