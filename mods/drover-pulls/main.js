// Pull requests: the open PRs of the open spaces' GitHub repositories, mine and those waiting
// on my review, with stacks, CI and review state, and click-only actions. A full-page view;
// place "none" (a layout block or the dialog overlay puts it on screen).
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, hc, spaces, panes, agents, theme, run, layout, props, closeOverlay, window } from "herdr";
import { TYPE, mono, metaColor, panelHeader, emptyState, button } from "./lib/panel-ui.js";
import {
  POLL_MS, reposFromRemotes, spaceFolder, summarizeRollup, rollupLabel, reviewLabel, filterPrs,
  buildStack, placesOnBranch, soleAgent, ciFixText, unresolvedComments, reviewText, mergeMethod,
  autoMergeBlock, autoMergeArgs, freshAutoMergeBlock, viewArgs, sendArgs, listArgs, requestedArgs, repoArgs, threadsArgs, safeUrl,
  openUrlArgv, openUrlProblem, ghProblem, ago, visibleIn,
} from "./logic.js";

const MOD = "drover-pulls";
const TICK_MS = 5000; // only checks what is due; GitHub is asked at most once a minute per repo
const CONFIRM_MS = 5000;
const GH_TIMEOUT = 20000;
const FILTERS = [["mine", "Mine"], ["review", "Review requested"], ["all", "All open"]];
const REFRESH_ICON = `mods/${MOD}/ui/refresh.svg`;
const prKey = (repo, n) => `${repo}#${n}`;
const idPart = (s) => String(s).replace(/[^\w-]/g, "_");

function loadFilter() {
  try {
    const v = localStorage.getItem("filter");
    return FILTERS.some(([k]) => k === v) ? v : "mine";
  } catch {
    return "mine";
  }
}

