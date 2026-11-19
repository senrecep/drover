// Busy-tab close guard: a tab with a working or blocked agent (or sub-agent) closes only on a second
// click or key press within CONFIRM_MS. Pure: the caller passes Herdr's live lists in.
// A copy lives in drover-tabs and drover-terminal-menu (same bytes, a test checks), next to tree.js.
import { descendants, kidStatus, ownStatus } from "./tree.js";

export const CONFIRM_MS = 6000;
// A second press this soon after arming is the same double click, not a yes.
export const ARM_GAP_MS = 400;
const LABEL_MAX = 40;
const BUSY = new Set(["working", "blocked"]);
// Control and bidi characters are removed from names before they are shown.
const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

// A program's display name, safe to show: no control characters, at most 40 characters.
export function cleanLabel(name) {
  const s = String(name ?? "").replace(BAD_CHARS, "").replace(/\s+/g, " ").trim().slice(0, LABEL_MAX).trim();
  return s || "An agent";
}

// The working or blocked agents a tab close would end, sorted by address: [{address, label, word}].
// Reads each terminal pane in the tab and every live sub-agent under it. Never TabInfo.status: it
// reports the most urgent word, and done outranks working. Missing data counts as busy.
export function busyInTab(tabId, panes, agents, terminals) {
  if (!Array.isArray(panes) || !Array.isArray(agents) || !Array.isArray(terminals)) return [{ address: "?", label: "An agent", word: "unknown" }];
  const listed = new Map(agents.map((a) => [a?.address, a?.status]));
  const out = new Map();
  const add = (address, name, word) => { if (address && BUSY.has(word) && !out.has(address)) out.set(address, { address, label: cleanLabel(name), word }); };
  for (const p of panes) {
    if (!p || p.tab !== tabId || !p.terminal) continue;
    const a = agents.find((x) => x?.address === p.terminal);
    const k = terminals.find((x) => x?.address === p.terminal);
    add(p.terminal, a?.program?.name ?? p.program?.name ?? k?.program?.name, ownStatus(a?.status ?? p.status ?? null, p.terminal, terminals));
    for (const kid of descendants(terminals, p.terminal)) add(kid.address, kid.program?.name, kidStatus(kid, listed));
  }
  return [...out.values()].sort((x, y) => (x.address < y.address ? -1 : x.address > y.address ? 1 : 0));
}

// The tab a key or a menu without an id means: the shown tab of the shown space.
export function activeTabId(spaces) {
  if (!Array.isArray(spaces)) return null;
  return spaces.find((s) => s?.active)?.tabs?.find((t) => t?.active)?.id ?? null;
}

const say = (word) => (word === "blocked" ? "needs you" : word);

// The line shown while armed. verb: "Click" or "Press".
export function armedText(busy, lastTab, verb = "Click") {
  const head = `${verb} again to close.`;
  let body;
  if (busy.some((b) => b.word === "unknown")) body = "Agents in this tab could not be checked, so anything running in it will stop.";
  else if (busy.length === 1) body = busy[0].word === "blocked" ? `${busy[0].label} needs you and will stop.` : `${busy[0].label} is working and will stop.`;
  else body = `This ends ${busy.length} agents: ${busy.map((b) => `${b.label} (${say(b.word)})`).join(", ")}.`;
  return `${head} ${body}${lastTab ? " This is the last tab, so the space closes too." : ""}`;
}

// What a close of `tabId` means now: {tab, gone, needsConfirm, lastTab, addresses, key, text}.
// data: {spaces, panes, agents, terminals}, each as Herdr returned it (or null when the call threw).
export function closePlan(tabId, data, verb = "Click") {
  const d = data ?? {};
  const space = Array.isArray(d.spaces) && tabId ? d.spaces.find((s) => (s?.tabs ?? []).some((t) => t?.id === tabId)) : null;
  if (!space) return { tab: tabId ?? null, gone: true, needsConfirm: false, lastTab: false, addresses: [], key: null, text: "" };
  const busy = busyInTab(tabId, d.panes, d.agents, d.terminals);
  const lastTab = (space.tabs ?? []).length === 1;
  const addresses = busy.map((b) => b.address);
  return { tab: tabId, gone: false, needsConfirm: busy.length > 0, lastTab, addresses, key: [tabId, ...addresses].join("|"), text: busy.length ? armedText(busy, lastTab, verb) : "" };
}

// The command for a close. Only a busy tab passes confirmed: an idle last tab still gets Herdr's own question.
export function closeCommand(plan) {
  return ["tab.close", plan.needsConfirm ? { id: plan.tab, confirmed: true } : { id: plan.tab }];
}

// One click or key press. armed: {tab, addresses, text, at, until} or null.
// -> {action: "fire" | "arm" | "ignore" | "disarm", armed, command?}
export function press(armed, plan, now) {
  if (!plan || plan.gone) return { action: "disarm", armed: null };
  const arm = () => ({ action: "arm", armed: { tab: plan.tab, addresses: plan.addresses, text: plan.text, at: now, until: now + CONFIRM_MS } });
  const fire = () => ({ action: "fire", armed: null, command: closeCommand(plan) });
  if (!armed || armed.tab !== plan.tab) return plan.needsConfirm ? arm() : fire();
  if (now - armed.at < ARM_GAP_MS) return { action: "ignore", armed };
  if (now > armed.until) return plan.needsConfirm ? arm() : fire();
  // A new agent since arming: the user has not agreed to end it yet. Ones that finished only shrink the set.
  const agreed = new Set(armed.addresses);
  if (plan.addresses.some((a) => !agreed.has(a))) return arm();
  return fire();
}

// The arm while it holds, else null.
export const liveArm = (armed, now) => (armed && armed.until >= now ? armed : null);
