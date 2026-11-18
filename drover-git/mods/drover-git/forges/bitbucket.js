// Bitbucket: pages open in the browser. An optional helper program the person configures in
// data/drover-git/settings.json ("bitbucketHelper": ["program", "arg", ...]) can list pull
// requests: it runs as an argv (no shell), gets no tokens from here, and must print a JSON array of
// { id, title, author, source, target, state, url } on stdout within 15 s.
// "{workspace}", "{repo}" and "{host}" in its arguments are replaced with the remote's values.
import { prRow, safeUrl } from "./index.js";

export const HELPER_MAX_ROWS = 200;
const PLACE = /\{(workspace|repo|host)\}/g;

/** Checks the configured helper argv; -> { argv } or { problem }. */
export function helperArgv(setting, info) {
  if (setting == null) return { problem: "none" };
  if (!Array.isArray(setting) || setting.length === 0 || setting.length > 32) return { problem: "bitbucketHelper must be a non-empty array of strings" };
  if (setting.some((a) => typeof a !== "string" || a.length > 512 || a.includes("\0"))) return { problem: "bitbucketHelper must be a non-empty array of strings" };
  if (!setting[0].trim()) return { problem: "bitbucketHelper: empty program" };
  const vals = { workspace: info?.owner ?? "", repo: info?.name ?? "", host: info?.host ?? "" };
  if (Object.values(vals).some((v) => !/^[\w.-]*$/.test(v))) return { problem: "bad repository" };
  return { argv: setting.map((a) => a.replace(PLACE, (_m, k) => vals[k])) };
}

/** Validates helper stdout. Unknown fields are dropped, URLs must be http(s). Throws a short message. */
export function parseHelperOutput(stdout) {
  let list;
  try { list = JSON.parse(String(stdout ?? "")); } catch { throw new Error("The helper did not print JSON"); }
  if (!Array.isArray(list)) throw new Error("The helper must print a JSON array");
  const rows = [];
  for (const o of list.slice(0, HELPER_MAX_ROWS)) {
    if (!o || typeof o !== "object" || Array.isArray(o)) continue;
    if (o.title == null || o.source == null) continue;
    if (o.url != null && !safeUrl(o.url)) continue;
    rows.push(prRow({ id: o.id != null ? `#${String(o.id).replace(/^#/, "")}` : "", title: o.title, author: o.author, source: o.source, target: o.target, state: o.state ?? "open", url: o.url }));
  }
  return rows;
}
