// Pure path helpers. Home is always passed in (never hardcoded).
const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
const trimSlash = (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
function tilde(p, home) {
  p = trimSlash(norm(p)); home = home ? trimSlash(norm(home)) : "";
  if (!home || home === "/") return p;
  if (p === home) return "~";
  return p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}
// Resolve "." and ".." lexically. Returns null for relative input that escapes.
function resolve(p) {
  p = norm(p); const abs = p.startsWith("/"); const out = [];
  for (const s of p.split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else if (!abs) return null; continue; }
    out.push(s);
  }
  return (abs ? "/" : "") + out.join("/") || (abs ? "/" : ".");
}
// Join child under root; null if the result leaves root (traversal) or the child has NUL bytes.
function safeJoin(root, ...parts) {
  root = resolve(root);
  if (!root) return null;
  for (const x of parts) if (String(x).includes("\0")) return null;
  const joined = resolve(root + "/" + parts.map(norm).join("/"));
  if (!joined) return null;
  return joined === root || joined.startsWith(root === "/" ? "/" : root + "/") ? joined : null;
}
const parent = (p) => { p = trimSlash(resolve(p) || "/"); const i = p.lastIndexOf("/"); return i <= 0 ? "/" : p.slice(0, i); };
const basename = (p) => trimSlash(norm(p)).split("/").pop();
// Walk from start up to (and including) stop, nearest first. stop defaults to filesystem root.
function walkUp(start, stop) {
  const out = []; let cur = trimSlash(resolve(start) || "/"); const end = stop ? trimSlash(resolve(stop)) : "/";
  for (let i = 0; i < 256; i++) {
    out.push(cur);
    if (cur === end || cur === "/") break;
    cur = parent(cur);
  }
  return out;
}
// First ancestor (inclusive) for which has(dir) is true, e.g. a repo root lookup.
const findUp = (start, has, stop) => walkUp(start, stop).find((d) => has(d)) || null;
const isInside = (root, p) => { const r = resolve(root), c = resolve(p); return !!r && !!c && (c === r || c.startsWith(r === "/" ? "/" : r + "/")); };
export { tilde, resolve, safeJoin, parent, basename, walkUp, findUp, isInside };
