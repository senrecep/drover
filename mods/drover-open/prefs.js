// Remembered choices, one per kind of target: { version: 1, url: { last, always }, file: …, dir: …, text: … }.
// Pure except load/save, which take the host's readTextFile/writeTextFile so check.cjs can fake them.
export const KINDS = ["url", "file", "dir", "text"];
const ID = /^[a-zA-Z]{1,16}$/;

// Tolerant parse: anything unexpected is dropped, a corrupt file reads as empty.
export function parsePrefs(raw) {
  const out = { version: 1 };
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return out;
  for (const k of KINDS) {
    const v = data[k];
    if (!v || typeof v !== "object") continue;
    const last = typeof v.last === "string" && ID.test(v.last) ? v.last : null;
    if (last) out[k] = { last, always: v.always === true };
  }
  return out;
}

export const serializePrefs = (p) => JSON.stringify(p, null, 2) + "\n";

// The prefs after choosing `id` for kind `k`; same object (by value) when nothing changes.
export function withChoice(prefs, k, id, always) {
  if (!KINDS.includes(k) || !ID.test(id || "")) return prefs;
  return { ...prefs, [k]: { last: id, always: always === true } };
}
export function forgetAll() { return { version: 1 }; }
export const samePrefs = (a, b) => serializePrefs(a) === serializePrefs(b);

// -> { prefs, raw } ; raw is the file's text (the CAS snapshot) or null when absent/unreadable.
export async function loadPrefs(read, file) {
  let raw = null;
  try { raw = await read(file); } catch (e) { raw = null; }
  return { prefs: parsePrefs(raw), raw: raw ?? null };
}

// Writes `change(current)` with compare-and-swap; on a stale snapshot re-reads once and retries.
// -> { ok: true, prefs, raw } | { ok: false, error }
export async function savePrefs(read, write, file, raw, change) {
  let snap = raw;
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = parsePrefs(snap);
    const next = change(current);
    if (samePrefs(current, next) && snap != null) return { ok: true, prefs: current, raw: snap };
    const text = serializePrefs(next);
    try {
      await write(file, text, snap);
      return { ok: true, prefs: next, raw: text };
    } catch (e) {
      if (attempt === 1) return { ok: false, error: String(e?.message || e).slice(0, 160) };
      try { snap = await read(file); } catch (e2) { snap = null; }
    }
  }
  return { ok: false, error: "could not save" };
}
