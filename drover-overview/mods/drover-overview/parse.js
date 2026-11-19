// Pure parsers for the command output the Overview reads. No herdr imports: node --test loads this file.

const clamp = (n) => Math.max(0, Math.min(100, n));
const unescape = (s) => s.replace(/\\x([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));

// `ps -A -o %cpu=` summed over `cores`: percent of the whole machine, or null.
export function parsePsCpu(out, cores) {
  let sum = 0;
  let seen = false;
  for (const line of (out ?? "").split("\n")) {
    const v = parseFloat(line.trim());
    if (Number.isFinite(v)) { sum += v; seen = true; }
  }
  if (!seen || !(cores > 0)) return null;
  return clamp(sum / cores);
}

// `sysctl -n hw.memsize hw.ncpu`: { memBytes, cores }, or null.
export function parseSysctl(out) {
  const [mem, cores] = (out ?? "").trim().split(/\s+/).map(Number);
  if (!(mem > 0) || !(cores > 0)) return null;
  return { memBytes: mem, cores };
}

// `vm_stat` and the total bytes: used percent as Activity Monitor counts it
// (wired + active + compressed), or null. The page size is in its header.
export function parseVmStat(out, memBytes) {
  const text = out ?? "";
  const page = Number(text.match(/page size of (\d+) bytes/)?.[1]);
  const pages = (label) => Number(text.match(new RegExp(`^${label}:\\s+(\\d+)`, "m"))?.[1] ?? NaN);
  const used = pages("Pages wired down") + pages("Pages active") + pages("Pages occupied by compressor");
  if (!(page > 0) || !Number.isFinite(used) || !(memBytes > 0)) return null;
  return clamp((used * page * 100) / memBytes);
}

// The aggregate `cpu` line of /proc/stat: { idle, total } jiffies, or null.
export function parseProcStat(out) {
  const m = (out ?? "").match(/^cpu\s+([\d\s]+)$/m);
  if (!m) return null;
  const v = m[1].trim().split(/\s+/).map(Number);
  if (v.length < 4) return null;
  const total = v.reduce((a, b) => a + b, 0);
  const idle = v[3] + (v[4] ?? 0); // idle + iowait
  return { idle, total };
}

// Busy percent between two parseProcStat samples, or null.
export function cpuFromSamples(prev, next) {
  if (!prev || !next) return null;
  const total = next.total - prev.total;
  const idle = next.idle - prev.idle;
  if (!(total > 0)) return null;
  return clamp(((total - idle) * 100) / total);
}

// /proc/loadavg with a core count: the 1-minute load as a percent, or null.
export function parseLoadAvg(out, cores) {
  const load = parseFloat((out ?? "").match(/^\s*([\d.]+)\s+[\d.]+\s+[\d.]+/m)?.[1]);
  if (!Number.isFinite(load) || !(cores > 0)) return null;
  return clamp((load * 100) / cores);
}

// Number of `processor` entries in /proc/cpuinfo or `cpuN` lines in /proc/stat.
export function parseCores(out) {
  const n = ((out ?? "").match(/^cpu\d+\s/gm) ?? []).length;
  return n > 0 ? n : null;
}

// /proc/meminfo: used percent (MemTotal - MemAvailable), or null.
export function parseMemInfo(out) {
  const kb = (key) => Number((out ?? "").match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] ?? NaN);
  const total = kb("MemTotal");
  let avail = kb("MemAvailable");
  if (!Number.isFinite(avail)) avail = kb("MemFree") + (kb("Buffers") || 0) + (kb("Cached") || 0);
  if (!(total > 0) || !Number.isFinite(avail)) return null;
  return clamp(((total - avail) * 100) / total);
}

// `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits`:
// { gpu, vram } averaged over GPUs (VRAM pooled), or null.
export function parseNvidiaSmi(out) {
  const rows = (out ?? "").split("\n")
    .map((l) => l.split(",").map((x) => parseFloat(x.trim())))
    .filter((r) => r.length >= 3 && r.slice(0, 3).every(Number.isFinite));
  if (!rows.length) return null;
  const gpu = rows.reduce((a, r) => a + r[0], 0) / rows.length;
  const used = rows.reduce((a, r) => a + r[1], 0);
  const total = rows.reduce((a, r) => a + r[2], 0);
  return { gpu: clamp(gpu), vram: total > 0 ? clamp((used * 100) / total) : null };
}

