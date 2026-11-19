// The one place this mod starts programs. Every argv is checked by forbiddenReason first; a call
// that fails the check never runs. Output shown to the person goes through gitProblem (URL
// userinfo stripped, secrets masked); the argv itself is never shown or logged.
import { exec, readTextFile } from "herdr";
import { redact, isDenied } from "./lib/guard.js";
import {
  forbiddenReason, readArgv, writeArgv, netArgv, gitProblem, NET_MS, HELPER_MS,
  parseStatus, parseLocalBranches, parseRemoteBranches, parseRemoteNames, recentBranches, defaultBranch,
  parseWorktrees, parseRepo, inProgressOp, OP_REFS, parseAheadBehind,
  statusArgs, localArgs, remoteArgs, reflogArgs, repoArgs, worktreeArgs, symrefArgs, incomingArgs, isAncestorArgs,
  aheadBehindArgs, checkRefArgs, openerArgv, openerWorked, openerError, openerProblem, windowsParts, winLinkArgv, WIN_LINK_PLAIN, WIN_LINK_MARK,
} from "./logic.js";
import { parseRemoteUrls, pickRemote, parseRemote } from "./forges/index.js";

export const READ_MS = 15000;
export const WRITE_MS = 120000;

/**
 * Runs argv[0] with argv[1..] after the forbidden-flag check.
 * -> { ok, code, out, err } ; err is a short display-safe line. Never throws.
 */
export async function call(kind, argv, { cwd, on, timeout } = {}) {
  const why = forbiddenReason(argv, kind);
  if (why) return { ok: false, code: -2, out: "", err: `Refused: ${why}`, refused: true };
  let r;
  try {
    r = await exec(argv[0], argv.slice(1), { cwd: cwd ?? undefined, on: on ?? undefined, timeout: timeout ?? READ_MS });
  } catch (e) {
    const msg = String(e?.message ?? e);
    const timedOut = /time ?out|timed out/i.test(msg);
    // Network calls go through env. Windows has no env unless Git for Windows' usr\bin is on PATH.
    const noEnv = argv[0] === "env" && /program not found/i.test(msg);
    const err = timedOut ? "Auth/network timeout: try the command in a terminal"
      : noEnv ? "Could not run git: env is not on PATH. On Windows, add Git for Windows' usr\\bin to PATH"
      : `Could not run ${argv[0] === "env" ? "git" : argv[0]}`;
    return { ok: false, code: -1, out: "", err, timedOut };
  }
  const code = r?.code ?? -1;
  return { ok: code === 0, code, out: r?.stdout ?? "", err: code === 0 ? "" : gitProblem(r?.stderr || r?.stdout || `exit ${code}`, redact) };
}

export const gitRead = (cwd, on, args) => call("read", readArgv(args), { cwd, on, timeout: READ_MS });
export const gitWrite = (cwd, on, args) => call("write", writeArgv(args), { cwd, on, timeout: WRITE_MS });
export const gitNet = (cwd, on, args) => call("net", netArgv(args), { cwd, on, timeout: NET_MS });
export const gh = (args, timeout = 20000) => call("gh", ["gh", ...args], { timeout });
export const glab = (args, timeout = 20000) => call("glab", ["glab", ...args], { timeout });
export const helper = (argv) => call("helper", argv, { timeout: HELPER_MS });

/** The repository a folder is in, or null. */
export async function repoOf(folder, on) {
  if (!folder) return null;
  const r = await gitRead(folder, on, repoArgs());
  return r.ok ? parseRepo(r.out) : null;
}

/** Which operation is in progress (merge, rebase, cherry-pick, revert) or null. */
export async function readOp(top, on) {
  const found = {};
  const refs = await Promise.all(OP_REFS.map(([, ref]) => gitRead(top, on, ["rev-parse", "-q", "--verify", ref])));
  OP_REFS.forEach(([op], i) => { found[op] = refs[i].ok; });
  // A rebase that stopped before REBASE_HEAD exists still has its state directory.
  const dirs = await gitRead(top, on, ["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge", "--git-path", "rebase-apply"]);
  if (dirs.ok) {
    for (const d of dirs.out.split("\n").map((s) => s.trim()).filter(Boolean)) {
      try {
        if ((await readTextFile(`${d}/head-name`, { on: on ?? undefined })) != null) found.rebaseDir = true;
      } catch { /* not there: no rebase of that kind */ }
    }
  }
  return inProgressOp(found);
}

