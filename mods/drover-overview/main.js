// Overview: every agent on every machine by state, and a card per machine with its
// CPU, memory, GPU and listening ports. A full page: place it in a layout block.
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { agents, spaces, panes, machines, terminals, theme, run, hc, notify, window, layout } from "herdr";
import { Host } from "./collect.js";
import { TYPE, mono, metaColor, panelHeader, sectionLabel, emptyState, button } from "./lib/panel-ui.js";
import { ago, visibleIn, groupRows, nextWake, snoozeAt, snoozePresets, settleValue, labelArgs, sendArgs } from "./parse.js";

const MOD = "drover-overview";
const TICK_MS = 5000; // metrics
const PORT_TICKS = 3; // ports every 15s
const IDLE_TICKS = 6; // window in the background: every 30s
const MAX_PORTS = 6;
const icon = (name, size) => svg(`mods/${MOD}/icons/${name}.svg`).size(size).flex_none();
const machineLabel = (name) => name ?? "Local";
const key = (name) => name ?? "";

const LABELS = { needs: "Needs you", done: "Done", working: "Working", idle: "Idle", snoozed: "Snoozed" };
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();

// The tab's name when someone named it, else the agent's own title, else its program.
function titleOf(a, tab) {
  if (tab?.named && tab.name) return tab.name;
  const live = clean(a.title);
  if (live && !/^[~/]/.test(live) && !live.includes("@")) return live;
  return a.program?.name || tab?.name || a.tab_name || a.address;
}

const programWord = (p) => (p?.key && p.key !== "program" && p.key !== "agent" ? p.key : p?.name ?? "");

// 0 ok, 1 warn, 2 high.
const level = (pct) => (pct >= 85 ? 2 : pct >= 60 ? 1 : 0);
const levelColor = (t, l) => (l === 2 ? t.ansi1 : l === 1 ? t.ansi3 : t.ansi2);

const programIcon = (p, size, color) => {
  if (!p?.icon) return div().size(size).flex_none();
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
};

