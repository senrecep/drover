// Pure parsing for the Ports page: lsof, ps and their formatting. No Herdr imports,
// so `node --test` can load it.

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "::1", "localhost"]);

// "*:3000", "127.0.0.1:24224", "[::1]:4329" -> { host, port }
export function splitAddress(addr) {
  const m = /^(.*):(\d+)$/.exec(String(addr ?? ""));
  if (!m) return null;
  return { host: m[1], port: Number(m[2]) };
}

export function displayBind(host, port) {
  const h = LOOPBACK.has(host) ? "localhost" : host === "[::]" || host === "0.0.0.0" ? "*" : host;
  return `${h}:${port}`;
}

// Wider binds win when IPv4 and IPv6 rows describe the same pid and port.
const bindRank = (host) => (host === "*" || host === "[::]" || host === "0.0.0.0" ? 2 : LOOPBACK.has(host) ? 0 : 1);

// [{ pid, host, port, command }] -> [{ pid, port, bind, hosts, command }], one per pid+port.
// `bind` is the widest bind; `hosts` keeps every host that pid+port listens on (for urlFor).
function listeners(found) {
  const byKey = new Map();
  for (const { pid, host, port, command } of found) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const key = `${pid}:${port}`;
    const prev = byKey.get(key);
    const hosts = prev ? prev.hosts : [];
    if (!hosts.includes(host)) hosts.push(host);
    if (!prev || bindRank(host) > bindRank(prev.host)) {
      byKey.set(key, { pid, port, host, bind: displayBind(host, port), hosts, command });
    }
  }
  return [...byKey.values()].map(({ host, ...r }) => r);
}

// `lsof -iTCP -sTCP:LISTEN -nP` -> [{ pid, port, bind, command }], one per pid+port.
export function parseLsof(text) {
  const found = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.includes("(LISTEN)")) continue;
    const cols = line.trim().split(/\s+/);
    const at = cols.lastIndexOf("(LISTEN)");
    const addr = splitAddress(cols[at - 1]);
    if (addr) found.push({ pid: Number(cols[1]), ...addr, command: cols[0] });
  }
  return listeners(found);
}

// Linux without lsof: `ss -ltnp` -> same shape. The header line is skipped (no -H: older iproute2
// lacks it). "127.0.0.53%lo:53" drops its interface; old ss writes IPv6 bare (":::22", "::1:631"),
// which becomes "[::]" and "[::1]" like newer ss prints it; one
// socket can list several processes in users:(("name",pid=N,fd=N),...). Rows without a pid
// (another user's process) are skipped.
export function parseSs(text) {
  const found = [];
  for (const line of String(text ?? "").split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== "LISTEN") continue;
    const addr = splitAddress(cols[3]);
    if (!addr) continue;
    const bare = addr.host.replace(/%[^\]]*/, "");
    const host = bare.includes(":") && !bare.startsWith("[") ? `[${bare}]` : bare;
    for (const m of cols.slice(5).join(" ").matchAll(/\("((?:[^"\\]|\\.)*)",pid=(\d+)/g)) {
      found.push({ pid: Number(m[2]), host, port: addr.port, command: m[1] });
    }
  }
  return listeners(found);
}

// `ss -ltnp` -> Map port -> Set(pid | "?"), for the check after a stop. Unlike parseSs, a LISTEN
// row with no pid (another account's socket, or a rootful docker-proxy) still counts: the port
// is held, we just can't see by whom.
export function parseSsHolders(text) {
  const out = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== "LISTEN") continue;
    const addr = splitAddress(cols[3]);
    if (!addr) continue;
    const pids = [...cols.slice(5).join(" ").matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
    const set = out.get(addr.port) ?? new Set();
    for (const p of pids.length ? pids : ["?"]) set.add(p);
    out.set(addr.port, set);
  }
  return out;
}

// Windows: `netstat -ano` -> same shape (command empty; names come from tasklist). A listening
// TCP row has a foreign address ending in ":0"; the state word itself is translated per
// language, so it isn't read. Covers IPv4 and IPv6 rows.
export function parseNetstat(text) {
  const found = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== "TCP" || cols.length < 5 || !/:0$/.test(cols[2])) continue;
    const addr = splitAddress(cols[1]);
    if (addr) found.push({ pid: Number(cols[cols.length - 1]), ...addr, command: "" });
  }
  return listeners(found);
}

