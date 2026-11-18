// Pure logic for the Worktrees page: no herdr or gpui imports, so node --test runs it.

const trimSlash = (p) => p.replace(/\/+$/, "");

// `git worktree list --porcelain`: blocks split by blank lines. The first is the main checkout.
export function parseWorktrees(out) {
  const list = [];
  for (const block of String(out ?? "").split(/\n\s*\n/)) {
    const lines = block.split("\n").filter(Boolean);
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path) continue;
    const field = (name) => {
      const l = lines.find((x) => x === name || x.startsWith(`${name} `));
      return l === undefined ? undefined : l.slice(name.length + 1);
    };
    const branchRef = field("branch");
    list.push({
      path: trimSlash(path) || "/",
      head: field("HEAD") ?? null,
      branch: branchRef ? branchRef.replace(/^refs\/heads\//, "") : null,
      detached: field("detached") !== undefined,
      bare: field("bare") !== undefined,
      locked: field("locked") !== undefined,
      lockReason: field("locked") || "",
      prunable: field("prunable") !== undefined,
      main: list.length === 0,
    });
  }
  return list;
}

// `git status --porcelain=v2 --branch`: changed-file count, upstream and ahead/behind.
export function parseStatus(out) {
  const r = { dirty: 0, upstream: null, ahead: 0, behind: 0 };
  for (const line of String(out ?? "").split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.upstream ")) r.upstream = line.slice(18).trim();
    else if (line.startsWith("# branch.ab ")) {
      const [a, b] = line.slice(12).trim().split(" ");
      r.ahead = Math.abs(parseInt(a, 10)) || 0;
      r.behind = Math.abs(parseInt(b, 10)) || 0;
    } else if (!line.startsWith("#")) r.dirty++;
  }
  return r;
}

// `rev-parse --path-format=absolute --git-common-dir --show-toplevel`: the main checkout
// and this folder's checkout. null for a bare repository or unreadable output.
export function parseRepo(out) {
  const [common, top] = String(out ?? "").split("\n").map((s) => trimSlash(s.trim()));
  if (!common || !top || !common.endsWith("/.git")) return null;
  const main = common.slice(0, -5) || "/";
  return { main, top, name: main.split("/").pop() || main };
}

