// Pure logic for the Pull requests page: no Herdr or process calls, so tests run under node.

export const POLL_MS = 60000;
export const REVIEW_TEXT_MAX = 4000;
export const COMMENT_MAX = 400;
export const MAX_THREADS = 20;

export const PR_FIELDS = [
  "number", "title", "url", "author", "headRefName", "baseRefName", "isDraft", "isCrossRepository",
  "reviewDecision", "statusCheckRollup", "updatedAt", "mergeable", "mergeStateStatus", "autoMergeRequest",
].join(",");

/** owner/repo of a github.com remote URL, else undefined. */
export function githubRepository(url) {
  return /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
    String(url ?? "").trim(),
  )?.[1];
}

/** owner/repo set from `git remote -v` output, github.com remotes only, in remote order. */
export function reposFromRemotes(out) {
  const found = [];
  for (const line of String(out ?? "").split(/\r?\n/)) {
    const m = /^\S+\s+(\S+)\s+\((?:fetch|push)\)$/.exec(line.trim());
    const repo = m && githubRepository(m[1]);
    if (repo && !found.includes(repo)) found.push(repo);
  }
  return found;
}

// The first terminal (in tab order) defines a space's checkout, not the focused one.
export function spaceFolder(space, paneList) {
  for (const tab of space.tabs ?? []) {
    const p = paneList.find((pane) => pane.tab === tab.id && pane.terminal && pane.cwd);
    if (p) return p.cwd;
  }
  return space.folder || null;
}

const FAILING = new Set(["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "CANCELLED"]);
const PENDING_STATES = new Set(["PENDING", "EXPECTED"]);

/** Checks summed up: { total, passing, failing, pending, failed: [names], state }. */
export function summarizeRollup(rollup) {
  const out = { total: 0, passing: 0, failing: 0, pending: 0, failed: [], state: "none" };
  for (const c of rollup ?? []) {
    out.total++;
    const name = c.name || c.context || "check";
    let kind;
    if (c.__typename === "StatusContext" || (c.state && !c.status && !c.conclusion)) {
      const s = String(c.state ?? "").toUpperCase();
      kind = PENDING_STATES.has(s) ? "pending" : FAILING.has(s) ? "failing" : "passing";
    } else if (String(c.status ?? "").toUpperCase() !== "COMPLETED") {
      kind = "pending";
    } else {
      kind = FAILING.has(String(c.conclusion ?? "").toUpperCase()) ? "failing" : "passing";
    }
    out[kind]++;
    if (kind === "failing" && !out.failed.includes(name)) out.failed.push(name);
  }
  out.state = out.total === 0 ? "none" : out.failing ? "failing" : out.pending ? "pending" : "passing";
  return out;
}

/** One short label for a rollup. */
export function rollupLabel(r) {
  if (r.state === "none") return "no checks";
  if (r.state === "failing") return `${r.failing} failing${r.pending ? `, ${r.pending} pending` : ""}`;
  if (r.state === "pending") return `${r.pending} pending, ${r.passing} passed`;
  return `${r.passing} passing`;
}

export function reviewLabel(decision) {
  switch (decision) {
    case "APPROVED": return "approved";
    case "CHANGES_REQUESTED": return "changes requested";
    case "REVIEW_REQUIRED": return "review required";
    default: return "";
  }
}

/** Which PRs a filter keeps. mine: author login; requested: numbers from review-requested:@me. */
export function filterPrs(prs, filter, viewer, requested) {
  const req = requested instanceof Set ? requested : new Set(requested ?? []);
  if (filter === "mine") return prs.filter((p) => viewer && p.author?.login === viewer);
  if (filter === "review") return prs.filter((p) => req.has(p.number));
  return prs.slice();
}

/**
 * Stacks: a PR nests under the open PR whose head branch is its base (same repo; the parent's head
 * must live in this repo, as a base branch always does). A child whose parent is filtered out is a
 * root. Returns rows in display order: { pr, depth, prefix, parent }.
 */
export function buildStack(prs) {
  const byHead = new Map();
  for (const p of prs) if (!p.isCrossRepository && !byHead.has(p.headRefName)) byHead.set(p.headRefName, p);
  const parentOf = new Map();
  for (const p of prs) {
    const parent = byHead.get(p.baseRefName);
    if (parent && parent !== p) parentOf.set(p, parent);
  }
  // Cycle guard: an ancestor chain that comes back to itself is cut at the PR seen twice.
  for (const p of prs) {
    const seen = new Set([p]);
    let cur = parentOf.get(p);
    while (cur) {
      if (seen.has(cur)) { parentOf.delete(p); break; }
      seen.add(cur);
      cur = parentOf.get(cur);
    }
  }
  const kids = new Map();
  for (const [child, parent] of parentOf) {
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(child);
  }
  const byUpdated = (a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")) || b.number - a.number;
  const roots = prs.filter((p) => !parentOf.has(p)).sort(byUpdated);
  const rows = [];
  const walk = (p, depth, lead, last) => {
    const prefix = depth === 0 ? "" : `${lead}${last ? "└─ " : "├─ "}`;
    rows.push({ pr: p, depth, prefix, parent: parentOf.get(p)?.number ?? null });
    const list = (kids.get(p) ?? []).sort((a, b) => a.number - b.number);
    const nextLead = depth === 0 ? "" : `${lead}${last ? "   " : "│  "}`;
    list.forEach((c, i) => walk(c, depth + 1, nextLead, i === list.length - 1));
  };
  for (const r of roots) walk(r, 0, "", true);
  return rows;
}

/**
 * Spaces checked out on a PR's head branch and the agents there. A space matches when the PR's
 * repo is one of its remotes and one of its panes is on the branch.
 */
export function placesOnBranch(repo, branch, spaceList, paneList, agentList, spaceRepos) {
  const out = [];
  for (const s of spaceList) {
    if (!(spaceRepos.get(s.id) ?? []).includes(repo)) continue;
    const tabs = new Set((s.tabs ?? []).map((t) => t.id));
    const onBranch = paneList.filter((p) => tabs.has(p.tab) && p.terminal && p.branch === branch);
    if (!onBranch.length) continue;
    const paneIds = new Set(onBranch.map((p) => p.pane));
    const agents = agentList.filter((a) => a.space === s.id && paneIds.has(a.pane));
    out.push({ space: s, tab: onBranch[0].tab, agents });
  }
  return out;
}

/** The single agent text may go to, or null when there are none or several. */
export function soleAgent(places) {
  const all = places.flatMap((p) => p.agents);
  return all.length === 1 ? all[0] : null;
}

/** Plain text safe to paste: no escape sequences, no control characters but newline and tab. */
export function sanitize(text, max = REVIEW_TEXT_MAX) {
  let s = String(text ?? "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "") // OSC, BEL or ST terminated (or unterminated)
    .replace(/\x1b[P^_X][\s\S]*?(?:\x1b\\|$)/g, "") // DCS, PM, APC, SOS
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\x9b[0-?]*[ -/]*[@-~]/g, "") // 8-bit CSI
    .replace(/\x1b[ -/]*[0-~]?/g, "") // other ESC sequences, and a lone ESC
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f\u0080-\u009f]/g, "")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "");
  if (s.length > max) s = `${s.slice(0, Math.max(0, max - 1)).replace(/\s+$/, "")}…`;
  return s;
}

