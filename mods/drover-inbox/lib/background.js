// Background work an agent left running when its turn ended: a shell, monitor, task or workflow that Claude Code
// lists under its prompt box, or a live helper terminal it started (`hc run --bg`). The screen is parsed here and
// dropped: only booleans leave this file, and nothing is stored but them, in memory.
// Vendored byte-identical into drover-inbox/lib and drover-agent-tree/lib (a test compares the two).
// It imports nothing: main.js hands in exec, the clock and tree.js's isAgent, so tests can stub them.

/** A newly finished turn stays on Working this long (ms). */
export const BG_HOLD = 3000;
/** The longest wait for the read made when the hold ends. */
export const BG_PROBE_WAIT = 2500;
/** The longest a finished turn is held as Background. */
export const BG_MAX = 300000;
/** The sweep's interval. */
export const BG_SWEEP = 5000;
/** The least time between two reads of one agent. */
export const BG_MIN_GAP = 15000;
/** One read's timeout. */
export const BG_READ_TIMEOUT = 2000;
/** A result older than this says nothing. */
export const BG_MAX_AGE = 30000;
/** How long reads stop after hc couldn't be started. */
export const BG_OFF = 60000;

const BG_PER_SWEEP = 3;
const BG_MAX_INPUT = 65536;
const BG_TAIL = 14;
const BG_FOOTER_LINES = 6;
// The prompt box's bottom edge: box-drawing horizontals and nothing else.
const BG_RULE = /^─{10,}$/;
// A workflow: a glyph, one word (its name, never kept), a bar of shade or full blocks, then done/total.
const BG_FLOW = /^\S{1,2}\s+\S+\s+[░-▓█]{3,}\s*\d+\/\d+/;
// A count: 1 to 99, one space, a known noun. Any other count fails the whole read.
const BG_COUNT = /^([1-9]\d?) (shells?|monitors?|background tasks?|tasks?|workflows?)$/;
const BG_NOUN = { shell: "shell", monitor: "monitor", background: "task", task: "task", workflow: "workflow" };
const BG_WORDS = [["shell", "a shell"], ["monitor", "a monitor"], ["task", "a background task"], ["workflow", "a workflow"], ["terminal", "a helper terminal"]];
// exec rejected for something other than a timeout: hc couldn't be started.
const BG_UNSTARTED = Object.freeze({ unstarted: true });

/**
 * What Claude Code's footer says is still running, from a screen's text. null: unknown (no footer found, or
 * something there that isn't one). The text is never kept.
 * @param {unknown} screen
 * @returns {null | { shell: boolean, monitor: boolean, task: boolean, workflow: boolean }}
 */
export function footerKinds(screen) {
  if (typeof screen !== "string" || screen.length > BG_MAX_INPUT) return null;
  const lines = screen.replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const tail = lines.slice(-BG_TAIL);
  let rule = -1;
  for (let i = tail.length - 1; i >= 0; i--) if (BG_RULE.test(tail[i].trim())) { rule = i; break; }
  if (rule < 0) return null;
  const below = tail.slice(rule + 1).map((l) => l.trim()).filter(Boolean);
  if (below.length > BG_FOOTER_LINES) return null;
  const kinds = { shell: false, monitor: false, task: false, workflow: false };
  for (const line of below) {
    if (BG_FLOW.test(line)) { kinds.workflow = true; continue; }
    const parts = line.split(/\s+·\s+|,\s+/).map((p) => p.trim());
    const counts = parts.filter((p) => /^\d/.test(p));
    if (!counts.length) continue;
    // Claude Code pairs its counts with the down-arrow hint; a statusline that doesn't is not this footer.
    if (!parts.some((p) => p.startsWith("↓"))) return null;
    for (const p of counts) {
      const m = BG_COUNT.exec(p);
      if (!m) return null;
      kinds[BG_NOUN[m[2].split(" ")[0].replace(/s$/, "")]] = true;
    }
  }
  return kinds;
}

/**
 * A live helper terminal under the agent: a non-agent child, such as a shell it started with `hc run --bg`.
 * Nothing about the child but its parent, state and status is read.
 * Direct children only: a helper terminal started by one of the agent's own child agents is not looked for.
 * That is a known limit, kept on purpose so the check stays cheap and simple.
 * @param {any[]} all terminals() @param {string} address @param {(k: any) => boolean} isAgent tree.js's
 */
export function childKinds(all, address, isAgent) {
  return { terminal: Array.isArray(all) && all.some((k) => k && k.parent === address && k.state === "live" && !isAgent(k)) };
}

/**
 * Whether an agent can be read at all: Claude Code, its own turn over (idle or done), nothing under it working
 * or asking, and a terminal of its own (not a mod card).
 * @param {any} a agents()' entry @param {string} own its own word @param {string} tree with its sub-agents'
 */
export function eligible(a, own, tree) {
  return Boolean(a) && a.app === "claude-code" && (own === "idle" || own === "done") && tree !== "working" && tree !== "blocked"
    && typeof a.address === "string" && !a.address.startsWith("pane:");
}

/** Anything at all running. @param {any} k */
export const bgAny = (k) => Boolean(k && (k.shell || k.monitor || k.task || k.workflow || k.terminal));

/** The tooltip, from fixed words only. @param {any} k */
export function bgSentence(k) {
  const words = BG_WORDS.filter(([key]) => k && k[key]).map(([, w]) => w);
  const list = words.length < 2 ? words[0] ?? "something" : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
  return `Its turn ended, but it still has ${list} running.`;
}

/**
 * Reads agents' screens for background work: one at a time, a few per sweep, each agent at most every
 * BG_MIN_GAP, with a timeout. In memory only. The view redraws when a drain says something changed.
 * A row is { a, own, tree, key }: the agent, its own and tree words, and its turn as the cache key.
 */
