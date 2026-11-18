// Pure logic for drover-projects: no host calls, so check.cjs runs it under plain node.
// Visits file, frecency, zoxide and find parsing, fuzzy ranking, the project list and the
// commands each action runs.
import { tilde, resolve, basename } from "./lib/paths.js";
import { denyReason } from "./lib/guard.js";

export const MOD = "drover-projects";
export const KEYS = {
  pins: `${MOD}.pins`,
  roots: `${MOD}.roots`,
  agent: `${MOD}.agent`,
  hidden: `${MOD}.hidden`,
};
export const DEFAULT_AGENT = ["claude"];

// One visit per path per 30 minutes, however many copies sample it.
export const VISIT_GAP_MS = 30 * 60 * 1000;
export const MAX_VISITS_PER_PATH = 30;
export const MAX_PATHS = 500;
export const MAX_AGE_MS = 90 * 24 * 3600 * 1000;
// readTextFile stops at 1 MiB: stay far below it so the file can always be read back.
export const MAX_FILE_BYTES = 512 * 1024;

export const SCAN_DEPTH = 2;
export const MARKERS = [
  ".git", "package.json", "go.mod", "Cargo.toml", "pyproject.toml", "setup.py", "requirements.txt",
  "*.csproj", "*.fsproj", "*.sln", "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile",
  "composer.json", "mix.exs", "deno.json", "Package.swift", "pubspec.yaml", "CMakeLists.txt",
  "flake.nix", "stack.yaml", "dune-project",
];
// Never descended into while scanning roots.
export const PRUNE = [
  "node_modules", ".venv", "venv", "vendor", "target", "dist", "build", ".build", "Library",
  ".Trash", ".cache", ".npm", ".cargo", ".rustup", "Pods", "DerivedData", "bin", "obj",
];
export const MAX_SCAN_RESULTS = 1000;
export const ROOT_SUGGESTIONS = ["~/projects", "~/Projects", "~/code", "~/src", "~/dev", "~/work", "~/repos", "~/Developer", "~/Documents/projects"];

// ---------- machines and keys ----------

/** The machine part of a key: "" for this computer. */
export const machineKey = (machine) => (machine ? String(machine) : "");
export const keyOf = (machine, path) => `${machineKey(machine)}\t${path}`;
export function parseKey(key) {
  const i = String(key).indexOf("\t");
  if (i < 0) return null;
  const m = key.slice(0, i);
  return { machine: m || null, path: key.slice(i + 1) };
}
export const sameMachine = (a, b) => machineKey(a) === machineKey(b);

/** This computer first, then every other machine machines() or a space names, sorted. */
export function machineList(machineInfos, spaceInfos) {
  const state = new Map();
  for (const m of machineInfos ?? []) state.set(machineKey(m?.name), m?.layout ?? "unavailable");
  for (const s of spaceInfos ?? []) if (s?.machine && !state.has(s.machine)) state.set(s.machine, "unavailable");
  const others = [...state.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b));
  return [
    { name: null, label: "This computer", layout: state.get("") ?? "ready" },
    ...others.map((n) => ({ name: n, label: n, layout: state.get(n) })),
  ];
}

// ---------- paths ----------

/** "~/x" with that machine's home, else the absolute, normalized path; null for anything else. */
export function expandPath(p, home) {
  const s = String(p ?? "").trim();
  if (!s || s.includes("\0") || s.includes("\n")) return null;
  let full = s;
  if (s === "~") full = home;
  else if (s.startsWith("~/")) full = home ? `${home}/${s.slice(2)}` : null;
  if (!full || !full.startsWith("/")) return null;
  const r = resolve(full);
  return r && r.length > 1 ? r.replace(/\/+$/, "") : r;
}

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

