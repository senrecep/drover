// Pure logic for the Git browser: parsers for git's machine output, blockers, argv builders and
// the forbidden-flag check every git/gh/glab call passes through. No herdr imports here, so the
// node tests in check.cjs load this file as it is.

export const STALE_MS = 10000; // a read older than this is re-read before any write
export const CONFIRM_MS = 6000; // a two-click confirmation expires after this
export const RECENT_MAX = 8;
export const NET_MS = 30000; // fetch / push / pull
export const HELPER_MS = 15000;
export const MAX_TEXT = 4000;

// ---------- small helpers ----------

/** Display text: control and bidi characters removed, length capped. */
export function clean(text, max = 300) {
  let s = String(text ?? "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[0-~]?/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f\u0080-\u009f​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/\r\n?/g, "\n");
  if (s.length > max) s = `${s.slice(0, Math.max(0, max - 1))}…`;
  return s;
}

/** Removes `user[:password]@` from every URL-looking piece of text. */
export function stripUserinfo(text) {
  return String(text ?? "").replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'<>]+@/gi, "$1");
}

/** `n` seconds/minutes/... ago, short. */
export function ago(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d`;
  if (d < 120) return `${Math.floor(d / 7)}w`;
  return `${Math.floor(d / 30)}mo`;
}

const int = (s) => {
  const n = parseInt(String(s ?? ""), 10);
  return Number.isFinite(n) ? n : 0;
};

// ---------- status --porcelain=v2 --branch [-z] ----------

/**
 * Parses `git status --porcelain=v2 --branch`, with or without -z.
 * -> { oid, head, detached, upstream, ahead, behind, hasAB, files: [{kind, xy, path, orig}],
 *      staged, unstaged, untracked, conflicted: [path], dirty }
 * kind: "changed" | "renamed" | "conflict" | "untracked" | "ignored".
 */
export function parseStatus(text) {
  const out = {
    oid: null, head: null, detached: false, upstream: null, ahead: 0, behind: 0, hasAB: false,
    files: [], staged: 0, unstaged: 0, untracked: 0, conflicted: [], dirty: 0,
  };
  const raw = String(text ?? "");
  const z = raw.includes("\0");
  const parts = z ? raw.split("\0") : raw.split("\n");
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith("# ")) {
      const [key, ...rest] = line.slice(2).split(" ");
      const val = rest.join(" ");
      if (key === "branch.oid") out.oid = val === "(initial)" ? null : val;
      else if (key === "branch.head") {
        if (val === "(detached)") out.detached = true;
        else out.head = val;
      } else if (key === "branch.upstream") out.upstream = val;
      else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(val);
        if (m) { out.ahead = int(m[1]); out.behind = int(m[2]); out.hasAB = true; }
      }
      continue;
    }
    const kind = line[0];
    if (kind === "1") {
      // 1 XY sub mH mI mW hH hI path
      const f = line.split(" ");
      const xy = f[1] ?? "..";
      out.files.push({ kind: "changed", xy, path: f.slice(8).join(" "), orig: null });
      count(out, xy);
    } else if (kind === "2") {
      // 2 XY sub mH mI mW hH hI Xscore path<sep>orig ; with -z the original path is the next field
      const f = line.split(" ");
      const xy = f[1] ?? "..";
      let path = f.slice(9).join(" ");
      let orig = null;
      if (z) { orig = parts[i + 1] ?? null; i++; } else {
        const tab = path.indexOf("\t");
        if (tab >= 0) { orig = path.slice(tab + 1); path = path.slice(0, tab); }
      }
      out.files.push({ kind: "renamed", xy, path, orig });
      count(out, xy);
    } else if (kind === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const f = line.split(" ");
      const path = f.slice(10).join(" ");
      out.files.push({ kind: "conflict", xy: f[1] ?? "UU", path, orig: null });
      out.conflicted.push(path);
    } else if (kind === "?") {
      out.files.push({ kind: "untracked", xy: "??", path: line.slice(2), orig: null });
      out.untracked++;
    } else if (kind === "!") {
      out.files.push({ kind: "ignored", xy: "!!", path: line.slice(2), orig: null });
    }
  }
  out.dirty = out.files.filter((f) => f.kind !== "ignored").length;
  return out;
}

function count(out, xy) {
  if (xy[0] && xy[0] !== ".") out.staged++;
  if (xy[1] && xy[1] !== ".") out.unstaged++;
}

/** Tracked changes (staged or not, conflicts included): untracked and ignored files don't count. */
export const trackedChanges = (st) => (st?.files ?? []).filter((f) => f.kind === "changed" || f.kind === "renamed" || f.kind === "conflict").length;

// ---------- for-each-ref ----------

export const LOCAL_FORMAT = "%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)%09%(committerdate:unix)%09%(worktreepath)%09%(HEAD)%09%(objectname:short)%09%(contents:subject)";
export const REMOTE_FORMAT = "%(refname)%09%(committerdate:unix)%09%(objectname:short)%09%(contents:subject)";

/** "ahead 2, behind 1" | "ahead 2" | "behind 1" | "gone" | "" */
export function parseTrack(s) {
  const t = String(s ?? "").trim();
  const out = { ahead: 0, behind: 0, gone: false };
  if (t === "gone") { out.gone = true; return out; }
  const a = /ahead (\d+)/.exec(t);
  const b = /behind (\d+)/.exec(t);
  if (a) out.ahead = int(a[1]);
  if (b) out.behind = int(b[1]);
  return out;
}

/** Local branches from `for-each-ref --format=LOCAL_FORMAT refs/heads`, newest first. */
export function parseLocalBranches(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [name, upstream, track, date, worktree, head, sha, ...subject] = line.split("\t");
    if (!name) continue;
    const tr = parseTrack(track);
    out.push({
      name, upstream: upstream || null, ahead: tr.ahead, behind: tr.behind, gone: tr.gone,
      date: int(date), worktree: worktree || null, head: (head ?? "").trim() === "*",
      sha: sha || "", subject: subject.join("\t"),
    });
  }
  return out.sort((a, b) => b.date - a.date || a.name.localeCompare(b.name));
}

/**
 * Remote-tracking branches from `for-each-ref --format=REMOTE_FORMAT refs/remotes`.
 * `remotes` (names from `git remote`) splits "origin/feat/x" correctly when a remote name has a "/".
 * Symbolic "<remote>/HEAD" refs are dropped. Newest first.
 */
export function parseRemoteBranches(text, remotes = []) {
  const names = [...remotes].sort((a, b) => b.length - a.length);
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [full, date, sha, ...subject] = line.split("\t");
    if (!full) continue;
    const ref = full.startsWith("refs/remotes/") ? full.slice(13) : full;
    let remote = names.find((r) => ref.startsWith(`${r}/`));
    if (!remote) remote = ref.split("/")[0];
    const name = ref.slice(remote.length + 1);
    if (!name || name === "HEAD") continue;
    out.push({ ref, remote, name, date: int(date), sha: sha || "", subject: subject.join("\t") });
  }
  return out.sort((a, b) => b.date - a.date || a.ref.localeCompare(b.ref));
}

/** `git remote` output -> names. */
export const parseRemoteNames = (text) => String(text ?? "").split("\n").map((s) => s.trim()).filter(Boolean);

// ---------- reflog -> recent branches ----------

const SHA_LIKE = /^[0-9a-f]{7,64}$/i;
const CHECKOUT = /^checkout: moving from (.+) to (.+)$/;

/**
 * `reflog show --format=%gs -n 300 HEAD` (newest first) -> recently checked out branch names,
 * most recent first, without the current one, SHAs, duplicates or branches that no longer exist.
 */
export function recentBranches(reflog, existing, current, max = RECENT_MAX) {
  const have = existing instanceof Set ? existing : new Set(existing ?? []);
  const seen = new Set();
  const out = [];
  const take = (name) => {
    const n = String(name ?? "").trim().replace(/^refs\/heads\//, "");
    if (!n || n === current || seen.has(n) || SHA_LIKE.test(n) || !have.has(n)) return;
    seen.add(n);
    out.push(n);
  };
  for (const line of String(reflog ?? "").split("\n")) {
    const m = CHECKOUT.exec(line.trim());
    if (!m) continue;
    take(m[2]);
    take(m[1]);
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

// ---------- default branch ----------

/**
 * The default branch. `symref` is `symbolic-ref --quiet --short refs/remotes/<remote>/HEAD`
 * output ("origin/main"). Fallbacks: <remote>/main, <remote>/master, local main, master, trunk,
 * develop, init.defaultBranch, then the first local branch. -> { name, source } or null.
 */
export function defaultBranch({ symref, remote = "origin", remoteBranches = [], locals = [], initDefault = "" } = {}) {
  const s = String(symref ?? "").trim();
  if (s) {
    const name = s.startsWith(`${remote}/`) ? s.slice(remote.length + 1) : s.replace(/^[^/]+\//, "");
    if (name && name !== "HEAD") return { name, source: "remote HEAD" };
  }
  const rset = new Set(remoteBranches.filter((r) => r.remote === remote).map((r) => r.name));
  for (const n of ["main", "master"]) if (rset.has(n)) return { name: n, source: `${remote}/${n}` };
  const lset = new Set(locals.map((l) => (typeof l === "string" ? l : l.name)));
  for (const n of ["main", "master", "trunk", "develop"]) if (lset.has(n)) return { name: n, source: "local" };
  const init = String(initDefault ?? "").trim();
  if (init && lset.has(init)) return { name: init, source: "init.defaultBranch" };
  const first = locals[0];
  if (first) return { name: typeof first === "string" ? first : first.name, source: "first branch" };
  return null;
}

// ---------- worktree list --porcelain ----------

/** -> [{ path, head, branch, detached, bare, locked, prunable }] in git's order (main first). */
export function parseWorktrees(text) {
  const out = [];
  let cur = null;
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) { if (cur) out.push(cur); cur = null; continue; }
    const sp = line.indexOf(" ");
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? "" : line.slice(sp + 1);
    if (key === "worktree") {
      if (cur) out.push(cur);
      cur = { path: val, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
    } else if (!cur) continue;
    else if (key === "HEAD") cur.head = val;
    else if (key === "branch") cur.branch = val.replace(/^refs\/heads\//, "");
    else if (key === "detached") cur.detached = true;
    else if (key === "bare") cur.bare = true;
    else if (key === "locked") cur.locked = true;
    else if (key === "prunable") cur.prunable = true;
  }
  if (cur) out.push(cur);
  return out;
}

// ---------- ahead / behind ----------

/** `rev-list --left-right --count A...B` -> { ahead, behind } (ahead = only in A). */
export function parseAheadBehind(text) {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(String(text ?? ""));
  return m ? { ahead: int(m[1]), behind: int(m[2]) } : null;
}

// ---------- repository ----------

/** `rev-parse --path-format=absolute --git-common-dir --show-toplevel` -> { common, top, main, name }. */
export function parseRepo(text) {
  const [common, top] = String(text ?? "").split("\n").map((s) => s.trim());
  if (!common || !top) return null;
  const main = common.endsWith("/.git") ? common.slice(0, -5) : common;
  const name = top.split("/").filter(Boolean).pop() || top;
  return { common, top, main, name, linked: main !== top };
}

// ---------- in-progress operations ----------

export const OP_REFS = [["merge", "MERGE_HEAD"], ["rebase", "REBASE_HEAD"], ["cherry-pick", "CHERRY_PICK_HEAD"], ["revert", "REVERT_HEAD"]];

/** { merge, rebase, "cherry-pick", revert, rebaseDir } booleans -> the operation in progress or null. */
export function inProgressOp(found) {
  if (!found) return null;
  if (found.rebaseDir || found.rebase) return "rebase";
  for (const [op] of OP_REFS) if (found[op]) return op;
  return null;
}

// ---------- branch names ----------

/** Why `name` can't be a branch name, or null. git check-ref-format --branch decides last. */
export function branchNameProblem(name) {
  const n = String(name ?? "");
  if (!n.trim()) return "Type a branch name";
  if (n !== n.trim()) return "No spaces at the start or end";
  if (n.startsWith("-")) return "A branch name can't start with -";
  if (n.startsWith("+")) return "A branch name can't start with +";
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(n)) return "No spaces or ~ ^ : ? * [ \\ in a branch name";
  if (n.includes("..") || n.includes("@{") || n.includes("//")) return "No .., @{ or // in a branch name";
  if (n === "@" || n === "HEAD") return `${n} is reserved`;
  if (n.endsWith("/") || n.endsWith(".") || n.endsWith(".lock") || n.startsWith("/")) return "Bad start or end";
  if (n.split("/").some((p) => p.startsWith("."))) return "A part can't start with .";
  if (n.length > 200) return "Too long";
  return null;
}

/** A ref this UI passes to git as a positional argument (branch or remote/branch). */
export function safeRef(ref) {
  const r = String(ref ?? "");
  if (!r || branchNameProblem(r)) throw new Error("bad ref");
  return r;
}

const safeRemote = (r) => {
  const s = String(r ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(s) || s.includes("..")) throw new Error("bad remote");
  return s;
};

// ---------- argv builders (git args, without the leading "git") ----------

export const statusArgs = () => ["-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch", "-z"];
export const localArgs = () => ["for-each-ref", `--format=${LOCAL_FORMAT}`, "refs/heads"];
export const remoteArgs = () => ["for-each-ref", `--format=${REMOTE_FORMAT}`, "refs/remotes"];
export const reflogArgs = () => ["reflog", "show", "--format=%gs", "-n", "300", "HEAD"];
export const repoArgs = () => ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"];
export const worktreeArgs = () => ["worktree", "list", "--porcelain"];
export const symrefArgs = (remote) => ["symbolic-ref", "--quiet", "--short", `refs/remotes/${safeRemote(remote)}/HEAD`];
export const aheadBehindArgs = (a, b) => ["rev-list", "--left-right", "--count", `${safeRef(a)}...${safeRef(b)}`];
/** Commits `source` would bring into `target`. */
export const incomingArgs = (target, source) => ["rev-list", "--count", `${safeRef(target)}..${safeRef(source)}`];
export const isAncestorArgs = (a, b) => ["merge-base", "--is-ancestor", safeRef(a), safeRef(b)];
export const checkRefArgs = (name) => ["check-ref-format", "--branch", safeRef(name)];

/** Switch to a local branch, or create a tracking branch for a remote-only one. */
export function switchArgs(branch, remoteRef = null) {
  if (remoteRef) return ["switch", "--track", safeRef(remoteRef)];
  return ["switch", "--", safeRef(branch)];
}
/** `git fetch <remote>`; `--prune` (drops remote-tracking refs gone upstream) only when the user opts in. */
export const fetchArgs = (remote, { prune = false } = {}) => (prune === true ? ["fetch", "--prune", safeRemote(remote)] : ["fetch", safeRemote(remote)]);
export const pullArgs = () => ["merge", "--ff-only", "@{upstream}"];
export function mergeArgs(branch, mode) {
  if (mode === "ff") return ["merge", "--ff-only", "--", safeRef(branch)];
  if (mode === "noff") return ["merge", "--no-ff", "--no-edit", "--", safeRef(branch)];
  throw new Error("bad merge mode");
}
export function pushArgs({ hasUpstream, remote, branch }) {
  if (hasUpstream) return ["push"];
  return ["push", "-u", safeRemote(remote), safeRef(branch)];
}
export const newBranchArgs = (name, from) => ["switch", "-c", safeRef(name), safeRef(from)];
export const abortMergeArgs = () => ["merge", "--abort"];

// ---------- forbidden-flag check (every git / gh / glab / helper argv) ----------

const NET_ENV = ["-u", "HERDR_ENV", "-u", "HERDR_SOCKET_PATH", "-u", "HERDR_PANE_ID", "GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=never"];

/** argv for a network git call: no prompts, no herdr session variables. */
export const netArgv = (gitArgs) => ["env", ...NET_ENV, "git", ...gitArgs];
/** argv for a local git read. */
export const readArgv = (gitArgs) => ["git", "--no-optional-locks", ...gitArgs];
/** argv for a local git write. */
export const writeArgv = (gitArgs) => ["git", ...gitArgs];

const GIT_READ = new Set(["status", "for-each-ref", "reflog", "symbolic-ref", "rev-parse", "rev-list", "merge-base", "worktree", "config", "remote", "check-ref-format", "log"]);
const GIT_WRITE = new Set(["switch", "fetch", "merge", "push"]);
const GH_ALLOWED = [["pr", "list"], ["pr", "view"], ["pr", "merge"], ["api", "graphql"]];
const GLAB_ALLOWED = [["mr", "list"]];

/** Splits `env [-u X]... [K=V]... prog args` -> { env, prog, args }. */
export function splitArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== "string")) return null;
  let i = 0;
  if (argv[0] === "env") {
    i = 1;
    while (i < argv.length) {
      if (argv[i] === "-u") { i += 2; continue; }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) { i++; continue; }
      break;
    }
  }
  if (i >= argv.length) return null;
  return { prog: argv[i], args: argv.slice(i + 1) };
}

// Flags no call from this mod may carry, whatever the program.
const FORBIDDEN_LONG = /^--(force|force-with-lease|force-if-includes|admin|hard|mirror|delete|discard-changes|no-verify|prune-tags|unshallow|exec|upload-pack|receive-pack|output|template|config-env)(=|$)/;

/** null when argv may run, else why not. `kind`: "read" | "write" | "net" | "gh" | "glab" | "helper". */
export function forbiddenReason(argv, kind) {
  const sp = splitArgv(argv);
  if (!sp) return "not an argv array";
  const { prog, args } = sp;
  if (args.some((a) => a.includes("\0"))) return "NUL in argument";
  for (const a of args) {
    if (FORBIDDEN_LONG.test(a)) return `forbidden flag ${a.split("=")[0]}`;
    // a single-dash short cluster with f (-f, -fd, -uf) or D (branch -D)
    if (/^-[A-Za-z]+$/.test(a) && /[fD]/.test(a.slice(1)) && !(kind === "glab" && a === "-F")) return `forbidden flag ${a}`;
  }
  if (kind === "helper") {
    return prog ? null : "empty helper";
  }
  if (kind === "gh") {
    if (prog !== "gh") return "not gh";
    if (!GH_ALLOWED.some(([a, b]) => args[0] === a && args[1] === b)) return `gh ${args[0] ?? ""} ${args[1] ?? ""} is not allowed`;
    if (args[0] === "pr" && args[1] === "merge") {
      if (!args.includes("--auto")) return "gh pr merge only with --auto";
      // exactly: pr merge <n> [--repo R] --auto --squash|--merge|--rebase ; nothing else (no --delete-branch, --body, ...)
      const rest = args.slice(2);
      let n = 0, method = 0;
      for (let j = 0; j < rest.length; j++) {
        const a = rest[j];
        if (a === "--repo") { j++; continue; }
        if (a === "--auto") continue;
        if (a === "--squash" || a === "--merge" || a === "--rebase") { method++; continue; }
        if (/^\d+$/.test(a)) { n++; continue; }
        return `gh pr merge: ${a.startsWith("-") ? a.split("=")[0] : "argument"} is not allowed`;
      }
      if (n !== 1 || method !== 1) return "gh pr merge needs one PR number and one method";
    }
    if (args[0] === "api" && args.some((a) => /^(-X|--method)$/.test(a) || /\bmutation\b/.test(a))) return "gh api only for queries";
    return null;
  }
  if (kind === "glab") {
    if (prog !== "glab") return "not glab";
    if (!GLAB_ALLOWED.some(([a, b]) => args[0] === a && args[1] === b)) return `glab ${args[0] ?? ""} ${args[1] ?? ""} is not allowed`;
    return null;
  }
  if (prog !== "git") return "not git";
  // git global options before the subcommand
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === "--no-optional-locks") { i++; continue; }
    if (a === "-c") { if (!/^core\.fsmonitor=false$/.test(args[i + 1] ?? "")) return "only -c core.fsmonitor=false"; i += 2; continue; }
    break;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub) return "no git subcommand";
  if (sub.startsWith("-")) return `git global option ${sub} is not allowed`;
  const allowed = kind === "read" ? GIT_READ : kind === "write" || kind === "net" ? GIT_WRITE : null;
  if (!allowed) return `bad kind ${kind}`;
  if (!allowed.has(sub)) return `git ${sub} is not allowed here`;
  if ((sub === "fetch" || sub === "push") && kind !== "net") return `git ${sub} must run as a network call`;
  if (sub === "worktree" && rest[0] !== "list") return "git worktree: list only";
  if (sub === "config" && !["--get", "--get-regexp"].includes(rest[0])) return "git config: reads only";
  if (sub === "remote" && rest.length > 0 && !(rest[0] === "get-url" || rest[0] === "-v")) return "git remote: list only";
  if (sub === "reflog" && rest[0] !== "show") return "git reflog: show only";
  if (sub === "symbolic-ref" && rest.filter((a) => !a.startsWith("-")).length !== 1) return "git symbolic-ref: read only";
  if (sub === "push") {
    for (const a of rest) {
      if (a.startsWith("+") || a.includes(":")) return "push refspecs with + or : are not allowed";
      if (a.startsWith("-") && !["-u", "--set-upstream", "--porcelain"].includes(a)) return `push ${a} is not allowed`;
    }
    if (rest.filter((a) => !a.startsWith("-")).length > 2) return "push: one remote and one branch";
  }
  if (sub === "fetch" && rest.some((a) => a.startsWith("+") || a.includes(":"))) return "fetch refspecs are not allowed";
  if (sub === "switch" && rest.some((a) => a.startsWith("-") && !["--", "-c", "--track"].includes(a))) return "switch: only -c and --track";
  if (sub === "merge") {
    const ok = ["--ff-only", "--no-ff", "--no-edit", "--abort", "--"];
    if (rest.some((a) => a.startsWith("-") && !ok.includes(a))) return "merge: only --ff-only, --no-ff, --no-edit, --abort";
  }
  return null;
}

// ---------- blockers ----------

/**
 * What stands in the way of `action` ("switch" | "merge" | "pull" | "push" | "newBranch" | "fetch" | "abort").
 * state: { status, op, readAt, agentsBusy: [names], target?: {name, worktree} }
 * -> [{ code, level: "block" | "warn", text }]
 */
export function blockers(action, state, now = Date.now()) {
  const out = [];
  const add = (code, level, text) => out.push({ code, level, text });
  const st = state?.status;
  if (!st) { add("unread", "block", "Repository state not read yet"); return out; }
  if (state.readAt == null || now - state.readAt > STALE_MS) add("stale", "block", "State is more than 10 s old: reading again first");
  const op = state.op ?? null;
  const tracked = trackedChanges(st);
  const busy = state.agentsBusy ?? [];
  if (action === "abort") {
    if (op !== "merge") add("noMerge", "block", "No merge in progress");
    if (busy.length) add("agentBusy", "warn", `Agent working here: ${busy.join(", ")}`);
    return out;
  }
  if (action === "fetch") return out;
  if (op && action !== "push") add("inProgress", "block", `A ${op} is in progress: finish or abort it first`);
  if (st.conflicted.length && action !== "push") add("conflicts", "block", `${st.conflicted.length} conflicted file${st.conflicted.length === 1 ? "" : "s"}`);
  const writesTree = action === "switch" || action === "merge" || action === "pull" || action === "newBranch";
  if (writesTree && busy.length) add("agentBusy", "block", `Agent working in this repo: ${busy.join(", ")}`);
  if (action === "switch" || action === "newBranch") {
    if (tracked) add("dirty", "warn", `${tracked} uncommitted change${tracked === 1 ? " goes" : "s go"} along; git refuses if they collide`);
    if (st.untracked) add("untracked", "warn", `${st.untracked} untracked file${st.untracked === 1 ? "" : "s"}`);
    const wt = state.target?.worktree;
    if (action === "switch" && wt && wt !== state.top) add("otherWorktree", "block", "Checked out in another worktree: go there instead");
  }
  if (action === "merge") {
    if (st.detached) add("detached", "block", "Detached HEAD: switch to a branch first");
    if (tracked) add("dirty", "block", `${tracked} uncommitted change${tracked === 1 ? "" : "s"}: commit or stash first`);
    if (st.untracked) add("untracked", "block", `${st.untracked} untracked file${st.untracked === 1 ? "" : "s"}: a merge can overwrite them`);
    if (state.target?.name && state.target.name === st.head) add("self", "block", "That is the current branch");
  }
  if (action === "pull") {
    if (st.detached) add("detached", "block", "Detached HEAD");
    if (!st.upstream) add("noUpstream", "block", "No upstream branch");
    if (tracked) add("dirty", "warn", `${tracked} uncommitted change${tracked === 1 ? "" : "s"}`);
  }
  if (action === "push") {
    if (st.detached) add("detached", "block", "Detached HEAD: nothing to push");
    if (op) add("inProgress", "block", `A ${op} is in progress`);
    if (st.upstream && st.behind > 0) add("behind", "block", `Behind ${st.upstream} by ${st.behind}: pull first`);
    if (st.upstream && st.hasAB && st.ahead === 0) add("nothing", "block", "Nothing to push");
    if (state.isDefault) add("default", "warn", "This is the default branch: the push goes straight to it");
  }
  return out;
}

export const blocking = (list) => (list ?? []).filter((b) => b.level === "block");

/** Agents whose pane folder is inside `top` and that are working. */
export function agentsBusyIn(top, agentList, paneList) {
  if (!top) return [];
  const cwdOf = new Map((paneList ?? []).map((p) => [p.pane, p.cwd]));
  const inside = (p) => !!p && (p === top || p.startsWith(top.endsWith("/") ? top : `${top}/`));
  return (agentList ?? [])
    .filter((a) => a.status === "working" && inside(cwdOf.get(a.pane)))
    .map((a) => clean(a.title || a.app || a.address, 40));
}

// ---------- git output for the UI ----------

/** One short line from git's stderr, with URL userinfo removed and secrets masked by `redact`. */
export function gitProblem(text, redact = (s) => ({ text: s })) {
  const lines = String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/^hint:/i.test(l));
  const pick = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[0] ?? "";
  if (/terminal prompts disabled|could not read Username|Authentication failed|Permission denied \(publickey/i.test(text ?? "")) return "Authentication needed: run the command in a terminal once";
  if (/Could not resolve host|unable to access|Connection (timed out|refused)/i.test(text ?? "")) return "Network problem: the remote did not answer";
  return clean(redact(stripUserinfo(pick)).text, 240);
}

/** Conflict files -> the prompt text for an agent. */
export function conflictPrompt(branch, files, op = "merge") {
  const list = files.slice(0, 40).map((f) => `- ${clean(f, 200)}`).join("\n");
  const more = files.length > 40 ? `\n(+${files.length - 40} more)` : "";
  return clean(`The ${op} into ${branch || "the current branch"} stopped with conflicts in:\n${list}${more}\nResolve them, keeping both sides' intent, then stage the files. Do not commit, abort or force anything.`, MAX_TEXT);
}

/** Filter for branch lists: every space-separated word must appear (case-insensitive). */
export function matches(name, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return true;
  const n = String(name ?? "").toLowerCase();
  return q.split(/\s+/).every((w) => n.includes(w));
}

/** The folder this view reads: props.cwd, the focused pane, the focused agent's pane, a terminal in the focused tab, the space folder. */
export function pickFolder({ propsCwd, focus, paneList, spaceList, agentList }) {
  if (propsCwd) return String(propsCwd);
  if (focus?.cwd) return focus.cwd;
  const panesById = new Map((paneList ?? []).map((p) => [p.pane, p]));
  if (focus?.agent) {
    const a = (agentList ?? []).find((x) => x.address === focus.agent);
    const p = a && panesById.get(a.pane);
    if (p?.cwd) return p.cwd;
  }
  if (focus?.tab) {
    const p = (paneList ?? []).find((x) => x.tab === focus.tab && x.cwd);
    if (p) return p.cwd;
  }
  const sp = (spaceList ?? []).find((s) => s.id === focus?.space) ?? (spaceList ?? []).find((s) => s.active);
  return sp?.folder || null;
}

/** The space and tab whose panes sit in `folder` (for "go to that worktree"). */
export function placeOf(folder, paneList, spaceList) {
  if (!folder) return null;
  const inside = (p) => !!p && (p === folder || p.startsWith(`${folder}/`));
  const pane = (paneList ?? []).find((p) => inside(p.cwd));
  if (!pane) return null;
  const space = (spaceList ?? []).find((s) => (s.tabs ?? []).some((t) => t.id === pane.tab));
  return space ? { space: space.id, tab: pane.tab, name: space.name } : null;
}

// ---------- system opener per platform ("macos" | "linux" | "windows") ----------

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
/** [program, args] that opens a local file or folder with its default app, or null when the path
 * is not absolute for that system. Windows paths start with a drive letter and go to explorer.exe
 * with backslashes. */
export function openerArgv(platform, path) {
  const p = String(path ?? "");
  if (platform === "windows") return /^[A-Za-z]:[\\/]/.test(p) ? ["explorer.exe", [p.replace(/\//g, "\\").replace(/^([A-Za-z]:)$/, "$1\\")]] : null;
  if (!p.startsWith("/")) return null;
  return platform === "linux" ? ["xdg-open", [p]] : ["open", [p]];
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
  "jnlp", "theme", "themepack", "mht", "xbap",
  "pyc", "pyo", "ps1xml", "ps2", "ps2xml", "psc2", "vsto", "mde", "accde", "mshxml", "mmc", "ocx", "sys", "dll"]);
// Would explorer.exe run this path? The name after the last / or \, with the trailing dots and spaces
// Windows drops ("a.exe." runs a.exe). A name that is only an extension (".js") counts. A ":" means an
// NTFS stream ("a.exe:s", "a.lnk::$DATA"), which is refused too.
function windowsRuns(p) {
  const b = String(p ?? "").split(/[\\/]/).pop().toLowerCase().replace(/[. ]+$/, ""), i = b.lastIndexOf(".");
  return b.includes(":") || (i >= 0 && (LAUNCH_EXT.has(b.slice(i + 1)) || WINDOWS_LAUNCH_EXT.has(b.slice(i + 1))));
}
/** Why a file would run instead of open (Windows only), else null. */
export function launchRisk(path, platform) {
  return platform === "windows" && windowsRuns(path) ? "this file is a script or launcher and would run" : null;
}
export const COMMA_PATH = "Explorer can't open paths with a comma. Copy the path instead.";
/** Why the system opener must not get this path, else null: a launcher, or a comma explorer.exe would split at. */
export function openerProblem(platform, path) {
  const risk = launchRisk(path, platform);
  if (risk) return `Not opened: ${risk}. Copy the path instead.`;
  return platform === "windows" && String(path ?? "").includes(",") ? COMMA_PATH : null;
}

/** Did the opener work? explorer.exe exits 1 even when it did, so its code is ignored. */
export const openerWorked = (platform, code) => platform === "windows" || code === 0;

/** What to say when the opener could not start. */
export function openerError(platform, error) {
  const missing = /program not found/i.test(String(error?.message ?? error ?? ""));
  if (missing && platform === "linux") return "Install xdg-utils to open files";
  if (missing && platform === "windows") return "explorer.exe was not found";
  return "Could not open it";
}
