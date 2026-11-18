// Pure logic for drover-goto: no Herdr calls here, so it runs under node:test.
//
// An item is { id, kind, title, sub, action }. `id` is stable across renders (the
// recents list stores it). `action` is plain data that main.js turns into app commands:
//   { type: "space", space }
//   { type: "tab", space, tab }
//   { type: "agent", space, tab, terminal }
//   { type: "layout", stack, child, reveal: [hidden node ids to show first] }
//   { type: "command", name }

export const KINDS = ["agent", "tab", "space", "panel", "command"];
export const PREFIXES = { ">": "command", "@": "agent", "#": "tab" };
export const RECENT_MAX = 20;
export const RESULT_MAX = 60;

// The side panel's stack: each child is a panel the palette can open.
export const PANEL_STACK = "panel-body";

// The commands of the drover mods. A command shows only when its mod has a block in the
// shown layout, because "<mod>.<command>" reaches shown copies only.
export const COMMANDS = [
  { mod: "drover-arrange", command: "equalize", title: "Equalize splits" },
  { mod: "drover-arrange", command: "grid", title: "Arrange as grid" },
  { mod: "drover-arrange", command: "two-columns", title: "Arrange as two columns" },
  { mod: "drover-arrange", command: "three-columns", title: "Arrange as three columns" },
  { mod: "drover-arrange", command: "main-stack", title: "Arrange as main + stack" },
  { mod: "drover-arrange", command: "save", title: "Save arrangement" },
  { mod: "drover-arrange", command: "open", title: "Arrangements" },
];

// --- clean text ------------------------------------------------------------------

// Names come from terminals and folders, so they can carry escape sequences and invisible text.
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
// C0, DEL, C1, and the line and paragraph separators: all become a space (one line).
const BREAKS = new RegExp("[\\x00-\\x1f\\x7f-\\x9f\\u2028\\u2029]", "g");
// Invisible and format characters: soft hyphen, CGJ, Arabic marks, Hangul fillers, Khmer vowels,
// Mongolian selectors, zero-width, bidi embeddings and isolates, invisible operators, Braille blank,
// variation selectors (both blocks), BOM, interlinear annotation, musical format marks, tag block.
const INVISIBLE = new RegExp("[\\u00ad\\u034f\\u0600-\\u0605\\u061c\\u06dd\\u070f\\u0890\\u0891\\u08e2\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\u2800\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff9-\\ufffb]|\\udb40[\\udc00-\\udc7f\\udd00-\\uddef]|\\ud834[\\udd73-\\udd7a]", "g");
export const TEXT_MAX = 200;

/** One plain line: no escape sequences, controls or invisible text; spaces collapsed; at most
 *  `max` characters. The input is cut before any regex runs. */
export function clean(text, max = TEXT_MAX) {
  const s = String(text ?? "").slice(0, max * 8)
    .replace(ESCAPES, "")
    .replace(BREAKS, " ")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : s;
}

// --- fuzzy matching ------------------------------------------------------------

const isWordChar = (c) => /[\p{L}\p{N}]/u.test(c);
const isUpper = (c) => c !== c.toLowerCase() && c === c.toUpperCase();

/** True when index j of `chars` starts a word (start, after a separator, or a camelCase hump). */
function wordStart(chars, j) {
  if (j === 0) return true;
  const prev = chars[j - 1];
  if (!isWordChar(prev)) return true;
  return isUpper(chars[j]) && !isUpper(prev);
}

const WORD_BONUS = 8;
const RUN_BONUS = 5;
const GAP_COST = 1;
const START_BONUS = 3;

/**
 * Subsequence match of `query` in `target`, ignoring case. Returns null, or
 * { score, positions } for the best alignment: higher for matches at word starts and
 * for consecutive characters, lower for gaps. `positions` index the target's characters
 * (code points).
 */
