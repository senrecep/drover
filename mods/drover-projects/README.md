# drover-projects

Your machines and the folders you work in, one click from a new space, a tab, an agent,
Git or Files. Works with no space or pane open.

## Open it

- `mod.open drover-projects` (bind a key to `mod.open:drover-projects`), or
- `drover-projects:open` from a key, when the layout has the background block (below), or
- as a tab: `tab.new {mod: "drover-projects"}`.

## What it lists

For the machine picked in the strip at the top (this computer first, then every machine
you connected, each with a dot: green connected, amber connecting, grey away):

- Pinned: projects you pinned (shared key `drover-projects.pins`).
- Recent: folders you worked in, ranked by frecency (recent visits count more), from
  this mod's own samples, seeded by `zoxide query -ls` when zoxide is installed there.
- In your folders: every folder up to two levels below the folders you add in
  Settings that holds `.git`, `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`,
  `*.csproj`, `*.sln`, `pom.xml` and similar. `node_modules`, `vendor`, build output and
  caches are skipped. Results are cached for 10 minutes; Rescan reads them again.

Type to fuzzy search by name or path (several words narrow it down).

On another machine the same lists are built there (`find` and `zoxide` run on that
machine). When it is away or its folders can't be listed, the mod says so and shows
pins and recent visits for it only.

Folders that hold credentials (`.ssh`, `.aws`, `.gnupg`, keychains, `.kube`, `.docker`)
are never listed, scanned or opened.

## Actions

| Action | What it does |
|---|---|
| Open / Go to space | Shows the space already open on that folder, else a new space there |
| New space | Always a new space in that folder, on that machine |
| New space + agent | A new space running your agent command (Settings; default `claude`) |
| Open as tab here | A terminal tab in the shown space (same machine only) |
| Git | `drover-git` as a dialog with `{cwd}`, plus `{on}` for another machine. For a folder on this computer it is off while a space on another machine is shown, because drover-git then follows that space |
| Files | `drover-files` as a tab (or a dialog with no space) with `{folder}`; this computer only |
| Pin / Unpin | Shared pins |
| Reveal in Finder | This computer only. `open -R` on macOS, `xdg-open` on Linux ("Show in file manager"), `explorer.exe` on Windows ("Show in Explorer"; only for a full drive path such as `C:\work`, and off for a folder with a comma, which Explorer would split) |
| Hide from list | Settings can show hidden projects again |

Each action first checks that the folder still exists on that machine. Git and Files are
shown disabled when those mods aren't installed. Enter opens the selected project,
up/down move, Esc closes (or leaves Settings).

## Settings

- Folders to scan, per machine: type `~/projects` or an absolute path, pick one
  with Choose… (this computer), or click a suggestion found on that machine. `/` and
  credential folders are refused.
- Agent: the command and its arguments, split on spaces (no shell), or one of the
  agents installed on that machine. Stored in `drover-projects.agent`.
- Hidden projects: show them again.

## Visits

A sampler looks at the focused terminal's folder every 30 seconds while the window is
active, uses its git top level, skips your home, `/` and credential folders, counts at most
one visit per folder per 30 minutes, and writes `data/drover-projects/visits.json` once a
minute (compare-and-swap, merged with other copies' writes; at most 500 folders, 30 visits
each, 90 days). It runs in the tab copy and in the background block; a dialog only reads.

To sample all the time, add a 0 px block to a row or column of your layout that is
always shown:

```json
{ "id": "drover-projects-bg", "type": "block", "size": { "px": 0 },
  "content": { "mod": "drover-projects", "props": { "role": "background" } } }
```

It also answers `drover-projects:open` (toggles the dialog). A layout switch restarts it;
the data stays in `data/drover-projects/`.

## Requirements

On macOS and Linux everything works. Listing uses `find` and `printenv`, and `zoxide` when
it is there. On Linux, showing a folder needs `xdg-open` (the xdg-utils package); without
it the mod says so.

On Windows, other machines work as usual, since `find` and `zoxide` run there. Folders on
the Windows computer itself are not listed or sampled: the mod reads `/` paths and runs
POSIX tools, so it shows a note there instead of an empty list.

## Files

- `main.js`: the three copies (dialog, tab, background) and drawing.
- `logic.js`: pure logic (visits, frecency, parsing, ranking, actions).
- `lib/`, `icons/`: vendored shared code and Material icons (do not edit; run sync-lib).

## License

MIT. Icons: see NOTICE.