function readJson(name, fallback) {
  try {
    return JSON.parse(localStorage.getItem(name) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}

export default class Overview extends View {
  init(_props, cx) {
    this.hosts = new Map(); // machine key -> Host
    this.shownHosts = ""; // what the cards last drew, to skip redraws that change nothing
    this.shownTimes = "";
    this.changed = readJson("changed", {}); // address -> { s, at }: when its state last changed
    this.folded = new Set(readJson("folded", []));
    this.snoozedOpen = readJson("snoozed-open", false);
    this.pending = { settled: {}, snoozed: {} }; // label values shown before the core reports them
    this.ui = null; // { address, kind: "reply" | "snooze", input? }: the one row with an open action
    this.hot = null; // address under the pointer
    this.wake = 0; // the next snooze to end
    this.keys = cx.focus_handle();
    this.ticks = 0;
    this.poll(cx, true);
    cx.timer.every(TICK_MS, (cx) => {
      this.ticks++;
      if (!visibleIn(layout(), MOD)) return;
      if (!window().active && this.ticks % IDLE_TICKS !== 0) return;
      this.poll(cx, this.ticks % PORT_TICKS === 0);
      // "2m" ages without anything else changing.
      if (this.timeSig(agents(), Date.now()) !== this.shownTimes || (this.wake && Date.now() >= this.wake)) cx.notify();
    });
  }

  host(name) {
    const k = key(name);
    if (!this.hosts.has(k)) this.hosts.set(k, new Host(name));
    return this.hosts.get(k);
  }

  // One task per machine: a slow remote never holds up this computer.
  poll(cx, withPorts) {
    for (const m of machines()) {
      if (m.temporary || (m.name != null && m.layout === "unavailable")) continue;
      const h = this.host(m.name);
      if (h.busy) continue;
      cx.spawn(async (cx) => {
        // A host that hasn't listed its ports yet asks on its first poll.
        const polled = await h.poll(withPorts || !h.portsTried);
        if (!polled) return;
        const sig = this.hostSig();
        if (sig === this.shownHosts) return;
        this.shownHosts = sig;
        cx.notify();
      });
    }
  }

  hostSig() {
    const r = (v) => (v == null ? "-" : Math.round(v));
    return [...this.hosts].map(([k, h]) => {
      const d = h.data;
      return `${k}|${r(d.cpu)}|${r(d.mem)}|${r(d.gpu)}|${r(d.vram)}|${(d.ports ?? []).map((p) => `${p.port}${p.name}`).join(",")}`;
    }).join(";");
  }

  timeSig(list, now) {
    return list.map((a) => `${a.address}:${ago(now - (this.changed[a.address]?.at ?? now))}`).join(",");
  }

  // Stamps agents whose state changed; done and idle count as one (looking turns done into idle).
  // A first-seen agent takes its tab's last change, not now.
  track(list, tabs, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      const had = this.changed[a.address];
      if (had?.s === s) continue;
      this.changed[a.address] = { s, at: had ? now : (tabs.get(a.tab)?.changed_at ?? now) };
      dirty = true;
    }
    if (!dirty) return;
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 7 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  toggleHost(k, cx) {
    this.folded.has(k) ? this.folded.delete(k) : this.folded.add(k);
    localStorage.setItem("folded", JSON.stringify([...this.folded]));
    cx.notify();
  }

  // One shape per state, readable without colour; only Needs you takes the attention colour.
  status(t, id) {
    if (id === "working") return icon("spinner", 11).text_color(t.muted).spin(900);
    if (id === "needs") return div().text_size(TYPE.xs).font_semibold().text_color(t.blocked).child("\u25B2");
    if (id === "done") return div().size(8).flex_none().rounded_full().bg(t.foreground);
    if (id === "snoozed") return div().text_size(TYPE.xs).text_color(metaColor(t)).child("z");
    return div().size(8).flex_none().rounded_full().border(1.5).border_color(t.dim);
  }

  // Shown at once; the core's label follows a moment later.
  setLabel(key, address, value, cx) {
    this.pending[key][address] = value;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await hc(labelArgs(address, key, value)).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) {
        delete this.pending[key][address];
        notify({ title: "Couldn't update the agent", body: (r.stderr ?? "").trim(), level: "error" });
      }
      cx.notify();
    });
  }

  focusAgent(a) {
    // The terminals are always on screen (no pages stack to switch back to); the side panel stays.
    run("pane.focus", { pane: a.pane });
  }

  openReply(address, cx) {
    const input = InputState.new({ placeholder: "Reply, Enter sends" });
    input.on("submit", (_e, cx) => this.sendReply(cx));
    this.ui = { address, kind: "reply", input };
    input.focus();
    cx.timer.after(60, () => { if (this.ui?.input === input) input.focus(); });
    cx.notify();
  }

  // Only from the person's Enter in the field.
  sendReply(cx) {
    const args = this.ui?.kind === "reply" ? sendArgs(this.ui.address, this.ui.input.value()) : null;
    if (!args) return;
    this.ui = null;
    cx.notify();
    cx.spawn(async () => {
      const r = await hc(args).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) notify({ title: "Couldn't send the reply", body: (r.stderr ?? "").trim(), level: "error" });
    });
  }

  replyKey(e, cx) {
    if (e.key !== "escape" || !this.ui) return;
    this.ui = null;
    cx.stop_propagation();
    cx.notify();
  }

  render() {
    const t = theme();
    const now = Date.now();
    const list = agents();
    const spaceList = spaces();
    const paneBranch = new Map(panes().map((p) => [p.pane, p.branch]));
    const spaceById = new Map(spaceList.map((s) => [s.id, s]));
    const tabs = new Map(spaceList.flatMap((s) => s.tabs.map((tab) => [tab.id, tab])));
    this.track(list, tabs, now);
    this.shownTimes = this.timeSig(list, now);

    const machineOf = (a) => spaceById.get(a.space)?.machine ?? (a.address.includes("/") ? a.address.split("/")[0] : null);
    const terms = new Map(terminals().map((k) => [k.address, k]));
    const label = (k, address) => {
      const live = terms.get(address)?.labels?.[k];
      if (this.pending[k][address] !== undefined && (live ?? "") === this.pending[k][address]) delete this.pending[k][address];
      return this.pending[k][address] ?? live ?? "";
    };
    if (this.ui && !list.some((a) => a.address === this.ui.address)) this.ui = null;
    const rows = list.map((a) => ({
      a,
      status: a.status,
      snooze: snoozeAt(label("snoozed", a.address)),
      settled: label("settled", a.address),
      turn: terms.get(a.address)?.turn ?? 0,
      title: titleOf(a, tabs.get(a.tab)),
      sub: [a.space_name, programWord(a.program)].filter(Boolean).join(" · "),
      branch: paneBranch.get(a.pane) || spaceById.get(a.space)?.branch || "",
      machine: machineOf(a),
      at: this.changed[a.address]?.at ?? now,
    }));
    const groups = groupRows(rows, now);
    this.wake = nextWake(rows, now);
    const count = (id) => groups.find((g) => g.id === id)?.rows.length ?? 0;
    const needs = count("needs");
    const done = count("done");
    const working = count("working");

    const hostList = machines().filter((m) => !m.temporary);
    const perMachine = new Map();
    for (const r of rows) perMachine.set(key(r.machine), (perMachine.get(key(r.machine)) ?? 0) + 1);

    // CPU at ~0 everywhere is noise: show it only when some host is doing something.
    const cpuBusy = [...this.hosts.values()].some((h) => (h.data?.cpu ?? 0) >= 0.1);
    const stat = (n, word, color) => h_flex().gap(4).items_center()
      .child(mono(div().text_size(TYPE.lg).font_semibold().when(Boolean(color), (el) => el.text_color(color))).child(String(n)))
      .child(div().text_size(TYPE.xs).text_color(metaColor(t)).child(word));

    return v_flex().id("overview").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(TYPE.sm)
      .child(panelHeader({ title: "Overview", meta: hostList.length, id: "ov-header" }, t))
      .child(h_flex().id("ov-summary").flex_none().px(12).py(8).gap(16).items_center()
        .child(stat(needs, "need you", needs ? t.blocked : undefined))
        .when(done > 0, (el) => el.child(stat(done, "done")))
        .when(working > 0, (el) => el.child(stat(working, "working"))))
      .child(v_flex().id("ov-body").flex_1().min_h(0).overflow_y_scrollbar().px(12).pt(2).pb(20)
        .child(h_flex().flex_none().px(4).gap(6).items_center()
          .child(sectionLabel("Hosts", t))
          .child(mono(div().pt(8).pb(4).text_size(TYPE.xs).text_color(metaColor(t))).child(String(hostList.length))))
        .child(h_flex().id("ov-hosts").flex_none().flex_wrap().items_start().gap(12).pt(6).pb(6)
          .children(hostList.map((m) => this.hostCard(t, m, perMachine.get(key(m.name)) ?? 0, cpuBusy))))
        .child(h_flex().flex_none().px(4).gap(6).items_center()
          .child(sectionLabel("Agents", t))
          .child(mono(div().pt(8).pb(4).text_size(TYPE.xs).text_color(metaColor(t))).child(String(rows.length))))
        .when(rows.length === 0, (el) => el.child(emptyState({ id: "ov-no-agents", title: "No agents yet",
          body: "Agents show up here once they report their status." }, t)))
        .children(groups.flatMap((g) => [
          this.groupHeader(t, g),
          ...(g.id === "snoozed" && !this.snoozedOpen ? [] : g.rows.map((r) => this.agentRow(t, g.id, r, now))),
        ])));
  }

  groupHeader(t, g) {
    const fold = g.id === "snoozed";
    return h_flex().id(`ov-g-${g.id}`).h(30).pt(10).px(4).flex_none().gap(6).items_center().text_size(TYPE.xs)
      .when(fold, (el) => el.cursor_pointer().on_click((_e, cx) => {
        this.snoozedOpen = !this.snoozedOpen;
        localStorage.setItem("snoozed-open", JSON.stringify(this.snoozedOpen));
        cx.notify();
      }).child(icon(this.snoozedOpen ? "chevron-down" : "chevron-right", 11).text_color(t.dim)))
      .child(div().font_semibold().text_color(g.id === "needs" ? t.blocked : t.muted).child(LABELS[g.id]))
      .child(mono(div().text_color(metaColor(t))).child(String(g.rows.length)));
  }

  button(t, id, text, act) {
    return button({ id, label: text, onClick: act }, t);
  }

  // Reply, Settle (a Done agent), Snooze (or Wake, when snoozed), or the snooze choices once Snooze is open.
  actions(t, section, a, now) {
    const id = (n) => `ov-${n}-${a.address}`;
    if (this.ui?.kind === "snooze" && this.ui.address === a.address) {
      return h_flex().gap(6).items_center().flex_none()
        .children(snoozePresets(now).map((p) => this.button(t, id(p.id), p.label, (cx) => {
          this.ui = null;
          this.setLabel("snoozed", a.address, String(p.at), cx);
        })))
        .child(this.button(t, id("snooze-x"), "Cancel", (cx) => { this.ui = null; cx.notify(); }));
    }
    return h_flex().gap(6).items_center().flex_none()
      .child(this.button(t, id("reply"), "Reply", (cx) => this.openReply(a.address, cx)))
      .when(section === "done", (el) => el.child(this.button(t, id("settle"), "Settle", (cx) => {
        this.setLabel("settled", a.address, settleValue(Date.now(), this.turnOf(a.address)), cx);
      })))
      .child(section === "snoozed"
        ? this.button(t, id("wake"), "Wake", (cx) => this.setLabel("snoozed", a.address, "", cx))
        : this.button(t, id("snooze"), "Snooze", (cx) => { this.ui = { address: a.address, kind: "snooze" }; cx.notify(); }));
  }

  turnOf(address) {
    return terminals().find((k) => k.address === address)?.turn ?? 0;
  }

  replyRow(t, section, r) {
    const { a } = r;
    return h_flex().id(`ov-a-${a.address}`).h(44).px(6).flex_none().gap(10).items_center().rounded(6).bg(t.selected)
      .track_focus(this.keys).on_key_down((e, cx) => this.replyKey(e, cx))
      .child(h_flex().w(14).flex_none().justify_center().child(this.status(t, section)))
      .child(programIcon(a.program, 16, t.foreground))
      .child(div().w(220).flex_none().truncate().font_semibold().child(r.title))
      .child(h_flex().flex_1().min_w(0).h(28).px(8).items_center().rounded(6).border(1).border_color(t.border).bg(t.input)
        .child(Input.new(this.ui.input).flex_1().h_full().text_size(TYPE.sm).text_color(t.foreground)))
      .child(div().flex_none().text_size(TYPE.xs).text_color(metaColor(t)).child("Enter sends \u00B7 Esc cancels"));
  }

  agentRow(t, section, r, now) {
    const { a } = r;
    if (this.ui?.address === a.address && this.ui.kind === "reply") return this.replyRow(t, section, r);
    const quiet = section === "idle" || section === "snoozed";
    const open = this.ui?.address === a.address && this.ui.kind === "snooze";
    const showActions = open || this.hot === a.address || a.focused;
    const sub = section === "snoozed" ? [r.sub, `back ${clock(r.snooze)}`].filter(Boolean).join(" \u00B7 ") : r.sub;
    return h_flex().id(`ov-a-${a.address}`).h(44).px(6).flex_none().gap(10).items_center().rounded(6)
      .when(a.focused, (el) => el.bg(t.selected))
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_hover((on, cx) => {
        if (on) this.hot = a.address;
        else if (this.hot === a.address) this.hot = null;
        cx.notify();
      })
      .on_click(() => this.focusAgent(a))
      .child(h_flex().w(14).flex_none().justify_center().child(this.status(t, section)))
      .child(programIcon(a.program, 16, t.foreground))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().font_medium().text_color(quiet ? t.muted : t.foreground).child(r.title))
        .child(div().truncate().text_size(TYPE.xs).text_color(metaColor(t)).child(sub)))
      .child(showActions
        ? h_flex().flex_none().justify_end().child(this.actions(t, section, a, now))
        : mono(div().max_w(140).min_w(0).flex_shrink(1).truncate().text_size(TYPE.xs).text_color(metaColor(t))).child(r.branch))
      .when(r.machine != null && !showActions, (el) => el.child(h_flex().max_w(100).min_w(0).flex_shrink(1).gap(4).items_center().text_size(TYPE.xs).text_color(metaColor(t))
        .child(icon("monitor", 12))
        .child(mono(div().min_w(0).truncate()).child(machineLabel(r.machine)))))
      .child(mono(div().w(40).flex_none().text_right().text_size(TYPE.xs).text_color(metaColor(t))).child(ago(now - r.at)));
  }

  hostCard(t, m, count, cpuBusy) {
    const k = key(m.name);
    const open = !this.folded.has(k);
    const d = this.hosts.get(k)?.data ?? {};
    const conn = m.name == null || m.layout === "ready" ? t.ansi2 : m.layout === "loading" ? t.ansi3 : t.ansi1;
    const meters = [["CPU", d.cpu], ["MEM", d.mem], ["GPU", d.gpu], ["VRAM", d.vram]].filter(([label, v]) => v != null && (label !== "CPU" || cpuBusy));
    const ports = d.ports ?? [];
    return v_flex().flex_1().min_w(240).p(12).gap(6).rounded(6).bg(t.surface).border(1).border_color(t.border)
      .child(h_flex().id(`ov-h-${k || "local"}`).gap(6).items_center().cursor_pointer()
        .on_click((_e, cx) => this.toggleHost(k, cx))
        .child(icon(open ? "chevron-down" : "chevron-right", 11).text_color(t.dim))
        .child(div().size(8).flex_none().rounded_full().bg(conn))
        .child(mono(div().flex_1().min_w(0).truncate().font_semibold()).child(machineLabel(m.name))))
      .child(div().text_size(TYPE.xs).text_color(metaColor(t))
        .child(m.name != null && m.layout === "unavailable" ? "unavailable" : `${count} agent${count === 1 ? "" : "s"}`))
      .when(open, (el) => el
        .children(meters.map(([label, v]) => this.meter(t, label, v)))
        .when(ports.length > 0, (el) => el.child(h_flex().flex_wrap().gap(6).pt(2)
          .children(ports.slice(0, MAX_PORTS).map((p) => mono(div().max_w(272).truncate().px(6).h(20).flex().items_center().rounded(4)
            .border(1).border_color(t.border).text_size(TYPE.xs).text_color(metaColor(t))
            .child(p.name ? `:${p.port} ${p.name}` : `:${p.port}`))))
          .when(ports.length > MAX_PORTS, (el) => el.child(mono(div().h(20).px(2).flex().items_center().text_size(TYPE.xs).text_color(metaColor(t)))
            .child(`+${ports.length - MAX_PORTS}`))))));
  }

  meter(t, label, v) {
    return h_flex().h(18).gap(8).items_center().text_size(TYPE.xs)
      .child(div().w(34).flex_none().text_color(metaColor(t)).child(label))
      .child(div().flex_1().h(4).rounded(2).bg(t.raised)
        .child(div().h_full().w(`${Math.max(1, Math.round(v))}%`).rounded(2).bg(levelColor(t, level(v)))))
      .child(mono(div().w(36).flex_none().text_right().text_color(metaColor(t))).child(`${Math.round(v)}%`));
  }
}
