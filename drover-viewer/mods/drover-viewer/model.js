// Pure helpers for the viewer: no host calls, so check.cjs tests them directly.
import { langFor, isMarkdown, utf8Length, MAX_BYTES } from "./lib/lang.js";
import { redact, MASK } from "./lib/guard.js";
import { resolve, parent } from "./lib/paths.js";

export const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp"]);
export const IMAGE_MAX = 20 * 1024 * 1024;
export const WINDOW_LINES = 2000;
export const MAX_LINE_CHARS = 2000;
export const LINK_MODES = ["system", "chooser"];
export const LINK_KEY = "drover-viewer.links";

// 32-bit FNV-1a over UTF-16 code units, twice with different offsets -> 16 hex chars.
export function fnv1a(s) {
  s = String(s ?? "");
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ (c >>> 3), 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

const drive = (s) => /^[A-Za-z]:[\\/]/.test(s);
// props -> {path, on, line} or {error}. `file` is accepted as an alias of `path`.
// On Windows a local path may also start with a drive letter (C:\ or C:/); it comes back with "/" separators.
export function normalizeTarget(p, home, platform = "macos") {
  const raw = p && typeof p === "object" ? (p.path ?? p.file) : null;
  const line = p && Number.isFinite(Number(p.line)) && Number(p.line) >= 1 ? Math.floor(Number(p.line)) : null;
  const on = p && typeof p.on === "string" && p.on.trim() ? p.on.trim() : null;
  if (typeof raw !== "string" || !raw.trim()) return { error: "No file", line, on };
  let path = raw.trim();
  if (path.includes("\0")) return { error: "Invalid path", line, on };
  if (path === "~" || path.startsWith("~/")) {
    if (!home || on) return { error: "Path must be absolute", line, on };
    path = home.replace(/\/+$/, "") + path.slice(1);
  }
  // A network path (//server/share or \\server\share) is refused here: resolve() would fold "//server" into "/server".
  if (platform === "windows" && !on && /^[\\/]{2}/.test(path)) return { error: "Path must be absolute", line, on };
  if (platform === "windows" && !on && drive(path)) {
    // resolve("C:/") is "C:": a drive root keeps its slash.
    const r = resolve(path).replace(/^([A-Za-z]:)$/, "$1/");
    return drive(r) ? { path: r, line, on } : { error: "Path must be absolute", line, on };
  }
  if (!path.startsWith("/")) return { error: "Path must be absolute", line, on };
  return { path: resolve(path), line, on };
}

export const nameOf = (p) => String(p || "").replace(/\/+$/, "").split("/").pop() || String(p || "");
export function extOf(p) {
  const b = nameOf(p).toLowerCase(), i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i + 1) : "";
}
// "image" (svg too) | "markdown" | "text"
export function kindOf(p) {
  if (IMAGE_EXT.has(extOf(p))) return "image";
  if (isMarkdown(p)) return "markdown";
  return "text";
}
export const languageOf = (p) => (extOf(p) === "svg" ? "xml" : langFor(p));

const count = (s, needle) => { let n = 0, i = 0; for (;;) { i = s.indexOf(needle, i); if (i < 0) return n; n++; i += needle.length; } };
// redact() plus how many secrets it masked (never the values).
export function redactInfo(text) {
  const src = String(text ?? "");
  const r = redact(src);
  const n = count(r.text, MASK) - count(src, MASK);
  return { text: r.text, count: r.redacted ? Math.max(1, n) : 0 };
}

// "  1234 /path\n" -> 1234
export function parseCount(stdout) {
  const m = /^\s*(\d+)/.exec(String(stdout ?? ""));
  return m ? Number(m[1]) : null;
}