const portOf = (addr) => {
  const p = Number(addr.slice(addr.lastIndexOf(":") + 1));
  return Number.isInteger(p) && p > 0 ? p : null;
};

// One entry per port, lowest first.
function uniquePorts(list) {
  const byPort = new Map();
  for (const x of list) {
    if (x.port == null) continue;
    const had = byPort.get(x.port);
    if (!had || (!had.name && x.name)) byPort.set(x.port, x);
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

// `lsof +c 0 -nP -iTCP -sTCP:LISTEN`: [{ port, name }].
export function parseLsof(out) {
  const list = [];
  for (const line of (out ?? "").split("\n")) {
    const m = line.match(/^(\S+)\s+\d+\s.*\sTCP\s+(\S+)\s+\(LISTEN\)\s*$/);
    if (!m) continue;
    list.push({ port: portOf(m[2]), name: unescape(m[1]) });
  }
  return uniquePorts(list);
}

// `ss -ltnp` (the header line is skipped): [{ port, name }]; name is null when ss can't see the owner (another user's process).
export function parseSs(out) {
  const list = [];
  for (const line of (out ?? "").split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || !/^LISTEN$/i.test(cols[0])) continue;
    const name = line.match(/users:\(\("([^"]+)"/)?.[1] ?? null;
    list.push({ port: portOf(cols[3]), name });
  }
  return uniquePorts(list);
}

// `netstat -ano` (Windows), TCP rows only: [{ port, pid }]. The state word is translated on non-English
// Windows, so a listener is known by its foreign address, 0.0.0.0:0 or [::]:0.
export function parseNetstat(out) {
  const list = [];
  for (const line of (out ?? "").split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0].toUpperCase() !== "TCP" || !/^(?:0\.0\.0\.0|\[::\]):0$/.test(cols[2])) continue;
    const pid = Number(cols[cols.length - 1]);
    list.push({ port: portOf(cols[1]), pid: Number.isInteger(pid) ? pid : null });
  }
  return list;
}

// `tasklist /FO CSV /NH`: pid -> program name, without ".exe".
export function parseTasklist(out) {
  const names = new Map();
  for (const line of (out ?? "").split("\n")) {
    const m = line.match(/^"([^"]*)","(\d+)"/);
    if (m) names.set(Number(m[2]), m[1].replace(/\.exe$/i, ""));
  }
  return names;
}

// Windows listeners with their names: [{ port, name }].
export const windowsPorts = (netstat, tasklist) => {
  const names = parseTasklist(tasklist);
  return uniquePorts(parseNetstat(netstat).map((x) => ({ port: x.port, name: names.get(x.pid) ?? null })));
};

// The system `uname -s` names; Git Bash, MSYS and Cygwin on Windows count as Windows.
export const osName = (uname) => (/^(?:MINGW|MSYS|CYGWIN)/i.test(uname ?? "") ? "Windows" : uname || null);

