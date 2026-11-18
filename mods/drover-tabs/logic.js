// Pure logic for drover-tabs: no Herdr calls here, so it runs under node:test.
//
// The side panel is the layout's `panel` column holding the `panel-body` stack. Every child of
// that stack is a panel: the toolbar pins some of them as buttons, and the Panels popup lists all
// of them in groups. A child the catalog doesn't know goes in "Other".

export const PANEL = "panel";
export const BODY = "panel-body";
export const PINS_KEY = "drover-tabs.pinned";
export const DEFAULT_PINS = ["drover-files", "changes", "drover-git"];
export const GROUPS = ["Files", "Git", "Agents", "System", "Other"];

const ICON = (name) => `mods/drover-tabs/icons/${name}.svg`;

// By block id. `mod`/`view` let a block with another id still be recognised by what it shows.
export const CATALOG = [
  { id: "drover-files", mod: "drover-files", label: "Files", group: "Files", icon: ICON("files") },
  { id: "changes", mod: "changes", label: "Changes", group: "Files", icon: ICON("changes") },
  { id: "drover-review", mod: "drover-review", label: "Review", group: "Files", icon: ICON("git-compare") },
  { id: "data-sqlite", mod: "drover-data", view: "sqlite", label: "Data: SQLite", group: "Files", icon: ICON("database") },
  { id: "data-todo", mod: "drover-data", view: "todo", label: "Data: Todo", group: "Files", icon: ICON("circle-check") },
  { id: "drover-git", mod: "drover-git", label: "Git", group: "Git", icon: ICON("circle-dot") },
  { id: "drover-pulls", mod: "drover-pulls", label: "Pull requests", group: "Git", icon: ICON("git-pull-request") },
  { id: "drover-worktrees", mod: "drover-worktrees", label: "Worktrees", group: "Git", icon: ICON("git-branch") },
  { id: "drover-agents", mod: "drover-agents", label: "Agents", group: "Agents", icon: ICON("bot") },
  { id: "drover-inbox", mod: "drover-inbox", label: "Inbox", group: "Agents", icon: ICON("inbox") },
  { id: "drover-overview", mod: "drover-overview", label: "Overview", group: "Agents", icon: ICON("activity") },
  { id: "drover-history", mod: "drover-history", label: "History", group: "Agents", icon: ICON("history") },
  { id: "drover-ports", mod: "drover-ports", label: "Ports", group: "System", icon: ICON("plug") },
  { id: "drover-projects", mod: "drover-projects", label: "Projects", group: "System", icon: ICON("folder") },
  { id: "drover-sim", mod: "drover-sim", label: "Simulator", group: "System", icon: ICON("smartphone") },
  // The shipped Files panel: known, but in no named group.
  { id: "files", mod: "files", label: "Files (built-in)", group: "Other", icon: ICON("file-text") },
];
const FALLBACK_ICON = ICON("panel-right");

/** The node with `id`, or null. Looks in children and floating blocks. */
export function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of [...(node.children ?? []), ...(node.floating ?? [])]) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

/** "drover-git" -> "Drover git". For children the catalog doesn't know. */
export function humanize(id) {
  const s = String(id ?? "").replace(/[-_]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : String(id ?? "");
}

/** What a panel-body child is: catalog entry by id, else by its mod (and view), else "Other". */
export function describe(child) {
  const id = child?.id;
  const mod = child?.content?.mod;
  const view = child?.content?.props?.view;
  const hit = CATALOG.find((e) => e.id === id)
    ?? CATALOG.find((e) => e.mod === mod && (e.view === undefined || e.view === (view ?? "sqlite")));
  if (hit) return { id, label: hit.label, group: hit.group, icon: hit.icon, order: CATALOG.indexOf(hit) };
  return { id, label: humanize(id), group: "Other", icon: FALLBACK_ICON, order: CATALOG.length };
}

/** Every panel: the ids of `panel-body`'s children, in layout order. */
export function panelIds(root) {
  const body = findNode(root, BODY);
  if (!body || body.type !== "stack") return [];
  return (body.children ?? []).map((c) => c?.id).filter((id) => typeof id === "string");
}

/** The panels in their groups, groups in GROUPS order, catalog order inside a group. Empty groups
 *  are left out. */
export function groupPanels(root) {
  const body = findNode(root, BODY);
  const children = (body?.children ?? []).filter((c) => typeof c?.id === "string");
  // Array.prototype.sort is stable: unknown children keep their layout order.
  const items = children.map(describe);
  return GROUPS.map((group) => ({
    group,
    items: items.filter((d) => d.group === group).sort((a, b) => a.order - b.order),
  })).filter((g) => g.items.length > 0);
}

/** Whether the side panel is on screen: the column and every node above it shown. */
export function panelShown(root) {
  const walk = (n, shown) => {
    if (!n || typeof n !== "object") return null;
    const here = shown && n.hidden !== true;
    if (n.id === PANEL) return here;
    for (const c of n.children ?? []) {
      const r = walk(c, here && (n.type !== "stack" || n.active == null || n.active === c.id));
      if (r !== null) return r;
    }
    return null;
  };
  return walk(root, true) === true;
}

/** The panel on screen now, or null when the side panel is hidden. */
export function openPanel(root) {
  if (!panelShown(root)) return null;
  const body = findNode(root, BODY);
  return body?.active ?? panelIds(root)[0] ?? null;
}

/** The app commands that toggle panel `id`: close it when it is the open one, else show it. */
export function toggleCommands(root, id) {
  if (openPanel(root) === id) return [["layout.hide", { id: PANEL }]];
  return [["layout.select", { stack: BODY, child: id }], ["layout.show", { id: PANEL }]];
}

/** The pinned panels that exist, in catalog order. Anything but an array means the defaults. */
export function normalizePins(value, ids) {
  const have = new Set(ids);
  const list = Array.isArray(value) ? value : DEFAULT_PINS;
  const seen = new Set();
  const out = [];
  for (const id of list) {
    if (typeof id !== "string" || seen.has(id) || !have.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  const order = (id) => {
    const i = CATALOG.findIndex((e) => e.id === id);
    return i < 0 ? CATALOG.length + ids.indexOf(id) : i;
  };
  return out.sort((a, b) => order(a) - order(b));
}

/** Pins with `id` added or removed. Keeps pins the layout lacks now (another layout may have them). */
export function togglePin(value, id) {
  const list = Array.isArray(value) ? value.filter((x) => typeof x === "string") : [...DEFAULT_PINS];
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** The popup's height in px for this many groups and rows, at most `max`: padding and title (44),
 *  a 34 px heading per group (8 top, 4 bottom, label line, gaps), 30 px rows with 1 px gaps, and 12 px to spare. */
export function popupHeight(groups, rows, max = 744) {
  return Math.min(max, 44 + groups * 34 + rows * 31 + 12);
}

/** The tallest the popup may be, in logical px: `cap`, or less when the window is short. `top` is
 *  where the popup starts, `margin` the gap kept below it. An unknown or unusable window height
 *  gives `cap`; a tiny window never goes under `floor`. */
export function popupMaxHeight(windowHeight, top = 0, margin = 12, cap = 780, floor = 160) {
  const h = Number(windowHeight);
  if (!Number.isFinite(h) || h <= 0) return cap;
  return Math.max(floor, Math.min(cap, Math.floor(h - (Number(top) || 0) - margin)));
}
