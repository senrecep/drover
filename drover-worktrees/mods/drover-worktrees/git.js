// Git and gh calls for the Worktrees page. Every call is an argv array with the folder as
// cwd; nothing here builds a shell line. Reads use --no-optional-locks.
import { exec, readTextFile } from "herdr";
import { parseWorktrees, parseStatus, parseRepo, githubFromRemotes, parseLaunch } from "./logic.js";

const READ_MS = 15000;

// A git read. Rejects only when git can't be started or the machine can't be reached.
export async function gitRead(cwd, on, args) {
  const r = await exec("git", ["--no-optional-locks", ...args], { cwd, on, timeout: READ_MS });
  return { ok: r.code === 0, code: r.code, out: r.stdout ?? "", err: (r.stderr || r.stdout || "").trim() };
}

// A git write (worktree add / remove).
export async function gitWrite(cwd, on, args, timeout = 120000) {
  const r = await exec("git", args, { cwd, on, timeout });
  return { ok: r.code === 0, out: r.stdout ?? "", err: (r.stderr || r.stdout || "").trim() };
}

// The real path of `path` with symlinks resolved. The part that doesn't exist yet is appended
// as written (git creates it). null when nothing up the chain resolves.
export async function realPathOf(path, on) {
  const rest = [];
  let cur = path;
  while (cur && cur !== "/") {
    const r = await exec("realpath", [cur], { on, timeout: READ_MS });
    const real = r.code === 0 ? r.stdout.trim() : "";
    if (real) return [real === "/" ? "" : real, ...rest].join("/") || "/";
    const i = cur.lastIndexOf("/");
    rest.unshift(cur.slice(i + 1));
    cur = cur.slice(0, i);
  }
  return null;
}

// The repository a folder belongs to: { main, top, name }, or null outside git.
export async function repoOf(folder, on) {
  const r = await gitRead(folder, on, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"]);
  return r.ok ? parseRepo(r.out) : null;
}

// One worktree's changed files, upstream, ahead/behind, unpushed commits and last commit time.
// A value git couldn't give stays null (removal treats null as a reason to refuse).
export async function readWorktree(wt, on) {
  const out = { ...wt, dirty: null, upstream: null, ahead: 0, behind: 0, unpushed: null, committed: 0 };
  if (wt.bare || wt.prunable) return out;
  const [status, unpushed, last] = await Promise.all([
    gitRead(wt.path, on, ["-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"]).catch(() => null),
    // Commits on HEAD that no remote-tracking ref has: covers no upstream and detached HEAD.
    gitRead(wt.path, on, ["rev-list", "--count", "HEAD", "--not", "--remotes"]).catch(() => null),
    gitRead(wt.path, on, ["log", "-1", "--format=%ct"]).catch(() => null),
  ]);
  if (status?.ok) Object.assign(out, parseStatus(status.out));
  if (unpushed?.ok) out.unpushed = parseInt(unpushed.out.trim(), 10) || 0;
  if (last?.ok) out.committed = parseInt(last.out.trim(), 10) || 0;
  return out;
}

// Everything the page shows for one repository.
export async function readRepo(repo, on) {
  const list = await gitRead(repo.main, on, ["worktree", "list", "--porcelain"]);
  if (!list.ok) throw new Error(list.err || "git worktree list failed");
  const [worktrees, head, remotes, launch] = await Promise.all([
    Promise.all(parseWorktrees(list.out).map((wt) => readWorktree(wt, on))),
    gitRead(repo.main, on, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => null),
    gitRead(repo.main, on, ["config", "--get-regexp", "^remote\\..*\\.url$"]).catch(() => null),
    readTextFile(`${repo.main}/.claude/launch.json`, { on }).catch(() => null),
  ]);
  const remoteHead = head?.ok ? head.out.trim().replace(/^origin\//, "") : "";
  return {
    worktrees,
    defaultBranch: remoteHead || worktrees[0]?.branch || "",
    github: remotes?.ok ? githubFromRemotes(remotes.out) : null,
    launch: launch == null ? null : parseLaunch(launch),
  };
}

// Recent PRs of a GitHub repository via the local gh. Throws { gh: "missing" | "error" }.
export async function listPrs(slug) {
  let r;
  try {
    r = await exec("gh", ["pr", "list", "--repo", slug, "--state", "all", "--limit", "100",
      "--json", "number,state,headRefName,isCrossRepository,updatedAt"], { timeout: 20000 });
  } catch {
    throw Object.assign(new Error("gh is not installed"), { gh: "missing" });
  }
  if (r.code !== 0) throw Object.assign(new Error((r.stderr || "gh failed").trim().split("\n")[0]), { gh: "error" });
  return JSON.parse(r.stdout || "[]");
}
