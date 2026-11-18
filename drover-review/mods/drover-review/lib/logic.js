// Pure logic for drover-review: git argv, parsing, diff signatures, viewed marks, turns, prompts.
// No host calls here, so node can test it.

// Global options on every git call: no index lock or refresh, no fsmonitor hook, no external diff.
export const GIT_PREFIX = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "diff.autoRefreshIndex=false", "-c", "core.quotePath=false"];
// Diff-only options (git rejects them before the subcommand).
export const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"];
// The empty tree: the base for a repository without commits.
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function gitArgs(sub, args = []) {
  return [...GIT_PREFIX, sub, ...(sub === "diff" ? DIFF_FLAGS : []), ...args];
}

/** `git status --porcelain=v1 -z --no-renames`: [{ path, untracked, deleted }]. */
export function parseStatus(z) {
  const out = [];
  for (const entry of String(z || "").split("\0")) {
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2), path = entry.slice(3);
    if (xy === "!!" || path.endsWith("/")) continue;
    out.push({ path, untracked: xy === "??", deleted: xy.includes("D") });
  }
  return out;
}

/** `git diff --numstat -z --no-renames`: [{ path, add, del, binary }] in git's order. */
export function parseNumstat(z) {
  const out = [];
  for (const entry of String(z || "").split("\0")) {
    const parts = entry.replace(/^\n/, "").split("\t");
    if (parts.length < 3) continue;
    const [a, d, ...rest] = parts;
    out.push({ path: rest.join("\t"), add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" });
  }
  return out;
}

/** A full `git diff` cut into one section per file, in git's order. */
export function splitDiff(text) {
  const out = [];
  let cur = null;
  for (const line of String(text || "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (cur) out.push(cur.join("\n"));
      cur = [line];
    } else if (cur) cur.push(line);
  }
  if (cur) out.push(cur.join("\n"));
  return out;
}

/** cyrb53: a fast 53-bit string hash, as 14 hex digits. */
export function hash(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** {path: signature} of tracked changes: the hash of each file's own diff section.
 *  numstat and the full diff list files in the same order; if the counts disagree the
 *  signature falls back to the path's counts (a file that changes again still differs in most cases). */
export function diffSignatures(numstat, sections) {
  const out = {};
  const zip = numstat.length === sections.length;
  numstat.forEach((f, i) => { out[f.path] = zip ? "d" + hash(sections[i]) : `n${f.add}:${f.del}:${f.binary ? 1 : 0}`; });
  return out;
}

// Untracked files bigger than this are listed but never read.
export const MAX_READ_BYTES = 1024 * 1024;

/** Output of one `stat` call for `count` paths, one line per path in argument order:
 *  "<type>|<size>|<mtime seconds>" (BSD `-f '%HT|%z|%m'` or GNU `-c '%F|%s|%Y'`).
 *  Returns [{ regular, size, mtime }] or null when the output doesn't fit the paths. */
export function parseStat(out, count) {
  const lines = String(out ?? "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== count) return null;
  const list = [];
  for (const line of lines) {
    const m = /^([^|]+)\|(\d+)\|(-?\d+)$/.exec(line);
    if (!m) return null;
    list.push({ regular: /^regular( empty)? file$/i.test(m[1]), size: Number(m[2]), mtime: Number(m[3]) });
  }
  return list;
}

/** Whether an untracked file may be hashed and read: a regular file (not a symlink) within the limit. */
export const readable = (st) => Boolean(st) && st.regular && st.size <= MAX_READ_BYTES;

/** The signature of a file that is not read: its size and modification time. null when unknown. */
export const statSig = (st) => (st ? `s${st.size}:${st.mtime}` : null);

export function countLines(text) {
  if (!text) return 0;
  return text.split("\n").length - Number(text.endsWith("\n"));
}

/** Changed files against HEAD plus untracked ones, sorted by path. */
export function buildFiles(status, numstat, sigs, untracked = {}) {
  const byPath = new Map();
  for (const f of numstat) byPath.set(f.path, { path: f.path, add: f.add, del: f.del, binary: f.binary, untracked: false, deleted: false, sig: sigs[f.path] ?? null });
  for (const s of status) {
    const cur = byPath.get(s.path);
    if (cur) { cur.deleted = s.deleted; continue; }
    if (!s.untracked) continue;
    const u = untracked[s.path] ?? {};
    byPath.set(s.path, { path: s.path, add: u.add ?? null, del: 0, binary: Boolean(u.binary), large: Boolean(u.large), untracked: true, deleted: false, sig: u.sig ?? null });
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ---------- viewed marks: { v: 1, checkouts: { [root]: { at, marks: { [path]: sig } } } } ----------

export const MAX_CHECKOUTS = 64;
export const MAX_MARKS = 4096;
export const MAX_KEY = 1024;

export function parseStore(text) {
  try {
    const s = JSON.parse(text);
    if (s && s.v === 1 && s.checkouts && typeof s.checkouts === "object") return s;
  } catch {}
  return { v: 1, checkouts: {} };
}

export function marksFor(store, root) {
  return store?.checkouts?.[root]?.marks ?? {};
}

/** A mark counts only while the file's signature is the one it was marked with. */
export function isViewed(marks, file) {
  return Boolean(file.sig) && marks[file.path] === file.sig;
}

/** Keep the newest checkouts and at most MAX_MARKS marks; drop over-long keys. */
export function boundStore(store) {
  const entries = Object.entries(store.checkouts)
    .filter(([root]) => root.length <= MAX_KEY)
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
    .slice(0, MAX_CHECKOUTS);
  const out = { v: 1, checkouts: {} };
  let budget = MAX_MARKS;
  for (const [root, c] of entries) {
    const marks = {};
    for (const [p, sig] of Object.entries(c.marks || {})) {
      if (budget <= 0) break;
      if (p.length > MAX_KEY || typeof sig !== "string") continue;
      marks[p] = sig;
      budget--;
    }
    if (Object.keys(marks).length) out.checkouts[root] = { at: c.at || 0, marks };
  }
  return out;
}

/** A new store with `file` marked (its current signature) or unmarked. */
export function setMark(store, root, file, viewed, now) {
  const cur = store.checkouts[root] ?? { at: now, marks: {} };
  const marks = { ...cur.marks };
  if (viewed && file.sig) marks[file.path] = file.sig;
  else delete marks[file.path];
  return boundStore({ v: 1, checkouts: { ...store.checkouts, [root]: { at: now, marks } } });
}

/** Marks that no longer match (the file changed again, or has no changes left) expire.
 *  Files whose signature is unknown this time keep their mark. Returns null when nothing expired. */
export function expireMarks(store, root, files) {
  const cur = store.checkouts[root];
  if (!cur) return null;
  const byPath = new Map(files.map((f) => [f.path, f]));
  const marks = {};
  let changed = false;
  for (const [p, sig] of Object.entries(cur.marks)) {
    const f = byPath.get(p);
    if (f && (f.sig === sig || f.sig == null)) marks[p] = sig;
    else changed = true;
  }
  if (!changed) return null;
  return boundStore({ v: 1, checkouts: { ...store.checkouts, [root]: { at: cur.at, marks } } });
}

export function viewedCount(files, marks) {
  return files.reduce((n, f) => n + (isViewed(marks, f) ? 1 : 0), 0);
}

/** Section 1's rows: optionally only a turn's paths, optionally without viewed files. */
export function visibleFiles(files, marks, { hideViewed = false, only = null } = {}) {
  return files.filter((f) => (!only || only.has(f.path)) && !(hideViewed && isViewed(marks, f)));
}

export function totals(files) {
  return files.reduce((t, f) => ({ add: t.add + (f.add || 0), del: t.del + (f.del || 0) }), { add: 0, del: 0 });
}

// ---------- turns ----------

/** Helper events (oldest first: {k:"p"} a real prompt, {k:"e", path, add, del} an edit)
 *  → turns newest first, each { files: [{ path, add, del, edits }], partial }.
 *  Edits before the first prompt form a partial turn (its prompt was beyond the read cap). */
export function splitTurns(events, limit = 5) {
  const turns = [];
  let cur = null;
  for (const ev of events || []) {
    if (ev.k === "p") {
      cur = { files: new Map(), partial: false };
      turns.push(cur);
    } else if (ev.k === "e" && typeof ev.path === "string") {
      if (!cur) {
        cur = { files: new Map(), partial: true };
        turns.push(cur);
      }
      const f = cur.files.get(ev.path) ?? { path: ev.path, add: 0, del: 0, edits: 0, unknown: false };
      if (ev.add == null || ev.del == null) f.unknown = true;
      f.add += ev.add || 0;
      f.del += ev.del || 0;
      f.edits++;
      cur.files.set(ev.path, f);
    }
  }
  return turns.reverse().slice(0, limit).map((t) => ({ partial: t.partial, files: [...t.files.values()] }));
}

/** A path from the transcript relative to the checkout root, or null when outside it. */
export function relPath(abs, root) {
  if (!abs || !root) return null;
  const r = root.endsWith("/") ? root : root + "/";
  return abs.startsWith(r) ? abs.slice(r.length) : null;
}

// ---------- prompts ----------

// One line of plain text: escape sequences, C1 controls and bidi/format characters go (as in
// drover-pulls' sanitize); C0 controls, DEL and line separators become a space.
const clean = (s) => String(s ?? "")
  .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "") // OSC, BEL or ST terminated (or unterminated)
  .replace(/\x1b[P^_X][\s\S]*?(?:\x1b\\|$)/g, "") // DCS, PM, APC, SOS
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI
  .replace(/\x9b[0-?]*[ -/]*[@-~]/g, "") // 8-bit CSI
  .replace(/\x1b[ -/]*[0-~]?/g, "") // other ESC sequences, and a lone ESC
  .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
  .replace(/[\u0080-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
const MAX_LISTED = 40;

function fileList(files) {
  const lines = files.slice(0, MAX_LISTED).map((f) => {
    const counts = f.binary ? "binary" : `+${f.add ?? "?"} -${f.del ?? 0}`;
    return `- ${clean(f.path)} (${f.untracked ? "untracked, " : f.deleted ? "deleted, " : ""}${counts})`;
  });
  if (files.length > MAX_LISTED) lines.push(`- and ${files.length - MAX_LISTED} more files`);
  return lines.join("\n");
}

/** The exact text sent to the agent. kind: "guide" | "bug". */
export function buildPrompt(kind, { root, branch, files, scope }) {
  const where = `the checkout at ${clean(root)}${branch ? ` (branch ${clean(branch)})` : ""}`;
  const what = scope ? clean(scope) : "the uncommitted changes against HEAD, untracked files included";
  const list = files.length ? `Files in scope:\n${fileList(files)}` : "There are no changed files in scope.";
  if (kind === "guide") {
    return [
      `Write a review guide for ${what} in ${where}.`,
      "Work read-only: do not edit, create, stage or commit files, and do not post anything anywhere. Read the changes yourself (git diff HEAD, and the untracked files).",
      list,
      "Reply with:",
      "1. What changed: two or three sentences.",
      "2. The order to read it in: numbered steps, each with a short title, one or two sentences, and the files and line ranges it covers. Put the code that others depend on first, its callers next, tests last.",
      "3. Files no step covers.",
      "4. What to test: a short checklist.",
      "Show the guide here and stop.",
    ].join("\n");
  }
  return [
    `Draft a bug report about a problem in ${what} in ${where}.`,
    "Work read-only: do not edit, create, stage or commit files. Do not post, comment, or open issues or pull requests; I will post the report myself.",
    list,
    "Steps:",
    "1. Gather the facts: branch, HEAD commit, versions of the tools involved, the changed files that matter, and only the error output or log lines that matter.",
    "2. Ask me one or two questions about what I did and what I expected, and wait for my answers.",
    "3. If the repository has a GitHub remote, search its existing issues for duplicates, read-only.",
    "4. Draft the report with these fields: title, what happened, steps to reproduce, expected, actual, environment, relevant log lines, possible duplicates.",
    "Show me the draft and stop.",
  ].join("\n");
}

// ---------- visibility ----------

// Whether the layout block showing `mod` is on screen: no hidden node above it and, in a stack,
// the active child. Not found in the layout (an overlay or a pane): shown.
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
