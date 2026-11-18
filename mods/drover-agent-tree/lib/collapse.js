// Pure logic for folding the Agents block: find the block in the layout tree, read whether it
// is collapsed, and name the layout command that changes it. No Herdr or gpui imports.

/** The block showing `mod` (first match, depth first), or the node with `fallbackId`. */
export function findBlock(root, mod, fallbackId) {
  let byId = null;
  const walk = (n) => {
    if (!n || typeof n !== "object") return null;
    if (n.type === "block" && n.content?.mod === mod) return n;
    if (n.id === fallbackId && n.type === "block") byId ??= n;
    for (const c of n.children ?? []) { const f = walk(c); if (f) return f; }
    return null;
  };
  return walk(root) ?? byId;
}

/** The block's height when folded: the header plus the 1 px line above it. */
export const collapsedPx = (headerH) => headerH + 1;

/** True / false when the node's size says so; null when it carries no size to read. */
export function layoutCollapsed(node, headerH) {
  const s = node?.size;
  if (!s) return null;
  if (typeof s.px === "number") return s.px <= collapsedPx(headerH);
  if (typeof s.weight === "number") return false;
  return null;
}

/**
 * What the list shows, and the command (if any) that makes the layout match it.
 * The layout wins when it says: a block already folded shows folded. Otherwise the stored
 * choice is applied to the layout once.
 */
export function startState(node, stored, headerH) {
  const seen = layoutCollapsed(node, headerH);
  if (seen === true) return { collapsed: true, command: null };
  if (stored === true) return { collapsed: true, command: resizeCommand(node?.id, true, headerH) };
  return { collapsed: false, command: null };
}

/** The size to remember before folding: the node's weight or px, or null when it is already
 *  folded (or carries no size), so a fold never overwrites the real size with the folded one. */
export function sizeToRemember(node, headerH) {
  const s = node?.size;
  if (!s || layoutCollapsed(node, headerH) !== false) return null;
  if (typeof s.weight === "number" && s.weight > 0) return { weight: s.weight };
  if (typeof s.px === "number" && s.px > 0) return { px: s.px };
  return null;
}

/** Parses a remembered size from storage; null when absent or not a usable {weight} or {px}. */
export function parseRemembered(raw) {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v.weight === "number" && v.weight > 0) return { weight: v.weight };
    if (v && typeof v.px === "number" && v.px > 0) return { px: v.px };
  } catch { /* absent or malformed */ }
  return null;
}

/** The layout.resize call for a fold (px) or an unfold (the remembered size, else weight 1).
 *  Null without a block id. */
export function resizeCommand(id, collapsed, headerH, remembered) {
  if (!id) return null;
  if (collapsed) return { name: "layout.resize", args: { id, px: collapsedPx(headerH) } };
  return { name: "layout.resize", args: { id, ...(remembered?.weight > 0 ? { weight: remembered.weight } : remembered?.px > 0 ? { px: remembered.px } : { weight: 1 }) } };
}

/** Parses the stored flag: only the string "1" folds. */
export const parseStored = (raw) => raw === "1";
