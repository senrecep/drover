// What a piece of text is (a web link, a path, or plain text) and what can be done with it.
// Pure: no host calls, so check.cjs tests it directly.
import { resolve as resolvePath, basename, parent } from "./lib/paths.js";
import { EDITOR_PREFIX } from "./lib/editors.js";

export const MAX_TEXT = 4096;
export const MAX_QUERY = 200;

const PAIRS = { '"': '"', "'": "'", "`": "`", "<": ">", "(": ")", "[": "]", "{": "}" };
const CLOSERS = { ")": "(", "]": "[", "}": "{", ">": "<" };
const count = (s, ch) => s.split(ch).length - 1;

// Strips wrapping quotes/brackets and sentence punctuation a selection tends to carry along.
export function unwrap(text) {
  let t = String(text ?? "").trim();
  for (let guard = 0; guard < 8 && t.length > 1; guard++) {
    const before = t;
    const close = PAIRS[t[0]];
    if (close && t.endsWith(close)) t = t.slice(1, -1).trim();
    // trailing sentence punctuation
    t = t.replace(/[.,;!?]+$/, "");
    // an unbalanced closer at the end ("(see /a/b)" selected without its opener)
    const last = t[t.length - 1];
    if (CLOSERS[last] && count(t, last) > count(t, CLOSERS[last])) t = t.slice(0, -1);
    if (`"'\``.includes(last) && count(t, last) % 2 === 1) t = t.slice(0, -1);
    // an unbalanced opener at the start
    const first = t[0];
    if (PAIRS[first] && first !== PAIRS[first] && count(t, first) > count(t, PAIRS[first])) t = t.slice(1);
    if (`"'\``.includes(first) && count(t, first) % 2 === 1) t = t.slice(1);
    t = t.trim();
    if (t === before) break;
  }
  return t;
}

