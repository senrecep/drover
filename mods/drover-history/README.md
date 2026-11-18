# drover-history

A "History" panel for the drover layout. It lists past agent sessions (Claude Code, Codex and Pi),
lets you search their text, and resumes one in a new tab.

## Use

- Open it from the panel tabs (Agents → History) or with `cmd-alt-y`.
- This space | All: "This space" lists the sessions started in the space's folder or below it,
  and in the folders its panes are in now (a pane in the home folder or in `/` adds only sessions
  started right there, not everything below it). "All" lists every session on this computer. The
  choice is kept in the shared key `drover-history.scope`.
- Agent chips: they show up when sessions from more than one agent are listed.
- Search (250 ms after you stop typing): words are ANDed and the last word matches as a prefix.
  Words shorter than 2 letters are dropped. If no word is left, the recent list stays, with a hint.
  Ğ, ü, ş, ö and ç match with or without their accents. Dotless ı is its own letter, so type it as
  you wrote it.
- Resume: click a row, or select it with ↑/↓ and press Enter. A new tab opens in the active space
  (or, when that space is on another machine, in a local space that holds the session's folder). It
  starts in the session's folder and runs one of these:

  | Agent | Command |
  |---|---|
  | Claude Code | `claude --resume <id>` (only from the session's own folder; resume is turned off if that folder is gone) |
  | Codex | `codex resume <id>` |
  | Pi | `pi --session <transcript path>` (a bare id is looked up only among the current folder's sessions) |

- Hover a row (or select it) to show Copy session id. Esc clears the search.

## Index

`indexer.py` uses only the standard library and is run as `python3 -I -B indexer.py …` with an argument
list (no shell). It reads these files and never writes to them:

- `~/.claude/projects/*/*.jsonl`. Subagent transcripts (in their own folders, or marked `isSidechain`)
  are skipped.
- `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Non-interactive `codex exec` runs and sessions
  started by another tool are skipped.
- `~/.pi/agent/sessions/*/*.jsonl`. Helper files in deeper folders are skipped.

A missing source is skipped.

The index is `<appHome>/data/drover-history/index.db`: SQLite FTS5 with the `unicode61` tokenizer
and diacritics removed. Nothing is written anywhere else.

- What is indexed: only the text that you and the agent wrote. Tool calls and their output,
  thinking, system reminders, slash-command wrappers and harness notices are left out.
- Caps: 4,000 characters per message and 200,000 per session (the newest messages are kept).
  Titles are capped at 120 characters.
- Title: the session's own name (Claude's custom title or summary, Pi's session name). If there
  is none, the first real prompt is used.
- Secrets are redacted before anything is written. This covers API keys and tokens (`sk-`, `ghp_`,
  `github_pat_`, `glpat-`, `xox?-`, AWS, Google, npm, JWT), bearer/basic values, URL passwords and
  secret-looking query values, `NAME=value` pairs whose name looks secret, and PEM private keys.
  `lib/history.js` runs the same rules again when it draws titles and snippets.
- Incremental: a file whose size and mtime haven't changed is skipped. A changed file is read
  again. Rows for deleted files are dropped. A file lock keeps runs from overlapping. Each run has a
  time budget (8 s), so the first index of a large history is built over several runs.

The panel only runs the indexer while History is the panel you're looking at and the window is
active, at low priority (`nice -n 10`). Runs are 1.5 s apart while the first index is being built,
then one minute apart.

### Commands (JSON on stdout; an error is `{"error": "…"}` with exit 1)

```
indexer.py update --home <appHome> [--budget 8]
indexer.py list   --home <appHome> [--cwd <dir>]... [--at <dir>]... [--limit 100] [--agent claude|codex|pi]
indexer.py search --home <appHome> --query=<text> [--cwd <dir>]... [--at <dir>]... [--limit 100] [--agent …]
```

`--query=<text>` is passed as one word, so a query that starts with `-` is not read as an option.
`--cwd` keeps sessions in that folder or below it; `--at` keeps those started in exactly that folder.

## Platforms

- macOS and Linux: everything above. It needs `python3` and `nice` on PATH.
- Windows: no `nice`. The panel runs `py -3`, or `python` if there is no py launcher (the
  Microsoft Store stub that only offers to install Python counts as missing), with `-X utf8` so
  titles with non-ASCII letters come through on any code page. "All" works and the
  index lock uses `msvcrt` instead of `fcntl`. "This space" does not work there: folders are
  matched as `/` paths, so the panel says so and offers Show all.