export const BackgroundProbe = class BackgroundProbe {
  /** @param {{ exec: (cmd: string, args: string[], opts: any) => Promise<any>, now: () => number, isAgent: (k: any) => boolean }} deps */
  constructor({ exec, now, isAgent }) {
    this.exec = exec;
    this.now = now;
    this.isAgent = isAgent;
    /** @type {Map<string, { key: string, kinds: any, at: number }>} */
    this.cache = new Map();
    /** @type {string | null} */
    this.inFlight = null;
    this.inFlightKey = null;
    this.startedAt = 0;
    this.dropAnswer = false;
    this.offUntil = 0;
    /** @type {{ address: string, key: string }[]} */
    this.queue = [];
    this.gen = 0;
  }

  /** hc couldn't be started a moment ago: no reads for now. */
  off() {
    return this.now() < this.offUntil;
  }

  /** The kinds read for this turn, while fresh; else null. */
  kinds(address, key) {
    const e = this.cache.get(address);
    return e && e.key === key && this.now() - e.at <= BG_MAX_AGE ? e.kinds : null;
  }

  /** A read for this turn has answered, whatever it said. */
  answered(address, key) {
    return this.cache.get(address)?.key === key;
  }

  /** The footer says something runs, as of a fresh read for this turn. */
  shown(address, key) {
    return bgAny(this.kinds(address, key));
  }

  /** What a read for this turn says: "yes", "no", or null before one has answered. */
  said(address, key) {
    return this.answered(address, key) ? (this.shown(address, key) ? "yes" : "no") : null;
  }

  /** A read is due: none yet for this turn, or the last is BG_MIN_GAP old. */
  due(address, key) {
    const e = this.cache.get(address);
    return !e || e.key !== key || this.now() - e.at >= BG_MIN_GAP;
  }

  /** Keeps what a screen says, as booleans. */
  record(address, key, screen) {
    this.cache.set(address, { key, kinds: footerKinds(screen), at: this.now() });
  }

  /** It started working: what was read is about a turn that's over. */
  forget(address) {
    this.cache.delete(address);
    this.queue = this.queue.filter((q) => q.address !== address);
    if (this.inFlight === address) this.dropAnswer = true;
  }

  /** Drops agents no longer listed. @param {Set<string>} listed */
  prune(listed) {
    for (const k of [...this.cache.keys()]) if (!listed.has(k)) this.cache.delete(k);
    this.queue = this.queue.filter((q) => listed.has(q.address));
  }

  /** Queues the sweep's reads: eligible rows that are due, stalest first, at most BG_PER_SWEEP. Returns how many. */
  plan(rows) {
    if (this.off()) return 0;
    const taken = new Set(this.queue.map((q) => q.address));
    if (this.inFlight !== null) taken.add(this.inFlight);
    const age = (r) => this.cache.get(r.a.address)?.at ?? -Infinity;
    const due = rows.filter((r) => eligible(r.a, r.own, r.tree) && !taken.has(r.a.address) && this.due(r.a.address, r.key))
      .sort((x, y) => (age(x) - age(y)) || 0);
    const room = Math.max(0, BG_PER_SWEEP - this.queue.length);
    for (const r of due.slice(0, room)) this.queue.push({ address: r.a.address, key: r.key });
    return Math.min(room, due.length);
  }

  /** Queues the read made when a turn's hold ends, ahead of the sweep's. Returns whether it queued one. */
  ask(r) {
    if (this.off() || !eligible(r.a, r.own, r.tree)) return false;
    const address = r.a.address;
    if (this.inFlight === address && this.inFlightKey === r.key && !this.dropAnswer) return false;
    this.queue = this.queue.filter((q) => q.address !== address);
    this.queue.unshift({ address, key: r.key });
    return true;
  }

  /** Reads what's queued, one at a time. Resolves true when what any agent shows changed. */
  async drain() {
    if (this.inFlight !== null) {
      // One read at a time; one that never came back is let go, and its answer dropped if it ever comes.
      if (this.now() - this.startedAt < 3 * BG_READ_TIMEOUT) return false;
      this.gen++;
      this.inFlight = null;
    }
    let changed = false;
    while (this.queue.length && !this.off()) {
      const { address, key } = /** @type {{ address: string, key: string }} */ (this.queue.shift());
      const before = this.said(address, key);
      const gen = ++this.gen;
      this.inFlight = address;
      this.inFlightKey = key;
      this.dropAnswer = false;
      this.startedAt = this.now();
      const kinds = await this.read(address);
      if (gen !== this.gen) return changed;
      this.inFlight = null;
      this.inFlightKey = null;
      if (kinds === BG_UNSTARTED) {
        this.offUntil = this.now() + BG_OFF;
        this.queue = [];
        return true;
      }
      if (this.dropAnswer) { this.dropAnswer = false; continue; }
      this.cache.set(address, { key, kinds, at: this.now() });
      if (this.said(address, key) !== before) changed = true;
    }
    return changed;
  }

  /** One screen read: the kinds, null when unknown, or BG_UNSTARTED. Output and errors are dropped here. */
  async read(address) {
    const start = this.now();
    let r = null;
    try {
      r = await this.exec("hc", ["read", address, "--lines", "0"], { timeout: BG_READ_TIMEOUT });
    } catch (e) {
      let timedOut = this.now() - start >= BG_READ_TIMEOUT * 0.9;
      try { timedOut = timedOut || /time/i.test(String(e && e.message)); } catch { timedOut = true; }
      return timedOut ? null : BG_UNSTARTED;
    }
    try {
      return r && r.code === 0 ? footerKinds(r.stdout) : null;
    } catch {
      return null;
    }
  }
};
