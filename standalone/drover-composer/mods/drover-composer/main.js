// Composer: write one message and send it to a terminal or to several agents at once
// (`hc send`, as if pasted and Enter pressed). Opens as a window (mod.open drover-composer).
//
// The terminal that had the keyboard is read once, when the composer opens: once the composer
// has the keyboard, "focused" would mean the composer. Blocked agents are skipped (a message would
// answer their question). Nothing typed here is stored: no history, no draft on disk.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, TextareaState, Textarea } from "gpui-base";
import { exec, agents, panes, focused, theme, props, closeOverlay, window } from "herdr";
import { TYPE, SPACE, mono, metaColor, button, iconButton, chip } from "./lib/panel-ui.js";
import {
  MODES, modeOf, candidates, targetsFor, split, pending, armKey, sendable, sendArgv, outcome, sendLabel, needsConfirm, ARM_MS, sendPressed, sendHint,
} from "./lib/compose.js";

const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const SEND_TIMEOUT_MS = 90000; // hc send waits while the person has an unfinished draft there

export default class Composer extends View {
  init(p, cx) {
    const pr = props() ?? p ?? {};
    this.overlay = pr.overlay ?? null;
    this.opened = focused()?.terminal ?? null;
    this.mode = this.opened ? "focused" : "idle";
    this.picked = new Set(this.opened ? [this.opened] : []);
    this.armed = null; // { key, until }: the exact targets a first click armed
    this.sending = false;
    this.results = new Map(); // address -> { state: "waiting" | "ok" | "error", message }
    this.delivered = new Set(); // addresses that already got `deliveredText` (a retry skips them)
    this.deliveredText = null;
    this.note = "";
    this.text = "";
    this.platform = window()?.platform ?? "macos";
    this.input = TextareaState.new({ placeholder: `Message. ${sendHint(this.platform)} sends, Esc closes` });
    this.input.set_auto_grow(3, 12);
    this.input.on("change", (_e, cx) => {
      const next = this.input.value();
      // `delivered` is tied to its text, not cleared here: typing and undoing mid-send keeps it.
      if (next !== this.text) { this.text = next; this.fresh(); if (!this.sending) this.results.clear(); }
      cx.notify();
    });
    this.input.focus();
    cx.timer.after(400, () => this.input.focus());
  }

  // Not `close`: that name is the host's own teardown hook on a View.
  // Only a window closes itself; a copy a layout places is the layout's to remove.
  overlayId() { return props()?.overlay ?? this.overlay; }
  dismiss() {
    const id = this.overlayId();
    if (id) closeOverlay(id);
  }

  // Anything the person changes disarms a pending confirm and drops the last send's note.
  fresh() {
    this.armed = null;
    if (!this.sending) this.note = "";
  }

  list() {
    return candidates({ agents: agents(), panes: panes(), opened: this.opened });
  }

  /** What a send would type into now: chosen, not blocked, not already given this message. */
  plan() {
    const { send, skip } = split(targetsFor(this.mode, this.list(), this.picked));
    const left = this.deliveredText === this.text ? pending(send, this.delivered) : send;
    return { send: left, skip, already: send.length - left.length };
  }

  isArmed(send) {
    return Boolean(this.armed) && Date.now() <= this.armed.until && this.armed.key === armKey(send);
  }

  setMode(id, cx) {
    this.mode = modeOf(id).id;
    this.fresh();
    cx.notify();
  }

  toggle(address, cx) {
    if (this.picked.has(address)) this.picked.delete(address);
    else this.picked.add(address);
    this.mode = "pick";
    this.fresh();
    cx.notify();
  }

