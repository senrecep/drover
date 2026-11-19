// Where a pointer lands on the simulator screen. Pure.
// touchEdge's bottom band (HOME_BAND 0.93 -> the bottom edge) follows herdr-sim by Robert Soriano
// (MIT, see NOTICE).

/** A point inside the panel's preview box -> the 0..1 ratio on the drawn image, or null when it
 *  falls outside it. `fit` is { x, y, width, height } of the image inside the box. */
export function toRatio(local, fit) {
  if (!local || !fit || !(fit.width > 0) || !(fit.height > 0)) return null;
  const x = (Number(local.x) - (fit.x ?? 0)) / fit.width;
  const y = (Number(local.y) - (fit.y ?? 0)) / fit.height;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1 || y > 1) return null;
  return { x, y };
}

/** Like toRatio, but pins a point outside the image to its edge (for drags that leave it). */
export function clampRatio(local, fit) {
  if (!local || !fit || !(fit.width > 0) || !(fit.height > 0)) return null;
  const x = (Number(local.x) - (fit.x ?? 0)) / fit.width;
  const y = (Number(local.y) - (fit.y ?? 0)) / fit.height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

/** The pointer in box coordinates: local_position when the host gives it, else position minus
 *  the box's origin (the event's bounds, else `box`: the bounds last seen), else null. */
export function localPoint(ev, box) {
  const lp = ev?.local_position;
  if (lp && Number.isFinite(Number(lp.x)) && Number.isFinite(Number(lp.y))) return { x: Number(lp.x), y: Number(lp.y) };
  const p = ev?.position, o = ev?.bounds?.origin ?? box?.origin;
  if (p && o) return { x: Number(p.x) - Number(o.x), y: Number(p.y) - Number(o.y) };
  return null;
}

/** A press this low on the screen starts at the bottom edge (the home indicator), as herdr-sim's
 *  HOME_BAND does (MIT, see NOTICE). */
export const HOME_BAND = 0.93;
export const EDGE_BOTTOM = 3;
export const touchEdge = (ratio) => (Number(ratio?.y) >= HOME_BAND ? EDGE_BOTTOM : 0);
