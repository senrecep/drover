// Host actions for drover-files: listing, opening, creating, renaming, trashing. argv arrays only.
import { exec, readTextFile, writeTextFile, appHome, window, panes, run } from "herdr";
import { LIST_SCRIPT, INDEX_SCRIPT, MOD, parseListing, parseIndex, nameProblem, launchRisk, lockReason, safeJoin, parent, basename, isInside } from "./model.js";
import { ignoreArgv, ignoredFromResult, IGNORE_MAX_NAMES } from "./lib/ignored.js";

export const platform = () => window()?.platform ?? "macos";
const TRASH = "/usr/bin/trash";   // macOS 15+ ships it (man trash): Finder's Trash, Put Back works.

export async function listFolder(path, on) {
  const windowsDirectory = async () => {
    // From the shipped files mod: Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target. Curly quotes are doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return (Array.isArray(result) ? result : [result]).filter(e => e && typeof e.name === "string").map(e => ({ name: e.name, dir: Boolean(e.dir) }));
  };
  if (!on && platform() === "windows") return windowsDirectory();
  let r;
  try { r = await exec("sh", ["-c", LIST_SCRIPT, MOD, path], { on, timeout: 15000 }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot list this folder");
  return parseListing(r.stdout);
}

export async function buildIndex(root, on, showNoise) {
  const r = await exec("sh", ["-c", INDEX_SCRIPT, MOD, root, showNoise ? "0" : "1"], { on, timeout: 8000 });
  if (r.code !== 0) throw new Error("Cannot search this folder");
  return parseIndex(r.stdout, showNoise);
}

// Git status marks for the tree, as the shipped files mod draws them. Writes nothing under .git.
export async function gitMarks(cwd, on, limit) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
  const marks = {};
  if (top?.code !== 0) return marks;
  const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
  if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, limit)) {
    const xy = entry.slice(0, 2);
    marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
  }
  return marks;
}

// Which of a listed folder's names git ignores: one check-ignore call, run in that folder. Never throws.
// None ignored or too many names: an empty set. No git, not a repo, a timeout: null (keep what was known).
export async function ignoredIn(dir, names, on) {
  if (!names.length || names.length > IGNORE_MAX_NAMES) return new Set();
  const r = await exec("git", ignoreArgv(names), { cwd: dir, on, timeout: 4000 }).catch(() => null);
  return ignoredFromResult(r);
}

const test = async (flag, path, on) => (await exec("test", [flag, path], { on }).catch(() => ({ code: 2 }))).code === 0;
export const exists = (path, on) => test("-e", path, on);
export const isDir = (path, on) => test("-d", path, on);

// What a path really is: realpath when the system has it, else the path itself. Null when it's gone.
export async function realPath(path, on) {
  const r = await exec("realpath", [path], { on }).catch(() => null);
  if (r?.code === 0 && r.stdout.trim()) return r.stdout.trim();
  return (await exists(path, on)) ? path : null;
}

// Refuses credential files, and paths whose real target is one (a symlink to ~/.ssh/id_rsa).
export async function openCheck(abs, on) {
  const lexical = lockReason(abs);
  if (lexical) return { ok: false, why: `Locked: ${lexical}` };
  const real = await realPath(abs, on);
  if (!real) return { ok: false, why: "It is no longer there" };
  const resolved = lockReason(real);
  if (resolved) return { ok: false, why: `Locked: points to a ${resolved}` };
  return { ok: true, real };
}

let viewerSeen = { at: 0, ok: false };
export async function viewerInstalled(now) {
  if (now - viewerSeen.at < 15000) return viewerSeen.ok;
  const text = await readTextFile(`${appHome()}/mods/drover-viewer/main.js`).catch(() => null);
  viewerSeen = { at: now, ok: text !== null };
  return viewerSeen.ok;
}

// Opens a file in drover-viewer beside the focused pane; a file already open from here gets focus instead.
// Returns the viewer's pane id when it can tell, else null.
// `sleep(ms)` comes from the caller's async context. Commands apply on the app's next turn, so new panes are polled for.
export async function openInViewer(abs, on, opened, sleep) {
  const known = opened.get(abs);
  if (known && panes().some(p => p.pane === known)) { run("pane.focus", { pane: known }); return { pane: known, how: "focused" }; }
  if (known) opened.delete(abs);
  const before = new Set(panes().map(p => p.pane));
  const props = { path: abs, file: abs };
  if (on) props.on = on;
  const newPane = () => panes().find(p => !before.has(p.pane) && p.mod === "drover-viewer");
  run("pane.split", { direction: "right", mod: "drover-viewer", props });
  for (let i = 0; i < 6; i++) {
    await sleep(80);
    const made = newPane();
    if (made) { opened.set(abs, made.pane); return { pane: made.pane, how: "split" }; }
  }
  // Nothing to split beside (no focused pane in this tab): a tab of its own.
  run("tab.new", { mod: "drover-viewer", props });
  for (let i = 0; i < 6; i++) {
    await sleep(80);
    const made = newPane();
    if (made) { opened.set(abs, made.pane); return { pane: made.pane, how: "tab" }; }
  }
  return { pane: null, how: "unknown" };
}

