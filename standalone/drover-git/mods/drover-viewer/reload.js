// Pure helpers for live reload and preview pane reuse. No host calls here, so node tests import them directly.
import { parent } from "./lib/paths.js";

export const RELOAD_MS = 250; // debounce after a watch hit
export const RELOAD_LARGE_MS = 1000; // large-file window mode reacts slower
export const RELOAD_GAP_MS = 500; // at most one check per 500 ms
export const POLL_MS = 5000; // fallback and remote poll
export const POLL_SLOW_MS = 30000; // after FAILS_SLOW failures in a row
export const FAILS_SLOW = 3;
export const FAILS_STOP = 10;
export const MISSING_RETRY_MS = 300; // atomic rename saves: look once more before calling a file gone
export const REARM_MS = 1000; // first pause before watching again after a reclaimed watch; doubles up to POLL_MS
export const RELOADED_MS = 2000; // how long the path line says "Reloaded"

export const OPEN_KEY = "drover-viewer.open";
export const SLOTS_KEY = "drover-viewer.slots";
export const STALE_MS = 1500; // an open message older than this is never acted on: drover-files has given up on it
export const ACK_BY_MS = 1100; // an answer after this (from the message's at) comes too late for drover-files' 1200 ms wait
export const SLOTS_MAX = 32;
export const OPEN_CHECK_MS = 300;
export const RESULTS = ["ok", "refused", "pinned"];

export const TEXT = {
  changed: "This file changed on disk. Your edits are still here.",
  changedLarge: "This file changed on disk.",
  gone: "This file was moved or deleted. Your edits are still here.",
  away: "This file now points somewhere drover will not open.",
  reloaded: "Reloaded",
  paused: "Live reload paused for this remote file.",
  retry: "Try again",
  reload: "Reload from disk",
  diff: "Show diff",
  dismiss: "Dismiss",
  preview: "Preview",
  keep: "Keep open",
};

// A buffer the user may still need: never replaced under them.
export const held = (s) => Boolean(s.dirty || s.saving || s.conflict || s.outside || s.offer);

// What a detected change does to the buffer: "none" | "replace" | "rebuild" | "banner" | "missing" | "missing-banner".
export function reloadAction(s = {}) {
  if (s.missing) return held(s) ? "missing-banner" : "missing";
  if (s.same) return "none";
  if (held(s)) return "banner";
  return s.roChanged ? "rebuild" : "replace";
}

// Paths compare with forward slashes and no trailing slash; drive paths ignore case.
function norm(p) {
  let s = String(p ?? "").replace(/\\/g, "/");
  while (s.length > 1 && s.endsWith("/") && !/^[A-Za-z]:\/$/.test(s)) s = s.slice(0, -1);
  return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s;
}

// The folder a file is watched through. A drive root keeps its slash ("C:/").
export function watchDir(real) {
  const d = parent(String(real ?? "").replace(/\\/g, "/"));
  return /^[A-Za-z]:$/.test(d) ? d + "/" : d;
}

// Does a watch batch touch this file? The file itself, or its folder (a folder or root entry means "refresh everything").
export function batchHits(batch, real) {
  if (!Array.isArray(batch) || !real) return false;
  const file = norm(real), dir = norm(watchDir(real));
  return batch.some((p) => { const x = norm(p); return x === file || x === dir; });
}

// Does the batch name the file itself (not just its folder)?
export const batchNames = (batch, real) => Array.isArray(batch) && Boolean(real) && batch.some((p) => norm(p) === norm(real));

// May this viewer take a new file? "pinned" when it is not a preview, "refused" when it holds something or the
// target is not one drover opens, else "ok".
export function acceptRetarget(s = {}) {
  if (s.pinned) return "pinned";
  if (held(s) || s.gone || s.away || s.denied || s.invalid) return "refused";
  return "ok";
}

const isNum = (n) => typeof n === "number" && Number.isFinite(n);
export const validSlot = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s);

