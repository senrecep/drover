// Pane arrangements: equalize the focused tab's splits, apply a preset, or save
// the tab's split shape under a name and apply it later.
//
// Two kinds of copy:
// - a layout block (any size, a 0 px block in the status row is enough): runs
//   the key commands drover-arrange.<command> (equalize, open, save, and the
//   preset keys two-columns, three-columns, main-stack, grid). Draws nothing.
// - an overlay (mod.open drover-arrange, or one the block opens): the popup.
//
// The tab's split tree is read from herdr-core's "herdr-app" document
// (`hc connect`, doc.get; read only). Changes go through app commands only:
// pane.split to add panes, layout.resize to size them. Nothing is closed and
// nothing is typed into a running program.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  run, props, focused, panes, theme, notify, exec, hc, appHome, nextCommand,
  openOverlay, closeOverlay, readTextFile, writeTextFile, window,
} from "herdr";
import * as fs from "fs/promises";
import {
  parseRpc, findTabRoot, normalise, leaves, countPanes, toShape, describe, PRESETS,
  equalizeOps, nextSplit, resizePlan, summary, cleanName, readStore, writeStore, upsert, rename, remove, missingTool,
} from "./logic.js";

const MOD = "drover-arrange";
const CONFIRM_MS = 4000;
const MAX_STEPS = 40;
const DIR = () => `${appHome()}/data/${MOD}`;
const FILE = () => `${DIR()}/arrangements.json`;
const DOC_GET = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "doc.get", params: { name: "herdr-app" } });

// --- the tab -------------------------------------------------------------------

/** The focused tab's id, or throws a sentence for people. */
function targetTab() {
  const f = focused();
  if (!f?.tab) throw new Error("No tab is focused.");
  if (f.tab.includes("/")) throw new Error("Tabs on other machines aren't supported yet.");
  return f.tab;
}

async function readLive(tab) {
  let r;
  try {
    r = await exec("sh", ["-c", 'command -v hc >/dev/null || PATH="$HOME/.local/bin:$PATH"; printf "%s\\n" "$1" | hc connect', "sh", DOC_GET], { timeout: 10000 });
  } catch (e) {
    throw new Error(missingTool(e, "sh", window()?.platform ?? "macos") ?? String(e?.message ?? e));
  }
  const root = findTabRoot(parseRpc(r.stdout)?.value, tab);
  if (!root) throw new Error("Couldn't find this tab in herdr-core's layout.");
  const live = normalise(root);
  if (!live) throw new Error("This tab has no panes.");
  return live;
}

function resizeAll(ops) {
  for (const op of ops) run("layout.resize", { id: op.id, weight: op.weight });
}

async function equalize() {
  const ops = equalizeOps(await readLive(targetTab()));
  resizeAll(ops);
  return ops.length ? "Splits equalized." : "Already equal.";
}

/** Splits until the tab has the shape (or can't get closer), then sizes it. */
async function applyShape(cx, shape, programs) {
  const tab = targetTab();
  let live = await readLive(tab);
  let created = 0;
  let started = 0;
  let stopped = "";
  for (let i = 0; i < MAX_STEPS; i++) {
    const step = nextSplit(live, shape, { programs });
    if (!step) break;
    const before = countPanes(live);
    const args = { pane: step.pane, direction: step.direction };
    if (step.argv) args.argv = step.argv;
    run("pane.split", args);
    let next = live;
    for (let tries = 0; tries < 20 && countPanes(next) <= before; tries++) {
      await cx.sleep(100);
      next = await readLive(tab);
    }
    if (countPanes(next) <= before) {
      stopped = "a split didn't happen, so it stopped there";
      break;
    }
    created += 1;
    if (step.argv) started += 1;
    live = next;
  }
  const plan = resizePlan(live, shape);
  resizeAll(plan.ops);
  return summary({ created, started, notes: plan.notes, stopped });
}

/** The saved command of each pane: what it was started with, never a plain shell. */
async function argvOf(live) {
  const shells = new Set(panes().filter((p) => p.program?.shell).map((p) => p.pane));
  const out = new Map();
  for (const leaf of leaves(live)) {
    if (!leaf.terminal || shells.has(leaf.id)) continue;
    try {
      const r = await hc(["get", leaf.terminal, "--json"]);
      const argv = JSON.parse(r.stdout)?.argv;
      if (Array.isArray(argv) && argv.length) out.set(leaf.id, argv);
    } catch {
      // Not readable: saved without a command.
    }
  }
  return out;
}

// --- storage -------------------------------------------------------------------

async function loadList() {
  return readStore(await readTextFile(FILE()));
}

/** Read, change, write with the read text as the expected snapshot; one retry. */
async function mutate(change) {
  await fs.mkdir(DIR(), { recursive: true }).catch(() => {});
  for (let attempt = 0; ; attempt++) {
    const raw = await readTextFile(FILE());
    const result = change(readStore(raw));
    if (result.error) throw new Error(result.error);
    try {
      await writeTextFile(FILE(), writeStore(result.list), raw);
      return result.list;
    } catch (e) {
      if (attempt >= 1) throw e;
    }
  }
}

