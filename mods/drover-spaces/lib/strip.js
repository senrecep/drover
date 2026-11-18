// The sidebar's view strip: which list the layout's stack shows (Spaces or Agents), and what the
// Agents tab says while hidden. Pure: no Herdr or gpui imports.

/** The stack the strip switches, and its two children, by layout id. */
export const STACK_ID = "sidebar-views";
export const VIEWS = Object.freeze([
  { id: "spaces", label: "Spaces" },
  { id: "agents", label: "Agents" },
]);

/** The layout node with `id` (depth first), or null. */
export function findNode(root, id) {
  if (!root || typeof root !== "object") return null;
  if (root.id === id) return root;
  for (const c of root.children ?? []) {
    const f = findNode(c, id);
    if (f) return f;
  }
  return null;
}

/** The view the stack shows: its `active` child when that is one of ours, else the first. */
export function activeView(root, stackId = STACK_ID) {
  const active = findNode(root, stackId)?.active;
  return VIEWS.some((v) => v.id === active) ? active : VIEWS[0].id;
}

const URGENT = ["blocked", "done", "working"];

/**
 * What the Agents tab shows: the most urgent status any agent has and how many share it
 * (needs you, then done, then working); idle only: the total, with no status.
 */
export function agentBadge(list) {
  const all = Array.isArray(list) ? list : [];
  for (const status of URGENT) {
    const n = all.filter((a) => a?.status === status).length;
    if (n) return { status, count: n };
  }
  return { status: null, count: all.length };
}

/** The sort the agents list uses (shared key `agents.sort`) and the one a click moves to. */
export const SORTS = Object.freeze([
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
]);
export function sortOf(value) {
  return SORTS.find((s) => s.id === value) ?? SORTS[0];
}
export function nextSort(value) {
  const i = SORTS.indexOf(sortOf(value));
  return SORTS[(i + 1) % SORTS.length];
}