// Line total from `wc -l` (newline count) and the file's last byte: a final newline ends the last line, it does not start one.
// An unknown last byte (null) keeps the safe "one more line" count.
export function lineTotal(newlines, lastByte) {
  const n = Number.isFinite(newlines) ? newlines : 0;
  return lastByte === "\n" || lastByte === "" ? n : n + 1;
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
export function launchRisk(p, { dir = false, executable = false, platform = "macos" } = {}) {
  const b = String(p ?? "").split("/").pop().toLowerCase(), i = b.lastIndexOf("."), ext = i > 0 ? b.slice(i + 1) : "";
  if (LAUNCH_EXT.has(ext) || (platform === "windows" && windowsRuns(p))) return dir ? "an app or bundle: opening it runs it" : "a script or launcher: opening it runs it";
  if (!dir && executable) return "an executable: opening it runs it";
  return null;
}

// null when the text may be edited and saved, else why it is read-only.
export function readOnlyReason({ on, redacted, bytes, text, roundTrip }) {
  if (on) return "Remote file: read-only";
  if (redacted) return `${redacted} secret${redacted === 1 ? "" : "s"} hidden: read-only`;
  if (typeof bytes === "number" && bytes > MAX_BYTES) return "Larger than 1 MiB: read-only";
  if (typeof text === "string" && typeof bytes === "number" && utf8Length(text) !== bytes) return "Encoding can't be preserved: read-only";
  if (roundTrip === false) return "Line endings can't be preserved: read-only";
  return null;
}

// Display lines: no trailing CR, no empty line after a final newline, long lines cut.
export function splitLines(text) {
  const lines = String(text ?? "").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => {
    const s = l.endsWith("\r") ? l.slice(0, -1) : l;
    return s.length > MAX_LINE_CHARS ? s.slice(0, MAX_LINE_CHARS) + " …" : s;
  });
}

// 1-based inclusive window of `size` lines centred on `line`, clamped to [1, total].
export function lineWindow(line, total, size = WINDOW_LINES) {
  const t = Math.max(1, Number(total) || 1), want = Math.min(Math.max(1, Number(line) || 1), t);
  let start = Math.max(1, want - Math.floor(size / 2));
  const end = Math.min(t, start + size - 1);
  start = Math.max(1, Math.min(start, end - size + 1));
  return { start, end };
}

export function parseLineInput(v) {
  const m = /^\s*:?\s*(\d{1,9})\s*$/.exec(String(v ?? ""));
  return m && Number(m[1]) >= 1 ? Number(m[1]) : null;
}