const agentName = (a) => {
  const title = String(a.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return a.program?.name || title || a.address;
};

export default class Pulls extends View {
  init(_props, cx) {
    this.filter = loadFilter();
    this.gh = null; // null: unknown, "ok", or a one-line problem
    this.ghMissing = false; // the gh program itself is not installed
    this.handle = cx.focus_handle();
    this.cursor = null; // prKey under the keyboard cursor
    this.order = []; // visible prKeys in list order, set by render
    this.viewer = null;
    this.spaceRepos = new Map(); // space id -> [owner/repo]
    this.spaceNoRepo = 0; // open spaces without a GitHub remote
    this.discoverSig = "";
    this.discoverAt = 0;
    this.remotes = new Map(); // JSON [machine, folder] -> { at, repos }
    this.repos = new Map(); // owner/repo -> { prs, requested, info, at, error, busy }
    this.cache = new Map(); // JSON gh args -> { at, data }
    this.threads = new Map(); // prKey -> { at, comments, error, busy }
    this.selected = null; // prKey
    this.confirm = null; // { kind: "merge" | "ci" | "review", key, until?, text?, address?, method? }
    this.busyAction = null;
    this.message = null; // { key, text, bad }
    this.tick(cx, false);
    cx.timer.every(TICK_MS, (cx) => this.tick(cx, false));
  }

  // Due work only: discovery when spaces' folders changed or a minute passed, then due repos.
  tick(cx, force) {
    // An overlay copy is on screen while open; a layout copy only when its block is shown.
    if (!force && !props()?.overlay && !visibleIn(layout(), MOD)) return;
    if (this.discovering) return;
    const places = this.places();
    const sig = JSON.stringify(places.map((p) => [p.id, p.machine, p.folder]));
    const now = Date.now();
    if (!force && sig === this.discoverSig && now - this.discoverAt < POLL_MS) {
      this.pollRepos(cx, false);
      return;
    }
    this.discovering = true;
    cx.spawn(async (cx) => {
      try {
        await this.discover(places, force);
        this.discoverSig = sig;
        this.discoverAt = Date.now();
        if (this.gh !== "ok" || !this.viewer) await this.checkGh();
      } finally {
        this.discovering = false;
      }
      cx.notify();
      this.pollRepos(cx, force);
    });
  }

  places() {
    const paneList = panes();
    return spaces().map((s) => ({ id: s.id, machine: s.machine ?? null, folder: spaceFolder(s, paneList) }));
  }

  async discover(places, force) {
    const now = Date.now();
    const next = new Map();
    let none = 0;
    for (const p of places) {
      if (!p.folder) { none++; continue; }
      const key = JSON.stringify([p.machine, p.folder]);
      let hit = this.remotes.get(key);
      if (force || !hit || now - hit.at >= POLL_MS) {
        let repos = [];
        try {
          const r = await exec("git", ["--no-optional-locks", "remote", "-v"], { cwd: p.folder, on: p.machine, timeout: 8000 });
          repos = r.code === 0 ? reposFromRemotes(r.stdout) : [];
        } catch {
          repos = []; // folder gone or machine unreachable: no repository for now
        }
        hit = { at: Date.now(), repos };
        this.remotes.set(key, hit);
      }
      if (hit.repos.length) next.set(p.id, hit.repos);
      else none++;
    }
    const live = new Set(places.map((p) => JSON.stringify([p.machine, p.folder])));
    for (const k of this.remotes.keys()) if (!live.has(k)) this.remotes.delete(k);
    this.spaceRepos = next;
    this.spaceNoRepo = none;
    const open = this.openRepos();
    for (const repo of this.repos.keys()) if (!open.has(repo)) this.repos.delete(repo);
    for (const k of this.threads.keys()) if (!open.has(k.split("#")[0])) this.threads.delete(k);
    if (this.selected && !open.has(this.selected.split("#")[0])) this.selected = null;
  }

  openRepos() {
    return new Set([...this.spaceRepos.values()].flat());
  }

  async checkGh() {
    try {
      const r = await exec("gh", ["api", "user", "--jq", ".login"], { timeout: GH_TIMEOUT });
      this.ghMissing = false;
      if (r.code === 0 && r.stdout.trim()) {
        this.gh = "ok";
        this.viewer = r.stdout.trim();
      } else {
        this.gh = ghProblem(r.stderr);
      }
    } catch {
      this.ghMissing = true;
      this.gh = "gh is not installed.";
    }
  }

  async query(args, force = false) {
    const key = JSON.stringify(args);
    const hit = this.cache.get(key);
    if (!force && hit && Date.now() - hit.at < POLL_MS) return hit.data;
    const r = await exec("gh", args, { timeout: GH_TIMEOUT });
    if (r.code !== 0) throw new Error(ghProblem(r.stderr));
    const data = JSON.parse(r.stdout || "null");
    this.cache.set(key, { at: Date.now(), data });
    for (const [k, v] of this.cache) if (Date.now() - v.at >= POLL_MS) this.cache.delete(k);
    return data;
  }

  pollRepos(cx, force) {
    if (this.gh !== "ok") return;
    const now = Date.now();
    for (const repo of this.openRepos()) {
      const cur = this.repos.get(repo) ?? { prs: null, requested: new Set(), info: null, at: 0, error: null, busy: false };
      this.repos.set(repo, cur);
      if (cur.busy || (!force && now - cur.at < POLL_MS)) continue;
      cur.busy = true;
      cur.at = now;
      cx.spawn(async (cx) => {
        let prs = null, requested = null, info = null, error = null;
        try {
          [prs, requested, info] = await Promise.all([
            this.query(listArgs(repo), force),
            this.query(requestedArgs(repo), force),
            this.query(repoArgs(repo), force).catch(() => null),
          ]);
        } catch (e) {
          error = String(e?.message ?? e);
        }
        cur.busy = false;
        // A late answer for a repository no longer open is dropped.
        if (this.repos.get(repo) !== cur || !this.openRepos().has(repo)) return;
        if (error) cur.error = error;
        else {
          cur.error = null;
          cur.prs = Array.isArray(prs) ? prs : [];
          cur.requested = new Set((requested ?? []).map((p) => p.number));
          cur.info = info?.data?.repository ?? cur.info;
        }
        if (force && this.selected?.startsWith(`${repo}#`)) this.loadThreads(this.selected, cx, true);
        cx.notify();
      });
    }
  }

  loadThreads(key, cx, force = false) {
    const [repo, n] = [key.slice(0, key.lastIndexOf("#")), Number(key.slice(key.lastIndexOf("#") + 1))];
    const cur = this.threads.get(key);
    if (cur?.busy || (!force && cur && Date.now() - cur.at < POLL_MS)) return;
    const entry = { at: Date.now(), comments: cur?.comments ?? null, error: null, busy: true };
    this.threads.set(key, entry);
    cx.spawn(async (cx) => {
      try {
        const data = await this.query(threadsArgs(repo, n), force);
        entry.comments = unresolvedComments(data?.data?.repository?.pullRequest?.reviewThreads?.nodes);
      } catch (e) {
        entry.error = String(e?.message ?? e);
      }
      entry.busy = false;
      if (this.threads.get(key) !== entry || !this.openRepos().has(repo)) return;
      cx.notify();
    });
  }

  setFilter(key, cx) {
    this.filter = key;
    try { localStorage.setItem("filter", key); } catch { /* storage unavailable: keep it for this copy */ }
    cx.notify();
  }

  // Keyboard: Up/Down move the cursor over the PR rows, Enter opens or closes its detail, Esc closes the detail.
  key(e, cx) {
    const k = e.key;
    if (k === "down" || k === "up") {
      if (this.order.length === 0) return;
      const i = this.order.indexOf(this.cursor);
      const n = i < 0 ? (k === "down" ? 0 : this.order.length - 1) : Math.max(0, Math.min(this.order.length - 1, i + (k === "down" ? 1 : -1)));
      this.cursor = this.order[n];
    } else if (k === "enter") {
      if (!this.cursor || !this.order.includes(this.cursor)) return;
      this.select(this.cursor, cx);
    } else if (k === "escape") {
      if (!this.selected) return;
      this.selected = null;
      this.confirm = null;
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  select(key, cx) {
    this.cursor = key;
    this.selected = this.selected === key ? null : key;
    this.confirm = null;
    this.message = null;
    if (this.selected) this.loadThreads(this.selected, cx);
    cx.notify();
  }

  // --- actions (explicit clicks only) ---

  openUrl(key, pr, cx) {
    const url = safeUrl(pr.url);
    if (!url) return;
    const platform = window()?.platform ?? "macos";
    const [cmd, args] = openUrlArgv(platform, url);
    cx.spawn(async (cx) => {
      let r = null, err = null;
      try { r = await exec(cmd, args); } catch (e) { err = e; }
      const text = openUrlProblem(platform, r, err);
      if (!text) return;
      this.message = { key, text, bad: true };
      cx.notify();
    });
  }

  goToSpace(place) {
    run("space.select", { id: place.space.id });
    if (place.tab) run("tab.select", { id: place.tab });
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
  }

  armTimeout(cx, kind, key) {
    cx.timer.after(CONFIRM_MS, (cx) => {
      if (this.confirm?.kind === kind && this.confirm.key === key && this.confirm.until <= Date.now()) {
        this.confirm = null;
        cx.notify();
      }
    });
  }

  autoMerge(repo, pr, method, cx) {
    const key = prKey(repo, pr.number);
    if (this.busyAction === key) return;
    if (this.confirm?.kind !== "merge" || this.confirm.key !== key || this.confirm.until < Date.now()) {
      this.confirm = { kind: "merge", key, until: Date.now() + CONFIRM_MS, method };
      this.armTimeout(cx, "merge", key);
      cx.notify();
      return;
    }
    const args = autoMergeArgs(repo, pr.number, this.confirm.method);
    const viewCmd = viewArgs(repo, pr.number);
    this.confirm = null;
    this.busyAction = key;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        // The listed state can be a minute old: look again right before merging.
        const v = await exec("gh", viewCmd, { timeout: GH_TIMEOUT });
        const refuse = v.code === 0 ? freshAutoMergeBlock(v.stdout) : "Could not check the pull request's current state; nothing was merged";
        if (refuse) {
          this.message = { key, text: refuse, bad: true };
          this.busyAction = null;
          this.pollRepos(cx, true);
          cx.notify();
          return;
        }
        const r = await exec("gh", args, { timeout: 30000 });
        this.message = r.code === 0
          ? { key, text: `Auto-merge (${method}) enabled.`, bad: false }
          : { key, text: (r.stderr || r.stdout || "gh pr merge failed").trim().split("\n")[0], bad: true };
      } catch (e) {
        this.message = { key, text: String(e?.message ?? e), bad: true };
      }
      this.busyAction = null;
      this.pollRepos(cx, true);
      cx.notify();
    });
  }

  // First click: preview the exact text and target. Second click on the same button: send it.
  toAgent(kind, key, agent, text, cx) {
    const c = this.confirm;
    if (c?.kind !== kind || c.key !== key || c.address !== agent.address) {
      this.confirm = { kind, key, address: agent.address, text, agent: agentName(agent) };
      this.message = null;
      cx.notify();
      return;
    }
    const sent = c.text;
    this.confirm = null;
    this.busyAction = key;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await hc(sendArgs(c.address, sent));
        this.message = r.code === 0
          ? { key, text: `Sent to ${c.agent} (${c.address}).`, bad: false }
          : { key, text: (r.stderr || r.stdout || "hc send failed").trim().split("\n")[0], bad: true };
      } catch (e) {
        this.message = { key, text: String(e?.message ?? e), bad: true };
      }
      this.busyAction = null;
      cx.notify();
    });
  }

  // --- view ---

  render() {
    const t = theme();
    const now = Date.now();
    const spaceList = spaces();
    const paneList = panes();
    const agentList = agents();
    const repos = [...this.openRepos()].sort();
    const sections = repos.map((repo) => {
      const r = this.repos.get(repo);
      const prs = r?.prs ? filterPrs(r.prs, this.filter, this.viewer, r.requested) : [];
      return { repo, r, rows: buildStack(prs) };
    });
    const total = sections.reduce((n, s) => n + s.rows.length, 0);
    this.order = sections.flatMap((s) => s.rows.map((row) => prKey(s.repo, row.pr.number)));
    let sel = null;
    if (this.selected) {
      const repo = this.selected.slice(0, this.selected.lastIndexOf("#"));
      const n = Number(this.selected.slice(this.selected.lastIndexOf("#") + 1));
      const r = this.repos.get(repo);
      const pr = r?.prs?.find((p) => p.number === n);
      if (pr) sel = { repo, pr, info: r.info, key: this.selected, places: placesOnBranch(repo, pr.headRefName, spaceList, paneList, agentList, this.spaceRepos) };
    }
    const placesFor = (repo, pr) => placesOnBranch(repo, pr.headRefName, spaceList, paneList, agentList, this.spaceRepos);
    const state = this.state(t, repos.length);
    const busy = Boolean(this.discovering) || [...this.repos.values()].some((r) => r.busy);

    return v_flex().id("pulls-root").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(TYPE.sm)
      .child(panelHeader({
        id: "pulls-header", title: "Pull requests", busy,
        meta: this.gh === "ok" && this.repos.size && total > 0 ? total : undefined,
        actions: [{ id: "pulls-refresh", icon: REFRESH_ICON, label: "Refresh", onClick: (cx) => this.tick(cx, true) }],
      }, t))
      .when(!state, (el) => el.child(this.filters(t)))
      .child(h_flex().flex_1().min_h(0).items_start().gap(12).px(12).pt(8).pb(12)
        .child(v_flex().id("pulls-list").flex_1().min_w(0).h_full().overflow_y_scrollbar().gap(12)
          .when(this.discoverAt === 0, (el) => el.child(div().py(8).text_color(metaColor(t)).child("Reading the open spaces…")))
          .when(Boolean(state), (el) => el.child(state))
          .when(!state, (el) => el.children(sections.map((s) => this.section(t, s, now, spaceList, placesFor)))))
        .when(Boolean(sel) && !state, (el) => el.child(this.detail(t, sel))));
  }

  // The whole-body empty or error state, or null when the list can show.
  state(t, repoCount) {
    if (this.discoverAt === 0) return null;
    if (this.ghMissing) return emptyState({ id: "pulls-state", title: "gh isn't installed", body: "Install gh to see pull requests here." }, t);
    if (this.gh && this.gh !== "ok") return emptyState({ id: "pulls-state", tone: "error", title: "Could not reach GitHub", body: this.gh }, t);
    if (repoCount === 0) return emptyState({ id: "pulls-state", title: "No GitHub repositories", body: "None of the open spaces is in a repository hosted on GitHub." }, t);
    return null;
  }

  filters(t) {
    return h_flex().id("pulls-filters").flex_none().flex_wrap().px(12).pt(8).items_center()
      .child(h_flex().flex_none().h(24).p(2).gap(2).rounded(6).border_1().border_color(t.border).bg(t.surface).role("toolbar").accessibility_label("Filter pull requests")
        .children(FILTERS.map(([key, label]) => {
          const on = this.filter === key;
          return div().id(`filter-${key}`).px(10).h_full().flex().items_center().rounded(4).text_size(TYPE.sm).cursor_pointer()
            .role("button").accessibility_label(label).tab_index(0)
            .text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected))
            .hover((s) => s.text_color(t.foreground)).focus((s) => s.border_1().border_color(t.accent))
            .on_key_down((e, cx) => { if (e.key === "enter" || e.key === "space") { cx.stop_propagation(); this.setFilter(key, cx); } })
            .on_click((_e, cx) => this.setFilter(key, cx))
            .child(label);
        })));
  }

  section(t, s, now, spaceList, placesFor) {
    const { repo, r, rows } = s;
    const meta = metaColor(t);
    const where = spaceList.filter((sp) => (this.spaceRepos.get(sp.id) ?? []).includes(repo)).map((sp) => sp.name);
    const empty = { mine: "No open pull requests of yours.", review: "Nothing waiting on your review.", all: "No open pull requests." }[this.filter];
    return v_flex().flex_none().gap(4)
      .child(h_flex().h(26).gap(8).items_center()
        .child(mono(div().text_size(TYPE.md).font_semibold().child(repo)))
        .child(div().min_w(0).truncate().text_size(TYPE.xs).text_color(meta).child(where.join(", ")))
        .child(div().flex_1()))
      .when(Boolean(r?.error), (el) => el.child(div().py(8).text_size(TYPE.xs).text_color(t.blocked).child(`Could not load pull requests: ${r.error}`)))
      .when(!r?.prs && !r?.error, (el) => el.child(div().py(8).text_color(meta).child("Reading pull requests…")))
      .when(Boolean(r?.prs) && rows.length === 0, (el) => el.child(div().py(8).text_color(meta).child(empty)))
      .children(rows.map((row) => this.row(t, repo, row, now, placesFor(repo, row.pr))));
  }

  ciColor(t, state) {
    return state === "failing" ? t.ansi1 : state === "pending" ? t.ansi3 : state === "passing" ? t.ansi2 : metaColor(t);
  }

  row(t, repo, { pr, prefix }, now, places) {
    const key = prKey(repo, pr.number);
    const on = this.selected === key;
    const cur = this.cursor === key;
    const ci = summarizeRollup(pr.statusCheckRollup);
    const review = reviewLabel(pr.reviewDecision);
    const updated = Date.parse(pr.updatedAt ?? "");
    return h_flex().id(`pr-${idPart(key)}`).flex_none().px(8).py(6).gap(8).items_center().rounded(6)
      .border_1().border_color(on ? t.border : t.background).when(cur && !on, (el) => el.bg(t.hover)).when(on, (el) => el.bg(t.selected))
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.handle.focus(); this.select(key, cx); })
      .when(prefix.length > 0, (el) => el.child(mono(div().flex_none().text_color(t.dim).child(prefix))))
      .child(v_flex().flex_1().min_w(0).gap(4)
        .child(h_flex().gap(8).items_center().min_w(0)
          .child(mono(div().flex_none().text_color(metaColor(t)).child(`#${pr.number}`)))
          .child(div().min_w(0).truncate().child(pr.title ?? ""))
          .when(Boolean(pr.isDraft), (el) => el.child(this.tag(t, "draft", metaColor(t, t.raised))))
          .when(places.length > 0, (el) => el.child(this.tag(t, places.map((p) => p.space.name).join(", "), t.accent))))
        .child(h_flex().gap(10).items_center().min_w(0).text_size(TYPE.xs).text_color(metaColor(t))
          .child(mono(div().min_w(0).truncate().child(pr.headRefName ?? "")))
          .when(Boolean(review), (el) => el.child(div().flex_none()
            .text_color(pr.reviewDecision === "APPROVED" ? t.ansi2 : pr.reviewDecision === "CHANGES_REQUESTED" ? t.ansi1 : metaColor(t))
            .child(review)))))
      .child(div().w(150).flex_none().text_right().text_size(TYPE.xs).text_color(this.ciColor(t, ci.state)).child(rollupLabel(ci)))
      .child(mono(div().w(34).flex_none().text_right().text_size(TYPE.xs).text_color(metaColor(t)).child(Number.isFinite(updated) ? ago(now - updated) : "")));
  }

  tag(t, text, color) {
    return div().flex_none().max_w(200).truncate().px(6).py(2).rounded(4).bg(t.raised).border_1().border_color(t.border).text_size(TYPE.xs).text_color(color).child(text);
  }

  // Resting buttons are secondary; the armed second step of a two-click action is "danger".
  button(id, label, t, onClick, opts = {}) {
    return button({ id, label, onClick, kind: opts.danger ? "danger" : "secondary", disabled: Boolean(opts.disabled), tooltip: opts.tooltip }, t);
  }

  field(t, label, value, color) {
    return h_flex().gap(8).items_start().text_size(TYPE.sm)
      .child(div().w(92).flex_none().text_color(metaColor(t, t.surface)).child(label))
      .child(div().flex_1().min_w(0).text_color(color ?? t.foreground).child(value));
  }

  detail(t, sel) {
    const { repo, pr, info, key, places } = sel;
    const meta = metaColor(t, t.surface);
    const ci = summarizeRollup(pr.statusCheckRollup);
    const th = this.threads.get(key);
    const comments = th?.comments ?? null;
    const agent = soleAgent(places);
    const agentCount = places.reduce((n, p) => n + p.agents.length, 0);
    const busy = this.busyAction === key;
    const c = this.confirm?.key === key ? this.confirm : null;
    const method = mergeMethod(info);
    const block = autoMergeBlock(pr, info);
    const merging = c?.kind === "merge" && c.until > Date.now();
    const mergeable = [pr.mergeable, pr.mergeStateStatus].filter(Boolean).map((s) => s.toLowerCase().replace(/_/g, " ")).join(" · ");
    const autoOn = pr.autoMergeRequest ? `on (${String(pr.autoMergeRequest.mergeMethod ?? "").toLowerCase() || "set"})` : "off";
    const threadsText = th?.error ? th.error : comments == null ? "reading…" : String(comments.length);
    const noAgent = agentCount === 0 ? "No agent in a space on this branch" : agentCount > 1 ? "More than one agent on this branch" : null;
    const ciText = agent && ci.failed.length ? ciFixText(repo, pr, ci.failed) : null;
    const revText = agent && comments?.length ? reviewText(repo, pr, comments) : null;
    const ciWhy = ciText || busy ? undefined : noAgent ?? (ci.failed.length ? undefined : "No failing checks");
    const revWhy = revText || busy ? undefined : noAgent ?? (comments?.length ? undefined : "No unresolved review comments");

    return v_flex().id("pulls-detail").w(340).flex_none().h_full().overflow_y_scrollbar().p(12).gap(10).rounded(6)
      .bg(t.surface).border_1().border_color(t.border)
      .child(div().font_semibold().text_size(TYPE.md).child(`#${pr.number} ${pr.title ?? ""}`))
      .child(mono(div().text_size(TYPE.xs).text_color(meta).child(`${repo} · ${pr.baseRefName} ← ${pr.headRefName}`)))
      .child(v_flex().gap(6)
        .child(this.field(t, "Checks", rollupLabel(ci), this.ciColor(t, ci.state)))
        .children(ci.failed.slice(0, 12).map((name) => this.field(t, "", `✗ ${name}`, t.ansi1)))
        .when(ci.failed.length > 12, (el) => el.child(this.field(t, "", `+${ci.failed.length - 12} more`, meta)))
        .child(this.field(t, "Review", reviewLabel(pr.reviewDecision) || "none", t.muted))
        .child(this.field(t, "Unresolved", threadsText, comments?.length ? t.ansi3 : t.muted))
        .child(this.field(t, "Mergeable", mergeable || "unknown", t.muted))
        .child(this.field(t, "Auto-merge", autoOn, pr.autoMergeRequest ? t.ansi2 : t.muted))
        .child(this.field(t, "Draft", pr.isDraft ? "yes" : "no", t.muted))
        .child(this.field(t, "On branch",
          places.length
            ? places.map((p) => `${p.space.name}${p.agents.length ? ` · ${p.agents.map((a) => `${agentName(a)} (${a.status})`).join(", ")}` : " · no agent"}`).join("; ")
            : "not checked out in an open space",
          places.length ? t.accent : meta)))
      .child(h_flex().flex_wrap().gap(6).pt(4)
        .child(this.button("act-open", "Open", t, (cx) => this.openUrl(key, pr, cx), { disabled: !safeUrl(pr.url), tooltip: safeUrl(pr.url) ? undefined : "No usable link for this pull request" }))
        .child(this.button("act-go", "Go to space", t, () => this.goToSpace(places[0]), { disabled: places.length === 0, tooltip: places.length === 0 ? "Not checked out in an open space" : undefined })))
      .child(v_flex().gap(4)
        .child(this.button("act-merge", busy && !c ? "Working…" : merging ? `Confirm auto-merge (${c.method})` : "Enable auto-merge", t,
          (cx) => this.autoMerge(repo, pr, method, cx), { danger: merging, disabled: Boolean(block) || busy, tooltip: block || undefined }))
        .when(Boolean(block), (el) => el.child(div().text_size(TYPE.xs).text_color(meta).child(block))))
      .child(v_flex().gap(4)
        .child(h_flex().flex_wrap().gap(6)
          .child(this.button("act-ci", c?.kind === "ci" ? "Send to agent" : "Ask agent to fix CI", t,
            (cx) => this.toAgent("ci", key, agent, ciText, cx), { danger: c?.kind === "ci", disabled: !ciText || busy, tooltip: ciWhy }))
          .child(this.button("act-review", c?.kind === "review" ? "Send to agent" : "Send review comments to agent", t,
            (cx) => this.toAgent("review", key, agent, revText, cx), { danger: c?.kind === "review", disabled: !revText || busy, tooltip: revWhy })))
        .when(Boolean(noAgent), (el) => el.child(div().text_size(TYPE.xs).text_color(meta).child(noAgent))))
      .when(c?.kind === "ci" || c?.kind === "review", (el) => el.child(this.preview(t, c)))
      .when(this.message?.key === key, (el) => el.child(div().text_size(TYPE.xs).text_color(this.message.bad ? t.blocked : t.ansi2).child(this.message.text)));
  }

  preview(t, c) {
    return v_flex().gap(6).p(10).rounded(6).bg(t.background).border_1().border_color(t.border)
      .child(h_flex().gap(8).items_center().text_size(TYPE.xs)
        .child(div().flex_1().min_w(0).text_color(metaColor(t, t.background)).child(`To ${c.agent} (${c.address}), then Enter:`))
        .child(this.button("act-cancel", "Cancel", t, (cx) => { this.confirm = null; cx.notify(); })))
      .child(mono(v_flex().id("pulls-preview").max_h(220).overflow_y_scrollbar().gap(2).text_size(TYPE.xs)
        .children(c.text.split("\n").map((line) => div().whitespace_normal().child(line || " ")))));
  }
}
