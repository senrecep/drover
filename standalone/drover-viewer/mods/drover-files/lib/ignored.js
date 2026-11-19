// Git-ignored entries for the tree: pure logic, no host calls (ops.js runs git, tests import this directly).
// One `git check-ignore` per listed folder, run in that folder with the folder's own names.

// argv for `git` in the listed folder. Writes nothing under .git; names are never parsed as options ("--").
export const ignoreArgv = (names) => ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "check-ignore", "--", ...names];

// More names than this in one folder: no check (the listing itself stops at 500).
export const IGNORE_MAX_NAMES = 600;

const ESC = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

// Git C-quotes a path that holds ", \ or control characters: "a\"b", "x\ny", octal bytes as \303\251.
export function unquote(line) {
  if (line.length < 2 || line[0] !== '"' || line[line.length - 1] !== '"') return line;
  const bytes = [];
  const enc = new TextEncoder();
  for (let i = 1; i < line.length - 1; i++) {
    const c = line[i];
    if (c !== "\\") { bytes.push(...enc.encode(c)); continue; }
    const n = line[i + 1];
    if (/[0-7]/.test(n ?? "") && /^[0-7]{3}$/.test(line.slice(i + 1, i + 4))) { bytes.push(parseInt(line.slice(i + 1, i + 4), 8)); i += 3; continue; }
    if (n in ESC) { bytes.push(ESC[n]); i += 1; continue; }
    bytes.push(92);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// check-ignore stdout -> Set of names (relative to the folder it ran in).
export function parseIgnored(stdout) {
  const out = new Set();
  for (const raw of String(stdout || "").split("\n")) {
    if (!raw) continue;
    const name = unquote(raw).replace(/\/+$/, "");
    if (name && !name.includes("/")) out.add(name);
  }
  return out;
}

// Exit 0: some ignored; 1: none. Anything else (128: not a repo, no git, a timeout): null, "no answer".
export const ignoredFromResult = (r) => r?.code === 0 ? parseIgnored(r.stdout) : r?.code === 1 ? new Set() : null;

const parentOf = (rel) => { const i = rel.lastIndexOf("/"); return i < 0 ? "" : rel.slice(0, i); };
const nameOf = (rel) => rel.slice(rel.lastIndexOf("/") + 1);

// map: Map<folderRel, Set<name>>. A tree path is ignored when it, or a folder above it, is listed as ignored.
export function isIgnored(map, rel) {
  let p = String(rel || "");
  while (p) {
    if (map.get(parentOf(p))?.has(nameOf(p))) return true;
    p = parentOf(p);
  }
  return false;
}

// A folder inside an ignored folder needs no git call: everything in it is ignored.
export const needsCheck = (map, folderRel) => !isIgnored(map, folderRel);

// Drops the cache for a folder and everything under it (closed or gone).
export function forget(map, folderRel) {
  for (const k of [...map.keys()]) if (k === folderRel || (folderRel && k.startsWith(folderRel + "/")) || !folderRel) map.delete(k);
}
