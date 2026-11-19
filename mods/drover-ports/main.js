// Ports: every listening TCP port on this computer, with its process, the Herdr
// space it runs in, and Open / Stop. A full-page view; place "none".
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { checking, exec, hc, home, notify, spaces, terminals, theme, window } from "herdr";
import { TYPE, SPACE, mono, metaColor, panelHeader, emptyState, button } from "./lib/panel-ui.js";
import {
  parseLsof, parsePs, parsePpid, parseCwd, fmtEtime, fmtMem, fmtCpu,
  tildify, folderName, findOwner, groupRows, canStop, parseSs, parseNetstat, parseTasklist,
  parsePwdx, notInstalled, stopCall, openCall, lsofListCall, ssListCall, netstatCall, tasklistCall, pwdxCall,
  noToolText, lsofUsable, describeCommand, safeName, containerOf, kindOf, urlFor, holdersOutcome, ssHoldersOutcome,
  netstatHoldersOutcome, stopVerdict, nextStopState, finalVerdict, startOf, sameStart, lsofHoldersCall, psStartCall,
} from "./parse.js";

const TICK_MS = 15000;
const CONFIRM_MS = 4000;
const EXEC_MS = 4000; // every exec: a hung lsof must not hold the page
const STOP_CHECK_MS = 1000;
const STOP_WAIT_MS = 10000;
const RESULT_MS = 6000;
const T = { timeout: EXEC_MS };
const nowSec = () => Math.floor(Date.now() / 1000);
const RESULT_LABEL = { stopped: "Stopped", still: "Still running", restarted: "Started again", unknown: "Could not check" };
const SORTS = [["port", "Port"], ["cpu", "CPU"], ["memory", "Memory"]];
const MOD = "drover-ports";
const UI = (name) => `mods/${MOD}/ui/${name}.svg`;
// Long paths keep their tail (folder and last segment): "…/parent/name", never cut in the middle.
const tailPath = (p, max = 30) => {
  if (!p || p.length <= max) return p;
  const parts = p.split("/").filter(Boolean);
  const two = `…/${parts.slice(-2).join("/")}`;
  return two.length <= max ? two : `…/${parts[parts.length - 1]}`;
};
const firstLine = (e) => String(e ?? "").split("\n")[0].slice(0, 200);
const local = (address) => !String(address).includes("/");
// "macos" | "linux" | "windows"; macOS when no window is up yet (herdr-app check).
const platformOf = () => { try { return window()?.platform ?? "macos"; } catch { return "macos"; } };

function loadSort() {
  try {
    const v = localStorage.getItem("sort");
    return SORTS.some(([k]) => k === v) ? v : "port";
  } catch {
    return "port";
  }
}

export default class Ports extends View {
  init(_props, cx) {
    this.sort = loadSort();
    this.rows = null; // null: not read yet
    this.error = null;
    this.sig = "";
    this.confirm = new Map(); // "pid:port" -> expiry ms
    this.stopping = new Set();
    this.checkingStop = new Set(); // keys whose port is being read again after a stop
    this.result = new Map(); // key -> { verdict, until }
    this.tool = null; // the listing tool that worked last: "lsof" | "ss" | "netstat"
    this.sel = null; // keyboard cursor: pid key
    this.hov = null; // hovered card: pid key
    this.handle = cx.focus_handle();
    this.order = [];
    this.shells = new Map(); // address -> { pid, space, parent }
    this.refresh(cx);
    // herdr-app check: read the list once, no timer.
    if (checking()) return;
    cx.timer.every(TICK_MS, (cx) => {
      if (window().active) this.refresh(cx);
    });
  }

  refresh(cx, force = false) {
    // A forced refresh that meets a running tick runs once more when that tick ends: the tick
    // may have read the ports before the stop landed.
    if (this.busy) { if (force) this.again = true; return; }
    this.busy = true;
    cx.spawn(async (cx) => {
      let rows = null;
      let error = null;
      try {
        rows = await this.read();
      } catch (e) {
        error = String(e?.message ?? e);
      }
      this.busy = false;
      const again = this.again;
      this.again = false;
      const sig = JSON.stringify([error, rows]);
      if (force || sig !== this.sig) {
        this.sig = sig;
        this.rows = rows ?? this.rows;
        this.error = error;
        cx.notify();
      }
      if (again) this.refresh(cx, true);
    });
  }

