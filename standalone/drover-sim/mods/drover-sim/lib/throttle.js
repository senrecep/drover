// Input for the helper: one request in flight at a time, moves coalesced and spaced, presses and
// releases never dropped. Plus the pointer gesture and the wheel step that turn GPUI events into
// helper requests. Pure: the clock, the sender and the timer are passed in.
//
// Portions adapted from serve-sim 0.1.49 by Evan Bacon (https://github.com/EvanBacon/serve-sim),
// licensed under the Apache License, Version 2.0 (see LICENSE-APACHE): wheelToScroll sends the
// web wheel sign and a pointer anchor, the shape serve-sim's scroll-as-drag takes. Modified for
// drover-sim.

export const MOVE_GAP = 16;    // the simulator drops drag events closer together than this
export const LINE_PX = 20;      // a wheel "line" in points, for wheels that report lines

const isMove = (item) => item?.route === "touch" && item.body?.phase === "move";
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const isScroll = (item) => item?.route === "scroll";

/** A serial queue of { route, body } requests. `send(item)` returns a promise; `later(ms, fn)`
 *  runs fn after ms (the view's cx.timer.after). */
export class InputQueue {
  constructor({ send, later, now = () => Date.now() }) {
    this.send = send; this.later = later; this.now = now;
    this.items = []; this.busy = false; this.waiting = false; this.lastTouchAt = -Infinity;
  }

  get size() { return this.items.length; }

  push(item) {
    // A newer move replaces a move still waiting at the tail; anything else queues in order.
    const tail = this.items.at(-1);
    if (isMove(item) && isMove(tail)) this.items[this.items.length - 1] = item;
    else if (isScroll(item) && isScroll(tail)) {
      // Wheel steps add up while one waits: the content still moves by the whole amount.
      tail.body = { ...item.body, dx: tail.body.dx + item.body.dx, dy: tail.body.dy + item.body.dy };
    }
    else this.items.push(item);
    this.pump();
  }

  clear() { this.items = []; }

  pump() {
    if (this.busy || this.waiting || !this.items.length) return;
    const item = this.items[0];
    if (isMove(item)) {
      const wait = this.lastTouchAt + MOVE_GAP - this.now();
      if (wait > 0) {
        this.waiting = true;
        this.later(wait, () => { this.waiting = false; this.pump(); });
        return;
      }
    }
    this.items.shift();
    if (item.route === "touch") this.lastTouchAt = this.now();
    this.busy = true;
    Promise.resolve()
      .then(() => this.send(item))
      .catch(() => null)
      .finally(() => { this.busy = false; this.pump(); });
  }
}

const touch = (phase, p) => ({ route: "touch", body: { phase, x: p.x, y: p.y } });

/** A mouse drag on the screen image: down, moves while held, up. Leaving the image releases. */
export class Pointer {
  constructor() { this.held = false; this.last = null; }

  down(ratio) {
    if (!ratio) return null;
    this.held = true; this.last = ratio;
    return touch("down", ratio);
  }

  move(ratio) {
    if (!this.held || !ratio) return null;
    if (this.last && ratio.x === this.last.x && ratio.y === this.last.y) return null;
    this.last = ratio;
    return touch("move", ratio);
  }

  up(ratio) {
    if (!this.held) return null;
    this.held = false;
    const at = ratio ?? this.last;
    this.last = null;
    return at ? touch("up", at) : null;
  }

  /** The pointer left the image while held: release where it last was. */
  leave() { return this.up(null); }
}

/** The wheel delta in points: pixels when given, else lines × LINE_PX. */
export function wheelDelta(ev) {
  const px = ev?.delta, ln = ev?.delta_lines;
  const x = Number(px?.x) || (Number(ln?.x) || 0) * LINE_PX;
  const y = Number(px?.y) || (Number(ln?.y) || 0) * LINE_PX;
  return { x, y };
}

/** A wheel or trackpad event over the screen -> a /scroll body: the scroll amount as a fraction
 *  of the fitted image (`fit`) in the web's wheel sign (positive scrolls down, so the content moves
 *  up), and the pointer's ratio as the anchor. GPUI's delta is the content's move, hence the minus.
 *  The helper turns it into a one-finger drag that follows the content. Null when nothing moved. */
export function wheelToScroll(ev, ratio, fit) {
  if (!fit || !(fit.width > 0) || !(fit.height > 0)) return null;
  const d = wheelDelta(ev);
  const dx = d.x / fit.width, dy = d.y / fit.height;
  if (!dx && !dy) return null;
  const at = ratio ?? { x: 0.5, y: 0.5 };
  return { dx: -dx, dy: -dy, x: clamp01(Number(at.x) || 0), y: clamp01(Number(at.y) || 0) };
}
