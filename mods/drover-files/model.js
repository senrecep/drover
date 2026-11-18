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
// A root already ending in "/" ("/" or a drive root "C:/") gets no second one.
export const absOf = (root, rel) => !rel ? root : root.endsWith("/") ? `${root}${rel}` : `${root}/${rel}`;

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

// A network path (\\server\share or //server/share) as a root on this Windows computer: refused,
// as drover-viewer does. The path helpers would fold "//server" into "/server", a different place.
export const NETWORK_ROOT = "Network folders (\\\\server\\share) are not shown here";
export const networkRoot = (p, platform, on) => !on && platform === "windows" && /^[\\/]{2}/.test(String(p ?? ""));

// "~/x" and "~" against the given home; anything else must already be absolute.
export function expandFolder(folder, home, platform) {
  if (typeof folder !== "string" || !folder.trim()) return null;
  let f = folder.trim();
  if (networkRoot(f, platform, null)) return null;
  if (f === "~" || f.startsWith("~/")) { if (!home) return null; f = home.replace(/\/+$/, "") + f.slice(1); }
  if (!f.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(f)) return null;
  return /^[A-Za-z]:/.test(f) ? f : resolve(f);
}

// A new or renamed entry name: null when fine, else why not.
export function nameProblem(name, platform) {
  if (typeof name !== "string" || !name.trim()) return "Type a name";
  if (name !== name.trim()) return "No spaces at the start or end";
  if (name === "." || name === "..") return "Not a valid name";
  if (/[\/\0]/.test(name)) return "A name can't contain / ";
  if (/[\u0000-\u001f\u007f]/.test(name)) return "No control characters";
  if (platform === "windows" && /[\\:*?"<>|]/.test(name)) return "A name can't contain \\ : * ? \" < > |";
  if (platform === "windows" && /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(name)) return "Windows keeps this name for itself";
  if (platform === "windows" && /[. ]$/.test(name)) return "A name can't end with a dot or space";
  if (name.length > 255) return "Too long";
  return null;
}

// Launch lists, kept byte-identical in drover-files, drover-viewer, drover-open, drover-git and drover-agents.
// LAUNCH_EXT: what the system opener runs rather than shows. Folders: app and installer bundles.
const LAUNCH_EXT = new Set(["app", "command", "tool", "terminal", "workflow", "action", "scpt", "scptd", "applescript", "pkg", "mpkg",
  "dmg", "img", "iso", "jar", "sh", "bash", "zsh", "csh", "ksh", "fish", "py", "rb", "pl", "php", "exe", "bat", "cmd", "com", "msi", "ps1", "vbs",
  "desktop", "appimage", "run", "bin", "url", "webloc", "inetloc", "fileloc", "prefpane", "saver", "osax", "kext", "plugin", "bundle",
  "mobileconfig", "dylib", "so"]);
// WINDOWS_LAUNCH_EXT: what explorer.exe runs too. Only on Windows: elsewhere .js and the rest open in an app.
const WINDOWS_LAUNCH_EXT = new Set(["lnk", "scr", "hta", "js", "jse", "vbe", "wsf", "wsh", "reg", "cpl", "msc", "msp", "pif", "psm1", "psc1",
  "application", "appref-ms", "gadget", "inf", "settingcontent-ms", "library-ms", "diagcab", "scf", "rdp", "iqy", "slk", "ade", "adp",
  "msix", "msixbundle", "appx", "appxbundle", "appinstaller", "msu", "pyw", "pyz", "pyzw",
  "chm", "ws", "wsc", "sct", "xll", "vhd", "vhdx", "search-ms", "searchconnector-ms", "website",
  "jnlp", "theme", "themepack", "mht", "xbap"]);
// Would explorer.exe run this path? The name after the last / or \, with the trailing dots and spaces
// Windows drops ("a.exe." runs a.exe). A name that is only an extension (".js") counts. A ":" means an
// NTFS stream ("a.exe:s", "a.lnk::$DATA"), which is refused too.
function windowsRuns(p) {
  const b = String(p ?? "").split(/[\\/]/).pop().toLowerCase().replace(/[. ]+$/, ""), i = b.lastIndexOf(".");
  return b.includes(":") || (i >= 0 && (LAUNCH_EXT.has(b.slice(i + 1)) || WINDOWS_LAUNCH_EXT.has(b.slice(i + 1))));
}
export function launchRisk(name, { dir = false, executable = false, platform } = {}) {
  const b = basename(name).toLowerCase(), i = b.lastIndexOf("."), ext = i > 0 ? b.slice(i + 1) : "";
  if (LAUNCH_EXT.has(ext)) return dir ? "an app or bundle: opening it runs it" : "a script or launcher: opening it runs it";
  if (!dir && platform === "windows" && windowsRuns(name)) return "a script or launcher: opening it runs it";
  if (!dir && executable) return "an executable: opening it runs it";
  return null;
}

// ---------- per-platform commands (pure; platform is "macos" | "linux" | "windows") ----------
export const revealLabel = (platform) => platform === "macos" ? "Reveal in Finder" : platform === "windows" ? "Show in Explorer" : "Show in file manager";
// lib/paths.js turns "\" into "/"; Windows tools get the native form back. A drive root stays "C:\", never "C:"
// (that means the current folder on drive C).
export const winPath = (p) => String(p).replace(/\//g, "\\").replace(/^([A-Za-z]:)$/, "$1\\");
// explorer.exe splits its arguments at commas, so such a path would open something else.
export const COMMA_PATH = "Explorer can't open paths with a comma. Copy the path instead.";
export const explorerProblem = (platform, p) => (platform === "windows" && String(p ?? "").includes(",") ? COMMA_PATH : null);
// A PowerShell single-quoted literal: ' and its curly forms are doubled (as in the folder listing).
export const psQuote = (s) => "'" + String(s).replace(/['‘’‚‛]/g, "$&$&") + "'";
const ps = (script) => ["powershell", ["-NoProfile", "-NonInteractive", "-Command", script]];
// [cmd, args] for the default app. explorer.exe exits 1 even when it worked: callers ignore its code.
export function openArgv(platform, p) {
  if (platform === "macos") return ["open", ["--", p]];
  if (platform === "windows") return ["explorer.exe", [winPath(p)]];
  return ["xdg-open", [p]];
}
// [cmd, args] that shows p in the file manager: selected on macOS and Windows, its folder on Linux.
export function revealArgv(platform, p, dir) {
  if (platform === "macos") return ["open", ["-R", "--", p]];
  if (platform === "windows") return ["explorer.exe", dir ? [winPath(p)] : ["/select,", winPath(p)]];
  return ["xdg-open", [dir ? p : parent(p)]];
}
// Trash commands to try in order; the next one only when the previous program is not installed.
export function trashArgvs(platform, p) {
  if (platform === "macos") return [["/usr/bin/trash", ["-s", p]]];
  if (platform === "windows") return [ps(WIN_RECYCLE + " " + psQuote(winPath(p)))];
  return [["gio", ["trash", "--", p]], ["trash-put", ["--", p]]];
}
export const TRASH_MISSING = "Install gio (glib) or trash-cli to move things to the Trash";
// Windows deletes for good, without asking, whatever SHFileOperation can't put in the Recycle Bin: anything on
// a network or removable drive, anything on a volume whose bin is set to delete at once (NukeOnDelete), and an
// item at least as big as the bin (MaxCapacity, in MB). FOF_WANTNUKEWARNING would ask first, but its dialog
// would hang the hidden PowerShell. So the script checks first and goes on only for a fixed drive whose bin
// settings it can read (the volume's key under BitBucket\Volume, else the BitBucket defaults), with
// NukeOnDelete 0 and the item (all files in a folder) smaller than MaxCapacity. Anything else, including any
// error while checking, prints NO_RECYCLE_MARK and exits 3 before anything is deleted.
// The delete itself: SHFileOperationW with FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI, so
// no dialog opens and a failure comes back as a code. SHFILEOPSTRUCT is packed to 1 byte in 32-bit Windows
// and to 8 in 64-bit, so there is one struct for each. The path is the only parameter.
export const NO_RECYCLE = "Can't move to the Recycle Bin on this drive";
export const NO_RECYCLE_MARK = "drover-files:no-recycle";
const OP_FIELDS = "{ public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags; public bool fAnyOperationsAborted; public IntPtr hNameMappings; public string lpszProgressTitle; } ";
const RECYCLE_CS = "using System; using System.Text; using System.Runtime.InteropServices; public static class DroverRecycle { "
  + "[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode, Pack = 1)] struct Op32 " + OP_FIELDS
  + "[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode, Pack = 8)] struct Op64 " + OP_FIELDS
  + "[DllImport(\"shell32.dll\", CharSet = CharSet.Unicode, EntryPoint = \"SHFileOperationW\")] static extern int Run32(ref Op32 op); "
  + "[DllImport(\"shell32.dll\", CharSet = CharSet.Unicode, EntryPoint = \"SHFileOperationW\")] static extern int Run64(ref Op64 op); "
  + "[DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode, EntryPoint = \"GetVolumeNameForVolumeMountPointW\")] static extern bool VolumeName(string root, StringBuilder name, int size); "
  + "public static string VolumeGuid(string root) { StringBuilder b = new StringBuilder(64); if (!VolumeName(root, b, 64)) return null; string s = b.ToString(); int i = s.IndexOf(\"{\"), j = s.IndexOf(\"}\"); return i >= 0 && j > i ? s.Substring(i, j - i + 1) : null; } "
  + "public static int Recycle(string p) { string from = p + \"\\0\\0\"; ushort flags = 0x0454; "
  + "if (IntPtr.Size == 4) { Op32 a = new Op32(); a.wFunc = 3; a.pFrom = from; a.fFlags = flags; int r = Run32(ref a); return r != 0 ? r : a.fAnyOperationsAborted ? -1 : 0; } "
  + "Op64 o = new Op64(); o.wFunc = 3; o.pFrom = from; o.fFlags = flags; int q = Run64(ref o); return q != 0 ? q : o.fAnyOperationsAborted ? -1 : 0; } }";
const WIN_RECYCLE = "$ErrorActionPreference = 'Stop'; & { param($p) "
  + "$ok = $false; try { if (-not $p.StartsWith('\\\\')) { $root = [IO.Path]::GetPathRoot($p); "
  + "if ([IO.DriveInfo]::new($root).DriveType -eq 'Fixed') { "
  + "Add-Type -TypeDefinition '" + RECYCLE_CS + "'; "
  + "$g = [DroverRecycle]::VolumeGuid($root); if (-not $g) { throw 'no volume' }; "
  + "$bb = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket'; "
  + "$k = Get-ItemProperty -LiteralPath ($bb + '\\Volume\\' + $g) -ErrorAction SilentlyContinue; if (-not $k) { $k = Get-ItemProperty -LiteralPath $bb }; "
  + "if ($null -eq $k.NukeOnDelete -or $null -eq $k.MaxCapacity) { throw 'no bin settings' }; "
  + "foreach ($h in 'HKCU', 'HKLM') { $pol = Get-ItemProperty -LiteralPath ($h + ':\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer') -ErrorAction SilentlyContinue; if ($pol -and [int]$pol.NoRecycleFiles -eq 1) { throw 'recycle bin off by policy' } }; "
  + "$size = if (Test-Path -LiteralPath $p -PathType Container) { [long](Get-ChildItem -LiteralPath $p -Recurse -Force -File | Measure-Object -Property Length -Sum).Sum } else { [long](Get-Item -LiteralPath $p -Force).Length }; "
  + "$ok = [int]$k.NukeOnDelete -eq 0 -and [long]$k.MaxCapacity -gt 0 -and $size -lt [long]$k.MaxCapacity * 1MB } } } catch { $ok = $false }; "
  + "if (-not $ok) { '" + NO_RECYCLE_MARK + "'; exit 3 }; "
  + "try { $r = [DroverRecycle]::Recycle($p) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }; "
  + "if ($r -ne 0) { [Console]::Error.WriteLine('Could not move it to the Recycle Bin (code ' + $r + ')'); exit 1 } }";
// Local Windows: a network path (\\server\share or //server/share) never goes to the Recycle Bin. Other paths
// that are not on a fixed drive are refused by the script itself, before anything is deleted.
export const recycleProblem = (platform, p) => (platform === "windows" && /^[\\/]{2}/.test(String(p ?? "")) ? NO_RECYCLE : null);
export const SEARCH_NEEDS_SH = "Search needs sh. Install Git for Windows and put its usr\\bin on PATH.";
// Local Windows has no test/mkdir/mv: one PowerShell call each. Paths only ever go in as quoted literals.
// Prints "d" for a folder, "f" for anything else that exists, nothing when it is gone.
export const winKindArgv = (p) => ps("$ErrorActionPreference = 'Stop'; & { param($p) if (Test-Path -LiteralPath $p -PathType Container) { 'd' } elseif (Test-Path -LiteralPath $p) { 'f' } } " + psQuote(winPath(p)));
export const winMkdirArgv = (p) => ps("$ErrorActionPreference = 'Stop'; & { param($p) [void][IO.Directory]::CreateDirectory($p) } " + psQuote(winPath(p)));
// [cmd, args] that renames src to dst. mode "new": never replaces what is there; "replace": a file over a file; "case": letter case only.
export function moveArgv(platform, src, dst, mode) {
  if (platform !== "windows") return ["mv", mode === "new" ? ["-n", "--", src, dst] : ["--", src, dst]];
  // File.Move and Directory.Move refuse an existing target; File.Replace swaps a file in without a moment with neither.
  const body = mode === "replace" ? "[IO.File]::Replace($s, $d, $null)"
    : "if (Test-Path -LiteralPath $s -PathType Container) { [IO.Directory]::Move($s, $d) } else { [IO.File]::Move($s, $d) }";
  return ps("$ErrorActionPreference = 'Stop'; & { param($s, $d) " + body + " } " + psQuote(winPath(src)) + " " + psQuote(winPath(dst)));
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
  const items = [];
  const add = (id, label, why, danger) => items.push({ id, label, disabled: Boolean(why), why: why || null, danger: Boolean(danger) });
  if (!dir) add("viewer", viewer ? "Open in viewer" : "Preview here", locked ? `locked: ${locked}` : null);
  // Locked folders and files are never handed to the system opener; launchers get Reveal instead.
  const risk = launchRisk(t.name || "", { dir, platform });
  add("system", dir ? "Open in system file manager" : "Open with system app",
    locked ? `locked: ${locked}` : local || (risk ? `${risk} · use ${revealLabel(platform)}` : null));
  add("reveal", revealLabel(platform), local);
  if (dir && !isRoot && !fixed) add("pin-here", pinned ? "Pin browser here" : "Pin browser here (stop following)", null);
  items.push(null);
  add("copy-path", "Copy path", null);
  add("copy-rel", "Copy relative path", null);
  items.push(null);
  add("new-file", dir ? "New file…" : "New file next to it…", local);
  add("new-folder", dir ? "New folder…" : "New folder next to it…", local);
  if (!isRoot) add("rename", "Rename…", local);
  // canTrash: "present"; "absent" (hidden: no trash command on this macOS, or remote); "missing" (Linux without gio or trash-cli).
  if (!isRoot && canTrash !== "absent") add("trash", "Move to Trash", local || (canTrash === "missing" ? TRASH_MISSING : canTrash ? null : "trash command not found"), true);
  return items;
}

// Height the popup needs for these items.
export const menuHeight = (items) => 16 + items.reduce((h, it) => h + (it ? 30 : 9), 0) + 26;

export { safeJoin, resolve, tilde, basename, parent, isInside, denyReason };