  async read() {
    const platform = platformOf();
    if (platform === "windows") return this.readWindows();
    let ls;
    try {
      ls = await exec(...lsofListCall(), T);
    } catch (e) {
      if (platform === "linux" && notInstalled(e)) return this.readSs();
      throw notInstalled(e) ? new Error(noToolText(platform)) : e;
    }
    if (!lsofUsable(ls, platform)) throw new Error(ls.stderr || "lsof failed");
    this.tool = "lsof";
    const ports = parseLsof(ls.stdout);
    if (!ports.length) return [];
    const pids = [...new Set(ports.map((p) => p.pid))].join(",");
    const [ps, cwd, tree] = await Promise.all([
      exec("ps", ["-ww", "-o", "pid=,pcpu=,rss=,etime=,command=", "-p", pids], T),
      exec("lsof", ["-a", "-d", "cwd", "-p", pids, "-Fn"], T).catch(() => null),
      exec("ps", ["-axo", "pid=,ppid="], T).catch(() => null),
    ]);
    return this.rows_(ports, parsePs(ps.stdout), parseCwd(cwd?.stdout), parsePpid(tree?.stdout));
  }

  // Linux without lsof: ss lists the ports, pwdx (procps) the folders.
  async readSs() {
    let ss;
    try { ss = await exec(...ssListCall(), T); } catch (e) { throw notInstalled(e) ? new Error(noToolText("linux")) : e; }
    if (ss.code !== 0) throw new Error(ss.stderr || "ss failed");
    this.tool = "ss";
    const ports = parseSs(ss.stdout);
    if (!ports.length) return [];
    const pids = [...new Set(ports.map((p) => p.pid))];
    const [ps, cwd, tree] = await Promise.all([
      exec("ps", ["-ww", "-o", "pid=,pcpu=,rss=,etime=,command=", "-p", pids.join(",")], T),
      exec(...pwdxCall(pids), T).catch(() => null),
      exec("ps", ["-axo", "pid=,ppid="], T).catch(() => null),
    ]);
    return this.rows_(ports, parsePs(ps.stdout), parsePwdx(cwd?.stdout), parsePpid(tree?.stdout));
  }

  // Windows: netstat for the ports, tasklist for names and memory. No cpu, uptime, command
  // line, folder or parent here, so rows land in System and carry no Herdr space.
  async readWindows() {
    const ns = await exec(...netstatCall(), T);
    if (ns.code !== 0) throw new Error(ns.stderr || "netstat failed");
    this.tool = "netstat";
    const ports = parseNetstat(ns.stdout);
    if (!ports.length) return [];
    const tl = await exec(...tasklistCall(), T).catch(() => null);
    const names = parseTasklist(tl?.stdout);
    const procs = new Map(ports.map((p) => {
      const t = names.get(p.pid);
      // tasklist failed for this pid: the program is unknown, so the row gets no Stop.
      return [p.pid, { cpu: null, rss: t?.rss ?? 0, etime: "", name: t?.name ?? `pid ${p.pid}`, exe: t?.name || undefined }];
    }));
    return this.rows_(ports, procs, new Map(), new Map());
  }

  // Rows carry name, exe and flags derived from the command line, never the command itself.
  async rows_(ports, procs, cwds, ppids) {
    const owners = await this.shellOwners(ppids);
    const h = home();
    const now = nowSec();
    const facts = new Map();
    for (const [pid, pr] of procs) {
      const d = pr.command != null ? describeCommand(pr.command) : { name: pr.name, exe: pr.exe ? safeName(pr.exe, "process") : undefined, inspect: false };
      facts.set(pid, { name: d.name, exe: d.exe, inspect: d.inspect, start: startOf(pr.etime, now) });
    }
    return ports
      .filter((p) => procs.has(p.pid))
      .map((p) => {
        const pr = procs.get(p.pid);
        const f = facts.get(p.pid);
        const dir = cwds.get(p.pid) ?? "";
        const spaceId = findOwner(p.pid, ppids, owners);
        return {
          pid: p.pid, port: p.port, bind: p.bind, hosts: p.hosts,
          name: f.name || `pid ${p.pid}`, exe: f.exe, start: f.start, container: containerOf(f.exe),
          kind: kindOf({ port: p.port, exe: f.exe, flags: { inspect: f.inspect } }),
          cpu: pr.cpu, rss: pr.rss, up: fmtEtime(pr.etime),
          folder: dir ? folderName(dir, h) : "", cwd: tildify(dir, h), fullCwd: dir,
          space: spaceId ? spaces().find((s) => s.id === spaceId)?.name ?? null : null,
        };
      });
  }