export function fuzzy(query, target) {
  const q = [...String(query ?? "").toLowerCase()].filter((c) => !/\s/u.test(c));
  const chars = [...String(target ?? "")];
  const lower = chars.map((c) => c.toLowerCase());
  const n = chars.length;
  const m = q.length;
  if (m === 0) return { score: 0, positions: [] };
  if (m > n) return null;

  // end[i][j]: best score matching q[0..i] with q[i] at target j (or -Infinity).
  // from[i][j]: the target index of q[i-1] in that alignment.
  const end = Array.from({ length: m }, () => new Array(n).fill(-Infinity));
  const from = Array.from({ length: m }, () => new Array(n).fill(-1));
  for (let i = 0; i < m; i++) {
    // Best end[i-1][k] over k < j, with its index, kept while j advances.
    let bestPrev = -Infinity;
    let bestPrevAt = -1;
    for (let j = 0; j < n; j++) {
      if (i > 0 && j > 0 && end[i - 1][j - 1] > bestPrev) {
        bestPrev = end[i - 1][j - 1];
        bestPrevAt = j - 1;
      }
      if (lower[j] !== q[i]) continue;
      const bonus = wordStart(chars, j) ? WORD_BONUS : 0;
      if (i === 0) {
        end[0][j] = 1 + bonus + (j === 0 ? START_BONUS : 0) - Math.min(j, 6) * 0.1;
        continue;
      }
      let best = -Infinity;
      let at = -1;
      if (j > 0 && end[i - 1][j - 1] > -Infinity) {
        best = end[i - 1][j - 1] + 1 + bonus + RUN_BONUS;
        at = j - 1;
      }
      if (bestPrevAt >= 0) {
        const gap = j - bestPrevAt - 1;
        const viaGap = bestPrev + 1 + bonus - GAP_COST * Math.min(gap, 3) - (gap > 3 ? 0.1 * (gap - 3) : 0);
        if (viaGap > best) {
          best = viaGap;
          at = bestPrevAt;
        }
      }
      end[i][j] = best;
      from[i][j] = at;
    }
  }
  let score = -Infinity;
  let last = -1;
  for (let j = 0; j < n; j++) {
    if (end[m - 1][j] > score) {
      score = end[m - 1][j];
      last = j;
    }
  }
  if (last < 0) return null;
  const positions = new Array(m);
  for (let i = m - 1, j = last; i >= 0; i--) {
    positions[i] = j;
    j = from[i][j];
  }
  return { score, positions };
}

/**
 * How an item matches: the title (with the matched characters), else the title and its
 * secondary text together (half the score, nothing emphasised in the title). Null when neither.
 */
export function matchItem(query, item) {
  const direct = fuzzy(query, item.title);
  if (direct) return direct;
  const joined = fuzzy(query, `${item.title} ${item.sub ?? ""}`);
  if (!joined) return null;
  return { score: joined.score / 2, positions: [] };
}

// --- query ---------------------------------------------------------------------

/** "> foo" -> { kind: "command", text: "foo" }; no prefix -> { kind: null, text }. */
export function parseQuery(raw) {
  const s = String(raw ?? "").replace(/^\s+/, "");
  const kind = PREFIXES[s[0]];
  if (!kind) return { kind: null, text: s.trim() };
  return { kind, text: s.slice(1).trim() };
}

// --- ranking -------------------------------------------------------------------

const NEEDS_ORDER = { blocked: 0, done: 1 };
const AGENT_ORDER = { blocked: 0, done: 1, working: 2, idle: 3 };

const statusOf = (item) => item.state ?? null;

/** Pushes the recent list's `id` to the front, drops repeats, keeps the last RECENT_MAX. */
export function pushRecent(list, id) {
  return [id, ...(Array.isArray(list) ? list : []).filter((x) => x !== id)].slice(0, RECENT_MAX);
}

/**
 * Ordered results for a raw query, as [{ item, positions }].
 * - A prefix keeps one kind (`>` commands, `@` agents, `#` tabs).
 * - Text: fuzzy score, then shorter title, then the order given.
 * - No text: agents that need the person (blocked, then done), then recents (newest
 *   first), then, with a prefix, the rest of that kind, else the spaces.
 */
