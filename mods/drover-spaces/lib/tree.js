// tree.js: the pure model behind drover-spaces. No host imports, so node:test loads it as is.
// Rows are flat (one array, one scroll child each) so a keyboard cursor index is a child index.

/** An agent's fallback letter: the first letter or digit of the name, upper-cased; else its first character. */
export function initial(name) {
  const chars = [...String(name ?? "").trim()];
  const letter = chars.find((c) => /[\p{L}\p{N}]/u.test(c)) ?? chars[0];
  return letter ? letter.toUpperCase() : "?";
}

/** "<1m", "4m", "2h", "3d" for a duration in ms (negative counts as zero). */
export function formatAge(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (s < 60) return "<1m";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** The machine an id or address belongs to: the part before "/", null for this computer. */
export function machineOf(id) {
  const s = String(id ?? "");
  const i = s.indexOf("/");
  return i > 0 ? s.slice(0, i) : null;
}

/** The status an age counts by: done and idle are one (looking at a finished agent turns done into idle). */
export const ageStatus = (status) => (status === "done" ? "idle" : status ?? null);

/** tab id -> its changed_at (when something in it last changed state), from spaces(). */
export function tabChangedAt(spaces) {
  const out = new Map();
  for (const s of spaces ?? []) for (const t of s.tabs ?? []) if (Number.isFinite(t?.changed_at)) out.set(t.id, t.changed_at);
  return out;
}

/**
 * Keeps, per agent address, the status it has (done and idle as one) and since when. An unchanged
 * status keeps its `since` (moved back to its tab's `changed_at` when that is earlier); a new or changed one starts at its tab's `changed_at` (the host's clock,
 * the same seed drover-agent-tree uses), else at `now`. Entries for agents that are gone go only when
 * `canPrune(address)` says their machine's list is complete. `changedAt`: tabChangedAt(spaces()).
 * Returns { ages, changed }.
 */
export function reconcileAges(prev, agents, now, canPrune = () => true, changedAt = new Map()) {
  const ages = {};
  let changed = false;
  const live = new Set();
  for (const a of agents ?? []) {
    if (!a?.address) continue;
    live.add(a.address);
    const status = ageStatus(a.status);
    const old = prev?.[a.address];
    const tabAt = changedAt.get(a.tab);
    const at = Number.isFinite(tabAt) && tabAt <= now ? tabAt : null;
    if (old && ageStatus(old.status) === status && Number.isFinite(old.since)) {
      // Nothing in the tab changed since `at`, so the status held since then at the latest: an
      // entry stamped later (first seen after a restart) moves back to it.
      const since = at !== null && at < old.since ? at : old.since;
      if (old.status === status && since === old.since) ages[a.address] = old;
      else { ages[a.address] = { status, since }; changed = true; }
    } else {
      ages[a.address] = { status, since: at ?? now };
      changed = true;
    }
  }
  for (const [address, entry] of Object.entries(prev ?? {})) {
    if (live.has(address)) continue;
    if (canPrune(address)) changed = true;
    else ages[address] = entry;
  }
  return { ages, changed };
}

/**
 * Drops space ("s:") and tab ("t:") keys whose id is gone, but only those `canPrune(id)` allows.
 * `liveIds`: the live space and tab ids. Returns the same Set when nothing went.
 */
export function pruneKeys(keys, liveIds, canPrune = () => true) {
  const live = new Set(liveIds);
  const out = new Set();
  let dropped = false;
  for (const k of keys) {
    const id = k.slice(2);
    if ((k.startsWith("s:") || k.startsWith("t:")) && !live.has(id) && canPrune(id)) { dropped = true; continue; }
    out.add(k);
  }
  return dropped ? out : keys;
}

/** Spaces grouped by machine in first-seen order, this computer first. `machines`: names (null:
 * this computer) of connected machines; one with no spaces still gets an (empty) group, after the others. */
export function groupByMachine(spaces, machines = []) {
  const groups = new Map();
  for (const s of spaces ?? []) {
    const m = s.machine ?? null;
    if (!groups.has(m)) groups.set(m, []);
    groups.get(m).push(s);
  }
  for (const m of machines ?? []) if (!groups.has(m ?? null)) groups.set(m ?? null, []);
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : 0))
    .map(([machine, list]) => ({ machine, spaces: list }));
}

/** The branch of a tab's first terminal pane, or null. `panes`: panes(), read once. */
export function tabBranch(tab, panes) {
  return (panes ?? []).find((p) => p.tab === tab.id && p.terminal)?.branch ?? null;
}