  // Map of each local Herdr terminal's shell pid -> its space id.
  async shellOwners(ppids) {
    // No parent pids (Windows, or ps failed): nothing can be traced to a shell, so no hc calls.
    if (!ppids.size) return new Map();
    const live = terminals().filter((t) => local(t.address) && (t.state ?? "live") === "live");
    for (const t of live) {
      const i = this.shells.get(t.address);
      if (i && ppids.has(i.pid)) continue;
      const r = await hc(["get", "--json", t.address]).catch(() => null);
      try {
        const j = JSON.parse(r?.stdout ?? "");
        this.shells.set(t.address, { pid: j.pid ?? null, space: j.labels?.["herdr.space"] ?? null, parent: j.parent ?? null });
      } catch {
        this.shells.delete(t.address);
      }
    }
    const spaceOf = (address, seen = new Set()) => {
      const i = this.shells.get(address);
      if (!i || seen.has(address)) return null;
      seen.add(address);
      return i.space ?? (i.parent ? spaceOf(i.parent, seen) : null);
    };
    const out = new Map();
    for (const t of live) {
      const i = this.shells.get(t.address);
      const space = spaceOf(t.address);
      if (i?.pid > 1 && space) out.set(i.pid, space);
    }
    return out;
  }

  setSort(key, cx) {
    this.sort = key;
    try { localStorage.setItem("sort", key); } catch { /* storage unavailable: keep it for this copy */ }
    cx.notify();
  }

  open(p) {
    const platform = platformOf();
    let call;
    try { call = openCall(urlFor(p.hosts, p.port), platform); } catch { return; }
    exec(...call, T).catch((e) => {
      if (platform === "linux" && notInstalled(e)) notify({ title: "Install xdg-utils to open links", level: "warning" });
    });
  }

  // Who holds `ports` right now, any pid: Map port -> Set(pid | "?"), or null when the read
  // failed. Uses the listing tool that worked last; a failed read is never "stopped".
  async portHolders(ports) {
    const platform = platformOf();
    if (platform === "windows") return netstatHoldersOutcome(await exec(...netstatCall(), T).catch(() => null), ports);
    const ss = async () => ssHoldersOutcome(await exec(...ssListCall(), T).catch(() => null), ports);
    if (this.tool === "ss") return ss();
    let r;
    try { r = await exec(...lsofHoldersCall(ports), T); } catch (e) {
      return platform === "linux" && notInstalled(e) ? ss() : null;
    }
    return holdersOutcome(r, platform, ports);
  }

  // Still the process the row showed? macOS/Linux compare the start time (pid reuse). Windows has
  // no start time here and relies on the holder check alone.
  async sameProcess(proc, platform) {
    if (platform === "windows") return true;
    const r = await exec(...psStartCall(proc.pid), T).catch(() => null);
    if (!r || r.code !== 0) return false;
    return sameStart(proc.start, startOf(String(r.stdout ?? "").trim(), nowSec()));
  }