const URL_RE = /^(https?):\/\/([^\s/?#@]+@)?([^\s/?#:@]+)(:\d{1,5})?([^\s]*)$/i;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/i;

// A URL as it may be shown: no userinfo, no query string or fragment.
export function displayUrl(url) {
  const m = URL_RE.exec(String(url ?? ""));
  if (!m) return "";
  const pathOnly = (m[5] || "").replace(/[?#].*$/, "");
  const cut = pathOnly !== (m[5] || "");
  return `${m[1].toLowerCase()}://${m[3]}${m[4] || ""}${pathOnly}${cut ? "?…" : ""}`;
}
export const urlHost = (url) => URL_RE.exec(String(url ?? ""))?.[3] ?? "";

function asUrl(t) {
  const md = /^\[[^\]]*\]\((https?:\/\/[^\s)]+)\)$/i.exec(t);
  if (md) t = md[1];
  if (/^www\.[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(t)) t = "https://" + t;
  const m = URL_RE.exec(t);
  if (!m || !/[a-z0-9]/i.test(m[3])) return null;
  // trailing punctuation that is not part of a URL
  let url = t;
  while (/[.,;:!?'"]$/.test(url)) url = url.slice(0, -1);
  if (url.endsWith(")") && count(url, ")") > count(url, "(")) url = url.slice(0, -1);
  return URL_RE.test(url) ? url : null;
}

function decodeFileUrl(t) {
  const m = /^file:\/\/(localhost)?(\/[^\s]*)$/i.exec(t);
  if (!m) return null;
  try { return decodeURIComponent(m[2]); } catch (e) { return m[2]; }
}

// "path:12", "path:12:5", "path:12:5:" (grep), "path(12,5)", "path#L12", python's `File "p", line 12`.
export function splitLocation(t) {
  let m = /^File "(.+)", line (\d+)/.exec(t);
  if (m) return { path: m[1], line: +m[2], col: null };
  t = t.replace(/:+$/, "");
  m = /^(.+?)#L(\d+)(?:C(\d+))?(?:-L?\d+)?$/.exec(t);
  if (m) return { path: m[1], line: +m[2], col: m[3] ? +m[3] : null };
  m = /^(.+?)\((\d+)(?:,\s*(\d+))?\)$/.exec(t);
  if (m) return { path: m[1], line: +m[2], col: m[3] ? +m[3] : null };
  m = /^(.+?):(\d+)(?::(\d+))?(?::.*)?$/.exec(t);
  if (m && !/^[a-z]+$/i.test(m[1])) return { path: m[1], line: +m[2], col: m[3] ? +m[3] : null };
  return { path: t, line: null, col: null };
}

// A full drive path on Windows, either separator: "C:\x" or "C:/x". Never "C:" alone or "C:x".
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;

function looksLikePath(p, win) {
  if (!p || p.length > 1024 || p.includes("\0")) return false;
  if (/^(~|\.{1,2})$/.test(p)) return true;
  if (/^(\/|~\/|\.\.?\/)/.test(p)) return true;
  // Local Windows: a drive path (spaces allowed, as above), and a relative one written with backslashes.
  if (win && (DRIVE_PATH.test(p) || (!/\s/.test(p) && /^[\w.@+-]+\\/.test(p)))) return true;
  if (/\s/.test(p)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return false; // another scheme (mailto:, ssh://)
  if (p.includes("/")) return true;
  if (/^\.[\w@+-][\w.@+-]*$/.test(p)) return true; // a bare dotfile: .env, .gitignore, .env.local
  return /^[\w@+-][\w.@+-]*\.[A-Za-z0-9]{1,10}$/.test(p) && !/^\d+(\.\d+)+$/.test(p);
}

// Absolute candidates for a path as written, nearest guess first. platform is set only for this computer.
// Local Windows: a drive path, or a relative path against a drive cwd, with "." and ".." resolved and then every
// part trimmed the way Windows reads it (windowsParts); one it refuses is no candidate.
export function candidates(p, { home, cwd, platform } = {}) {
  const out = [];
  const add = (x) => { const r = x && resolvePath(x); if (r && r.startsWith("/") && !out.includes(r)) out.push(r); };
  const win = platform === "windows";
  // file:///C:/x decodes to "/C:/x": on Windows that is the drive path C:/x.
  if (win && /^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
  const addDrive = (x) => {
    const r = resolvePath(x.slice(2).replace(/\\/g, "/")), w = r ? windowsParts(x.slice(0, 2) + r) : null;
    if (w?.path && !out.includes(w.path)) out.push(w.path);
  };
  if (win && DRIVE_PATH.test(p)) { addDrive(p); return out; }
  if (p === "~" || p.startsWith("~/")) { if (home) add(home + p.slice(1)); return out; }
  if (p.startsWith("/")) { add(p); return out; }
  if (!cwd) return out;
  if (win) {
    if (!DRIVE_PATH.test(cwd) || p.startsWith("\\")) return out;
    addDrive(cwd + "/" + p);
    const diffWin = /^[ab][\\/](.+)$/.exec(p);
    if (diffWin) addDrive(cwd + "/" + diffWin[1]);
    return out;
  }
  add(cwd + "/" + p);
  // git diff prefixes: "a/src/x.js", "b/src/x.js"
  const diff = /^[ab]\/(.+)$/.exec(p);
  if (diff) add(cwd + "/" + diff[1]);
  return out;
}

// -> { kind: "empty" | "url" | "path" | "text", ... }
export function parseTarget(raw, opts = {}) {
  let text = String(raw ?? "").replace(/\r/g, "");
  const truncated = text.length > MAX_TEXT;
  if (truncated) text = text.slice(0, MAX_TEXT);
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { kind: "empty" };
  if (lines.length > 1 || truncated) {
    const inText = URL_IN_TEXT.exec(lines[0]);
    return { kind: "text", query: lines[0].slice(0, MAX_QUERY), multiline: lines.length > 1, url: inText ? asUrl(inText[0]) : null };
  }
  const t = unwrap(lines[0]);
  if (!t) return { kind: "empty" };
  const url = asUrl(t);
  if (url) return { kind: "url", url };
  const fileUrl = decodeFileUrl(t);
  const loc = splitLocation(fileUrl ?? t);
  const p = unwrap(loc.path);
  if (looksLikePath(p, opts.platform === "windows")) {
    const list = candidates(p, opts);
    // A drive path, or a relative one against a drive cwd, with no candidate was refused (a stream, a short ~1
    // name), not left waiting for a folder.
    const win = opts.platform === "windows", dp = win && /^\/[A-Za-z]:[\\/]/.test(p) ? p.slice(1) : p;
    const full = !win ? null : DRIVE_PATH.test(dp) ? dp
      : opts.cwd && DRIVE_PATH.test(opts.cwd) && !/^[\\/~]/.test(p) ? opts.cwd + "/" + p : null;
    if (!list.length && full) {
      const r = resolvePath(full.slice(2).replace(/\\/g, "/")), w = r ? windowsParts(full.slice(0, 2) + r) : null;
      const refused = w?.error ? `Refused: the path has ${w.error}` : "Refused: not a full drive path";
      return { kind: "path", written: p, line: loc.line, col: loc.col, candidates: list, needsCwd: false, refused };
    }
    return { kind: "path", written: p, line: loc.line, col: loc.col, candidates: list, needsCwd: !list.length };
  }
  const inText = URL_IN_TEXT.exec(t);
  if (inText && asUrl(inText[0])) return { kind: "text", query: t.slice(0, MAX_QUERY), url: asUrl(inText[0]) };
  return { kind: "text", query: t.slice(0, MAX_QUERY) };
}

// The chooser's actions. `info` for a path: { status: "file"|"dir"|"missing"|"checking"|"error", abs, deny }.
export const LABELS = {
  browser: "Open in browser", copyLink: "Copy link",
  viewer: "Open in viewer", tab: "Open in new tab", reveal: "Reveal in files", system: "Open with system app", copyPath: "Copy path",
  files: "Open in files", search: "Search in files", copyText: "Copy text", finder: "Reveal in Finder",
};
export const ICONS = {
  browser: "globe", copyLink: "copy", viewer: "panel-right", tab: "app-window", reveal: "folder-search", system: "external-link",
  copyPath: "copy", files: "panel-right", search: "search", copyText: "copy", finder: "folder-search",
};

// Windows path checks, kept byte-identical in every drover mod that carries them.
// Windows drops trailing dots and spaces from every part (".ssh./id_rsa " is .ssh/id_rsa), reads "x:y" after the
// drive as stream y of file x, and lets a short 8.3 name such as PROGRA~1 stand for a long one, which could be .ssh.
// So the credential check gets every part trimmed, and a stream or a short name is refused outright.
// -> {path} ("C:/..." with every part trimmed) or {error}; null unless p starts with a drive letter and a slash.
export function windowsParts(p) {
  const m = /^([A-Za-z]:)([\\/].*)$/.exec(String(p ?? ""));
  if (!m) return null;
  const parts = (m[2] ?? "").split(/[\\/]/).filter(Boolean).map((s) => s.replace(/[. ]+$/, ""));
  if (parts.some((s) => s === "")) return { error: "a name made only of dots or spaces" };
  if (parts.some((s) => s.includes(":"))) return { error: "a file stream (name:stream)" };
  if (parts.some((s) => /~\d/.test(s))) return { error: "a short 8.3 name such as PROGRA~1; use the full name" };
  return { path: m[1] + "/" + parts.join("/") };
}
// Local Windows has no realpath, so a link can't be followed to see where it leads. This PowerShell walks from the
// path up to its drive and prints WIN_LINK_MARK when any existing part is a symbolic link or junction, else
// WIN_LINK_PLAIN. An error (a part it may not read) prints neither, and the caller then refuses too.
export const WIN_LINK_PLAIN = "drover:plain";
export const WIN_LINK_MARK = "drover:link";
export const winLinkArgv = (p) => ["powershell", ["-NoProfile", "-NonInteractive", "-Command",
  "$ErrorActionPreference = 'Stop'; & { param($q) while ($q) { if (Test-Path -LiteralPath $q) { $i = Get-Item -LiteralPath $q -Force; "
  + "if (($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $i.LinkType) { '" + WIN_LINK_MARK + "'; exit 0 } }; "
  + "$q = [IO.Path]::GetDirectoryName($q) }; '" + WIN_LINK_PLAIN + "' } "
  + "'" + String(p).replace(/\//g, "\\").replace(/['‘’‚‛]/g, "$&$&") + "'"]];
// End of the Windows path checks.

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
  "jnlp", "theme", "themepack", "mht", "xbap",
  "pyc", "pyo", "ps1xml", "ps2", "ps2xml", "psc2", "vsto", "mde", "accde", "mshxml", "mmc", "ocx", "sys", "dll"]);
// Would explorer.exe run this path? The name after the last / or \, with the trailing dots and spaces
// Windows drops ("a.exe." runs a.exe). A name that is only an extension (".js") counts. A ":" means an
// NTFS stream ("a.exe:s", "a.lnk::$DATA"), which is refused too.
function windowsRuns(p) {
  const b = String(p ?? "").split(/[\\/]/).pop().toLowerCase().replace(/[. ]+$/, ""), i = b.lastIndexOf(".");
  return b.includes(":") || (i >= 0 && (LAUNCH_EXT.has(b.slice(i + 1)) || WINDOWS_LAUNCH_EXT.has(b.slice(i + 1))));
}
export function launchRisk(p, { dir = false, executable = false, platform } = {}) {
  const b = basename(String(p ?? "")).toLowerCase(), i = b.lastIndexOf("."), ext = i > 0 ? b.slice(i + 1) : "";
  if (LAUNCH_EXT.has(ext) || (platform === "windows" && windowsRuns(p))) return dir ? "an app or bundle: opening it runs it" : "a script or launcher: opening it runs it";
  if (!dir && executable) return "an executable: opening it runs it";
  return null;
}
// Why the system app must not get this path (looked-up info), checked on the path as written and on its real target.
export const infoRisk = (info, platform) => {
  if (!info || (info.status !== "file" && info.status !== "dir")) return null;
  const o = { dir: info.status === "dir", executable: Boolean(info.exec), platform };
  return launchRisk(info.abs, o) || launchRisk(info.real, o);
};
// Windows form of a path: backslashes, and a drive root stays "C:\" (never "C:", the current folder on drive C).
const winNative = (p) => String(p).replace(/\//g, "\\").replace(/^([A-Za-z]:)$/, "$1\\");
// explorer.exe splits its arguments at commas, so it is never handed a path with one.
export const COMMA_PATH = "Explorer can't open paths with a comma. Copy the path instead.";
export const explorerProblem = (platform, path) => (platform === "windows" && String(path ?? "").includes(",") ? COMMA_PATH : null);
// argv that shows (never opens) a local file or folder in the system file manager.
export function systemRevealArgv(platform, path) {
  if (platform === "macos") return ["open", ["-R", "--", path]];
  if (platform === "windows") return ["explorer.exe", ["/select,", winNative(path)]];
  return ["xdg-open", [parent(path)]];
}
// The name of that action in the system's own words (no platform: macOS).
export const finderLabel = (platform) =>
  !platform || platform === "macos" ? LABELS.finder : platform === "windows" ? "Show in Explorer" : "Show in file manager";
// What to say when the system opener is not installed (exec rejects with "program not found").
export const missingOpener = (cmd) => (cmd === "xdg-open" ? "xdg-open is missing. Install xdg-utils to open files." : `${cmd} was not found.`);

// Which remembered-choice bucket a target falls in.
export function prefKey(target, info) {
  if (!target || target.kind === "empty") return null;
  if (target.kind === "url") return "url";
  if (target.kind === "text") return "text";
  return info?.status === "dir" ? "dir" : info?.status === "file" ? "file" : null;
}

// The editor rows for a local file or folder: one per installed editor (ctx.editors), macOS and Linux
// (on Linux only editors found through their command-line launcher, `cli`).
export function editorRows(ctx = {}, disabled = null) {
  if ((ctx.platform !== "macos" && ctx.platform !== "linux") || !Array.isArray(ctx.editors)) return [];
  return ctx.editors
    .filter((e) => e && typeof e.id === "string" && typeof e.name === "string" && (ctx.platform === "macos" || typeof e.cli === "string"))
    .map((e) => ({ id: EDITOR_PREFIX + e.id, label: `Open in ${e.name}`, icon: "app-window", disabled, editor: e.name }));
}

// -> [{ id, label, icon, disabled: reason | null }]
// ctx: { cwd, on, platform, editors: [{ id, name }] installed, mode: "editors" for editor rows only }.
export function actionsFor(target, info = {}, ctx = {}) {
  const a = (id, disabled = null) => ({ id, label: LABELS[id], icon: ICONS[id], disabled });
  const remote = ctx.on ? "this machine only" : null;
  const noSearch = ctx.cwd ? null : "no folder to search";
  if (!target || target.kind === "empty") return [];
  if (ctx.mode === "editors") return editorActions(target, info, ctx, a, remote);
  if (target.kind === "url") return [a("browser"), a("copyLink")];
  if (target.kind === "text") {
    const list = [a("search", noSearch), a("copyText")];
    return target.url ? [a("browser"), ...list] : list;
  }
  const deny = info.deny ? `refused: ${info.deny}` : null;
  // A launcher or executable is never handed to the system app: the system file manager shows it instead.
  const sys = () => {
    if (deny || !infoRisk(info, ctx.platform)) return a("system", deny || remote);
    const f = a("finder", remote);
    f.label = finderLabel(ctx.platform);
    return f;
  };
  const eds = () => editorRows(ctx, deny || remote);
  // Editor rows go last: they appear once detection finishes, so the 1-9 numbers of the rows above never move.
  if (info.status === "dir") return [a("files", deny), a("tab", deny), sys(), a("copyPath"), ...eds()];
  if (info.status === "file") return [a("viewer", deny), a("tab", deny), a("reveal"), sys(), a("copyPath"), ...eds()];
  if (info.status === "checking") return [a("viewer", "checking…"), a("tab", "checking…"), a("reveal", "checking…"), a("system", "checking…"), a("copyPath")];
  // missing, unresolved or failed: copy what was written, or search for its name
  return [a("search", noSearch), a("copyPath", info.abs || target.candidates?.length ? null : "no full path")];
}

// "Open in": the editor rows and the system row only. A remote target is never looked up: every row
// is disabled. A launcher or bundle gets "Reveal in Finder" instead of the system app, as elsewhere.
function editorActions(target, info, ctx, a, remote) {
  if (target.kind !== "path") return [];
  const sysRow = (disabled) => {
    if (disabled || !infoRisk(info, ctx.platform)) return a("system", disabled);
    const f = a("finder");
    f.label = finderLabel(ctx.platform);
    return f;
  };
  if (remote) return [...editorRows(ctx, remote), a("system", remote)];
  if (info.status === "checking") return [...editorRows(ctx, "checking…"), a("system", "checking…")];
  if (info.status === "dir" || info.status === "file") {
    const deny = info.deny ? `refused: ${info.deny}` : null;
    return [...editorRows(ctx, deny), sysRow(deny)];
  }
  const why = info.status === "missing" ? "not found" : info.status === "error" ? "could not check" : "no full path";
  return [...editorRows(ctx, why), a("system", why)];
}

// The row to keep selected when the list changes under the user: the row with id `prevId`, else `fallback`.
export function reselect(list, prevId, fallback = 0) {
  const i = prevId && Array.isArray(list) ? list.findIndex((a) => a?.id === prevId) : -1;
  return i >= 0 ? i : fallback;
}

// The query a missing path searches for: its file name.
export const searchQueryFor = (target) => target.kind === "path" ? basename(target.written).slice(0, MAX_QUERY) : (target.query || "");
// The folder "Reveal in files" opens.
// parent("C:/a.txt") is "C:", which is no folder: a file at a drive root shows the root, "C:/".
export const revealFolder = (info) => {
  if (info.status === "dir") return info.abs;
  const up = parent(info.abs);
  return /^[A-Za-z]:$/.test(up) ? up + "/" : up;
};

// argv that opens a local file or folder with the system's app.
export function systemOpenArgv(platform, path) {
  if (platform === "macos") return ["open", ["--", path]];
  if (platform === "windows") return ["explorer.exe", [winNative(path)]];
  return ["xdg-open", [path]];
}

export const describeLocation = (line, col) => (line ? `:${line}${col ? `:${col}` : ""}` : "");