export async function openSystem(abs, dir, on) {
  if (on) throw new Error("Only on this computer");
  // Locked folders and files (and links whose real target is locked) are refused, folders included.
  const check = await openCheck(abs, null);
  if (!check.ok) throw new Error(check.why);
  const real = check.real;
  const executable = dir ? false : await test("-x", real, null);
  const risk = launchRisk(abs, { dir, executable }) || launchRisk(real, { dir, executable });
  if (risk) throw new Error(`Not opened: ${risk}. Use ${platform() === "macos" ? "Reveal in Finder" : "Show in file manager"} instead.`);
  const r = platform() === "macos" ? await exec("open", ["--", abs]) : await exec("xdg-open", [abs]);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || "The system could not open it");
}

export async function reveal(abs, dir, on) {
  if (on) throw new Error("Only on this computer");
  const r = platform() === "macos" ? await exec("open", ["-R", "--", abs]) : await exec("xdg-open", [dir ? abs : parent(abs)]);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || "Could not show it");
}

// "present" | "absent" (no such command here) - only macOS ships a documented trash command.
export async function trashAvailable(on) {
  if (on || platform() !== "macos") return "absent";
  return (await test("-x", TRASH, null)) ? "present" : "absent";
}

export async function moveToTrash(abs, root, on) {
  if (on) throw new Error("Only on this computer");
  if (!isInside(root, abs) || abs === root) throw new Error("Only things inside the shown folder");
  if (!(await exists(abs, null))) throw new Error("It is no longer there");
  const r = await exec(TRASH, ["-s", abs]);
  if (r.code !== 0 || (await exists(abs, null))) throw new Error(r.stderr.trim().split("\n")[0] || "Could not move it to the Trash");
}

export async function newFile(folder, name, on) {
  if (on) throw new Error("Only on this computer");
  const bad = nameProblem(name); if (bad) throw new Error(bad);
  const target = safeJoin(folder, name); if (!target) throw new Error("Not a valid name");
  if (await exists(target, null)) throw new Error(`${name} already exists`);
  // expected = null: creates only; an existing file is refused, never replaced.
  await writeTextFile(target, "", null);
  return target;
}

export async function newFolder(folder, name, on) {
  if (on) throw new Error("Only on this computer");
  const bad = nameProblem(name); if (bad) throw new Error(bad);
  const target = safeJoin(folder, name); if (!target) throw new Error("Not a valid name");
  if (await exists(target, null)) throw new Error(`${name} already exists`);
  const r = await exec("mkdir", ["--", target]);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || "Could not make the folder");
  return target;
}

// Renames inside the same folder. A taken name: a folder is never replaced; a file only with overwrite (the second click).
// -> {done: target} or {confirm: target} (asks for the second click)
export async function renameEntry(abs, name, overwrite, on) {
  if (on) throw new Error("Only on this computer");
  const bad = nameProblem(name); if (bad) throw new Error(bad);
  const target = safeJoin(parent(abs), name); if (!target) throw new Error("Not a valid name");
  if (target === abs) return { done: abs };
  if (!(await exists(abs, null))) throw new Error(`${basename(abs)} is no longer there`);
  const srcDir = await isDir(abs, null);
  // Case-only rename on a case-insensitive disk: the "target" is the source itself.
  const sameFile = target.toLowerCase() === abs.toLowerCase() && (await realPath(target, null)) === (await realPath(abs, null));
  if (sameFile) {
    // Only the letter case changes: the "existing" target is the source itself, so a plain mv is safe here.
    const r = await exec("mv", ["--", abs, target]);
    if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || "Could not rename it");
  } else if (await exists(target, null)) {
    if (await isDir(target, null)) throw new Error(`A folder named ${name} is already there`);
    if (srcDir) throw new Error(`A file named ${name} is already there`);
    if (!overwrite) return { confirm: target };
    const r = await exec("mv", ["--", abs, target]);
    if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || "Could not rename it");
  } else {
    // -n: never replaces what appeared in the meantime; its exit code differs between systems, so check the result.
    const r = await exec("mv", ["-n", "--", abs, target]);
    if (r.code !== 0 && !(await exists(target, null))) throw new Error(r.stderr.trim().split("\n")[0] || "Could not rename it");
  }
  if (!sameFile && (await exists(abs, null))) throw new Error(`${name} appeared before the rename; nothing was changed`);
  return { done: target };
}