  stop(proc, cx) {
    if (!canStop(proc)) return;
    const key = String(proc.pid);
    const until = this.confirm.get(key);
    if (!until || until < Date.now()) {
      this.confirm.set(key, Date.now() + CONFIRM_MS);
      cx.timer.after(CONFIRM_MS, (cx) => {
        if ((this.confirm.get(key) ?? 0) <= Date.now()) {
          this.confirm.delete(key);
          cx.notify();
        }
      });
      cx.notify();
      return;
    }
    this.confirm.delete(key);
    if (checking() || this.stopping.has(key) || this.checkingStop.has(key)) return;
    this.stopping.add(key);
    this.result.delete(key);
    cx.notify();
    cx.spawn(async (cx) => {
      let verdict = null;
      let newKey = null;
      const ports = proc.ports.map((p) => p.port);
      const first = ports[0];
      try {
        if (!canStop(proc)) return;
        const platform = platformOf();
        // Pre-check: who holds the ports now, and is it still the same process?
        const before = await this.portHolders(ports);
        if (!before) {
          notify({ title: `Could not read port ${first}`, body: "No signal was sent. Try again in a moment.", level: "warning" });
          return;
        }
        const ours = ports.some((p) => before.get(p)?.has(proc.pid));
        if (!ours) {
          const taken = ports.map((p) => [p, [...(before.get(p) ?? [])]]).find(([, s]) => s.length);
          if (!taken) {
            notify({ title: `Port ${first} is already free`, level: "info" });
          } else {
            const who = taken[1].find((x) => x !== "?");
            notify({ title: who ? `Port ${taken[0]} is now held by pid ${who}` : `Port ${taken[0]} is now held by another account`,
              body: "No signal was sent. A watcher may have restarted it.", level: "warning" });
          }
          return;
        }
        if (!(await this.sameProcess(proc, platform))) {
          notify({ title: `The process on :${first} changed`, body: "Nothing was stopped.", level: "warning" });
          return;
        }
        // Signal, then read the ports again until they settle.
        const r = await exec(...stopCall(proc.pid, platform), T).catch(() => null);
        this.stopping.delete(key);
        this.checkingStop.add(key);
        cx.notify();
        if (r?.code !== 0) {
          notify(platform === "windows"
            ? { title: `Couldn't stop ${proc.name}`, body: "Windows asked it to close and it didn't. Stop it from its own window or Task Manager.", level: "warning" }
            : { title: `Couldn't stop ${proc.name}`, body: "The stop signal was refused.", level: "warning" });
          // One read so the card shows the true state.
          verdict = finalVerdict(nextStopState(null, stopVerdict(proc.pid, ports, await this.portHolders(ports), before)).last);
          return;
        }
        let state = null;
        const end = Date.now() + STOP_WAIT_MS;
        while (Date.now() < end) {
          await cx.sleep(STOP_CHECK_MS);
          state = nextStopState(state, stopVerdict(proc.pid, ports, await this.portHolders(ports), before));
          if (state.done) break;
        }
        verdict = state?.done ? finalVerdict(state.final) : finalVerdict(state?.last);
        const v = state?.final ?? state?.last;
        // The old card goes away on refresh; the new pid's card carries "Started again".
        if (verdict === "restarted" && Number.isInteger(v?.pid) && v.pid !== proc.pid) newKey = String(v.pid);
        this.tell(verdict, v, first);
      } finally {
        this.stopping.delete(key);
        this.checkingStop.delete(key);
        if (verdict) {
          for (const k of newKey ? [key, newKey] : [key]) {
            this.result.set(k, { verdict, until: Date.now() + RESULT_MS });
            cx.timer.after(RESULT_MS, (cx) => {
              if ((this.result.get(k)?.until ?? 0) <= Date.now()) { this.result.delete(k); cx.notify(); }
            });
          }
        }
        this.refresh(cx, true);
      }
    });
  }

  // The toast for a stop result. "stopped" gets a short one because the card is gone on refresh.
  // No stderr is ever echoed.
  tell(verdict, v, first) {
    const port = v?.port ?? first;
    if (verdict === "stopped") {
      notify({ title: "Stopped.", level: "info" });
    } else if (verdict === "still") {
      notify({ title: `Port ${port} did not close`, body: "The process was still listening after 10 seconds.", level: "warning" });
    } else if (verdict === "restarted") {
      notify({ title: `:${port} started again`, level: "warning",
        body: v?.pid ? `pid ${v.pid} took it right after the stop. A watcher may have restarted it.` : "Another process took it, and this account can't see which." });
    } else if (verdict === "unknown") {
      notify({ title: `Could not check :${port}`, body: "The stop signal was sent, but the port could not be read.", level: "warning" });
    }
  }

  moveSel(d, cx) {
    if (!this.order.length) return;
    const i = this.order.findIndex((p) => String(p.pid) === this.sel);
    const n = i < 0 ? (d > 0 ? 0 : this.order.length - 1) : Math.max(0, Math.min(this.order.length - 1, i + d));
    this.sel = String(this.order[n].pid);
    cx.notify();
  }

  onKey(e, cx) {
    if (e.key === "down") { this.moveSel(1, cx); cx.stop_propagation(); }
    else if (e.key === "up") { this.moveSel(-1, cx); cx.stop_propagation(); }
    else if (e.key === "enter") {
      const p = this.order.find((r) => String(r.pid) === this.sel);
      const web = p?.ports?.find((x) => x.kind === "web");
      if (web) { this.open(web); cx.stop_propagation(); }
    } else if (e.key === "escape" && this.sel) { this.sel = null; cx.notify(); cx.stop_propagation(); }
  }

