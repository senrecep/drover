# drover-viewer

A file viewer and editor pane. It previews Markdown, edits text and code, shows images, and opens large
files as a read-only window of lines. Saving is explicit and guarded against changes made elsewhere.

## Open it

The mod has no place of its own (`"place": "none"`). Other mods or key bindings open it with props:

```js
run("pane.split", { direction: "right", mod: "drover-viewer", props: { path: "/abs/file.md", line: 120 } });
run("tab.new", { mod: "drover-viewer", props: { path: "~/notes.txt" } });
```

| prop   | meaning                                                                  |
|--------|--------------------------------------------------------------------------|
| `path` | Absolute path, or one starting with `~/`. `file` is accepted as an alias. |
| `line` | Optional 1-based line. The view opens on the Lines view, centred on it.  |
| `on`   | Optional machine name. The file is read there and opens read-only.      |

## What opens how

| file                                   | view                                                       |
|----------------------------------------|------------------------------------------------------------|
| Markdown (`.md`, `.mdx`, …)            | Preview, with a Source tab (an editor)                     |
| Code                                   | Editor with syntax colours by extension                    |
| `.txt` and other text                  | Editor with soft wrap                                      |
| png, jpg, gif, webp, svg               | Image (svg also has a Source tab)                          |
| Larger than 1 MiB                      | Read-only Lines view, 2,000 lines at a time, Prev/Next, Go to line |
| Binary or not UTF-8                    | An info card with Open in app and Copy path                |
| Credential and key files               | A refusal card. The file is never read.                    |

Credential files are refused before anything reads them, and again after symlinks are resolved. The list
covers `.env*`, `auth.json`, `credentials`, `*.sqlite`, `*.db`, `~/.ssh`, `.aws`, `.netrc`, docker and kube
config, and similar files (see `lib/guard.js`).

When the text holds something that looks like a secret (keys, tokens, passwords), the values are replaced
with `[redacted]`. The file opens read-only, and a banner shows only how many values were hidden.

A file also opens read-only when saving would change it in ways you did not ask for:

- it is on another machine;
- it is larger than 1 MiB;
- its encoding would not survive the round trip;
- the editor would rewrite its line endings.

## Editing and saving

- Unsaved changes. `● Unsaved` shows in the header. Save, and a two-click Revert, appear in the toolbar.
- Saving. Save writes through `writeTextFile` with the text last read as the expected content. Nothing
  is written until you press Save or run `drover-viewer.save`.
- When the file changed on disk. Save is refused and a banner offers three choices:
  - Reload keeps your edits as a draft, then loads the file from disk and offers the draft again.
  - Keep my draft takes the disk version as the new base, so the next Save, labelled
    *Save (replace disk)*, overwrites it. It refuses when the disk now holds secrets or binary data.
  - Show diff shows a line diff from disk to your draft, with secrets redacted.
- Drafts. While you edit, a draft is saved every 1.5 s to
  `<app home>/data/drover-viewer/drafts/<hash>.json`. The draft is removed after a save or a revert. When you
  reopen the file, the draft is offered (Restore / Discard), and marked when the file changed since.

## Links in Markdown

- Web links (http/https) open in the system browser. If the `drover-open` mod is installed and the
  shared key `drover-viewer.links` is `"chooser"`, its chooser opens instead. The Links: toolbar button
  switches between the two.
- Relative and `file://` links open in this pane, resolved from the file's folder. `#L12` jumps to line 12,
  and ← (or `drover-viewer.back`) returns to the previous file. While there are unsaved edits, the link
  opens in a new pane to the right instead.
- Other links (mailto, javascript, anchors) are ignored. Links to credential files are refused.

## Commands

The commands go to every shown viewer. Only the focused viewer acts; when no viewer has focus, the one
used last acts.

| command                 | action                                        |
|-------------------------|-----------------------------------------------|
| `drover-viewer.save`    | Save                                          |
| `drover-viewer.toggle`  | Next view (Preview or Source, Editor or Lines)  |
| `drover-viewer.revert`  | Revert (press twice within 4 s)               |
| `drover-viewer.reload`  | Reload (unsaved edits are kept as a draft)    |
| `drover-viewer.back`    | Back to the previous file after a link        |

Suggested bindings in `keys.json`:

```json
"mod:drover-viewer": {
  "cmd-s": "drover-viewer.save",
  "cmd-e": "drover-viewer.toggle",
  "cmd-r": "drover-viewer.reload",
  "cmd-[": "drover-viewer.back"
}
```

## Limits

- Images. Images are copied to `data/drover-viewer/cache/` before display, because the image element only
  loads files under the app home. Images on other machines and images over 20 MiB get an info card. A file whose extension says
  image but whose content is not one (checked with `file --mime-type` where that tool exists) gets the binary card. SVGs are
  rasterised, so Fit to pane can look soft.
- Remote files. Files on another machine are read-only, because `writeTextFile` has no machine option.
- Line jumps in the editor. The editor has no scroll API, so a line jump uses the Lines view.

## License

MIT, see the LICENSE file at the repository root. The icons are from Material Icon Theme (MIT), see `NOTICE`.
