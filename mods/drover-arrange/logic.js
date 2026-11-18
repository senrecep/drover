// Pure logic for drover-arrange: no Herdr calls here, so it runs under node:test.
//
// Three tree shapes appear:
// - doc node: a tab's tree as herdr-core's "herdr-app" document stores it
//   ({id, type: "row" | "column" | "block", size?: {weight}, children?, content?}).
// - live node: normalise(doc) — {type: "pane" | "row" | "column", id, sizeId, w,
//   children?, terminal?, mod?}. `id` is the node itself (a pane id splits);
//   `sizeId` is the outermost id that carries its weight in its parent (a
//   one-child wrapper collapses into its child but keeps the wrapper's size).
// - shape: what an arrangement saves — {type: "pane", w, argv?} or
//   {type: "row" | "column", w, children}; weights are fractions summing to 1
//   in each container and no container has a child of its own direction.

export const DIRECTION = { row: "right", column: "down" };

const weightOf = (n) => {
  const w = n?.size?.weight;
  return typeof w === "number" && w > 0 ? w : 1; // unsized siblings share equally
};

const round = (x) => Math.round(x * 10000) / 10000;

// --- reading -----------------------------------------------------------------

/** The first JSON-RPC response line of `hc connect`, or throws its error. */
export function parseRpc(stdout) {
  for (const line of String(stdout ?? "").split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    const msg = JSON.parse(s);
    if (msg.error) throw new Error(msg.error.message ?? "herdr-core error");
    if ("result" in msg) return msg.result;
  }
  throw new Error("herdr-core gave no answer");
}

/** The doc root of a tab in herdr-core's "herdr-app" document value. */
export function findTabRoot(value, tabId) {
  for (const space of value?.spaces ?? []) {
    for (const tab of space.tabs ?? []) if (tab.id === tabId) return tab.root ?? null;
  }
  return null;
}

/** doc node -> live node (null for an empty container). */
export function normalise(node, sizeId = null, w = null) {
  if (!node) return null;
  const outer = sizeId ?? node.id;
  const weight = w ?? weightOf(node);
  if (node.type === "row" || node.type === "column") {
    const kids = (node.children ?? []).filter(Boolean);
    if (kids.length === 0) return null;
    if (kids.length === 1) return normalise(kids[0], outer, weight);
    const children = kids.map((c) => normalise(c)).filter(Boolean);
    if (children.length === 1) return { ...children[0], sizeId: outer, w: weight };
    return { type: node.type, id: node.id, sizeId: outer, w: weight, children };
  }
  const content = node.content ?? {};
  const leaf = { type: "pane", id: node.id, sizeId: outer, w: weight };
  if (content.terminal) leaf.terminal = content.terminal;
  if (content.mod) leaf.mod = content.mod;
  return leaf;
}

export function leaves(node) {
  if (!node) return [];
  return node.type === "pane" ? [node] : node.children.flatMap(leaves);
}

export const countPanes = (node) => leaves(node).length;

// --- shapes ------------------------------------------------------------------

/** Any tree (live or shape) -> a clean shape: fractions, no same-direction nesting. */
export function toShape(node, argvOf = () => null) {
  const shape = build(node, argvOf);
  shape.w = 1;
  return shape;
}

function build(node, argvOf) {
  if (node.type === "pane") {
    const leaf = { type: "pane", w: node.w ?? 1 };
    const argv = node.argv ?? argvOf(node);
    if (Array.isArray(argv) && argv.length) leaf.argv = argv.map(String);
    return leaf;
  }
  // Flatten a child of the same direction into this level, weights multiplied.
  const raw = [];
  const total = node.children.reduce((s, c) => s + (c.w ?? 1), 0) || 1;
  for (const c of node.children) {
    const share = (c.w ?? 1) / total;
    const sub = build(c, argvOf);
    if (sub.type === node.type) {
      const subTotal = sub.children.reduce((s, g) => s + g.w, 0) || 1;
      for (const g of sub.children) raw.push({ ...g, w: share * (g.w / subTotal) });
    } else raw.push({ ...sub, w: share });
  }
  return { type: node.type, w: node.w ?? 1, children: raw.map((c) => ({ ...c, w: round(c.w) })) };
}

