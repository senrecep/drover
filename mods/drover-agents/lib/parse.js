// Pure helpers for the Agents page: no host calls, tested with `node --test`.

// ---------- prices ----------

// USD per million tokens as [input, output]. A model matches when its id contains the key
// (probe.py picks the longest); cache write and read are multiples of the input price.
export const DEFAULT_PRICES = Object.freeze({
  models: Object.freeze({ haiku: [0.1, 0.5], sonnet: [2, 10], opus: [4, 20], fable: [10, 50] }),
  cacheWrite: 1.25,
  cacheRead: 0.1,
});

// A finite, non-negative number from a number or a numeric string, else undefined.
function rate(v) {
  if (typeof v === "string" && v.trim() !== "") v = Number(v);
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function pricePair(v) {
  if (!Array.isArray(v) || v.length !== 2) return undefined;
  const pair = v.map(rate);
  return pair.includes(undefined) ? undefined : pair;
}

// Defaults, then config.json, then layout props: each source is { prices: {...} } and a later one
// wins. Entries that are not valid prices are skipped. The result is a fresh copy every call.
export function mergePrices(...sources) {
  const table = { models: {}, cacheWrite: DEFAULT_PRICES.cacheWrite, cacheRead: DEFAULT_PRICES.cacheRead };
  for (const [key, pair] of Object.entries(DEFAULT_PRICES.models)) table.models[key] = [...pair];
  for (const source of sources) {
    const p = source && typeof source === "object" ? source.prices : null;
    if (!p || typeof p !== "object") continue;
    if (p.models && typeof p.models === "object") {
      for (const [key, value] of Object.entries(p.models)) {
        const pair = pricePair(value);
        if (pair) table.models[key] = pair;
      }
    }
    for (const field of ["cacheWrite", "cacheRead"]) {
      const r = rate(p[field]);
      if (r !== undefined) table[field] = r;
    }
  }
  return table;
}

// ---------- labels ----------

const NONE = "—";
const UNITS = [[1e3, "k"], [1e6, "M"], [1e9, "B"]];

// 950 -> "950", 103300 -> "103.3k", 2e6 -> "2M". The unit is chosen after rounding to one decimal,
// so 999950 is "1M", not "1000k". Billions are the largest unit.
export function formatTokens(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return NONE;
  const size = Math.abs(n);
  if (size < 1000) return String(n);
  const sign = n < 0 ? "-" : "";
  for (const [step, unit] of UNITS) {
    const scaled = Math.round((size / step) * 10) / 10;
    if (scaled < 1000 || unit === "B") return sign + String(scaled) + unit;
  }
  return NONE;
}

export function formatUsd(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return NONE;
  if (v > 0 && v < 0.01) return "<$0.01";
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

// The context meter: { pct: "52% used", detail: "103.3k / 200k", fill: 0..1 }, or null.
export function contextView(ctx) {
  const used = ctx?.used;
  const total = ctx?.window;
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return null;
  const fill = Math.max(0, Math.min(1, used / total));
  return { pct: Math.round(fill * 100) + "% used", detail: formatTokens(used) + " / " + formatTokens(total), fill };
}

// ---------- paths ----------

const trimSlashes = (p) => p.replace(/\/+$/, "");
const inside = (child, parent) => child === parent || child.startsWith(parent + "/");

export function tildify(path, home) {
  if (!path) return "";
  if (!home) return path;
  if (path === home) return "~";
  return path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

// What opens a probe path (home written as "~") in an editor; null unless it is a whole path. macOS: the
// default text editor (open -t). Linux: xdg-open. Windows: explorer.exe, which hands it to the file's app
// and returns at once (Notepad would stay running into exec's timeout).
// A "~/x" path with no known home folder is not opened (it must not become "/x"). On Windows a file
// explorer.exe would run, a path with a comma, or a network path (\\server or //server) is not opened
// either: openRefusal says why.
export function editorArgv(path, home, platform) {
  const p = String(path ?? ""), win = platform === "windows";
  const tilde = (win ? /^~[\\/]/ : /^~\//).test(p);
  if (tilde && !home) return null;
  const full = tilde ? String(home) + p.slice(1) : p;
  if (full.includes("…")) return null;
  if (win) return /^[A-Za-z]:[\\/]/.test(full) && !openRefusal(full, platform) ? ["explorer.exe", [full.replace(/\//g, "\\")]] : null;
  if (!full.startsWith("/")) return null;
  return platform === "linux" ? ["xdg-open", [full]] : ["open", ["-t", full]];
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

// Why a path is not handed to the opener, or null. Only Windows refuses anything: a network path, which
// would reach out to the server; a file it would run (see windowsRuns); a path with a comma.
export function openRefusal(path, platform) {
  if (platform !== "windows") return null;
  const p = String(path ?? "");
  if (/^[\\/]{2}/.test(p)) return "Network paths (\\\\server\\share) are not opened here. Use Copy path and open it in your editor.";
  if (windowsRuns(p)) return "Windows would run this file instead of showing it, so it is not opened here. Use Copy path and open it in your editor.";
  if (p.includes(",")) return "Windows Explorer cannot open a path with a comma in it. Use Copy path and open it in your editor.";
  return null;
}

// What to say when the editor did not open, from exec's result or error; null when it did, and on macOS,
// which stays quiet as before. explorer.exe exits 1 even when it opened the file.
export function openProblem(platform, result, error) {
  if (platform === "macos") return null;
  if (error) {
    if (!/program not found/.test(String(error?.message ?? error))) return "Could not open the file.";
    return platform === "linux" ? "Install xdg-utils to open files." : "explorer.exe was not found.";
  }
  return platform === "linux" && result?.code !== 0 ? "Could not open the file: xdg-open found no app for it." : null;
}

// The tail of a long path behind "…/", as many whole segments as fit in `max` characters.
export function shortPath(path, max = 30) {
  if (!path) return "";
  if (path.length <= max) return path;
  const parts = path.split("/").filter(Boolean);
  const lead = "…/";
  let tail = parts.pop() ?? "";
  while (parts.length && lead.length + parts[parts.length - 1].length + 1 + tail.length <= max) {
    tail = parts.pop() + "/" + tail;
  }
  return lead + tail;
}

// ---------- git ----------

// Every git call: no optional locks, no fsmonitor hook, no external diff program, and no
// repository found by walking into a bare one.
export const GIT_PREFIX = Object.freeze([
  "--no-optional-locks",
  "-c", "core.fsmonitor=false",
  "-c", "diff.external=",
  "-c", "safe.bareRepository=explicit",
]);
export function gitArgs(args) {
  return GIT_PREFIX.concat(args);
}

// The repository root, only when the focused folder lies inside it (core.worktree can point anywhere).
export function rootFor(folder, root) {
  if (!folder || !root) return null;
  const top = trimSlashes(root);
  if (top === "") return folder.startsWith("/") ? root : null;
  return inside(trimSlashes(folder), top) ? root : null;
}

// ---------- cost rows ----------

// A cost block's models as rows: priced ones by cost, then unpriced; ties by tokens. Highest first.
export function modelRows(block) {
  const models = block?.models;
  if (!models || typeof models !== "object") return [];
  const rows = Object.entries(models).map(([model, row]) => ({ model, tokens: row?.tokens ?? 0, cost: row?.cost ?? null }));
  const rank = (r) => (r.cost === null ? -Infinity : r.cost);
  return rows.sort((x, y) => rank(y) - rank(x) || y.tokens - x.tokens);
}

// ---------- the Agents page ----------

export const GROUPS = [
  { id: "instructions", label: "Instructions", short: "instr" },
  { id: "skills", label: "Skills", short: "skills" },
  { id: "agents", label: "Agents", short: "agents" },
  { id: "commands", label: "Commands", short: "cmds" },
  { id: "hooks", label: "Hooks", short: "hooks" },
  { id: "mcp", label: "MCP servers", short: "mcp" },
  { id: "plugins", label: "Plugins", short: "plugins" },
];

// "71 skills · 12 mcp · 7 hooks": the non-empty global + project counts in group order, at most `max` parts.
export function countSummary(counts, max = 3) {
  const g = counts?.global ?? {};
  const p = counts?.project ?? {};
  const parts = GROUPS.map((x) => ({ short: x.short, n: (g[x.id] ?? 0) + (p[x.id] ?? 0) })).filter((x) => x.n > 0);
  if (!parts.length) return "nothing configured";
  const word = (x) => (x.n === 1 && x.short.endsWith("s") ? x.short.slice(0, -1) : x.short);
  return parts.slice(0, max).map((x) => `${x.n} ${word(x)}`).join(" · ");
}

// The agent to show: the remembered one when it is still detected, else the first.
export function pickAgent(agents, saved) {
  if (!Array.isArray(agents) || !agents.length) return null;
  return agents.some((a) => a.id === saved) ? saved : agents[0].id;
}

// The next or previous agent id, wrapping around.
export function stepAgent(agents, id, dir) {
  if (!Array.isArray(agents) || !agents.length) return null;
  const i = agents.findIndex((a) => a.id === id);
  const n = agents.length;
  return agents[(((i < 0 ? 0 : i + dir) % n) + n) % n].id;
}

// One item's right-hand detail: MCP transport and program/host, the source folder, or the description.
export function itemDetail(groupId, it) {
  if (groupId === "mcp") return [it.transport, it.detail, it.desc, it.src].filter(Boolean).join(" · ");
  return [it.src, it.desc].filter(Boolean).join(" · ");
}

// A command from keys.json or `herdr-app do drover-agents.<cmd>`: next, prev, select:<id>, refresh,
// open:<global|project>.<kind>:<index> (show that listed file in the viewer), close (the viewer).
export function parseCommand(raw) {
  const s = String(raw ?? "").trim();
  if (s === "next" || s === "prev" || s === "refresh" || s === "close") return { action: s };
  const m = s.match(/^select:([A-Za-z0-9_-]{1,80})$/);
  if (m) return { action: "select", id: m[1] };
  const o = s.match(/^open:(global|project)\.(instructions|skills|agents|commands):(\d{1,5})$/);
  return o ? { action: "open", which: o[1], kind: o[2], index: Number(o[3]) } : null;
}

// ---------- Usage: token aggregates ----------

// Only an exact match: a Claude mirror or another agent has no token totals of its own here.
const TOKENS_ADAPTER = { claude: "claude", codex: "codex", opencode: "opencode", antigravity: "antigravity" };
const own = (map, id) => (Object.prototype.hasOwnProperty.call(map, id) ? map[id] : null);
export const tokensAdapter = (agentId) => own(TOKENS_ADAPTER, agentId);

// "2026-10-16" → "Oct 16".
export function dayLabel(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ""));
  if (!m) return "—";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(m[2]) - 1] ?? "?"} ${Number(m[3])}`;
}

export const percent1 = (r) => (r == null || !Number.isFinite(r) ? "—" : `${(Math.round(r * 1000) / 10).toFixed(1)}%`);

// 84 daily totals → 12 weekly columns of 7 heat levels (0 = none, 1..4 by share of the busiest day).
export function heatWeeks(days) {
  const list = Array.isArray(days) ? days.map((v) => (Number.isFinite(v) && v > 0 ? v : 0)) : [];
  const max = Math.max(0, ...list);
  const level = (v) => (v <= 0 || max <= 0 ? 0 : Math.min(4, 1 + Math.floor((v / max) * 3.999)));
  const weeks = [];
  for (let i = 0; i < list.length; i += 7) weeks.push(list.slice(i, i + 7).map(level));
  return weeks;
}

export const sizeLabel = (n) => (!Number.isFinite(n) ? "" : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** Whether the copy of `mod` in the layout tree is on screen: no hidden node above it, and the active
 *  child of every stack above it (a panel-body child that isn't the open panel is not on screen).
 *  True when the mod isn't in the tree (an overlay copy). */
export function visibleIn(node, mod) {
  const walk = (n, shown) => {
    if (!n || typeof n !== "object") return null;
    const here = shown && !n.hidden;
    if (n.content?.mod === mod) return here;
    let found = null;
    for (const c of n.children ?? []) {
      const r = walk(c, here && (n.type !== "stack" || n.active == null || n.active === c.id));
      if (r === true) return true;
      if (r === false) found = false;
    }
    for (const f of n.floating ?? []) {
      const r = walk(f, here);
      if (r === true) return true;
      if (r === false) found = false;
    }
    return found;
  };
  return walk(node, true) ?? true;
}

/** Below this measured width (logical px) the list and the detail stack into one column. */
export const NARROW_BELOW = 520;

/** True when `width` is a measured width under NARROW_BELOW. An unmeasured width (0, NaN, undefined)
 *  is not narrow, so the first frame draws the wide layout. */
export const narrow = (width) => Number.isFinite(width) && width > 0 && width < NARROW_BELOW;

/**
 * What a key does in the agents page. ctx: { key, ids (agent ids in list order), current (selected id),
 * small (narrow layout), page ("list" | "detail"), viewOpen }. Returns null when the key is not ours, else
 * { select?: id, page?: "list" | "detail", closeView?: true }. Up/Down clamp at the ends and only act while
 * the list is on screen; Enter opens the detail in the narrow layout; Escape closes the viewer first,
 * then leaves the narrow detail for the list.
 */
export function navKey({ key, ids = [], current = null, small = false, page = "list", viewOpen = false }) {
  if (key === "escape") {
    if (viewOpen) return { closeView: true };
    if (small && page === "detail") return { page: "list" };
    return null;
  }
  const listShown = !small || (page === "list" && !viewOpen);
  if (!listShown || !ids.length) return null;
  if (key === "up" || key === "down") {
    const i = ids.indexOf(current);
    const next = i < 0 ? 0 : Math.min(ids.length - 1, Math.max(0, i + (key === "down" ? 1 : -1)));
    return { select: ids[next] };
  }
  if (key === "enter" && small && ids.includes(current)) return { page: "detail" };
  return null;
}

// How probe.py is started, tried in order: on Windows the py launcher first (python.org installs no
// python3.exe), elsewhere exactly python3.
export const pythonCommands = (platform) => (platform === "windows" ? [["py", ["-3"]], ["python3", []]] : [["python3", []]]);
