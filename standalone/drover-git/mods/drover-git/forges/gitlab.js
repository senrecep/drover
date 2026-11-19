// GitLab through glab when it is installed (its JSON output is marked experimental upstream, so
// every field is optional here). Without glab the merge request pages open in the browser.
import { prRow } from "./index.js";

/** glab mr list for a parsed remote. -R takes a full URL, so self-hosted instances work too. */
export function listArgs(info) {
  if (!info?.web) throw new Error("bad repository");
  return ["mr", "list", "-R", info.web, "-F", "json", "--per-page", "50"];
}

export function parseMRs(stdout) {
  const list = JSON.parse(String(stdout ?? "") || "[]");
  if (!Array.isArray(list)) throw new Error("not a list");
  return list.slice(0, 200).map((m) => prRow({
    id: `!${m.iid ?? ""}`, title: m.title, author: m.author?.username ?? m.author?.name ?? "",
    source: m.source_branch, target: m.target_branch, state: m.state ?? "opened", url: m.web_url,
    draft: m.draft ?? m.work_in_progress,
  }));
}

export function glabProblem(stderr) {
  const s = String(stderr ?? "");
  if (/auth|401|token|log ?in/i.test(s)) return "glab is not signed in for this host: run glab auth login in a terminal";
  if (/404|not found/i.test(s)) return "Project not found or not visible to this account";
  return "GitLab did not answer";
}