export function rank(items, raw, recent = []) {
  const { kind, text } = parseQuery(raw);
  const pool = kind ? items.filter((it) => it.kind === kind) : items;
  let out;
  if (text) {
    const scored = [];
    pool.forEach((item, order) => {
      const hit = matchItem(text, item);
      if (hit) scored.push({ item, positions: hit.positions, score: hit.score, order });
    });
    scored.sort((a, b) => b.score - a.score || [...a.item.title].length - [...b.item.title].length || a.order - b.order);
    out = scored.map(({ item, positions }) => ({ item, positions }));
  } else {
    const seen = new Set();
    out = [];
    const add = (item) => {
      if (!item || seen.has(item.id)) return;
      seen.add(item.id);
      out.push({ item, positions: [] });
    };
    pool
      .filter((it) => it.kind === "agent" && it.state in NEEDS_ORDER)
      .sort((a, b) => NEEDS_ORDER[statusOf(a)] - NEEDS_ORDER[statusOf(b)])
      .forEach(add);
    const byId = new Map(pool.map((it) => [it.id, it]));
    for (const id of recent) add(byId.get(id));
    if (kind) {
      const rest = pool.filter((it) => !seen.has(it.id));
      if (kind === "agent") rest.sort((a, b) => (AGENT_ORDER[statusOf(a)] ?? 9) - (AGENT_ORDER[statusOf(b)] ?? 9));
      rest.forEach(add);
    } else {
      pool.filter((it) => it.kind === "space").forEach(add);
    }
  }
  return out.slice(0, RESULT_MAX);
}

// --- building the items ----------------------------------------------------------

/** The node with `id` and the ids of the nodes above it that are hidden (itself included), or null. */
export function findPath(node, id, trail = []) {
  if (!node || typeof node !== "object") return null;
  const here = node.hidden === true ? [...trail, node.id] : trail;
  if (node.id === id) return { node, hidden: here };
  for (const child of [...(node.children ?? []), ...(node.floating ?? [])]) {
    const hit = findPath(child, id, here);
    if (hit) return hit;
  }
  return null;
}

/** Every mod with a block that is shown: no hidden node above it, and in each stack only the
 *  active child (the first when none is named). "<mod>.<command>" reaches shown copies only. */
export function shownMods(node, out = new Set()) {
  if (!node || typeof node !== "object" || node.hidden === true) return out;
  const mod = node.content?.mod;
  if (typeof mod === "string") out.add(mod);
  let children = node.children ?? [];
  if (node.type === "stack") {
    const active = children.find((c) => c?.id === node.active) ?? children[0];
    children = active ? [active] : [];
  }
  for (const child of [...children, ...(node.floating ?? [])]) shownMods(child, out);
  return out;
}

/** Every mod named by a block in the layout. */
export function layoutMods(node, out = new Set()) {
  if (!node || typeof node !== "object") return out;
  const mod = node.content?.mod;
  if (typeof mod === "string") out.add(mod);
  for (const child of [...(node.children ?? []), ...(node.floating ?? [])]) layoutMods(child, out);
  return out;
}

/** The side panel's names for the panel-body children it knows (the Panels popup's labels). */
export const PANEL_TITLES = {
  "drover-files": "Files", changes: "Changes", "drover-review": "Review", "data-sqlite": "Data: SQLite",
  "data-todo": "Data: Todo", "drover-git": "Git", "drover-pulls": "Pull requests", "drover-worktrees": "Worktrees",
  "drover-agents": "Agents", "drover-inbox": "Inbox", "drover-overview": "Overview",
  "drover-ports": "Ports", "drover-projects": "Projects", files: "Files (classic)",
};
const panelTitle = (id) => (Object.hasOwn(PANEL_TITLES, id) ? PANEL_TITLES[id] : humanize(id));