// `tasklist /FO CSV /NH` -> Map pid -> { name, rss } ("node.exe" -> "node"; rss in KB from
// "45,678 K", whatever the thousands separator).
export function parseTasklist(text) {
  const out = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const f = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
    const pid = Number(f[1]);
    if (f.length < 5 || !Number.isInteger(pid) || pid <= 0) continue;
    out.set(pid, { name: f[0].replace(/\.exe$/i, ""), rss: Number(f[4].replace(/\D/g, "")) || 0 });
  }
  return out;
}

// `pwdx <pids>` (procps, used with ss) -> Map pid -> cwd. "1: Permission denied" lines are skipped.
export function parsePwdx(text) {
  const out = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const m = /^(\d+):\s+(\/.*)$/.exec(line.trimEnd());
    if (m) out.set(Number(m[1]), m[2]);
  }
  return out;
}

// Pids among `found` (any parser's rows) that listen on one of `ports`.
export function pidsOnPorts(found, ports) {
  const want = new Set(ports);
  return new Set(found.filter((r) => want.has(r.port)).map((r) => r.pid));
}

// `ps -ww -o pid=,pcpu=,rss=,etime=,command= -p ...` -> Map pid -> { cpu, rss, etime, command }
export function parsePs(text) {
  const out = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    out.set(Number(m[1]), { cpu: Number(m[2]), rss: Number(m[3]), etime: m[4], command: m[5].trimEnd() });
  }
  return out;
}

// `ps -axo pid=,ppid=` -> Map pid -> ppid
export function parsePpid(text) {
  const out = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), Number(m[2]));
  }
  return out;
}

// `lsof -a -d cwd -p ... -Fn` -> Map pid -> cwd
export function parseCwd(text) {
  const out = new Map();
  let pid = null;
  for (const line of String(text ?? "").split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid != null) out.set(pid, line.slice(1));
  }
  return out;
}

// `lsof -t` -> Set of pids
export function parsePids(text) {
  return new Set(String(text ?? "").split(/\s+/).filter(Boolean).map(Number));
}

// ps etime "[[dd-]hh:]mm:ss" -> seconds
export function etimeSeconds(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(etime ?? "").trim());
  if (!m) return null;
  const [, d, h, mi, s] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi) * 60 + Number(s);
}

// "07:06:13" -> "7h 6m", "24-15:17:46" -> "24d 15h", "11:25" -> "11m", "00:42" -> "42s"
export function fmtEtime(etime) {
  const sec = etimeSeconds(etime);
  if (sec == null) return "";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}

// rss in KB -> "23 MB" / "1.2 GB"
export function fmtMem(kb) {
  const mb = Number(kb ?? 0) / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 10) return `${Math.round(mb)} MB`;
  return `${mb.toFixed(1)} MB`;
}

// null: not known (Windows), shown blank.
export function fmtCpu(p) {
  if (p === null) return "";
  const n = Number(p ?? 0);
  return n < 10 ? `${n.toFixed(1)}%` : `${Math.round(n)}%`;
}

export function tildify(path, home) {
  if (!path) return "";
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

export function folderName(path, home) {
  if (!path) return "";
  if (home && path === home) return "~";
  if (path === "/") return "/";
  return path.replace(/\/+$/, "").split("/").pop();
}

const base = (s) => String(s ?? "").split("/").pop();
const NODEISH = new Set(["node", "bun", "deno", "nodejs"]);
const PYTHONISH = /^python(\d+(\.\d+)?)?$/i;

// The first argument after `from` that isn't a flag and looks like a subcommand word.
function subcommand(words, from) {
  const w = words[from];
  return w && /^[a-z][\w:-]*$/.test(w) ? w : null;
}

// A friendly process name from its full command line.
export function friendlyName(command, fallback = "") {
  const cmd = String(command ?? "").trim();
  if (!cmd) return fallback;
  if (/^next-server\b/.test(cmd)) return "node";
  const app = /^\/Applications\/([^/]+)\.app\//.exec(cmd);
  if (app) return app[1];
  const words = cmd.split(/\s+/);
  const exe = /([^/]+)\.app\/Contents\/MacOS\//.exec(cmd)?.[1] ?? base(words[0]);
  if (/^Python$/.test(exe) || PYTHONISH.test(exe)) {
    if (words[1] === "-m" && words[2]) return words[2];
    if (words[1] && !words[1].startsWith("-")) return base(words[1]);
    return "python";
  }
  if (NODEISH.has(exe) && words[1]) {
    const script = words[1];
    const bin = /node_modules\/\.bin\/([^/]+)$/.exec(script)?.[1] ?? /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(script)?.[1];
    if (bin) {
      const name = bin.split("/").pop();
      const sub = subcommand(words, 2);
      return sub ? `${name} ${sub}` : name;
    }
    if (!script.startsWith("-")) return `${exe} ${base(script)}`;
  }
  return exe || fallback;
}

// The program's own name from its command line, never its arguments. A macOS bundle binary
// can have spaces ("OrbStack Helper.app/Contents/MacOS/OrbStack Helper"): when the text after
// MacOS/ starts with the bundle name, that name is it; otherwise the first word after MacOS/
// ("Docker.app/Contents/MacOS/com.docker.backend" -> "com.docker.backend"). A rewritten title
// such as "postgres: checkpointer" loses its colon.
function knownExeOf(cmd) {
  if (!cmd.startsWith("/")) return undefined;
  const names = [...CONTAINER_NAMES.keys()].sort((a, b) => b.length - a.length);
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`^((?:/[^/]+)*)/(${escaped.join("|")}|com\\.docker\\.[^/\\s]+)(?=\\s|$)`);
  const m = re.exec(cmd);
  if (!m) return undefined;
  const folders = m[1].split("/").slice(1);
  if (folders.some((f) => /^\s|\s$|\s-|=/.test(f))) return undefined;
  return m[2];
}