/** Why this path must not be listed or opened (credential folders), or null. */
// Windows drive paths are checked with every part trimmed the way Windows reads them; a stream or 8.3 name is refused.
// platform "windows" (this computer only) also refuses anything that is not a full drive path.
export const blockedPath = (p, platform) => {
  const w = windowsParts(p);
  if (w) return w.error ?? denyReason(w.path);
  return platform === "windows" ? "not a full drive path" : denyReason(p);
};

/** Not a project: the filesystem root and the machine's home. */
const HOME_FOLDERS = new Set(["Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures", "Public", "Applications"]);
export function boringPath(p, home) {
  if (!p || p === "/") return true;
  // One level below the root (/opt, /usr, /tmp): system folders, not projects.
  if (/^\/[^/]+\/?$/.test(p)) return true;
  const h = home ? home.replace(/\/+$/, "") : null;
  if (!h) return false;
  if (p === h) return true;
  if (p.startsWith(h + "/")) {
    const rest = p.slice(h.length + 1);
    return !rest.includes("/") && HOME_FOLDERS.has(rest);
  }
  return false;
}

export const displayPath = (p, home) => tilde(p, home);

// ---------- visits file ----------

export const emptyStore = () => ({ version: 1, entries: {} });

/** Parses visits.json; anything unreadable is an empty store (never throws). */
export function parseVisits(raw) {
  const out = emptyStore();
  if (!raw) return out;
  let data;
  try { data = JSON.parse(raw); } catch { return out; }
  const entries = data && typeof data === "object" && data.entries && typeof data.entries === "object" ? data.entries : {};
  for (const [key, list] of Object.entries(entries)) {
    if (!parseKey(key) || !Array.isArray(list)) continue;
    const ts = list.filter((n) => Number.isFinite(n) && n > 0).map(Math.floor);
    if (ts.length) out.entries[key] = [...new Set(ts)].sort((a, b) => a - b);
  }
  return out;
}

/** Adds visit times, keeping at most one per VISIT_GAP_MS (so two samplers never double count). */
function addTimes(list, times) {
  const all = [...(list ?? []), ...times].sort((a, b) => a - b);
  const out = [];
  for (const t of all) if (!out.length || t - out[out.length - 1] >= VISIT_GAP_MS) out.push(t);
  return out;
}

/** True when a sample at `now` would count as a new visit for this key. */
export function wouldCount(store, key, now) {
  const list = store.entries[key];
  return !list?.length || now - list[list.length - 1] >= VISIT_GAP_MS;
}

/** Records a sample; returns true when it counted. */
export function addSample(store, key, now) {
  if (!parseKey(key) || !wouldCount(store, key, now)) return false;
  store.entries[key] = addTimes(store.entries[key], [now]);
  return true;
}

/** a ∪ b, with the gap rule applied across both. */
export function mergeStores(a, b) {
  const out = emptyStore();
  for (const s of [a, b]) for (const [key, list] of Object.entries(s?.entries ?? {})) out.entries[key] = addTimes(out.entries[key], list);
  return out;
}

/** Drops old visits, keeps the newest MAX_VISITS_PER_PATH per path and the MAX_PATHS best paths. */
export function pruneStore(store, now) {
  const kept = [];
  for (const [key, list] of Object.entries(store.entries)) {
    const fresh = list.filter((t) => now - t <= MAX_AGE_MS && t <= now + 60000).slice(-MAX_VISITS_PER_PATH);
    if (fresh.length) kept.push([key, fresh, frecency(fresh, now)]);
  }
  kept.sort((x, y) => y[2] - x[2] || y[1][y[1].length - 1] - x[1][x[1].length - 1]);
  const out = emptyStore();
  for (const [key, list] of kept.slice(0, MAX_PATHS)) out.entries[key] = list;
  return out;
}

