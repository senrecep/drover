// Pure logic for drover-history: no Herdr calls here, so it runs under node:test.

export const MOD = "drover-history";
export const BODY = "panel-body";
export const PANEL = "panel";
export const SCOPE_KEY = "drover-history.scope";
export const AGENT_IDS = ["claude", "codex", "pi"];
const LABELS = { claude: "Claude", codex: "Codex", pi: "Pi" };
// Theme ansi slots, so the dots follow the theme: Claude yellow-orange, Codex blue, Pi green.
const COLORS = { claude: "ansi3", codex: "ansi4", pi: "ansi2" };

export const agentLabel = (a) => LABELS[a] ?? String(a ?? "");
export const agentColor = (a, t) => t?.[COLORS[a]] ?? t?.muted;

/** The stored scope: "space" (default) or "all". Accepts the string or a `{ value }` record. */
export function normalizeScope(v) {
  const s = typeof v === "string" ? v : v?.value;
  return s === "all" ? "all" : "space";
}

// ---------- where the panel is (findNode / panelShown after drover-tabs/logic.js) ----------

/** The node with `id`, or null. Looks in children and floating blocks. */
export function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of [...(node.children ?? []), ...(node.floating ?? [])]) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

/** Whether the side panel column is on screen: it and every node above it shown. */
export function panelShown(root) {
  const walk = (n, shown) => {
    if (!n || typeof n !== "object") return null;
    const here = shown && n.hidden !== true;
    if (n.id === PANEL) return here;
    for (const c of n.children ?? []) {
      const r = walk(c, here && (n.type !== "stack" || n.active == null || n.active === c.id));
      if (r !== null) return r;
    }
    return null;
  };
  return walk(root, true) === true;
}

/** True only while History is the panel on screen: the side panel shown and panel-body's
 *  selected child is this mod's block. Hidden stack children stay mounted, so the view asks. */
export function historyShown(root, id = MOD) {
  const body = findNode(root, BODY);
  if (!body || body.type !== "stack") return false;
  const active = body.active ?? body.children?.[0]?.id;
  return active === id && panelShown(root);
}

// ---------- scope ----------