  send(cx) {
    if (this.sending || !sendable(this.text)) return;
    const { send } = this.plan();
    if (!send.length) return;
    // Several targets ask twice, and the second click must confirm the same set the first armed.
    if (needsConfirm(send.length) && !this.isArmed(send)) {
      this.armed = { key: armKey(send), until: Date.now() + ARM_MS };
      cx.timer.after(ARM_MS + 50, (cx) => cx.notify());
      cx.notify();
      return;
    }
    this.armed = null;
    this.sending = true;
    this.note = "";
    const text = this.text;
    if (this.deliveredText !== text) { this.delivered.clear(); this.deliveredText = text; }
    for (const c of send) this.results.set(c.address, { state: "waiting", message: "Waiting for its draft to clear" });
    cx.notify();
    cx.spawn(async (cx) => {
      let failed = 0;
      await Promise.all(send.map(async (c) => {
        let r;
        try { r = outcome(await exec("hc", sendArgv(c.address, text), { timeout: SEND_TIMEOUT_MS })); }
        catch (e) { r = { ok: false, message: String(e?.message ?? e).split("\n")[0].slice(0, 140) || "Send failed" }; }
        if (r.ok) this.delivered.add(c.address);
        if (!r.ok) failed++;
        this.results.set(c.address, { state: r.ok ? "ok" : "error", message: r.message });
        cx.notify();
      }));
      this.sending = false;
      if (failed) {
        this.note = `${failed} of ${send.length} not sent.` + (this.text === text
          ? ` Send again retries only ${failed === 1 ? "that one" : "those"}` : "");
      } else if (this.input.value() === text) {
        // Cleared only when the box still holds what was sent: nothing typed meanwhile is lost.
        const n = Math.max(this.delivered.size, send.length); // a retry counts the earlier ones too
        this.text = ""; // before set_value, in case it emits "change" at once
        this.delivered.clear();
        this.deliveredText = null;
        this.input.set_value("");
        this.note = n === 1 ? "Sent" : `Sent to ${n} terminals`;
      } else {
        this.note = send.length === 1 ? "Sent" : `Sent to ${send.length} terminals`;
      }
      cx.notify();
    });
  }

  key(e, cx) {
    if (e.key === "escape") { this.dismiss(); cx.stop_propagation(); return; }
    // A held key repeats: only a fresh press may send (or confirm a send to several).
    if (e.key === "enter" && sendPressed(e.modifiers, window()?.platform ?? this.platform)) { if (!e.is_held) this.send(cx); cx.stop_propagation(); }
  }

  // ---------- render ----------

