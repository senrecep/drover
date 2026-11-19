// The frame ring: RING fixed image files per view in the drover-sim-screen mod, rewritten by the
// helper and shown RELOAD_MS after each write, once Herdr has reloaded the file. The ring with a
// delayed reveal, the due-time gate and one slot set per view follow herdr-sim (MIT, see NOTICE).
// Pure: no Herdr calls, so it runs under node:test.

export const SCREEN_MOD = "drover-sim-screen";
export const RING = 12;
export const RELOAD_MS = 200;   // Herdr reloads a changed image under mods/ in ~175 ms
export const FRAME_MS = 33;     // 30 fps
export const AHEAD = RING - 4;  // the helper writes at most this many frames past the last ack
export const LEASE_RECLAIM_MS = 1500;
export const LEASE_STALE_MS = 5000;

export const screenDir = (appHomeDir) => `${appHomeDir}/mods/${SCREEN_MOD}`;
export const slotName = (view, i) => `${view}-${i}.jpg`;
export const slotRel = (view, i) => `mods/${SCREEN_MOD}/${slotName(view, i)}`;
export const tempName = (view, i) => `.w-${view}-${i}`;

/** The view's RING image paths, relative to the app home (what image() takes). */
export const ringPaths = (view) => Array.from({ length: RING }, (_, i) => slotRel(view, i));

/** Which slots to draw, oldest first and the one on top last. A reply's slot is promoted only
 *  after RELOAD_MS, so Herdr has reloaded that file before it is on top. */
export class Ring {
  constructor() {
    this.stack = Array.from({ length: RING }, (_, i) => i);
    this.epoch = null;
    this.seq = 0;           // the newest seq promoted in this epoch
    this.top = null;        // the slot on top, once something was promoted
    this.promoted = 0;      // promotes that changed the top
    this.lastRevealSeq = 0;
  }

  /** Moves `slot` to the top for frame `seq` of `epoch`. A frame older than the top is ignored,
   *  but only within one epoch: a new helper starts counting at 1 again. Returns true when the
   *  top changed. */
  promote(slot, seq, epoch) {
    if (!(Number.isInteger(slot) && slot >= 0 && slot < RING)) return false;
    if (epoch === this.epoch && seq <= this.seq) return false;
    this.epoch = epoch;
    this.seq = seq;
    this.lastRevealSeq = seq;
    const i = this.stack.indexOf(slot);
    if (i >= 0) this.stack.splice(i, 1);
    this.stack.push(slot);
    const changed = this.top !== slot;
    this.top = slot;
    if (changed) this.promoted += 1;
    return changed;
  }
}

/** The helper's write gate, mirrored for tests: `due = max(due, now - frameMs) + frameMs`, so
 *  uneven arrivals still average one frame per frameMs. Returns true when a frame goes out. */
export function dueGate(state, now, frameMs = FRAME_MS) {
  const due = state.due ?? 0;   // the helper starts at 0 too
  if (now < due) return false;
  state.due = Math.max(due, now - frameMs) + frameMs;
  return true;
}

/** The first slot the helper writes for a view new to its epoch: past the one on top. */
export const firstSlot = (top) => (Number.isInteger(top) && top >= 0 && top < RING ? (top + 1) % RING : 0);

/** A new view id `<kind>-<n>` from the process-wide lease map (Map<id, {copyKey, at}>), for a
 *  copy that holds none: its old lease back once that lease has been silent for LEASE_RECLAIM_MS
 *  (a reload of the same block), else the lowest free n. A lease that is still ticking is never
 *  taken, whatever its key; one silent for LEASE_STALE_MS is free. A copy that holds a lease
 *  keeps it with touchLease. */
export function leaseView(map, kind, copyKey, now) {
  const k = kind === "pane" ? "pane" : "panel";
  const free = (e) => !e || now - e.at >= LEASE_STALE_MS;
  for (const [id, e] of map) {
    if (id.startsWith(`${k}-`) && e.copyKey === copyKey && now - e.at >= LEASE_RECLAIM_MS) {
      map.set(id, { copyKey, at: now });
      return id;
    }
  }
  for (let n = 0; ; n++) {
    const id = `${k}-${n}`;
    if (free(map.get(id))) { map.set(id, { copyKey, at: now }); return id; }
  }
}

/** Refreshes a held lease; false when another copy took it (the caller leases again). */
export function touchLease(map, id, copyKey, now) {
  const e = map.get(id);
  if (!e || e.copyKey !== copyKey) return false;
  e.at = now;
  return true;
}

export function freeLease(map, id, copyKey) {
  if (map.get(id)?.copyKey === copyKey) map.delete(id);
}