/** A saved shape from storage, checked; null when it isn't one. */
export function validShape(s, depth = 0) {
  if (!s || typeof s !== "object" || depth > 12) return null;
  const w = typeof s.w === "number" && s.w > 0 ? s.w : 1;
  if (s.type === "pane") {
    const leaf = { type: "pane", w };
    if (Array.isArray(s.argv) && s.argv.length && s.argv.every((a) => typeof a === "string")) leaf.argv = s.argv;
    return leaf;
  }
  if ((s.type !== "row" && s.type !== "column") || !Array.isArray(s.children) || s.children.length < 2) return null;
  const children = s.children.map((c) => validShape(c, depth + 1));
  if (children.some((c) => !c)) return null;
  return toShape({ type: s.type, w, children });
}

export function describe(shape) {
  const n = countPanes(shape);
  const programs = leaves(shape).filter((l) => l.argv).length;
  const parts = [`${n} pane${n === 1 ? "" : "s"}`];
  if (shape.type !== "pane") parts.push(shape.type === "row" ? "side by side" : "stacked");
  if (programs) parts.push(`${programs} program${programs === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

const pane = (w = 1) => ({ type: "pane", w });
export const PRESETS = [
  { key: "two-columns", name: "Two columns", shape: toShape({ type: "row", children: [pane(), pane()] }) },
  { key: "three-columns", name: "Three columns", shape: toShape({ type: "row", children: [pane(), pane(), pane()] }) },
  {
    key: "main-stack",
    name: "Main + stack",
    shape: toShape({ type: "row", children: [pane(3), { type: "column", w: 2, children: [pane(), pane()] }] }),
  },
  {
    key: "grid",
    name: "2×2 grid",
    shape: toShape({
      type: "row",
      children: [
        { type: "column", children: [pane(), pane()] },
        { type: "column", children: [pane(), pane()] },
      ],
    }),
  },
];

// --- equalize ----------------------------------------------------------------

/** layout.resize steps that make every container's children equal. */
export function equalizeOps(live) {
  const ops = [];
  const walk = (n) => {
    if (!n || n.type === "pane") return;
    if (!n.children.every((c) => c.w === n.children[0].w)) {
      for (const c of n.children) ops.push({ id: c.sizeId, weight: 1 });
    }
    n.children.forEach(walk);
  };
  walk(live);
  return ops;
}

// --- apply -------------------------------------------------------------------

const firstLeaf = (s) => (s.type === "pane" ? s : firstLeaf(s.children[0]));

/**
 * The next split that brings `live` closer to `shape`, or null when no split
 * is needed or possible. A split right/down puts the new pane just after the
 * one split (in its row/column, or in a new one around it), so appending
 * always splits the newest pane at the end to keep the order. Siblings are
 * added before descending, so a level is complete before its children grow.
 * `argv`: the saved command of the shape pane the new pane becomes.
 */
export function nextSplit(live, shape, { programs = false } = {}) {
  const walk = (s, l) => {
    if (s.type === "pane") return null;
    const direction = DIRECTION[s.type];
    const argvFor = (index) => (programs ? firstLeaf(s.children[index]).argv ?? null : null);
    if (l.type === "pane") return { pane: l.id, direction, argv: argvFor(1) };
    if (l.type !== s.type) return null;
    const m = l.children.length;
    if (m < s.children.length) {
      let at = -1;
      for (let i = m - 1; i >= 0; i--) if (l.children[i].type === "pane") { at = i; break; }
      if (at >= 0) return { pane: l.children[at].id, direction, argv: argvFor(at + 1) };
    }
    for (let i = 0; i < Math.min(m, s.children.length); i++) {
      const step = walk(s.children[i], l.children[i]);
      if (step) return step;
    }
    return null;
  };
  return live && shape ? walk(shape, live) : null;
}

/**
 * After the splits: layout.resize steps for every part of `live` that matches
 * `shape`, plus notes on what doesn't. Extra live children keep an equal share
 * (1/m) and the matched ones split the rest in the saved proportions.
 */
export function resizePlan(live, shape) {
  const ops = [];
  const notes = { extra: 0, mismatched: 0, missing: 0 };
  const walk = (s, l) => {
    if (s.type === "pane") {
      if (l.type !== "pane") notes.extra += countPanes(l) - 1;
      return;
    }
    if (l.type === "pane") { notes.missing += countPanes(s) - 1; return; }
    if (l.type !== s.type) {
      notes.mismatched += 1;
      return;
    }
    const k = s.children.length;
    const m = l.children.length;
    const n = Math.min(k, m);
    const total = s.children.slice(0, n).reduce((a, c) => a + c.w, 0) || 1;
    // Matched children share n/m of the space in saved proportions; extras get 1/m each.
    for (let i = 0; i < m; i++) {
      const weight = i < n ? (s.children[i].w / total) * (n / m) : 1 / m;
      ops.push({ id: l.children[i].sizeId, weight: round(weight) });
    }
    for (let i = n; i < m; i++) notes.extra += countPanes(l.children[i]);
    for (let i = n; i < k; i++) notes.missing += countPanes(s.children[i]);
    for (let i = 0; i < n; i++) walk(s.children[i], l.children[i]);
  };
  if (live && shape) walk(shape, live);
  return { ops, notes };
}

/** One line for the popup after an apply. */
export function summary({ created, started, notes, stopped }) {
  const out = [];
  out.push(created ? `Made ${created} pane${created === 1 ? "" : "s"}` : "No new panes needed");
  if (started) out.push(`started ${started} program${started === 1 ? "" : "s"}`);
  if (notes.extra) out.push(`${notes.extra} extra pane${notes.extra === 1 ? "" : "s"} kept; sizes set where the shape matches`);
  if (notes.mismatched) out.push(`${notes.mismatched} split${notes.mismatched === 1 ? " runs" : "s run"} the other way and ${notes.mismatched === 1 ? "was" : "were"} left alone`);
  if (notes.missing) out.push(`${notes.missing} pane${notes.missing === 1 ? "" : "s"} could not be added there`);
  if (stopped) out.push(stopped);
  return out.join(" · ") + ".";
}

/** The sentence for an exec that could not start `tool` (Windows has no sh); null for any other failure. */
export function missingTool(err, tool, platform) {
  if (!/program not found|ENOENT/.test(String(err?.message ?? err))) return null;
  return platform === "windows"
    ? `Reading the layout needs ${tool}. Install Git for Windows and put its usr\\bin on PATH.`
    : `Reading the layout needs ${tool}. Install it and try again.`;
}

// --- saved arrangements ------------------------------------------------------

export function cleanName(name) {
  return String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
}

/** Parsed storage file -> [{name, shape, saved}], dropping anything malformed. */
export function readStore(text) {
  let data;
  try {
    data = JSON.parse(text ?? "");
  } catch {
    return [];
  }
  const list = Array.isArray(data?.arrangements) ? data.arrangements : [];
  const out = [];
  for (const a of list) {
    const name = cleanName(a?.name);
    const shape = a?.shape?.type === "pane" ? null : validShape(a?.shape);
    if (name && shape && !out.some((o) => o.name === name)) out.push({ name, shape, saved: Number(a.saved) || 0 });
  }
  return out;
}

export function writeStore(list) {
  return JSON.stringify({ version: 1, arrangements: list }, null, 2) + "\n";
}

/** Add or replace by name. */
export function upsert(list, entry) {
  const rest = list.filter((a) => a.name !== entry.name);
  return [...rest, entry].sort((a, b) => a.name.localeCompare(b.name));
}

export function rename(list, from, to) {
  const name = cleanName(to);
  if (!name) return { list, error: "Give it a name." };
  if (name !== from && list.some((a) => a.name === name)) return { list, error: `“${name}” already exists.` };
  return { list: list.map((a) => (a.name === from ? { ...a, name } : a)).sort((a, b) => a.name.localeCompare(b.name)) };
}

export const remove = (list, name) => list.filter((a) => a.name !== name);
