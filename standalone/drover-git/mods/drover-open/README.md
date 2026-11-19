# drover-open

"Open with" for herdr-app: hand it a link, a path or some text and pick what to do with it.

| The text is | You can |
|---|---|
| an `http`/`https` link | Open in browser · Copy link |
| a file (absolute, `~/…`, or relative to the pane's folder; `:line[:col]` kept) | Open in viewer (beside the pane) · Open in new tab · Reveal in files · Open with system app · Copy path |
| a folder | Open in files · Open in new tab · Open with system app · Copy path |
| a path that is not there | Search in files (for its name) · Copy path |
| anything else | Search in files · Copy text (and Open in browser when a link is inside) |

Recognized locations: `src/a.js:12`, `src/a.js:12:5`, grep's `src/a.js:12:5:`,
`Foo.cs(10,5)`, `x.py#L7`, Python's `File "x.py", line 3`, `file:///…`, git diff's `a/…` and `b/…`.
Quotes, brackets and trailing punctuation around a selection are dropped.

## Use

- From the clipboard: bind a key to `mod.open:drover-open`. With no target the chooser reads the
  clipboard. While it is open, a key bound to `drover-open.clipboard` reads the clipboard again.
- From the terminal menu: `drover-terminal-menu` adds "Open selection…", which opens this chooser
  with the selected text and the pane it came from.
- From another mod:
  ```js
  openOverlay({ mod: "drover-open", kind: "popup", at: "pointer", width: 380, height: 340,
    props: { target, cwd, on, pane } });
  ```
  `cwd` resolves relative paths, `on` is the machine (a space's `machine`), `pane` is where the
  viewer opens beside. `ask: true` always shows the chooser.
- Open in an editor (macOS and Linux): local folders and files also get one "Open in <Editor>" row per
  installed editor, rechecked every 10 minutes. On macOS that is VS Code, Cursor, Zed, Windsurf, Sublime
  Text, Nova, BBEdit, JetBrains IDEs, Android Studio, Xcode, Fleet and VSCodium, found in the system or
  home Applications folder, and the run is `open -a <App> <path>`. On Linux it is the editors whose
  launcher one `which` call finds on PATH (`code`, `cursor`, `zed` or `zeditor`, `windsurf`, `subl`,
  `codium`), and the run is `<launcher> <path>`. No shell either way.
  `mode: "editors"` shows only those rows and the system app, titled "Open in". The choice is kept in
  the shared key `drover-open.editor`. Remote targets show the rows disabled ("this machine only") and
  run nothing.

Keys: ↑/↓ move, Enter runs, 1 to 9 run that row, A toggles "always", Esc closes.

## Remembered choices

The last choice per kind (links, files, folders, text) is preselected next time. Tick
Always do this and a target handed in by a caller (the terminal menu) runs that choice without
asking, with a short notification. The clipboard opener always shows the chooser, so "always" can be
unticked there; Forget choices clears everything. Choices live in
`<app home>/data/drover-open/prefs.json` and are written only when you pick something.

## Safety

- Links open through the app (`open_url`), and only `http`/`https` ones. The chooser shows a link
  without its user, password, query string or fragment; secrets in shown text are masked.
- Credential files and folders (`.env*`, keys, `.ssh`, `.aws`, keychains, `*.sqlite`, `*.db`, …) are
  never opened, also when a harmless name links to one. They can still be revealed or copied.
- Paths are looked up with a fixed `sh` script that receives the path as an argument; the system app
  is started with an argument list (`open` on macOS, `xdg-open` on Linux, `explorer.exe` on Windows).
  "Open with system app" works on this machine only. Scripts, apps and other launchers get "Reveal in
  Finder" ("Show in file manager" on Linux, "Show in Explorer" on Windows) instead; on Windows that
  also covers `.lnk`, `.js`, `.hta`, `.reg` and the other files Explorer would run.
- "Search in files" runs `rg --fixed-strings` (or `grep -F` when ripgrep is missing) in the pane's
  folder with credential files excluded, at most 5 hits per file and 200 in all.

## Needs

`drover-viewer` (props `{ file, line?, col?, on? }`) and `drover-files` (props `{ folder, reveal?, on? }`)
for the viewer and files actions; those prop names are the contract this mod assumes. Without those
mods installed, the viewer, new tab and files actions do not show the target.
`sh` on the target machine; `rg` is optional. On Linux, `xdg-open` (xdg-utils) for the system app and
the file manager.

## Platforms

macOS has everything above. Linux has everything too, with editors found by their launcher on PATH.
JetBrains IDEs, Fleet, Nova, BBEdit, Xcode and Android Studio have no Linux row.

Windows works with some limits:

- No editor rows. The editor launchers there are `.cmd` files, which would hand the path to `cmd.exe`.
- Paths on this computer are drive paths such as `C:\work\a.txt` or `C:/work/a.txt`, with an
  optional `:line` or `:line:col`. A relative path is read against the pane's folder only when that
  folder is a drive path; otherwise the chooser says "Relative path, but no folder is known". Network
  paths (`\\server\share`), device paths (`\\?\C:\`) and a bare `C:` are not read, and neither is a
  path Windows would read another way, such as one with a stream (`a.txt:s`) or a short `~1` name.
- `~` and `~/...` are not read yet, because the home folder there is a drive path. Write the full path.
- Checking a path needs `sh`: install Git for Windows and put its `usr\bin` on PATH. Without it the
  chooser says so.
- Open with system app and Show in Explorer take only a full drive path such as `C:\work\a.txt`.
  Before an open, every part of the path is trimmed the way Windows reads it, credential files are
  refused, and PowerShell checks that no folder on the path is a symbolic link or junction.
- Explorer splits its arguments at commas, so Open with system app and Show in Explorer refuse a
  path with a comma. Copy the path instead.
- Search in files needs `rg` or `grep` on PATH.

## License

MIT, see the LICENSE file at the repository root. Third-party icons are listed in `NOTICE`.
