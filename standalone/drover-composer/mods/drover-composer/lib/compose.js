// What the composer sends and to whom. Pure: no Herdr or gpui imports.
//
// A target is a terminal: every agent, plus the terminal that had the keyboard when the composer
// opened (often a shell, which is no agent). Blocked agents are never typed into: their prompt is
// a question (a permission dialog), and a pasted message would answer it.

/** The ways to pick targets, in the order the composer shows them. */
export const MODES = Object.freeze([
  { id: "focused", label: "Focused" },
  { id: "idle", label: "Idle agents" },
  { id: "all", label: "All agents" },
  { id: "pick", label: "Pick" },
]);
export const modeOf = (id) => MODES.find((m) => m.id === id) ?? MODES[0];

const where = (a) => [a?.space_name, a?.tab_name].filter(Boolean).join(" › ");

/**
 * Every terminal the composer can send to: agents in the host's order, then the opening
 * terminal when it is not an agent. `opened`: the terminal address focused at open time.
 */
export function candidates({ agents = [], panes = [], opened = null } = {}) {
  const list = (Array.isArray(agents) ? agents : []).filter((a) => a?.address).map((a) => ({
    address: a.address,
    name: a.program?.name || a.app || "Agent",
    where: where(a),
    status: a.status ?? null,
    agent: true,
    opened: a.address === opened,
  }));
  if (opened && !list.some((c) => c.address === opened)) {
    const p = (Array.isArray(panes) ? panes : []).find((x) => x?.terminal === opened);
    list.unshift({
      address: opened,
      name: p?.program?.name || "Terminal",
      where: "",
      status: p?.status ?? null,
      agent: false,
      opened: true,
    });
  }
  return list;
}

/** The candidates a mode selects. `picked`: addresses chosen by hand (mode "pick"). */
export function targetsFor(mode, list, picked = new Set()) {
  const all = Array.isArray(list) ? list : [];
  switch (mode) {
    case "all": return all.filter((c) => c.agent);
    case "idle": return all.filter((c) => c.agent && (c.status === "idle" || c.status === "done"));
    case "pick": return all.filter((c) => picked.has(c.address));
    default: return all.filter((c) => c.opened);
  }
}

/** Splits targets into those a send may type into and those it skips, with why. */
export function split(targets) {
  const send = [], skip = [];
  for (const c of targets ?? []) {
    if (c.status === "blocked") skip.push({ ...c, why: "Needs you: answer it in its pane" });
    else send.push(c);
  }
  return { send, skip };
}

/** Targets that have not had this message yet (a retry after a partial failure skips the rest). */
export const pending = (send, delivered) => (send ?? []).filter((c) => !delivered?.has(c.address));

/** The identity of a target set: a confirm counts only for the set the first click armed. */
export const armKey = (send) => (send ?? []).map((c) => c.address).sort().join("\n");

/** A message worth sending: anything but whitespace. */
export const sendable = (text) => typeof text === "string" && text.trim().length > 0;

/**
 * The `hc` argv for one send. `--` ends hc's options, so a message that starts with "-" stays a
 * message. Never `--force`: that would type into a blocked agent's dialog.
 */
export const sendArgv = (address, text) => ["send", "--", String(address), String(text)];

/** One send's outcome from `hc`'s exit and its JSON error, if any; never echoes the message. */
export function outcome(res) {
  if (res && res.code === 0) {
    const err = parseError(res.stdout);
    return err ? { ok: false, message: err } : { ok: true, message: "Sent" };
  }
  return { ok: false, message: parseError(res?.stdout) || parseError(res?.stderr) || firstLine(res?.stderr) || "Send failed" };
}
function parseError(s) {
  try {
    const j = JSON.parse(String(s ?? "").trim() || "null");
    return typeof j?.error?.message === "string" ? oneLine(j.error.message) : null;
  } catch { return null; }
}
const firstLine = (s) => oneLine(String(s ?? "").split("\n").find((l) => l.trim()) ?? "");
const oneLine = (s) => String(s).replace(/\s+/g, " ").trim().slice(0, 140);

/** The send button's words for n targets. */
export function sendLabel(n, armed = false) {
  if (!n) return "Send";
  const who = n === 1 ? "1 terminal" : `${n} terminals`;
  return armed ? `Confirm: send to ${who}` : n === 1 ? "Send" : `Send to ${who}`;
}

/** More than one target asks twice: the first click arms, a second within the window sends. */
export const needsConfirm = (n) => n > 1;
export const ARM_MS = 5000;

// The send chord: Cmd+Enter on macOS, Ctrl+Enter on Linux and Windows (`platform` there is Super or Win).
export const sendPressed = (mods, platform) => Boolean(platform === "macos" ? mods?.platform : mods?.control);
export const sendHint = (platform) => (platform === "macos" ? "⌘↩" : "Ctrl+Enter");
