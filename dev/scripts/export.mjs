#!/usr/bin/env node
// One-way export from the live Herdr config dir into this repo.
// Usage: node dev/scripts/export.mjs [--src <dir>]
//
// Reads the config dir and never writes to it. Writes the root layout (layouts/drover.json,
// keys.json, mods/, themes/) and one folder per standalone mod item under standalone/, then removes
// whatever it no longer writes under those generated paths, then runs dev/scripts/leak-gate.mjs.
// Every mod an item names must resolve to a mod the item ships or one Herdr ships; anything
// else stops the export with file:line before a file is written.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { gate, report } from "./leak-gate.mjs";

export const OWNER = ["sen", "recep"].join("");
export const REPO = "drover";

// "." is the repo root, the layout item. Its mods are the closure of the published layout and keys.
// The standalone items sit under standalone/.
export const ITEMS = [
  { dir: ".", layout: "drover.json", mods: "layout" },
  { dir: "standalone/drover-git", mods: ["drover-git", "drover-viewer", "drover-open", "drover-files"] },
  { dir: "standalone/drover-viewer", mods: ["drover-viewer", "drover-open", "drover-files"] },
  { dir: "standalone/drover-data", mods: ["drover-data"] },
  { dir: "standalone/drover-ports", mods: ["drover-ports"] },
  { dir: "standalone/drover-pulls", mods: ["drover-pulls"] },
  { dir: "standalone/drover-worktrees", mods: ["drover-worktrees"] },
  { dir: "standalone/drover-review", mods: ["drover-review"] },
  { dir: "standalone/drover-overview", mods: ["drover-overview"] },
  { dir: "standalone/drover-composer", mods: ["drover-composer"] },
  { dir: "standalone/drover-dispatch", mods: ["drover-dispatch"] },
  { dir: "standalone/drover-agents", mods: ["drover-agents"] },
  { dir: "standalone/drover-sim", mods: ["drover-sim", "drover-sim-screen"] },
];

// Printed on every run. Never written to the repo as a stub.
export const PENDING = [];

// A nested item's gallery name is its folder with "/" replaced by "--".
export const installLine = (dir) => dir === "."
  ? `Read ~/.config/herdr-app/AGENTS.md, then add this layout: herdr.dev/layouts/${OWNER}/${REPO}`
  : `Read ~/.config/herdr-app/AGENTS.md, then add this mod: herdr.dev/mods/${OWNER}/${REPO}--${dir.split("/").join("--")}`;
export const installLines = () => ITEMS.map((i) => installLine(i.dir));
// The only binary files the repo may carry: each item's preview, its source in dev/docs-src, and the
// layout's copy at layouts/drover.png, plus the README screenshots in dev/docs-src/shots.
const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs-src", "shots");
export const previewPaths = () => [...ITEMS.flatMap((i) => i.dir === "."
  ? ["preview.png", "dev/docs-src/preview.png", "layouts/drover.png"]
  : [`${i.dir}/preview.png`, `dev/docs-src/${i.dir}/preview.png`]),
  ...(fs.existsSync(SHOTS) ? fs.readdirSync(SHOTS).filter((f) => f.endsWith(".png")) : [])
    .map((f) => `dev/docs-src/shots/${f}`)];
// The copyright line of the root LICENSE (hand-written at the repo root; the export never writes it).
export const LICENSE_LINE = `Copyright (c) 2026 ${OWNER}`;

// Local mods that are not ours to publish. The published layout and keys drop them by name.
const DROP = new Set([
  "pr-flow", ["claude", "inspector"].join("-"), "usage-limits", "hibernate", "resources", "desktop-notifications",
  "agent-groups", "over9k-switcher", ["agent", "history"].join("-"),
]);
// Layout block ids renamed in the published copy.
const RENAME_IDS = { [["in", "sights", "-original-tabs"].join("")]: "tab-bar" };
// The panel the drover layout fills: bindings that act on it move to the "layout:drover" section.
const PANEL_NODES = new Set(["panel", "panel-body"]);
// Only the drover layout's own node ids couple a mod to it.
const LAYOUT_ONLY_IDS = ["panel", "panel-body", "sidebar", "sidebar-views", "sidebar-lists"];
// Calls that pass the coupling check because they look the node up first: "<mod>/<file>" -> why.
const GUARDED = new Map();
// Quoted strings that equal a local mod's name but mean something else: "<file in the mod>" -> names.
const LITERAL_OK = new Map([
  ["lib/icon-map.js", new Set(["resources"])], // a folder name in the file icon table
]);