const oneLine = (s, max) => sanitize(s, max).replace(/\s*\n\s*/g, " ");

export function ciFixText(repo, pr, failed) {
  const names = failed.length ? failed.map((n) => oneLine(n, 120)).join(", ") : "(names unavailable)";
  return sanitize(
    `PR #${pr.number} "${oneLine(pr.title, 200)}" in ${repo} (branch ${oneLine(pr.headRefName, 200)}) has failing CI checks: ${names}. ` +
      "Look at the failing checks (gh pr checks), fix the cause on this branch, run the relevant tests, and push.",
  );
}

/** Unresolved threads from the GraphQL reviewThreads nodes, as { path, line, body, author }. */
export function unresolvedComments(threads) {
  return (threads ?? [])
    .filter((t) => !t.isResolved)
    .map((t) => {
      const first = t.comments?.nodes?.[0];
      return { path: t.path ?? "", line: t.line ?? t.originalLine ?? null, body: first?.body ?? "", author: first?.author?.login ?? "" };
    });
}

export function reviewText(repo, pr, comments, max = REVIEW_TEXT_MAX) {
  const head = `PR #${pr.number} "${oneLine(pr.title, 200)}" in ${repo} (branch ${oneLine(pr.headRefName, 200)}) has ${comments.length} unresolved review comment${comments.length === 1 ? "" : "s"}. Address them on this branch and push:`;
  const lines = [head];
  let used = head.length;
  let shown = 0;
  for (const c of comments.slice(0, MAX_THREADS)) {
    const where = `${oneLine(c.path, 200) || "(general)"}${c.line ? `:${c.line}` : ""}`;
    const line = `- ${where}: ${oneLine(c.body, COMMENT_MAX)}`;
    if (used + line.length + 1 > max - 40) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  if (shown < comments.length) lines.push(`(${comments.length - shown} more not shown; see the PR on GitHub)`);
  return sanitize(lines.join("\n"), max);
}

/** Merge method the repository allows, squash first; null when none is allowed. */
export function mergeMethod(repoInfo) {
  if (!repoInfo) return null;
  if (repoInfo.squashMergeAllowed) return "squash";
  if (repoInfo.mergeCommitAllowed) return "merge";
  if (repoInfo.rebaseMergeAllowed) return "rebase";
  return null;
}

// States in which gh would merge at once instead of enabling auto-merge.
const MERGEABLE_NOW = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

/** Why auto-merge can't be offered, or null when it can. */
export function autoMergeBlock(pr, repoInfo) {
  if (pr.autoMergeRequest) return "Auto-merge is already on";
  if (pr.isDraft) return "Draft pull request";
  if (!repoInfo) return "Reading repository settings…";
  if (repoInfo.autoMergeAllowed === false) return "The repository does not allow auto-merge";
  if (!mergeMethod(repoInfo)) return "No merge method allowed";
  if (MERGEABLE_NOW.has(pr.mergeStateStatus)) return "Already mergeable: --auto would merge it now";
  return null;
}

// Fresh states in which --auto waits instead of merging at once.
const AUTO_WAITS = new Set(["BLOCKED", "BEHIND", "DIRTY"]);

/** Decision on `gh pr view --json mergeStateStatus,state,isDraft` output: null to go on, else why not. */
export function freshAutoMergeBlock(stdout) {
  let v;
  try {
    v = JSON.parse(String(stdout ?? ""));
  } catch {
    return "Could not read the pull request's current state; nothing was merged";
  }
  if (!v || typeof v !== "object") return "Could not read the pull request's current state; nothing was merged";
  if (v.state !== "OPEN") return "The pull request is no longer open; nothing was merged";
  if (v.isDraft) return "Draft pull request";
  if (!AUTO_WAITS.has(v.mergeStateStatus)) return `Now ${String(v.mergeStateStatus ?? "unknown").toLowerCase().replace(/_/g, " ")}: --auto could merge it now; nothing was merged`;
  return null;
}

export function viewArgs(repo, number) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`bad repo ${repo}`);
  if (!Number.isInteger(number) || number < 1) throw new Error(`bad PR number ${number}`);
  return ["pr", "view", String(number), "--repo", repo, "--json", "mergeStateStatus,state,isDraft"];
}