/** Everything the browser shows for one repository. */
export async function readAll(repo, on) {
  const top = repo.top;
  const [status, locals, remotes, remoteNames, reflog, worktrees, urls, initDefault] = await Promise.all([
    gitRead(top, on, statusArgs()),
    gitRead(top, on, localArgs()),
    gitRead(top, on, remoteArgs()),
    gitRead(top, on, ["remote"]),
    gitRead(top, on, reflogArgs()),
    gitRead(top, on, worktreeArgs()),
    gitRead(top, on, ["config", "--get-regexp", "^remote\\..*\\.url$"]),
    gitRead(top, on, ["config", "--get", "init.defaultBranch"]),
  ]);
  if (!status.ok) throw new Error(status.err || "git status failed");
  const st = parseStatus(status.out);
  const localList = locals.ok ? parseLocalBranches(locals.out) : [];
  const names = remoteNames.ok ? parseRemoteNames(remoteNames.out) : [];
  const remoteList = remotes.ok ? parseRemoteBranches(remotes.out, names) : [];
  const remoteUrls = urls.ok ? parseRemoteUrls(urls.out) : [];
  const upstreamRemote = st.upstream ? names.find((n) => st.upstream.startsWith(`${n}/`)) ?? null : null;
  const remote = pickRemote(remoteUrls, upstreamRemote)?.remote ?? names[0] ?? null;
  let symref = "";
  if (remote) {
    const s = await gitRead(top, on, symrefArgs(remote));
    symref = s.ok ? s.out.trim() : "";
  }
  const op = await readOp(top, on);
  const current = st.head;
  return {
    status: st,
    op,
    locals: localList,
    remotes: remoteList,
    remoteNames: names,
    remote,
    upstreamRemote,
    remoteUrls,
    recent: reflog.ok ? recentBranches(reflog.out, new Set(localList.map((l) => l.name)), current) : [],
    def: defaultBranch({ symref, remote: remote ?? "origin", remoteBranches: remoteList, locals: localList, initDefault: initDefault.ok ? initDefault.out : "" }),
    worktrees: worktrees.ok ? parseWorktrees(worktrees.out) : [],
    readAt: Date.now(),
  };
}

/** The forge for the chosen remote, or null. */
export function forgeOf(data, forgeHosts) {
  const pick = pickRemote(data?.remoteUrls ?? [], data?.upstreamRemote);
  return pick ? parseRemote(pick.url, forgeHosts) : null;
}

/** Commits `source` would bring into `target`, and whether a fast-forward is possible. */
export async function mergePreview(top, on, target, source) {
  const [n, ff] = await Promise.all([gitRead(top, on, incomingArgs(target, source)), gitRead(top, on, isAncestorArgs(target, source))]);
  return { incoming: n.ok ? parseInt(n.out.trim(), 10) || 0 : null, ff: ff.code === 0, error: n.ok ? null : n.err };
}

/** Ahead/behind of `a` against `b`. */
export async function compare(top, on, a, b) {
  const r = await gitRead(top, on, aheadBehindArgs(a, b));
  return r.ok ? parseAheadBehind(r.out) : null;
}

/**
 * Opens a local file or folder with the system's default app. Credential files are refused.
 * On Windows launchers, paths with a comma and paths through a link or junction are refused too; `copy` then holds
 * the path to offer. Streams and short 8.3 names are refused outright.
 */
export async function openLocal(path, platform = "macos") {
  let p = String(path ?? "");
  // Windows: every part trimmed the way Windows reads it before the credential check, as in drover-viewer.
  const w = platform === "windows" ? windowsParts(p) : null;
  // Local Windows opens only a full drive path; anything else is refused, never passed on as it is.
  if (platform === "windows" && !w) return { ok: false, err: "Refused: not a full drive path" };
  if (w?.error) return { ok: false, err: "Refused: the path has " + w.error };
  if (w) p = w.path;
  const argv = p.includes("\0") || isDenied(p) ? null : openerArgv(platform, p);
  if (!argv) return { ok: false, err: "Refused: not a file this view opens" };
  const problem = openerProblem(platform, p);
  if (problem) return { ok: false, err: problem, copy: p };
  if (platform === "windows") {
    // No realpath here: a link or junction on the path could lead to a credential file, so it is refused, and so is a
    // path the check couldn't finish on. The name itself passed the check above, so it may be copied.
    const r = await exec(...winLinkArgv(p), { timeout: 15000 }).catch(() => null);
    const out = r?.code === 0 ? String(r.stdout ?? "").trim() : "";
    if (out === WIN_LINK_MARK) return { ok: false, err: "Not opened: this path goes through a link or junction. Copy the path instead.", copy: p };
    if (out !== WIN_LINK_PLAIN) return { ok: false, err: "Not opened: couldn't check this path for links. Copy the path instead.", copy: p };
  }
  try {
    const r = await exec(argv[0], argv[1], { timeout: 10000 });
    const ok = openerWorked(platform, r.code);
    return { ok, err: ok ? "" : "Could not open it" };
  } catch (e) {
    return { ok: false, err: openerError(platform, e) };
  }
}

/** git's own verdict on a new branch name. */
export async function validBranch(top, on, name) {
  const r = await gitRead(top, on, checkRefArgs(name));
  return r.ok;
}
