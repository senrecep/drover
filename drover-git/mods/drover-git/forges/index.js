// Remote URL -> forge, plus the web pages for a repository, branch, compare / new PR and PR list.
// Pure: no herdr imports. URL userinfo is never kept; only scheme, host, port and path survive.

export const KNOWN_HOSTS = { "github.com": "github", "gitlab.com": "gitlab", "bitbucket.org": "bitbucket" };
const KINDS = new Set(["github", "gitlab", "bitbucket"]);

const trimPath = (p) => String(p ?? "").replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
const okHost = (h) => /^[A-Za-z0-9.-]+$/.test(h) && !h.startsWith(".") && !h.startsWith("-");
const okPath = (p) => p.length > 0 && p.split("/").every((s) => /^[A-Za-z0-9._~-]+$/.test(s) && s !== "." && s !== "..");

/**
 * Parses a git remote URL. Forms: `git@host:a/b(.git)`, `ssh://[user@]host[:port]/a/b`,
 * `git://host/a/b`, `https://[user[:pw]@]host[:port]/a/b`. Nested GitLab groups are kept.
 * `forgeHosts`: { "git.example.com": "gitlab" } for self-hosted forges.
 * -> { kind: "github"|"gitlab"|"bitbucket"|null, host, port, path, owner, name, web } or null.
 */
export function parseRemote(url, forgeHosts = {}) {
  const u = String(url ?? "").trim();
  if (!u || /\s/.test(u)) return null;
  let host, port = null, path, webPort = null;
  let m;
  if ((m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/]+)(?::(\d+))?(\/.*)?$/i.exec(u))) {
    const scheme = m[1].toLowerCase();
    if (!["https", "http", "ssh", "git", "git+ssh", "ssh+git"].includes(scheme)) return null;
    host = m[2].toLowerCase();
    port = m[3] ? Number(m[3]) : null;
    path = trimPath(m[4] ?? "");
    // An https port is the web port; an ssh port is not.
    if (scheme === "https" || scheme === "http") webPort = port;
    // Bitbucket Server style /scm/ prefix
    path = path.replace(/^scm\//, "");
  } else if ((m = /^(?:[^@/:]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(u))) {
    host = m[1].toLowerCase();
    path = trimPath(m[2]);
  } else return null;
  if (!okHost(host) || !okPath(path)) return null;
  const segs = path.split("/");
  if (segs.length < 2) return null;
  const custom = Object.fromEntries(Object.entries(forgeHosts ?? {}).map(([k, v]) => [String(k).toLowerCase(), v]));
  let kind = KNOWN_HOSTS[host] ?? (KINDS.has(custom[host]) ? custom[host] : null);
  if (!kind && /^gitlab\./.test(host)) kind = "gitlab";
  if ((kind === "github" || kind === "bitbucket") && segs.length !== 2) return { kind: null, host, port, path, owner: segs[0], name: segs[segs.length - 1], web: null };
  const web = `https://${host}${webPort && webPort !== 443 ? `:${webPort}` : ""}/${path}`;
  return { kind, host, port, path, owner: segs.slice(0, -1).join("/"), name: segs[segs.length - 1], web };
}

/** `git config --get-regexp ^remote\..*\.url$` -> [{ remote, url }]. */
export function parseRemoteUrls(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = /^remote\.(.+)\.url\s+(\S+)\s*$/.exec(line.trim());
    if (m) out.push({ remote: m[1], url: m[2] });
  }
  return out;
}

/** The remote to use: the current upstream's remote, then origin, then the first one. */
export function pickRemote(list, upstreamRemote) {
  if (!list?.length) return null;
  return list.find((r) => r.remote === upstreamRemote) ?? list.find((r) => r.remote === "origin") ?? list[0];
}

const enc = (b) => String(b).split("/").map(encodeURIComponent).join("/");
const q = (b) => encodeURIComponent(String(b));

/**
 * Web pages for a parsed remote. branch: the branch to show; base: the target of a new PR.
 * -> { repo, branch, compare, prs } (any can be null when the forge is unknown).
 */
export function webUrls(info, { branch, base } = {}) {
  if (!info?.web) return { repo: null, branch: null, compare: null, prs: null };
  const w = info.web;
  if (info.kind === "github") {
    return {
      repo: w,
      branch: branch ? `${w}/tree/${enc(branch)}` : null,
      compare: branch ? `${w}/compare/${base ? `${enc(base)}...` : ""}${enc(branch)}?expand=1` : null,
      prs: `${w}/pulls`,
    };
  }
  if (info.kind === "gitlab") {
    return {
      repo: w,
      branch: branch ? `${w}/-/tree/${enc(branch)}` : null,
      compare: branch ? `${w}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${q(branch)}${base ? `&merge_request%5Btarget_branch%5D=${q(base)}` : ""}` : null,
      prs: `${w}/-/merge_requests`,
    };
  }
  if (info.kind === "bitbucket") {
    return {
      repo: w,
      branch: branch ? `${w}/src/${enc(branch)}` : null,
      compare: branch ? `${w}/pull-requests/new?source=${q(branch)}${base ? `&dest=${q(base)}` : ""}` : null,
      prs: `${w}/pull-requests`,
    };
  }
  return { repo: w, branch: null, compare: null, prs: null };
}

/** Only http(s) URLs, without userinfo; else null. */
export function safeUrl(url) {
  let u;
  try { u = new URL(String(url ?? "")); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  return u.toString();
}

/** What a URL may show on screen: host and path, never the query string or userinfo. */
export function showUrl(url) {
  let u;
  try { u = new URL(String(url ?? "")); } catch { return ""; }
  return `${u.host}${u.pathname}`.replace(/\/$/, "");
}

/** One normalized PR / MR row. */
export function prRow(o) {
  const str = (v, max = 200) => String(v ?? "").replace(/[\x00-\x1f\x7f​-‏‪-‮⁦-⁩]/g, "").slice(0, max);
  return {
    id: str(o.id, 20),
    title: str(o.title),
    author: str(o.author, 80),
    source: str(o.source),
    target: str(o.target),
    state: str(o.state, 30).toLowerCase(),
    url: safeUrl(o.url),
    draft: Boolean(o.draft),
    checks: o.checks ? str(o.checks, 60) : "",
    number: Number.isInteger(o.number) ? o.number : null,
  };
}