/** Text for the file, pruned again until it fits MAX_FILE_BYTES. */
export function serializeVisits(store, now) {
  let s = pruneStore(store, now);
  for (;;) {
    const text = JSON.stringify(s);
    const keys = Object.keys(s.entries);
    if (text.length <= MAX_FILE_BYTES || keys.length <= 1) return text;
    const trimmed = emptyStore();
    for (const k of keys.slice(0, Math.floor(keys.length * 0.8))) trimmed.entries[k] = s.entries[k];
    s = trimmed;
  }
}

// ---------- frecency ----------

const HOUR = 3600 * 1000;
/** zoxide-like age buckets. */
export function weight(age) {
  if (age < 4 * HOUR) return 4;
  if (age < 24 * HOUR) return 2;
  if (age < 7 * 24 * HOUR) return 0.5;
  return 0.25;
}
export const frecency = (times, now) => (times ?? []).reduce((sum, t) => sum + weight(Math.max(0, now - t)), 0);

// ---------- zoxide and find ----------

/** `zoxide query -ls`: "  12.5 /path" lines. */
export function parseZoxide(stdout) {
  const out = [];
  for (const line of String(stdout ?? "").split("\n")) {
    const m = /^\s*(\d+(?:\.\d+)?)\s+(\/.*\S)\s*$/.exec(line);
    if (m) out.push({ path: m[2], score: Number(m[1]) });
  }
  return out;
}

/** zoxide's score as a frecency seed: below one fresh visit, so the mod's own samples lead. */
export const zoxideSeed = (score) => Math.min(3, Math.log10(1 + Math.max(0, score)));

/** argv for find: folders up to `depth` below root holding a marker. Depth options first (GNU find). */
export function findArgs(root, depth = SCAN_DEPTH) {
  const names = (list) => list.flatMap((n, i) => (i ? ["-o", "-name", n] : ["-name", n]));
  return [
    root, "-mindepth", "1", "-maxdepth", String(depth + 1),
    "(", ...names(PRUNE), ")", "-prune",
    "-o", "-name", ".git", "-prune", "-print",
    "-o", "(", ...names(MARKERS.filter((m) => m !== ".git")), ")", "-print",
  ];
}

/** Folders that hold a marker, from find's output, unique, inside root, never credential folders. */
export function parseFind(stdout, root) {
  const r = String(root).replace(/\/+$/, "");
  const seen = new Set();
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line.startsWith(r + "/")) continue;
    const i = line.lastIndexOf("/");
    const dir = i > 0 ? line.slice(0, i) : null;
    if (!dir || blockedPath(dir) || seen.has(dir)) continue;
    seen.add(dir);
    if (seen.size >= MAX_SCAN_RESULTS) break;
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** Project markers Recent requires (a folder needs one of these, unless pinned). */
export const RECENT_MARKERS = [
  ".git", "package.json", "go.mod", "Cargo.toml", "*.csproj", "*.sln", "pyproject.toml", "pubspec.yaml",
  "build.gradle", "build.gradle.kts", "Package.swift", "Gemfile", "composer.json",
];
export const MARKER_BATCH = 80;

/** argv for find: the markers directly inside each of `paths` (no recursion). */
export function markerArgs(paths) {
  const names = RECENT_MARKERS.flatMap((n, i) => (i ? ["-o", "-name", n] : ["-name", n]));
  return [...paths, "-mindepth", "1", "-maxdepth", "1", "(", ...names, ")", "-print"];
}

/** The folders of `paths` that find said hold a marker. */
export function parseMarkers(stdout, paths) {
  const want = new Set((paths ?? []).map((p) => String(p).replace(/\/+$/, "") || "/"));
  const out = new Set();
  for (const line of String(stdout ?? "").split("\n")) {
    const i = line.lastIndexOf("/");
    if (i < 0) continue;
    const dir = i === 0 ? "/" : line.slice(0, i);
    if (want.has(dir)) out.add(dir);
  }
  return out;
}