  render() {
    const t = theme();
    const rows = this.rows ?? [];
    const groups = groupRows(rows, this.sort, home());
    this.order = groups.flatMap((g) => g.procs);
    const empty = !this.error && this.rows !== null && rows.length === 0;
    return v_flex().id("ports-root").size_full().bg(t.background).text_color(t.foreground).text_size(TYPE.sm)
      .track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx))
      .child(panelHeader({
        id: "ports-header", title: "Ports", busy: Boolean(this.busy),
        meta: this.rows && rows.length ? rows.length : undefined,
        actions: [{ id: "ports-refresh", icon: UI("refresh"), label: "Refresh", onClick: (cx) => this.refresh(cx, true) }],
      }, t))
      .when(!this.error && !empty, (el) => el.child(this.sortRow(t)))
      .child(v_flex().id("ports-list").flex_1().min_h(0).overflow_y_scrollbar().px(SPACE.PX).pt(SPACE.GAP).pb(SPACE.PX).gap(16)
        .when(Boolean(this.error), (el) => el.child(emptyState({ id: "ports-error", tone: "error", title: "Could not read ports",
          body: firstLine(this.error) || "Try again in a moment.", action: { id: "ports-retry", label: "Retry", onClick: (cx) => this.refresh(cx, true) } }, t)))
        .when(!this.error && this.rows === null, (el) => el.child(div().py(8).text_size(TYPE.sm).text_color(metaColor(t)).child("Reading ports…")))
        .when(empty, (el) => el.child(emptyState({ id: "ports-empty", title: "No ports in use", body: "Nothing is listening on a TCP port." }, t)))
        .children(groups.map((g) => this.group(g, t))));
  }

  sortRow(t) {
    return h_flex().flex_none().px(SPACE.PX).py(SPACE.GAP).gap(SPACE.GAP).items_center()
      .child(div().text_size(TYPE.xs).text_color(metaColor(t)).child("Sort by"))
      .child(h_flex().flex_none().h(24).p(2).gap(2).rounded(6).border_1().border_color(t.border).bg(t.surface)
        .children(SORTS.filter(([key]) => key !== "cpu" || platformOf() !== "windows").map(([key, label]) => {
          const on = this.sort === key;
          const pick = (cx) => this.setSort(key, cx);
          return div().id(`sort-${key}`).px(10).h_full().flex().items_center().rounded(4).text_size(TYPE.xs).cursor_pointer()
            .role("button").tab_index(0).focus((s) => s.border_1().border_color(t.accent))
            .text_color(on ? t.foreground : metaColor(t, t.surface)).when(on, (el) => el.bg(t.selected))
            .hover((s) => s.text_color(t.foreground))
            .on_key_down((e, cx) => { if (e.key === "enter" || e.key === "space") { cx.stop_propagation(); pick(cx); } })
            .on_click((_e, cx) => pick(cx))
            .child(label);
        })));
  }

  group(g, t) {
    const n = g.procs.reduce((s, p) => s + p.ports.length, 0);
    const space = g.procs.find((p) => p.space)?.space;
    return v_flex().id(`group-${g.key || "system"}`).flex_none().gap(8)
      .child(h_flex().gap(8).items_center().min_w(0)
        .child(div().flex_none().text_size(TYPE.md).font_semibold().text_color(g.system || g.containers ? metaColor(t) : t.foreground).child(g.label))
        .child(h_flex().flex_none().gap(2).items_center().text_size(TYPE.xs).text_color(metaColor(t))
          .child(mono(div().child(String(n)))).child(div().child(`port${n === 1 ? "" : "s"}`)))
        .when(Boolean(g.cwd) && g.cwd !== g.label, (el) => el.child(mono(div().min_w(0).text_size(TYPE.xs).text_color(metaColor(t)).truncate().child(tailPath(g.cwd)))))
        .when(Boolean(space), (el) => el.child(div().min_w(0).max_w(160).truncate().px(6).py(2).rounded(4).bg(t.raised)
          .border_1().border_color(t.border).text_size(TYPE.xs).text_color(t.accent).child(`Herdr: ${space}`))))
      .children(g.procs.map((p) => this.card(p, t, g.system || g.containers)));
  }

  // A port chip. A web port opens its URL (the host follows the bind); db, debug and other ports
  // show their kind and do nothing on click. The bind shows when it isn't "*".
  chip(p, pid, t) {
    const wide = p.bind.startsWith("*:");
    const web = p.kind === "web";
    const url = web ? urlFor(p.hosts, p.port) : "";
    const label = web ? `Open ${url.replace(/^http:\/\//, "")}` : "Not a web page";
    const open = (cx) => { this.open(p); cx.notify(); };
    return h_flex().id(`port-${pid}-${p.port}`).flex_none().h(22).px(8).gap(6).items_center().rounded(4)
      .bg(t.raised).border_1().border_color(t.border)
      .accessibility_label(web ? label : `Port ${p.port}, ${p.kind}`).tooltip(label)
      .when(web, (el) => el.cursor_pointer().role("button").tab_index(0)
        .hover((s) => s.bg(t.hover).border_color(t.accent)).focus((s) => s.border_color(t.accent))
        .on_key_down((e, cx) => { if (e.key === "enter" || e.key === "space") { cx.stop_propagation(); open(cx); } })
        .on_click((_e, cx) => { cx.stop_propagation(); open(cx); }))
      .child(mono(div().text_size(TYPE.sm).font_semibold().child(`:${p.port}`)))
      .when(!wide, (el) => el.child(mono(div().text_size(TYPE.xs).text_color(metaColor(t, t.raised)).child(p.bind.replace(/:\d+$/, "")))))
      .child(div().text_size(TYPE.xs).text_color(metaColor(t, t.raised)).child(web ? "↗" : p.kind));
  }

  card(r, t, system) {
    const key = String(r.pid);
    const confirming = (this.confirm.get(key) ?? 0) > Date.now();
    const stopping = this.stopping.has(key);
    const rechecking = this.checkingStop.has(key);
    const res = this.result.get(key);
    const result = res && res.until > Date.now() ? RESULT_LABEL[res.verdict] : "";
    const selected = this.sel === key;
    const stoppable = canStop(r);
    const showStop = stoppable && (selected || this.hov === key || confirming || stopping) && !rechecking;
    // Inside a project group the folder is already the heading; System cards keep their cwd.
    // The third line is the program and folder, never its arguments.
    const where = system && r.cwd && r.cwd !== "/" ? `${tailPath(r.cwd)} · ` : "";
    const line = r.container ? r.container.meta : `${where}${r.exe ?? "unknown program"}`;
    const name = r.container ? r.container.label : r.name;
    const stopLabel = stopping ? "Stopping…" : confirming ? "Confirm stop" : "Stop";
    return h_flex().id(`card-${key}`).flex_none().items_start().gap(12).py(10).px(12).rounded(6)
      .bg(selected ? t.hover : t.surface).border_1().border_color(selected ? t.accent : t.border)
      .on_hover((h, cx) => { if (h ? this.hov !== key : this.hov === key) { this.hov = h ? key : null; cx.notify(); } })
      .on_click((_e, cx) => { this.sel = key; this.handle.focus?.(); cx.notify(); })
      .child(v_flex().flex_1().min_w(0).gap(6)
        .child(h_flex().gap(8).items_center().min_w(0)
          .child(div().id(`name-${key}`).font_semibold().truncate().when(Boolean(r.container?.tip), (el) => el.tooltip(r.container.tip)).child(name))
          .child(mono(div().flex_none().text_size(TYPE.xs).text_color(metaColor(t, selected ? t.hover : t.surface)).child(r.up ? `pid ${r.pid} · up ${r.up}` : `pid ${r.pid}`))))
        .child(h_flex().flex_wrap().gap(6).children(r.ports.map((p) => this.chip(p, r.pid, t))))
        .child(mono(div().text_size(TYPE.xs).text_color(metaColor(t, selected ? t.hover : t.surface)).truncate().child(line))))
      .child(h_flex().flex_none().gap(8).items_center().min_w(72).justify_end()
        .when(rechecking || Boolean(result), (el) => el.child(div().text_size(TYPE.xs).text_color(metaColor(t, selected ? t.hover : t.surface))
          .child(rechecking ? "Checking…" : result)))
        .when(showStop, (el) => el.child(button({ id: `stop-${key}`, label: stopLabel, kind: confirming ? "danger" : "secondary",
          disabled: stopping, onClick: (cx) => this.stop(r, cx) }, t))))
      .child(mono(v_flex().w(80).flex_none().items_end().gap(4).text_size(TYPE.sm)
        .child(div().text_right().child(fmtCpu(r.cpu)))
        .child(div().text_right().text_color(metaColor(t, selected ? t.hover : t.surface)).child(fmtMem(r.rss)))));
  }
}