/** The last part of a folder path ("/" for the root), or null. */
export function baseName(path) {
  const s = String(path ?? "").trim();
  if (!s) return null;
  const trimmed = s.replace(/\/+$/, "");
  if (!trimmed) return "/";
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** A tab's panes from panes(), in their order. */
export function tabPanes(tab, panes) {
  return (panes ?? []).filter((p) => p.tab === tab.id);
}

/** The agent running in a pane: the same pane id, else the pane's terminal is the agent's address. */
export function paneAgent(pane, agents) {
  return (agents ?? []).find((a) => a.pane === pane.pane) ?? (pane.terminal ? (agents ?? []).find((a) => a.address === pane.terminal) : null) ?? null;
}

const SHELLS = new Set(["fish", "zsh", "bash", "sh", "dash", "ksh", "tcsh", "csh", "nu", "elvish", "xonsh", "pwsh", "powershell"]);
const PATHY = /^(~|\/|[A-Za-z]:\\)/;

/**
 * Whether a terminal title only says where the shell is: a path, "<path> - <shell>", "<shell> <path>"
 * or "user@host: <path>". Returns { shell } (the shell's name, or null when the title doesn't say),
 * or null for a title that names something (an agent's task, a program, a file).
 */
export function placeTitle(title) {
  const s = String(title ?? "").trim();
  if (!s) return null;
  let m = s.match(/^(.+?)\s+[-–—]\s+([\w.+-]+)$/);
  if (m && PATHY.test(m[1])) return { shell: SHELLS.has(m[2]) ? m[2] : null };
  m = s.match(/^([\w.+-]+)\s+(\S.*)$/);
  if (m && SHELLS.has(m[1]) && PATHY.test(m[2])) return { shell: m[1] };
  if (/^[^\s@:]+@[^\s:]+:\s*(~|\/)/.test(s)) return { shell: null };
  if (PATHY.test(s) && !/\s[-–—]\s/.test(s)) return { shell: null };
  return null;
}

/**
 * What a pane sub-row shows. `label`: the agent's title, else the pane's title, else the program's
 * name. `folder` (cwd basename) and `branch` only where they differ from the tab's own (its first
 * terminal pane, `ref`) and the space's (`space.folder`, `space.branch`); null otherwise.
 */
export function paneDetail(pane, { agent = null, ref = null, space = {}, index = null } = {}) {
  // A terminal with no title of its own reports its address ("t2h"): that names nothing, so say which pane it is.
  // A shell's own title only repeats where it is ("~/w/app - fish", "me@box: ~/w"): name the shell instead.
  const raw = pane.title && pane.title !== pane.terminal ? pane.title : null;
  const place = raw ? placeTitle(raw) : null;
  const title = place ? place.shell : raw;
  const label = agent?.title || title || agent?.program?.name || pane.program?.name || agent?.app || pane.app || pane.mod || (index != null ? `Pane ${index + 1}` : "Terminal");
  const folder = baseName(pane.cwd);
  const showFolder = folder && folder !== baseName(ref?.cwd) && folder !== baseName(space.folder);
  const branch = pane.branch ?? null;
  const showBranch = branch && branch !== (ref?.branch ?? null) && branch !== (space.branch ?? null);
  return { label, status: agent?.status ?? pane.status ?? null, folder: showFolder ? folder : null, branch: showBranch ? branch : null };
}

/** Panes of one tab that share a label ("zsh", "zsh") get their place after it ("zsh 2"), so each row names one pane. */
export function numberRepeats(paneRows) {
  const seen = new Map();
  for (const r of paneRows) seen.set(r.label, (seen.get(r.label) ?? 0) + 1);
  const at = new Map();
  for (const r of paneRows) {
    if (seen.get(r.label) < 2) continue;
    const n = (at.get(r.label) ?? 0) + 1;
    at.set(r.label, n);
    r.label = `${r.label} ${n}`;
  }
  return paneRows;
}

/**
 * The visible rows, in order. Row kinds:
 *  machine {machine, online, count}  space {space, tabs, settled}
 *  tab {space, tab, branch, agents, split (lists pane rows), paneCount}  pane {space, tab, pane, agent, label, status, folder, branch}
 *  agent {space, tab, agent}  settled {space, count, open}  new {}  empty {machine, online} (a machine with no spaces)
 * A tab split into more than one pane lists each pane (with its agent, if any) instead of agent rows,
 * and folds; agents that match no pane follow its panes. A single-pane tab lists its agents.
 * `folded`: a Set of row keys ("m:<machine>", "s:<space id>", "t:<tab id>"). `openSettled`: space ids whose
 * put-away tabs are shown. `online(machine)`: true when its layout is ready.
 */
export function flattenRows({ spaces = [], agents = [], panes = [], folded = new Set(), openSettled = new Set(), online = () => true, machines = [] } = {}) {
  const rows = [];
  const groups = groupByMachine(spaces, machines);
  const grouped = groups.length > 1;
  const byTab = new Map();
  for (const a of agents) {
    if (!byTab.has(a.tab)) byTab.set(a.tab, []);
    byTab.get(a.tab).push(a);
  }
  for (const g of groups) {
    const mkey = `m:${g.machine ?? ""}`;
    if (grouped) {
      rows.push({ kind: "machine", key: mkey, depth: 0, machine: g.machine, online: online(g.machine), count: g.spaces.length, folded: folded.has(mkey) });
      if (folded.has(mkey)) continue;
    }
    const base = grouped ? 1 : 0;
    // A connected machine with no spaces offers to open one there.
    if (grouped && !g.spaces.length) rows.push({ kind: "empty", key: `e:${g.machine ?? ""}`, depth: 1, machine: g.machine, online: online(g.machine), parent: mkey });
    for (const s of g.spaces) {
      const skey = `s:${s.id}`;
      const all = s.tabs ?? [];
      const shown = all.filter((t) => !t.settled);
      const settled = all.filter((t) => t.settled);
      const isFolded = folded.has(skey);
      rows.push({ kind: "space", key: skey, depth: base, space: s, tabs: shown.length, settled: settled.length, folded: isFolded, parent: grouped ? mkey : null });
      if (isFolded) continue;
      const open = openSettled.has(s.id);
      const pushTab = (t) => {
        const branch = tabBranch(t, panes);
        const list = byTab.get(t.id) ?? [];
        const own = tabPanes(t, panes);
        const split = own.length > 1;
        const tkey = `t:${t.id}`;
        const tabFolded = split && folded.has(tkey);
        rows.push({ kind: "tab", key: tkey, depth: base + 1, space: s, tab: t, branch: branch && branch !== s.branch ? branch : null,
          agents: list.length, split, cwd: own.find((p) => p.terminal)?.cwd ?? null, paneCount: split ? own.length : (t.panes ?? own.length), folded: tabFolded, parent: skey });
        // `paneCount` > 1 with `split` false: the tab is split but panes() doesn't list its panes (yet); it shows as split, without sub-rows.
        if (tabFolded) return;
        const placed = new Set();
        let start = rows.length;
        if (split) {
          const ref = own.find((p) => p.terminal) ?? null;
          start = rows.length;
          for (const [i, p] of own.entries()) {
            const a = paneAgent(p, list.filter((x) => !placed.has(x.address)));
            if (a) placed.add(a.address);
            rows.push({ kind: "pane", key: `p:${p.pane}`, depth: base + 2, space: s, tab: t, pane: p, agent: a, ...paneDetail(p, { agent: a, ref, space: s, index: i }), parent: tkey });
          }
        }
        if (split) numberRepeats(rows.slice(start));
        for (const a of list) if (!placed.has(a.address)) rows.push({ kind: "agent", key: `a:${a.address}`, depth: base + 2, space: s, tab: t, agent: a, parent: tkey });
      };
      shown.forEach(pushTab);
      if (settled.length) {
        rows.push({ kind: "settled", key: `z:${s.id}`, depth: base + 1, space: s, count: settled.length, open, parent: skey });
        if (open) settled.forEach(pushTab);
      }
    }
  }
  return rows;
}

/** Whether a row folds: machine and space rows, tabs split into panes (the put-away row opens and closes too). */
export const foldable = (row) => row?.kind === "machine" || row?.kind === "space" || row?.kind === "settled" || (row?.kind === "tab" && Boolean(row.split));
const isOpen = (row) => (row.kind === "settled" ? row.open : !row.folded);

/** The key `delta` rows from `key` (clamped); the first row when `key` is not shown. */
export function step(rows, key, delta) {
  if (!rows.length) return null;
  const i = rows.findIndex((r) => r.key === key);
  if (i < 0) return rows[delta < 0 ? rows.length - 1 : 0].key;
  return rows[Math.max(0, Math.min(rows.length - 1, i + delta))].key;
}

/**
 * What a key does at the cursor. Returns { cursor, toggle?: row, activate?: row } or null for
 * keys this list leaves alone. ←: fold an open row, else go to its parent. →: unfold a folded
 * row, else go to its first child.
 */
export function keyAction(rows, cursor, key) {
  const i = rows.findIndex((r) => r.key === cursor);
  const row = i >= 0 ? rows[i] : null;
  if (key === "down" || key === "up") return { cursor: step(rows, cursor, key === "down" ? 1 : -1) };
  if (key === "home") return { cursor: rows[0]?.key ?? null };
  if (key === "end") return { cursor: rows[rows.length - 1]?.key ?? null };
  if (!row) return key === "left" || key === "right" || key === "enter" ? { cursor: rows[0]?.key ?? null } : null;
  if (key === "enter") return { cursor, activate: row };
  if (key === "right") {
    if (foldable(row) && !isOpen(row)) return { cursor, toggle: row };
    const next = rows[i + 1];
    return { cursor: next && next.parent === row.key ? next.key : cursor };
  }
  if (key === "left") {
    if (foldable(row) && isOpen(row)) return { cursor, toggle: row };
    return { cursor: row.parent ?? cursor };
  }
  return null;
}