/** Recent candidates still to be checked for a marker: not pinned, not found by the roots scan, unknown so far. */
export function markerTodo(items, known) {
  return (items ?? []).filter((i) => !i.pinned && !i.scanned && i.score > 0 && !known.has(i.path)).map((i) => i.path).slice(0, MARKER_BATCH);
}

// ---------- shared settings ----------

/** Pins as stored in shared state: [{machine, path, label?}], cleaned. */
export function readPins(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const p of value) {
    if (!p || typeof p.path !== "string" || !p.path.startsWith("/")) continue;
    const key = keyOf(p.machine ?? null, p.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ machine: p.machine || null, path: p.path, ...(typeof p.label === "string" && p.label ? { label: p.label } : {}) });
  }
  return out;
}
export function togglePin(pins, machine, path) {
  const list = readPins(pins);
  const key = keyOf(machine, path);
  const i = list.findIndex((p) => keyOf(p.machine, p.path) === key);
  if (i >= 0) list.splice(i, 1);
  else list.push({ machine: machine || null, path });
  return list;
}

/** Roots per machine: {"": ["~/projects"], "box": ["/srv"]}. */
export function readRoots(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [m, list] of Object.entries(value)) {
    if (!Array.isArray(list)) continue;
    const clean = [...new Set(list.filter((r) => typeof r === "string" && (r.startsWith("/") || r === "~" || r.startsWith("~/"))))];
    if (clean.length) out[m] = clean;
  }
  return out;
}
/** A root typed or picked: "~/x" kept as typed (portable), else absolute; null when it isn't a usable folder. */
export function normalizeRoot(text, home) {
  const s = String(text ?? "").trim().replace(/\/+$/, "") || "";
  if (!s) return null;
  const full = expandPath(s, home);
  if (!full || full === "/") return null;
  if (blockedPath(full)) return null;
  if (home && full.startsWith(home.replace(/\/+$/, "") + "/")) return "~" + full.slice(home.replace(/\/+$/, "").length);
  if (home && full === home.replace(/\/+$/, "")) return "~";
  return full;
}
export function addRoot(roots, machine, root) {
  const all = readRoots(roots);
  const m = machineKey(machine);
  all[m] = [...new Set([...(all[m] ?? []), root])];
  return all;
}
export function removeRoot(roots, machine, root) {
  const all = readRoots(roots);
  const m = machineKey(machine);
  all[m] = (all[m] ?? []).filter((r) => r !== root);
  if (!all[m].length) delete all[m];
  return all;
}

/** The agent's argv: shared value (array of words), else the default. */
export function readAgent(value) {
  if (Array.isArray(value) && value.length && value.every((w) => typeof w === "string" && w.length && !w.includes("\0"))) return value.slice();
  return DEFAULT_AGENT.slice();
}
/** Words of a typed command, split on blanks (no shell: quotes are not interpreted). Null when empty. */
export function parseAgentText(text) {
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.some((w) => w.includes("\0"))) return null;
  return words;
}

export const readHidden = (value) => (Array.isArray(value) ? value.filter((k) => typeof k === "string" && parseKey(k)) : []);

// ---------- the project list ----------

/** A space already at this folder on this machine, or null. */
export function spaceAt(spaceInfos, machine, path) {
  return (spaceInfos ?? []).find((s) => sameMachine(s.machine, machine) && s.folder && s.folder.replace(/\/+$/, "") === path) ?? null;
}

/**
 * Every project on `machine`: pins, visited (own samples), zoxide, scanned. Each:
 * {key, machine, path, name, pinned, score, visits, last, zoxide, scanned, space}
 */