/** "page-pulls" -> "Pulls", "drover-git" -> "Drover git". */
export function humanize(id) {
  const s = String(id ?? "").replace(/^page-/, "").replace(/[-_]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : String(id ?? "");
}

const cleanTitle = (s) => clean(s).replace(/^[^\p{L}\p{N}~/]+/u, "").trim();

/** An agent's name: its tab's name when someone named it, else its own title, else its program. */
export function agentTitle(a, tab) {
  if (tab?.named) return tab.name;
  const live = cleanTitle(a.title);
  if (live && !/^[~/]/.test(live) && !live.includes("@")) return live;
  return a.program?.name || a.tab_name || a.address;
}

const where = (space) => (space.machine ? `${space.name} · ${space.machine}` : space.name);

/**
 * The items from plain data: { spaces, agents, layout }, shaped like the host's
 * spaces(), agents() and layout().
 */
export function buildItems({ spaces = [], agents = [], layout = null } = {}) {
  const items = [];
  const spaceById = new Map(spaces.map((s) => [s.id, s]));

  for (const s of spaces) {
    const sub = [s.folder, s.machine].filter(Boolean).join(" · ");
    items.push({ id: `space:${s.id}`, kind: "space", title: clean(s.name), sub: clean(sub), action: { type: "space", space: s.id } });
  }
  for (const s of spaces) {
    for (const t of s.tabs ?? []) {
      items.push({
        id: `tab:${t.id}`, kind: "tab", title: clean(t.name), sub: clean(where(s)),
        action: { type: "tab", space: s.id, tab: t.id },
      });
    }
  }
  for (const a of agents) {
    const space = spaceById.get(a.space);
    const tab = space?.tabs?.find((t) => t.id === a.tab);
    items.push({
      id: `agent:${a.address}`, kind: "agent", title: clean(agentTitle(a, tab)), state: a.status,
      sub: clean(`${a.status} · ${a.space_name ?? space?.name ?? ""}`),
      action: { type: "agent", space: a.space, tab: a.tab, terminal: a.address },
    });
  }

  const stackItems = (stackId, kind, label, titleOf) => {
    const found = findPath(layout, stackId);
    if (!found || found.node.type !== "stack") return;
    for (const child of found.node.children ?? []) {
      if (typeof child?.id !== "string") continue;
      items.push({
        id: `${kind}:${child.id}`, kind, title: clean(titleOf(child.id)), sub: label,
        action: { type: "layout", stack: stackId, child: child.id, reveal: found.hidden },
      });
    }
  };
  stackItems(PANEL_STACK, "panel", "Panel", panelTitle);

  const mods = shownMods(layout);
  for (const c of COMMANDS) {
    if (!mods.has(c.mod)) continue;
    items.push({
      id: `command:${c.mod}.${c.command}`, kind: "command", title: c.title, sub: `${c.mod}.${c.command}`,
      action: { type: "command", name: `${c.mod}.${c.command}` },
    });
  }
  return items;
}

/**
 * The app commands that carry an item's action out, as [name, args]. Only navigation:
 * select, show, and a mod's own command. Nothing is sent to a terminal, closed or run.
 * An agent also gets agent.focus, so the agent view shows that agent.
 */
export function commandsFor(action) {
  switch (action?.type) {
    case "space":
      return [["space.select", { id: action.space }]];
    case "tab":
      return [["space.select", { id: action.space }], ["tab.select", { id: action.tab }]];
    case "agent":
      return [
        ["space.select", { id: action.space }], ["tab.select", { id: action.tab }],
        ...(action.terminal ? [["agent.focus", { terminal: action.terminal }]] : []),
      ];
    case "layout":
      return [
        ...(action.reveal ?? []).map((id) => ["layout.show", { id }]),
        ["layout.select", { stack: action.stack, child: action.child }],
      ];
    case "command":
      return [[action.name, {}]];
    default:
      return [];
  }
}

// --- storage -------------------------------------------------------------------

/** The recents file's text -> a list of ids (bad or missing text gives []). */
export function readRecent(text) {
  try {
    const v = JSON.parse(text ?? "null");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export const writeRecent = (list) => `${JSON.stringify(list.slice(0, RECENT_MAX), null, 1)}\n`;

// --- display ---------------------------------------------------------------------

/** Splits a title into runs of { text, on } so matched characters can be emphasised. */
export function segments(title, positions = []) {
  const on = new Set(positions);
  const out = [];
  [...String(title ?? "")].forEach((c, i) => {
    const hit = on.has(i);
    const last = out[out.length - 1];
    if (last && last.on === hit) last.text += c;
    else out.push({ text: c, on: hit });
  });
  return out;
}

/** The index after moving `by` steps in a list of `length`, wrapping round. */
export function move(index, by, length) {
  if (length <= 0) return 0;
  return (((index + by) % length) + length) % length;
}