export function exeOf(command) {
  const cmd = String(command ?? "").trim();
  if (!cmd) return undefined;
  const all = [...cmd.matchAll(/([^/]+)\.app\/Contents\/MacOS\//g)];
  if (all.length) {
    const last = all[all.length - 1];
    const bundle = last[1];
    const rest = cmd.slice(last.index + last[0].length);
    if (rest === bundle || rest.startsWith(`${bundle} `)) return bundle;
    const first = rest.split(/\s+/)[0];
    if (first) return first;
  }
  // A plain absolute path whose folders have spaces: match the known container programs by the
  // basename of the executable path instead of splitting on the first space. Folder names may
  // hold an interior space; a space before "-" or "/" or an "=" means an argument, not a folder.
  const known = knownExeOf(cmd);
  if (known) return known;
  const name = base(cmd.split(/\s+/)[0]).replace(/:$/, "");
  return name || undefined;
}

// A display name that can't carry a secret: anything that looks like an assignment, URL
// userinfo or query falls back to the program name. friendlyName never returns arguments
// today; this is the second line of defense.
export function safeName(name, exe) {
  const n = String(name ?? "");
  if (!n || n.length > 60 || /[=@?&%]|:\/\/|\b(token|secret|password|passwd|apikey|api_key)\b/i.test(n)) return exe || "process";
  return n;
}

// The whole use of a command line: name, exe and the inspect flag. The caller drops the
// command right after, so rows, their signature and the render never hold arguments.
export function describeCommand(command, fallback = "") {
  const exe = exeOf(command);
  return {
    name: safeName(friendlyName(command, fallback), exe ?? fallback),
    exe: exe === undefined ? undefined : safeName(exe, "process"),
    inspect: /(^|\s)--inspect(-brk|-port|-wait)?(=|\s|$)/.test(String(command ?? "")),
  };
}

// ---------- containers and kinds ----------

const DOCKER_DESKTOP = { label: "Docker", meta: "Published by Docker Desktop. Stop the container in Docker." };
const DOCKER = { label: "Docker", meta: "Published by Docker. Stop the container in Docker." };
const ORBSTACK = { label: "Docker", tip: "OrbStack", meta: "Published by OrbStack. Stop the container in OrbStack." };
const CONTAINERS = { label: "Containers", meta: "Published by a container tool. Stop the container there." };
const WSL = { label: "WSL", meta: "Forwarded from WSL. Stop the program inside WSL." };

// Exact executable names (macOS, Linux, Windows without .exe). Only "com.docker." is a prefix.
export const CONTAINER_NAMES = new Map([
  ["com.docker.backend", DOCKER_DESKTOP], ["com.docker.vpnkit", DOCKER_DESKTOP], ["com.docker.build", DOCKER_DESKTOP],
  ["com.docker.proxy", DOCKER_DESKTOP], ["vpnkit", DOCKER_DESKTOP], ["vpnkit-bridge", DOCKER_DESKTOP],
  ["OrbStack", ORBSTACK], ["OrbStack Helper", ORBSTACK],
  ["limactl", CONTAINERS], ["gvproxy", CONTAINERS],
  ["docker-proxy", DOCKER], ["rootlessport", DOCKER], ["rootlesskit", DOCKER],
  ["conmon", CONTAINERS], ["pasta", CONTAINERS], ["slirp4netns", CONTAINERS],
  ["wslrelay", WSL],
]);

// exe -> { label, meta, tip? } or null. Never looks at arguments.
export function containerOf(exe) {
  if (typeof exe !== "string" || !exe) return null;
  const hit = CONTAINER_NAMES.get(exe) ?? (exe.startsWith("com.docker.") ? DOCKER_DESKTOP : null);
  return hit ? { ...hit } : null;
}

const DB_PORTS = new Set([5432, 3306, 33060, 6379, 27017, 11211, 1433, 1521, 26257]);
const DB_EXES = new Set(["postgres", "mysqld", "mariadbd", "redis-server", "valkey-server", "mongod", "memcached", "sqlservr", "cockroach"]);
const DEBUG_PORTS = new Set([9229, 9230, 5005, 5678, 2345]);
const OTHER_PORTS = new Set([5672, 1883, 2181, 9092, 4369, 25, 53]);

// "web" | "db" | "debug" | "other", from fixed tables. Ports are never probed: a one-shot login
// callback would take a probe as its answer. A name beats a port (redis-server on 7000 is db).
export function kindOf({ port, exe, flags } = {}) {
  if (DB_EXES.has(exe)) return "db";
  if (DB_PORTS.has(port)) return "db";
  if (DEBUG_PORTS.has(port) || flags?.inspect) return "debug";
  if (OTHER_PORTS.has(port)) return "other";
  return "web";
}

const WILDCARD = new Set(["*", "[::]", "0.0.0.0", "::"]);
const IP_HOST = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-fA-F:.]+\])$/;