export function buildProjects({ machine, pins, store, zoxide, scanned, hidden, spaces: spaceInfos, home, now }) {
  const m = machineKey(machine);
  const map = new Map();
  const hide = new Set(hidden ?? []);
  const get = (path) => {
    const p = String(path).replace(/\/+$/, "") || "/";
    if (blockedPath(p)) return null;
    const key = keyOf(machine, p);
    if (!map.has(key)) {
      map.set(key, { key, machine: machine || null, path: p, name: basename(p) || p, pinned: false, label: null, score: 0, visits: 0, last: 0, zoxide: 0, scanned: false, space: null });
    }
    return map.get(key);
  };
  for (const p of readPins(pins)) {
    if (machineKey(p.machine) !== m) continue;
    const it = get(p.path);
    if (it) { it.pinned = true; it.label = p.label ?? null; }
  }
  for (const [key, list] of Object.entries(store?.entries ?? {})) {
    const k = parseKey(key);
    if (!k || machineKey(k.machine) !== m || boringPath(k.path, home)) continue;
    const it = get(k.path);
    if (!it) continue;
    it.visits = list.length;
    it.last = list[list.length - 1] ?? 0;
    it.score += frecency(list, now);
  }
  for (const z of zoxide ?? []) {
    if (boringPath(z.path, home)) continue;
    const it = get(z.path);
    if (!it) continue;
    it.zoxide = z.score;
    it.score += zoxideSeed(z.score);
  }
  for (const p of scanned ?? []) {
    if (boringPath(p, home)) continue;
    const it = get(p);
    if (it) it.scanned = true;
  }
  const out = [];
  for (const it of map.values()) {
    if (hide.has(it.key) && !it.pinned) continue;
    it.space = spaceAt(spaceInfos, machine, it.path)?.id ?? null;
    out.push(it);
  }
  return out;
}

/**
 * Sections when nothing is typed: Pinned, Recent (score > 0), In your folders (the rest, by name).
 * `isProject(item)`: false drops a folder without a project marker from Recent (pinned and scanned always stay).
 */
