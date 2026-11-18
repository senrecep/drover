// Pure logic for drover-files: no host calls here, so check.cjs can test it directly.
import { safeJoin, resolve, tilde, basename, parent, isInside } from "./lib/paths.js";
import { denyReason } from "./lib/guard.js";

export const MOD = "drover-files";
export const PER_FOLDER = 500, TOTAL = 5000;
// Names the hide toggle covers (on by default).
export const NOISE = new Set([".git", "node_modules", ".DS_Store"]);
// noise: {value, at} (the hide toggle, all copies); focusFilter: {at, by} (which copy took the key); bump: {n, reveal} after a change; act: {panel, id, abs, at} from a menu copy to its panel.
export const SHARED = { noise: "drover-files.show-noise", bump: "drover-files.bump", act: "drover-files.act", focusFilter: "drover-files.focus-filter" };
// A shared message older than this (persisted from an earlier run) is ignored.
export const STALE_MS = 10000;
export const fresh = (msg, now) => Boolean(msg && typeof msg.at === "number" && now - msg.at >= 0 && now - msg.at < STALE_MS);

// Absolute path of a tree path ("" is the root itself).
export const absOf = (root, rel) => !rel ? root : root === "/" ? `/${rel}` : `${root}/${rel}`;

// A row is locked when it is a credential file or folder, or sits inside one.
export const rowLock = (abs) => denyReason(abs);

// Flattens the loaded tree into visible rows, depth first, folders first.
export function flatten(entries, folders, showNoise, limit = TOTAL) {
  const out = [];
  const walk = (prefix, depth) => {
    if (out.length >= limit || depth > 40) return;
    for (const e of visible(entries.get(prefix) ?? [], showNoise)) {
      if (out.length >= limit) return;
      const rel = prefix ? `${prefix}/${e.name}` : e.name, open = e.dir && folders.has(rel);
      out.push({ rel, name: e.name, dir: e.dir, depth, open });
      if (open) walk(rel, depth + 1);
    }
  };
  walk("", 0);
  return out;
}

// Every loaded path, for filtering before (or instead of) the full index.
export function loadedPaths(entries, showNoise) {
  const out = [];
  for (const [prefix, list] of entries) {
    if (!showNoise && prefix.split("/").some(s => NOISE.has(s))) continue;
    for (const e of visible(list, showNoise)) out.push({ path: prefix ? `${prefix}/${e.name}` : e.name, dir: e.dir });
  }
  return out;
}

// Folders to open so `rel` shows: "a/b/c.txt" -> ["a", "a/b"].
export const ancestors = (rel) => { const s = String(rel || "").split("/").filter(Boolean); return s.slice(0, -1).map((_, i) => s.slice(0, i + 1).join("/")); };

// Moves a selection through rows by delta, clamped.
export function step(rows, current, delta) {
  if (!rows.length) return null;
  const i = rows.findIndex(r => r.rel === current);
  const next = i < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, i + delta));
  return rows[next].rel;
}

// Lists one folder as NUL-separated "kind\0name" pairs. Fixed script, the folder is "$1" only.
export const LIST_SCRIPT = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
// Every path under "$1" for the quick filter, relative, folders with a trailing "/"; prunes .git and node_modules when $2 is 1.
// Works with BSD (macOS) and GNU find. Bounded by depth, line count and the exec timeout.
export const INDEX_SCRIPT = String.raw`cd "$1" || exit 1; if [ "$2" = 1 ]; then set -- \( -name .git -o -name node_modules \) -prune -o; else set --; fi; find . -maxdepth 12 "$@" \( -type d -exec printf "%s/\n" {} + -o -print \) 2>/dev/null | head -n 20001`;
export const INDEX_LIMIT = 20000;

export function parseListing(stdout) {
  const fields = String(stdout || "").split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) if (fields[i + 1]) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export const sortEntries = (entries) => entries.slice().sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
export const visible = (entries, showNoise) => showNoise ? entries : entries.filter(e => !NOISE.has(e.name));

// Where the browser should look. A mod pane (this one, a viewer) has no folder: while it holds focus, keep
// the last terminal's place in the same space instead of jumping to the space folder (that would collapse the tree).
export function pickLocation({ spaces, panes, focused }, prev) {
  const space = spaces.find(s => s.active), f = focused;
  const pane = f?.pane ? panes.find(p => p.pane === f.pane) : null;
  if (pane && pane.terminal === null && prev && prev.space === (space?.id ?? null)) return prev;
  const on = f?.pane === null ? (f?.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, on: on ?? null, space: space?.id ?? null };
}

// "~/x" and "~" against the given home; anything else must already be absolute.
export function expandFolder(folder, home) {
  if (typeof folder !== "string" || !folder.trim()) return null;
  let f = folder.trim();
  if (f === "~" || f.startsWith("~/")) { if (!home) return null; f = home.replace(/\/+$/, "") + f.slice(1); }
  if (!f.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(f)) return null;
  return /^[A-Za-z]:/.test(f) ? f : resolve(f);
}

