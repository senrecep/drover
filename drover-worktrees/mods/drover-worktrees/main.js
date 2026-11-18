// Worktrees: the git worktrees of every repository behind the open spaces, with New / Open
// space / Remove, and per-repository run actions. A full page; place "none".
import { View, div } from "gpui-kit";
import { TYPE, SPACE, mono, metaColor, button as kitButton, panelHeader, sectionLabel, noRepoState } from "./lib/panel-ui.js";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { hc, home, spaces, panes, agents, machines, theme, window, layout, run, shared, setShared } from "herdr";
import {
  nameError, baseError, worktreePath, worktreesRoot, addArgs, landingError, removeBlockers, removeArgs, prFor,
  spaceFolder, spaceFor, agentsOn, repoKey, tilde, ago, saveAction, deleteAction, actionError, visibleIn, parseWorktrees,
  windowsRefusal,
} from "./logic.js";
import { gitRead, gitWrite, repoOf, realPathOf, readRepo, readWorktree, listPrs } from "./git.js";

const MOD = "drover-worktrees";
const ACTIONS = `${MOD}.actions`; // shared: { [repoKey]: [{ id, name, command }] }, seen by every copy
const TICK_MS = 30000;
const PR_MS = 60000;
const CONFIRM_MS = 6000;
const REFRESH_ICON = `mods/${MOD}/ui/refresh.svg`;
// Tail-preserving path: long paths keep their last two segments ("…/parent/name"), never cut mid-path.
const tailPath = (p) => {
  if (p.length <= 28) return p;
  const seg = p.split("/").filter(Boolean);
  if (seg.length < 2) return p;
  const two = `…/${seg.slice(-2).join("/")}`;
  return two.length <= 28 ? two : `…/${seg[seg.length - 1]}`;
};
const machineLabel = (m) => m ?? "this computer";
const inside = (p, dir) => p === dir || p.startsWith(`${dir}/`);

function readJson(name, fallback) {
  try { return JSON.parse(localStorage.getItem(name) ?? "null") ?? fallback; } catch { return fallback; }
}

export default class Worktrees extends View {
  init(_props, cx) {
    this.repos = null; // null: not read yet; else [{ key, machine, main, name, worktrees, ... }]
    this.quiet = []; // one-line states: not a repository, git missing, machine unreachable
    this.sig = "";
    this.prs = new Map(); // repoKey -> { at, list }
    this.gh = null; // null ok, else a one-line state
    this.confirm = new Map(); // repoKey + path -> expiry
    this.busyRows = new Set();
    this.messages = new Map(); // repoKey -> one-line result or error
    this.form = null; // { kind: "new" | "action", key, id? }
    this.formError = "";
    this.formBusy = false;
    this.runs = readJson("runs", {}); // actionKey -> tab id this mod opened
    this.running = new Set(); // actionKeys whose tab still runs its command
    this.inBranch = InputState.new({ placeholder: "branch name" });
    this.inBase = InputState.new({ placeholder: "base" });
    this.inName = InputState.new({ placeholder: "Name, e.g. Dev server" });
    this.inCmd = InputState.new({ placeholder: "Command, e.g. npm run dev" });
    for (const input of [this.inBranch, this.inBase, this.inName, this.inCmd]) {
      input.on("change", (_e, cx) => { this.formError = ""; cx.notify(); });
      input.on("submit", (_e, cx) => this.submit(cx));
    }
    this.refresh(cx, true);
    cx.timer.every(TICK_MS, (cx) => {
      if (window().active && visibleIn(layout(), MOD)) this.refresh(cx);
    });
  }

  // ---- reading ----

