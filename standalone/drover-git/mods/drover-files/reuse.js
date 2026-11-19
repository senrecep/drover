// Preview pane reuse for drover-files: a single click shows the file in one preview viewer pane, retargeted in place;
// a double click keeps that pane open. No host imports here: panes, shared state, run, sleep and the clock come in
// through `deps`, so node can test it. herdr cannot change a live pane's props, so a retarget is a shared message
// ("drover-viewer.open") to a slot id this panel made, and the viewer acks it in "drover-viewer.slots".
// Nothing here closes a pane or sends it text, and a path that fails lockReason is never written to shared state.

export const OPEN_KEY = "drover-viewer.open";
export const SLOTS_KEY = "drover-viewer.slots";
export const VIEWER = "drover-viewer";
export const ACK_MS = 1200;
export const ACK_STEP = 80;
export const ACK_POLLS = Math.ceil(ACK_MS / ACK_STEP);
export const SLOT_LEN = 12;
export const OWN_MAX = 64;
const RESULTS = new Set(["ok", "refused", "pinned"]);

// A random slot id: SLOT_LEN base36 characters.
export function newSlot(rand = Math.random) {
  let s = "";
  for (let i = 0; i < SLOT_LEN; i++) {
    const n = Math.floor(Number(rand()) * 36);
    s += (Number.isInteger(n) && n >= 0 && n < 36 ? n : 0).toString(36);
  }
  return s;
}

// The next message seq: strictly above any seq written before, by this copy (`last`) or already in shared (`stored`).
export function nextSeq(last, stored, now) {
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return Math.max(num(now), Math.max(num(last), num(stored)) + 1);
}

// What a click on a file row asks for. A click with no usable event (or a modifier click) opens pinned, as before;
// count 1 previews, count 2 keeps the preview open, anything later does nothing. The modifier is the platform key
// (Cmd on macOS), and on Linux and Windows also Ctrl, the key people use there.
export function routeClick(e, plat = "macos") {
  const n = e && typeof e === "object" ? e.click_count : undefined;
  if (!Number.isInteger(n) || n < 1) return "pinned";
  const m = e.modifiers && typeof e.modifiers === "object" ? e.modifiers : null;
  if (m && (m.platform === true || (plat !== "macos" && m.control === true))) return n === 1 ? "pinned" : "none";
  if (n === 1) return "preview";
  if (n === 2) return "pin";
  return "none";
}

// One slot's entry from "drover-viewer.slots", or null when it is missing or not an object.
export function slotEntry(slots, slot) {
  if (!slots || typeof slots !== "object" || typeof slot !== "string" || !Object.prototype.hasOwnProperty.call(slots, slot)) return null;
  const e = slots[slot];
  return e && typeof e === "object" ? e : null;
}

// The viewer's answer to message `seq`: "ok", "refused", "pinned", "superseded" (it already handled a later one), or null.
export function ackOf(slots, slot, seq) {
  const e = slotEntry(slots, slot);
  if (!e || typeof e.seq !== "number") return null;
  if (e.seq > seq) return "superseded";
  if (e.seq !== seq) return null;
  return RESULTS.has(e.result) ? e.result : null;
}

// Drops slots whose pane is gone. `slots` is a Map of slot id to pane id; returns the dropped slot ids.
export function pruneSlots(slots, livePanes) {
  const live = new Set((livePanes ?? []).map((p) => p && p.pane));
  const dropped = [];
  for (const [slot, pane] of [...slots]) if (!live.has(pane)) { slots.delete(slot); dropped.push(slot); }
  return dropped;
}

// A slot this panel can still retarget: its pane is a live drover-viewer in `tab`, and the viewer has not said it is
// kept open or holds edits. The newest such slot wins. Slots that are no longer previews are removed from `cands`.
export function pickSlot({ own, cands, livePanes, tab, slots }) {
  if (!tab) return null;
  const list = [...cands].reverse();
  for (const slot of list) {
    const pane = own.get(slot);
    const p = (livePanes ?? []).find((x) => x && x.pane === pane);
    if (!pane || !p) { cands.delete(slot); continue; }
    const e = slotEntry(slots, slot);
    if (e && (e.preview === false || e.dirty === true)) { cands.delete(slot); continue; }
    if (p.mod !== VIEWER || p.tab !== tab) continue;
    return { slot, pane };
  }
  return null;
}