const THEMES = ["catppuccin.json", "atom-one-dark.json"];
const SCRIPTS = ["sync-lib.mjs"];
const LAYOUT_EXTRAS = ["drover.svg"];

const EXCLUDE_DIRS = new Set(["__pycache__", "node_modules", "data", ".state", "bin", "test", "tests"]);
const EXCLUDE_NAMES = new Set(["gpui-kit.d.ts", "herdr.d.ts", "jsconfig.json", ".viewed.json", ".DS_Store"]);
const EXCLUDE_RE = [/^\.cost-cache-/, /\.error$/, /\.bak$/, /\.bak-/, /\.pyc$/, /\.jpe?g$/i, /^\.w-/, /^simd-/, /\.test\.js$/, /^check.*\.cjs$/, /^test_.*\.py$/];
const skip = (name, isDir) =>
  isDir ? EXCLUDE_DIRS.has(name) : EXCLUDE_NAMES.has(name) || EXCLUDE_RE.some((r) => r.test(name));
const SOURCE_EXT = new Set([".js", ".cjs", ".mjs", ".py", ".json"]);

const ROOT_LICENSE_LINE = "MIT License (see the LICENSE file at the repository root)";

class ExportError extends Error {}
const fail = (lines) => { throw new ExportError(Array.isArray(lines) ? lines.join("\n") : lines); };

// ---------- reading the config dir ----------

// The files a mod ships: everything but tests, typings, caches and its own MIT LICENSE.
function modFiles(srcMods, mod) {
  const out = [];
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isSymbolicLink() || skip(e.name, e.isDirectory())) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile() && r !== "LICENSE") out.push(r);
    }
  })(path.join(srcMods, mod), "");
  return out;
}