// "now" under a minute, then 2m, 3h, 4d.
export function ago(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// Whether the layout block showing `mod` is on screen: no hidden node above it and,
// in a stack, the active child. Not found in the layout (an overlay or a pane): shown.
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

// ---- Inbox: sections, snooze, settle, reply ----

export const SECTION_ORDER = ["needs", "done", "working", "idle", "snoozed"];

// The wake time in a `snoozed=<ms>` label, or 0 (none, empty, or not a number).
export function snoozeAt(label) {
  const n = Number(label);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// A `settled=<ms>:<turn>` label holds while the agent isn't busy and no turn has ended since.
// Same rule as the inbox, so both agree on what is settled.
export function isSettled(label, status, turn) {
  if (!label || status === "working" || status === "blocked") return false;
  return (turn ?? 0) <= Number(String(label).split(":")[1]);
}

// The value for `settled=`: when, and the turn it was settled at.
export const settleValue = (now, turn) => `${now}:${turn ?? 0}`;

// The inbox section of one agent: Needs you whenever it is blocked (a snooze never hides a
// prompt), else snoozed until it wakes, else its state; a settled Done is Idle. Anything
// without a known status counts as idle.
export function sectionOf({ status, snooze, settled, turn }, now) {
  if (status === "blocked") return "needs";
  if (snooze > now) return "snoozed";
  if (status === "working") return "working";
  if (status === "done") return isSettled(settled, status, turn) ? "idle" : "done";
  return "idle";
}

// Rows ({ status, snooze, settled, turn, at }) into the non-empty sections in order,
// each longest-waiting first (oldest `at` first). Ties keep the input order.
export function groupRows(rows, now) {
  const by = new Map(SECTION_ORDER.map((id) => [id, []]));
  for (const r of rows) by.get(sectionOf(r, now)).push(r);
  return SECTION_ORDER.map((id) => ({ id, rows: by.get(id).sort((x, y) => x.at - y.at) })).filter((g) => g.rows.length);
}

// The soonest wake time still ahead among the rows, or 0.
export function nextWake(rows, now) {
  let next = 0;
  for (const r of rows) if (r.snooze > now && (!next || r.snooze < next)) next = r.snooze;
  return next;
}

// The snooze choices: 15 min, 1 h, and 9:00 local tomorrow.
export function snoozePresets(now) {
  const d = new Date(now);
  const tomorrow = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 9).getTime();
  return [
    { id: "15m", label: "15 min", at: now + 15 * 60000 },
    { id: "1h", label: "1 hour", at: now + 3600000 },
    { id: "tomorrow", label: "Tomorrow", at: tomorrow },
  ];
}

// `hc label <address> key=value`; an empty value removes the label.
export const labelArgs = (address, key, value) => ["label", address, `${key}=${value}`];

// ---- Reply: a snapshot of the agent when the box opens, checked again before the send ----

// Lines at the bottom of the screen that count for a waiting agent's question.
export const REGION_LINES = 24;

// The reply text without trailing whitespace, or null when blank.
export function sendBody(text) {
  const body = String(text ?? "").replace(/\s+$/, "");
  return body.trim() ? body : null;
}

// `hc send`: pastes the text and presses Enter. "--" keeps text starting with "-" a text.
// A waiting (blocked) agent needs --force; idle and working use --if, which hc checks again
// right before it types. Done has no --if word. Null for any other state, blank text or no address.
export function replyArgs(address, body, state) {
  if (!address || !sendBody(body)) return null;
  const opts = { blocked: ["--force"], idle: ["--if", "idle"], working: ["--if", "working"], done: [] }[state];
  if (!opts) return null;
  return ["send", ...opts, "--json", "--", address, body];
}

export const getArgs = (address) => ["get", "--json", "--", address];
export const readArgs = (address) => ["read", "--json", "--lines", "0", "--", address];

// 64-bit FNV-1a over UTF-16 code units, as 16 hex digits. Spots drift, not forgery.
export function hash(text) {
  const s = String(text ?? "");
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

// The parsed `hc get --json` of a terminal -> only what a reply is checked against, or null when
// it is not live or lacks a status, app or foreground pid. Nothing else (argv, cwd, labels) is kept.
export function snapOf(term, regionHash) {
  if (!term || term.state !== "live") return null;
  const st = term.status;
  const pid = term.foreground?.pid;
  if (!st || typeof st.state !== "string" || typeof st.app !== "string" || !st.app || !Number.isInteger(pid)) return null;
  return {
    pid,
    app: st.app,
    state: st.state,
    kind: st.kind ?? null,
    statusMs: term.status_ms ?? null,
    turn: term.turn ?? 0,
    msgHash: hash(st.msg ?? ""),
    regionHash: regionHash ?? null,
  };
}

// Same process, app, state and turn. A waiting agent must also show the same question: same
// status time, kind, message and screen region. For idle, working and done, hc's own check is the fence.
export function sameSnap(a, b) {
  if (!a || !b) return false;
  if (a.pid !== b.pid || a.app !== b.app || a.state !== b.state || a.turn !== b.turn) return false;
  if (a.state !== "blocked") return true;
  return a.statusMs === b.statusMs && a.kind === b.kind && a.msgHash === b.msgHash && a.regionHash === b.regionHash;
}

// The last REGION_LINES non-empty-tailed lines of a screen, CRLF or LF, trailing spaces gone.
function regionLines(screen) {
  const lines = String(screen ?? "").split(/\r?\n/).map((l) => l.replace(/\r/g, "").replace(/\s+$/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-REGION_LINES);
}

// Lines that are only spinner or box-drawing noise.
const NOISE = /^[\s─-╿⠀-⣿·•●○◐-◓◴-◷✢✳✶✻✽*]+$/;
const CURSOR = /^\s*[❯›>▶](?:\s|$)/;

// The bottom of a screen with what moves on its own taken out: spinners, timers, token counts,
// a caret. Used only for a fingerprint, never shown.
export function normalizeRegion(screen) {
  return regionLines(screen)
    .filter((l) => !(l.trim() && NOISE.test(l)))
    .map((l) => l
      .replace(/\d+(?:[.,]\d+)?\s?(?:ms|s|m|h)\b/g, "#")
      .replace(/\d[\d.,]*\s?[kKmM]?\s*(tokens?)\b/gi, "# $1")
      .replace(/\b(tokens?):?\s*\d[\d.,]*\s?[kKmM]?/gi, "$1 #")
      .replace(CURSOR, "")
      .replace(/ {2,}/g, " ")
      .trim())
    .join("\n");
}

// A numbered choice: an optional marker symbol, then "1." or "1)".
const ITEM = /^\s*([^\p{L}\p{N}\s]\s*)?(\d{1,2})([.)])(?:\s|$)/u;

// Whether the bottom of the screen shows a list of choices, where Enter would pick an option.
// Errs toward yes: a false yes only means the reply is refused.
export function menuShown(screen) {
  const lines = regionLines(screen);
  const items = lines.map((l) => l.match(ITEM)).filter(Boolean);
  // (a) "1." then the next numbered line "2." (or with ")").
  for (let i = 0; i + 1 < items.length; i++) {
    if (items[i][2] === "1" && items[i + 1][2] === "2" && items[i][3] === items[i + 1][3]) return true;
  }
  // (c) a numbered line marked with a symbol: the current choice.
  if (items.some((m) => m[1])) return true;
  // (b) a key hint: Esc, or a key with select, choose or confirm.
  return lines.some((l) => /\besc(?:ape)?\b/i.test(l)
    || (/\b(?:enter|return|tab|space|arrows?)\b|[←-↓]/i.test(l) && /\b(?:select|choose|confirm)\b/i.test(l)));
}

// Why a reply is refused for this snapshot, or null when it may go:
// "permission", "auth", "menu" (waiting agents only), or "refused" for a state that takes no replies.
export function refusalOf(snap, menu) {
  const state = snap?.state;
  if (state === "blocked") {
    if (snap.kind === "permission") return "permission";
    if (snap.kind === "auth") return "auth";
    return menu ? "menu" : null;
  }
  return state === "idle" || state === "working" || state === "done" ? null : "refused";
}

// The text of `hc read --json` output, or null when it is unreadable or incomplete.
export function readText(stdout) {
  let r;
  try { r = JSON.parse(stdout ?? ""); } catch { return null; }
  if (!r || typeof r.text !== "string" || r.complete === false || r.why === "error") return null;
  return r.text;
}

// What the screen region gives a snapshot: whether a menu shows, and its fingerprint.
export const regionOf = (text) => ({ menu: menuShown(text), hash: hash(normalizeRegion(text)) });

// Parsed JSON, or null.
export function parseJson(s) {
  try { return JSON.parse(s ?? ""); } catch { return null; }
}

// hc's stderr on a failed send -> fixed text and the next state. The raw error is never shown:
// a usage error can echo the reply text.
export function sendErrorText(stderr) {
  const kind = parseJson(stderr)?.error?.kind;
  if (kind === "status_mismatch" || kind === "blocked") return { text: "This agent changed before the reply went in. Nothing was sent.", state: "changed" };
  if (kind === "not_found" || kind === "finished") return { text: "That agent is gone.", state: "gone" };
  return { text: "Couldn't send the reply.", state: "failed" };
}

// The live row says the agent moved on since the snapshot (done and idle count as one).
// Advisory only: the check before the send decides.
export function drifted(snap, liveStatus, liveTurn) {
  if (!snap) return false;
  const word = (s) => (s === "done" ? "idle" : s);
  return word(liveStatus) !== word(snap.state) || (liveTurn ?? 0) !== snap.turn;
}

// A send that went in while a waiting agent had already moved on: hc's SendResult says so.
export function landedLate(snap, stdout) {
  if (snap?.state !== "blocked") return false;
  const r = parseJson(stdout);
  if (!r || typeof r !== "object") return false;
  return r.status !== "blocked" || r.turn !== snap.turn;
}

// The `layout.select` args that bring `child` of stack `stack` forward, or null when the
// current layout has no such stack or child.
export function selectArgs(node, stack, child) {
  const walk = (n) => {
    if (!n || typeof n !== "object") return false;
    if (n.type === "stack" && n.id === stack && (n.children ?? []).some((c) => c.id === child)) return true;
    return (n.children ?? []).some(walk) || (n.floating ?? []).some(walk);
  };
  return walk(node) ? { stack, child } : null;
}
