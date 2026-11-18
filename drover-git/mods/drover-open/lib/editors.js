// Editors the chooser can open a folder or file in, and which of them are installed.
// Pure except detect(), which takes the stat function so tests can fake it. macOS only.

// { id, name }: name is the app bundle's name without ".app" (what `open -a` takes).
export const EDITORS = Object.freeze([
  { id: "vscode", name: "Visual Studio Code" },
  { id: "cursor", name: "Cursor" },
  { id: "zed", name: "Zed" },
  { id: "windsurf", name: "Windsurf" },
  { id: "sublime", name: "Sublime Text" },
  { id: "nova", name: "Nova" },
  { id: "bbedit", name: "BBEdit" },
  { id: "idea", name: "IntelliJ IDEA" },
  { id: "ideace", name: "IntelliJ IDEA CE" },
  { id: "webstorm", name: "WebStorm" },
  { id: "pycharm", name: "PyCharm" },
  { id: "goland", name: "GoLand" },
  { id: "rider", name: "Rider" },
  { id: "androidstudio", name: "Android Studio" },
  { id: "xcode", name: "Xcode" },
  { id: "fleet", name: "Fleet" },
  { id: "vscodium", name: "VSCodium" },
].map((e) => Object.freeze(e)));

/** Shared key holding the last chosen editor's app name. */
export const EDITOR_KEY = "drover-open.editor";
/** How long a detection result is reused, in ms. */
export const EDITOR_TTL = 10 * 60 * 1000;
/** Action id prefix of an editor row. */
export const EDITOR_PREFIX = "editor-";

export const editorById = (id) => EDITORS.find((e) => e.id === id) || null;
export const editorByName = (name) => EDITORS.find((e) => e.name === name) || null;
export const isEditorAction = (id) => typeof id === "string" && id.startsWith(EDITOR_PREFIX) && Boolean(editorById(id.slice(EDITOR_PREFIX.length)));
export const editorOfAction = (id) => (isEditorAction(id) ? editorById(id.slice(EDITOR_PREFIX.length)) : null);

// Where apps live: the system folder, then the person's own.
export function editorRoots(home) {
  const h = String(home || "").replace(/\/+$/, "");
  return h.startsWith("/") ? ["/Applications", `${h}/Applications`] : ["/Applications"];
}
export const appPaths = (name, home) => editorRoots(home).map((r) => `${r}/${name}.app`);

// -> [{ id, name }] of installed editors, table order. `isDir(path)` resolves true for a folder.
export async function detect(isDir, home, platform) {
  if (platform !== "macos") return [];
  const out = [];
  for (const e of EDITORS) {
    for (const p of appPaths(e.name, home)) {
      let hit = false;
      try { hit = Boolean(await isDir(p)); } catch (err) { hit = false; }
      if (hit) { out.push(e); break; }
    }
  }
  return out;
}

// Mods may only stat paths inside home, so /Applications is probed by listing it instead.
// listingProbe(list) returns an isDir-style probe for detect(): it lists each parent folder once
// (list(dir) -> Set of entry names; a failure counts as empty) and answers by membership.
export function listingProbe(list) {
  const dirs = new Map();
  return async (p) => {
    const s = String(p ?? ""), i = s.lastIndexOf("/");
    if (i <= 0 || i === s.length - 1) return false;
    const dir = s.slice(0, i), name = s.slice(i + 1);
    if (!dirs.has(dir)) dirs.set(dir, Promise.resolve().then(() => list(dir)).then((x) => (x instanceof Set ? x : new Set())).catch(() => new Set()));
    return (await dirs.get(dir)).has(name);
  };
}

/** Entry names from `ls -1` output. */
export const lsEntries = (stdout) => new Set(String(stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean));

// A detection cache with a time to live: get(now, load) reuses the last list while it is fresh,
// and shares one load between callers that ask while it runs.
export function editorCache(ttl = EDITOR_TTL) {
  let at = -Infinity, list = null, pending = null;
  return {
    peek: (now) => (list && now - at < ttl ? list : null),
    async get(now, load) {
      if (list && now - at < ttl) return list;
      if (!pending) pending = (async () => {
        try { list = await load(); at = now; } catch (e) { list = list || []; at = now; }
        pending = null;
        return list;
      })();
      return pending;
    },
  };
}

// argv that opens an absolute local path in an editor: no shell, the path is never a flag.
export function editorOpenArgv(name, path) {
  if (!editorByName(name)) throw new Error("unknown editor");
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) throw new Error("not an absolute path");
  return ["open", ["-a", name, path]];
}
