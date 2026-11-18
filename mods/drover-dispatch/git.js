// Git and gh calls for Dispatch. Every call is an argv array; nothing here builds a shell line.
// git: reads with --no-optional-locks, and the one write `worktree add -b`. gh: read-only.
import { exec } from "herdr";
import { parseRepo, repoFromRemotes, parseWorktrees, defaultFromRemoteHead, addArgs, ghProblem } from "./logic.js";

const READ_MS = 15000;
const GH_MS = 20000;

export async function gitRead(cwd, args) {
  const r = await exec("git", ["--no-optional-locks", ...args], { cwd, timeout: READ_MS });
  return { ok: r.code === 0, out: r.stdout ?? "", err: (r.stderr || r.stdout || "").trim() };
}

/** { main, repo } of a folder, or throws a sentence. */
export async function repoOf(folder) {
  const top = await gitRead(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"]);
  const parsed = top.ok ? parseRepo(top.out) : null;
  if (!parsed) throw new Error("The focused space is not in a git repository.");
  const remotes = await gitRead(parsed.main, ["remote", "-v"]);
  const repo = remotes.ok ? repoFromRemotes(remotes.out) : null;
  if (!repo) throw new Error("This repository has no github.com remote.");
  return { main: parsed.main, repo };
}

/** Facts Set up decides on, read fresh: worktrees, local branches, the local default branch, and
 *  whether the planned folder exists. */
export async function readFacts(main, path) {
  const [list, heads, remoteHead, folder] = await Promise.all([
    gitRead(main, ["worktree", "list", "--porcelain"]),
    gitRead(main, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
    gitRead(main, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
    path ? exec("test", ["-e", path], { timeout: READ_MS }).then((r) => r.code === 0).catch(() => false) : false,
  ]);
  const branches = new Set(heads.ok ? heads.out.split("\n").map((s) => s.trim()).filter(Boolean) : []);
  // The default branch as it is locally: origin/HEAD's name, else main, else master.
  const named = remoteHead.ok ? defaultFromRemoteHead(remoteHead.out) : null;
  const base = [named, "main", "master"].find((b) => b && branches.has(b)) ?? null;
  return { worktrees: list.ok ? parseWorktrees(list.out) : [], branches, base, folderExists: folder };
}

/** Real path with symlinks resolved; the missing tail is appended as written. */
export async function realPathOf(path) {
  const rest = [];
  let cur = path;
  while (cur && cur !== "/") {
    const r = await exec("realpath", ["--", cur], { timeout: READ_MS }).catch(() => null);
    const real = r?.code === 0 ? r.stdout.trim() : "";
    if (real) return [real === "/" ? "" : real, ...rest].join("/") || "/";
    const i = cur.lastIndexOf("/");
    rest.unshift(cur.slice(i + 1));
    cur = cur.slice(0, i);
  }
  return null;
}

/** The given paths that are symlinks, dangling ones too (test -L does not follow the link).
 *  A check that cannot run counts as a symlink. */
export async function symlinkParts(paths) {
  const hits = await Promise.all(paths.map(async (path) => {
    const r = await exec("test", ["-L", path], { timeout: READ_MS }).catch(() => null);
    return r?.code === 1 ? null : path;
  }));
  return hits.filter(Boolean);
}

/** git worktree add --no-track -b <branch> <path> <base>. "" on success, else the error. */
export async function addWorktree(main, path, branch, base) {
  const r = await exec("git", addArgs(path, branch, base), { cwd: main, timeout: 120000 });
  return r.code === 0 ? "" : (r.stderr || r.stdout || "git worktree add failed.").trim().split("\n").pop();
}

/** gh, read-only. Throws a one-line sentence. */
export async function gh(args) {
  let r;
  try {
    r = await exec("gh", args, { timeout: GH_MS });
  } catch {
    throw new Error("GitHub CLI (gh) is not installed.");
  }
  if (r.code !== 0) throw new Error(ghProblem(r.stderr));
  return r.stdout ?? "";
}