// The URL for a web port, built from a host and a port only. The host follows the binds:
// a wildcard or both loopbacks -> localhost, one loopback -> that one, else the bound address.
export function urlFor(hosts, port) {
  const hs = (hosts ?? []).map(String);
  const v4 = hs.includes("127.0.0.1");
  const v6 = hs.includes("[::1]");
  let host = "localhost";
  if (hs.some((h) => WILDCARD.has(h)) || (v4 && v6) || hs.includes("localhost")) host = "localhost";
  else if (v4) host = "127.0.0.1";
  else if (v6) host = "[::1]";
  else if (hs.length && IP_HOST.test(hs[0])) host = hs[0];
  return `http://${host}:${Number(port)}`;
}

// Walks up from pid through ppids until a pid in `shells` (Map shellPid -> value).
export function findOwner(pid, ppids, shells) {
  const seen = new Set();
  let p = pid;
  while (p > 1 && !seen.has(p)) {
    if (shells.has(p)) return shells.get(p);
    seen.add(p);
    p = ppids.get(p) ?? 0;
  }
  return null;
}

export function sortRows(rows, by) {
  const out = [...rows];
  if (by === "cpu") out.sort((a, b) => b.cpu - a.cpu || a.port - b.port);
  else if (by === "memory") out.sort((a, b) => b.rss - a.rss || a.port - b.port);
  else out.sort((a, b) => a.port - b.port || a.pid - b.pid);
  return out;
}