// A new or renamed entry name: null when fine, else why not.
export function nameProblem(name) {
  if (typeof name !== "string" || !name.trim()) return "Type a name";
  if (name !== name.trim()) return "No spaces at the start or end";
  if (name === "." || name === "..") return "Not a valid name";
  if (/[\/\0]/.test(name)) return "A name can't contain / ";
  if (/[\u0000-\u001f\u007f]/.test(name)) return "No control characters";
  if (name.length > 255) return "Too long";
  return null;
}

// Things the system opener would run rather than show. Folders: app and installer bundles.
const LAUNCH_EXT = new Set(["app", "command", "tool", "terminal", "workflow", "action", "scpt", "scptd", "applescript", "pkg", "mpkg",
  "jar", "sh", "bash", "zsh", "csh", "ksh", "fish", "py", "rb", "pl", "php", "exe", "bat", "cmd", "com", "msi", "ps1", "vbs", "desktop",
  "appimage", "run", "bin", "dmg", "img", "iso", "url", "webloc", "inetloc", "fileloc", "prefpane", "saver", "osax", "kext", "plugin", "bundle", "mobileconfig", "dylib", "so"]);
export function launchRisk(name, { dir = false, executable = false } = {}) {
  const b = basename(name).toLowerCase(), i = b.lastIndexOf("."), ext = i > 0 ? b.slice(i + 1) : "";
  if (LAUNCH_EXT.has(ext)) return dir ? "an app or bundle: opening it runs it" : "a script or launcher: opening it runs it";
  if (!dir && executable) return "an executable: opening it runs it";
  return null;
}

export const rel = (root, abs) => abs === root ? "." : abs.startsWith(root === "/" ? "/" : root + "/") ? abs.slice(root === "/" ? 1 : root.length + 1) : null;
export const displayRoot = (root, home) => root ? tilde(root, home) : "";

// Quick filter: every term (space separated) must appear in the path; basename hits rank first, then shorter paths.
export function filterIndex(paths, query, limit = 300) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { rows: [], total: 0 };
  const hits = [];
  for (const p of paths) {
    const low = p.path.toLowerCase();
    if (!terms.every(t => low.includes(t))) continue;
    const name = low.slice(low.lastIndexOf("/") + 1);
    const score = (terms.every(t => name.includes(t)) ? 0 : 1000) + (name.startsWith(terms[0]) ? 0 : 100) + p.path.length;
    hits.push([score, p]);
  }
  hits.sort((a, b) => a[0] - b[0] || a[1].path.localeCompare(b[1].path));
  return { rows: hits.slice(0, limit).map(h => h[1]), total: hits.length };
}

// find output -> [{path, dir}] (relative, no leading "./"), noise filtered unless shown.
export function parseIndex(stdout, showNoise) {
  const out = [];
  let truncated = false;
  for (const line of String(stdout || "").split("\n")) {
    if (!line || line === "./" || line === ".") continue;
    if (out.length >= INDEX_LIMIT) { truncated = true; break; }
    const dir = line.endsWith("/"), path = line.replace(/^\.\//, "").replace(/\/$/, "");
    if (!path || (!showNoise && path.split("/").some(s => NOISE.has(s)))) continue;
    out.push({ path, dir });
  }
  return { paths: out, truncated };
}

// Why a path may not be opened (viewer or system app), or null. Checked on the path and on what it resolves to.
export const lockReason = (...paths) => { for (const p of paths) { const r = p ? denyReason(p) : null; if (r) return r; } return null; };

// The right-click menu for one entry (or the root when rel is "."): [{id, label, disabled?, why?, danger?}] with null separators.
export function menuItems(t) {
  const { dir, isRoot, locked, remote, platform, canTrash, viewer, fixed, pinned } = t;
  const local = remote ? "only on this computer" : null;
  const sys = platform === "macos" || platform === "linux";
  const items = [];
  const add = (id, label, why, danger) => items.push({ id, label, disabled: Boolean(why), why: why || null, danger: Boolean(danger) });
  if (!dir) add("viewer", viewer ? "Open in viewer" : "Preview here", locked ? `locked: ${locked}` : null);
  // Locked folders and files are never handed to the system opener; launchers get Reveal instead.
  const risk = launchRisk(t.name || "", { dir });
  if (sys) add("system", dir ? "Open in system file manager" : "Open with system app",
    locked ? `locked: ${locked}` : local || (risk ? `${risk} · use ${platform === "macos" ? "Reveal in Finder" : "Show in file manager"}` : null));
  if (sys) add("reveal", platform === "macos" ? "Reveal in Finder" : "Show in file manager", local);
  if (dir && !isRoot && !fixed) add("pin-here", pinned ? "Pin browser here" : "Pin browser here (stop following)", null);
  items.push(null);
  add("copy-path", "Copy path", null);
  add("copy-rel", "Copy relative path", null);
  items.push(null);
  add("new-file", dir ? "New file…" : "New file next to it…", local);
  add("new-folder", dir ? "New folder…" : "New folder next to it…", local);
  if (!isRoot) add("rename", "Rename…", local);
  if (!isRoot && canTrash !== "absent") add("trash", "Move to Trash", local || (canTrash ? null : "trash command not found"), true);
  return items;
}

// Height the popup needs for these items.
export const menuHeight = (items) => 16 + items.reduce((h, it) => h + (it ? 30 : 9), 0) + 26;

export { safeJoin, resolve, tilde, basename, parent, isInside, denyReason };