// A link from rendered markdown -> {kind:"web", url} | {kind:"file", path, line} | {kind:"ignore", reason}
export function classifyLink(url, baseDir, home) {
  let u = String(url ?? "").trim();
  if (!u) return { kind: "ignore", reason: "empty link" };
  if (/^https?:\/\/[^\s/?#]/i.test(u)) return { kind: "web", url: u };
  if (u.startsWith("#")) return { kind: "ignore", reason: "anchor" };
  const isFile = /^file:\/\//i.test(u);
  if (isFile) u = u.replace(/^file:\/\/(localhost)?/i, "");
  else if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return { kind: "ignore", reason: "unsupported link" };
  let line = null;
  const hash = u.indexOf("#");
  if (hash >= 0) { const m = /^L(\d+)/i.exec(u.slice(hash + 1)); if (m) line = Number(m[1]); u = u.slice(0, hash); }
  const q = u.indexOf("?");
  if (q >= 0) u = u.slice(0, q);
  try { u = decodeURIComponent(u); } catch (e) { return { kind: "ignore", reason: "bad link" }; }
  if (!u || u.includes("\0")) return { kind: "ignore", reason: "empty link" };
  if (u === "~" || u.startsWith("~/")) { if (!home) return { kind: "ignore", reason: "no home" }; u = home.replace(/\/+$/, "") + u.slice(1); }
  else if (!u.startsWith("/")) { if (!baseDir) return { kind: "ignore", reason: "no folder" }; u = baseDir.replace(/\/+$/, "") + "/" + u; }
  return { kind: "file", path: resolve(u), line };
}

// A URL as it may be shown: scheme, host and path only (no userinfo, query or fragment).
export function displayUrl(url) {
  const m = /^(https?):\/\/(?:[^\s/?#@]*@)?([^\s/?#]+)([^\s?#]*)/i.exec(String(url ?? ""));
  if (!m) return "link";
  const s = `${m[1].toLowerCase()}://${m[2]}${m[3]}`;
  return s.length > 80 ? s.slice(0, 79) + "…" : s;
}

export const linkMode = (v) => (LINK_MODES.includes(v) ? v : "system");
export const draftName = (path, on) => `${fnv1a((on || "") + "\0" + path)}.json`;
export const cachePrefix = (path, on) => `${fnv1a((on || "") + "\0" + path)}-`;
export function cacheName(path, on, stamp, ext) {
  const e = IMAGE_EXT.has(String(ext).toLowerCase()) ? String(ext).toLowerCase() : "img";
  return `${cachePrefix(path, on)}${String(stamp).replace(/[^0-9a-z]/gi, "")}.${e}`;
}

// A stored draft is offered only for this file, when it differs from what is on disk.
export function draftOffer(draft, path, on, diskText) {
  if (!draft || typeof draft !== "object" || typeof draft.text !== "string") return null;
  if (draft.path !== path || (draft.on || null) !== (on || null)) return null;
  if (draft.text === diskText) return null;
  return { text: draft.text, savedAt: Number(draft.savedAt) || 0, stale: draft.baseHash !== fnv1a(diskText) };
}
export const makeDraft = (path, on, text, diskText, now) => ({ path, on: on || null, text, baseHash: fnv1a(diskText), savedAt: now });

export function formatBytes(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "unknown size";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

export function ago(ms, now) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// writeTextFile rejection -> "conflict" | "size" | "error"
export function saveErrorKind(e) {
  const m = String(e?.message ?? e ?? "");
  if (/changed outside|reload before saving/i.test(m)) return "conflict";
  if (/exceeds 1 MiB/i.test(m)) return "size";
  return "error";
}
// Short host message, one line, no paths repeated beyond what the user already sees.
export const shortError = (e) => String(e?.message ?? e ?? "Unknown error").replace(/^Error:\s*/, "").replace(/`herdr\.\w+`:\s*/, "").split("\n")[0].slice(0, 160);

// ---------- system opener, per platform ("macos" | "linux" | "windows") ----------
// A drive root stays "C:\", never "C:" (the current folder on drive C).
const native = (p) => String(p).replace(/\//g, "\\").replace(/^([A-Za-z]:)$/, "$1\\");
export const revealLabel = (platform) => (platform === "windows" ? "Show in Explorer" : platform === "linux" ? "Show in file manager" : "Reveal in Finder");
// Explorer selects a file with "/select," followed by the path; a folder is opened as itself.
export function revealArgv(platform, p, dir = false) {
  if (platform === "windows") return ["explorer.exe", dir ? [native(p)] : ["/select,", native(p)]];
  if (platform === "linux") return ["xdg-open", [parent(p)]];
  return ["open", ["-R", "--", p]];
}
export function openArgv(platform, p) {
  if (platform === "windows") return ["explorer.exe", [native(p)]];
  if (platform === "linux") return ["xdg-open", [p]];
  return ["open", [p]];
}
// explorer.exe splits its arguments at commas, so it is never handed a path with one.
export const COMMA_PATH = "Explorer can't open paths with a comma. Copy the path instead.";
export const explorerProblem = (platform, p) => (platform === "windows" && String(p ?? "").includes(",") ? COMMA_PATH : null);
// explorer.exe exits 1 even when it worked, so its exit code says nothing.
export const openerWorked = (platform, code) => platform === "windows" || code === 0;
export const notFound = (e) => /program not found/i.test(String(e?.message ?? e ?? ""));
export function openError(e, platform) {
  if (notFound(e) && platform === "linux") return "Install xdg-utils to open files";
  if (notFound(e) && platform === "windows") return "explorer.exe was not found";
  return "The system couldn't open this file";
}
// Local Windows has no wc, tail, sed, sh or cp unless Git for Windows' usr\bin is on PATH.
export const WINDOWS_TOOLS = "Needs wc, tail, sed, sh and cp. Install Git for Windows and put its usr\\bin on PATH.";
export const readError = (e, platform, on) => (!on && platform === "windows" && notFound(e) ? WINDOWS_TOOLS : shortError(e));