export class PreviewReuse {
  // deps: panes(), focusedTab(), get(key), set(key, value), run(name, args), now(), rand(), lockReason(...paths),
  // split(props, sleep) -> {pane, how}.
  constructor(deps) {
    this.d = deps;
    this.own = new Map();     // slot -> pane, every slot this panel made (capped)
    this.cands = new Set();   // slots still treated as previews
    this.onOf = new Map();    // slot -> the machine its pane reads from (null: this computer)
    this.lastSeq = 0;
    this.ticket = 0;
    this.last = null;         // the latest single click: {ticket, abs, state: "pending" | "done" | "skipped", slot, pin}
    this.chain = Promise.resolve();
  }

  live() { const p = this.d.panes(); return Array.isArray(p) ? p : []; }
  slotOfPane(pane) { if (!pane) return null; for (const [slot, p] of this.own) if (p === pane) return slot; return null; }

  // True when `pane` is one of this panel's live preview panes (a pinned open must not land there).
  isPreviewPane(pane) {
    const slot = this.slotOfPane(pane);
    if (!slot || !this.cands.has(slot)) return false;
    if (!this.live().some((p) => p && p.pane === pane)) return false;
    return slotEntry(this.d.get(SLOTS_KEY), slot)?.preview !== false;
  }

  // Before a pinned open of `abs`: drops opened[abs] when that pane is a live preview (the next click would retarget
  // it) or a slot pane whose viewer reports another file (it was retargeted since, so focusing it would show the
  // wrong file). A slot entry with no string path (the viewer refused that file) also counts as another file.
  // Returns true when it dropped the entry.
  dropForPinned(opened, abs) {
    const pane = opened.get(abs);
    if (!pane) return false;
    let stale = this.isPreviewPane(pane);
    const slot = this.slotOfPane(pane);
    if (!stale && slot) {
      const e = slotEntry(this.d.get(SLOTS_KEY), slot);
      if (e && e.path !== abs) stale = true;
    }
    if (stale) opened.delete(abs);
    return stale;
  }

  remember(slot, pane, on) {
    this.own.set(slot, pane); this.cands.add(slot); this.onOf.set(slot, on || null);
    while (this.own.size > OWN_MAX) { const first = this.own.keys().next().value; this.forgetSlot(first); }
  }

  forgetSlot(slot) { this.own.delete(slot); this.cands.delete(slot); this.onOf.delete(slot); }

  prune() { for (const slot of pruneSlots(this.own, this.live())) this.forgetSlot(slot); }

  seq() {
    const stored = this.d.get(OPEN_KEY);
    const s = nextSeq(this.lastSeq, stored && typeof stored === "object" ? stored.seq : 0, this.d.now());
    this.lastSeq = s;
    return s;
  }

  // Runs `op` after every earlier one, so two messages never race for the one shared key.
  serial(op) {
    const run = this.chain.then(op);
    this.chain = run.catch(() => {});
    return run;
  }

  // A single click on a file: returns a ticket for preview() or cancel().
  begin(abs) {
    const ticket = ++this.ticket;
    this.last = { ticket, abs, state: "pending", slot: null, pin: false };
    return ticket;
  }

  // The click's checks failed (locked, gone, no viewer): nothing to keep open later.
  cancel(ticket) { if (this.last && this.last.ticket === ticket) this.last.state = "skipped"; }

  async waitAck(slot, seq, sleep) {
    const pane = this.own.get(slot);
    for (let i = 0; i < ACK_POLLS; i++) {
      await sleep(ACK_STEP);
      const r = ackOf(this.d.get(SLOTS_KEY), slot, seq);
      if (r) return r;
      if (!this.live().some((p) => p && p.pane === pane)) return null;
    }
    return null;
  }

  // Shows `abs` in this panel's preview pane: focus a pane that already shows it, else retarget the live preview slot
  // in the focused tab (acked), else split a new preview pane. `real` is the checked real path.
  preview(ticket, { abs, real, on, opened, sleep }) {
    return this.serial(async () => {
      const last = this.last && this.last.ticket === ticket ? this.last : null;
      let r;
      try { r = await this.show(ticket, { abs, real, on, opened, sleep }); }
      catch (e) { if (last) last.state = "skipped"; throw e; }
      if (!last) return r;
      last.state = r.how === "superseded" || r.how === "denied" ? "skipped" : "done";
      last.slot = r.slot ?? null;
      if (last.pin && last.slot) { last.pin = false; r.pinned = await this.pinNow(last.slot, sleep); }
      return r;
    });
  }

