// Pure logic for the top bar's calmer chrome: the diff chip, the context title and the new-tab
// templates. No Herdr calls here, so it runs under node:test.

/** Shared key for user-defined new-tab templates: [{ name, argv }] or ["program", ...]. */
export const TEMPLATES_KEY = "drover-tabs.templates";
/** How often the diff chip may ask git again, in ms. */
export const DIFF_INTERVAL = 5000;
/** Narrower than this, the context title is hidden rather than squeezed. */
export const TITLE_MIN_W = 90;

/** `git diff --shortstat` output -> { files, added, removed }; empty output means a clean tree. */
export function parseShortstat(stdout) {
  const s = String(stdout ?? "");
  const num = (re) => { const m = re.exec(s); return m ? Number(m[1]) : 0; };
  return {
    files: num(/(\d+) files? changed/),
    added: num(/(\d+) insertions?\(\+\)/),
    removed: num(/(\d+) deletions?\(-\)/),
  };
}

/** Where a space is now: the first terminal pane's live folder in its tabs (tab order), else its folder. */
export function liveFolder(space, panes) {
  if (!space) return null;
  const list = Array.isArray(panes) ? panes : [];
  for (const tab of space.tabs ?? []) {
    const p = list.find((x) => x?.tab === tab.id && x.terminal && x.cwd);
    if (p) return p.cwd;
  }
  return space.folder || null;
}

/** The identity the diff belongs to: a new key refreshes at once. */
export function diffKey(space, tabId, cwd) {
  return space ? `${space.machine ?? ""}|${space.id}|${tabId ?? ""}|${cwd ?? ""}` : "";
}

/** Whether to ask git now: a new key, or the last ask is at least `interval` old. Never while one runs. */
export function shouldRefresh(state, key, now, interval = DIFF_INTERVAL) {
  if (!key || state?.busy) return false;
  if (state?.key !== key) return true;
  return !(state.at > 0) || now - state.at >= interval;
}

/** What the chip shows for an exec result: null hides it (not a repo, git failed). */
export function diffFromResult(result) {
  if (!result || result.code !== 0) return null;
  return parseShortstat(result.stdout);
}

/** The context title's parts: the space's name and its branch (null when none). */
export function contextTitle(space) {
  if (!space) return null;
  const name = String(space.name ?? "").trim();
  const branch = typeof space.branch === "string" && space.branch.trim() ? space.branch.trim() : null;
  if (!name && !branch) return null;
  return { name, branch };
}

/** Whether the title fits in the width it was given. */
export function titleFits(width, min = TITLE_MIN_W) {
  return Number(width) >= min;
}

