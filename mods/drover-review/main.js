// Review: the focused space's checkout in a narrow panel. Changed files with viewed marks,
// the files the agent touched in its latest turns, and two drafting prompts for that agent.
// Read-only outside its own folder. Programs it runs:
//   git (read-only argv, see lib/logic.js) on focus change, every 10 s, and on the Refresh icon;
//   python3 -I probe.py (bounded transcript read) on focus change, every 20 s, and on the Refresh icon;
//   hc send <agent> <prompt> only on the second click of a draft button.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, spaces, panes, focused, agents, terminals, theme, appHome, readTextFile, writeTextFile, window, layout } from "herdr";
import {
  gitArgs, parseStatus, parseNumstat, splitDiff, diffSignatures, buildFiles, countLines, EMPTY_TREE,
  parseStore, parseStat, readable, statSig, visibleIn, marksFor, isViewed, setMark, expireMarks, viewedCount, visibleFiles, totals, splitTurns, buildPrompt,
} from "./lib/logic.js";
import { TYPE, SPACE, MINUS, mono, metaColor, diffStat, button, panelHeader, sectionLabel, emptyState, noRepoState } from "./lib/panel-ui.js";

const MOD = "drover-review";
const DIR = () => `${appHome()}/mods/${MOD}`;
const STORE = () => `${DIR()}/.viewed.json`;
const UI = (name) => `mods/${MOD}/ui/${name}.svg`;
const EVERY = 10_000;
const TURNS = 5;
const MAX_ROWS = 300;
const MAX_UNTRACKED_READS = 100;
const STAT_FORMATS = [["-f", "%HT|%z|%m"], ["-c", "%F|%s|%Y"]]; // BSD, then GNU
const live = () => visibleIn(layout(), MOD) && window().active;

function location() {
  const space = spaces().find((s) => s.active) ?? null, f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || "", on, space: space?.id ?? null };
}
const contextKey = () => JSON.stringify(location());

// Agents in the focused space; the session is read from the focused one, else the only one.
function spaceAgents() {
  const { space } = location();
  return space ? agents().filter((a) => a.space === space) : [];
}
function sessionSource() {
  const list = spaceAgents(), f = focused();
  const a = list.find((x) => x.address === f?.terminal) ?? (list.length === 1 ? list[0] : null);
  const address = a?.address ?? f?.terminal ?? null;
  const term = address ? terminals().find((t) => t.address === address) : null;
  const pane = address ? panes().find((p) => p.terminal === address) : null;
  return { cwd: pane?.cwd || location().cwd, pid: term?.foreground?.pid ?? null };
}

const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};

export default class Review extends View {
  init(_props, cx) {
    this.key = null;
    this.reset();
    this.hideViewed = store.get("hideViewed", false) === true;
    this.marks = parseStore("{}");
    this.untrackedCache = {};
    this.busy = { git: false, turns: false, send: false };
    this.again = { git: false, turns: false }; // a load was asked for while one ran
    this.dormant = false; // hidden or in a background window: not polling
    this.ticks = 0;
    this.tasks = [cx.timer.every(EVERY, (cx) => {
      if (!live()) { this.dormant = true; return; }
      if (this.dormant) { this.dormant = false; this.loadGit(cx, true); this.loadTurns(cx, true); return; }
      this.ticks++;
      this.loadGit(cx);
      if (this.ticks % 2 === 0) this.loadTurns(cx);
    })];
    cx.spawn(async (cx) => {
      const text = await readTextFile(STORE()).catch(() => null);
      this.marks = parseStore(text);
      cx.notify();
    });
  }

  async close() {
    for (const task of this.tasks) task.cancel();
  }

  reset() {
    this.root = null; this.branch = null; this.files = null; this.gitError = null; this.noRepo = false;
    this.turns = null; this.session = null; this.turn = null;
    this.armed = null; this.note = null; this.copied = null;
  }

  checkContext(cx) {
    const key = contextKey();
    if (this.dormant && live()) { this.dormant = false; this.loadGit(cx, true); this.loadTurns(cx, true); }
    if (key === this.key) return;
    this.key = key;
    this.reset();
    this.loadGit(cx, true);
    this.loadTurns(cx, true);
  }