  async show(ticket, { abs, real, on, opened, sleep }) {
    if (ticket !== this.ticket) return { how: "superseded", pane: null, slot: null };
    if (typeof abs !== "string" || !abs || this.d.lockReason(abs) || (real && this.d.lockReason(real))) return { how: "denied", pane: null, slot: null };
    this.prune();
    const panes = this.live(), isLive = (pane) => panes.some((p) => p && p.pane === pane);
    for (const [p, pane] of [...opened]) if (!isLive(pane)) opened.delete(p);
    const known = opened.get(abs);
    if (known && isLive(known)) {
      const slot = this.slotOfPane(known);
      const shown = slot ? slotEntry(this.d.get(SLOTS_KEY), slot)?.path : abs;
      // A slot pane that was retargeted since: its entry says it shows another file now.
      if (typeof shown === "string" && shown !== abs) opened.delete(abs);
      else {
        this.d.run("pane.focus", { pane: known });
        return { how: "focused", pane: known, slot: slot && this.cands.has(slot) ? slot : null };
      }
    } else if (known) opened.delete(abs);

    const pick = pickSlot({ own: this.own, cands: this.cands, livePanes: panes, tab: this.d.focusedTab(), slots: this.d.get(SLOTS_KEY) });
    if (pick) {
      const seq = this.seq();
      this.d.set(OPEN_KEY, { slot: pick.slot, path: abs, on: on || null, line: null, seq, at: this.d.now(), pin: false });
      const ack = await this.waitAck(pick.slot, seq, sleep);
      if (ack === "ok") {
        for (const [p, pane] of [...opened]) if (pane === pick.pane) opened.delete(p);
        opened.set(abs, pick.pane);
        this.onOf.set(pick.slot, on || null);
        this.d.run("pane.focus", { pane: pick.pane });
        return { how: "retarget", pane: pick.pane, slot: pick.slot };
      }
      if (ack === "superseded") return { how: "superseded", pane: null, slot: null };
      // No answer: take the message back before the new pane, so a viewer that reads it late cannot also show abs.
      if (ack === null) this.withdraw(pick.slot, seq, abs);
      // Refused (it holds edits, or it is kept open now), or no answer: never send to it again; a new pane instead.
      this.cands.delete(pick.slot);
    }

    let slot = newSlot(this.d.rand);
    for (let i = 0; i < 4 && this.own.has(slot); i++) slot = newSlot(this.d.rand);
    if (this.own.has(slot)) return { how: "unknown", pane: null, slot: null };
    const props = { path: abs, file: abs, slot, preview: true };
    if (on) props.on = on;
    const made = await this.d.split(props, sleep);
    if (!made || !made.pane) return { how: made?.how ?? "unknown", pane: null, slot: null };
    this.remember(slot, made.pane, on);
    opened.set(abs, made.pane);
    return { how: made.how, pane: made.pane, slot };
  }

  // Replaces our unanswered message to `slot` with a newer one that no viewer acts on: it names a fresh slot id that
  // no pane holds, so every viewer drops it on the slot test, and the old slot never sees its message again. Only
  // when the key still holds our message: another panel's newer click is left alone. `path` is the same checked path.
  // A viewer that read the message before this write can still answer late; the viewer's 1500 ms age limit and the
  // dropped slot (never retargeted again) bound that case. Returns true when it wrote.
  withdraw(slot, seq, abs) {
    const cur = this.d.get(OPEN_KEY);
    if (!cur || typeof cur !== "object" || cur.slot !== slot || cur.seq !== seq) return false;
    let none = newSlot(this.d.rand);
    for (let i = 0; i < 4 && (this.own.has(none) || none === slot); i++) none = newSlot(this.d.rand);
    if (this.own.has(none) || none === slot) return false;
    this.d.set(OPEN_KEY, { slot: none, path: abs, on: null, line: null, seq: this.seq(), at: this.d.now(), pin: false });
    return true;
  }

  // Asks a preview slot to stay open. The slot stops being a preview here at once, acked or not, so a later click
  // never retargets a pane the user asked to keep. Only slots this panel made are ever messaged.
  async pinNow(slot, sleep) {
    if (!this.own.has(slot)) return null;
    this.cands.delete(slot);
    const seq = this.seq();
    this.d.set(OPEN_KEY, { slot, on: this.onOf.get(slot) ?? null, line: null, seq, at: this.d.now(), pin: true });
    return this.waitAck(slot, seq, sleep);
  }

  // The second click of a double click on `abs`: keep its preview pane open.
  pinClick(abs, opened, sleep) {
    const last = this.last;
    if (last && last.abs === abs && last.state === "pending") { last.pin = true; return Promise.resolve(null); }
    let slot = last && last.abs === abs && last.state === "done" ? last.slot : null;
    if (!slot) {
      const pane = opened.get(abs), s = this.slotOfPane(pane);
      if (s && this.isPreviewPane(pane)) slot = s;
    }
    if (!slot || !this.cands.has(slot)) return Promise.resolve(null);
    return this.serial(() => this.pinNow(slot, sleep));
  }
}
