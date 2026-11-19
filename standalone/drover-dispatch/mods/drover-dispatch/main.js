// Dispatch: pick an open GitHub issue of the focused space's repository and set up a place to
// work on it: a git worktree on a new branch, a space on it, worker and reviewer panes side by
// side. Optionally (off by default, two clicks) start an agent in the worker pane.
//
// Two kinds of copy:
// - a layout block (a 0 px block is enough): runs the key command drover-dispatch.open. Draws nothing.
// - an overlay (mod.open drover-dispatch, or one the block opens): the dialog.
import { View, div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { hc, spaces, panes, agents, focused, theme, settings, run, props, appHome, readTextFile, openOverlay, nextCommand, window } from "herdr";
import {
  BODY_MAX, sanitize, oneLine, spaceFolder, spaceProblem, proposedBranch, buildPlan, worktreePath, landingError,
  firstMessage, spaceName, agentCommands, armKey, press, stillArmed, filterIssues, listArgs, viewArgs, userArgs, issueUrl,
  agentBlocked, readyAgent, newSpace, partsBetween, looksLikePrompt, shellAtPrompt,
} from "./logic.js";
import { gitRead, repoOf, readFacts, realPathOf, symlinkParts, addWorktree, gh } from "./git.js";

const MOD = "drover-dispatch";
const AGENT_WAIT_MS = 30000;
const mono = () => settings().font_family ?? "JetBrains Mono";
const inside = (p, dir) => p === dir || String(p ?? "").startsWith(`${dir}/`);

export default class Dispatch extends View {
  init(p, cx) {
    this.overlay = (p ?? props())?.overlay ?? null;
    if (!this.overlay) return this.initBlock(cx);
    // The space is fixed when the dialog opens: Set up moves focus to the new space.
    this.space = spaces().find((s) => s.id === focused()?.space) ?? null;
    this.problem = spaceProblem(this.space);
    this.repo = null; // { main, repo }
    this.issues = null;
    this.viewer = null;
    this.mine = false;
    this.selected = null; // issue number
    this.detail = null; // { n, title, body, error }
    this.viewSeq = 0;
    this.facts = null; // readFacts for the current branch text
    this.factsSeq = 0;
    this.busy = false; // a set-up or open is running
    this.message = null; // { text, bad }
    this.made = null; // { n, branch, space, pane, terminal, started } the place this copy just made
    this.agentOn = false;
    this.agents = [["claude"]];
    this.agentIdx = 0;
    this.armed = null;
    this.starting = false;
    this.inFilter = InputState.new({ placeholder: "Filter issues" });
    this.inBranch = InputState.new({ placeholder: "branch name" });
    this.inFilter.on("change", (_e, cx) => cx.notify());
    this.inBranch.on("change", (_e, cx) => { this.message = null; this.armed = null; this.loadFacts(cx); cx.notify(); });
    if (!this.problem) this.load(cx);
  }

  initBlock(cx) {
    cx.spawn(async () => {
      for (;;) {
        const command = String(await nextCommand());
        if (command === "open") openOverlay({ mod: MOD, kind: "dialog", width: 900, height: 620 });
      }
    });
  }

  // ---- reading ----

  load(cx) {
    cx.spawn(async (cx) => {
      try {
        const cfg = await readTextFile(`${appHome()}/mods/${MOD}/config.json`).catch(() => null);
        try { this.agents = agentCommands(cfg ? JSON.parse(cfg) : null); } catch { this.agents = agentCommands(null); }
        const folder = spaceFolder(this.space, panes());
        if (!folder) throw new Error("The focused space has no folder.");
        this.repo = await repoOf(folder);
        cx.notify();
        const [list, viewer] = await Promise.all([
          gh(listArgs(this.repo.repo)).then((s) => JSON.parse(s || "[]")),
          gh(userArgs()).then((s) => s.trim()).catch(() => null),
        ]);
        this.issues = Array.isArray(list) ? list.filter((i) => Number.isInteger(i?.number)) : [];
        this.viewer = viewer;
      } catch (e) {
        this.problem = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  select(issue, cx) {
    if (this.selected === issue.number) return;
    this.selected = issue.number;
    this.armed = null;
    this.message = null;
    this.detail = { n: issue.number, title: issue.title, body: null, error: null };
    this.inBranch.set_value(proposedBranch(issue));
    this.loadFacts(cx);
    const seq = ++this.viewSeq;
    const n = issue.number;
    cx.spawn(async (cx) => {
      let body = null, error = null;
      try {
        const v = JSON.parse(await gh(viewArgs(this.repo.repo, n)) || "{}");
        body = sanitize(v?.body ?? "", BODY_MAX) || "(no description)";
      } catch (e) {
        error = String(e?.message ?? e);
      }
      if (seq !== this.viewSeq || this.selected !== n) return; // a later selection won
      this.detail = { ...this.detail, body, error };
      cx.notify();
    });
    cx.notify();
  }

  loadFacts(cx) {
    if (!this.repo) return;
    const branch = this.inBranch.value();
    const seq = ++this.factsSeq;
    const path = worktreePath(this.repo.main, branch);
    cx.spawn(async (cx) => {
      const facts = await readFacts(this.repo.main, path).catch(() => null);
      if (seq !== this.factsSeq) return;
      this.facts = facts;
      cx.notify();
    });
  }

  plan(facts = this.facts, branch = this.inBranch.value()) {
    if (!this.repo || !facts) return null;
    return buildPlan({ main: this.repo.main, branch, base: facts.base, worktrees: facts.worktrees, branchExists: facts.branches.has(branch), folderExists: facts.folderExists,
      platform: window()?.platform ?? "macos" });
  }

  // ---- acting ----

  issue() {
    return this.issues?.find((i) => i.number === this.selected) ?? null;
  }

  setUp(cx) {
    const issue = this.issue();
    if (this.busy || !issue || !this.repo) return; // a second click while running does nothing
    this.busy = true;
    this.armed = null;
    this.message = { text: "Working…", bad: false };
    const branch = this.inBranch.value();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const main = this.repo.main;
        const facts = await readFacts(main, worktreePath(main, branch));
        this.facts = facts;
        const plan = this.plan(facts, branch);
        if (plan.kind === "refuse") throw new Error(plan.reason);
        if (plan.kind === "create") {
          const ref = await gitRead(main, ["check-ref-format", "--branch", branch]);
          if (!ref.ok) throw new Error(`Not a valid branch name: ${branch}`);
          const parent = plan.path.slice(0, plan.path.lastIndexOf("/"));
          const [realMain, realParent, links] = await Promise.all([realPathOf(main), realPathOf(parent), symlinkParts(partsBetween(main, parent))]);
          const lands = landingError(realMain, realParent, main, parent, links);
          if (lands) throw new Error(lands);
          const err = await addWorktree(main, plan.path, branch, facts.base);
          if (err) throw new Error(err);
        }
        await this.place(cx, issue, branch, plan.path, plan.kind === "create");
      } catch (e) {
        this.message = { text: String(e?.message ?? e), bad: true };
      } finally {
        this.busy = false;
        this.loadFacts(cx);
        cx.notify();
      }
    });
  }

  // A space on the worktree with worker and reviewer side by side. An existing space there is
  // selected instead, and then no agent can be started from here.
  async place(cx, issue, branch, path, created) {
    const paneList = panes();
    const there = !created && spaces().find((s) => !s.machine && inside(spaceFolder(s, paneList) ?? "", path));
    if (there) {
      run("space.select", { id: there.id });
      if (this.made?.space !== there.id) this.made = null; // keep the place this copy made
      this.message = { text: `Went to space ${there.name}; it was already open on ${path}.`, bad: false };
      return;
    }
    const realPath = await realPathOf(path);
    const name = spaceName(issue);
    const before = new Set(spaces().map((s) => s.id));
    run("space.new", { name, folder: path, machine: "" });
    // Only the new space on this folder with this name; anything ambiguous stops here.
    const found = await this.until(cx, () => { const r = newSpace(spaces(), before, [path, realPath], name); return r.space || r.error ? r : null; });
    if (found?.error) throw new Error(found.error);
    const space = found?.space ?? null;
    const tab = space?.tabs?.[0]?.id;
    const worker = tab && await this.until(cx, () => panes().find((p) => p.tab === tab && p.terminal));
    if (!worker) throw new Error(`${created ? "Created the worktree" : "Found the worktree"}, but the new space did not appear.`);
    run("pane.split", { pane: worker.pane, direction: "right" });
    const reviewer = await this.until(cx, () => panes().find((p) => p.tab === tab && p.terminal && p.pane !== worker.pane));
    this.armed = null;
    this.made = { n: issue.number, branch, space: space.id, pane: worker.pane, terminal: worker.terminal, started: false };
    this.message = {
      text: `${created ? "Created" : "Opened"} ${path} on ${branch}${reviewer ? "; worker left, reviewer right." : "; the reviewer split did not appear."}`,
      bad: !reviewer,
    };
  }

  async until(cx, find, ms = 3000) {
    for (let waited = 0; ; waited += 100) {
      const v = find();
      if (v || waited >= ms) return v ?? null;
      await cx.sleep(100);
    }
  }

  // What the agent button would do now; null when it can't.
  agentPlan() {
    const issue = this.issue();
    const m = this.made;
    if (!this.agentOn || !issue || !m || m.n !== issue.number || m.branch !== this.inBranch.value()) return null;
    if (!panes().some((p) => p.pane === m.pane && p.terminal === m.terminal)) return null;
    const argv = this.agents[this.agentIdx] ?? this.agents[0];
    const message = firstMessage(this.repo.repo, issue);
    return { argv, message, terminal: m.terminal, pane: m.pane, key: armKey([issue.number, this.inBranch.value(), argv, message, m.terminal]) };
  }

  startAgent(cx) {
    const a = this.agentPlan();
    if (!a || this.starting) return;
    // Resuming: the command was typed and the agent stopped on a question; only the message is left.
    const made = this.made;
    const resume = made.awaiting === true;
    const blocked = agentBlocked(made, agents());
    if (blocked) { this.armed = null; this.message = { text: blocked, bad: true }; cx.notify(); return; }
    const r = press(this.armed, a.key);
    this.armed = r.armed;
    if (!r.fire) { cx.notify(); return; }
    this.starting = true;
    made.started = true; // never typed twice, even when a later step fails
    made.awaiting = false;
    this.message = { text: resume ? "Sending the first message…" : `Starting ${a.argv.join(" ")}…`, bad: false };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (!resume) {
          // A shell at its prompt reports no status, so `hc send --if` (idle|working only) cannot guard
          // this: check hc get instead. Typed: only the configured command (safe tokens), never issue text.
          const got = await hc(["get", "--json", a.terminal]);
          let info = null;
          try { info = got.code === 0 ? JSON.parse(got.stdout) : null; } catch { info = null; }
          if (!shellAtPrompt(info)) {
            made.started = false; // nothing was typed: a later click may try again
            throw new Error("The worker pane is not a shell at its prompt; nothing was typed. Return it to the prompt, then click again.");
          }
          const typed = await hc(["send", "--", a.terminal, a.argv.join(" ")]);
          if (typed.code !== 0) throw new Error("Could not type the agent command into the worker pane.");
        }
        // The agent in exactly this pane and terminal, reporting idle. Never --force past a blocked one.
        const ready = await this.until(cx, () => readyAgent(agents(), a.pane, a.terminal), AGENT_WAIT_MS);
        // A trust or permission question first: the screen is checked, never shown or kept.
        const screen = await hc(["read", a.terminal, "--lines", "20"]);
        if (screen.code !== 0) throw new Error("Could not read the worker pane; the message was not sent.");
        if (looksLikePrompt(screen.stdout)) {
          made.awaiting = true;
          throw new Error("The agent is asking a question (trust or permission): answer it in the worker pane, then click again.");
        }
        if (!ready) throw new Error(`${a.argv[0]} did not report ready in the worker pane; the message was not sent.`);
        // --if idle: refused unless an idle agent (not a shell) is there.
        const sent = await hc(["send", "--if", "idle", "--", a.terminal, a.message]);
        if (sent.code !== 0) throw new Error("The agent was not idle; the message was not sent.");
        this.message = { text: `Started ${a.argv.join(" ")} in the worker pane and sent the first message.`, bad: false };
      } catch (e) {
        this.message = { text: String(e?.message ?? e), bad: true };
      } finally {
        this.starting = false;
        cx.notify();
      }
    });
  }

  // ---- drawing ----

  render() {
    const t = theme();
    if (!this.overlay) return div();
    const root = v_flex().id("dispatch-root").size_full().bg(t.background).text_color(t.foreground).font_family(mono()).text_size(12.5)
      .child(h_flex().flex_none().h(52).px(20).gap(10).items_center()
        .child(div().text_size(15).font_bold().child("Dispatch issue"))
        .child(div().min_w(0).truncate().text_color(t.dim).child(this.repo?.repo ?? "")));
    if (this.problem) return root.child(div().px(20).py(8).text_color(t.dim).child(this.problem));
    return root.child(h_flex().flex_1().min_h(0).items_start().gap(14).px(20).pb(16)
      .child(this.listPane(t))
      .child(this.detailPane(t)));
  }

  listPane(t) {
    const shown = filterIssues(this.issues ?? [], this.inFilter.value(), this.mine, this.viewer);
    return v_flex().w(380).flex_none().h_full().gap(8)
      .child(h_flex().gap(8).items_center()
        .child(Input.new(this.inFilter).flex_1().min_w(0).h(28).px(8).rounded(5).border_1().border_color(t.input).bg(t.background))
        .child(div().id("dispatch-mine").flex_none().px(8).h(28).flex().items_center().rounded(5).border_1().cursor_pointer()
          .border_color(this.mine ? t.accent : t.border).text_size(12).text_color(this.mine ? t.foreground : t.muted)
          .when(this.mine, (el) => el.bg(t.selected))
          .when(!this.viewer, (el) => el.opacity(0.55))
          .on_click((_e, cx) => { if (this.viewer) { this.mine = !this.mine; cx.notify(); } })
          .child("Assigned to me")))
      .child(v_flex().id("dispatch-list").flex_1().min_h(0).overflow_y_scrollbar().gap(2)
        .when(this.issues === null, (el) => el.child(div().py(6).text_color(t.dim).child(this.repo ? "Reading issues…" : "Looking at the space…")))
        .when(this.issues !== null && shown.length === 0, (el) => el.child(div().py(6).text_color(t.dim).child("No open issues match.")))
        .children(shown.map((i) => this.issueRow(t, i))));
  }

  issueRow(t, i) {
    const on = this.selected === i.number;
    const labels = (i.labels ?? []).map((l) => oneLine(l?.name, 30)).filter(Boolean);
    return v_flex().id(`dispatch-i-${i.number}`).flex_none().px(8).py(5).gap(2).rounded(6).cursor_pointer()
      .when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.select(i, cx))
      // The title wraps (up to 140 chars) instead of cutting at the column's edge.
      .child(h_flex().gap(6).min_w(0).items_start()
        .child(div().flex_none().text_color(t.muted).child(`#${i.number}`))
        .child(div().flex_1().min_w(0).whitespace_normal().child(oneLine(i.title, 140))))
      .when(labels.length > 0, (el) => el.child(div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(labels.join(" · "))));
  }

  button(id, label, t, onClick, opts = {}) {
    const color = opts.danger ? t.blocked : opts.primary ? t.foreground : t.muted;
    return div().id(id).flex_none().px(10).h(24).flex().items_center().rounded(5).border_1()
      .border_color(opts.danger ? t.blocked : opts.primary ? t.accent : t.border).text_size(12)
      .text_color(opts.disabled ? t.dim : color)
      .when(Boolean(opts.disabled), (el) => el.opacity(0.55))
      .when(!opts.disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }))
      .child(label);
  }

  field(t, label, value, color) {
    return h_flex().gap(8).items_start().text_size(12)
      .child(div().w(84).flex_none().text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).whitespace_normal().text_color(color ?? t.foreground).child(value));
  }

  detailPane(t) {
    const issue = this.issue();
    const box = v_flex().id("dispatch-detail").flex_1().min_w(0).h_full().overflow_y_scrollbar().p(14).gap(10).rounded(8)
      .bg(t.surface).border_1().border_color(t.border);
    if (!issue) return box.child(div().text_color(t.dim).child("Pick an issue."));
    const d = this.detail?.n === issue.number ? this.detail : null;
    const labels = (issue.labels ?? []).map((l) => oneLine(l?.name, 30)).filter(Boolean);
    const plan = this.plan();
    const ap = this.agentPlan();
    const armed = Boolean(stillArmed(this.armed, ap?.key ?? null));
    const blocked = ap ? agentBlocked(this.made, agents()) : null;
    const agentText = this.agents[this.agentIdx] ?? this.agents[0];
    const msg = firstMessage(this.repo.repo, issue);
    const planText = !plan ? "checking…" : plan.kind === "create" ? `new branch from ${this.facts.base} (local)` : plan.reason;
    return box
      .child(div().font_bold().text_size(13).whitespace_normal().child(`#${issue.number} ${oneLine(issue.title, 300)}`))
      .child(div().text_size(11.5).text_color(t.dim).child(issueUrl(this.repo.repo, issue.number)))
      .when(labels.length > 0, (el) => el.child(this.field(t, "Labels", labels.join(", "), t.muted)))
      .child(v_flex().id("dispatch-body").max_h(150).overflow_y_scrollbar().p(8).rounded(6).bg(t.background).border_1().border_color(t.border)
        .text_size(11.5).text_color(t.muted)
        .children((d?.error ? [d.error] : d?.body == null ? ["Reading…"] : d.body.split("\n")).map((l) => div().whitespace_normal().child(l || " "))))
      .child(div().pt(4).text_size(11.5).font_semibold().text_color(t.muted).child("Plan"))
      .child(h_flex().gap(8).items_center()
        .child(div().w(84).flex_none().text_size(12).text_color(t.dim).child("Branch"))
        .child(Input.new(this.inBranch).flex_1().min_w(0).h(28).px(8).rounded(5).border_1().border_color(t.input).bg(t.background)))
      .child(this.field(t, "Worktree", plan?.path ?? "—", t.muted))
      .child(this.field(t, "", planText, plan?.kind === "refuse" ? t.blocked : plan?.kind === "open" ? t.ansi3 : t.dim))
      .child(this.field(t, "Agent", this.agentOn ? `${agentText.join(" ")}, after a second click` : "none (reviewer and worker are plain shells)", t.muted))
      .child(h_flex().gap(8).items_center().flex_wrap()
        .when(plan?.kind !== "open", (el) => el.child(this.button("dispatch-setup", this.busy ? "Setting up…" : "Set up", t,
          (cx) => this.setUp(cx), { primary: true, disabled: this.busy || plan?.kind !== "create" })))
        .when(plan?.kind === "open", (el) => el.child(this.button("dispatch-open", this.busy ? "Opening…" : "Open existing", t,
          (cx) => this.setUp(cx), { primary: true, disabled: this.busy })))
        .child(this.button("dispatch-agent-toggle", this.agentOn ? "☑ Start an agent" : "☐ Start an agent", t,
          (cx) => { this.agentOn = !this.agentOn; this.armed = null; cx.notify(); }))
        .when(this.agentOn && this.agents.length > 1, (el) => el.children(this.agents.map((a, i) =>
          this.button(`dispatch-agent-${i}`, a.join(" "), t, (cx) => { this.agentIdx = i; this.armed = null; cx.notify(); }, { primary: i === this.agentIdx })))))
      .child(v_flex().gap(6).p(10).rounded(6).bg(t.background).border_1().border_color(armed ? t.blocked : t.border)
        .child(div().text_size(11.5).text_color(t.muted).child(!this.agentOn ? "First message (sent only if you start an agent):" : ap
          ? blocked ?? `Types "${ap.argv.join(" ")}" into the worker pane (${ap.terminal}), waits for it, then sends:`
          : "Available after Set up made the worker pane for this issue and branch. First message:"))
        .when(Boolean(ap && !blocked), (el) => el.child(div().text_size(11).text_color(t.dim)
          .child("Risk: a start-up prompt the agent reports as idle (e.g. folder trust) could take this message as its answer.")))
        .children(msg.split("\n").map((l) => div().text_size(11.5).whitespace_normal().text_color(this.agentOn ? t.foreground : t.dim).child(l)))
        .when(this.agentOn, (el) => el.child(h_flex().gap(8)
          .child(this.button("dispatch-start", this.starting ? "Starting…" : armed ? "Confirm: start and send" : "Start agent", t,
            (cx) => this.startAgent(cx), { danger: armed, disabled: !ap || Boolean(blocked) || this.starting }))
          .when(armed, (el) => el.child(this.button("dispatch-cancel", "Cancel", t, (cx) => { this.armed = null; cx.notify(); }))))))
      .when(Boolean(this.message), (el) => el.child(div().text_size(11.5).whitespace_normal().text_color(this.message.bad ? t.blocked : t.ansi2).child(this.message.text)));
  }
}