const trimSlash = (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

const absDirs = (list) => [...new Set(list.filter((d) => typeof d === "string" && d.startsWith("/")).map(trimSlash))].sort();

/** The active space and the folders "This space" covers. `cwds`: folders whose sessions count
 *  with everything below them: the space's folder and its panes' live folders. `exact`: pane
 *  folders that only count as themselves: the home folder and "/", which hold everything. A
 *  space with no folder adds none (not home). `remote` when the space lives on another machine. */
export function scopeOf(spaceList, paneList, homeDir) {
  const space = (spaceList ?? []).find((s) => s.active) ?? null;
  if (!space) return { space: null, remote: false, cwds: [], exact: [] };
  if (space.machine) return { space, remote: true, cwds: [], exact: [] };
  const tabs = new Set((space.tabs ?? []).map((t) => t.id));
  const home = typeof homeDir === "string" && homeDir ? trimSlash(homeDir) : null;
  const paneDirs = absDirs((paneList ?? []).filter((p) => tabs.has(p.tab)).map((p) => p.cwd));
  const broad = (d) => d === "/" || d === home;
  const cwds = absDirs([space.folder, ...paneDirs.filter((d) => !broad(d))]);
  const exact = paneDirs.filter((d) => broad(d) && !cwds.some((c) => within(d, c)));
  return { space, remote: false, cwds, exact };
}

/** Whether `dir` is `root` or inside it. */
export function within(dir, root) {
  if (typeof dir !== "string" || typeof root !== "string" || !dir || !root) return false;
  const r = trimSlash(root), d = trimSlash(dir);
  return r === "/" || d === r || d.startsWith(r + "/");
}

// ---------- indexer calls ----------

/** The pythons to try, in order, as [program, args before -I]. Windows: the py launcher, then
 *  python (python3 there is often only the Store's install stub). */
export const pythonCandidates = (platform) => (platform === "windows" ? [["py", ["-3", "-X", "utf8"]], ["python", ["-X", "utf8"]]] : [["python3", []]]);

/** Whether a probe's answer means that python runs. Starting is enough on macOS and Linux; the
 *  Windows Store stub starts and exits 9009, so there the exit code counts. */
export const probeOk = (platform, r) => platform !== "windows" || r?.code === 0;

/** What the missing-python state says. */
export const noPythonText = (platform) => (platform === "windows"
  ? { title: "Python not found", body: "History reads sessions with Python 3 (py or python on PATH). Install it, then Retry." }
  : { title: "python3 not found", body: "History reads sessions with python3. Install it, then Retry." });

/** "This space" matches folders as POSIX paths (here and in indexer.py), so not on Windows. */
export const spaceScopeWorks = (platform) => platform !== "windows";

/** exec argv for an update run: low priority (nice, not on Windows), isolated python, no bytecode written. */
export function updateCall(script, appHome, budget, python = ["python3", []], platform = "macos") {
  const args = [...python[1], "-I", "-B", script, "update", "--home", appHome, "--budget", String(budget)];
  return platform === "windows" ? [python[0], args] : ["nice", ["-n", "10", python[0], ...args]];
}

/** exec argv for the list (empty query) or a search. */
export function queryCall(script, appHome, { query = "", cwds = null, exact = null, limit = 100, agent = "all" } = {}, python = ["python3", []]) {
  const q = String(query ?? "").trim();
  // One "--query=<text>" word: a query that starts with "-" is never read as an option.
  const args = [...python[1], "-I", "-B", script, ...(q ? ["search", `--query=${q}`] : ["list"]), "--home", appHome, "--limit", String(limit)];
  for (const c of cwds ?? []) args.push("--cwd", c);
  for (const c of exact ?? []) args.push("--at", c);
  if (AGENT_IDS.includes(agent)) args.push("--agent", agent);
  return [python[0], args];
}

/** The indexer's JSON answer, or `{ error }` for anything else. */
export function parseOut(r) {
  const text = String(r?.stdout ?? "").trim();
  try {
    const out = JSON.parse(text.split("\n").pop() || "null");
    if (out && typeof out === "object") return r?.code === 0 || out.error ? out : { error: `indexer exited ${r?.code}` };
  } catch { /* fall through */ }
  return { error: r?.code ? `indexer exited ${r.code}` : "indexer gave no answer" };
}

/** "Indexing… 120/983" while an index run has more to do, else null. */
export function statusText(st) {
  if (!st || st.done !== false) return null;
  return st.busy ? "Indexing…" : `Indexing… ${st.indexed ?? 0}/${st.total ?? 0}`;
}

// ---------- resume ----------

/** The program line that resumes a session, or null. Pi takes the transcript path: `--session`
 *  resolves a bare id only among the current folder's sessions. */
export function resumeArgv(row) {
  if (!row?.id) return null;
  if (row.agent === "claude") return ["claude", "--resume", row.id];
  if (row.agent === "codex") return ["codex", "resume", row.id];
  if (row.agent === "pi") return typeof row.path === "string" && row.path ? ["pi", "--session", row.path] : null;
  return null;
}

/**
 * Where and how to resume `row`: `{ ok: true, args }` for `tab.new`, or `{ ok: false, reason }`.
 * The tab opens in the active space when it is on this computer, else in a local space whose
 * folder holds the session's folder. `exists`: whether that folder is there now. Claude only
 * resumes from the folder it ran in; Codex and Pi resume anywhere, so they fall back to the
 * space's folder.
 */
export function resumePlan(row, spaceList, exists = row?.exists !== false) {
  const argv = resumeArgv(row);
  if (!argv) return { ok: false, reason: "This session can't be resumed." };
  if (row.agent === "claude" && !row.cwd) return { ok: false, reason: "Can't resume: session folder unknown." };
  if (!exists && row.agent === "claude") return { ok: false, reason: "Can't resume: folder no longer exists." };
  const local = (spaceList ?? []).filter((s) => !s.machine);
  const active = local.find((s) => s.active);
  const holder = local.filter((s) => within(row.cwd, s.folder)).sort((a, b) => b.folder.length - a.folder.length)[0];
  const space = active ?? holder;
  if (!space) return { ok: false, reason: "Sessions are on this computer. Open a local space to resume." };
  const args = { space: space.id, argv };
  if (exists && row.cwd) args.folder = row.cwd;
  return { ok: true, args };
}

// ---------- display ----------

const SECRET_NAME = String.raw`[\w.-]*(?:secret|token|passw(?:or)?d|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth[_-]?key|session[_-]?key)[\w.-]*`;
// The display twin of indexer.py's redactor (that one runs before anything is written).
const REDACT = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, "[redacted key]"],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, "[redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted]"],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[redacted]"],
  [/\bnpm_[A-Za-z0-9]{30,}/g, "[redacted]"],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, "[redacted]"],
  [/\bhf_[A-Za-z0-9]{30,}/g, "[redacted]"],
  [/\bya29\.[A-Za-z0-9_-]{20,}/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\b(bearer|basic|token)(\s+)(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{12,}/gi, "$1$2[redacted]"],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^/\s@]+@/gi, "$1[redacted]@"],
  [/([?&](?:[\w.-]*(?:token|key|secret|sig|signature|password|passwd|auth|code|credential)[\w.-]*)=)[^&#\s"'<>]+/gi, "$1[redacted]"],
  [new RegExp(`(${SECRET_NAME})(["']?\\s*[:=]\\s*["']?)(?=[^\\s"'\`,;&]*[A-Za-z])[^\\s"'\`,;&]{4,}`, "gi"), "$1$2[redacted]"],
];

/** Text with secret-looking tokens replaced by "[redacted]". */
export function redact(text) {
  let s = String(text ?? "");
  for (const [rx, rep] of REDACT) s = s.replace(rx, rep);
  return s;
}

const oneLine = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
const cut = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");

/** A snippet `{pre, hit, post}` made safe to draw: one line, redacted, at most `cap` chars. */
export function snippetView(sn, cap = 200) {
  if (!sn || typeof sn !== "object") return null;
  const hit = cut(redact(oneLine(sn.hit)), 60);
  let pre = redact(oneLine(sn.pre)), post = redact(oneLine(sn.post));
  const room = Math.max(cap - hit.length, 0);
  if (pre.length > Math.floor(room / 2)) pre = "…" + pre.slice(-(Math.max(Math.floor(room / 2) - 1, 0)));
  post = post.slice(0, Math.max(room - pre.length, 0));
  if (!hit && !pre && !post) return null;
  return { pre, hit, post };
}

/** "just now", "5m ago", "3h ago", "2d ago", "3w ago", "4mo ago", "2y ago". `when` in epoch seconds. */
export function relAge(when, nowMs = Date.now()) {
  const s = Math.max(0, Math.floor(nowMs / 1000 - Number(when)));
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d < 14) return `${d}d ago`;
  if (d < 60) return `${Math.floor(d / 7)}w ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

/** The last folder name of `cwd`; "~" for the home folder. */
export function folderName(cwd, homeDir) {
  if (typeof cwd !== "string" || !cwd) return "?";
  const c = trimSlash(cwd);
  if (homeDir && c === trimSlash(homeDir)) return "~";
  return c === "/" ? "/" : c.slice(Math.max(c.lastIndexOf("/"), c.lastIndexOf("\\")) + 1);
}

/** One list row as the view draws it. */
export function shapeRow(r, { homeDir, now = Date.now() } = {}) {
  const msgs = Number(r?.msgs) || 0;
  const missing = r?.exists === false;
  const meta = [folderName(r?.cwd, homeDir), relAge(r?.updated, now), `${msgs} ${msgs === 1 ? "msg" : "msgs"}`]
    .filter(Boolean).join(" · ") + (missing ? " · folder missing" : "");
  return {
    key: `${r?.agent}:${r?.id}`,
    agent: r?.agent,
    id: String(r?.id ?? ""),
    cwd: r?.cwd ?? "",
    path: r?.path ?? null,
    exists: !missing,
    title: cut(redact(oneLine(r?.title)) || "(untitled)", 120),
    meta,
    snippet: snippetView(r?.snippet),
  };
}

/** The selection after moving `delta` rows, clamped to the list. */
export function moveSel(sel, delta, count) {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, (Number.isInteger(sel) ? sel : -1) + delta));
}

/** The agents to offer as filter chips: those with sessions in the current scope, in a fixed order. */
export function presentAgents(counts) {
  return AGENT_IDS.filter((a) => Number(counts?.[a]) > 0);
}
