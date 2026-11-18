// Pure decisions for Dispatch: no herdr or gpui imports, so node --test runs it.

export const LIST_LIMIT = 50;
export const BODY_MAX = 1500;
export const SLUG_MAX = 40;

const trimSlash = (p) => String(p ?? "").replace(/\/+$/, "");

// The same character set as drover-data's stripControl and drover-goto's clean (copied, not imported).
// Built from strings: the app's regexp parser rejects U+2028/2029 inside a literal.
// Whole terminal escape sequences: OSC, DCS, PM, APC, SOS (7- and 8-bit) up to BEL, ST or the end;
// CSI (7- and 8-bit); then any other ESC sequence or lone ESC.
const ESCAPES = new RegExp([
  "\\x1b[\\]P^_X][\\s\\S]*?(?:\\x07|\\x1b\\\\|\\x9c|$)",
  "[\\x90\\x98\\x9d\\x9e\\x9f][\\s\\S]*?(?:\\x07|\\x1b\\\\|\\x9c|$)",
  "\\x1b\\[[0-?]*[ -/]*[@-~]?",
  "\\x9b[0-?]*[ -/]*[@-~]?",
  "\\x1b[ -/]*[0-~]?",
].join("|"), "g");
const LINE_SEPS = new RegExp("[\\u2028\\u2029]", "g");
// C0 (but tab and newline), DEL, C1.
const CONTROLS = new RegExp("[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f]", "g");
// Invisible and format characters: soft hyphen, CGJ, Arabic marks, Hangul fillers, Khmer vowels,
// Mongolian selectors, zero-width, bidi embeddings and isolates, invisible operators, Braille blank,
// variation selectors (both blocks), BOM, interlinear annotation, musical format marks, tag block.
const INVISIBLE = new RegExp("[\\u00ad\\u034f\\u0600-\\u0605\\u061c\\u06dd\\u070f\\u0890\\u0891\\u08e2\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\u2800\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff9-\\ufffb]|\\udb40[\\udc00-\\udc7f\\udd00-\\uddef]|\\ud834[\\udd73-\\udd7a]", "g");

/** Plain text from GitHub: no escape sequences, no control/format characters (bidi, zero-width,
 *  tag block, soft hyphen) but newline and tab. The input is cut to max*4 before any regex. */
