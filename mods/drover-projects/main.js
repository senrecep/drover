// Projects: your machines and the folders you work in, one click from a space, a tab, an agent,
// Git or Files. Works with no space or pane open.
//
// Three kinds of copy (props decide):
// - overlay (mod.open drover-projects, or the dialog the background copy opens): the picker.
//   It only reads the visits file: a dialog's copy and its timers end when it closes.
// - {role: "background"}: a 0 px layout block. Samples where you work and answers the key
//   command drover-projects.open. Draws nothing.
// - a pane (tab.new {mod: "drover-projects"}): the picker in a tab, and it samples too.
//
// Sampling: every 30 s, while the window is active, the focused terminal's folder (its git
// top level) on its machine. Written to data/drover-projects/visits.json once a minute,
// compare-and-swap, merging with what other copies wrote.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import {
  exec, run, props, theme, settings, spaces, machines, focused, window as hostWindow,
  shared, setShared, nextCommand, openOverlay, closeOverlay, appHome, home,
  readTextFile, writeTextFile, knownAgents, pickFolder,
} from "herdr";
import * as fs from "fs/promises";
import { resolveIcon } from "./lib/icons.js";
import * as L from "./logic.js";
import { TYPE, mono, metaColor, panelHeader, sectionLabel, emptyState, button } from "./lib/panel-ui.js";

const MOD = L.MOD;
const SAMPLE_MS = 30 * 1000;
const FLUSH_MS = 60 * 1000;
const RELOAD_MS = 60 * 1000;
const REFRESH_MS = 500;
const TOPLEVEL_TTL = 10 * 60 * 1000;
const SCAN_TTL = 10 * 60 * 1000;
const MAX_FOUND_ROWS = 300;
const MAX_HITS = 200;
const ROW_H = 38;

const DIR = () => `${appHome()}/data/${MOD}`;
const VISITS = () => `${DIR()}/visits.json`;
const SCANS = () => `${DIR()}/scan.json`;
const UI = (name) => `mods/${MOD}/icons/ui-${name}.svg`;

async function ensureDir() {
  try {
    await fs.mkdir(DIR(), { recursive: true });
  } catch {
    // Already there, or the write fails later with its own error.
  }
}

/** Read, change, write against what was read; a few tries when another copy wrote first. */
async function updateFile(path, change, tries = 3) {
  await ensureDir();
  for (let attempt = 0; attempt < tries; attempt++) {
    let raw = null;
    try {
      raw = await readTextFile(path);
    } catch {
      return false;
    }
    try {
      await writeTextFile(path, change(raw), raw);
      return true;
    } catch {
      // Someone else wrote in between: read again and merge.
    }
  }
  return false;
}