// Rows grouped by project folder (cwd), then by process. Container rows (Docker and friends)
// go to a "Containers" group; processes whose cwd is empty, "/" or home land in a trailing
// "System" group. Groups and processes follow the sort: lowest port, or highest summed cpu / memory.
// -> [{ key, label, cwd, system, containers, procs: [{ pid, name, exe, container, start, ports: [{ port, bind, hosts, kind }], cpu, rss, up, space, cwd, folder }] }]
const CONTAINERS_KEY = "~containers";
export function groupRows(rows, by, home) {
  const groups = new Map();
  for (const r of sortRows(rows, by)) {
    const full = r.fullCwd ?? "";
    const containers = Boolean(r.container);
    const system = !containers && (!full || full === "/" || (home && full === home));
    const key = containers ? CONTAINERS_KEY : system ? "" : full;
    let g = groups.get(key);
    if (!g) {
      g = {
        key, label: containers ? "Containers" : system ? "System" : r.folder || r.cwd,
        cwd: system || containers ? "" : r.cwd, system, containers, procs: [], byPid: new Map(),
      };
      groups.set(key, g);
    }
    let p = g.byPid.get(r.pid);
    if (!p) {
      p = {
        pid: r.pid, name: r.name, exe: r.exe, container: r.container ?? null, start: r.start ?? null,
        worker: r.worker ?? false, agentSelf: r.agentSelf ?? false,
        ports: [], cpu: r.cpu, rss: r.rss, up: r.up, space: r.space, cwd: r.cwd, folder: r.folder,
      };
      g.byPid.set(r.pid, p);
      g.procs.push(p);
    }
    p.ports.push({ port: r.port, bind: r.bind, hosts: r.hosts ?? [], kind: r.kind ?? "web" });
  }
  const score = (g) => by === "cpu" ? -g.procs.reduce((s, p) => s + p.cpu, 0)
    : by === "memory" ? -g.procs.reduce((s, p) => s + p.rss, 0)
    : Math.min(...g.procs.map((p) => p.ports[0].port));
  const rank = (g) => (g.system ? 2 : g.containers ? 1 : 0);
  return [...groups.values()]
    .map(({ byPid, ...g }) => g)
    .sort((a, b) => rank(a) - rank(b) || score(a) - score(b) || a.label.localeCompare(b.label));
}

// Stop is offered only for a plain pid above 1 whose program is known, that is not a container
// process, not an agent's own process and not a worker folded under its supervisor. An unknown
// exe (tasklist or ps failed, or the name was masked to "process") gets no Stop: it might be a
// container process. Checked at render, at the first click and at the second click.
export function canStop(row) {
  if (!row || !Number.isInteger(row.pid) || row.pid <= 1) return false;
  if (typeof row.exe !== "string" || !row.exe || row.exe === "process") return false;
  if (row.container || containerOf(row.exe)) return false;
  if (row.agentSelf || row.worker) return false;
  return true;
}

// ---------- after a stop: who holds the ports now ----------

// Map port -> Set(pid | "?"), keeping only `ports` when given.
function holdersMap(found, ports) {
  const want = ports ? new Set(ports) : null;
  const out = new Map();
  for (const [port, pids] of found) {
    if (want && !want.has(port)) continue;
    out.set(port, new Set([...(out.get(port) ?? []), ...pids]));
  }
  return out;
}
const fromRows = (rows) => rows.map((r) => [r.port, [r.pid]]);

// `lsof -nP -iTCP:<ports> -sTCP:LISTEN` -> Map port -> Set(pid), or null when the read failed.
// Exit 1 with no output is "nothing listens". On Linux, exit 1 with a listing that parses is
// also valid (see lsofUsable). Anything else is null: a failed read is never "stopped".
export function holdersOutcome(r, platform, ports) {
  if (!r || !lsofUsable(r, platform)) return null;
  return holdersMap(fromRows(parseLsof(r.stdout)), ports);
}

// `ss -ltnp` -> the same, with pid-less rows held by "?".
export function ssHoldersOutcome(r, ports) {
  if (!r || r.code !== 0) return null;
  return holdersMap(parseSsHolders(r.stdout), ports);
}

// `netstat -ano` -> the same.
export function netstatHoldersOutcome(r, ports) {
  if (!r || r.code !== 0) return null;
  return holdersMap(fromRows(parseNetstat(r.stdout)), ports);
}

// One read of the stopped ports. `baseline` is the pre-check read: a holder that already shared
// the port with ours before the signal (a worker or sibling) is never read as a restart.
// -> { verdict: "stopped" | "waiting" | "restarted" | "unknown", pid?: number | null, port? }
export function stopVerdict(pid, ports, h, baseline) {
  if (!h) return { verdict: "unknown" };
  // Waiting only while our own pid still holds a port. A pre-signal holder that remains alone
  // (a sibling that shared the port) is not ours and not a restart: the stop is done.
  let other = null;
  for (const port of ports) {
    const set = h.get(port);
    if (!set) continue;
    for (const x of set) {
      if (x === pid) return { verdict: "waiting" };
      if (!other && !baseline?.get(port)?.has(x)) other = { verdict: "restarted", pid: x === "?" ? null : x, port };
    }
  }
  return other ?? { verdict: "stopped" };
}