export function autoMergeArgs(repo, number, method) {
  if (!["squash", "merge", "rebase"].includes(method)) throw new Error(`bad merge method ${method}`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`bad repo ${repo}`);
  if (!Number.isInteger(number) || number < 1) throw new Error(`bad PR number ${number}`);
  return ["pr", "merge", String(number), "--repo", repo, "--auto", `--${method}`];
}

// "--" ends hc's options, so text that starts with "-" is still sent as text.
export function sendArgs(address, text) {
  return ["send", "--", String(address), text];
}

export function listArgs(repo) {
  return ["pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", PR_FIELDS];
}

export function requestedArgs(repo) {
  return ["pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--search", "review-requested:@me", "--json", "number"];
}

export const REPO_QUERY =
  "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){autoMergeAllowed squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed}}";

// gh repo view has no autoMergeAllowed field; GraphQL has all four.
export function repoArgs(repo) {
  const [owner, name] = repo.split("/");
  return ["api", "graphql", "-f", `query=${REPO_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`];
}

export const THREADS_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved path line originalLine comments(first:1){nodes{body author{login}}}}}}}}";

export function threadsArgs(repo, number) {
  const [owner, name] = repo.split("/");
  return ["api", "graphql", "-f", `query=${THREADS_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`];
}

export const safeUrl = (url) => (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(String(url ?? "")) ? url : null);

/** The program that opens a link in the browser, per window platform ("macos" | "linux" | "windows"). -> [command, args] */
export function openUrlArgv(platform, url) {
  if (platform === "windows") return ["explorer.exe", [url]];
  if (platform === "linux") return ["xdg-open", [url]];
  return ["open", [url]];
}

/**
 * What to say when opening a link went wrong, from exec's result or error; null when it worked or on
 * macOS, which stays quiet as before. explorer.exe exits 1 even when it opened the link.
 */
export function openUrlProblem(platform, result, error) {
  if (platform === "macos") return null;
  const tool = platform === "windows" ? "explorer.exe" : "xdg-open";
  if (error) return /program not found/.test(String(error?.message ?? error)) ? (platform === "linux" ? "Install xdg-utils to open links." : `${tool} was not found.`) : "Could not open the link.";
  if (platform === "windows" || result?.code === 0) return null;
  return "Could not open the link: xdg-open found no browser.";
}

/** Quiet one-liners for gh failures. */
export function ghProblem(stderr) {
  const s = String(stderr ?? "");
  if (/auth login|not logged|authentication|HTTP 401/i.test(s)) return "GitHub CLI is not signed in: run gh auth login.";
  if (/Could not resolve to a Repository|HTTP 404|not found/i.test(s)) return "Repository not found or not visible to this account.";
  if (/rate limit/i.test(s)) return "GitHub rate limit reached; trying again in a minute.";
  return "GitHub did not answer; trying again in a minute.";
}

// "now" under a minute, then 2m, 3h, 4d, 5w.
export function ago(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 14 ? `${d}d` : `${Math.floor(d / 7)}w`;
}

/** Whether the layout has a stack `id` with a child `child`. */
export function hasStackChild(node, id, child) {
  if (!node || typeof node !== "object") return false;
  if (node.type === "stack" && node.id === id && (node.children ?? []).some((c) => c?.id === child)) return true;
  return [...(node.children ?? []), ...(node.floating ?? [])].some((c) => hasStackChild(c, id, child));
}

// Whether the block showing `mod` is on screen. Not in the layout (an overlay or a pane): shown.
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