const ago = (ms, now) => {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

/** A long path keeps its tail: the last two folders with a leading "…/", never cut in the middle. */
const tailPath = (p, max) => {
  if (p.length <= max) return p;
  const parts = p.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
};

const safe = (fn, fallback) => {
  try {
    return fn() ?? fallback;
  } catch {
    return fallback;
  }
};

export default class Projects extends View {
  init(p, cx) {
    const pr = p ?? safe(() => props(), {}) ?? {};
    this.overlay = pr.overlay ?? null;
    this.role = this.overlay ? "dialog" : pr.role === "background" ? "background" : "pane";
    this.timers = [];
    if (this.role !== "dialog") this.startSampler(cx);
    if (this.role === "background") return this.commandLoop(cx, "open");
    this.initUi(pr, cx);
    if (this.role === "pane") this.commandLoop(cx, "focus");
  }

  async close() {
    for (const t of this.timers) t?.cancel?.();
    this.timers = [];
    if (this.pending && Object.keys(this.pending.entries).length) await this.flush();
  }

  commandLoop(cx, wanted) {
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand());
        if (c !== wanted) continue;
        // mod.open toggles, so pressing the key again closes the dialog instead of stacking one.
        if (c === "open") run("mod.open", { name: MOD });
        else if (c === "focus") {
          this.input?.focus();
          cx.notify();
        }
      }
    });
  }

  // ---------------- sampler ----------------

  startSampler(cx) {
    this.pending = L.emptyStore();
    this.tops = new Map();
    this.homes = this.homes ?? new Map();
    this.timers.push(cx.timer.every(SAMPLE_MS, (cx) => this.sample(cx)));
    this.timers.push(cx.timer.every(FLUSH_MS, (cx) => cx.spawn(async () => this.flush())));
    this.timers.push(cx.timer.after(5000, (cx) => this.sample(cx)));
  }

  sample(cx) {
    if (this.sampling) return;
    if (!safe(() => hostWindow().active, true)) return;
    const f = safe(() => focused(), null);
    const cwd = f?.cwd;
    if (!cwd || !cwd.startsWith("/")) return;
    const space = safe(() => spaces(), []).find((s) => s.id === f.space);
    const machine = space?.machine ?? null;
    this.sampling = true;
    cx.spawn(async () => {
      try {
        const path = await this.toplevel(machine, cwd);
        const h = await this.homeOf(machine).catch(() => null);
        if (!path || L.boringPath(path, h) || L.blockedPath(path)) return;
        L.addSample(this.pending, L.keyOf(machine, path), Date.now());
      } finally {
        this.sampling = false;
      }
    });
  }

  /** The git top level of cwd (cached 10 min), else cwd itself. */
  async toplevel(machine, cwd) {
    const k = L.keyOf(machine, cwd);
    const hit = this.tops.get(k);
    if (hit && Date.now() - hit.at < TOPLEVEL_TTL) return hit.path;
    let path = cwd;
    try {
      const r = await exec("env", L.toplevelArgv(), { cwd, on: machine, timeout: 5000 });
      const top = r.code === 0 ? r.stdout.trim() : "";
      if (top.startsWith("/") && !top.includes("\n")) path = top;
    } catch {
      // Not reachable or no git: keep the folder.
    }
    if (this.tops.size > 200) this.tops.clear();
    this.tops.set(k, { path, at: Date.now() });
    return path;
  }

  async flush() {
    const mine = this.pending;
    if (!mine || !Object.keys(mine.entries).length) return;
    this.pending = L.emptyStore();
    let written = null;
    const ok = await updateFile(VISITS(), (raw) => {
      written = L.serializeVisits(L.mergeStores(L.parseVisits(raw), mine), Date.now());
      return written;
    });
    if (ok) {
      if (this.store) this.store = L.parseVisits(written);
      this.rev = (this.rev ?? 0) + 1;
    } else {
      // Keep them for the next minute.
      this.pending = L.mergeStores(this.pending, mine);
    }
  }

  // ---------------- machine facts ----------------

  /** That machine's home folder (cached). Rejects when it can't be asked. */
  async homeOf(machine) {
    const mk = L.machineKey(machine);
    if (!mk) return home();
    this.homes = this.homes ?? new Map();
    if (this.homes.has(mk)) return this.homes.get(mk);
    const r = await exec("printenv", ["HOME"], { on: machine, timeout: 8000 });
    const h = r.stdout.trim();
    if (r.code !== 0 || !h.startsWith("/")) throw new Error("no home");
    this.homes.set(mk, h);
    return h;
  }

  // ---------------- UI ----------------

  initUi(pr, cx) {
    this.store = L.emptyStore();
    this.rev = 0;
    this.data = new Map(); // machineKey -> {home, zoxide, scanned, scan: idle|loading|done|error, scannedAt, note}
    this.missing = new Set();
    this.view = "list";
    this.moreOpen = false;
    this.status = null;
    this.busy = null;
    this.rows = [];
    this.selectedKey = null;
    this.sig = null;
    this.installed = { git: false, files: false };
    this.agents = null;
    this.suggestions = null;
    const active = safe(() => spaces(), []).find((s) => s.active);
    this.machine = pr.machine !== undefined ? pr.machine || null : active?.machine ?? null;
    this.scroll = ScrollHandle.new();
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Search projects…" });
    this.input.on("change", (_e, cx) => {
      this.selectedKey = null;
      this.refresh(true);
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => {
      const item = this.selectedItem();
      if (item) this.act("open", item, cx);
    });
    this.rootInput = InputState.new({ placeholder: "~/projects or /srv/code" });
    this.rootInput.on("submit", (_e, cx) => this.addRootFromInput(cx));
    this.agentInput = InputState.new({ placeholder: "claude" });
    this.agentInput.on("submit", (_e, cx) => this.saveAgent(cx));
    this.input.focus();
    this.timers.push(cx.timer.after(300, () => this.input.focus()));
    this.timers.push(cx.timer.every(REFRESH_MS, (cx) => {
      if (this.refresh(false)) cx.notify();
      if (this.markerTodo?.length) cx.spawn(async (cx) => { if (await this.checkMarkers()) cx.notify(); });
    }));
    this.timers.push(cx.timer.every(RELOAD_MS, (cx) => cx.spawn(async (cx) => {
      await this.loadVisits();
      cx.notify();
    })));
    cx.spawn(async (cx) => {
      await this.loadVisits();
      for (const k of ["git", "files"]) {
        this.installed[k] = await readTextFile(`${appHome()}/mods/drover-${k}/main.js`).then((t) => t != null, () => false);
      }
      this.refresh(true);
      cx.notify();
      if (await this.checkMarkers()) cx.notify();
    });
    this.loadMachine(cx, this.machine, false);
    this.loadSettingsExtras(cx);
  }

  async loadVisits() {
    try {
      this.store = L.parseVisits(await readTextFile(VISITS()));
    } catch {
      // Unreadable: keep what we had.
    }
    this.rev++;
  }

  machineInfo(name) {
    const list = L.machineList(safe(() => machines(), []), safe(() => spaces(), []));
    return list.find((m) => L.sameMachine(m.name, name)) ?? { name, label: name ?? "This computer", layout: "unavailable" };
  }

  dataOf(machine) {
    const mk = L.machineKey(machine);
    if (!this.data.has(mk)) this.data.set(mk, { home: mk ? null : home(), zoxide: [], scanned: [], scan: "idle", zox: "idle", scannedAt: 0, note: null, rootsSig: null, markers: new Map(), markerBusy: false });
    return this.data.get(mk);
  }

  selectMachine(name, cx) {
    this.machine = name;
    this.selectedKey = null;
    this.suggestions = null;
    this.agents = null;
    this.status = null;
    this.loadMachine(cx, name, false);
    if (this.view === "settings") this.loadSettingsExtras(cx);
    this.refresh(true);
    cx.notify();
  }

  /** Home, zoxide and the roots scan for one machine. `force`: scan again even if cached. */
  loadMachine(cx, machine, force) {
    const d = this.dataOf(machine);
    const info = this.machineInfo(machine);
    if (info.layout !== "ready" && machine) {
      d.note = info.layout === "loading"
        ? `Connecting to ${info.label}… showing pins and recent visits.`
        : `${info.label} isn't connected: showing pins and recent visits only.`;
      d.scan = "idle";
      this.rev++;
      return;
    }
    if (d.scan === "loading") return;
    d.scan = "loading";
    d.note = null;
    this.rev++;
    cx.spawn(async (cx) => {
      const mk = L.machineKey(machine);
      try {
        d.home = await this.homeOf(machine);
      } catch {
        d.scan = "error";
        d.note = `Can't list folders on ${info.label}: showing pins and recent visits only.`;
        this.rev++;
        cx.notify();
        return;
      }
      if (d.zox === "idle") {
        d.zox = "done";
        try {
          const r = await exec("zoxide", ["query", "-ls"], { on: machine, timeout: 5000 });
          if (r.code === 0) d.zoxide = L.parseZoxide(r.stdout).sort((a, b) => b.score - a.score).slice(0, 300);
        } catch {
          // zoxide isn't installed there: skip it quietly.
        }
      }
      const roots = (L.readRoots(shared(L.KEYS.roots))[mk] ?? []);
      const full = roots.map((r) => L.expandPath(r, d.home)).filter((r) => r && r !== "/" && !L.blockedPath(r));
      const rootsSig = JSON.stringify(full);
      let cached = null;
      if (!force) {
        try {
          const all = JSON.parse((await readTextFile(SCANS())) ?? "{}");
          const c = all?.[mk];
          if (c && c.roots === rootsSig && Date.now() - c.at < SCAN_TTL && Array.isArray(c.dirs)) cached = c;
        } catch {
          // No cache.
        }
      }
      if (cached) {
        d.scanned = cached.dirs.filter((x) => typeof x === "string" && !L.blockedPath(x));
        d.scannedAt = cached.at;
      } else {
        const dirs = new Set();
        let failed = 0;
        for (const root of full) {
          try {
            const r = await exec("find", L.findArgs(root), { on: machine, timeout: 20000 });
            // find exits 1 when some folder couldn't be read; what it printed is still good.
            for (const dir of L.parseFind(r.stdout, root)) dirs.add(dir);
          } catch {
            failed++;
          }
        }
        d.scanned = [...dirs].slice(0, L.MAX_SCAN_RESULTS);
        d.scannedAt = Date.now();
        if (failed && failed === full.length) {
          d.scan = "error";
          d.note = `Can't list folders on ${info.label}: showing pins and recent visits only.`;
          this.rev++;
          cx.notify();
          return;
        }
        if (failed) d.note = `${failed} of your folders couldn't be read on ${info.label}.`;
        await updateFile(SCANS(), (raw) => {
          let all = {};
          try {
            all = JSON.parse(raw ?? "{}") ?? {};
          } catch {
            all = {};
          }
          all[mk] = { at: d.scannedAt, roots: rootsSig, dirs: d.scanned };
          return JSON.stringify(all);
        }, 2);
      }
      d.rootsSig = rootsSig;
      d.scan = "done";
      this.rev++;
      this.refresh(true);
      cx.notify();
      if (await this.checkMarkers()) cx.notify();
    });
  }

  /**
   * Recent lists projects only: folders from visits or zoxide without a project marker drop out unless pinned.
   * One find per batch, markers directly inside each folder. A failed check keeps them (shown as before).
   */
  async checkMarkers() {
    const machine = this.machine;
    const d = this.dataOf(machine);
    const paths = (this.markerTodo ?? []).filter((p) => !d.markers.has(p));
    // An unreachable machine is never asked; its folders stay listed.
    if (machine && this.machineInfo(machine).layout !== "ready") return false;
    if (!paths.length || d.markerBusy) return false;
    d.markerBusy = true;
    try {
      const r = await exec("find", L.markerArgs(paths), { on: machine, timeout: 8000 });
      // find exits 1 when a folder is gone; what it printed is still good.
      const found = L.parseMarkers(r.stdout, paths);
      for (const p of paths) d.markers.set(p, found.has(p));
    } catch {
      for (const p of paths) d.markers.set(p, true);
    } finally {
      d.markerBusy = false;
    }
    this.rev++;
    this.refresh(true);
    return true;
  }

  /** Rebuilds the rows when anything they depend on changed. True when it did. Never from render. */
  refresh(force) {
    if (!this.input) return false;
    const sp = safe(() => spaces(), []);
    const d = this.dataOf(this.machine);
    const shownStore = this.pending ? L.mergeStores(this.store, this.pending) : this.store;
    const pins = shared(L.KEYS.pins);
    const hidden = shared(L.KEYS.hidden);
    const roots = shared(L.KEYS.roots);
    const info = this.machineInfo(this.machine);
    const query = this.input.value();
    const sig = JSON.stringify([query, L.machineKey(this.machine), this.rev, pins, hidden, roots, info.layout,
      sp.map((s) => [s.id, s.folder, s.machine, s.active]), [...this.missing]]);
    if (!force && sig === this.sig) return false;
    this.sig = sig;
    // Roots changed somewhere else (another copy's settings): scan again.
    const mk = L.machineKey(this.machine);
    const want = (L.readRoots(roots)[mk] ?? []).map((r) => L.expandPath(r, d.home)).filter(Boolean);
    if (d.scan === "done" && d.rootsSig !== JSON.stringify(want)) d.scan = "stale";
    const items = L.buildProjects({
      machine: this.machine, pins, store: shownStore, zoxide: d.zoxide, scanned: d.scanned,
      hidden: L.readHidden(hidden), spaces: sp, home: d.home, now: Date.now(),
    });
    for (const it of items) it.missing = this.missing.has(it.key);
    this.markerTodo = L.markerTodo(items, d.markers);
    this.total = items.length;
    if (query.trim()) {
      const hits = L.rank(items, query, d.home);
      this.groups = [{ id: "hits", title: `${hits.length} match${hits.length === 1 ? "" : "es"}`, rows: hits.slice(0, MAX_HITS) }];
    } else {
      this.groups = L.sections(items, 40, (i) => d.markers.get(i.path)).map((s) => ({
        id: s.id, title: s.title, more: Math.max(0, s.items.length - MAX_FOUND_ROWS),
        rows: s.items.slice(0, MAX_FOUND_ROWS).map((item) => ({ item, positions: [] })),
      }));
    }
    this.rows = this.groups.flatMap((g) => g.rows);
    return true;
  }

  selectedIndex() {
    const i = this.rows.findIndex((r) => r.item.key === this.selectedKey);
    return i >= 0 ? i : this.rows.length ? 0 : -1;
  }
  selectedItem() {
    const i = this.selectedIndex();
    return i >= 0 ? this.rows[i].item : null;
  }

  dismiss() {
    if (this.overlay) closeOverlay(this.overlay);
  }

  key(e, cx) {
    const k = e.key;
    const ctrl = Boolean(e.modifiers?.control);
    if (k === "escape") {
      if (this.view === "settings") {
        this.view = "list";
        cx.notify();
        return;
      }
      if (this.overlay) return this.dismiss();
      if (this.input.value()) {
        this.input.set_value("");
        this.refresh(true);
        cx.notify();
      }
      return;
    }
    if (this.view !== "list") return;
    let by;
    if (k === "down" || (ctrl && k === "n")) by = 1;
    else if (k === "up" || (ctrl && k === "p")) by = -1;
    else return;
    const at = L.move(Math.max(0, this.selectedIndex()), by, this.rows.length);
    this.selectedKey = this.rows[at]?.item.key ?? null;
    cx.stop_propagation();
    cx.notify();
  }

  setStatus(text, level = "info") {
    this.status = text ? { text, level } : null;
  }

  ctx() {
    const sp = safe(() => spaces(), []);
    return {
      machineReady: !this.machine || this.machineInfo(this.machine).layout === "ready",
      activeSpace: sp.find((s) => s.active) ?? null,
      platform: safe(() => hostWindow().platform, "macos"),
      installed: this.installed,
      agent: L.readAgent(shared(L.KEYS.agent)),
    };
  }

  act(id, item, cx) {
    if (this.busy) return;
    const ctx = this.ctx();
    const action = L.actionsFor(item, ctx).find((a) => a.id === id);
    if (!action?.enabled) {
      if (action?.reason) this.setStatus(action.reason, "warning");
      cx.notify();
      return;
    }
    const shown = L.displayPath(item.path, this.dataOf(item.machine).home);
    if (id === "pin") {
      setShared(L.KEYS.pins, L.togglePin(shared(L.KEYS.pins), item.machine, item.path));
      this.setStatus(item.pinned ? `Unpinned ${shown}` : `Pinned ${shown}`);
      this.refresh(true);
      cx.notify();
      return;
    }
    if (id === "hide") {
      const hidden = L.readHidden(shared(L.KEYS.hidden));
      if (!hidden.includes(item.key)) setShared(L.KEYS.hidden, [...hidden, item.key].slice(-1000));
      this.setStatus(`Hidden ${shown}. Settings can show it again.`);
      this.selectedKey = null;
      this.refresh(true);
      cx.notify();
      return;
    }
    const commands = L.commandsFor(id, item, ctx);
    const goesToSpace = id === "open" && item.space;
    this.busy = id;
    this.setStatus(goesToSpace ? null : `Checking ${shown}…`);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (!goesToSpace && L.NEEDS_FOLDER.has(id)) {
          let ok = false;
          try {
            const r = await exec("test", ["-d", item.path], { on: item.machine, timeout: 8000 });
            ok = r.code === 0;
          } catch {
            this.setStatus(`Couldn't reach ${item.machine ?? "this computer"} to check the folder.`, "error");
            return;
          }
          if (!ok) {
            this.missing.add(item.key);
            this.setStatus(`${shown} doesn't exist any more. Unpin or hide it.`, "error");
            this.refresh(true);
            return;
          }
          this.missing.delete(item.key);
        }
        for (const c of commands) {
          if (c[0] === "run") run(c[1], c[2]);
          else if (c[0] === "overlay") openOverlay(c[1]);
          else if (c[0] === "exec") {
            const r = await exec(c[1], c[2], { timeout: 10000 }).catch(() => null);
            if (!r || r.code !== 0) {
              this.setStatus("The file manager couldn't show that folder.", "error");
              return;
            }
          }
        }
        this.setStatus(null);
        if (this.overlay && id !== "reveal") this.dismiss();
      } finally {
        this.busy = null;
        cx.notify();
      }
    });
  }

  // ---------------- settings ----------------

  openSettings(cx) {
    this.view = this.view === "settings" ? "list" : "settings";
    if (this.view === "settings") {
      this.agentInput.set_value(L.readAgent(shared(L.KEYS.agent)).join(" "));
      this.loadSettingsExtras(cx);
    }
    cx.notify();
  }

  loadSettingsExtras(cx) {
    const machine = this.machine;
    if (machine && this.machineInfo(machine).layout !== "ready") {
      this.suggestions = [];
      this.agents = [];
      return;
    }
    this.suggestions = null;
    cx.spawn(async (cx) => {
      let found = [];
      try {
        const h = await this.homeOf(machine);
        const paths = L.ROOT_SUGGESTIONS.map((s) => L.expandPath(s, h)).filter(Boolean);
        const r = await exec("find", [...paths, "-maxdepth", "0", "-type", "d"], { on: machine, timeout: 8000 });
        const exists = new Set(r.stdout.split("\n").filter(Boolean));
        const seen = new Set();
        for (const s of L.ROOT_SUGGESTIONS) {
          const full = L.expandPath(s, h);
          // macOS folders ignore case: ~/projects and ~/Projects are one folder.
          if (!exists.has(full) || seen.has(full.toLowerCase())) continue;
          seen.add(full.toLowerCase());
          found.push(s);
        }
      } catch {
        found = [];
      }
      if (L.sameMachine(machine, this.machine)) this.suggestions = found;
      cx.notify();
    });
    cx.spawn(async (cx) => {
      let list = [];
      try {
        list = (await knownAgents({ on: machine })).filter((a) => a.installed && a.agent && Array.isArray(a.run) && a.run.length);
      } catch {
        list = [];
      }
      if (L.sameMachine(machine, this.machine)) this.agents = list.slice(0, 8);
      cx.notify();
    });
  }

  addRoot(text, cx) {
    const d = this.dataOf(this.machine);
    let root = L.normalizeRoot(text, d.home);
    const typed = String(text ?? "").trim().replace(/\/+$/, "");
    if (!root && !d.home && /^~\/[^\0\n]+$/.test(typed) && !L.blockedPath(typed)) root = typed;
    if (!root) {
      this.setStatus("That isn't a folder path you can scan (use ~/… or /…, not / or a credentials folder).", "error");
      cx.notify();
      return;
    }
    setShared(L.KEYS.roots, L.addRoot(shared(L.KEYS.roots), this.machine, root));
    this.setStatus(`Added ${root}. Scanning…`);
    this.rootInput.set_value("");
    d.scan = "idle";
    this.loadMachine(cx, this.machine, true);
    cx.notify();
  }

  addRootFromInput(cx) {
    this.addRoot(this.rootInput.value(), cx);
  }

  removeRoot(root, cx) {
    setShared(L.KEYS.roots, L.removeRoot(shared(L.KEYS.roots), this.machine, root));
    const d = this.dataOf(this.machine);
    d.scan = "idle";
    this.loadMachine(cx, this.machine, true);
    this.setStatus(`Removed ${root}.`);
    cx.notify();
  }

  chooseFolder(cx) {
    cx.spawn(async (cx) => {
      let picked = null;
      try {
        picked = await pickFolder({ prompt: "Add" });
      } catch {
        this.setStatus("The folder picker couldn't open.", "error");
      }
      if (picked) this.addRoot(picked, cx);
      cx.notify();
    });
  }

  saveAgent(cx) {
    const words = L.parseAgentText(this.agentInput.value());
    if (!words) {
      setShared(L.KEYS.agent, null);
      this.agentInput.set_value(L.DEFAULT_AGENT.join(" "));
      this.setStatus(`Agent reset to ${L.DEFAULT_AGENT.join(" ")}.`);
    } else {
      setShared(L.KEYS.agent, words);
      this.setStatus(`New spaces + agent will run ${words[0]}.`);
    }
    cx.notify();
  }


  // ---------------- drawing ----------------

  /** The kit's text button: primary (one per view) or secondary. `opts.enabled`, `opts.primary`, `opts.tip`. */
  button(t, id, label, onClick, opts = {}) {
    return button({ id, label, onClick, kind: opts.primary ? "primary" : "secondary", disabled: opts.enabled === false, tooltip: opts.tip }, t);
  }

  machineStrip(t) {
    const list = L.machineList(safe(() => machines(), []), safe(() => spaces(), []));
    const dot = { ready: t.done, loading: t.working, unavailable: t.dim };
    const row = h_flex().gap(6).items_center().flex_1().min_w(0).overflow_hidden().flex_wrap();
    list.forEach((m, i) => {
      const on = L.sameMachine(m.name, this.machine);
      const state = m.layout === "ready" ? "connected" : m.layout === "loading" ? "connecting" : "not connected";
      row.child(h_flex().id(`machine-${i}`).h(26).px(8).gap(6).items_center().rounded(6).flex_none().cursor_pointer()
        .border_1().border_color(on ? t.accent : t.border).bg(on ? t.selected : t.background)
        .hover((s) => s.bg(on ? t.selected : t.hover))
        .role("button").accessibility_label(`${m.label}: ${state}`).tooltip(`${m.label}: ${state}`)
        .on_click((_e, cx) => this.selectMachine(m.name, cx))
        .child(svg(UI(m.name ? "server" : "computer")).size(13).flex_none().text_color(on ? t.foreground : t.muted))
        .child(div().text_size(TYPE.sm).text_color(on ? t.foreground : metaColor(t)).child(m.label))
        .child(div().size(7).rounded_full().flex_none().bg(dot[m.layout] ?? t.dim)));
    });
    row.child(this.button(t, "add-machine", "Add machine", () => run("app.settings", { section: "machines" }), { tip: "Add or manage machines" }));
    return row;
  }

  narrow() {
    return (this.width ?? 880) < 640;
  }

  header(t) {
    const d = this.dataOf(this.machine);
    const settingsOpen = this.view === "settings";
    return panelHeader({
      title: "Projects",
      meta: this.total > 0 ? this.total : undefined,
      busy: d.scan === "loading",
      actions: [
        { id: "settings", icon: UI("gear"), label: settingsOpen ? "Back to projects" : "Settings", active: settingsOpen, onClick: (cx) => this.openSettings(cx) },
        {
          id: "rescan", icon: UI("refresh"), label: "Rescan folders", disabled: d.scan === "loading",
          onClick: (cx) => {
            this.dataOf(this.machine).zox = "idle";
            this.loadMachine(cx, this.machine, true);
            cx.notify();
          },
        },
      ],
    }, t);
  }

  search(t) {
    return h_flex().h(34).flex_none().mx(12).px(10).gap(8).items_center().rounded(6)
      .border_1().border_color(t.accent).bg(t.background)
      .child(svg(UI("search")).size(14).flex_none().text_color(t.dim))
      .child(Input.new(this.input).flex_1().h_full().text_size(TYPE.sm).text_color(t.foreground));
  }

  title(t, item, positions) {
    const name = item.label || item.name;
    const row = h_flex().min_w(0).overflow_hidden().whitespace_nowrap().text_size(TYPE.sm);
    for (const s of L.segments(name, positions)) {
      row.child(s.on
        ? div().flex_none().font_medium().text_color(t.accent).child(s.text)
        : div().flex_none().text_color(item.missing ? metaColor(t) : t.foreground).child(s.text));
    }
    return row;
  }

  row(t, hit, i, at) {
    const { item, positions } = hit;
    const on = i === at;
    const h = this.dataOf(item.machine).home;
    const icon = resolveIcon(MOD, true, item.name, { root: true });
    const meta = metaColor(t, on ? t.selected : t.background);
    const badges = h_flex().gap(6).flex_none().items_center().text_size(TYPE.xs).text_color(meta);
    if (item.missing) badges.child(div().text_color(t.blocked).child("missing"));
    if (item.space) badges.child(div().px(5).rounded(4).bg(t.selected).text_color(t.foreground).child("open"));
    if (item.pinned) badges.child(svg(UI("pin")).size(11).text_color(t.muted).accessibility_label("Pinned"));
    if (item.last) badges.child(div().child(ago(item.last, Date.now())));
    return h_flex().id(`row-${i}`).h(ROW_H).flex_none().mx(6).px(8).gap(10).items_center().rounded(6).cursor_pointer()
      .when(on, (el) => el.bg(t.selected))
      .hover((s) => s.bg(on ? t.selected : t.hover))
      .on_click((e, cx) => {
        const again = this.selectedKey === item.key || (this.selectedKey == null && i === 0);
        this.selectedKey = item.key;
        if (again && e?.click_count >= 2) this.act("open", item, cx);
        cx.notify();
      })
      .child(image(icon).size(16).flex_none())
      .child(v_flex().flex_1().min_w(0)
        .child(this.title(t, item, positions))
        .child(mono(div().truncate().text_size(TYPE.xs).text_color(meta).child(tailPath(L.displayPath(item.path, h), this.narrow() ? 32 : 52)))))
      .child(badges);
  }

  onboarding(t) {
    const card = v_flex().mx(12).my(6).p(12).gap(8).min_w(160).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(div().min_w(0).text_size(TYPE.md).font_semibold().child("Where do your projects live?"))
      .child(div().min_w(0).text_size(TYPE.sm).text_color(metaColor(t, t.surface)).child("Add folders and Projects lists every repo and project two levels below them. Pins and folders you work in show up either way."));
    const chips = h_flex().gap(6).flex_wrap();
    for (const s of this.suggestions ?? []) chips.child(mono(div().child(this.button(t, `sug-${s}`, s, (cx) => this.addRoot(s, cx)))));
    if (!this.machine) chips.child(this.button(t, "choose", "Choose folder…", (cx) => this.chooseFolder(cx)));
    chips.child(this.button(t, "onb-settings", "Type a path…", (cx) => this.openSettings(cx)));
    if (this.suggestions === null) card.child(div().text_size(TYPE.xs).text_color(metaColor(t, t.surface)).child("Looking for common project folders…"));
    return card.child(chips);
  }

  list(t) {
    const d = this.dataOf(this.machine);
    const roots = L.readRoots(shared(L.KEYS.roots))[L.machineKey(this.machine)] ?? [];
    const at = this.selectedIndex();
    const query = this.input.value().trim();
    const body = v_flex().id("list").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).pb(6);
    if (d.note) {
      body.child(h_flex().mx(12).my(4).px(10).py(6).gap(8).items_center().rounded(6).bg(t.surface)
        .child(svg(UI("warning")).size(13).flex_none().text_color(t.blocked))
        .child(div().text_size(TYPE.sm).text_color(metaColor(t, t.surface)).child(d.note)));
    }
    const ready = !this.machine || this.machineInfo(this.machine).layout === "ready";
    const onboarding = !roots.length && ready && d.scan !== "error" && !query;
    if (onboarding) body.child(this.onboarding(t));
    if (d.scan === "loading" && !this.rows.length) {
      body.child(div().px(18).py(6).text_size(TYPE.sm).text_color(metaColor(t)).child("Reading your folders…"));
    }
    let i = 0;
    for (const g of this.groups ?? []) {
      body.child(div().px(18).child(sectionLabel(g.title, t)));
      for (const hit of g.rows) {
        body.child(this.row(t, hit, i, at));
        if (i === at && this.narrow()) body.child(this.inlineActions(t, hit.item));
        i++;
      }
      if (g.more) body.child(div().px(18).py(4).text_size(TYPE.xs).text_color(metaColor(t)).child(`${g.more} more: type to search`));
    }
    if (!this.rows.length && d.scan !== "loading" && !onboarding) {
      body.child(query
        ? emptyState({ id: "empty-matches", title: "No matches", body: `Nothing matches "${query}".`,
          action: { id: "clear-search", label: "Clear search", onClick: (cx) => { this.input.set_value(""); this.refresh(true); cx.notify(); } } }, t)
        : emptyState({ id: "empty-projects", title: "No projects yet", body: "Pin a project, add a folder to scan, or work in a terminal for a while." }, t));
    }
    return body;
  }

  /** The actions of one project: Open (the one primary), two spaces, then a "More" toggle for the rest. */
  actionButtons(t, item, container) {
    const acts = L.actionsFor(item, this.ctx());
    const shownIds = new Set(["open", "space", "agent"]);
    const make = (a) => {
      const label = this.busy === a.id ? `${a.label}…` : a.label;
      container.child(this.button(t, `act-${a.id}`, label, (cx) => this.act(a.id, item, cx),
        { enabled: a.enabled && !this.busy, primary: a.id === "open", tip: a.reason ?? undefined }));
      if (!a.enabled && a.reason && a.id !== "hide") container.child(div().pl(4).text_size(TYPE.xs).text_color(metaColor(t)).child(a.reason));
    };
    for (const a of acts.filter((x) => shownIds.has(x.id))) make(a);
    container.child(this.button(t, "act-more", this.moreOpen ? "Fewer actions" : "⋯ More", (cx) => {
      this.moreOpen = !this.moreOpen;
      cx.notify();
    }, { tip: "Open as tab, Git, Files, pin, reveal, hide" }));
    if (this.moreOpen) for (const a of acts.filter((x) => !shownIds.has(x.id))) make(a);
    return container;
  }

  detail(t) {
    const item = this.selectedItem();
    const panel = v_flex().w(270).flex_none().h_full().min_h(0).p(12).gap(8).border_l_1().border_color(t.border);
    if (!item) return panel.child(div().text_size(TYPE.sm).text_color(metaColor(t)).child("Pick a project to see what you can do with it."));
    const h = this.dataOf(item.machine).home;
    const now = Date.now();
    const facts = [];
    if (item.machine) facts.push(`On ${item.machine}`);
    if (item.visits) facts.push(`${item.visits} visit${item.visits === 1 ? "" : "s"}, last ${ago(item.last, now)}`);
    if (item.zoxide) facts.push("Known to zoxide");
    if (item.scanned) facts.push("In your folders");
    if (item.space) facts.push("A space is open here");
    panel.child(div().text_size(TYPE.md).font_semibold().truncate().child(item.label || item.name))
      .child(mono(div().text_size(TYPE.xs).text_color(metaColor(t)).child(tailPath(L.displayPath(item.path, h), 40))));
    if (facts.length) panel.child(div().text_size(TYPE.xs).text_color(metaColor(t)).child(facts.join(" · ")));
    if (item.missing) panel.child(div().text_size(TYPE.xs).text_color(t.blocked).child("This folder doesn't exist any more."));
    const actions = h_flex().gap(6).pt(4).id("actions").flex_1().min_h(0).flex_wrap().items_start().content_start().overflow_y_scrollbar();
    return panel.child(this.actionButtons(t, item, actions));
  }

  /** Narrow panes: the selected project's actions under its row instead of a side panel. */
  inlineActions(t, item) {
    const box = v_flex().mx(12).mb(6).px(8).py(6).gap(4).rounded(6).bg(t.surface);
    if (item.missing) box.child(div().text_size(TYPE.xs).text_color(t.blocked).child("This folder doesn't exist any more."));
    return box.child(this.actionButtons(t, item, h_flex().gap(6).flex_wrap().items_start()));
  }

  settingsView(t) {
    const mk = L.machineKey(this.machine);
    const label = this.machineInfo(this.machine).label;
    const roots = L.readRoots(shared(L.KEYS.roots))[mk] ?? [];
    const hidden = L.readHidden(shared(L.KEYS.hidden));
    const ready = !this.machine || this.machineInfo(this.machine).layout === "ready";
    const meta = metaColor(t);
    const v = v_flex().id("settings").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(8).gap(10);
    v.child(div().text_size(TYPE.md).font_semibold().child(`Folders to scan on ${label}`))
      .child(div().text_size(TYPE.sm).text_color(meta).child("Projects (a .git folder, package.json, go.mod, *.csproj and the like) up to two levels below each folder are listed."));
    if (!roots.length) v.child(div().text_size(TYPE.sm).text_color(meta).child("None yet."));
    roots.forEach((r, i) => v.child(h_flex().gap(8).items_center()
      .child(svg(UI("folder")).size(13).flex_none().text_color(t.muted))
      .child(mono(div().flex_1().min_w(0).truncate().text_size(TYPE.sm).child(r)))
      .child(this.button(t, `rm-root-${i}`, "Remove", (cx) => this.removeRoot(r, cx)))));
    v.child(h_flex().gap(6).items_center()
      .child(h_flex().h(28).flex_1().px(8).items_center().rounded(6).border_1().border_color(t.border).bg(t.background)
        .child(Input.new(this.rootInput).flex_1().h_full().text_size(TYPE.sm)))
      .child(this.button(t, "add-root", "Add", (cx) => this.addRootFromInput(cx), { primary: true }))
      .when(!this.machine, (el) => el.child(this.button(t, "choose-root", "Choose…", (cx) => this.chooseFolder(cx)))));
    if (!ready) v.child(div().text_size(TYPE.xs).text_color(meta).child(`${label} isn't connected: folders you add are scanned once it is.`));
    const sug = (this.suggestions ?? []).filter((s) => !roots.includes(s));
    if (sug.length) {
      const chips = h_flex().gap(6).flex_wrap();
      for (const s of sug) chips.child(mono(div().child(this.button(t, `ssug-${s}`, s, (cx) => this.addRoot(s, cx)))));
      v.child(div().text_size(TYPE.xs).text_color(meta).child("Found on this machine:")).child(chips);
    }
    v.child(div().pt(8).text_size(TYPE.md).font_semibold().child("Agent for “New space + agent”"))
      .child(div().text_size(TYPE.sm).text_color(meta).child("The command and its arguments, separated by spaces (no shell, quotes are not interpreted)."))
      .child(h_flex().gap(6).items_center()
        .child(mono(h_flex().h(28).flex_1().px(8).items_center().rounded(6).border_1().border_color(t.border).bg(t.background)
          .child(Input.new(this.agentInput).flex_1().h_full().text_size(TYPE.sm))))
        .child(this.button(t, "save-agent", "Save", (cx) => this.saveAgent(cx))));
    if (this.agents?.length) {
      const chips = h_flex().gap(6).flex_wrap();
      this.agents.forEach((a, i) => chips.child(this.button(t, `agent-${i}`, a.name, (cx) => {
        this.agentInput.set_value(a.run.join(" "));
        this.saveAgent(cx);
      })));
      v.child(div().text_size(TYPE.xs).text_color(meta).child(`Installed on ${label}:`)).child(chips);
    }
    v.child(div().pt(8).text_size(TYPE.md).font_semibold().child("Hidden projects"))
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(TYPE.sm).text_color(meta).child(hidden.length ? `${hidden.length} hidden` : "Nothing is hidden."))
        .when(hidden.length > 0, (el) => el.child(this.button(t, "unhide", "Show them again", (cx) => {
          setShared(L.KEYS.hidden, []);
          this.setStatus("Hidden projects are back.");
          this.refresh(true);
          cx.notify();
        }))));
    return v;
  }

  footer(t) {
    const s = this.status;
    const color = s?.level === "error" ? t.blocked : s?.level === "warning" ? t.ansi3 : metaColor(t);
    return h_flex().h(26).flex_none().px(14).gap(12).items_center().border_t_1().border_color(t.border).text_size(TYPE.xs)
      .child(div().flex_1().min_w(0).truncate().text_color(color).child(s?.text ?? `${this.total ?? 0} projects`))
      .when(!this.narrow(), (el) => el.child(div().flex_none().text_color(metaColor(t)).child(this.view === "settings" ? "Esc back" : `↑↓ move   Enter open   Esc ${this.overlay ? "close" : "clear"}`)));
  }

  render() {
    if (this.role === "background") return div();
    const t = theme();
    const root = v_flex().id("projects").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_size_change((size, cx) => {
        const w = Math.round(size?.width ?? 0);
        if (w && w !== this.width) {
          this.width = w;
          cx.notify();
        }
      })
      .size_full().min_h(0).gap(8).bg(this.overlay ? t.popover : t.background).text_color(t.foreground).text_size(TYPE.md)
      .child(this.header(t))
      .child(h_flex().px(12).flex_none().child(this.machineStrip(t)));
    if (this.view === "settings") return root.child(this.settingsView(t)).child(this.footer(t));
    if (this.narrow()) {
      return root.child(this.search(t))
        .child(v_flex().flex_1().min_h(0).child(this.list(t)))
        .child(this.footer(t));
    }
    return root.child(this.search(t))
      .child(h_flex().flex_1().min_h(0).items_start()
        .child(v_flex().flex_1().min_w(0).h_full().min_h(0).child(this.list(t)))
        .child(this.detail(t)))
      .child(this.footer(t));
  }
}