  modeTab(m, t, cx) {
    const on = m.id === this.mode;
    return h_flex().id(`mode-${m.id}`).h(24).px(8).flex_none().items_center().rounded(6).cursor_pointer()
      .role("tab").accessibility_label(m.label).tab_index(0)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => this.setMode(m.id, cx))
      .child(div().text_size(TYPE.sm).font_medium().text_color(on ? t.foreground : metaColor(t, t.popover ?? t.background)).child(m.label));
  }

  targetRow(c, t, chosen) {
    const res = this.results.get(c.address);
    const blocked = c.status === "blocked";
    const pick = this.mode === "pick";
    const dot = c.status && c.status !== "idle"
      ? div().size(c.status === "blocked" ? 8 : 6).flex_none().rounded(4).bg(t[c.status] ?? t.unknown)
      : div().size(6).flex_none();
    const state = res
      ? res.state === "waiting"
        ? div().flex_none().text_size(TYPE.xs).text_color(metaColor(t)).accessibility_label(res.message)
          .frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)
        : div().flex_none().max_w(200).truncate().text_size(TYPE.xs)
          .text_color(res.state === "ok" ? t.done : t.blocked).tooltip(res.message).child(res.message)
      : blocked && chosen
        ? div().flex_none().text_size(TYPE.xs).text_color(t.blocked).child("Skipped: needs you")
        : null;
    const label = `${c.name}${c.where ? `, ${c.where}` : ""}${c.opened ? ", focused" : ""}`;
    return h_flex().id(`target-${c.address}`).h(SPACE.ROW_H).px(8).gap(8).flex_none().items_center().rounded(6)
      .accessibility_label(label)
      .when(pick, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).role("check_box").tab_index(0)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => this.toggle(c.address, cx)))
      .child(div().size(14).flex_none().flex().items_center().justify_center().rounded(3).border_1()
        .border_color(chosen ? t.accent : t.input).when(chosen, (el) => el.bg(t.accent))
        .when(chosen, (el) => el.child(svg(ICON("check")).size(10).text_color(t.accent_foreground ?? t.background))))
      .child(dot)
      .child(div().flex_none().text_size(TYPE.sm).text_color(chosen ? t.foreground : metaColor(t)).child(c.name))
      .child(div().flex_1().min_w(0).truncate().text_size(TYPE.xs).text_color(metaColor(t)).child(c.where))
      .when(c.opened, (el) => el.child(chip("focused", t)))
      .when(Boolean(state), (el) => el.child(state));
  }

  render(cx) {
    const t = theme();
    const list = this.list();
    const chosen = targetsFor(this.mode, list, this.picked);
    const chosenSet = new Set(chosen.map((c) => c.address));
    const { send, skip, already } = this.plan();
    const armed = this.isArmed(send);
    const ready = sendable(this.text) && send.length > 0 && !this.sending;
    const why = !list.length ? "No terminals or agents to send to"
      : !send.length ? (already ? "Already sent there" : skip.length ? "Every chosen agent needs you first" : "Choose where to send")
      : !sendable(this.text) ? "Write a message" : "";
    const summary = this.note || (this.sending ? "Sending…" : why
      || `${send.length === 1 ? "1 terminal" : `${send.length} terminals`}${skip.length ? `, ${skip.length} skipped` : ""}${already ? `, ${already} already sent` : ""}`);

    return v_flex().id("drover-composer").w_full().bg(t.popover ?? t.background).text_color(t.foreground)
      .on_key_down((e, cx) => this.key(e, cx))
      // Header: also the window's grip (presses on the controls below don't drag).
      .child(h_flex().id("composer-header").h(SPACE.HEADER_H).flex_none().px(SPACE.PX).gap(SPACE.GAP).items_center()
        .border_b_1().border_color(t.border).role("toolbar").accessibility_label("Composer")
        .child(div().flex_none().text_size(TYPE.md).font_semibold().child("Composer"))
        .child(div().flex_1().min_w(0))
        .when(Boolean(this.overlayId()), (el) => el.child(
          iconButton({ id: "composer-close", icon: ICON("x"), label: "Close (Esc)", onClick: () => this.dismiss() }, t))))
      .child(v_flex().p(SPACE.PX).gap(SPACE.GAP)
        .child(div().id("composer-input").w_full().rounded(6).border_1().border_color(t.input).bg(t.background)
          .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.input.focus(); })
          .child(Textarea.new(this.input).w_full().px(8).py(6).text_size(TYPE.md).text_color(t.foreground)))
        .child(h_flex().id("composer-modes").gap(2).items_center().role("tab_list").accessibility_label("Send to")
          .child(div().flex_none().pr(6).text_size(TYPE.xs).font_semibold().text_color(metaColor(t)).child("Send to"))
          .children(MODES.map((m) => this.modeTab(m, t, cx))))
        .child(v_flex().id("composer-targets").max_h(220).overflow_y_scroll().gap(1)
          .when(!list.length, (el) => el.child(div().py(6).text_size(TYPE.sm).text_color(metaColor(t))
            .child("No agents are running, and no terminal had the keyboard.")))
          .children(list.map((c) => this.targetRow(c, t, chosenSet.has(c.address))))))
      .child(h_flex().id("composer-footer").h(44).flex_none().px(SPACE.PX).gap(SPACE.GAP).items_center()
        .border_t_1().border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(TYPE.xs).text_color(metaColor(t)).role("status")
          .accessibility_label(summary).child(summary))
        .child(button({
          id: "composer-send",
          label: sendLabel(send.length, armed),
          kind: armed ? "danger" : "primary",
          disabled: !ready,
          tooltip: armed ? "Click again to send" : sendHint(window()?.platform ?? this.platform),
          onClick: (cx) => this.send(cx),
        }, t)));
  }
}
