// GitHub through the local gh CLI (gh keeps the auth; nothing here sees a token).
import { prRow } from "./index.js";

export const PR_FIELDS = "number,title,headRefName,baseRefName,author,updatedAt,url,isDraft,state,statusCheckRollup";
const SLUG = /^[\w.-]+\/[\w.-]+$/;

const slugOf = (info) => {
  const s = `${info?.owner ?? ""}/${info?.name ?? ""}`;
  if (!SLUG.test(s)) throw new Error("bad repository");
  // gh --repo takes HOST/OWNER/REPO for GitHub Enterprise
  return info.host && info.host !== "github.com" ? `${info.host}/${s}` : s;
};

export function listArgs(info) {
  return ["pr", "list", "--repo", slugOf(info), "--state", "open", "--limit", "50", "--json", PR_FIELDS];
}

export function viewArgs(info, number) {
  if (!Number.isInteger(number) || number < 1) throw new Error("bad PR number");
  return ["pr", "view", String(number), "--repo", slugOf(info), "--json", "mergeStateStatus,state,isDraft,autoMergeRequest"];
}

export function autoMergeArgs(info, number, method) {
  if (!["squash", "merge", "rebase"].includes(method)) throw new Error("bad merge method");
  if (!Number.isInteger(number) || number < 1) throw new Error("bad PR number");
  return ["pr", "merge", String(number), "--repo", slugOf(info), "--auto", `--${method}`];
}

export const REPO_QUERY =
  "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){autoMergeAllowed squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed}}";

export function repoSettingsArgs(info) {
  slugOf(info);
  const args = ["api", "graphql", "--raw-field", `query=${REPO_QUERY}`, "--raw-field", `owner=${info.owner}`, "--raw-field", `name=${info.name}`];
  return info.host && info.host !== "github.com" ? [...args, "--hostname", info.host] : args;
}

/** Repository merge settings from the GraphQL answer, or null. */
export function parseRepoSettings(stdout) {
  try {
    const r = JSON.parse(String(stdout ?? ""))?.data?.repository;
    return r && typeof r === "object" ? r : null;
  } catch { return null; }
}

export function mergeMethod(settings) {
  if (!settings) return null;
  if (settings.squashMergeAllowed) return "squash";
  if (settings.mergeCommitAllowed) return "merge";
  if (settings.rebaseMergeAllowed) return "rebase";
  return null;
}

const FAILING = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PENDING = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);

/** statusCheckRollup -> "passing" | "failing" | "pending" | "". */
export function checksState(rollup) {
  let fail = 0, pend = 0, n = 0;
  for (const c of Array.isArray(rollup) ? rollup : []) {
    n++;
    if (c.status && String(c.status).toUpperCase() !== "COMPLETED") { pend++; continue; }
    const s = String(c.conclusion || c.state || "").toUpperCase();
    if (FAILING.has(s)) fail++;
    else if (PENDING.has(s)) pend++;
  }
  return n === 0 ? "" : fail ? "failing" : pend ? "pending" : "passing";
}

/** gh pr list --json output -> normalized rows. Throws on bad JSON. */
export function parsePRs(stdout) {
  const list = JSON.parse(String(stdout ?? "") || "[]");
  if (!Array.isArray(list)) throw new Error("not a list");
  return list.slice(0, 200).map((p) => prRow({
    id: `#${p.number}`, number: p.number, title: p.title, author: p.author?.login ?? "",
    source: p.headRefName, target: p.baseRefName, state: p.state ?? "open", url: p.url,
    draft: p.isDraft, checks: checksState(p.statusCheckRollup),
  }));
}

const AUTO_WAITS = new Set(["BLOCKED", "BEHIND", "DIRTY", "UNKNOWN"]);

/** Decision on viewArgs output right before enabling auto-merge: null to go on, else why not. */
export function freshAutoMergeBlock(stdout) {
  let v;
  try { v = JSON.parse(String(stdout ?? "")); } catch { return "Could not read the pull request's state; nothing was merged"; }
  if (!v || typeof v !== "object") return "Could not read the pull request's state; nothing was merged";
  if (v.state !== "OPEN") return "The pull request is not open; nothing was merged";
  if (v.isDraft) return "Draft pull request";
  if (v.autoMergeRequest) return "Auto-merge is already on";
  if (!AUTO_WAITS.has(v.mergeStateStatus)) return `It is ${String(v.mergeStateStatus ?? "unknown").toLowerCase().replace(/_/g, " ")}: --auto would merge at once; nothing was merged`;
  return null;
}

/** Quiet one-liners for gh failures (stderr is never shown as is). */
export function ghProblem(stderr) {
  const s = String(stderr ?? "");
  if (/auth login|not logged|authentication|HTTP 401/i.test(s)) return "GitHub CLI is not signed in: run gh auth login in a terminal";
  if (/Could not resolve to a Repository|HTTP 404|not found/i.test(s)) return "Repository not found or not visible to this account";
  if (/rate limit/i.test(s)) return "GitHub rate limit reached";
  if (/auto.?merge/i.test(s) && /not allowed|disabled|enable/i.test(s)) return "Auto-merge is not enabled for this repository";
  if (/protected branch|required status|review/i.test(s)) return "Branch protection does not allow this yet";
  return "GitHub did not answer";
}
