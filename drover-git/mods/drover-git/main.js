// Git browser: branches (current, default, recent, local, remote), worktrees, local switch /
// fetch / pull / merge / push / new branch, conflict help and the forge's pull requests.
// Opens as a dialog (mod.open) or as a pane / tab (props: { cwd?, on? }).
// Every program it starts goes through git.js (argv only, forbidden flags refused).
import { View, div, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { spaces, panes, agents, focused, theme, window, run, props, closeOverlay, hc, appHome, home, readTextFile } from "herdr";
import {
  blockers, blocking, agentsBusyIn, pickFolder, placeOf, matches, ago, clean, conflictPrompt, askArgs, branchNameProblem,
  switchArgs, fetchArgs, pullArgs, mergeArgs, pushArgs, newBranchArgs, abortMergeArgs, CONFIRM_MS, STALE_MS, trackedChanges,
} from "./logic.js";
import { gitRead, gitWrite, gitNet, gh, glab, helper, repoOf, readAll, forgeOf, mergePreview, compare, validBranch, openLocal } from "./git.js";
import { webUrls, safeUrl, showUrl } from "./forges/index.js";
import * as github from "./forges/github.js";
import * as gitlab from "./forges/gitlab.js";
import * as bitbucket from "./forges/bitbucket.js";
import { resolveIcon } from "./lib/icons.js";
import { isDenied } from "./lib/guard.js";
import { tilde, basename } from "./lib/paths.js";
import { TYPE, mono, metaColor, sectionLabel, panelHeader, button as uiButton, iconButton, chip, emptyState, noRepoState } from "./lib/panel-ui.js";

const MOD = "drover-git";
const TICK_MS = 3000;
// Below this body width the detail stacks under the list; side by side it is DETAIL_W wide.
const DETAIL_STACK_W = 560;
const DETAIL_W = 300;
const REMOTE_SHOWN = 150;
const LOCAL_SHOWN = 200;
const UI = (name) => `mods/${MOD}/ui/${name}.svg`;
const firstLine = (text, max = 200) => String(text ?? "").split(/\r?\n/)[0].slice(0, max);
const ERROR_MS = 9000;
const NOTE_MS = 5000;
const idPart = (s) => String(s).replace(/[^\w-]/g, "_").slice(0, 80);
const MARKS = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed", U: "Conflicted", "?": "Untracked" };
const markWord = (xy, conflict) => (conflict ? "Conflicted" : [...new Set([...String(xy)].map((c) => MARKS[c]).filter(Boolean))].join(", ") || "Changed");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

export default class Git extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.fixed = Boolean(p.cwd);
    this.on = p.on ?? this.focusMachine();
    this.folder = this.fixed ? String(p.cwd) : this.focusFolder();
    this.repo = undefined; // undefined: reading, null: not a repository
    this.data = null;
    this.error = "";
    this.settings = { forgeHosts: {}, bitbucketHelper: null, fetchPrune: false, problem: "" };
    this.forge = null;
    this.sel = null; // { kind: "current" | "local" | "remote" | "worktree", name }
    this.tab = "branch";
    this.mergeMode = "ff";
    this.newFrom = "current";
    this.preview = null; // { key, incoming, ff, error }
    this.cmp = null; // { key, ahead, behind }
    this.confirm = null; // { kind, key, until, text?, address?, agent? }
    this.busy = null; // label of the running action
    this.message = null; // { text, bad }
    this.prs = null; // { kind, rows, error, busy, at, browser }
    this.ghSettings = null;
    this.viewer = false;
    this.reading = false;
    this.filterText = "";
    this.filter = InputState.new({ placeholder: "Filter branches and worktrees", value: "" });
    this.filter.on("change", (_e, cx) => { this.filterText = this.filter.value(); cx.notify(); });
    this.branchText = "";
    this.branchInput = InputState.new({ placeholder: "new-branch-name", value: "" });
    this.branchInput.on("change", (_e, cx) => { this.branchText = this.branchInput.value(); cx.notify(); });
    this.branchInput.on("submit", (_e, cx) => this.newBranch(cx));
    this.userHome = this.on ? "" : home();
    cx.spawn(async (cx) => {
      await this.loadSettings();
      await this.readNow();
      cx.notify();
    });
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
  }

  // --- where ---

  focusMachine() {
    const f = focused();
    const sp = spaces().find((s) => s.id === f?.space) ?? spaces().find((s) => s.active);
    return sp?.machine ?? null;
  }

  focusFolder() {
    const f = focused();
    // our own pane has no cwd: keep reading what we read
    return pickFolder({ propsCwd: null, focus: f, paneList: panes(), spaceList: spaces(), agentList: agents() });
  }

  async loadSettings() {
    try {
      const text = await readTextFile(`${appHome()}/data/${MOD}/settings.json`);
      if (text == null) throw new Error("not found");
      const s = JSON.parse(text);
      const hosts = {};
      for (const [k, v] of Object.entries(s?.forgeHosts ?? {})) if (typeof k === "string" && ["github", "gitlab", "bitbucket"].includes(v)) hosts[k] = v;
      this.settings = { forgeHosts: hosts, bitbucketHelper: s?.bitbucketHelper ?? null, fetchPrune: s?.fetchPrune === true, problem: "" };
    } catch (e) {
      const missing = /not found|no such|ENOENT|does not exist/i.test(String(e?.message ?? e));
      this.settings = { forgeHosts: {}, bitbucketHelper: null, fetchPrune: false, problem: missing ? "" : "settings.json could not be read as JSON" };
    }
    try {
      this.viewer = (await readTextFile(`${appHome()}/mods/drover-viewer/mod.json`)) != null;
    } catch { this.viewer = false; }
  }

  noRepoText() {
    return this.folder ? `${tilde(this.folder, this.userHome)} isn't inside a git repository.` : "This space's folder isn't inside a git repository.";
  }

  // --- reading ---

  async readNow() {
    if (this.reading) return;
    this.reading = true;
    const folder = this.folder;
    try {
      const repo = folder ? await repoOf(folder, this.on) : null;
      if (folder !== this.folder) return;
      if (repo?.top !== this.repo?.top) { this.sel = null; this.prs = null; this.preview = null; this.cmp = null; }
      this.repo = repo;
      if (!repo) { this.data = null; this.error = ""; return; }
      this.data = await readAll(repo, this.on);
      this.error = "";
      this.forge = forgeOf(this.data, this.settings.forgeHosts);
      if (this.sel && !this.exists(this.sel)) this.sel = null;
    } catch (e) {
      this.error = clean(e?.message ?? e, 240);
    } finally {
      this.reading = false;
    }
  }

  exists(sel) {
    const d = this.data;
    if (!d) return false;
    if (sel.kind === "current") return true;
    if (sel.kind === "local") return d.locals.some((l) => l.name === sel.name);
    if (sel.kind === "remote") return d.remotes.some((r) => r.ref === sel.name);
    if (sel.kind === "worktree") return d.worktrees.some((w) => w.path === sel.name);
    return false;
  }

  tick(cx) {
    const m = this.message;
    if (m !== this.noteSeen) { this.noteSeen = m; this.noteAt = Date.now(); }
    if (m && Date.now() - this.noteAt > (m.bad ? ERROR_MS : NOTE_MS)) { this.message = null; this.noteSeen = null; cx.notify(); }
    if (this.busy || this.reading) return;
    if (window() && window().active === false) return;
    if (!this.fixed) {
      const f = focused();
      const next = f?.cwd ?? null;
      if (next && next !== this.folder && !(this.repo && (next === this.repo.top || next.startsWith(`${this.repo.top}/`)))) {
        this.folder = next;
        this.on = this.focusMachine();
        this.userHome = this.on ? "" : home();
        this.repo = undefined;
        cx.spawn(async (cx) => { await this.readNow(); cx.notify(); });
        cx.notify();
        return;
      }
    }
    if (this.data && Date.now() - this.data.readAt < STALE_MS) return;
    if (this.repo === null && Date.now() - (this.lastMiss ?? 0) < STALE_MS) return;
    this.lastMiss = Date.now();
    cx.spawn(async (cx) => { await this.readNow(); cx.notify(); });
  }

  refresh(cx) {
    this.message = null;
    cx.spawn(async (cx) => {
      await this.loadSettings();
      await this.readNow();
      if (this.tab === "prs") await this.loadPRs();
      if (this.sel) await this.loadSelection();
      cx.notify();
    });
  }

  state(target) {
    const d = this.data;
    return {
      status: d?.status, op: d?.op, readAt: d?.readAt, top: this.repo?.top,
      agentsBusy: agentsBusyIn(this.repo?.top, agents(), panes()),
      isDefault: Boolean(d?.def?.name && d.def.name === d?.status?.head),
      target,
    };
  }

  /** Blockers as the screen shows them (the read is fresh by definition; actions re-read anyway). */
  shownBlockers(action, target) {
    const s = this.state(target);
    return blockers(action, s, s.readAt ?? Date.now()).filter((b) => b.code !== "stale");
  }

  // --- selection ---

  select(sel, cx) {
    this.sel = sel;
    this.tab = "branch";
    this.preview = null;
    this.cmp = null;
    this.message = null;
    if (this.confirm?.kind !== "ask") this.confirm = null;
    cx.spawn(async (cx) => { await this.loadSelection(); cx.notify(); });
    cx.notify();
  }

  selRef() {
    const s = this.sel;
    if (!s || !this.data) return null;
    if (s.kind === "local" || s.kind === "remote") return s.name;
    if (s.kind === "worktree") return this.data.worktrees.find((w) => w.path === s.name)?.branch ?? null;
    return null;
  }

  async loadSelection() {
    const ref = this.selRef();
    const head = this.data?.status?.head;
    if (!ref || !head || ref === head || !this.repo) return;
    const key = `${head}|${ref}`;
    const [p, c] = await Promise.all([
      mergePreview(this.repo.top, this.on, head, ref).catch(() => null),
      compare(this.repo.top, this.on, head, ref).catch(() => null),
    ]);
    if (this.selRef() !== ref) return;
    this.preview = p ? { key, ...p } : null;
    this.cmp = c ? { key, ...c } : null;
  }

  // --- confirmation ---

  armed(kind, key) {
    const c = this.confirm;
    return Boolean(c && c.kind === kind && c.key === key && c.until > Date.now());
  }

  arm(kind, key, cx, extra = {}) {
    this.confirm = { kind, key, until: Date.now() + CONFIRM_MS, ...extra };
    this.message = null;
    cx.timer.after(CONFIRM_MS + 50, (cx) => {
      if (this.confirm?.kind === kind && this.confirm.key === key && this.confirm.until <= Date.now()) {
        this.confirm = null;
        cx.notify();
      }
    });
    cx.notify();
  }

  // Runs one write: re-reads, checks blockers again, runs, re-reads, reports.
  write(cx, label, action, target, run, done) {
    if (this.busy) return;
    this.busy = label;
    this.confirm = null;
    this.message = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.readNow();
        const stop = blocking(blockers(action, this.state(typeof target === "function" ? target() : target), Date.now()));
        if (!this.data) this.message = { text: this.error || this.noRepoText(), bad: true };
        else if (stop.length) this.message = { text: stop.map((b) => b.text).join(" · "), bad: true };
        else {
          const r = await run();
          this.message = r.ok ? { text: done(r), bad: false } : { text: r.err || "Failed", bad: true };
        }
      } catch (e) {
        this.message = { text: clean(e?.message ?? e, 200), bad: true };
      }
      await this.readNow();
      if (this.sel) await this.loadSelection();
      this.busy = null;
      cx.notify();
    });
  }

  // --- actions ---

  fetch(cx) {
    const remote = this.data?.upstreamRemote ?? this.data?.remote;
    if (!remote) { this.message = { text: "No remote to fetch from", bad: true }; cx.notify(); return; }
    this.write(cx, "Fetching…", "fetch", null, () => gitNet(this.repo.top, this.on, fetchArgs(remote, { prune: this.settings.fetchPrune })), () => `Fetched ${remote}`);
  }

  pull(cx) {
    const remote = this.data?.upstreamRemote;
    this.write(cx, "Pulling…", "pull", null, async () => {
      if (remote) {
        const f = await gitNet(this.repo.top, this.on, fetchArgs(remote));
        if (!f.ok) return f;
        await this.readNow();
        const stop = blocking(blockers("pull", this.state(null), Date.now()));
        if (stop.length) return { ok: false, err: stop.map((b) => b.text).join(" · ") };
        if (this.data.status.behind === 0) return { ok: true, out: "", upToDate: true };
      }
      return gitWrite(this.repo.top, this.on, pullArgs());
    }, (r) => (r.upToDate ? "Already up to date" : "Fast-forwarded to upstream"));
  }

  push(cx) {
    const st = this.data?.status;
    if (!st?.head) return;
    const key = st.head;
    const remote = this.data.upstreamRemote ?? this.data.remote;
    if (!st.upstream && !remote) { this.message = { text: "No remote to push to", bad: true }; cx.notify(); return; }
    if (!this.armed("push", key)) { this.arm("push", key, cx); return; }
    const args = pushArgs({ hasUpstream: Boolean(st.upstream), remote, branch: st.head });
    this.write(cx, "Pushing…", "push", null, () => gitNet(this.repo.top, this.on, args),
      () => (st.upstream ? `Pushed ${st.head} to ${st.upstream}` : `Pushed ${st.head} to ${remote} and set it as upstream`));
  }

  switchTo(cx, target) {
    // target: { name, remoteRef?, worktree? }
    const key = target.remoteRef ?? target.name;
    const warns = this.shownBlockers("switch", target).filter((b) => b.level === "warn");
    if (warns.length && !this.armed("switch", key)) { this.arm("switch", key, cx); return; }
    const args = switchArgs(target.name, target.remoteRef ?? null);
    this.write(cx, "Switching…", "switch", target, () => gitWrite(this.repo.top, this.on, args), () => `Now on ${target.name}`);
  }

  merge(cx, ref) {
    const head = this.data?.status?.head;
    if (!head) return;
    const key = `${head}|${ref}|${this.mergeMode}`;
    if (!this.armed("merge", key)) { this.arm("merge", key, cx); return; }
    const mode = this.mergeMode;
    this.write(cx, "Merging…", "merge", { name: ref }, async () => {
      const p = await mergePreview(this.repo.top, this.on, head, ref);
      if (p.incoming === 0) return { ok: true, upToDate: true };
      if (mode === "ff" && !p.ff) return { ok: false, err: "Not a fast-forward: choose --no-ff to make a merge commit" };
      return gitWrite(this.repo.top, this.on, mergeArgs(ref, mode));
    }, (r) => (r.upToDate ? `${head} already has everything from ${ref}` : `Merged ${ref} into ${head}`));
  }

  abortMerge(cx) {
    if (!this.armed("abort", "merge")) { this.arm("abort", "merge", cx); return; }
    this.write(cx, "Aborting…", "abort", null, () => gitWrite(this.repo.top, this.on, abortMergeArgs()), () => "Merge aborted");
  }

  newBranch(cx) {
    const name = this.branchText.trim();
    const problem = branchNameProblem(name);
    if (problem) { this.message = { text: problem, bad: true }; cx.notify(); return; }
    const from = this.newFrom === "selected" && this.selRef() ? this.selRef() : this.data?.status?.head ?? "HEAD";
    if (this.data?.locals.some((l) => l.name === name)) { this.message = { text: `${name} already exists`, bad: true }; cx.notify(); return; }
    this.write(cx, "Creating…", "newBranch", null, async () => {
      if (!(await validBranch(this.repo.top, this.on, name))) return { ok: false, err: "git does not accept that branch name" };
      return gitWrite(this.repo.top, this.on, newBranchArgs(name, from === "HEAD" ? this.data.status.oid : from));
    }, () => {
      this.branchText = "";
      this.branchInput.set_value("");
      return `Created ${name} from ${from} and switched to it`;
    });
  }

  openUrl(cx, url) {
    const u = safeUrl(url);
    if (!u) { this.message = { text: "Not a web address", bad: true }; cx.notify(); return; }
    cx.open_url(u);
  }

  openFile(cx, rel) {
    const abs = `${this.repo.top}/${rel}`;
    if (isDenied(abs)) { this.message = { text: "Refused: credential files are not opened here", bad: true }; cx.notify(); return; }
    if (this.viewer) {
      run("tab.new", { mod: "drover-viewer", props: { file: abs, on: this.on ?? null } });
      this.closeDialog();
      return;
    }
    if (this.on) { this.message = { text: "A file viewer is needed for files on another machine", bad: true }; cx.notify(); return; }
    cx.spawn(async (cx) => {
      const r = await openLocal(abs, window()?.platform);
      if (!r.ok) this.message = { text: r.err, bad: true, copy: r.copy ?? null };
      cx.notify();
    });
  }

  goToPlace(cx, folder) {
    const place = placeOf(folder, panes(), spaces());
    if (!place) { this.message = { text: "No open space is in that folder", bad: true }; cx.notify(); return; }
    run("space.select", { id: place.space });
    run("tab.select", { id: place.tab });
    this.closeDialog();
  }

  showHere(cx, folder) {
    this.folder = folder;
    this.fixed = true;
    this.repo = undefined;
    this.data = null;
    this.sel = null;
    this.prs = null;
    cx.spawn(async (cx) => { await this.readNow(); cx.notify(); });
    cx.notify();
  }

  closeDialog() {
    const o = props()?.overlay;
    if (o) closeOverlay(o);
  }

  // The agent "Ask agent" talks to: the focused one, else the only agent working in this repo.
  askTarget() {
    const list = agents();
    const f = focused();
    const byAddr = f?.agent ? list.find((a) => a.address === f.agent) : null;
    if (byAddr) return byAddr;
    const top = this.repo?.top;
    const cwdOf = new Map(panes().map((p) => [p.pane, p.cwd]));
    const here = list.filter((a) => { const c = cwdOf.get(a.pane); return top && c && (c === top || c.startsWith(`${top}/`)); });
    return here.length === 1 ? here[0] : null;
  }

  ask(cx) {
    const agent = this.askTarget();
    if (!agent) return;
    const files = this.data?.status?.conflicted ?? [];
    const text = conflictPrompt(this.data?.status?.head, files, this.data?.op ?? "merge");
    const c = this.confirm;
    if (c?.kind !== "ask" || c.address !== agent.address) {
      this.confirm = { kind: "ask", key: "ask", until: Number.MAX_SAFE_INTEGER, address: agent.address, agent: clean(agent.title || agent.app || agent.address, 40), text };
      this.message = null;
      cx.notify();
      return;
    }
    const sent = c.text;
    this.confirm = null;
    this.busy = "Sending…";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await hc(askArgs(c.address, sent));
        this.message = r.code === 0 ? { text: `Sent to ${c.agent}`, bad: false } : { text: "The agent could not be reached", bad: true };
      } catch {
        this.message = { text: "The agent could not be reached", bad: true };
      }
      this.busy = null;
      cx.notify();
    });
  }

  copyPrompt(cx) {
    const files = this.data?.status?.conflicted ?? [];
    cx.write_to_clipboard(conflictPrompt(this.data?.status?.head, files, this.data?.op ?? "merge"));
    this.message = { text: "Copied the prompt", bad: false };
    cx.notify();
  }

  // --- pull requests ---

  showPRs(cx) {
    this.tab = "prs";
    if (!this.prs || Date.now() - (this.prs.at ?? 0) > 60000) {
      cx.spawn(async (cx) => { await this.loadPRs(); cx.notify(); });
    }
    cx.notify();
  }

  async loadPRs() {
    const f = this.forge;
    if (!f?.kind) { this.prs = { kind: null, rows: [], error: "", at: Date.now() }; return; }
    this.prs = { ...(this.prs ?? {}), kind: f.kind, busy: true };
    let rows = [], error = "", browser = false;
    try {
      if (f.kind === "github") {
        const [r, s] = await Promise.all([gh(github.listArgs(f)), this.ghSettings ? null : gh(github.repoSettingsArgs(f))]);
        if (s?.ok) this.ghSettings = github.parseRepoSettings(s.out);
        if (r.ok) rows = github.parsePRs(r.out);
        else if (r.code === -1) { error = "gh is not installed or did not answer: open them in the browser"; browser = true; }
        else error = github.ghProblem(r.err);
      } else if (f.kind === "gitlab") {
        const r = await glab(gitlab.listArgs(f));
        if (r.ok) rows = gitlab.parseMRs(r.out);
        else if (r.code === -1) { error = "glab is not installed: merge requests open in the browser"; browser = true; }
        else error = gitlab.glabProblem(r.err);
      } else if (f.kind === "bitbucket") {
        const h = bitbucket.helperArgv(this.settings.bitbucketHelper, f);
        if (h.problem === "none") { browser = true; error = "Pull requests open in the browser (a helper can list them here: see README)"; }
        else if (h.problem) error = h.problem;
        else {
          const r = await helper(h.argv);
          if (r.ok) rows = bitbucket.parseHelperOutput(r.out);
          else error = r.code === -1 ? r.err : "The helper failed";
        }
      }
    } catch (e) {
      error = clean(e?.message ?? e, 200);
    }
    this.prs = { kind: f.kind, rows, error, browser, busy: false, at: Date.now() };
  }

  autoMerge(cx, pr) {
    const f = this.forge;
    const method = github.mergeMethod(this.ghSettings);
    if (!f || f.kind !== "github" || !pr.number || !method) return;
    const key = String(pr.number);
    if (!this.armed("auto", key)) { this.arm("auto", key, cx, { method }); return; }
    this.confirm = null;
    this.busy = "Enabling auto-merge…";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const v = await gh(github.viewArgs(f, pr.number));
        const refuse = v.ok ? github.freshAutoMergeBlock(v.out) : "Could not check the pull request; nothing was merged";
        if (refuse) this.message = { text: refuse, bad: true };
        else {
          const r = await gh(github.autoMergeArgs(f, pr.number, method), 30000);
          this.message = r.ok ? { text: `Auto-merge (${method}) is on for ${pr.id}`, bad: false } : { text: github.ghProblem(r.err), bad: true };
        }
      } catch (e) {
        this.message = { text: clean(e?.message ?? e, 200), bad: true };
      }
      this.busy = null;
      await this.loadPRs();
      cx.notify();
    });
  }

  // --- view ---

  render() {
    const t = theme();
    const d = this.data;
    return v_flex().id("git-root").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(TYPE.sm)
      .child(this.header(t))
      .when(this.repo === undefined, (el) => el.child(this.quiet(t, "Reading the repository…")))
      .when(this.repo === null && !this.folder, (el) => el.child(emptyState({ id: "git-no-folder", title: "No folder",
        body: "Focus a terminal to show its folder here." }, t)))
      .when(this.repo === null && Boolean(this.folder), (el) => el.child(noRepoState({ id: "git-no-repo", folder: tilde(this.folder, this.userHome) }, t)))
      .when(Boolean(this.repo) && !d && Boolean(this.error), (el) => el.child(emptyState({ id: "git-error", tone: "error",
        title: "Could not read the repository", body: firstLine(this.error) }, t)))
      .when(Boolean(this.repo) && !d && !this.error, (el) => el.child(this.quiet(t, "Reading the repository…")))
      .when(Boolean(this.repo && d), (el) => el
        .child(this.statusBar(t))
        .child(this.body(t)))
      .child(this.footer(t));
  }

  // The list and the detail side by side; stacked (list on top) when the panel is too narrow for both.
  body(t) {
    const narrow = (this.bodyW ?? Infinity) < DETAIL_STACK_W;
    const box = narrow ? v_flex() : h_flex().items_start();
    return box.id("git-body").flex_1().min_h(0)
      .on_size_change((size, cx) => { const w = Math.round(size.width); if (w !== this.bodyW) { this.bodyW = w; cx.notify(); } })
      .child(this.sidebar(t, narrow))
      .child(this.detailPane(t, narrow));
  }

  // The loading line: the header spinner says "busy"; this one line says what is being read.
  quiet(t, text) {
    return div().flex_1().px(16).py(12).text_size(TYPE.sm).text_color(metaColor(t)).child(text);
  }

  header(t) {
    const r = this.repo;
    const actions = [];
    if (this.data) {
      actions.push({ id: "act-fetch", icon: UI("fetch"), label: "Fetch from remote", onClick: (cx) => this.fetch(cx),
        disabled: Boolean(this.busy) || !this.data?.remoteNames?.length });
    }
    actions.push({ id: "act-refresh", icon: UI("refresh"), label: "Refresh", onClick: (cx) => this.refresh(cx), disabled: Boolean(this.busy) });
    return panelHeader({ id: "git-header", title: "Git", meta: r?.name, actions, busy: this.repo === undefined || this.reading || Boolean(this.busy) }, t);
  }

  statusBar(t) {
    const d = this.data;
    const st = d.status;
    const head = st.detached ? `detached at ${(st.oid ?? "").slice(0, 8)}` : st.head ?? "";
    const tracked = trackedChanges(st);
    const pushB = this.shownBlockers("push", null);
    const pullB = this.shownBlockers("pull", null);
    const pushing = this.armed("push", st.head);
    const remote = d.upstreamRemote ?? d.remote;
    const pushLabel = pushing
      ? (st.upstream ? `Confirm push to ${st.upstream}` : `Confirm push -u ${remote} ${st.head}`)
      : st.upstream ? `Push${st.ahead ? ` ${st.ahead}` : ""}` : "Push (set upstream)";
    const pushStop = blocking(pushB);
    return v_flex().id("git-status").flex_none().px(16).py(8).gap(6).border_b_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(10).items_center().min_w(0).flex_wrap()
        .child(div().flex_none().text_color(metaColor(t, t.surface)).child("On"))
        .child(mono(div().text_size(TYPE.sm).font_medium().flex_none().max_w(260).truncate().text_color(st.detached ? t.ansi3 : t.foreground).child(head)))
        .when(Boolean(st.upstream), (el) => el.child(mono(div().min_w(0).truncate().text_color(metaColor(t, t.surface)).child(`→ ${st.upstream}`))))
        .when(!st.upstream && !st.detached, (el) => el.child(this.tag(t, "no upstream", t.ansi3)))
        .when(st.ahead > 0, (el) => el.child(this.tag(t, `↑${st.ahead}`, t.ansi2, { data: true })))
        .when(st.behind > 0, (el) => el.child(this.tag(t, `↓${st.behind}`, t.ansi3, { data: true })))
        .child(this.tag(t, tracked || st.untracked ? `${tracked} changed · ${st.untracked} untracked` : "No changes", tracked ? t.ansi3 : t.dim))
        .when(Boolean(d.op), (el) => el.child(this.tag(t, `${d.op} in progress`, t.blocked)))
        .when(Boolean(this.on), (el) => el.child(this.tag(t, `on ${this.on}`, t.accent)))
        .when(Boolean(this.repo?.linked), (el) => el.child(this.tag(t, "worktree", t.muted)))
        .when(Boolean(d.def), (el) => el.child(h_flex().flex_none().gap(4).text_size(TYPE.xs).text_color(metaColor(t, t.surface))
          .child(div().child("default"))
          .child(mono(div().child(d.def.name)))))
        .child(div().flex_1().min_w(0))
        .child(this.button("act-pull", "Pull --ff-only", t, (cx) => this.pull(cx), { disabled: Boolean(this.busy) || blocking(pullB).length > 0, tooltip: this.why(pullB) }))
        .child(this.button("act-push", pushLabel, t, (cx) => this.push(cx), { danger: pushing, disabled: Boolean(this.busy) || pushStop.length > 0, tooltip: this.why(pushB) })))
      .when(pushing || pushStop.length > 0 || blocking(pullB).length > 0, (el) => el.child(h_flex().gap(12).flex_wrap().text_size(TYPE.xs)
        .when(pushing, (el) => el.children(pushB.filter((b) => b.level === "warn").map((b) => div().text_color(t.blocked).child(`⚠ ${b.text}`))))
        .when(pushing, (el) => el.child(div().text_color(metaColor(t, t.surface)).child("Click again within 6 s to push.")))
        .when(!pushing && pushStop.length > 0 && !st.detached, (el) => el.child(div().text_color(metaColor(t, t.surface)).child(`Push: ${pushStop.map((b) => b.text).join(" · ")}`)))
        .when(blocking(pullB).length > 0, (el) => el.child(div().text_color(metaColor(t, t.surface)).child(`Pull: ${blocking(pullB).map((b) => b.text).join(" · ")}`)))));
  }

  // --- left: sections ---

  sidebar(t, narrow = false) {
    const d = this.data;
    const q = this.filterText;
    const st = d.status;
    const head = st.head;
    const localNames = new Set(d.locals.map((l) => l.name));
    const recent = d.recent.filter((n) => matches(n, q));
    const locals = d.locals.filter((l) => matches(l.name, q));
    const remotes = d.remotes.filter((r) => matches(r.ref, q));
    const wts = d.worktrees.filter((w) => matches(`${w.path} ${w.branch ?? ""}`, q));
    const now = Date.now();
    const local = (l, sec) => this.row(t, `${sec}-${idPart(l.name)}`, { kind: "local", name: l.name }, l.name, [
      l.head ? this.tag(t, "current", t.accent) : null,
      l.worktree && !l.head ? this.tag(t, "worktree", t.muted) : null,
      l.gone ? this.tag(t, "gone", t.ansi3) : null,
      l.ahead ? mono(div().text_size(TYPE.xs).text_color(t.ansi2).child(`↑${l.ahead}`)) : null,
      l.behind ? mono(div().text_size(TYPE.xs).text_color(t.ansi3).child(`↓${l.behind}`)) : null,
      mono(div().w(34).text_right().text_size(TYPE.xs).text_color(metaColor(t)).child(l.date ? ago(now - l.date * 1000) : "")),
    ]);
    const defLocal = d.def ? d.locals.find((l) => l.name === d.def.name) : null;
    const defRemote = d.def && !defLocal ? d.remotes.find((r) => r.name === d.def.name && r.remote === (d.remote ?? "origin")) : null;
    return (narrow ? v_flex().flex_none().h(220).w_full().border_b_1() : v_flex().flex_1().min_w(160).h_full().min_h(0).border_r_1()).id("git-side").border_color(t.border)
      .child(div().flex_none().p(10).child(Input.new(this.filter).h(30).px(10).items_center().rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground)))
      .child(v_flex().id("git-sections").flex_1().min_h(0).overflow_y_scrollbar().px(10).pb(12).gap(10)
        .child(this.section(t, "Current", [
          this.row(t, "cur", { kind: "current", name: head ?? "" }, st.detached ? `detached ${(st.oid ?? "").slice(0, 8)}` : head ?? "", [
            st.ahead ? mono(div().text_size(TYPE.xs).text_color(t.ansi2).child(`↑${st.ahead}`)) : null,
            st.behind ? mono(div().text_size(TYPE.xs).text_color(t.ansi3).child(`↓${st.behind}`)) : null,
            st.dirty ? this.tag(t, `${st.dirty} dirty`, t.ansi3) : null,
          ]),
        ]))
        .child(this.section(t, "Default", [
          defLocal ? local(defLocal, "def")
            : defRemote ? this.row(t, "def-remote", { kind: "remote", name: defRemote.ref }, defRemote.ref, [this.tag(t, "remote only", t.muted)])
              : (d.def ? mono(div().px(8).text_color(metaColor(t)).child(d.def.name)) : div().px(8).text_color(metaColor(t)).child("No default branch found")),
        ]))
        .child(this.section(t, `Recent`, recent.length ? recent.map((n) => {
          const l = d.locals.find((x) => x.name === n);
          return l ? local(l, "rec") : null;
        }) : [div().px(8).text_color(metaColor(t)).child(q ? "No match" : "No branch switches in the reflog")]))
        .child(this.section(t, `Local (${d.locals.length})`, [
          ...locals.slice(0, LOCAL_SHOWN).map((l) => local(l, "loc")),
          locals.length > LOCAL_SHOWN ? div().px(8).text_color(metaColor(t)).child(`+${locals.length - LOCAL_SHOWN} more: type to filter`) : null,
          locals.length === 0 ? div().px(8).text_color(metaColor(t)).child("No match") : null,
        ]))
        .child(this.section(t, `Remote (${d.remotes.length})`, [
          ...remotes.slice(0, REMOTE_SHOWN).map((r) => this.row(t, `rem-${idPart(r.ref)}`, { kind: "remote", name: r.ref }, r.ref, [
            localNames.has(r.name) ? this.tag(t, "local", t.dim) : null,
            mono(div().w(34).text_right().text_size(TYPE.xs).text_color(metaColor(t)).child(r.date ? ago(now - r.date * 1000) : "")),
          ])),
          remotes.length > REMOTE_SHOWN ? div().px(8).text_color(metaColor(t)).child(`+${remotes.length - REMOTE_SHOWN} more: type to filter`) : null,
          d.remotes.length === 0 ? div().px(8).text_color(metaColor(t)).child(d.remoteNames.length ? "No remote branches: try Fetch" : "No remote") : remotes.length === 0 ? div().px(8).text_color(metaColor(t)).child("No match") : null,
        ]))
        .child(this.section(t, `Worktrees (${d.worktrees.length})`, wts.map((w) => this.row(t, `wt-${idPart(w.path)}`, { kind: "worktree", name: w.path },
          basename(w.path) || w.path, [
            w.path === this.repo.top ? this.tag(t, "here", t.accent) : null,
            w.branch ? mono(div().min_w(0).max_w(140).truncate().text_size(TYPE.xs).text_color(metaColor(t)).child(w.branch)) : this.tag(t, w.bare ? "bare" : "detached", t.dim),
            w.locked ? this.tag(t, "locked", t.dim) : null,
            w.prunable ? this.tag(t, "prunable", t.ansi3) : null,
          ])))));
  }

  section(t, title, rows) {
    return v_flex().flex_none().gap(2)
      .child(div().px(8).child(sectionLabel(title, t)))
      .children(rows.filter(Boolean));
  }

  row(t, id, sel, label, extras) {
    const on = this.sel && this.sel.kind === sel.kind && this.sel.name === sel.name;
    return h_flex().id(`row-${id}`).flex_none().h(26).px(8).gap(8).items_center().rounded(5).cursor_pointer()
      .when(Boolean(on), (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.select(sel, cx))
      .child(mono(div().flex_1().min_w(0).truncate().child(label)))
      .children(extras.filter(Boolean));
  }

  // --- right: detail ---

  detailPane(t, narrow = false) {
    const d = this.data;
    const conflict = d.status.conflicted.length > 0 || Boolean(d.op);
    // Side by side the detail has a fixed width, so the list keeps the rest; stacked it takes what is left below.
    return (narrow ? v_flex().flex_1().min_h(0).w_full() : v_flex().flex_none().w(DETAIL_W).h_full().min_h(0)).id("git-detail")
      .child(h_flex().flex_none().h(36).px(14).gap(4).items_center().border_b_1().border_color(t.border)
        .child(this.tabButton(t, "branch", "Branch"))
        .child(this.tabButton(t, "prs", this.forgeLabel()))
        .child(div().flex_1())
        .children(this.webButtons(t)))
      .child(v_flex().id("git-detail-body").flex_1().min_h(0).overflow_y_scrollbar().p(14).gap(12)
        .when(conflict, (el) => el.child(this.conflictCard(t)))
        .when(this.tab === "branch", (el) => el.child(this.branchDetail(t)).child(this.newBranchCard(t)))
        .when(this.tab === "prs", (el) => el.child(this.prList(t))));
  }

  forgeLabel() {
    const k = this.forge?.kind;
    return k === "gitlab" ? "Merge requests" : "Pull requests";
  }

  tabButton(t, key, label) {
    const on = this.tab === key;
    return div().id(`tab-${key}`).px(10).h(26).flex().items_center().rounded(5).cursor_pointer()
      .text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected))
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { if (key === "prs") this.showPRs(cx); else { this.tab = key; cx.notify(); } })
      .child(label);
  }

  webButtons(t) {
    const f = this.forge;
    if (!f?.web) return [];
    const branch = this.selRef() ?? this.data?.status?.head;
    const base = this.data?.def?.name;
    const plainBranch = branch && this.sel?.kind === "remote" ? this.data.remotes.find((r) => r.ref === branch)?.name : branch;
    const u = webUrls(f, { branch: plainBranch, base: plainBranch !== base ? base : undefined });
    return [
      this.button("web-repo", "Repo ↗", t, (cx) => this.openUrl(cx, u.repo), { disabled: !u.repo }),
      this.button("web-branch", "Branch ↗", t, (cx) => this.openUrl(cx, u.branch), { disabled: !u.branch }),
      this.button("web-compare", f.kind === "gitlab" ? "New MR ↗" : "New PR ↗", t, (cx) => this.openUrl(cx, u.compare), { disabled: !u.compare || plainBranch === base }),
    ];
  }

  branchDetail(t) {
    const d = this.data;
    const st = d.status;
    const sel = this.sel ?? { kind: "current", name: st.head ?? "" };
    if (sel.kind === "worktree") return this.worktreeDetail(t, d.worktrees.find((w) => w.path === sel.name));
    const isCurrent = sel.kind === "current" || (sel.kind === "local" && sel.name === st.head);
    if (isCurrent) return this.currentDetail(t);
    const local = sel.kind === "local" ? d.locals.find((l) => l.name === sel.name) : null;
    const remote = sel.kind === "remote" ? d.remotes.find((r) => r.ref === sel.name) : null;
    if (!local && !remote) return div().text_color(metaColor(t)).child("Select a branch.");
    const ref = sel.name;
    const now = Date.now();
    const localTwin = remote ? d.locals.find((l) => l.name === remote.name) : null;
    const switchTarget = local
      ? { name: local.name, worktree: local.worktree }
      : localTwin ? { name: localTwin.name, worktree: localTwin.worktree } : { name: remote.name, remoteRef: remote.ref };
    const swB = this.shownBlockers("switch", switchTarget);
    const swKey = switchTarget.remoteRef ?? switchTarget.name;
    const swArmed = this.armed("switch", swKey);
    const elsewhere = local?.worktree && local.worktree !== this.repo.top ? local.worktree : null;
    const mgB = this.shownBlockers("merge", { name: ref });
    const mgKey = `${st.head}|${ref}|${this.mergeMode}`;
    const mgArmed = this.armed("merge", mgKey);
    const p = this.preview?.key === `${st.head}|${ref}` ? this.preview : null;
    const c = this.cmp?.key === `${st.head}|${ref}` ? this.cmp : null;
    const commit = local ?? remote;
    const swLabel = swArmed ? "Confirm switch" : remote && !localTwin ? `Switch (track ${remote.ref})` : `Switch to ${switchTarget.name}`;
    const incomingText = p == null ? "counting…" : p.error ? p.error : p.incoming === 0 ? "nothing new" : `${plural(p.incoming, "commit")}${p.ff ? ", fast-forward possible" : ", needs a merge commit"}`;
    return v_flex().gap(10)
      .child(h_flex().gap(8).items_center().min_w(0)
        .child(mono(div().text_size(TYPE.lg).font_semibold().min_w(0).truncate().child(ref)))
        .when(Boolean(remote), (el) => el.child(this.tag(t, "remote", t.muted)))
        .when(Boolean(local?.gone), (el) => el.child(this.tag(t, "upstream gone", t.ansi3))))
      .child(v_flex().gap(5)
        .child(this.field(t, "Last commit", commit?.sha
          ? h_flex().gap(6).min_w(0).child(mono(div().flex_none().text_color(metaColor(t)).child(commit.sha)))
            .child(div().min_w(0).truncate().child(`${clean(commit.subject, 120)}${commit.date ? ` · ${ago(now - commit.date * 1000)}` : ""}`))
          : "—"))
        .when(Boolean(local), (el) => el.child(this.field(t, "Upstream", local.upstream ? `${local.upstream}${local.ahead || local.behind ? ` (↑${local.ahead} ↓${local.behind})` : ""}` : "none", undefined, Boolean(local.upstream))))
        .child(this.field(t, `vs ${st.head ?? "HEAD"}`, c ? `${c.ahead} only on ${st.head}, ${c.behind} only on ${ref}` : st.head ? "comparing…" : "detached HEAD"))
        .when(Boolean(local?.worktree), (el) => el.child(this.field(t, "Checked out", tilde(local.worktree, this.userHome), t.accent, true))))
      .child(this.card(t, "Switch", v_flex().gap(6)
        .child(h_flex().gap(6).flex_wrap()
          .when(!elsewhere, (el) => el.child(this.button("act-switch", swLabel, t, (cx) => this.switchTo(cx, switchTarget), { danger: swArmed, disabled: Boolean(this.busy) || blocking(swB).length > 0, tooltip: this.why(swB) })))
          .when(Boolean(elsewhere), (el) => el
            .child(this.button("act-goto", "Go to that worktree", t, (cx) => this.goToPlace(cx, elsewhere), { disabled: !placeOf(elsewhere, panes(), spaces()) }))
            .child(this.button("act-showwt", "Show it here", t, (cx) => this.showHere(cx, elsewhere)))))
        .children(this.blockerLines(t, swB, swArmed))))
      .child(this.card(t, `Merge ${ref} into ${st.head ?? "HEAD"}`, v_flex().gap(6)
        .child(this.field(t, "Incoming", incomingText, p?.incoming ? t.foreground : metaColor(t, t.surface)))
        .child(h_flex().gap(6).items_center().flex_wrap()
          .child(this.segment(t, [["ff", "--ff-only"], ["noff", "--no-ff"]], this.mergeMode, (k, cx) => { this.mergeMode = k; this.confirm = null; cx.notify(); }))
          .child(this.button("act-merge", mgArmed ? `Confirm merge (${this.mergeMode === "ff" ? "--ff-only" : "--no-ff"})` : "Merge…", t, (cx) => this.merge(cx, ref), {
            danger: mgArmed,
            disabled: Boolean(this.busy) || !st.head || blocking(mgB).length > 0 || p?.incoming === 0 || (this.mergeMode === "ff" && p != null && !p.ff && p.incoming > 0),
            tooltip: this.why(mgB),
          })))
        .when(this.mergeMode === "ff" && p != null && !p.ff && p.incoming > 0, (el) => el.child(div().text_size(TYPE.xs).text_color(metaColor(t, t.surface)).child("Not a fast-forward: choose --no-ff for a merge commit.")))
        .when(mgArmed, (el) => el.child(div().text_size(TYPE.xs).text_color(t.blocked).child(`Click again within 6 s: ${p?.incoming ? plural(p.incoming, "commit") : "commits"} from ${ref} into ${st.head}.`)))
        .children(this.blockerLines(t, mgB, false))));
  }

  currentDetail(t) {
    const d = this.data;
    const st = d.status;
    const files = st.files.filter((f) => f.kind !== "ignored" && f.kind !== "conflict");
    return v_flex().gap(10)
      .child(h_flex().gap(8).items_center()
        .child(mono(div().text_size(TYPE.lg).font_semibold().child(st.detached ? `detached at ${(st.oid ?? "").slice(0, 8)}` : st.head ?? "")))
        .child(this.tag(t, "current", t.accent)))
      .child(v_flex().gap(5)
        .child(this.field(t, "Upstream", st.upstream ? `${st.upstream} (↑${st.ahead} ↓${st.behind})` : "none: Push sets it", undefined, Boolean(st.upstream)))
        .child(this.field(t, "Default", d.def ? `${d.def.name} (${d.def.source})` : "unknown", undefined, Boolean(d.def)))
        .child(this.field(t, "Remotes", d.remoteNames.length ? d.remoteNames.join(", ") : "none", undefined, d.remoteNames.length > 0))
        .when(Boolean(this.forge?.web), (el) => el.child(this.field(t, "Forge", `${this.forge.kind ?? "unknown"} · ${showUrl(this.forge.web)}`)))
        .child(this.field(t, "Changes", files.length || st.conflicted.length
          ? [st.conflicted.length ? `${st.conflicted.length} conflicted` : null, `${st.staged} staged`, `${st.unstaged} unstaged`, `${st.untracked} untracked`].filter(Boolean).join(" · ")
          : "No changes", st.conflicted.length ? t.blocked : files.length ? t.ansi3 : metaColor(t))))
      .when(files.length > 0, (el) => el.child(v_flex().gap(1)
        .children(files.slice(0, 40).map((f) => this.fileRow(t, f.path, f.xy, false)))
        .when(files.length > 40, (el) => el.child(div().text_color(metaColor(t)).child(`+${files.length - 40} more`)))));
  }

  worktreeDetail(t, w) {
    if (!w) return div().text_color(metaColor(t)).child("That worktree is gone.");
    const here = w.path === this.repo.top;
    const place = placeOf(w.path, panes(), spaces());
    return v_flex().gap(10)
      .child(mono(div().text_size(TYPE.md).font_semibold().min_w(0).truncate().child(tilde(w.path, this.userHome))))
      .child(v_flex().gap(5)
        .child(this.field(t, "Branch", w.branch ?? (w.bare ? "bare" : "detached"), undefined, Boolean(w.branch)))
        .child(this.field(t, "HEAD", (w.head ?? "").slice(0, 10), undefined, true))
        .when(w.locked, (el) => el.child(this.field(t, "Locked", "yes")))
        .when(w.prunable, (el) => el.child(this.field(t, "Prunable", "its folder is gone", t.ansi3)))
        .child(this.field(t, "Open in", place ? place.name : "no open space", place ? t.accent : metaColor(t))))
      .child(h_flex().gap(6).flex_wrap()
        .child(this.button("wt-go", "Go to space", t, (cx) => this.goToPlace(cx, w.path), { disabled: !place || here }))
        .child(this.button("wt-show", "Show it here", t, (cx) => this.showHere(cx, w.path), { disabled: here || w.bare || w.prunable }))
        .child(this.button("wt-term", "Terminal there", t, () => { run("tab.new", { folder: w.path }); this.closeDialog(); }, { disabled: w.bare || w.prunable || Boolean(this.on) })));
  }

  newBranchCard(t) {
    const d = this.data;
    const from = this.newFrom === "selected" && this.selRef() ? this.selRef() : d.status.head ?? "HEAD";
    const problem = this.branchText ? branchNameProblem(this.branchText.trim()) : null;
    const nb = this.shownBlockers("newBranch", null);
    return this.card(t, "New branch", v_flex().gap(6)
      .child(div().w_full().min_w(120).child(Input.new(this.branchInput).h(28).w_full().px(10).items_center().rounded(6).border(1).border_color(problem ? t.blocked : t.input).bg(t.background).text_color(t.foreground)))
      .child(h_flex().gap(6).items_center().flex_wrap()
        .child(this.segment(t, [["current", "from current"], ["selected", "from selected"]], this.selRef() ? this.newFrom : "current", (k, cx) => { this.newFrom = k; cx.notify(); }))
        .child(this.button("act-new", "Create & switch", t, (cx) => this.newBranch(cx), { primary: true, disabled: Boolean(this.busy) || !this.branchText.trim() || Boolean(problem) || blocking(nb).length > 0, tooltip: this.why(nb) })))
      .child(div().text_size(TYPE.xs).text_color(problem ? t.blocked : metaColor(t, t.surface)).child(problem ?? `Starts at ${from}.`))
      .children(this.blockerLines(t, nb, false)));
  }

  conflictCard(t) {
    const d = this.data;
    const st = d.status;
    const agent = this.askTarget();
    const askArmed = this.confirm?.kind === "ask";
    const abortArmed = this.armed("abort", "merge");
    return v_flex().id("git-conflict").gap(8).p(12).rounded(8).border_1().border_color(t.blocked).bg(t.surface)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(TYPE.md).font_semibold().text_color(t.blocked).child(d.op ? `${d.op} in progress` : "Conflicts"))
        .child(div().text_color(metaColor(t, t.surface)).child(st.conflicted.length ? plural(st.conflicted.length, "conflicted file") : "no conflicted files left: commit to finish")))
      .child(v_flex().gap(1)
        .children(st.conflicted.slice(0, 60).map((f) => this.fileRow(t, f, "UU", true)))
        .when(st.conflicted.length > 60, (el) => el.child(div().text_color(metaColor(t, t.surface)).child(`+${st.conflicted.length - 60} more`))))
      .child(h_flex().gap(6).flex_wrap()
        .when(d.op === "merge", (el) => el.child(this.button("act-abort", abortArmed ? "Confirm abort merge" : "Abort merge", t, (cx) => this.abortMerge(cx), { danger: abortArmed, disabled: Boolean(this.busy) })))
        .when(st.conflicted.length > 0, (el) => el
          .child(this.button("act-ask", askArmed ? `Send to ${this.confirm.agent}` : "Ask agent", t, (cx) => this.ask(cx), { danger: askArmed, disabled: !agent || Boolean(this.busy) }))
          .child(this.button("act-copy", "Copy prompt", t, (cx) => this.copyPrompt(cx)))))
      .when(abortArmed, (el) => el.child(div().text_size(TYPE.xs).text_color(t.blocked).child("Click again within 6 s: git merge --abort drops the merge's changes in progress.")))
      .when(d.op && d.op !== "merge", (el) => el.child(div().text_size(TYPE.xs).text_color(metaColor(t, t.surface)).child(`Finish or abort the ${d.op} in a terminal (git ${d.op} --continue / --abort).`)))
      .when(!agent && st.conflicted.length > 0, (el) => el.child(div().text_size(TYPE.xs).text_color(metaColor(t, t.surface)).child("Ask agent: focus an agent first (or have exactly one in this repo).")))
      .when(askArmed, (el) => el.child(v_flex().gap(6).p(10).rounded(6).bg(t.background).border_1().border_color(t.border)
        .child(h_flex().gap(8).items_center().text_size(TYPE.xs)
          .child(div().flex_1().min_w(0).text_color(metaColor(t, t.background)).child(`To ${this.confirm.agent}, then Enter:`))
          .child(this.button("act-ask-cancel", "Cancel", t, (cx) => { this.confirm = null; cx.notify(); })))
        .child(v_flex().id("git-ask-preview").max_h(160).overflow_y_scrollbar().gap(2).text_size(TYPE.xs)
          .children(this.confirm.text.split("\n").map((line) => mono(div().whitespace_normal().child(line || " ")))))));
  }

  fileRow(t, path, xy, conflict) {
    const name = path.split("/").pop();
    const denied = isDenied(path);
    return h_flex().id(`file-${conflict ? "c" : "w"}-${idPart(path)}`).h(24).px(6).gap(8).items_center().rounded(4)
      .child(image(resolveIcon(MOD, false, name)).size(14).flex_none())
      .child(mono(div().w(22).flex_none().text_color(conflict ? t.blocked : t.ansi3).tooltip(markWord(xy, conflict)).accessibility_label(markWord(xy, conflict)).child(xy.replace(/\./g, " "))))
      .child(mono(div().flex_1().min_w(0).truncate().child(clean(path, 300))))
      .child(this.button(`open-${conflict ? "c" : "w"}-${idPart(path)}`, "Open", t, (cx) => this.openFile(cx, path), { disabled: denied }));
  }

  prList(t) {
    const f = this.forge;
    const p = this.prs;
    const urls = webUrls(f, {});
    const head = this.data.status.head;
    if (!f?.kind) {
      return emptyState({ id: "prs-none", title: "No supported remote", body: f?.web
        ? `${showUrl(f.web)} is not a known forge. Add it under forgeHosts in data/${MOD}/settings.json.`
        : "This repository has no GitHub, GitLab or Bitbucket remote." }, t);
    }
    const method = github.mergeMethod(this.ghSettings);
    const noun = f.kind === "gitlab" ? "merge requests" : "pull requests";
    return v_flex().gap(8)
      .child(h_flex().gap(8).items_center()
        .child(h_flex().min_w(0).gap(6).items_center()
          .child(div().flex_none().text_size(TYPE.md).font_semibold().child(`Open ${noun}`))
          .child(mono(div().min_w(0).truncate().text_size(TYPE.xs).text_color(metaColor(t)).child(`${f.owner}/${f.name}`))))
        .child(div().flex_1())
        .when(Boolean(p?.busy), (el) => el.child(div().text_size(TYPE.xs).text_color(metaColor(t)).accessibility_label("Loading")
          .frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
        .child(this.button("prs-web", "All in browser ↗", t, (cx) => this.openUrl(cx, urls.prs), { disabled: !urls.prs }))
        .child(iconButton({ id: "prs-refresh", icon: UI("refresh"), label: "Refresh", disabled: Boolean(p?.busy),
          onClick: (cx) => { cx.spawn(async (cx) => { await this.loadPRs(); cx.notify(); }); } }, t)))
      .when(Boolean(this.settings.problem), (el) => el.child(div().text_color(t.blocked).child(this.settings.problem)))
      .when(Boolean(p?.error), (el) => el.child(div().text_color(p.browser ? metaColor(t) : t.blocked).child(p.error)))
      .when(!p, (el) => el.child(div().text_color(metaColor(t)).child(`Reading ${noun}…`)))
      .when(Boolean(p && !p.busy && !p.error && p.rows.length === 0), (el) => el.child(emptyState({ id: "prs-empty", title: `No open ${noun}` }, t)))
      .children((p?.rows ?? []).map((pr, i) => {
        const key = String(pr.number ?? "");
        const armed = this.armed("auto", key);
        const mine = pr.source === head;
        return v_flex().id(`pr-${i}`).flex_none().p(8).gap(4).rounded(6).border_1().border_color(mine ? t.accent : t.border)
          .child(h_flex().gap(8).items_center().min_w(0)
            .child(mono(div().flex_none().text_color(metaColor(t)).child(pr.id)))
            .child(div().flex_1().min_w(0).truncate().font_medium().child(pr.title))
            .when(pr.draft, (el) => el.child(this.tag(t, "draft", t.dim)))
            .when(Boolean(pr.checks), (el) => el.child(this.tag(t, pr.checks, pr.checks === "failing" ? t.ansi1 : pr.checks === "pending" ? t.ansi3 : t.ansi2))))
          .child(h_flex().gap(8).items_center().min_w(0).text_size(TYPE.xs).text_color(metaColor(t))
            .child(mono(div().min_w(0).truncate().child(`${pr.source} → ${pr.target}`)))
            .child(div().flex_none().child(pr.author ? `by ${pr.author}` : ""))
            .child(div().flex_1())
            .child(this.button(`pr-open-${i}`, "Open ↗", t, (cx) => this.openUrl(cx, pr.url), { disabled: !pr.url }))
            .when(f.kind === "github" && pr.number != null, (el) => el.child(this.button(`pr-auto-${i}`, armed ? `Confirm auto-merge (${method})` : "Auto-merge", t,
              (cx) => this.autoMerge(cx, pr), { danger: armed, disabled: Boolean(this.busy) || !method || pr.draft }))))
          .when(armed, (el) => el.child(mono(div().text_size(TYPE.xs).text_color(t.blocked).child(`Click again within 6 s: gh pr merge --auto --${method}. GitHub merges when checks and reviews pass.`))));
      }))
      .when(f.kind === "github" && !method && Boolean(p) && !p.busy, (el) => el.child(div().text_size(TYPE.xs).text_color(metaColor(t)).child("Auto-merge needs the repository's merge settings (gh could not read them).")));
  }

  // --- pieces ---

  blockerLines(t, list, armed) {
    return list.map((b, i) => div().id(`blk-${b.code}-${i}`).text_size(TYPE.xs)
      .text_color(b.level === "block" ? t.blocked : armed ? t.ansi3 : metaColor(t, t.surface))
      .child(`${b.level === "block" ? "✕" : "⚠"} ${b.text}${b.level === "warn" && armed ? " (click again within 6 s)" : ""}`));
  }

  card(t, title, body) {
    return v_flex().gap(8).p(12).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(div().text_size(TYPE.xs).font_semibold().text_color(metaColor(t, t.surface)).child(title))
      .child(body);
  }

  /** Why a blocked action is disabled: its blockers as one tooltip line (undefined when nothing blocks). */
  why(list) {
    const stop = blocking(list);
    return stop.length ? stop.map((b) => b.text).join(" · ") : undefined;
  }

  segment(t, items, value, onPick) {
    return h_flex().flex_none().h(24).p(2).gap(2).rounded(6).border_1().border_color(t.border).bg(t.background)
      .children(items.map(([key, label]) => {
        const on = value === key;
        return div().id(`seg-${key}`).px(8).h_full().flex().items_center().rounded(4).text_size(TYPE.xs).cursor_pointer()
          .text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected))
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); onPick(key, cx); })
          .child(label);
      }));
  }

  field(t, label, value, color, data = false) {
    const text = String(value ?? "");
    const v = div().flex_1().min_w(0).truncate().text_color(color ?? t.foreground).tooltip(text).child(text);
    return h_flex().gap(8).items_start()
      .child(div().w(72).flex_none().truncate().text_color(metaColor(t, t.background)).child(label))
      .child(data ? mono(v) : v);
  }

  // A small pill. t.dim / t.muted colors become the readable meta color (t.dim fails contrast).
  tag(t, text, color, { data = false } = {}) {
    const c = color === t.dim || color === t.muted ? metaColor(t, t.raised) : color;
    return chip(text, t, { color: c, data }).border_1().border_color(t.border);
  }

  // The shared button: secondary by default, `primary` for the view's one main action, `danger` only for
  // an armed destructive second click. Handlers take cx only.
  button(id, label, t, onClick, opts = {}) {
    const kind = opts.danger ? "danger" : opts.primary ? "primary" : "secondary";
    return uiButton({ id, label, onClick, kind, disabled: Boolean(opts.disabled), tooltip: opts.tooltip }, t);
  }

  footer(t) {
    const m = this.message;
    const shown = m ? { text: firstLine(m.text), bad: m.bad } : this.busy ? { text: String(this.busy), bad: false, working: true } : null;
    return h_flex().id("git-footer").flex_none().h(30).px(12).gap(8).items_center().border_t_1().border_color(t.border).text_size(TYPE.xs)
      .child(shown
        ? div().id("git-status-line").flex_1().min_w(0).truncate().role("status").text_color(shown.bad ? t.blocked : shown.working ? metaColor(t) : t.ansi2).child(shown.text)
        : mono(div().flex_1().min_w(0).truncate().text_color(metaColor(t)).child(this.repo ? tilde(this.repo.top, this.userHome) : "")))
      .when(Boolean(m?.copy), (el) => el.child(this.button("git-status-copy", "Copy path", t, (cx) => {
        cx.write_to_clipboard(m.copy);
        this.message = { text: "Path copied", bad: false };
        cx.notify();
      })))
      .when(Boolean(m), (el) => el.child(iconButton({ id: "git-status-dismiss", icon: UI("close"), label: "Dismiss message",
        onClick: (cx) => { this.message = null; cx.notify(); } }, t)))
      .when(Boolean(this.data), (el) => el.child(div().flex_none().text_color(metaColor(t)).child(`read ${ago(Date.now() - this.data.readAt)} ago`.replace("now ago", "just now"))));
  }
}
