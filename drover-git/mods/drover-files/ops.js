// Host actions for drover-files: listing, opening, creating, renaming, trashing. argv arrays only.
import { exec, readTextFile, writeTextFile, appHome, window, panes, run } from "herdr";
import { LIST_SCRIPT, INDEX_SCRIPT, MOD, parseListing, parseIndex, nameProblem, launchRisk, lockReason, safeJoin, parent, basename, isInside,
  revealLabel, openArgv, revealArgv, trashArgvs, moveArgv, winKindArgv, winMkdirArgv, TRASH_MISSING, SEARCH_NEEDS_SH,
  explorerProblem, recycleProblem, NO_RECYCLE, NO_RECYCLE_MARK, windowsParts, winLinkArgv, WIN_LINK_PLAIN, WIN_LINK_MARK } from "./model.js";
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

const notFound = (e) => String(e).includes("program not found");
// Local Windows: no sh, test, mkdir or mv (PowerShell stands in); remote machines keep their POSIX tools.
const localWindows = (on) => !on && platform() === "windows";

export async function buildIndex(root, on, showNoise) {
  const r = await exec("sh", ["-c", INDEX_SCRIPT, MOD, root, showNoise ? "0" : "1"], { on, timeout: 8000 })
    .catch(e => { throw notFound(e) && localWindows(on) ? new Error(SEARCH_NEEDS_SH) : e; });
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

const test = async (flag, path, on) => {
  if (localWindows(on)) {
    // -x is never true here: launch risk on Windows goes by extension.
    if (flag === "-x") return false;
    const [cmd, args] = winKindArgv(path);
    const r = await exec(cmd, args).catch(() => null), kind = r?.code === 0 ? r.stdout.trim() : "";
    return flag === "-d" ? kind === "d" : kind === "d" || kind === "f";
  }
  return (await exec("test", [flag, path], { on }).catch(() => ({ code: 2 }))).code === 0;
};
export const exists = (path, on) => test("-e", path, on);
export const isDir = (path, on) => test("-d", path, on);

// What a path really is: realpath when the system has it, else the path itself. Null when it's gone.
// Local Windows: the path itself (a realpath from Git for Windows answers in /c/... form).
export async function realPath(path, on) {
  if (localWindows(on)) return (await exists(path, on)) ? path : null;
  const r = await exec("realpath", [path], { on }).catch(() => null);
  if (r?.code === 0 && r.stdout.trim()) return r.stdout.trim();
  return (await exists(path, on)) ? path : null;
}

// Refuses credential files, and paths whose real target is one (a symlink to ~/.ssh/id_rsa). On Windows: see windowsParts.
export async function openCheck(abs, on) {
  // Local Windows opens only a full drive path ("C:/..."); anything else is refused, never passed on as it is.
  if (localWindows(on) && !windowsParts(abs)) return { ok: false, why: "Locked: not a full drive path" };
  const lexical = lockReason(abs);
  if (lexical) return { ok: false, why: `Locked: ${lexical}` };
  let real = await realPath(abs, on);
  if (!real) return { ok: false, why: "It is no longer there" };
  // Local Windows has no realpath, so a link or junction anywhere on the path is refused, and so is a path the check
  // couldn't finish on.
  if (localWindows(on)) {
    const w = windowsParts(real); // the trimmed name is the one checked and opened
    if (!w?.path) return { ok: false, why: w?.error ? `Locked: the path has ${w.error}` : "Locked: not a full drive path" };
    real = w.path;
    const [cmd, args] = winLinkArgv(real);
    const r = await exec(cmd, args, { timeout: 15000 }).catch(() => null);
    const out = r?.code === 0 ? String(r.stdout ?? "").trim() : "";
    if (out === WIN_LINK_MARK) return { ok: false, why: "Locked: goes through a link or junction" };
    if (out !== WIN_LINK_PLAIN) return { ok: false, why: "Locked: couldn't check it for links" };
  }
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
  const plat = platform();
  const risk = launchRisk(abs, { dir, executable, platform: plat }) || launchRisk(real, { dir, executable, platform: plat });
  if (risk) throw new Error(`Not opened: ${risk}. Use ${revealLabel(plat)} instead.`);
  const comma = explorerProblem(plat, abs); if (comma) throw new Error(comma);
  await opener(openArgv(plat, abs), "The system could not open it");
}

export async function reveal(abs, dir, on) {
  if (on) throw new Error("Only on this computer");
  const plat = platform(), comma = explorerProblem(plat, abs);
  if (comma) throw new Error(comma);
  // explorer.exe gets only a full drive path, every part trimmed the way Windows reads it.
  const w = plat === "windows" ? windowsParts(abs) : null;
  if (plat === "windows" && !w?.path) throw new Error(w?.error ? `Not shown: the path has ${w.error}` : "Not shown: the path must be a full drive path");
  await opener(revealArgv(plat, w ? w.path : abs, dir), "Could not show it");
}

// Runs an opener argv. explorer.exe exits 1 even when it worked, so its code means nothing.
async function opener([cmd, args], fallback) {
  const r = await exec(cmd, args).catch(e => { throw cmd === "xdg-open" && notFound(e) ? new Error("Install xdg-utils to open files") : e; });
  if (cmd !== "explorer.exe" && r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || fallback);
}

// "present" | "absent" (no such command here, hidden) | "missing" (Linux without gio or trash-put: shown, with what to install).
// macOS: its own /usr/bin/trash (macOS 15+). Windows: the Recycle Bin through PowerShell, always there.
export async function trashAvailable(on) {
  if (on) return "absent";
  const plat = platform();
  if (plat === "macos") return (await test("-x", TRASH, null)) ? "present" : "absent";
  if (plat === "windows") return "present";
  // Only "program not found" means missing; whatever --version answers, the program is there.
  for (const [cmd] of trashArgvs(plat, "")) if (await exec(cmd, ["--version"]).then(() => true, e => !notFound(e))) return "present";
  return "missing";
}

export async function moveToTrash(abs, root, on) {
  if (on) throw new Error("Only on this computer");
  if (!isInside(root, abs) || abs === root) throw new Error("Only things inside the shown folder");
  const plat = platform(), noBin = recycleProblem(plat, abs);
  if (noBin) throw new Error(noBin);
  if (!(await exists(abs, null))) throw new Error("It is no longer there");
  const tries = trashArgvs(plat, abs);
  let r = null;
  for (const [cmd, args] of tries) {
    r = await exec(cmd, args).catch(e => { if (tries.length > 1 && notFound(e)) return null; throw e; });
    if (r) break;
  }
  if (!r) throw new Error(TRASH_MISSING);
  // Windows refused the drive (network, removable, or unknown): nothing was touched.
  if (plat === "windows" && r.stdout.includes(NO_RECYCLE_MARK)) throw new Error(NO_RECYCLE);
  if (r.code !== 0 || (await exists(abs, null))) throw new Error(r.stderr.trim().split("\n")[0] || "Could not move it to the Trash");
}

export async function newFile(folder, name, on) {
  if (on) throw new Error("Only on this computer");
  const bad = nameProblem(name, platform()); if (bad) throw new Error(bad);
  const target = safeJoin(folder, name); if (!target) throw new Error("Not a valid name");
  if (await exists(target, null)) throw new Error(`${name} already exists`);
  // expected = null: creates only; an existing file is refused, never replaced.
  await writeTextFile(target, "", null);
  return target;
}

export async function newFolder(folder, name, on) {
  if (on) throw new Error("Only on this computer");
  const bad = nameProblem(name, platform()); if (bad) throw new Error(bad);
  const target = safeJoin(folder, name); if (!target) throw new Error("Not a valid name");
  if (await exists(target, null)) throw new Error(`${name} already exists`);
  const [cmd, args] = localWindows(null) ? winMkdirArgv(target) : ["mkdir", ["--", target]];
  const r = await exec(cmd, args);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || "Could not make the folder");
  return target;
}