// A branch name typed for a new worktree. Returns the reason it is refused, or null.
// git check-ref-format --branch runs after this; these are the checks that keep the
// folder inside .claude/worktrees and keep the name from reading as a git option.
export function nameError(name) {
  const n = String(name ?? "");
  if (!n.trim()) return "Type a branch name.";
  if (n !== n.trim()) return "No spaces at either end.";
  if (n.startsWith("-")) return "A name can't start with '-'.";
  if (n.includes("\\")) return "No backslashes.";
  if (n.startsWith("/") || n.endsWith("/")) return "No '/' at either end.";
  if (/[\x00-\x20\x7f~^:?*[]/.test(n)) return "No spaces or ~ ^ : ? * [ in a name.";
  for (const seg of n.split("/")) {
    if (seg === "") return "No empty parts between '/'.";
    if (seg === "." || seg === "..") return "No '.' or '..' parts.";
    if (seg.startsWith(".")) return "No part may start with '.'.";
  }
  return null;
}

// A base typed for a new worktree (a branch, tag or commit). Reason, or null.
export function baseError(base) {
  const b = String(base ?? "");
  if (!b) return null;
  if (b.startsWith("-")) return "A base can't start with '-'.";
  if (/[\x00-\x20\x7f]/.test(b)) return "No spaces in the base.";
  return null;
}

export const worktreesRoot = (main) => `${trimSlash(main)}/.claude/worktrees`;

// Where a worktree for `name` goes: <main>/.claude/worktrees/<name>, or null when
// the name is refused or the result would not sit strictly inside that folder.
export function worktreePath(main, name) {
  if (nameError(name)) return null;
  const root = worktreesRoot(main);
  const parts = [];
  for (const seg of `${root}/${name}`.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const path = `/${parts.join("/")}`;
  return path.startsWith(`${root}/`) && path.length > root.length + 1 ? path : null;
}

// Whether a new worktree's parent folder, as the real path after symlinks, is still inside the real
// main checkout (compared by segment). Returns the reason it is refused, or null.
export function landingError(realMain, realParent) {
  const m = trimSlash(String(realMain ?? ""));
  const p = trimSlash(String(realParent ?? ""));
  if (!m || !p || !m.startsWith("/") || !p.startsWith("/")) return "Could not resolve the worktrees folder.";
  return p === m || p.startsWith(`${m}/`) ? null : "The worktrees folder leads outside the repository (a symlink).";
}

// argv for `git worktree add`: a branch that exists is checked out, a new one starts at base.
export function addArgs(path, branch, exists, base) {
  if (exists) return ["worktree", "add", path, branch];
  return ["worktree", "add", "--no-track", "-b", branch, path, base || "HEAD"];
}

// Why a worktree can't be removed, as short reasons; empty means it can.
// wt: parseWorktrees entry plus { dirty, unpushed } (null: unknown) and agents (count in its space).
export function removeBlockers(wt) {
  const out = [];
  if (wt.main) out.push("main checkout");
  if (wt.bare) out.push("bare repository");
  if (wt.locked) out.push(wt.lockReason ? `locked: ${wt.lockReason}` : "locked");
  if (wt.prunable) out.push("folder is missing");
  if (wt.dirty == null) out.push("status unknown");
  else if (wt.dirty > 0) out.push(`${wt.dirty} uncommitted file${wt.dirty === 1 ? "" : "s"}`);
  if (wt.unpushed == null) out.push("unpushed commits unknown");
  else if (wt.unpushed > 0) out.push(`${wt.unpushed} unpushed commit${wt.unpushed === 1 ? "" : "s"}`);
  if ((wt.agents ?? 0) > 0) out.push("an agent is running there");
  return out;
}

export const canRemove = (wt) => removeBlockers(wt).length === 0;

// The argv `Remove` runs: never --force, never anything else.
export const removeArgs = (path) => ["worktree", "remove", path];

// github.com remotes only, as owner/name.
export function githubRepository(url) {
  return /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
    String(url ?? "").trim(),
  )?.[1] ?? null;
}

// `git config --get-regexp ^remote\..*\.url$`: origin's GitHub repo first, else any.
export function githubFromRemotes(out) {
  const remotes = String(out ?? "").split("\n").map((l) => /^remote\.(.+)\.url (.+)$/.exec(l.trim())).filter(Boolean)
    .map(([, name, url]) => ({ name, repo: githubRepository(url) })).filter((r) => r.repo);
  return (remotes.find((r) => r.name === "origin") ?? remotes[0])?.repo ?? null;
}

// The PR for a branch from `gh pr list --json number,state,headRefName,isCrossRepository,updatedAt`:
// an open one wins, else the most recently updated. Forks' PRs with the same branch name don't count.
export function prFor(prs, branch) {
  if (!branch) return null;
  const mine = (prs ?? []).filter((p) => p.headRefName === branch && !p.isCrossRepository)
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  const pr = mine.find((p) => p.state === "OPEN") ?? mine[0];
  return pr ? { number: pr.number, state: String(pr.state).toLowerCase() } : null;
}

// `<main>/.claude/launch.json`: name and command of each configuration. env is never read.
export function parseLaunch(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  const list = Array.isArray(j?.configurations) ? j.configurations : [];
  return list.filter((c) => c && typeof c === "object").map((c) => {
    const exe = typeof c.runtimeExecutable === "string" ? c.runtimeExecutable : "";
    const args = Array.isArray(c.runtimeArgs) ? c.runtimeArgs.filter((a) => typeof a === "string") : [];
    const command = typeof c.command === "string" ? c.command : [exe, ...args].filter(Boolean).join(" ");
    return { name: typeof c.name === "string" ? c.name : "(unnamed)", command };
  });
}

// A space's checkout: its first terminal's live folder, else where it was made.
export function spaceFolder(space, paneList) {
  const tabs = new Set((space.tabs ?? []).map((t) => t.id));
  return paneList.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space.folder || null;
}

const inside = (p, dir) => p === dir || p.startsWith(`${dir}/`);

// The space on a worktree: same machine, its folder inside the worktree and not
// inside a deeper worktree of the same repo (linked worktrees live in the main one).
export function spaceFor(path, allPaths, machine, spaceList, paneList) {
  return spaceList.find((s) => {
    if ((s.machine ?? null) !== (machine ?? null)) return false;
    const at = spaceFolder(s, paneList);
    if (!at || !inside(at, path)) return false;
    return !allPaths.some((o) => o !== path && o.length > path.length && inside(o, path) && inside(at, o));
  }) ?? null;
}

// Agents that stop a removal: any agent in a space whose folder (live or where it was made) is the
// worktree or inside it, or whose own pane's folder is, on the same machine. Compared by path segment.
export function agentsOn(path, machine, spaceList, paneList, agentList) {
  const spaceById = new Map(spaceList.map((s) => [s.id, s]));
  const paneById = new Map(paneList.map((p) => [p.pane, p]));
  return agentList.filter((a) => {
    const s = spaceById.get(a.space);
    if (!s || (s.machine ?? null) !== (machine ?? null)) return false;
    const at = [spaceFolder(s, paneList), s.folder, paneById.get(a.pane)?.cwd];
    return at.some((f) => f && inside(trimSlash(f) || "/", path));
  }).length;
}

export const repoKey = (machine, main) => JSON.stringify([machine ?? null, main]);

export function tilde(path, home) {
  if (!home || !path) return path ?? "";
  return inside(path, home) ? `~${path.slice(home.length)}` : path;
}

export function ago(seconds, nowSec) {
  if (!seconds) return "";
  const d = Math.max(0, nowSec - seconds);
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m`;
  if (d < 86400) return `${Math.round(d / 3600)}h`;
  if (d < 86400 * 60) return `${Math.round(d / 86400)}d`;
  return `${Math.round(d / 86400 / 30)}mo`;
}

// Saved run actions: { [repoKey]: [{ id, name, command }] }. Each returns a new store.
export function saveAction(store, key, action) {
  const list = store?.[key] ?? [];
  const has = list.some((a) => a.id === action.id);
  return { ...store, [key]: has ? list.map((a) => (a.id === action.id ? action : a)) : [...list, action] };
}

export function deleteAction(store, key, id) {
  const list = (store?.[key] ?? []).filter((a) => a.id !== id);
  const next = { ...store };
  if (list.length) next[key] = list;
  else delete next[key];
  return next;
}

export function actionError(name, command) {
  if (!String(name ?? "").trim()) return "Give it a name.";
  if (!String(command ?? "").trim()) return "Type a command.";
  return null;
}

// Whether the layout block showing `mod` is on screen (not found: an overlay, so shown).
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