// The recheck loop as pure state. state: { last, restarted, done, final }. A null read keeps
// waiting and is remembered; "stopped" ends it; "restarted" ends it only on the second read in a
// row that says so (one framework restarts through a brief handover).
export function nextStopState(state, v) {
  const s = { last: state?.last ?? null, restarted: state?.restarted ?? 0, done: false, final: null };
  if (v.verdict === "unknown") return s;
  s.last = v;
  if (v.verdict === "stopped") return { ...s, restarted: 0, done: true, final: v };
  if (v.verdict === "restarted") {
    s.restarted += 1;
    if (s.restarted >= 2) return { ...s, done: true, final: v };
    return s;
  }
  return { ...s, restarted: 0 };
}

// When time runs out, the last good read decides. No good read at all is "unknown"; a failed read
// never counts as stopped. An unconfirmed "restarted" still reports as restarted.
// -> "stopped" | "still" | "restarted" | "unknown"
export function finalVerdict(last) {
  if (!last) return "unknown";
  if (last.verdict === "waiting") return "still";
  if (last.verdict === "restarted") return "restarted";
  if (last.verdict === "stopped") return "stopped";
  return "unknown";
}

// ps etime -> start time in seconds since the epoch (null when unreadable).
export function startOf(etime, nowSec) {
  const s = etimeSeconds(etime);
  return s == null ? null : nowSec - s;
}

// Same process as the row? Starts within 2 seconds; a missing start on either side is "changed".
export const sameStart = (a, b) => a != null && b != null && Math.abs(a - b) <= 2;

export function killArgs(pid) {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`refusing to signal pid ${pid}`);
  return ["-TERM", String(pid)];
}

// ---------- per platform ("macos" | "linux" | "windows"); argv only ----------

// An exec rejection that means the program isn't installed.
export const notInstalled = (e) => /program not found|ENOENT|no such file/i.test(String(e?.message ?? e ?? ""));

// The stop command: SIGTERM, or taskkill (asks the program to close; no /F) on Windows.
export function stopCall(pid, platform) {
  const args = killArgs(pid);
  return platform === "windows" ? ["taskkill", ["/PID", String(pid)]] : ["kill", args];
}

// Opens a web port in the default browser: a port number (http://localhost:PORT) or a URL from
// urlFor. Anything else is refused, so only a host and a port ever reach the browser.
const SAFE_URL = /^http:\/\/(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-fA-F:.]+\]):\d{1,5}$/;
export function openCall(target, platform) {
  const url = typeof target === "string" ? target : `http://localhost:${Number(target)}`;
  if (!SAFE_URL.test(url)) throw new Error("refusing to open that address");
  if (platform === "windows") return ["explorer.exe", [url]];
  if (platform === "linux") return ["xdg-open", [url]];
  return ["open", [url]];
}

// The listing calls the Ports page runs, in order of preference.
export const lsofListCall = () => ["lsof", ["-iTCP", "-sTCP:LISTEN", "-nP"]];
export const ssListCall = () => ["ss", ["-ltnp"]];

const portList = (ports) => {
  const ok = ports.filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  if (!ok.length || ok.length !== ports.length) throw new Error("refusing to read those ports");
  return ok.join(",");
};
// Who listens on these ports now, any pid (no -p): the column form, so parseLsof can read it.
export const lsofHoldersCall = (ports) => ["lsof", ["-nP", `-iTCP:${portList(ports)}`, "-sTCP:LISTEN"]];
// The start of one pid, to make sure it is still the process the row showed.
export const psStartCall = (pid) => {
  killArgs(pid);
  return ["ps", ["-o", "etime=", "-p", String(pid)]];
};

// What the page says when nothing can list ports: ss (iproute2) is only offered on Linux.
export const noToolText = (platform) => (platform === "linux" ? "Install lsof (or iproute2 for ss) to list ports" : "Install lsof to list ports");

// Whether a `lsof -iTCP -sTCP:LISTEN` result is usable. lsof exits 1 when nothing listens; on Linux
// some builds also exit 1 with a full listing (a warning about another mount), so there exit 1 is fine
// when the output parses. macOS keeps the old rule: exit 1 only with empty output.
export function lsofUsable(r, platform) {
  if (!r) return false;
  if (r.code === 0) return true;
  if (r.code !== 1) return false;
  const out = String(r.stdout ?? "").trim();
  return !out || (platform === "linux" && parseLsof(out).length > 0);
}
export const netstatCall = () => ["netstat", ["-ano"]];
export const tasklistCall = () => ["tasklist", ["/FO", "CSV", "/NH"]];
export const pwdxCall = (pids) => ["pwdx", pids.map(String)];
