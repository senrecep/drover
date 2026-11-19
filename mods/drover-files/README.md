# drover-files

A file browser panel for herdr-app. It follows the focused terminal or agent folder, or shows a
fixed folder, and opens files in drover-viewer.

## What it does

- Follows the focused pane's folder. While focus sits on a mod pane (a viewer, this panel), it
  keeps the last terminal's folder instead of jumping away. The pin button (or the
  `toggle-follow` command) stops following; "Pin browser here" on a folder's menu pins that folder.
- `props.folder` shows a fixed folder: an absolute path or `~/…`. Anything else shows an error
  instead of following.
- Click a folder to expand it. Click a file to open it in `drover-viewer` beside the panel
  (`pane.split` right, props `{path, file}`). Clicking it again focuses the same viewer pane while it
  is open. Without drover-viewer installed, a read-only inline preview opens, with secrets masked.
- A single click on a file opens it in a preview viewer pane, and the next single click reuses that pane
  for its file. A double click, or the Keep open button in the viewer, pins the pane. Enter, Open in
  viewer on the menu, and Cmd-click (Ctrl-click on Linux and Windows) open a separate pinned viewer.
  A viewer with unsaved edits is never replaced; a new pane opens instead.
- Right-click a row (or empty space for the root): Open in viewer, Open with system app,
  Reveal in Finder (Show in file manager on Linux, Show in Explorer on Windows), Copy path,
  Copy relative path, New file, New folder, Rename, Move to Trash.
  - Rename onto an existing file asks for a second click on Replace; a folder is never replaced.
  - Move to Trash takes two clicks. See Requirements for the command each system uses.
  - Open with system app refuses scripts, app bundles and executables (they would run); use Reveal.
    On Windows it also refuses shortcuts, installers and script files such as `.lnk`, `.js`, `.hta`,
    `.reg`, `.msix`, `.chm` and `.search-ms`.
- Hide toggle (eye button, `toggle-hidden`) hides `.git`, `node_modules` and `.DS_Store`
  in every copy. Hidden by default.
- Git-ignored files and folders show their name in the muted color (icons keep their colors).
  One `git check-ignore` per listed folder, refreshed with the listing; nothing runs inside an
  ignored folder, and no git or no repository simply means nothing is dimmed.
- Quick filter: type to filter the whole folder (space-separated terms, file names first).
  Enter opens the first match; Escape clears it.
- Credential files (`.env*`, keys, `.ssh`, `.aws`, `.netrc`, `*.sqlite`, auth and token
  files, and links pointing to them) show a lock icon and never open.
- Keyboard: Up/Down select, Enter opens, Right/Left expand/collapse, Escape clears the filter.

## Commands

Bind these in `keys.json` under the mod's section: `focus-filter`, `toggle-follow`,
`toggle-hidden`, `refresh`.

## Requirements

macOS needs nothing extra. Move to Trash uses macOS's own `/usr/bin/trash` (macOS 15 and later),
which moves the item into the Finder Trash. Where that command is missing, the item is not shown.

Linux opens and shows files with `xdg-open` from xdg-utils. Move to Trash uses `gio trash`
(glib), or `trash-put` from trash-cli when gio is not installed. With neither, the menu item is
shown greyed out and says what to install. Show in file manager opens the containing folder; it
does not select the file.

Windows uses only what ships with it. Open and Show in Explorer run `explorer.exe`, Move to Trash
sends the item to the Recycle Bin through PowerShell, and New folder, Rename and the existence
checks run small fixed PowerShell commands with the path passed as a quoted literal. Some limits:

- The quick filter searches only the folders already loaded unless `sh` and `find` from Git for
  Windows are on PATH. The panel says so when they are not.
- Windows drops trailing dots and spaces from a name, so the credential check does too (`.ssh.\id_rsa`
  counts as `.ssh\id_rsa`). A path with a file stream (`name:stream`) or a short 8.3 name (`PROGRA~1`) is
  locked; use the full name.
- There is no realpath, so before opening a file PowerShell checks every folder on its path. A path that
  goes through a symbolic link or junction is not opened, and neither is one the check couldn't finish on.
  Only a full drive path such as `C:\work\notes.txt` opens or is shown in Explorer; any other form is
  refused. A terminal whose folder is in any other form, a network share included, shows no folder.
- Changing only the letter case of a folder name fails with the system's error. Files work.
- File actions are slower than on macOS and Linux, since each check starts PowerShell.
- Move to Trash works only when Windows would really keep the item. On a network share, a USB stick
  or other removable drive, on a drive whose Recycle Bin is set to delete files at once, or for an
  item at least as big as that drive's Recycle Bin, Windows would delete it for good. So the item
  is left alone and the menu says "Can't move to the Recycle Bin on this drive". The same happens
  when the Recycle Bin settings can't be read. Counting a large folder takes a moment.
- Names with `\ : * ? " < > |`, names Windows keeps for itself (`con`, `prn`, `aux`, `nul`,
  `com0` to `com9`, `lpt0` to `lpt9`, with or without an extension) and names ending with a dot or
  space are refused.
- Explorer splits its arguments at commas, so Open and Show in Explorer refuse a path with a comma.
  Copy the path instead.
- Network folders (`\\server\share`) are not shown.

## Safety

Every command runs as an argument array; the two shell scripts are fixed text with the folder
passed as `$1`. The Windows PowerShell commands are fixed text too, with the path added as a
single-quoted literal. Nothing is written except by New file, New folder, Rename and Move to Trash, each
from an explicit click. Remote folders (`on` a machine) are browse and view only.

## License

MIT for the new code; see NOTICE for the derived and third-party parts.