export function sections(items, recentLimit = 40, isProject = null) {
  const byName = (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
  const pinned = items.filter((i) => i.pinned).sort(byName);
  const recent = items.filter((i) => !i.pinned && i.score > 0 && (i.scanned || !isProject || isProject(i) !== false)).sort((a, b) => b.score - a.score || b.last - a.last || byName(a, b)).slice(0, recentLimit);
  const shown = new Set([...pinned, ...recent].map((i) => i.key));
  const rest = items.filter((i) => !shown.has(i.key) && (i.scanned || !isProject || isProject(i) !== false)).sort(byName);
  return [
    { id: "pinned", title: "Pinned", items: pinned },
    { id: "recent", title: "Recent", items: recent },
    { id: "found", title: "In your folders", items: rest },
  ].filter((s) => s.items.length);
}

// ---------- fuzzy ----------

const isBoundary = (ch) => ch === "/" || ch === "-" || ch === "_" || ch === "." || ch === " ";

/** Subsequence match of one word; {score, positions} or null. Case-insensitive. */
export function fuzzyWord(word, text) {
  const q = word.toLowerCase();
  const s = text.toLowerCase();
  if (!q) return { score: 0, positions: [] };
  // Prefer a contiguous hit.
  const at = s.indexOf(q);
  if (at >= 0) {
    const boundary = at === 0 || isBoundary(s[at - 1]);
    return { score: 10 * q.length + (boundary ? 15 : 0), positions: Array.from({ length: q.length }, (_, i) => at + i) };
  }
  const positions = [];
  let score = 0;
  let j = 0;
  for (let i = 0; i < s.length && j < q.length; i++) {
    if (s[i] !== q[j]) continue;
    let bonus = 1;
    if (i === 0 || isBoundary(s[i - 1])) bonus += 4;
    if (positions.length && positions[positions.length - 1] === i - 1) bonus += 3;
    score += bonus;
    positions.push(i);
    j++;
  }
  if (j < q.length) return null;
  return { score: score - Math.min(10, (positions[positions.length - 1] - positions[0]) / 4), positions };
}

/** Every blank-separated word must match the name or the path; the name counts more. */
export function fuzzy(query, item, home) {
  const words = String(query ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { score: 0, positions: [] };
  const name = item.label || item.name;
  const shown = displayPath(item.path, home);
  let score = 0;
  const positions = [];
  for (const w of words) {
    const inName = fuzzyWord(w, name);
    const inPath = fuzzyWord(w, shown);
    if (!inName && !inPath) return null;
    if (inName && (!inPath || inName.score * 2 >= inPath.score)) {
      score += inName.score * 2;
      positions.push(...inName.positions);
    } else score += inPath.score;
  }
  return { score, positions: [...new Set(positions)].sort((a, b) => a - b) };
}

/** Ranked hits for a query: [{item, positions}]. */
export function rank(items, query, home) {
  const hits = [];
  for (const item of items) {
    const f = fuzzy(query, item, home);
    if (!f) continue;
    hits.push({ item, positions: f.positions, score: f.score + Math.log2(1 + item.score) * 3 + (item.pinned ? 8 : 0) });
  }
  hits.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  return hits;
}

/** Text pieces for drawing matches bold. */
export function segments(text, positions) {
  const on = new Set(positions ?? []);
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const hit = on.has(i);
    if (out.length && out[out.length - 1].on === hit) out[out.length - 1].text += text[i];
    else out.push({ text: text[i], on: hit });
  }
  return out;
}

export const move = (at, by, n) => (n ? Math.min(n - 1, Math.max(0, at + by)) : 0);

// ---------- actions ----------

/**
 * What each action does for a project, or why it can't: {id, label, enabled, reason}.
 * ctx: {machineReady, activeSpace, platform, installed: {git, files}, agent}
 */
const REVEAL_PLATFORMS = new Set(["macos", "linux", "windows"]);
export const COMMA_PATH = "Explorer can't open paths with a comma. Copy the path instead.";
export const DRIVE_PATH = "Explorer shows only a full drive path such as C:\\work. Copy the path instead.";
/** The reveal action's name in the system's own words. */
export const revealLabel = (platform) =>
  platform === "linux" ? "Show in file manager" : platform === "windows" ? "Show in Explorer" : "Reveal in Finder";

/**
 * What a reveal exec came back with (r = result, or the Error it threw): null when it worked, else the message to show.
 * explorer.exe exits 1 even when it opened the folder, so its code is ignored.
 */
export function revealOutcome(platform, r) {
  if (r instanceof Error || !r) {
    if (/program not found/i.test(String(r?.message ?? ""))) {
      if (platform === "linux") return "xdg-open is missing. Install xdg-utils to open files.";
      if (platform === "windows") return "explorer.exe was not found.";
    }
    return "The file manager couldn't show that folder.";
  }
  if (r.code !== 0 && platform !== "windows") return "The file manager couldn't show that folder.";
  return null;
}

/**
 * False only for this computer on Windows: listing, scanning and marker checks run POSIX tools
 * (find, printenv) and take "/" paths, so there they are skipped with a note. Other machines still work.
 */
export const listsFolders = (platform, machine) => Boolean(machine) || platform !== "windows";

export function actionsFor(item, ctx) {
  const off = (reason) => ({ enabled: false, reason });
  const on = { enabled: true, reason: null };
  const ready = ctx.machineReady;
  const away = ready ? null : "This machine isn't connected.";
  const tabHere = !ctx.activeSpace ? off("No space is open.")
    : !sameMachine(ctx.activeSpace.machine, item.machine) ? off("The current space is on another machine.")
      : away ? off(away) : on;
  const reveal = item.machine ? off("Only folders on this computer can be shown in the file manager.")
    : !REVEAL_PLATFORMS.has(ctx.platform) ? off("Not supported on this system.")
      : ctx.platform === "windows" && String(item.path ?? "").includes(",") ? off(COMMA_PATH)
        : ctx.platform === "windows" && !windowsParts(item.path)?.path ? off(DRIVE_PATH) : on;
  const agentName = (ctx.agent ?? DEFAULT_AGENT).join(" ");
  // drover-git takes the machine from props.on, and falls back to the focused space's machine
  // when it is null: a folder on this computer needs a space on this computer to be shown.
  const git = !ctx.installed?.git ? off("drover-git is not installed.") : away ? off(away)
    : !item.machine && ctx.activeSpace && !sameMachine(ctx.activeSpace.machine, null)
      ? off("Switch to a space on this computer first: Git follows the shown space's machine.") : on;
  // drover-files reads props.folder on this computer only.
  const files = !ctx.installed?.files ? off("drover-files is not installed.") : away ? off(away)
    : item.machine ? off("Files shows folders on this computer only.") : on;
  return [
    { id: "open", label: item.space ? "Go to space" : "Open", ...(item.space ? on : away ? off(away) : on) },
    { id: "space", label: "New space", ...(away ? off(away) : on) },
    { id: "agent", label: `New space + ${agentName}`, ...(away ? off(away) : on) },
    { id: "tab", label: "Open as tab here", ...tabHere },
    { id: "git", label: "Git", ...git },
    { id: "files", label: "Files", ...files },
    { id: "pin", label: item.pinned ? "Unpin" : "Pin", ...on },
    { id: "reveal", label: revealLabel(ctx.platform), ...reveal },
    { id: "hide", label: "Hide from list", ...(item.pinned ? off("Unpin it first.") : on) },
  ];
}

/** Which actions open the folder (and so check it exists first). */
export const NEEDS_FOLDER = new Set(["open", "space", "agent", "tab", "git", "files", "reveal"]);

/**
 * The host calls an action makes: [["run", name, args] | ["overlay", spec] | ["exec", cmd, args]].
 * Pin and hide are shared-state changes handled by the caller.
 */
export function commandsFor(id, item, ctx) {
  const machine = machineKey(item.machine);
  const name = item.label || item.name;
  switch (id) {
    case "open":
      if (item.space) return [["run", "space.select", { id: item.space }]];
      return [["run", "space.new", { name, folder: item.path, machine }]];
    case "space":
      return [["run", "space.new", { name, folder: item.path, machine }]];
    case "agent":
      return [["run", "space.new", { name, folder: item.path, machine, argv: (ctx.agent ?? DEFAULT_AGENT).slice() }]];
    case "tab":
      return [["run", "tab.new", { name, space: ctx.activeSpace.id, folder: item.path }]];
    case "git":
      return [["overlay", { mod: "drover-git", kind: "dialog", width: 1100, height: 720, props: item.machine ? { cwd: item.path, on: item.machine } : { cwd: item.path } }]];
    case "files":
      if (ctx.activeSpace && sameMachine(ctx.activeSpace.machine, item.machine)) {
        return [["run", "tab.new", { name, space: ctx.activeSpace.id, mod: "drover-files", props: { folder: item.path } }]];
      }
      return [["overlay", { mod: "drover-files", kind: "dialog", width: 900, height: 640, props: { folder: item.path } }]];
    case "reveal":
      // explorer.exe splits its arguments at commas, and gets only a full drive path; a drive root stays "C:\".
      if (ctx.platform === "windows") {
        const w = windowsParts(item.path);
        return String(item.path).includes(",") || !w?.path ? [] : [["exec", "explorer.exe", [w.path.replace(/\//g, "\\")]]];
      }
      return ctx.platform === "linux" ? [["exec", "xdg-open", [item.path]]] : [["exec", "open", ["-R", item.path]]];
    default:
      return [];
  }
}

/** argv for git rev-parse --show-toplevel without the parent app's routing variables or prompts. */
export const toplevelArgv = () => ["-u", "HERDR_ENV", "-u", "HERDR_SOCKET_PATH", "-u", "HERDR_PANE_ID", "GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=never", "git", "--no-optional-locks", "rev-parse", "--show-toplevel"];