// Renames inside the same folder. A taken name: a folder is never replaced; a file only with overwrite (the second click).
// -> {done: target} or {confirm: target} (asks for the second click)
export async function renameEntry(abs, name, overwrite, on) {
  if (on) throw new Error("Only on this computer");
  const plat = platform();
  const bad = nameProblem(name, plat); if (bad) throw new Error(bad);
  const target = safeJoin(parent(abs), name); if (!target) throw new Error("Not a valid name");
  if (target === abs) return { done: abs };
  if (!(await exists(abs, null))) throw new Error(`${basename(abs)} is no longer there`);
  const srcDir = await isDir(abs, null);
  // Case-only rename on a case-insensitive disk: the "target" is the source itself.
  // Windows has no realpath to tell, and its disks are case-insensitive: the same name in other letters is the source.
  const sameFile = target.toLowerCase() === abs.toLowerCase() && (plat === "windows" || (await realPath(target, null)) === (await realPath(abs, null)));
  const move = (mode) => { const [cmd, args] = moveArgv(plat, abs, target, mode); return exec(cmd, args); };
  if (sameFile) {
    // Only the letter case changes: the "existing" target is the source itself, so a plain mv is safe here.
    const r = await move("case");
    if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || "Could not rename it");
  } else if (await exists(target, null)) {
    if (await isDir(target, null)) throw new Error(`A folder named ${name} is already there`);
    if (srcDir) throw new Error(`A file named ${name} is already there`);
    if (!overwrite) return { confirm: target };
    const r = await move("replace");
    if (r.code !== 0) throw new Error(r.stderr.trim().split("\n")[0] || "Could not rename it");
  } else {
    // -n: never replaces what appeared in the meantime; its exit code differs between systems, so check the result.
    const r = await move("new");
    if (r.code !== 0 && !(await exists(target, null))) throw new Error(r.stderr.trim().split("\n")[0] || "Could not rename it");
  }
  if (!sameFile && (await exists(abs, null))) throw new Error(`${name} appeared before the rename; nothing was changed`);
  return { done: target };
}