// The bytes a mod file ships with. drover-sim's NOTICE points at the root LICENSE here, until its
// own source says so.
function modFileBytes(srcMods, mod, rel) {
  const buf = fs.readFileSync(path.join(srcMods, mod, rel));
  if (mod === "drover-sim" && rel === "NOTICE") {
    return Buffer.from(buf.toString("utf8").split("MIT License (see LICENSE)").join(ROOT_LICENSE_LINE));
  }
  if (rel === "README.md") {
    // check.cjs and tests/ are not exported, so a README's "## Tests", "## Check" or "## Development"
    // section, or a bullet naming check.cjs, would point at missing files.
    const text = buf.toString("utf8");
    const cut = text
      .replace(/^## (?:Tests|Check|Development)\n[\s\S]*?(?=^## |(?![\s\S]))/gm, "")
      .replace(/^- `check\.cjs`.*\n/gm, "");
    if (cut !== text) return Buffer.from(cut);
  }
  return buf;
}

// Every mod a mod's shipped source names, with file:line.
function modRefs(ctx, mod) {
  const refs = [];
  const add = (name, kind, file, line) => { if (name !== mod) refs.push({ name, kind, at: `${mod}/${file}:${line}` }); };
  for (const rel of modFiles(ctx.srcMods, mod)) {
    if (!SOURCE_EXT.has(path.extname(rel))) continue;
    const lines = fs.readFileSync(path.join(ctx.srcMods, mod, rel), "utf8").split("\n");
    lines.forEach((text, i) => {
      const n = i + 1;
      for (const m of text.matchAll(/\bmod\s*:\s*["'`]([\w.-]+)["'`]/g)) add(m[1], "mod", rel, n);
      for (const m of text.matchAll(/["'`]mod\.open["'`]\s*,\s*\{\s*name\s*:\s*["'`]([\w.-]+)["'`]/g)) add(m[1], "mod.open", rel, n);
      for (const m of text.matchAll(/["'`]mod\.open:([\w.-]+)["'`]/g)) add(m[1], "mod.open", rel, n);
      for (const m of text.matchAll(/\.mod\s*===?\s*["'`]([\w.-]+)["'`]/g)) add(m[1], ".mod ===", rel, n);
      for (const m of text.matchAll(/\b(?:shared|setShared)\(\s*["'`]([\w-]+)\./g)) if (ctx.U.has(m[1])) add(m[1], "shared", rel, n);
      for (const m of text.matchAll(/\.\.\/([\w.-]+)\//g)) if (ctx.U.has(m[1])) add(m[1], "path", rel, n);
      for (const m of text.matchAll(/\bmods\/([\w.-]+)\//g)) if (ctx.U.has(m[1]) || ctx.S.has(m[1])) add(m[1], "path", rel, n);
      for (const m of text.matchAll(/["'`]([\w.-]+)["'`]/g)) if (ctx.U.has(m[1]) && !LITERAL_OK.get(rel)?.has(m[1])) add(m[1], "literal", rel, n);
      if (/\brun\(\s*["'`]layout\.(select|show|hide|toggle)/.test(text)) {
        const ids = LAYOUT_ONLY_IDS.filter((id) => new RegExp(`["'\`]${id}["'\`]`).test(text));
        refs.push({ name: null, kind: "layout", at: `${mod}/${rel}:${n}`, ids, key: `${mod}/${rel}` });
      }
    });
  }
  return refs;
}

const isDrover = (ctx, name) => ctx.U.has(name) && name.startsWith("drover-");

// Strings a key binding value names: actions and args.
function bindingStrings(v) {
  if (typeof v === "string") return [v];
  if (v && typeof v === "object") return Object.values(v).flatMap(bindingStrings);
  return [];
}

// Mod names a key binding refers to.
function bindingRefs(ctx, v) {
  const out = new Set();
  for (const s of bindingStrings(v)) {
    if (ctx.U.has(s) || ctx.S.has(s)) out.add(s);
    const open = /^mod\.open:(.+)$/.exec(s);
    if (open) out.add(open[1]);
    const cmd = /^([\w-]+)\.[\w-]/.exec(s);
    if (cmd && ctx.U.has(cmd[1])) out.add(cmd[1]);
  }
  return [...out];
}

// The node a layout.* binding acts on, or null.
function bindingNode(v) {
  const command = typeof v === "string" ? v : v?.command;
  if (typeof command !== "string" || !/^layout\.(select|show|hide|toggle)\b/.test(command)) return null;
  const colon = command.indexOf(":");
  if (colon >= 0) return command.slice(colon + 1);
  return v?.args?.stack ?? v?.args?.id ?? null;
}

// ---------- the published layout and keys ----------

function publishLayout(ctx, layout) {
  const removed = [];
  const out = structuredClone(layout);
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.children)) {
      node.children = node.children.filter((c) => {
        const mod = c?.content?.mod;
        if (mod && DROP.has(mod)) { removed.push(`${c.id} (${mod})`); return false; }
        return true;
      });
    }
    if (typeof node.id === "string" && RENAME_IDS[node.id]) node.id = RENAME_IDS[node.id];
    for (const v of Object.values(node)) if (v && typeof v === "object") walk(v);
  })(out);
  if (out.cloned_from && !ctx.S.has(`layout:${out.cloned_from.name}`)) delete out.cloned_from;
  const withPreview = {};
  for (const [k, v] of Object.entries(out)) {
    withPreview[k] = v;
    if (k === "id") withPreview.preview = "layouts/drover.png";
  }
  if (!("preview" in withPreview)) withPreview.preview = "layouts/drover.png";

  // Every mod the published layout names.
  const mods = [];
  const text = JSON.stringify(withPreview, null, 2).split("\n");
  text.forEach((line, i) => {
    const m = /"(?:mod|terminal_menu)":\s*"([\w.-]+)"/.exec(line);
    if (m) mods.push({ name: m[1], at: `layouts/drover.json:${i + 1} (published)` });
  });
  return { layout: withPreview, removed, mods };
}

function publishKeys(ctx, keys) {
  const out = { global: {}, "layout:drover": {} };
  const dropped = [];
  const bad = [];
  for (const [section, binds] of Object.entries(keys)) {
    const mod = /^mod:(.+)$/.exec(section)?.[1];
    if (mod) {
      if (DROP.has(mod)) { dropped.push(`${section} (whole section)`); continue; }
      if (isDrover(ctx, mod)) out[section] = binds;
      continue;
    }
    if (section === "layout:drover") { Object.assign(out[section], binds); continue; }
    if (section !== "global" || !binds || typeof binds !== "object") continue;
    for (const [key, v] of Object.entries(binds)) {
      const refs = bindingRefs(ctx, v);
      if (refs.some((r) => DROP.has(r))) { dropped.push(`global ${key}`); continue; }
      const node = bindingNode(v);
      if (node && PANEL_NODES.has(node)) { out["layout:drover"][key] = v; continue; }
      if (!refs.some((r) => isDrover(ctx, r))) continue; // Herdr's own bindings stay out of the snippet.
      for (const r of refs) if (!isDrover(ctx, r) && !ctx.S.has(r)) bad.push(`keys.json global ${key}: names ${r}, neither a drover mod nor shipped`);
      out.global[key] = v;
    }
  }
  if (bad.length) fail(bad);
  for (const k of Object.keys(out)) if (!Object.keys(out[k]).length) delete out[k];
  return { keys: out, dropped };
}

// The bindings an item of `mods` ships: their global opens and commands, and their own sections.
function itemKeys(ctx, published, mods) {
  const own = new Set(mods);
  const out = {};
  const global = {};
  for (const [key, v] of Object.entries(published.global ?? {})) {
    const refs = bindingRefs(ctx, v);
    if (refs.some((r) => own.has(r)) && refs.every((r) => own.has(r) || ctx.S.has(r)) && !bindingNode(v)) global[key] = v;
  }
  if (Object.keys(global).length) out.global = global;
  for (const m of mods) if (published[`mod:${m}`]) out[`mod:${m}`] = published[`mod:${m}`];
  return Object.keys(out).length ? out : null;
}

// ---------- the resolver ----------

function keyMods(ctx, keys) {
  const found = [];
  for (const [section, binds] of Object.entries(keys)) {
    const mod = /^mod:(.+)$/.exec(section)?.[1];
    if (mod) found.push({ name: mod, at: `keys.json [${section}] (published)` });
    for (const [key, v] of Object.entries(binds)) for (const r of bindingRefs(ctx, v)) found.push({ name: r, at: `keys.json ${section} ${key} (published)` });
  }
  return found;
}

// Checks every reference of every mod in `mods`; returns the lines to print. Fails loudly.
function resolve(ctx, label, mods, { standalone }) {
  const own = new Set(mods);
  const errors = [];
  const between = new Map();
  const shipped = new Set();
  const coupling = [];
  for (const mod of mods) {
    if (!ctx.U.has(mod)) { errors.push(`${label}: ${mod} is not a folder in the config dir's mods`); continue; }
    for (const r of modRefs(ctx, mod)) {
      if (r.kind === "layout") {
        if (!r.ids.length) continue;
        if (standalone && !GUARDED.has(r.key)) errors.push(`${r.at}: layout call on drover node ${r.ids.join(", ")} keeps ${mod} layout-only`);
        else coupling.push(`${r.at} (${r.ids.join(", ")})`);
        continue;
      }
      if (own.has(r.name)) { if (r.kind !== "literal") between.set(`${mod} -> ${r.name}`, r.at); continue; }
      if (ctx.S.has(r.name)) { shipped.add(r.name); continue; }
      errors.push(`${r.at}: ${r.kind} reference to "${r.name}", not shipped by ${label} nor by Herdr`);
    }
  }
  if (errors.length) fail([`resolver failed for ${label}:`, ...errors.map((e) => "  " + e)]);
  const lines = [`${label}: ${mods.length} mod(s): ${mods.join(", ")}`];
  if (between.size) lines.push(`  within: ${[...between].map(([k, at]) => `${k} (${at})`).join("; ")}`);
  if (shipped.size) lines.push(`  shipped by Herdr: ${[...shipped].sort().join(", ")}`);
  if (coupling.length) lines.push(`  layout calls: ${coupling.join("; ")}`);
  return lines;
}

// The root closure: the mods the published layout and keys name, and every drover mod those name.
function layoutClosure(ctx, starts) {
  const set = new Set();
  const queue = [];
  const errors = [];
  for (const s of starts) {
    if (isDrover(ctx, s.name)) { if (!set.has(s.name)) { set.add(s.name); queue.push(s.name); } }
    else if (!ctx.S.has(s.name)) errors.push(`${s.at}: "${s.name}" is neither a drover mod nor shipped`);
  }
  while (queue.length) {
    const mod = queue.shift();
    for (const r of modRefs(ctx, mod)) {
      if (r.kind === "layout" || !r.name || set.has(r.name)) continue;
      if (isDrover(ctx, r.name)) { set.add(r.name); queue.push(r.name); }
    }
  }
  if (errors.length) fail(["resolver failed for the root layout:", ...errors.map((e) => "  " + e)]);
  return [...set].sort();
}

// ---------- writing ----------

function makeWriter(repo) {
  const stats = { written: 0, unchanged: 0, removed: 0, bytes: 0 };
  const written = new Set();
  const write = (rel, buf, mode) => {
    const to = path.join(repo, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(to) && Buffer.compare(fs.readFileSync(to), buf) === 0) stats.unchanged++;
    else { fs.writeFileSync(to, buf, mode ? { mode } : undefined); stats.written++; }
    stats.bytes += buf.length;
    written.add(rel);
  };
  const json = (rel, obj) => write(rel, Buffer.from(JSON.stringify(obj, null, 2) + "\n"));
  // Removes every file under the generated roots that this run did not write.
  const prune = (roots) => {
    const removedFiles = [];
    for (const root of roots) {
      const abs = path.join(repo, root);
      if (!fs.existsSync(abs)) continue;
      if (fs.statSync(abs).isFile()) {
        if (!written.has(root)) { fs.rmSync(abs); stats.removed++; removedFiles.push(root); }
        continue;
      }
      (function walk(dir, rel) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name), r = `${rel}/${e.name}`;
          if (e.isDirectory()) { walk(p, r); if (!fs.readdirSync(p).length) fs.rmdirSync(p); }
          else if (!written.has(r)) { fs.rmSync(p); stats.removed++; removedFiles.push(r); }
        }
      })(abs, root);
      if (!fs.readdirSync(abs).length) fs.rmdirSync(abs);
    }
    return removedFiles;
  };
  return { write, json, prune, stats, written };
}

function copyMod(ctx, w, mod, relDir) {
  for (const rel of modFiles(ctx.srcMods, mod)) {
    const abs = path.join(ctx.srcMods, mod, rel);
    w.write(`${relDir}/${mod}/${rel}`, modFileBytes(ctx.srcMods, mod, rel), fs.statSync(abs).mode & 0o777);
  }
}

// Hand-written gallery text in <repo>/dev/docs-src (README, RECIPEs, previews), laid out like the repo.
// "<name>.src.md" is published as "<name>.md", so the gallery never sees dev/docs-src as an item.
// Install-line markers are filled from OWNER, REPO and the item folder. shots/ stays in dev/docs-src:
// the README links it there.
function copyGallery(repo, w) {
  const gal = path.join(repo, "dev", "docs-src");
  if (!fs.existsSync(gal)) return 0;
  const items = ITEMS.map((i) => i.dir).filter((d) => d !== ".");
  let n = 0;
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      // Dot entries (.DS_Store, hook state such as .omc) are never gallery text.
      if (e.isSymbolicLink() || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (rel || e.name !== "shots") walk(p, rel ? `${rel}/${e.name}` : e.name); continue; }
      const name = e.name.endsWith(".src.md") ? e.name.slice(0, -".src.md".length) + ".md" : e.name;
      const r = rel ? `${rel}/${name}` : name;
      let buf = fs.readFileSync(p);
      if (r.endsWith(".md")) {
        const here = items.find((d) => rel === d || rel.startsWith(d + "/")) ?? ".";
        buf = Buffer.from(buf.toString("utf8").replace(/<!-- install(?::([\w./-]+))? -->[\s\S]*?<!-- \/install -->/g,
          (_m, dir) => `<!-- install${dir ? ":" + dir : ""} -->\n${installLine(dir ?? here)}\n<!-- /install -->`));
      }
      w.write(r, buf);
      if (r === "preview.png") w.write("layouts/drover.png", buf);
      n++;
    }
  })(gal, "");
  return n;
}

// ---------- main ----------

function main() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const args = process.argv.slice(2);
  const si = args.indexOf("--src");
  const src = path.resolve(si >= 0 && args[si + 1] ? args[si + 1] : path.join(os.homedir(), ".config", "herdr-app"));
  if (!fs.existsSync(src)) fail("source not found: " + src);
  const srcMods = path.join(src, "mods");
  // Folder names only: no other mod's files are read unless an item ships it.
  const U = new Set(fs.readdirSync(srcMods, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name));
  const S = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(src, "installed.json"), "utf8"))));
  const ctx = { src, srcMods, U, S };

  // Resolve everything before writing anything.
  const root = ITEMS.find((i) => i.dir === ".");
  const layoutSrc = JSON.parse(fs.readFileSync(path.join(src, "layouts", root.layout), "utf8"));
  const keysSrc = JSON.parse(fs.readFileSync(path.join(src, "keys.json"), "utf8"));
  const pubLayout = publishLayout(ctx, layoutSrc);
  const pubKeys = publishKeys(ctx, keysSrc);
  const rootMods = layoutClosure(ctx, [...pubLayout.mods, ...keyMods(ctx, pubKeys.keys)]);
  const out = [];
  out.push(...resolve(ctx, "root layout", rootMods, { standalone: false }));
  const plans = [];
  for (const item of ITEMS.filter((i) => i.dir !== ".")) {
    out.push(...resolve(ctx, item.dir, item.mods, { standalone: true }));
    plans.push({ item, keys: itemKeys(ctx, pubKeys.keys, item.mods) });
  }

  const w = makeWriter(repo);
  for (const mod of rootMods) copyMod(ctx, w, mod, "mods");
  w.json(`layouts/${root.layout}`, pubLayout.layout);
  w.json("keys.json", pubKeys.keys);
  for (const f of LAYOUT_EXTRAS) { const p = path.join(src, "layouts", f); if (fs.existsSync(p)) w.write(`layouts/${f}`, fs.readFileSync(p)); }
  for (const f of THEMES) { const p = path.join(src, "themes", f); if (fs.existsSync(p)) w.write(`themes/${f}`, fs.readFileSync(p)); }
  for (const f of SCRIPTS) { const p = path.join(src, "scripts", f); if (fs.existsSync(p)) w.write(`dev/scripts/${f}`, fs.readFileSync(p), fs.statSync(p).mode & 0o777); }
  for (const { item, keys } of plans) {
    for (const mod of item.mods) copyMod(ctx, w, mod, `${item.dir}/mods`);
    if (keys) w.json(`${item.dir}/keys.json`, keys);
  }
  const gallery = copyGallery(repo, w);

  // Generated roots only. LICENSE, .gitignore, dev/docs-src and the two scripts in dev/scripts are
  // never pruned. README.md comes from dev/docs-src and is overwritten, never pruned. Root folders
  // that hold mods/ are items from the old flat layout; scripts/ and shots/ are old generated roots.
  const itemDirs = fs.readdirSync(repo, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "dev" && fs.existsSync(path.join(repo, e.name, "mods"))).map((e) => e.name);
  const removed = w.prune([...new Set(["mods", "layouts", "themes", "keys", "keys.json", "RECIPE.md", "dev/scripts/sync-lib.mjs",
    "scripts", "shots", "standalone", ...itemDirs.filter((d) => d !== "mods")])]);

  console.log(`source: ${src}`);
  console.log("resolver:");
  for (const l of out) console.log("  " + l);
  console.log(`published layout: removed ${pubLayout.removed.join(", ") || "nothing"}; ids renamed: ${Object.values(RENAME_IDS).join(", ")}`);
  console.log(`published keys: dropped ${pubKeys.dropped.join(", ") || "nothing"}; ${Object.keys(pubKeys.keys["layout:drover"] ?? {}).length} binding(s) under layout:drover`);
  console.log(`items: root layout + ${plans.length} standalone: ${plans.map((p) => p.item.dir).join(", ")}`);
  console.log(`gallery files: ${gallery}`);
  console.log(`pending: ${PENDING.length ? "" : "nothing"}`);
  for (const p of PENDING) console.log("  " + p);
  console.log(`files: ${w.written.size}  written: ${w.stats.written}  unchanged: ${w.stats.unchanged}  removed: ${w.stats.removed}  bytes: ${w.stats.bytes}`);
  for (const r of removed) console.log("  removed " + r);

  if (!report(gate(repo, installLines(), { LICENSE: [LICENSE_LINE] }, previewPaths()))) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (e) {
    if (e instanceof ExportError) { console.error(e.message); process.exit(1); }
    throw e;
  }
}
