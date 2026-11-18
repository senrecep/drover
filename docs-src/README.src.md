# drover

drover is a layout for [Herdr](https://herdr.dev), the terminal app built for running coding agents. It gives the window a sidebar of spaces and agents, a tab bar with a run button, a header on every pane, and a side panel you can switch between files, review, git, ports, pull requests and a few more panels.

The mods behind it also install one at a time. If you like your own layout, add the Git dialog or the port list to it and leave the rest.

The mods run on your machine, and on the machines you connected to Herdr. They call programs you already have, such as git, gh, lsof and sqlite3, and pass their arguments as lists. A shell only runs a fixed script or a command you saved yourself. Anything that deletes, merges, pushes, stops a process or sends one message to several agents waits for a second click.

## Screenshots

The spaces sidebar, and the same sidebar folded down to a rail of icons:

![Spaces sidebar](shots/sidebar.png)

![Folded sidebar rail](shots/sidebar-rail.png)

The Files panel, with a filter box and git marks next to each file:

![Files panel](shots/files.png)

The Panels list behind the buttons at the right of the tab bar, where you pick and pin side panels:

![Panels list](shots/panels.png)

The terminal menu, with new space, keybinds and the themes:

![Terminal menu](shots/terminal-menu.png)

## Install

Paste the line into an agent running inside Herdr. It reads Herdr's own instructions, copies the files into `~/.config/herdr-app`, merging any keys. Your current layout stays as it was.

The whole layout:

<!-- install -->
<!-- /install -->

Single items:

drover-git, a Git dialog for branches, merges, pushes and pull requests. It brings drover-viewer, drover-open and drover-files along.

<!-- install:drover-git -->
<!-- /install -->

drover-viewer, a file viewer and editor pane with an "Open with" chooser and a file tree.

<!-- install:drover-viewer -->
<!-- /install -->

drover-data, a SQLite browser and a TODO.md board for the focused folder.

<!-- install:drover-data -->
<!-- /install -->

drover-ports, every listening TCP port with its process, its Herdr space, and Open and Stop buttons.

<!-- install:drover-ports -->
<!-- /install -->

drover-pulls, the open pull requests of your open spaces, with CI and review state.

<!-- install:drover-pulls -->
<!-- /install -->

drover-worktrees, the git worktrees behind your spaces, with New, Remove and saved run commands.

<!-- install:drover-worktrees -->
<!-- /install -->

drover-review, a narrow panel of changed files with viewed marks and the files your agent touched.

<!-- install:drover-review -->
<!-- /install -->

drover-overview, every agent on every machine by state, plus CPU, memory, GPU and ports per machine.

<!-- install:drover-overview -->
<!-- /install -->

drover-composer, one message sent to a terminal or to several agents at once.

<!-- install:drover-composer -->
<!-- /install -->

drover-dispatch, pick a GitHub issue and get a worktree, a space and two panes for it.

<!-- install:drover-dispatch -->
<!-- /install -->

drover-agents, the setup and token usage of the coding-agent CLIs on this computer.

<!-- install:drover-agents -->
<!-- /install -->

drover-sim, a Simulator panel that shows an iOS Simulator or an Android emulator and passes your taps and typing through to it. It brings drover-sim-screen along.

<!-- install:drover-sim -->
<!-- /install -->

Each folder has a RECIPE.md that describes the item and what it runs.

## Requirements

You need Herdr. The layout is drawn for macOS: it leaves room for the window buttons, and several mods use macOS tools such as `open` and `/usr/bin/trash`. drover-overview also reads Linux machines.

The tools each item calls:

- drover (the layout): git, python3, lsof and ps. gh for pull requests and Dispatch, sqlite3 for the Data panel, xcrun or adb for the Simulator panel. zoxide and ripgrep are used when present.
- drover-git: git. gh or glab to list pull requests; without them a button opens the forge page.
- drover-viewer: nothing beyond Herdr. `file` and ripgrep are used when present.
- drover-data: git, sqlite3, find and realpath.
- drover-ports: lsof and ps.
- drover-pulls: git and gh, logged in.
- drover-worktrees: git. gh adds pull request tags.
- drover-review: git, python3 and stat. The turns section reads Claude Code transcripts.
- drover-overview: on macOS sysctl, vm_stat, ps and lsof; on Linux /proc and ss, and nvidia-smi for a GPU.
- drover-composer: nothing beyond Herdr.
- drover-dispatch: git and gh, logged in.
- drover-agents: python3 and git.
- drover-sim: for iOS, macOS with Xcode (`xcrun simctl`, and `xcrun swiftc` to build the live view helper on first use). For Android, `adb`.

## License

MIT, see [LICENSE](LICENSE). A few mods started as copies of mods that ship with Herdr, which is Apache-2.0. Those folders keep the Apache text in LICENSE-APACHE and say in NOTICE which parts came from where. The icon sets keep their own LICENSE and NOTICE files.

## How this repo is built

The folders here are generated. The mods live in a Herdr config folder, and `node scripts/export.mjs` copies them out:

```sh
node scripts/export.mjs                # reads ~/.config/herdr-app
node scripts/export.mjs --src <dir>    # reads another config folder
```

The script never writes to the config folder. It writes the layout (`layouts/drover.json`, `keys.json`, `mods/`, `themes/`) and one folder per single item, and leaves out local mods that are not part of drover. It copies the text in `docs-src/` into place, where `README.src.md` becomes `README.md` and `RECIPE.src.md` becomes `RECIPE.md`, and fills in the install lines. Last, it removes files it no longer writes and runs `scripts/leak-gate.mjs`, which fails the export when a private name or path slipped in.

So don't edit a generated folder by hand. Change the mod in Herdr, try it there, and export again. The two themes in `themes/` are not copied by the installer; put one in your own themes folder if you want it.
