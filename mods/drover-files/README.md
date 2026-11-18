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
- Right-click a row (or empty space for the root): Open in viewer, Open with system app,
  Reveal in Finder, Copy path, Copy relative path, New file, New folder, Rename, Move to Trash.
  - Rename onto an existing file asks for a second click on Replace; a folder is never replaced.
  - Move to Trash takes two clicks and uses macOS's own `/usr/bin/trash` (macOS 15 and later),
    which moves the item into the Finder Trash. Where that command is missing, the item is not shown.
  - Open with system app refuses scripts, app bundles and executables (they would run); use Reveal.
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

## Safety

Every command runs as an argument array; the two shell scripts are fixed text with the folder
passed as `$1`. Nothing is written except by New file, New folder, Rename and Move to Trash, each
from an explicit click. Remote folders (`on` a machine) are browse and view only.

## License

MIT for the new code; see NOTICE for the derived and third-party parts.
