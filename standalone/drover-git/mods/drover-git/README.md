# drover-git

A Git branch browser for herdr-app. It opens as a 1100×720 dialog (`mod.open` with
`{ "name": "drover-git" }`) or as a page in a tab (`tab.new` with `mod: "drover-git"`).

## Which repository

`props.cwd` when given, else the focused pane's folder, else the folder of the focused agent's pane,
else the active space's folder. Without `props.cwd` it follows focus every few seconds while the
window is active. A folder that is not inside a repository shows that plainly.

## What it shows

- Current branch with its upstream, ahead/behind and uncommitted counts.
- Default branch: the remote's HEAD, else `origin/main` or `origin/master`, else a local
  `main`/`master`/`develop`, else `init.defaultBranch`, else the first branch. The source is shown.
- Recent branches from the reflog, All local, Remote (with a filter box; type words in
  any order) and Worktrees.
- A branch's detail: last commit, ahead/behind against the current branch, which worktree has it
  checked out, and links to the branch, compare and pull request pages on GitHub, GitLab or
  Bitbucket.
- Pull requests tab: GitHub through `gh pr list`, GitLab through `glab mr list`, Bitbucket
  through an optional helper (below). Without the tool, a button opens the forge's list in the browser.

## Actions

| Action | What runs | Confirm |
|---|---|---|
| Switch | `git switch -- <b>`; a remote-only branch uses `git switch --track <remote>/<b>` | second click when the tree is dirty |
| Fetch | `git fetch --prune <remote>` (30 s, no prompts) | none |
| Pull | fetch, then `git merge --ff-only @{upstream}` | none |
| Merge | `git merge --ff-only` or `git merge --no-ff --no-edit`, with the incoming commit count first | two clicks |
| Push | `git push`, or `git push -u <remote> <b>` with no upstream; warns on the default branch | two clicks |
| New branch | `git switch -c <name> <base>` from the current or the selected branch | none |
| Abort merge | `git merge --abort` | two clicks |
| Auto-merge (GitHub) | `gh pr merge <n> --auto --<method>` after a fresh `gh pr view` check | two clicks |

Before every write the repository is read again and the action is re-checked. Writes are blocked
while a merge, rebase, cherry-pick or revert is in progress, while there are conflicts, on a
detached HEAD, when an agent in this repository is working, and for the cases each action needs
(merge needs a clean tree, push needs to not be behind, and so on). A read older than 10 s is
refreshed first.

Conflicts. When a merge stops, the dialog lists the conflicted files. Each one opens in
drover-viewer when it is installed, else with the system app. Ask agent shows the exact prompt
first; only a second click sends it to the focused agent (or the one agent working in this
repository). It goes out as `hc send -- <agent> <prompt>`, so the prompt is always passed as
text, even when it starts with a dash. Copy prompt puts it on the clipboard instead.

## Settings

Optional, in `<herdr-app home>/data/drover-git/settings.json`:

```json
{
  "forgeHosts": { "git.example.com": "gitlab", "bitbucket.example.com": "bitbucket" },
  "bitbucketHelper": ["my-bb-tool", "prs", "{workspace}", "{repo}", "--host", "{host}"],
  "fetchPrune": false
}
```

- `fetchPrune` (default `false`): when `true`, Fetch runs `git fetch --prune`, which removes
  remote-tracking branches deleted upstream. Off by default, so Fetch never deletes refs.
- `forgeHosts` marks self-hosted hosts as `github`, `gitlab` or `bitbucket`.
- `bitbucketHelper` is an argv (no shell). `{workspace}`, `{repo}` and `{host}` are replaced.
  It must print a JSON array of `{ id, title, author, source, target, state, url }` within 15 s.
  It gets no tokens from this mod; its own login is its business.

## Safety

- Every program runs as an argument array through one wrapper (`git.js`) that refuses forbidden
  argv before anything starts: `--force` and its variants, `-f`/`-D` clusters, `+` and `:`
  refspecs, `--delete`, `--mirror`, `--no-verify`, `--admin`, `reset`, `clean`, `worktree remove`,
  any git subcommand outside a short list, and any gh/glab call other than listing, viewing and
  `pr merge --auto`.
- Network calls run with `GIT_TERMINAL_PROMPT=0`; a call that would ask for a password fails
  with a short message. Auth stays with git credential helpers, `gh` and `glab`.
- Error text has URL userinfo stripped and secrets masked. Arguments and environment are never shown.
- Links open through the app's URL opener (http/https only). Credential files (`.env*`, keys,
  `.ssh`, `.netrc`, and so on) are never opened.
- Nothing is sent to a terminal or agent without a click, and the mod writes no files.

## Platforms

- macOS: everything works. Opening a file without the viewer mod uses `open`.
- Linux: everything works. Opening a file without the viewer mod uses `xdg-open`, and when that is
  missing the view says to install xdg-utils.
- Windows: opening a file without the viewer mod uses `explorer.exe` with a drive-letter path, and
  its exit code is ignored because it is 1 even when the file opened. Scripts, shortcuts, installers
  and other files Explorer would run (`.exe`, `.js`, `.lnk`, `.msix`, `.search-ms` and others), and
  paths with a comma (Explorer splits its arguments at commas), are not opened; the view offers Copy
  path instead. Before opening, PowerShell checks every folder on the path, and a path that goes
  through a symbolic link or junction, or one the check couldn't finish on, is not opened either.
  Only a full drive path such as `C:\work\notes.txt` opens; any other form is refused.
  Trailing dots and spaces in a name are dropped before the credential check, as Windows does, and a
  path with a file stream (`name:stream`) or a short 8.3 name (`PROGRA~1`) is refused. Fetch, pull and push run git
  through `env` to turn off password prompts, so they need `env` on PATH: Git for Windows has it in
  its `usr\bin` folder, which a default install does not put on PATH. Without it those actions
  fail with "Could not run git". Repositories on another machine run the same commands there.

Web links always open through the app's URL opener, on every system.