export function sanitize(text, max = 4000) {
  let s = String(text ?? "").slice(0, max * 4)
    .replace(ESCAPES, "")
    .replace(/\r\n?/g, "\n")
    .replace(LINE_SEPS, "\n")
    .replace(CONTROLS, "")
    .replace(INVISIBLE, "")
    .replace(/[^\S\n\t ]/g, " ") // other spaces (NBSP etc.) to plain space
    .split("\n").map((l) => l.trimEnd()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  if (s.length > max) s = `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
  return s;
}

/** One line of GitHub text. */
export const oneLine = (s, max = 200) => sanitize(String(s ?? "").slice(0, max * 8), max * 2).replace(/\s+/g, " ").trim().slice(0, max);

/** owner/repo of a github.com remote URL, else null. */
export function githubRepository(url) {
  const repo = /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
    String(url ?? "").trim(),
  )?.[1] ?? null;
  return validRepo(repo) ? repo : null;
}

/** `git remote -v`: origin's GitHub repo first, else the first GitHub remote, else null. */
export function repoFromRemotes(out) {
  const found = [];
  for (const line of String(out ?? "").split(/\r?\n/)) {
    const m = /^(\S+)\s+(\S+)\s+\((?:fetch|push)\)$/.exec(line.trim());
    const repo = m && githubRepository(m[2]);
    if (repo) found.push({ name: m[1], repo });
  }
  return (found.find((r) => r.name === "origin") ?? found[0])?.repo ?? null;
}

/** owner/repo; neither part may be "." or "..". */
export const validRepo = (r) => /^[\w.-]+\/[\w.-]+$/.test(String(r ?? "")) && String(r).split("/").every((p) => p !== "." && p !== "..");
export const validNumber = (n) => Number.isInteger(n) && n > 0;

/** `rev-parse --path-format=absolute --git-common-dir --show-toplevel`: the main checkout. */
export function parseRepo(out) {
  const [common, top] = String(out ?? "").split("\n").map((s) => trimSlash(s.trim()));
  if (!common || !top || !common.endsWith("/.git")) return null;
  return { main: common.slice(0, -5) || "/", top };
}

// The first terminal (in tab order) defines a space's checkout.
export function spaceFolder(space, paneList) {
  for (const tab of space?.tabs ?? []) {
    const p = paneList.find((pane) => pane.tab === tab.id && pane.terminal && pane.cwd);
    if (p) return p.cwd;
  }
  return space?.folder || null;
}

/** Why the focused space can't be used, or null. */
export function spaceProblem(space) {
  if (!space) return "No space is focused.";
  if (space.machine) return `This space is on ${oneLine(space.machine, 60)}; Dispatch works on this computer only.`;
  return null;
}

const MARKS = new RegExp("[\\u0300-\\u036f]", "g"); // combining accents left by NFKD

/** issue-<n>-<slug>: lowercase ASCII letters, digits and dashes, slug at most 40. */
export function slugify(title) {
  const s = String(title ?? "").normalize("NFKD").replace(MARKS, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, SLUG_MAX).replace(/-+$/, "");
}

export function proposedBranch(issue) {
  const slug = slugify(issue?.title);
  return slug ? `issue-${issue.number}-${slug}` : `issue-${issue.number}`;
}

/** Same rules as drover-worktrees' nameError. Reason, or null. */
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

export const worktreesRoot = (main) => `${trimSlash(main)}/.claude/worktrees`;

/** <main>/.claude/worktrees/<name>, or null when refused or outside that folder. */
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

/** The worktrees folder (parent, written under main) must resolve to exactly the same segments under
 *  the real main checkout: no symlinked part on the way, and never into .git. Reason, or null. */
export function landingError(realMain, realParent, main, parent, links = []) {
  if ((links ?? []).length) return "A part of the worktrees folder is a symlink.";
  const m = trimSlash(realMain);
  const p = trimSlash(realParent);
  const wm = trimSlash(main);
  const wp = trimSlash(parent);
  if (!m || !p || !m.startsWith("/") || !p.startsWith("/") || !wm.startsWith("/")) return "Could not resolve the worktrees folder.";
  if (!wp.startsWith(`${wm}/`)) return "The worktrees folder is not inside the repository.";
  const tail = wp.slice(wm.length);
  if (tail.split("/")[1] === ".git" || p === `${m}/.git` || p.startsWith(`${m}/.git/`)) return "The worktrees folder is inside .git.";
  return p === `${m}${tail}` ? null : "A part of the worktrees folder is a symlink.";
}

/** Every path from the first part under main down to parent, to be checked one by one (lstat):
 *  main/a, main/a/b, … parent. Empty when parent is not under main. */
export function partsBetween(main, parent) {
  const wm = trimSlash(main);
  const wp = trimSlash(parent);
  if (!wm.startsWith("/") || !wp.startsWith(`${wm}/`)) return [];
  const out = [];
  let cur = wm;
  for (const seg of wp.slice(wm.length + 1).split("/")) {
    cur = `${cur}/${seg}`;
    out.push(cur);
  }
  return out;
}

/** The only git write: a new branch at base in a new worktree. */
export function addArgs(path, branch, base) {
  if (nameError(branch) || !String(path).startsWith("/") || !base || String(base).startsWith("-")) throw new Error("bad worktree arguments");
  return ["worktree", "add", "--no-track", "-b", branch, path, base];
}

/** `git worktree list --porcelain` as [{ path, branch }]. */
export function parseWorktrees(out) {
  const list = [];
  for (const block of String(out ?? "").split(/\n\s*\n/)) {
    const lines = block.split("\n").filter(Boolean);
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path) continue;
    const ref = lines.find((l) => l.startsWith("branch "))?.slice(7);
    list.push({ path: trimSlash(path) || "/", branch: ref ? ref.replace(/^refs\/heads\//, "") : null });
  }
  return list;
}

/** Default branch name from `symbolic-ref --short refs/remotes/origin/HEAD` ("origin/main"). */
export const defaultFromRemoteHead = (out) => String(out ?? "").trim().replace(/^origin\//, "") || null;

/**
 * What Set up would do. facts: { main, branch, base, worktrees, branchExists, folderExists }.
 * Returns { kind: "create" | "open" | "refuse", path, reason, existing }.
 */
export function buildPlan(f) {
  const err = nameError(f.branch);
  if (err) return { kind: "refuse", path: null, reason: err };
  const path = worktreePath(f.main, f.branch);
  if (!path) return { kind: "refuse", path: null, reason: "That name would leave the worktrees folder." };
  const wts = f.worktrees ?? [];
  const byBranch = wts.find((w) => w.branch === f.branch);
  const byPath = wts.find((w) => w.path === path);
  const existing = byPath ?? byBranch;
  if (existing && existing === wts[0]) return { kind: "refuse", path, reason: `${f.branch} is checked out in the main checkout.` };
  if (byPath && byPath.branch !== f.branch) {
    const on = byPath.branch ? `on branch ${byPath.branch}` : "on a detached HEAD";
    return { kind: "refuse", path, reason: `The worktree at ${path} is ${on}, not ${f.branch}.` };
  }
  if (existing) {
    const what = byPath ? "The worktree folder already exists" : `Branch ${f.branch} already has a worktree`;
    return { kind: "open", path: existing.path, existing, reason: `${what}: ${existing.path}` };
  }
  if (f.branchExists) return { kind: "refuse", path, reason: `Branch ${f.branch} already exists without a worktree; pick another name.` };
  if (f.folderExists) return { kind: "refuse", path, reason: `${path} exists but is not a worktree; pick another name.` };
  if (!f.base) return { kind: "refuse", path, reason: "Could not find the default branch locally." };
  return { kind: "create", path, reason: null };
}

export const issueUrl = (repo, n) => `https://github.com/${repo}/issues/${n}`;

/** The fixed first message. Never contains the issue body. */
export function firstMessage(repo, issue) {
  if (!validRepo(repo) || !validNumber(issue?.number)) throw new Error("bad issue");
  const title = oneLine(issue.title, 160) || "(no title)";
  return [
    `Work on issue #${issue.number} of ${repo}: "${title}"`,
    issueUrl(repo, issue.number),
    `Read the issue yourself first with: gh issue view ${issue.number} --repo ${repo}`,
  ].join("\n");
}

/** Space name: #<n> <short title>. */
export function spaceName(issue) {
  const t = oneLine(issue?.title, 60);
  const short = t.length > 32 ? `${t.slice(0, 31).trimEnd()}…` : t;
  return short ? `#${issue.number} ${short}` : `#${issue.number}`;
}

/** Agent commands from config.json: argv arrays of safe tokens only. Default [["claude"]]. */
export function agentCommands(config) {
  const raw = Array.isArray(config?.agents) ? config.agents : [];
  const out = [];
  for (const a of raw) {
    const argv = Array.isArray(a) ? a.map(String) : String(a ?? "").trim().split(/\s+/);
    if (argv.length && argv.every((t) => /^[A-Za-z0-9._/=-]+$/.test(t)) && !argv[0].startsWith("-")) out.push(argv);
  }
  return out.length ? out : [["claude"]];
}

/** Arming: a first click stores { key, at }, a later one with the same key fires. */
export const armKey = (parts) => JSON.stringify(parts);
export const ARM_GAP_MS = 400;

/** A second press within ARM_GAP_MS of arming (a double click) is ignored. */
export function press(armed, key, now = Date.now()) {
  if (armed && armed.key === key) {
    if (now - armed.at < ARM_GAP_MS) return { armed, fire: false };
    return { armed: null, fire: true };
  }
  return { armed: { key, at: now }, fire: false };
}

/** Disarm when what the armed key described has changed. */
export const stillArmed = (armed, key) => (armed && key != null && armed.key === key ? armed : null);

/** Why no agent may be started in the worker pane made earlier, or null. made: { pane, terminal, started, awaiting }.
 *  awaiting: the command was typed and the agent stopped on a question; a click then only sends the message. */
export function agentBlocked(made, agentList) {
  if (made?.awaiting === true) return null;
  if (made?.started) return "An agent was already started in this worker pane.";
  if ((agentList ?? []).some((a) => a.pane === made?.pane || a.address === made?.terminal)) return "An agent is already running in the worker pane.";
  return null;
}

/** The agent in exactly this worker pane and terminal, when it reports idle. */
export const readyAgent = (agentList, pane, terminal) =>
  (agentList ?? []).find((a) => a.pane === pane && a.address === terminal && a.status === "idle") ?? null;

/** What a trust or permission question looks like on an agent's screen. A match stops the first message. */
export const PROMPT_PATTERNS = [
  /\b(do you|you) trust\b|\btrust (this|the) (folder|files|project|workspace|directory)/i,
  /do you (want|wish) to (proceed|continue|allow)/i,
  /needs your permission|permission to (use|run|edit|write|read|access)|grant permission/i,
  /^[\s\u2502|>\u276f\u203a*-]*1[.)]\s*Yes\b/im,
  /\(y\/n\)|\[y\/n\]/i,
  /\b(allow|approve|deny)\b.*\?/i,
];
export const looksLikePrompt = (text) => PROMPT_PATTERNS.some((re) => re.test(String(text ?? "")));

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "elvish", "xonsh"]);