/** User templates from the shared value: strings become { name, argv: [s] }; bad entries are dropped. */
export function normalizeTemplates(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const v of value) {
    let t = null;
    if (typeof v === "string" && v.trim()) t = { name: v.trim(), argv: [v.trim()] };
    else if (v && typeof v === "object" && Array.isArray(v.argv) && v.argv.length && v.argv.every((a) => typeof a === "string" && a)) {
      t = { name: typeof v.name === "string" && v.name.trim() ? v.name.trim() : v.argv[0], argv: [...v.argv] };
    }
    if (!t) continue;
    const k = t.argv.join("\u0000");
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * The menu's rows: Shell first, then the installed known agents (most picked first, as given),
 * then the user's templates not already listed. Each row: { id, name, argv (null: a shell), icon, tint }.
 */
export function templateRows(known, user) {
  const rows = [{ id: "shell", name: "Shell", argv: null, icon: null, tint: true }];
  const seen = new Set();
  for (const a of Array.isArray(known) ? known : []) {
    if (!a?.installed || !Array.isArray(a.run) || !a.run.length) continue;
    const k = a.run.join("\u0000");
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push({ id: `agent-${a.key ?? a.run[0]}`, name: a.name || a.run[0], argv: [...a.run], icon: a.icon ?? null, tint: Boolean(a.tint) });
  }
  normalizeTemplates(user).forEach((t, i) => {
    const k = t.argv.join("\u0000");
    if (seen.has(k)) return;
    seen.add(k);
    rows.push({ id: `user-${i}`, name: t.name, argv: t.argv, icon: null, tint: true });
  });
  return rows;
}

/** The tab.new arguments for a row in `spaceId`. */
export function newTabArgs(row, spaceId) {
  const args = {};
  if (spaceId) args.space = spaceId;
  if (row?.argv?.length) args.argv = [...row.argv];
  return args;
}

/** The template popup's height for this many rows: title 30, 30 px rows, padding. */
export function templatesHeight(rows, max = 420) {
  return Math.min(max, 12 + 30 + Math.max(1, rows) * 30 + 8);
}

// ---- "Open in ▾": the focused folder in an editor, through drover-open's "Open in" popup ----

/** drover-open's shared key: the app name of the last editor chosen there. */
export const EDITOR_KEY = "drover-open.editor";
/** The "Open in" popup's size. */
export const OPEN_IN_W = 320;
export const OPEN_IN_H = 300;

/** The folder "Open in" acts on: the focused space's folder, else the focused pane's cwd; null hides the button. */
export function openInFolder(space, focused) {
  if (typeof space?.folder === "string" && space.folder.startsWith("/")) return space.folder;
  const cwd = focused?.cwd;
  return typeof cwd === "string" && cwd.startsWith("/") ? cwd : null;
}

/**
 * Where "Open in" acts: the focused space with the focused pane's cwd; when the focus names no known
 * space, the active space alone (no cwd: the focused pane may belong to another space or machine).
 * -> { folder, on }
 */
export function openInSource(spaces, focused) {
  const all = Array.isArray(spaces) ? spaces : [];
  const own = focused?.space ? all.find((s) => s?.id === focused.space) : null;
  const space = own ?? all.find((s) => s?.active) ?? null;
  return { folder: openInFolder(space, own ? focused : null), on: space?.machine ?? null };
}

/** A shared editor value that may be handed to `open -a`: an app name, never a path or a flag. */
export function editorName(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9 .+_-]{0,63}$/.test(value) && !value.endsWith(".app") ? value : null;
}

/** Where an app named `name` would be installed: the system Applications folder, then the home one. */
export function editorAppPaths(name, home) {
  const h = String(home || "").replace(/\/+$/, "");
  const roots = ["", ...(h.startsWith("/") ? [h] : [])].map((r) => `${r}/Applications`);
  return roots.map((r) => `${r}/${name}.app`);
}

/** The openOverlay spec for drover-open's "Open in" popup on `folder` (on: the machine, null when local). */
export function openInOverlay(folder, on, at) {
  return {
    mod: "drover-open", kind: "popup", width: OPEN_IN_W, height: OPEN_IN_H,
    props: { target: folder, cwd: folder, on: on ?? null, mode: "editors" },
    ...(at ? { at: { x: Math.max(8, at.x + at.w - OPEN_IN_W), y: at.y + at.h + 4 } } : {}),
  };
}

/**
 * What the main part does: open the folder in the remembered editor when it is installed, the folder
 * is local and this is macOS; otherwise the popup (where a remote space's rows explain themselves).
 * -> { kind: "exec", command, args } | { kind: "popup" } | null (no folder).
 */
export function openInPlan({ folder, on, editor, installed, platform }) {
  if (!folder) return null;
  const name = editorName(editor);
  if (on || platform !== "macos" || !name || !installed || !folder.startsWith("/")) return { kind: "popup" };
  return { kind: "exec", command: "open", args: ["-a", name, folder] };
}

/** The main part's tooltip. */
export function openInTip(editor, on) {
  const name = editorName(editor);
  if (on) return "Open in an editor (this machine only)";
  return name ? `Open in ${name}` : "Open in an editor";
}
