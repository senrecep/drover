// Ports: every listening TCP port on this computer, with its process, the Herdr
// space it runs in, and Open / Stop. A full-page view; place "none".
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, hc, home, spaces, terminals, theme, window } from "herdr";
import { TYPE, SPACE, mono, metaColor, panelHeader, emptyState, button } from "./lib/panel-ui.js";
import {
  parseLsof, parsePs, parsePpid, parseCwd, parsePids, fmtEtime, fmtMem, fmtCpu,
  tildify, folderName, friendlyName, findOwner, groupRows, canStop, killArgs,
} from "./parse.js";

const TICK_MS = 15000;
const CONFIRM_MS = 4000;
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
    this.sel = null; // keyboard cursor: pid key
    this.hov = null; // hovered card: pid key
    this.handle = cx.focus_handle();
    this.order = [];
    this.shells = new Map(); // address -> { pid, space, parent }
    this.refresh(cx);
    cx.timer.every(TICK_MS, (cx) => {
      if (window().active) this.refresh(cx);
    });
  }

  refresh(cx, force = false) {
    if (this.busy) return;
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
      const sig = JSON.stringify([error, rows]);
      if (force || sig !== this.sig) {
        this.sig = sig;
        this.rows = rows ?? this.rows;
        this.error = error;
        cx.notify();
      }
    });
  }

  async read() {
    const ls = await exec("lsof", ["-iTCP", "-sTCP:LISTEN", "-nP"]);
    if (ls.code !== 0 && ls.stdout.trim()) throw new Error(ls.stderr || "lsof failed");
    if (ls.code !== 0 && ls.code !== 1) throw new Error(ls.stderr || "lsof failed");
    const ports = parseLsof(ls.stdout);
    if (!ports.length) return [];
    const pids = [...new Set(ports.map((p) => p.pid))].join(",");
    const [ps, cwd, tree] = await Promise.all([
      exec("ps", ["-ww", "-o", "pid=,pcpu=,rss=,etime=,command=", "-p", pids]),
      exec("lsof", ["-a", "-d", "cwd", "-p", pids, "-Fn"]).catch(() => null),
      exec("ps", ["-axo", "pid=,ppid="]).catch(() => null),
    ]);
    const procs = parsePs(ps.stdout);
    const cwds = parseCwd(cwd?.stdout);
    const ppids = parsePpid(tree?.stdout);
    const owners = await this.shellOwners(ppids);
    const h = home();
    return ports
      .filter((p) => procs.has(p.pid))
      .map((p) => {
        const pr = procs.get(p.pid);
        const dir = cwds.get(p.pid) ?? "";
        const spaceId = findOwner(p.pid, ppids, owners);
        return {
          pid: p.pid, port: p.port, bind: p.bind,
          name: friendlyName(pr.command, p.command),
          cpu: pr.cpu, rss: pr.rss, up: fmtEtime(pr.etime), command: pr.command,
          folder: dir ? folderName(dir, h) : "", cwd: tildify(dir, h), fullCwd: dir,
          space: spaceId ? spaces().find((s) => s.id === spaceId)?.name ?? null : null,
        };
      });
  }

  // Map of each local Herdr terminal's shell pid -> its space id.
  async shellOwners(ppids) {
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

  open(port) {
    exec("open", [`http://localhost:${port}`]).catch(() => null);
  }

  stop(proc, cx) {
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
    this.stopping.add(key);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        // Re-check just before signalling: only this pid, still listening on one of its ports.
        const ports = proc.ports.map((p) => p.port);
        const r = await exec("lsof", ["-nP", "-a", "-p", String(proc.pid), `-iTCP:${ports.join(",")}`, "-sTCP:LISTEN", "-t"]).catch(() => null);
        if (canStop(proc.pid, ports[0], parsePids(r?.stdout))) await exec("kill", killArgs(proc.pid)).catch(() => null);
      } finally {
        this.stopping.delete(key);
        this.refresh(cx, true);
      }
    });
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
      if (p?.ports?.length) { this.open(p.ports[0].port); cx.stop_propagation(); }
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
        .children(SORTS.map(([key, label]) => {
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
        .child(div().flex_none().text_size(TYPE.md).font_semibold().text_color(g.system ? metaColor(t) : t.foreground).child(g.label))
        .child(h_flex().flex_none().gap(2).items_center().text_size(TYPE.xs).text_color(metaColor(t))
          .child(mono(div().child(String(n)))).child(div().child(`port${n === 1 ? "" : "s"}`)))
        .when(Boolean(g.cwd) && g.cwd !== g.label, (el) => el.child(mono(div().min_w(0).text_size(TYPE.xs).text_color(metaColor(t)).truncate().child(tailPath(g.cwd)))))
        .when(Boolean(space), (el) => el.child(div().min_w(0).max_w(160).truncate().px(6).py(2).rounded(4).bg(t.raised)
          .border_1().border_color(t.border).text_size(TYPE.xs).text_color(t.accent).child(`Herdr: ${space}`))))
      .children(g.procs.map((p) => this.card(p, t, g.system)));
  }

  // A port chip: click opens http://localhost:PORT; the bind shows when it isn't "*".
  chip(p, pid, t) {
    const wide = p.bind.startsWith("*:");
    const open = (cx) => { this.open(p.port); cx.notify(); };
    return h_flex().id(`port-${pid}-${p.port}`).flex_none().h(22).px(8).gap(6).items_center().rounded(4)
      .bg(t.raised).border_1().border_color(t.border).cursor_pointer()
      .role("button").accessibility_label(`Open localhost:${p.port}`).tooltip(`Open localhost:${p.port}`).tab_index(0)
      .hover((s) => s.bg(t.hover).border_color(t.accent)).focus((s) => s.border_color(t.accent))
      .on_key_down((e, cx) => { if (e.key === "enter" || e.key === "space") { cx.stop_propagation(); open(cx); } })
      .on_click((_e, cx) => { cx.stop_propagation(); open(cx); })
      .child(mono(div().text_size(TYPE.sm).font_semibold().child(`:${p.port}`)))
      .when(!wide, (el) => el.child(mono(div().text_size(TYPE.xs).text_color(metaColor(t, t.raised)).child(p.bind.replace(/:\d+$/, "")))))
      .child(div().text_size(TYPE.xs).text_color(metaColor(t, t.raised)).child("↗"));
  }

  card(r, t, system) {
    const key = String(r.pid);
    const confirming = (this.confirm.get(key) ?? 0) > Date.now();
    const stopping = this.stopping.has(key);
    const selected = this.sel === key;
    const showStop = selected || this.hov === key || confirming || stopping;
    // Inside a project group the folder is already the heading; System cards keep their cwd.
    const where = system && r.cwd && r.cwd !== "/" ? `${tailPath(r.cwd)} · ` : "";
    const stopLabel = stopping ? "Stopping…" : confirming ? "Confirm stop" : "Stop";
    return h_flex().id(`card-${key}`).flex_none().items_start().gap(12).py(10).px(12).rounded(6)
      .bg(selected ? t.hover : t.surface).border_1().border_color(selected ? t.accent : t.border)
      .on_hover((h, cx) => { if (h ? this.hov !== key : this.hov === key) { this.hov = h ? key : null; cx.notify(); } })
      .on_click((_e, cx) => { this.sel = key; this.handle.focus?.(); cx.notify(); })
      .child(v_flex().flex_1().min_w(0).gap(6)
        .child(h_flex().gap(8).items_center().min_w(0)
          .child(div().font_semibold().truncate().child(r.name))
          .child(mono(div().flex_none().text_size(TYPE.xs).text_color(metaColor(t, selected ? t.hover : t.surface)).child(`pid ${r.pid} · up ${r.up}`))))
        .child(h_flex().flex_wrap().gap(6).children(r.ports.map((p) => this.chip(p, r.pid, t))))
        .child(mono(div().text_size(TYPE.xs).text_color(metaColor(t, selected ? t.hover : t.surface)).truncate().child(`${where}${r.command}`))))
      .child(h_flex().flex_none().gap(8).items_center().min_w(72).justify_end()
        .when(showStop, (el) => el.child(button({ id: `stop-${key}`, label: stopLabel, kind: confirming ? "danger" : "secondary",
          disabled: stopping, onClick: (cx) => this.stop(r, cx) }, t))))
      .child(mono(v_flex().w(80).flex_none().items_end().gap(4).text_size(TYPE.sm)
        .child(div().text_right().child(fmtCpu(r.cpu)))
        .child(div().text_right().text_color(metaColor(t, selected ? t.hover : t.surface)).child(fmtMem(r.rss)))));
  }
}