  refreshAll(cx) {
    this.note = null; this.copied = null;
    this.loadGit(cx, true);
    this.loadTurns(cx, true);
    cx.notify();
  }

  // ---------- git ----------

  loadGit(cx, force = false) {
    const { cwd, on } = location(), key = this.key;
    if (!cwd) return;
    if (this.busy.git) { if (force) this.again.git = true; return; }
    this.busy.git = true;
    cx.spawn(async (cx) => {
      try {
        const git = (sub, args, dir) => exec("git", gitArgs(sub, args), { cwd: dir, on, timeout: 30_000 });
        const top = await git("rev-parse", ["--show-toplevel"], cwd);
        if (key !== this.key) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.noRepo = true; this.gitError = null; return; }
        const root = top.stdout.trim();
        const head = await git("rev-parse", ["--verify", "-q", "HEAD"], root);
        const base = head.code === 0 ? "HEAD" : EMPTY_TREE;
        const branch = await git("branch", ["--show-current"], root);
        const status = await git("status", ["--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], root);
        const numstat = await git("diff", [base, "--numstat", "-z"], root);
        const full = await git("diff", [base], root);
        for (const r of [status, numstat, full]) if (r.code !== 0) throw new Error("git failed");
        const st = parseStatus(status.stdout), ns = parseNumstat(numstat.stdout);
        const sigs = diffSignatures(ns, splitDiff(full.stdout));
        const untracked = await this.untrackedInfo(root, on, st.filter((s) => s.untracked).map((s) => s.path), git);
        if (key !== this.key) return;
        this.root = root;
        this.branch = branch.code === 0 ? branch.stdout.trim() || null : null;
        this.files = buildFiles(st, ns, sigs, untracked);
        this.gitError = null; this.noRepo = false;
        const files = this.files, expired = expireMarks(this.marks, root, files);
        if (expired) { this.marks = expired; this.persist((s) => expireMarks(s, root, files), cx); }
      } catch {
        if (key === this.key) this.gitError = "Could not read the changes."; this.noRepo = false;
      } finally {
        this.busy.git = false;
        cx.notify();
        if (this.again.git) { this.again.git = false; this.loadGit(cx); }
      }
    });
  }

  // One stat call per 100 files: type, size and mtime, in argument order. null per file when unknown.
  async statAll(root, on, paths) {
    const stats = {};
    for (let i = 0; i < paths.length; i += 100) {
      const batch = paths.slice(i, i + 100);
      let list = null;
      for (const fmt of STAT_FORMATS) {
        const r = await exec("stat", [...fmt, "--", ...batch], { cwd: root, on, timeout: 30_000 }).catch(() => null);
        list = r && r.code === 0 ? parseStat(r.stdout, batch.length) : null;
        if (list) break;
      }
      batch.forEach((p, j) => { stats[p] = list ? list[j] : null; });
    }
    return stats;
  }

  // Untracked files: only regular files up to 1 MB are hashed (`git hash-object --no-filters`, no write)
  // and read, and lines are counted only when the hash changed. Symlinks, other types, big files and
  // files git could not stat still list; their mark is keyed on size and mtime.
  async untrackedInfo(root, on, paths, git) {
    const out = {};
    const blobs = {};
    const stats = await this.statAll(root, on, paths);
    const small = paths.filter((p) => readable(stats[p]));
    for (let i = 0; i < small.length; i += 100) {
      const batch = small.slice(i, i + 100);
      const r = await git("hash-object", ["--no-filters", "--", ...batch], root).catch(() => null);
      const ids = r && r.code === 0 ? r.stdout.trim().split("\n") : [];
      if (ids.length === batch.length) batch.forEach((p, j) => { blobs[p] = ids[j]; });
    }
    let reads = 0;
    const cache = {};
    for (const p of paths) {
      const ok = readable(stats[p]);
      const sig = ok ? (blobs[p] ? "u" + blobs[p] : null) : statSig(stats[p]);
      const old = this.untrackedCache[p];
      if (old && sig && old.sig === sig) { cache[p] = old; out[p] = old; continue; }
      let add = null, binary = false;
      if (ok && reads < MAX_UNTRACKED_READS) {
        reads++;
        const text = await readTextFile(`${root}/${p}`, { on }).catch(() => null);
        if (text != null) { binary = text.includes("\0"); add = binary ? null : countLines(text); }
      }
      out[p] = { sig, add, binary, large: !ok };
      if (sig) cache[p] = out[p];
    }
    this.untrackedCache = cache;
    return out;
  }

  // ---------- marks (a hidden file in this folder, shared by every copy) ----------

  // writeTextFile refuses a stale snapshot: read, apply, write; once more if another copy won.
  persist(change, cx) {
    const run = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const text = await readTextFile(STORE()).catch(() => null);
        const next = change(parseStore(text));
        if (!next) return;
        try {
          await writeTextFile(STORE(), JSON.stringify(next), text);
          return;
        } catch {}
      }
    };
    const before = this.pending ?? Promise.resolve();
    this.pending = new Promise((done) => cx.spawn(async () => { await before.catch(() => {}); await run().catch(() => {}); done(); }));
  }

  toggleViewed(file, cx) {
    if (!this.root || !file.sig) return;
    const root = this.root, viewed = !isViewed(marksFor(this.marks, root), file), now = Date.now();
    this.marks = setMark(this.marks, root, file, viewed, now);
    this.persist((s) => setMark(s, root, file, viewed, now), cx);
    cx.notify();
  }

  // ---------- transcript ----------

  loadTurns(cx, force = false) {
    const loc = location(), key = this.key;
    if (loc.on || !loc.cwd) return;
    if (this.busy.turns) { if (force) this.again.turns = true; return; }
    this.busy.turns = true;
    const src = sessionSource();
    cx.spawn(async (cx) => {
      try {
        const args = ["-I", `${DIR()}/probe.py`, "turns", "--cwd", src.cwd, "--turns", String(TURNS)];
        if (this.root) args.push("--root", this.root);
        if (src.pid) args.push("--pid", String(src.pid));
        const r = await exec("python3", args, { timeout: 30_000 });
        const data = JSON.parse(r.stdout.trim() || "{}");
        if (key !== this.key) return;
        if (r.code !== 0 || data.error) throw new Error("probe");
        this.session = data.session ? { id: data.session, how: data.how } : null;
        this.turns = data.session ? splitTurns(data.events, TURNS) : [];
        if (this.turn != null && this.turn >= this.turns.length) this.turn = null;
      } catch {
        if (key === this.key) { this.turns = []; this.session = { failed: true }; }
      } finally {
        this.busy.turns = false;
        cx.notify();
        if (this.again.turns) { this.again.turns = false; this.loadTurns(cx); }
      }
    });
  }

  // ---------- drafts ----------

  target() {
    const list = spaceAgents();
    return list.length === 1 ? list[0] : null;
  }

  scopeFiles() {
    const only = this.turnPaths();
    return (this.files ?? []).filter((f) => !only || only.has(f.path));
  }

  draft(kind, cx) {
    const agent = this.target();
    if (!agent || !this.root || this.busy.send) return;
    const a = this.armed;
    if (a && a.kind === kind && a.address === agent.address && a.key === this.key) {
      this.send(a, cx);
      return;
    }
    const scope = this.turn == null ? null : `the files the agent changed in its ${this.turn === 0 ? "latest turn" : `turn ${this.turn} before the latest`} that still have uncommitted changes`;
    const text = buildPrompt(kind, { root: this.root, branch: this.branch, files: this.scopeFiles(), scope });
    this.armed = { kind, text, address: agent.address, name: agentName(agent), key: this.key };
    this.note = null;
    cx.notify();
  }

  send(a, cx) {
    this.busy.send = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("hc", ["send", a.address, a.text], { timeout: 15_000 });
        this.note = r.code === 0 ? `Sent to ${a.name}.` : "Could not send the prompt.";
      } catch {
        this.note = "Could not send the prompt.";
      } finally {
        this.armed = null;
        this.busy.send = false;
        cx.notify();
      }
    });
  }

  // ---------- drawing ----------

  turnPaths() {
    const t = this.turn == null ? null : this.turns?.[this.turn];
    return t ? new Set(t.files.map((f) => f.path).filter((p) => !p.startsWith("/"))) : null;
  }

  meta(t) { return metaColor(t, t.background); }

  section(t, id, title, body, right) {
    return v_flex().id(id).gap(6).px(SPACE.PX).pb(10).border_b_1().border_color(t.border)
      .child(h_flex().min_h(SPACE.HIT).items_center().justify_between().gap(6)
        .child(sectionLabel(title, t))
        .when(Boolean(right), (el) => el.child(right)))
      .child(body);
  }

  dim(t, text) {
    return div().text_size(TYPE.xs).text_color(this.meta(t)).child(text);
  }

  // +12 −3 in mono with signs; an unknown count draws "+?" / "−0?".
  counts(t, add, del, unknown = false) {
    if (add != null && !unknown) {
      const d = del ?? 0;
      if (add && !d) return mono(h_flex().flex_none().text_size(TYPE.xs).accessibility_label(`${add} added`).child(div().text_color(t.ansi2).child(`+${add}`)));
      if (d && !add) return mono(h_flex().flex_none().text_size(TYPE.xs).accessibility_label(`${d} removed`).child(div().text_color(t.ansi1).child(`${MINUS}${d}`)));
      return diffStat({ added: add, removed: d }, t);
    }
    return mono(h_flex().flex_none().gap(4).text_size(TYPE.xs)
      .child(div().text_color(add == null ? this.meta(t) : t.ansi2).child(add == null ? "+?" : `+${add}`))
      .child(div().text_color(t.ansi1).child(`${MINUS}${del ?? 0}${unknown ? "?" : ""}`)));
  }

  fileRow(t, f, marks, i) {
    const viewed = isViewed(marks, f);
    const parts = f.path.split("/"), name = parts.pop();
    const box = div().id(`v-${i}`).flex_none().size(14).rounded(4).border_1().flex().items_center().justify_center().text_size(TYPE.xs)
      .accessibility_label(viewed ? `Mark ${f.path} as not viewed` : `Mark ${f.path} as viewed`)
      .border_color(viewed ? t.accent : t.input).when(viewed, (el) => el.bg(t.accent).text_color(t.accent_foreground).child("✓"))
      .when(Boolean(f.sig), (el) => el.cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); this.toggleViewed(f, cx); }));
    const label = h_flex().id(`p-${i}`).flex_1().min_w(0).cursor_pointer().rounded(4).hover((el) => el.bg(t.hover))
      .on_click((_e, cx) => { cx.write_to_clipboard(`${this.root}/${f.path}`); this.copied = f.path; cx.notify(); })
      .child(div().min_w(0).truncate().text_color(viewed ? this.meta(t) : t.foreground).child(name))
      .when(parts.length > 0, (el) => el.child(mono(div().pl(6).min_w(0).flex_1().truncate().text_size(TYPE.xs).text_color(this.meta(t)).child(parts.join("/")))));
    const tag = this.copied === f.path ? "copied" : f.untracked ? (f.large ? "new, not read" : "new") : f.deleted ? "deleted" : f.binary ? "binary" : null;
    return h_flex().gap(8).items_center().min_w(0).h(SPACE.ROW_H).text_size(TYPE.sm)
      .child(box).child(label)
      .when(Boolean(tag), (el) => el.child(div().flex_none().text_size(TYPE.xs).text_color(this.copied === f.path ? t.accent : this.meta(t)).child(tag)))
      .when(!f.binary, (el) => el.child(this.counts(t, f.add, f.del)));
  }

  // The focused folder, tail-preserving: the last two segments with a leading "…/" when there are more.
  folderName() {
    const segs = location().cwd.split("/").filter(Boolean);
    return segs.length > 2 ? `…/${segs.slice(-2).join("/")}` : segs.join("/");
  }

  // Whole-body states: no folder, or a folder outside any repository. Null when the panel can show content.
  blockingState(t) {
    if (location().cwd === "") {
      return emptyState({ id: "no-folder", title: "No folder", body: "Focus a terminal to show its folder here." }, t);
    }
    if (this.noRepo) return noRepoState({ id: "no-repo", folder: this.folderName() }, t);
    return null;
  }

  changesSection(t) {
    if (!this.files && !this.gitError) return this.section(t, "sec-changes", "Changes", this.dim(t, "Reading changes…"));
    if (!this.root) {
      return this.section(t, "sec-changes", "Changes", emptyState({ id: "git-error", tone: "error", title: "Could not read the changes", body: "Try Refresh in a moment." }, t));
    }
    const marks = marksFor(this.marks, this.root);
    const only = this.turnPaths();
    const scoped = this.files.filter((f) => !only || only.has(f.path));
    const rows = visibleFiles(this.files, marks, { hideViewed: this.hideViewed, only });
    const sum = totals(scoped);
    const head = h_flex().gap(8).items_center().text_size(TYPE.sm).min_h(SPACE.HIT)
      .child(div().text_color(t.foreground).child(`${viewedCount(scoped, marks)} of ${scoped.length} viewed`))
      .when(scoped.length > 0, (el) => el.child(this.counts(t, sum.add, sum.del)))
      .child(div().flex_1())
      .child(button({ id: "hide", label: this.hideViewed ? "Show viewed" : "Hide viewed", onClick: (cx) => {
        this.hideViewed = !this.hideViewed; store.set("hideViewed", this.hideViewed); cx.notify();
      } }, t));
    const body = v_flex().gap(4).child(head);
    if (only) {
      const missing = this.turns[this.turn].files.length - scoped.length;
      body.child(h_flex().gap(6).items_center().text_size(TYPE.xs)
        .child(div().flex_1().min_w(0).truncate().text_color(t.accent).child(`Only the ${this.turn === 0 ? "latest turn" : `turn ${this.turn} earlier`}'s files`))
        .child(button({ id: "clear-turn", label: "All files", onClick: (cx) => { this.turn = null; this.armed = null; cx.notify(); } }, t)));
      if (missing > 0) body.child(this.dim(t, `${missing} of its files have no uncommitted changes or are outside this checkout.`));
    }
    if (!scoped.length) body.child(this.dim(t, only ? "None of this turn's files has uncommitted changes." : "No changes"));
    else if (!rows.length) body.child(this.dim(t, "Every file here is viewed."));
    body.children(rows.slice(0, MAX_ROWS).map((f, i) => this.fileRow(t, f, marks, i)));
    if (rows.length > MAX_ROWS) body.child(this.dim(t, `Showing the first ${MAX_ROWS} of ${rows.length} files.`));
    body.child(this.dim(t, "Click a name to copy its path."));
    return this.section(t, "sec-changes", "Changes", body,
      this.branch ? mono(div().min_w(0).truncate().text_size(TYPE.xs).text_color(this.meta(t)).child(this.branch)) : null);
  }

  turnsSection(t) {
    let body;
    if (location().on) body = this.dim(t, "Remote space: the agent's transcript is read on this computer only.");
    else if (!this.turns) body = this.dim(t, "Reading turns…");
    else if (!this.session) body = this.dim(t, "No Claude Code session found for this space.");
    else if (this.session.failed) body = this.dim(t, "Could not read the session.");
    else if (!this.turns.length) body = this.dim(t, "No turns yet.");
    else {
      body = v_flex().gap(2).text_size(TYPE.sm).children(this.turns.map((turn, i) => {
        const sel = this.turn === i, sum = totals(turn.files);
        const label = i === 0 ? "Latest turn" : i === 1 ? "1 turn earlier" : `${i} turns earlier`;
        const unknown = turn.files.some((f) => f.unknown);
        const row = h_flex().id(`turn-${i}`).gap(8).items_center().px(8).h(SPACE.ROW_H).rounded(6).cursor_pointer()
          .when(sel, (el) => el.bg(t.selected)).hover((el) => el.bg(t.hover))
          .on_click((_e, cx) => { this.turn = sel ? null : i; this.armed = null; cx.notify(); })
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(label + (turn.partial ? " (start not read)" : "")))
          .child(h_flex().flex_none().gap(3).text_size(TYPE.xs).text_color(this.meta(t))
            .child(mono(div().child(String(turn.files.length)))).child(div().child(turn.files.length === 1 ? "file" : "files")))
          .when(turn.files.length > 0, (el) => el.child(this.counts(t, sum.add, sum.del, unknown)));
        const files = v_flex().pl(12).gap(2).children(turn.files.slice(0, 60).map((f) => h_flex().gap(8).items_center().min_w(0).text_size(TYPE.xs)
          .child(mono(div().flex_1().min_w(0).truncate().text_color(this.meta(t)).child(f.path)))
          .child(this.counts(t, f.unknown && !f.add ? null : f.add, f.del, f.unknown))));
        return v_flex().gap(2).child(row).when(sel && turn.files.length > 0, (el) => el.child(files));
      }));
    }
    return this.section(t, "sec-turns", "Agent turns", body);
  }

  draftsSection(t) {
    const list = spaceAgents(), agent = this.target();
    const a = this.armed && agent && this.armed.address === agent.address && this.armed.key === this.key ? this.armed : null;
    const ready = Boolean(agent && this.root && !this.busy.send);
    const why = !agent ? (list.length ? "Review needs exactly one agent in this space." : "Start an agent in this space to draft a review.")
      : !this.root ? "Needs a git checkout." : this.busy.send ? "Sending…" : undefined;
    const label = (kind, text) => (a?.kind === kind ? `Send ${text.toLowerCase()}` : text);
    const draftButton = (kind, id, text) => button({ id, label: label(kind, text), onClick: (cx) => this.draft(kind, cx),
      kind: a?.kind === kind ? "primary" : "secondary", disabled: !ready, tooltip: ready ? undefined : why }, t);
    const buttons = h_flex().gap(6).child(draftButton("guide", "d-guide", "Review guide")).child(draftButton("bug", "d-bug", "Bug report draft"));
    const body = v_flex().gap(6);
    if (!agent) {
      body.child(emptyState(list.length
        ? { id: "no-agent", title: `${list.length} agents in this space`, body: "Review needs exactly one." }
        : { id: "no-agent", title: "No agent in this space", body: "Start an agent in this space to draft a review." }, t));
    }
    body.child(buttons);
    if (agent && !this.root) body.child(this.dim(t, "Needs a git checkout."));
    if (a) {
      body.child(h_flex().gap(4).text_size(TYPE.xs).text_color(this.meta(t)).child(div().child(`To ${a.name} ·`)).child(mono(div().min_w(0).truncate().child(a.address)))
        .child(div().child("Click again to send.")))
        .child(div().id("prompt-text").max_h(180).overflow_y_scrollbar().p(8).rounded(6).bg(t.background).border_1().border_color(t.border)
          .text_size(TYPE.xs).text_color(this.meta(t)).child(a.text))
        .child(h_flex().child(button({ id: "d-cancel", label: "Cancel", onClick: (cx) => { this.armed = null; cx.notify(); } }, t)));
    } else if (agent) {
      body.child(h_flex().gap(4).text_size(TYPE.xs).text_color(this.meta(t)).child(div().child(`Target: ${agentName(agent)} ·`)).child(mono(div().min_w(0).truncate().child(agent.address)))
        .child(div().child("First click shows the prompt.")));
    }
    if (this.note) body.child(this.dim(t, this.note));
    return this.section(t, "sec-drafts", "Drafts", body);
  }

  headerMeta() {
    if (this.turn != null && this.turns?.[this.turn]) return this.turn === 0 ? "Latest turn" : `${this.turn} turns earlier`;
    const n = this.files?.length ?? 0;
    return this.root && n > 0 ? `${n} ${n === 1 ? "file" : "files"}` : undefined;
  }

  render(cx) {
    this.checkContext(cx);
    const t = theme();
    const header = panelHeader({
      id: "review-header", title: "Review", meta: this.headerMeta(), busy: this.busy.git || this.busy.turns,
      actions: [{ id: "refresh", icon: UI("refresh"), label: "Refresh", onClick: (cx) => this.refreshAll(cx) }],
    }, t);
    const blocked = this.blockingState(t);
    return v_flex().id("drover-review").size_full().bg(t.background).text_color(t.foreground).text_size(TYPE.md).overflow_y_scrollbar()
      .child(header)
      .children(blocked ? [blocked] : [this.changesSection(t), this.turnsSection(t), this.draftsSection(t)]);
  }
}

function agentName(a) {
  return a.program?.name || a.app || a.title || "agent";
}