/** A plain shell waiting at its prompt, from `hc get --json`: live, no status (shells report none),
 *  and the root shell itself in the foreground. Anything else, or unsure: false. */
export function shellAtPrompt(info) {
  if (!info || info.state !== "live" || info.status != null) return false;
  const fg = info.foreground;
  if (!fg || fg.pid == null || fg.pid !== info.pid) return false;
  return SHELLS.has(String(fg.name ?? "").replace(/^-/, "").split("/").pop());
}

/** The one space space.new just made: new since `before`, on folder (or its real path), with the
 *  expected name. { space } or { error } when there is none or more than one. */
export function newSpace(list, before, folders, name) {
  const want = new Set(folders.filter(Boolean).map(trimSlash));
  const hits = (list ?? []).filter((s) => !before.has(s.id) && want.has(trimSlash(s.folder)) && s.name === name);
  if (hits.length === 1) return { space: hits[0] };
  return { error: hits.length ? "More than one new space matches the worktree; nothing more was done." : null };
}

/** Issue list filter: text against number, title and labels; mine: assigned to viewer. */
export function filterIssues(list, text, mine, viewer) {
  const q = String(text ?? "").trim().toLowerCase().replace(/^#/, "");
  return (list ?? []).filter((i) => {
    if (mine && !(viewer && (i.assignees ?? []).some((a) => a?.login === viewer))) return false;
    if (!q) return true;
    const hay = [String(i.number), i.title, ...(i.labels ?? []).map((l) => l?.name)].join("\n").toLowerCase();
    return hay.includes(q);
  });
}

export function listArgs(repo) {
  if (!validRepo(repo)) throw new Error("bad repo");
  return ["issue", "list", `--repo=${repo}`, "--state", "open", "--limit", String(LIST_LIMIT), "--json", "number,title,labels,assignees,updatedAt,url"];
}

export function viewArgs(repo, n) {
  if (!validRepo(repo) || !validNumber(n)) throw new Error("bad issue");
  return ["issue", "view", String(n), `--repo=${repo}`, "--json", "body,title,url"];
}

export const userArgs = () => ["api", "user", "--jq", ".login"];

/** Quiet one-liners for gh failures. */
export function ghProblem(stderr) {
  const s = String(stderr ?? "");
  if (/auth login|not logged|authentication|HTTP 401/i.test(s)) return "GitHub CLI is not signed in: run gh auth login.";
  if (/Could not resolve to a Repository|HTTP 404|not found/i.test(s)) return "Repository not found or not visible to this account.";
  if (/disabled issues|has issues disabled/i.test(s)) return "Issues are turned off for this repository.";
  if (/rate limit/i.test(s)) return "GitHub rate limit reached; try again later.";
  return "GitHub did not answer.";
}