// The open message for this slot, cleaned, or null when it is for another slot, already handled, stale or malformed.
export function openMessage(msg, { slot, lastSeq = 0, now = 0 } = {}) {
  if (!validSlot(slot) || !msg || typeof msg !== "object" || Array.isArray(msg)) return null;
  if (msg.slot !== slot || !isNum(msg.seq) || !isNum(msg.at)) return null;
  if (msg.seq <= lastSeq) return null;
  if (now - msg.at > STALE_MS || msg.at - now > STALE_MS) return null;
  const pin = msg.pin === true;
  // A pin may leave the path out (pin the shown file); anything else needs one.
  const path = typeof msg.path === "string" && msg.path ? msg.path : null;
  if (!path && (!pin || (msg.path !== undefined && msg.path !== null))) return null;
  const line = isNum(msg.line) && msg.line >= 1 ? Math.floor(msg.line) : null;
  const on = typeof msg.on === "string" && msg.on ? msg.on : null;
  return { seq: msg.seq, at: msg.at, path, on, line, pin };
}

// What to do with a cleaned message. s: {preview, same, denied, invalid, dirty, saving, conflict, outside, offer, gone, away}.
// -> {result, retarget, pin, gate}. With gate, result is the answer once the gate passes on the target (a failed or late
// gate answers "refused" and changes nothing); without it, result is the answer now. A pin request may name a new file:
// the single shared key holds only the last click, so a fast double click can arrive as one pin message.
const plan = (result, retarget, pin, gate) => ({ result, retarget, pin, gate });
export function planOpen(m, s = {}) {
  // A pin with no path, or naming the shown file, pins what is shown.
  if (m.pin && (!m.path || s.same)) return plan("pinned", false, true, false);
  // A viewer that is no longer a preview takes no other file.
  if (!s.preview) return plan("refused", false, false, false);
  // It holds something the user needs: refuse and keep it open from now on.
  if (held(s)) return plan("refused", false, true, false);
  // The target is not one drover opens, or the shown file is gone or leads elsewhere: refuse, still a preview.
  if (s.invalid || s.denied || s.gone || s.away) return plan("refused", false, false, false);
  if (s.same) return plan("ok", false, false, true);
  return plan("ok", true, Boolean(m.pin), true);
}

// The next pause before a reclaimed watch is armed again: doubles, from REARM_MS up to POLL_MS.
export const nextRearm = (ms) => Math.min(POLL_MS, Math.max(REARM_MS, isNum(ms) ? ms * 2 : REARM_MS));

// Keeps the `max` newest entries by `at`; drops anything that is not a plain entry.
export function pruneSlots(obj, max = SLOTS_MAX) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const rows = Object.entries(obj).filter(([k, v]) => validSlot(k) && v && typeof v === "object" && !Array.isArray(v));
  rows.sort((a, b) => (isNum(b[1].at) ? b[1].at : 0) - (isNum(a[1].at) ? a[1].at : 0));
  return Object.fromEntries(rows.slice(0, Math.max(0, max)));
}

// The slots map with this slot's entry set, capped.
export function withSlot(obj, slot, entry, max = SLOTS_MAX) {
  const base = obj && typeof obj === "object" && !Array.isArray(obj) ? { ...obj } : {};
  if (validSlot(slot)) base[slot] = entry;
  return pruneSlots(base, max);
}

// The entry a viewer starts from, or null. Only a string path is taken; the gate runs on it like on props.
export function slotStart(obj, slot) {
  if (!validSlot(slot) || !obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const e = obj[slot];
  if (!e || typeof e !== "object" || typeof e.path !== "string" || !e.path) return null;
  return { path: e.path, on: typeof e.on === "string" && e.on ? e.on : null, preview: e.preview === true, seq: isNum(e.seq) ? e.seq : 0 };
}

// cksum prints "<crc> <size> <path>": keep crc and size, drop the rest.
export function parseCksum(stdout) {
  const m = /^\s*(\d+)\s+(\d+)/.exec(String(stdout ?? ""));
  return m ? `${m[1]}:${m[2]}` : null;
}

// Delay before the next remote poll, or null to stop.
export function pollDelay(fails) {
  if (fails >= FAILS_STOP) return null;
  return fails >= FAILS_SLOW ? POLL_SLOW_MS : POLL_MS;
}

// Wait before the next check, honoring the debounce and the gap since the last one.
export const checkDelay = (base, lastAt, now) => Math.max(base, isNum(lastAt) ? lastAt + RELOAD_GAP_MS - now : 0);

// Keeps the cursor inside the new text.
export function clampRange(r, length) {
  if (!r || !isNum(r.start) || !isNum(r.end)) return null;
  const c = (n) => Math.max(0, Math.min(length, n));
  return { start: c(r.start), end: c(r.end) };
}