// --- the view ------------------------------------------------------------------

export default class Arrange extends View {
  init(p, cx) {
    this.overlay = (p ?? props())?.overlay ?? null;
    if (!this.overlay) return this.initBlock(cx);
    this.mode = (p ?? props())?.mode === "save" ? "save" : "list";
    this.list = [];
    this.message = "";
    this.error = false;
    this.busy = false;
    this.confirm = null; // { name, until }
    this.renaming = null;
    this.programs = false;
    this.handle = cx.focus_handle();
    this.nameInput = InputState.new({ placeholder: "Name" });
    this.nameInput.on("submit", (_e, cx) => this.save(cx));
    this.renameInput = InputState.new({});
    this.renameInput.on("submit", (_e, cx) => this.finishRename(cx));
    this.focusMode();
    cx.timer.after(300, () => this.focusMode());
    cx.spawn(async (cx) => {
      try {
        this.list = await loadList();
      } catch (e) {
        this.say(String(e?.message ?? e), true);
      }
      cx.notify();
    });
  }

  // A layout copy: key commands only.
  initBlock(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const command = String(await nextCommand());
        if (command === "open") openOverlay({ mod: MOD, kind: "dialog", width: 440, height: 480 });
        else if (command === "save") openOverlay({ mod: MOD, kind: "dialog", width: 400, height: 230, props: { mode: "save" } });
        else if (command === "equalize") await report(() => equalize(), false);
        else {
          const preset = PRESETS.find((p) => p.key === command);
          if (preset) await report(() => applyShape(cx, preset.shape, false), true);
        }
      }
    });
  }

  focusMode() {
    if (this.mode === "save") this.nameInput.focus();
    else if (this.renaming) this.renameInput.focus();
    else this.handle.focus();
  }

  say(text, error = false) {
    this.message = text;
    this.error = error;
  }

  /** Runs one action at a time and shows its result. */
  act(cx, work) {
    if (this.busy) return;
    this.busy = true;
    this.say("Working…");
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.say(await work(cx));
      } catch (e) {
        this.say(String(e?.message ?? e), true);
      }
      this.busy = false;
      cx.notify();
    });
  }

  save(cx) {
    const name = cleanName(this.nameInput.value());
    if (!name) {
      this.say("Give it a name.", true);
      cx.notify();
      return;
    }
    const programs = this.programs;
    this.act(cx, async () => {
      const live = await readLive(targetTab());
      if (live.type === "pane") throw new Error("This tab has one pane: nothing to save.");
      const commands = programs ? await argvOf(live) : new Map();
      const shape = toShape(live, (leaf) => commands.get(leaf.id) ?? null);
      const existed = this.list.some((a) => a.name === name);
      this.list = await mutate((list) => ({ list: upsert(list, { name, shape, saved: Date.now() }) }));
      this.mode = "list";
      this.nameInput.set_value("");
      this.focusMode();
      return `${existed ? "Replaced" : "Saved"} “${name}”: ${describe(shape)}.`;
    });
  }

  startRename(name) {
    this.renaming = name;
    this.renameInput.set_value(name);
    this.renameInput.set_selected_range({ start: 0, end: name.length });
    this.renameInput.focus();
  }

  finishRename(cx) {
    const from = this.renaming;
    const to = cleanName(this.renameInput.value());
    this.act(cx, async () => {
      this.list = await mutate((list) => rename(list, from, to));
      this.renaming = null;
      this.focusMode();
      return to === from ? "" : `Renamed to “${to}”.`;
    });
  }

  remove(cx, name) {
    const c = this.confirm;
    if (!c || c.name !== name || Date.now() > c.until) {
      this.confirm = { name, until: Date.now() + CONFIRM_MS };
      cx.timer.after(CONFIRM_MS + 50, (cx) => cx.notify());
      cx.notify();
      return;
    }
    this.confirm = null;
    this.act(cx, async () => {
      this.list = await mutate((list) => ({ list: remove(list, name) }));
      return `Deleted “${name}”.`;
    });
  }

  key(e, cx) {
    if (e.key === "escape") {
      if (this.renaming) this.renaming = null;
      else if (this.mode === "save" && !(props()?.mode === "save")) this.mode = "list";
      else return closeOverlay(this.overlay);
      this.focusMode();
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (this.mode !== "list" || this.renaming || e.modifiers?.control || e.modifiers?.platform) return;
    const preset = PRESETS[Number(e.key) - 1];
    if (e.key === "e") this.act(cx, () => equalize());
    else if (preset) this.act(cx, (cx) => applyShape(cx, preset.shape, false));
    else if (e.key === "s") { this.mode = "save"; this.focusMode(); }
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  render() {
    if (!this.overlay) return div();
    const t = theme();
    const button = (id, text, onClick, { primary = false, danger = false, disabled = false } = {}) =>
      h_flex().id(id).h(24).px(10).flex_none().items_center().rounded(6).text_size(11.5)
        .border_1().border_color(primary ? t.solid : danger ? t.blocked : t.border)
        .when(primary, (el) => el.bg(t.solid))
        .text_color(primary ? t.solid_foreground : danger ? t.blocked : t.muted)
        .when(disabled, (el) => el.opacity(0.55))
        .when(!disabled, (el) => el.cursor_pointer().hover((s) => (primary ? s.opacity(0.85) : s.bg(t.hover).text_color(danger ? t.blocked : t.foreground)))
          .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }))
        .child(text);
    const title = (text, hint) => h_flex().items_center().pb(10)
      .child(div().flex_1().text_size(13).font_semibold().child(text))
      .child(div().text_size(11).text_color(t.dim).child(hint));
    const footer = (el) => el.when(Boolean(this.message), (el) =>
      el.child(div().pt(10).text_size(11.5).text_color(this.error ? t.blocked : t.muted).child(this.message)));
    const root = v_flex().id("arrange").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).p(16).bg(t.popover).text_color(t.foreground);

    if (this.mode === "save") {
      const box = h_flex().id("programs").gap(8).pt(12).items_center().cursor_pointer()
        .on_click((_e, cx) => { this.programs = !this.programs; cx.notify(); })
        .child(div().size(14).rounded(4).border_1().border_color(this.programs ? t.accent : t.input)
          .bg(this.programs ? t.accent : t.background).text_size(10.5).text_color(t.accent_foreground)
          .flex().items_center().justify_center().child(this.programs ? "✓" : ""))
        .child(div().text_size(12).child("Also start programs"))
        .child(div().text_size(11).text_color(t.dim).child("(non-shell panes)"));
      return root
        .child(title("Save arrangement", "Esc"))
        .child(div().text_size(11.5).text_color(t.dim).pb(6).child("The focused tab's splits and their proportions."))
        .child(Input.new(this.nameInput).h(32).px(10).rounded(6).border_1().border_color(t.accent)
          .bg(t.background).text_size(13).text_color(t.foreground))
        .child(box)
        .child(h_flex().pt(12).gap(8).justify_end()
          .child(button("save-cancel", "Cancel", () => {
            if (props()?.mode === "save") closeOverlay(this.overlay);
            else { this.mode = "list"; this.focusMode(); }
          }))
          .child(button("save-ok", "Save", (cx) => this.save(cx), { primary: true, disabled: this.busy })))
        .map(footer);
    }

    const presetRow = h_flex().gap(6).flex_wrap().children(PRESETS.map((p, i) =>
      button(`preset-${p.key}`, `${i + 1}  ${p.name}`, (cx) => this.act(cx, (cx) => applyShape(cx, p.shape, false)), { disabled: this.busy })));
    const rows = this.list.map((a) => {
      const confirming = this.confirm?.name === a.name && Date.now() <= this.confirm.until;
      const programs = leaves(a.shape).some((l) => l.argv);
      const name = this.renaming === a.name
        ? Input.new(this.renameInput).h(28).px(8).rounded(6).border_1().border_color(t.accent).bg(t.background).text_size(12)
        : v_flex().min_w(0)
          .child(div().text_size(12).font_semibold().truncate().child(a.name))
          .child(div().text_size(11).text_color(t.dim).truncate().child(describe(a.shape)));
      return h_flex().id(`row-${a.name}`).gap(6).py(6).items_center().border_b_1().border_color(t.border)
        .child(div().flex_1().min_w(0).child(name))
        .child(button(`apply-${a.name}`, "Apply", (cx) => this.act(cx, (cx) => applyShape(cx, a.shape, programs)), { primary: true, disabled: this.busy }))
        .child(this.renaming === a.name
          ? button(`rename-ok-${a.name}`, "Done", (cx) => this.finishRename(cx), { disabled: this.busy })
          : button(`rename-${a.name}`, "Rename", (cx) => { this.startRename(a.name); cx.notify(); }, { disabled: this.busy }))
        .child(button(`delete-${a.name}`, confirming ? "Sure?" : "Delete", (cx) => this.remove(cx, a.name), { danger: confirming, disabled: this.busy }));
    });

    return root
      .child(title("Arrangements", "e equalize · 1–4 presets · s save · Esc"))
      .child(div().text_size(11.5).font_semibold().text_color(t.muted).pb(6).child("PRESETS"))
      .child(presetRow)
      .child(h_flex().gap(6).pt(10)
        .child(button("equalize", "Equalize splits", (cx) => this.act(cx, () => equalize()), { disabled: this.busy }))
        .child(button("save-open", "Save current…", (cx) => { this.mode = "save"; this.focusMode(); cx.notify(); })))
      .child(div().text_size(11.5).font_semibold().text_color(t.muted).pt(12).pb(2).child("SAVED"))
      .child(v_flex().id("saved").flex_1().min_h(32).overflow_y_scrollbar()
        .when(this.list.length === 0, (el) => el.child(div().py(8).text_size(12).text_color(t.dim).child("Nothing saved yet.")))
        .children(rows))
      .map(footer);
  }
}

/** Key commands from the layout copy: a toast only when there is something to say. */
async function report(work, always) {
  try {
    const text = await work();
    if (always) notify({ title: "Arrangement", body: text, level: "info" });
  } catch (e) {
    notify({ title: "Arrangement", body: String(e?.message ?? e), level: "error" });
  }
}