  refresh(cx, force = false) {
    if (this.busy) {
      // Asked while a read runs: its answer may predate this request, so read again when it ends.
      if (force) this.again = true;
      return;
    }
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const { repos, quiet } = await this.read();
        await this.readPrs(repos, force);
        await this.readRunning();
        const sig = JSON.stringify([repos, quiet, this.gh, [...this.prs].map(([k, v]) => [k, v.list]), [...this.running]]);
        if (force || sig !== this.sig) {
          this.sig = sig;
          this.repos = repos;
          this.quiet = quiet;
          cx.notify();
        }
      } finally {
        this.busy = false;
        const again = this.again;
        this.again = false;
        if (again) this.refresh(cx, true);
      }
    });
  }

  async read() {
    const paneList = panes();
    const down = new Set(machines().filter((m) => m.name != null && m.layout === "unavailable").map((m) => m.name));
    const folders = new Map(); // [machine, folder] -> space names
    for (const s of spaces()) {
      const machine = s.machine ?? null;
      if (down.has(machine)) continue;
      const folder = spaceFolder(s, paneList);
      if (!folder) continue;
      const k = JSON.stringify([machine, folder]);
      if (!folders.has(k)) folders.set(k, { machine, folder, names: [] });
      folders.get(k).names.push(s.name);
    }
    const quiet = [];
    const found = new Map();
    const noGit = new Set();
    await Promise.all([...folders.values()].map(async (f) => {
      try {
        const repo = await repoOf(f.folder, f.machine);
        if (!repo) quiet.push(`${f.names.join(", ")}: not a git repository`);
        else if (!found.has(repoKey(f.machine, repo.main))) found.set(repoKey(f.machine, repo.main), { ...repo, machine: f.machine });
      } catch {
        noGit.add(f.machine);
      }
    }));
    for (const m of noGit) quiet.push(`git is not available on ${machineLabel(m)}`);
    const repos = await Promise.all([...found.values()].map(async (r) => {
      const key = repoKey(r.machine, r.main);
      try {
        return { key, machine: r.machine, main: r.main, name: r.name, ...(await readRepo(r, r.machine)), error: null };
      } catch (e) {
        return { key, machine: r.machine, main: r.main, name: r.name, worktrees: [], defaultBranch: "", github: null, launch: null, error: String(e?.message ?? e) };
      }
    }));
    repos.sort((a, b) => String(a.machine ?? "").localeCompare(String(b.machine ?? "")) || a.name.localeCompare(b.name));
    quiet.sort();
    return { repos, quiet };
  }

  // At most once a minute per repository, and not at all once gh turned out to be missing.
  async readPrs(repos, force) {
    for (const r of repos) {
      if (!r.github || this.gh === "gh isn't installed") continue;
      const had = this.prs.get(r.key);
      if (had && Date.now() - had.at < PR_MS) continue;
      try {
        this.prs.set(r.key, { at: Date.now(), list: await listPrs(r.github) });
        this.gh = null;
      } catch (e) {
        this.prs.set(r.key, { at: Date.now(), list: had?.list ?? [] });
        this.gh = e.gh === "missing" ? "gh isn't installed" : `Could not reach GitHub: ${String(e.message ?? "").split("\n")[0].slice(0, 200)}`;
      }
    }
  }

  // A tab this mod opened still runs its command when its terminal's foreground
  // process is not the shell the terminal started (that one comes back when it ends).
  async readRunning() {
    const tabs = new Set(spaces().flatMap((s) => s.tabs.map((t) => t.id)));
    const paneList = panes();
    const running = new Set();
    let pruned = false;
    for (const [k, tab] of Object.entries(this.runs)) {
      if (!tabs.has(tab)) { delete this.runs[k]; pruned = true; continue; }
      if (await this.tabRunning(tab, paneList)) running.add(k);
    }
    if (pruned) this.saveRuns();
    this.running = running;
  }

  async tabRunning(tab, paneList = panes()) {
    for (const p of paneList.filter((x) => x.tab === tab && x.terminal)) {
      try {
        const r = await hc(["get", "--json", p.terminal]);
        const j = JSON.parse(r.stdout || "{}");
        if (j.state === "live" && j.foreground?.pid && j.foreground.pid !== j.pid) return true;
      } catch { /* unreadable: treat as not running */ }
    }
    return false;
  }

  saveRuns() {
    try { localStorage.setItem("runs", JSON.stringify(this.runs)); } catch { /* storage unavailable: kept for this copy */ }
  }

  // ---- worktree actions ----

  spaceOn(repo, wt) {
    return spaceFor(wt.path, repo.worktrees.map((w) => w.path), repo.machine, spaces(), panes());
  }

  agentsOn(repo, wt) {
    return agentsOn(wt.path, repo.machine, spaces(), panes(), agents());
  }

  openSpace(repo, wt) {
    const s = this.spaceOn(repo, wt);
    if (s) run("space.select", { id: s.id });
    else run("space.new", { folder: wt.path, machine: repo.machine ?? "" });
  }

  remove(repo, wt, cx) {
    const refused = windowsRefusal("remove", window()?.platform ?? "macos", repo.machine);
    if (refused) { this.messages.set(repo.key, refused); cx.notify(); return; }
    const k = `${repo.key}\0${wt.path}`;
    if ((this.confirm.get(k) ?? 0) < Date.now()) {
      this.confirm.set(k, Date.now() + CONFIRM_MS);
      cx.timer.after(CONFIRM_MS, (cx) => {
        if ((this.confirm.get(k) ?? 0) <= Date.now()) { this.confirm.delete(k); cx.notify(); }
      });
      cx.notify();
      return;
    }
    this.confirm.delete(k);
    this.busyRows.add(k);
    this.messages.delete(repo.key);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        // Re-check everything right before removing: the list may be 30 s old.
        const list = await gitRead(repo.main, repo.machine, ["worktree", "list", "--porcelain"]);
        const now = list.ok ? parseWorktrees(list.out).find((w) => w.path === wt.path) : null;
        if (!now) { this.messages.set(repo.key, `${wt.path} is no longer a worktree of ${repo.name}.`); return; }
        const fresh = await readWorktree(now, repo.machine);
        const blockers = removeBlockers({ ...fresh, agents: this.agentsOn(repo, wt) });
        if (blockers.length) { this.messages.set(repo.key, `Not removed: ${blockers.join(", ")}.`); return; }
        const r = await gitWrite(repo.main, repo.machine, removeArgs(wt.path));
        this.messages.set(repo.key, r.ok ? `Removed ${wt.path}. The branch stays.` : `git worktree remove failed: ${r.err}`);
      } catch (e) {
        this.messages.set(repo.key, `Could not remove: ${e?.message ?? e}`);
      } finally {
        this.busyRows.delete(k);
        this.refresh(cx, true);
      }
    });
  }

  // ---- forms ----

  openForm(form, cx) {
    this.form = form;
    this.formError = "";
    if (form.kind === "new") {
      const repo = this.repos.find((r) => r.key === form.key);
      this.inBranch.set_value("");
      this.inBase.set_value(repo?.defaultBranch ?? "");
      this.inBranch.focus();
    } else {
      const a = (shared(ACTIONS)?.[form.key] ?? []).find((x) => x.id === form.id);
      this.inName.set_value(a?.name ?? "");
      this.inCmd.set_value(a?.command ?? "");
      this.inName.focus();
    }
    cx.notify();
  }

  closeForm(cx) {
    this.form = null;
    this.formError = "";
    cx.notify();
  }

  submit(cx) {
    if (!this.form || this.formBusy) return;
    if (this.form.kind === "action") return this.saveActionForm(cx);
    const repo = this.repos?.find((r) => r.key === this.form.key);
    if (!repo) return this.closeForm(cx);
    const name = this.inBranch.value().trim();
    const base = this.inBase.value().trim() || repo.defaultBranch;
    const refused = windowsRefusal("create", window()?.platform ?? "macos", repo.machine);
    if (refused) { this.formError = refused; cx.notify(); return; }
    const err = nameError(name) ?? baseError(base);
    const path = err ? null : worktreePath(repo.main, name);
    if (err || !path) { this.formError = err ?? "That name would leave the worktrees folder."; cx.notify(); return; }
    this.formBusy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.formError = await this.create(repo, name, base, path);
        if (!this.formError) {
          run("space.new", { folder: path, machine: repo.machine ?? "" });
          this.messages.set(repo.key, `Created ${path}.`);
          this.form = null;
          this.refresh(cx, true);
        }
      } catch (e) {
        this.formError = String(e?.message ?? e);
      } finally {
        this.formBusy = false;
        cx.notify();
      }
    });
  }

  async create(repo, name, base, path) {
    const on = repo.machine;
    const ref = await gitRead(repo.main, on, ["check-ref-format", "--branch", name]);
    if (!ref.ok) return `Not a valid branch name: ${name}`;
    const exists = (await gitRead(repo.main, on, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`])).ok;
    if (!exists) {
      const b = await gitRead(repo.main, on, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
      if (!b.ok) return `Base not found: ${base}`;
    }
    // .claude or .claude/worktrees may be a symlink: refuse a target that really lands elsewhere.
    const [realMain, realParent] = await Promise.all([realPathOf(repo.main, on), realPathOf(path.slice(0, path.lastIndexOf("/")), on)]);
    const lands = landingError(realMain, realParent);
    if (lands) return lands;
    const r = await gitWrite(repo.main, on, addArgs(path, name, exists, base));
    return r.ok ? "" : r.err || "git worktree add failed.";
  }

  saveActionForm(cx) {
    const name = this.inName.value().trim();
    const command = this.inCmd.value().trim();
    const err = actionError(name, command);
    if (err) { this.formError = err; cx.notify(); return; }
    const id = this.form.id ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    setShared(ACTIONS, saveAction(shared(ACTIONS) ?? {}, this.form.key, { id, name, command }));
    this.closeForm(cx);
  }

  removeAction(key, id, cx) {
    const k = `act\0${key}\0${id}`;
    if ((this.confirm.get(k) ?? 0) < Date.now()) {
      this.confirm.set(k, Date.now() + CONFIRM_MS);
      cx.timer.after(CONFIRM_MS, (cx) => {
        if ((this.confirm.get(k) ?? 0) <= Date.now()) { this.confirm.delete(k); cx.notify(); }
      });
      cx.notify();
      return;
    }
    this.confirm.delete(k);
    setShared(ACTIONS, deleteAction(shared(ACTIONS) ?? {}, key, id));
    delete this.runs[`${key}\0${id}`];
    this.saveRuns();
    cx.notify();
  }

  // The repository's space: the one on its main checkout, else any on one of its worktrees.
  repoSpace(repo) {
    const main = repo.worktrees.find((w) => w.main);
    const onMain = main ? this.spaceOn(repo, main) : null;
    if (onMain) return onMain;
    const paneList = panes();
    return spaces().find((s) => (s.machine ?? null) === (repo.machine ?? null) && inside(spaceFolder(s, paneList) ?? "", repo.main)) ?? null;
  }

  runAction(repo, a, cx) {
    const k = `${repo.key}\0${a.id}`;
    cx.spawn(async (cx) => {
      const tracked = this.runs[k];
      const where = tracked && spaces().find((s) => s.tabs.some((t) => t.id === tracked));
      if (where && (await this.tabRunning(tracked))) {
        run("space.select", { id: where.id });
        run("tab.select", { id: tracked });
        return;
      }
      // The command is a line the person typed; a terminal tab is where a shell line belongs.
      const argv = ["sh", "-c", a.command];
      const space = this.repoSpace(repo);
      if (space) {
        const before = new Set(space.tabs.map((t) => t.id));
        run("tab.new", { space: space.id, name: a.name, folder: repo.main, argv });
        const tab = spaces().find((s) => s.id === space.id)?.tabs.find((t) => !before.has(t.id));
        if (tab) this.runs[k] = tab.id;
      } else {
        const before = new Set(spaces().map((s) => s.id));
        run("space.new", { folder: repo.main, machine: repo.machine ?? "", tab: a.name, argv });
        const made = spaces().find((s) => !before.has(s.id));
        if (made?.tabs[0]) this.runs[k] = made.tabs[0].id;
      }
      this.saveRuns();
      this.running.add(k);
      cx.notify();
    });
  }

  // ---- drawing ----

  render() {
    const t = theme();
    const repos = this.repos ?? [];
    const store = shared(ACTIONS) ?? {};
    const wtCount = repos.reduce((n, r) => n + r.worktrees.length, 0);
    const meta = this.repos && repos.length > 0 ? `${repos.length} repo${repos.length === 1 ? "" : "s"} · ${wtCount} worktree${wtCount === 1 ? "" : "s"}` : undefined;
    return v_flex().id("wt-root").size_full().bg(t.background).text_color(t.foreground).text_size(TYPE.sm)
      .child(panelHeader({ id: "wt-header", title: "Worktrees", meta, busy: Boolean(this.busy),
        actions: [{ id: "wt-refresh", icon: REFRESH_ICON, label: "Refresh", onClick: (cx) => this.refresh(cx, true) }] }, t))
      .child(v_flex().id("wt-body").flex_1().min_h(0).overflow_y_scrollbar().px(SPACE.PX).pt(SPACE.GAP).pb(20).gap(10)
        .when(this.repos === null, (el) => el.child(div().py(8).text_size(TYPE.sm).text_color(metaColor(t)).child("Reading repositories…")))
        .when(this.repos !== null && repos.length === 0 && this.quiet.length === 0, (el) => el.child(noRepoState({ id: "wt-no-repo" }, t)))
        .when(repos.length > 0, (el) => el.child(sectionLabel("Worktrees", t)))
        .children(repos.map((r) => this.repoCard(r, t)))
        .children(this.quiet.map((q, i) => div().id(`wt-q-${i}`).text_size(TYPE.xs).text_color(metaColor(t)).truncate().child(q)))
        .when(Boolean(this.gh), (el) => el.child(div().text_size(TYPE.xs).text_color(t.blocked).truncate().child(this.gh)))
        .when(repos.length > 0, (el) => el.child(sectionLabel("Run actions", t)))
        .children(repos.map((r) => this.actionsCard(r, store[r.key] ?? [], t))));
  }

  // opts: { danger, primary, disabled, tooltip } mapped onto the shared kit button.
  button(id, label, t, onClick, opts = {}) {
    const kind = opts.danger ? "danger" : opts.primary ? "primary" : "secondary";
    return kitButton({ id, label, kind, disabled: Boolean(opts.disabled), tooltip: opts.tooltip, onClick: (cx) => onClick(cx) }, t);
  }

  tag(t, text, color) {
    return div().flex_none().max_w("100%").truncate().px(6).py(2).rounded(4).bg(t.raised).border_1().border_color(t.border).text_size(TYPE.xs).text_color(color).child(text);
  }

  card(id, t) {
    return v_flex().id(id).flex_none().p(12).gap(10).rounded(6).bg(t.surface).border_1().border_color(t.border);
  }

  repoHeader(r, t, extra) {
    const path = r.machine ? `${r.machine}:${r.main}` : tilde(r.main, home());
    return h_flex().gap(10).items_center().min_w(0)
      .child(div().text_size(TYPE.md).font_semibold().child(r.name))
      .child(mono(div().flex_1().min_w(0).truncate().text_size(TYPE.xs).text_color(metaColor(t, t.surface)).tooltip(path).child(tailPath(path))))
      .child(extra);
  }

  repoCard(r, t) {
    const msg = this.messages.get(r.key);
    const forming = this.form?.kind === "new" && this.form.key === r.key;
    return this.card(`wt-repo-${r.key}`, t)
      .child(this.repoHeader(r, t, forming ? div() : this.button(`wt-new-${r.key}`, "+ New worktree", t, (cx) => this.openForm({ kind: "new", key: r.key }, cx))))
      .when(forming, (el) => el.child(this.newForm(r, t)))
      .when(Boolean(r.error), (el) => el.child(div().text_size(TYPE.xs).text_color(t.blocked).truncate().child(r.error)))
      .when(Boolean(msg), (el) => el.child(div().text_size(TYPE.xs).text_color(metaColor(t, t.surface)).truncate().child(msg)))
      .children(r.worktrees.map((w) => this.worktreeRow(r, w, t)));
  }

  input(state, t, w) {
    const el = Input.new(state).h(28).px(8).items_center().rounded(6).border_1().border_color(t.input).bg(t.background).text_color(t.foreground);
    return w ? el.w(w).flex_none() : el.flex_1().min_w(0);
  }

  newForm(r, t) {
    const name = this.inBranch.value().trim();
    const path = name && !nameError(name) ? worktreePath(r.main, name) : null;
    const hint = div().text_size(TYPE.xs).truncate().text_color(this.formError ? t.blocked : metaColor(t, t.background))
      .child(this.formError || (path ? `→ ${path} (an existing branch is checked out as is)` : `→ ${worktreesRoot(r.main)}/<name>`));
    return v_flex().gap(6).p(10).rounded(6).border_1().border_color(t.border).bg(t.background)
      .child(h_flex().gap(8).items_center()
        .child(this.input(this.inBranch, t))
        .child(div().text_color(metaColor(t, t.background)).child("from"))
        .child(this.input(this.inBase, t, 200))
        .child(this.button(`wt-create-${r.key}`, this.formBusy ? "Creating…" : "Create", t, (cx) => this.submit(cx), { primary: true, disabled: this.formBusy }))
        .child(this.button(`wt-cancel-${r.key}`, "Cancel", t, (cx) => this.closeForm(cx))))
      .child(this.formError ? hint : mono(hint));
  }

  worktreeRow(r, w, t) {
    const k = `${r.key}\0${w.path}`;
    const space = this.spaceOn(r, w);
    const agentCount = this.agentsOn(r, w);
    const blockers = removeBlockers({ ...w, agents: agentCount });
    const pr = prFor(this.prs.get(r.key)?.list, w.branch);
    const confirming = (this.confirm.get(k) ?? 0) > Date.now();
    const busy = this.busyRows.has(k);
    const meta = metaColor(t, t.surface);
    // Each fact is [text, data]: data facts (counts, refs, ages) are set in mono, the words stay sans.
    const facts = [
      [w.prunable ? "folder missing" : w.dirty == null ? "status unknown" : w.dirty ? `${w.dirty} changed` : "clean", w.dirty > 0, w.dirty ? t.ansi3 : meta],
      [w.upstream ? `↑${w.ahead} ↓${w.behind} ${w.upstream}` : w.branch ? "no upstream" : "", Boolean(w.upstream), meta],
      [w.unpushed ? `${w.unpushed} unpushed` : "", true, meta],
      [w.committed ? `${ago(w.committed, Date.now() / 1000)} ago` : "", true, meta],
    ].filter((f) => f[0]);
    const prColor = pr?.state === "open" ? t.ansi2 : pr?.state === "merged" ? t.ansi5 : t.ansi1;
    const path = r.machine ? w.path : tilde(w.path, home());
    const why = !w.main && blockers.length > 0 ? `Can't remove: ${blockers.join(", ")}` : "";
    return h_flex().id(`wt-row-${k}`).flex_none().flex_wrap().items_start().gap(8).pt(8).border_t_1().border_color(t.border)
      .child(v_flex().flex_1().min_w(200).gap(4)
        .child(h_flex().flex_wrap().gap(6).items_center().min_w(0)
          .child(mono(div().min_w(0).max_w("100%").truncate().child(w.branch ?? (w.bare ? "(bare)" : `detached ${String(w.head ?? "").slice(0, 7)}`))))
          .when(w.main, (el) => el.child(this.tag(t, "main checkout", metaColor(t, t.raised))))
          .when(Boolean(pr), (el) => el.child(mono(this.tag(t, `PR #${pr.number} ${pr?.state}`, prColor))))
          .when(Boolean(space), (el) => el.child(this.tag(t, `space: ${space?.name}`, t.accent)))
          .when(agentCount > 0, (el) => el.child(this.tag(t, `${agentCount} agent${agentCount === 1 ? "" : "s"}`, t.working)))
          .when(w.locked, (el) => el.child(this.tag(t, "locked", t.ansi3))))
        .child(mono(div().text_size(TYPE.xs).text_color(meta).truncate().tooltip(path).child(tailPath(path))))
        .child(h_flex().flex_wrap().gap(4).items_center().text_size(TYPE.xs)
          .children(facts.flatMap(([text, data, color], i) => {
            const el = div().text_color(color).child(text);
            return [...(i ? [div().text_color(t.dim).child("·")] : []), data ? mono(el) : el];
          })))
        .when(pr?.state === "merged" && blockers.length === 0, (el) => el.child(div().text_size(TYPE.xs).text_color(meta).child("merged, can be removed")))
        .when(confirming, (el) => el.child(mono(div().text_size(TYPE.xs).text_color(t.blocked).truncate().child(`Click again to run: git worktree remove ${w.path}`))))
        .when(Boolean(why), (el) => el.child(div().text_size(TYPE.xs).text_color(meta).truncate().child(why))))
      .child(h_flex().flex_none().gap(8)
        .when(!w.prunable && !w.bare, (el) => el.child(this.button(`wt-open-${k}`, space ? "Go to space" : "Open space", t, () => this.openSpace(r, w))))
        .when(!w.main, (el) => el.child(this.button(`wt-rm-${k}`, busy ? "Removing…" : confirming ? "Confirm remove" : "Remove", t,
          (cx) => this.remove(r, w, cx), { danger: confirming, disabled: busy || blockers.length > 0, tooltip: why || undefined }))));
  }

  actionsCard(r, list, t) {
    const forming = this.form?.kind === "action" && this.form.key === r.key;
    const meta = metaColor(t, t.surface);
    return this.card(`wt-act-${r.key}`, t)
      .child(this.repoHeader(r, t, forming && !this.form.id ? div() : this.button(`wt-addact-${r.key}`, "+ Add action", t, (cx) => this.openForm({ kind: "action", key: r.key, id: null }, cx))))
      .when(forming && !this.form.id, (el) => el.child(this.actionForm(r, t)))
      .when(list.length === 0 && !forming, (el) => el.child(div().text_color(meta).child("No saved actions.")))
      .children(list.map((a) => forming && this.form.id === a.id ? this.actionForm(r, t) : this.actionRow(r, a, t)))
      .when(Boolean(r.launch?.length), (el) => el
        .child(div().pt(4).text_size(TYPE.xs).font_semibold().text_color(meta).child(".claude/launch.json (read-only)"))
        .children(r.launch.map((c, i) => h_flex().id(`wt-launch-${r.key}-${i}`).gap(12).items_center().min_w(0)
          .child(div().w(180).flex_none().truncate().child(c.name))
          .child(mono(div().flex_1().min_w(0).truncate().text_color(meta).child(c.command))))));
  }

  actionRow(r, a, t) {
    const k = `${r.key}\0${a.id}`;
    const running = this.running.has(k);
    const confirming = (this.confirm.get(`act\0${r.key}\0${a.id}`) ?? 0) > Date.now();
    return h_flex().id(`wt-a-${k}`).gap(12).items_center().min_w(0).pt(6).border_t_1().border_color(t.border)
      .child(div().w(180).flex_none().truncate().child(a.name))
      .child(mono(div().flex_1().min_w(0).truncate().text_color(metaColor(t, t.surface)).child(a.command)))
      .when(running, (el) => el.child(this.tag(t, "running", t.working)))
      .child(this.button(`wt-run-${k}`, running ? "Show" : "▶ Run", t, (cx) => this.runAction(r, a, cx), { primary: true }))
      .child(this.button(`wt-edit-${k}`, "Edit", t, (cx) => this.openForm({ kind: "action", key: r.key, id: a.id }, cx)))
      .child(this.button(`wt-del-${k}`, confirming ? "Confirm delete" : "Delete", t, (cx) => this.removeAction(r.key, a.id, cx), { danger: confirming }));
  }

  actionForm(r, t) {
    const hint = div().text_size(TYPE.xs).truncate().text_color(this.formError ? t.blocked : metaColor(t, t.background))
      .child(this.formError || `Runs with sh -c in a new tab, in ${r.machine ? r.main : tilde(r.main, home())}`);
    return v_flex().gap(6).p(10).rounded(6).border_1().border_color(t.border).bg(t.background)
      .child(h_flex().gap(8).items_center()
        .child(this.input(this.inName, t, 180))
        .child(this.input(this.inCmd, t))
        .child(this.button(`wt-save-${r.key}`, "Save", t, (cx) => this.submit(cx), { primary: true }))
        .child(this.button(`wt-acancel-${r.key}`, "Cancel", t, (cx) => this.closeForm(cx))))
      .child(hint);
  }
}
