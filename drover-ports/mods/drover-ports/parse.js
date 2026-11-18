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

// [{ pid, host, port, command }] -> [{ pid, port, bind, command }], one per pid+port.
function listeners(found) {
  const byKey = new Map();
  for (const { pid, host, port, command } of found) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const key = `${pid}:${port}`;
    const prev = byKey.get(key);
    if (!prev || bindRank(host) > bindRank(prev.host)) {
      byKey.set(key, { pid, port, host, bind: displayBind(host, port), command });
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

// Rows grouped by project folder (cwd), then by process. Processes whose cwd is
// empty, "/" or home land in a trailing "System" group. Groups and processes follow
// the sort: lowest port, or highest summed cpu / memory.
// -> [{ key, label, cwd, system, procs: [{ pid, name, ports: [{ port, bind }], cpu, rss, up, command, space, cwd, folder }] }]
export function groupRows(rows, by, home) {
  const groups = new Map();
  for (const r of sortRows(rows, by)) {
    const full = r.fullCwd ?? "";
    const system = !full || full === "/" || (home && full === home);
    const key = system ? "" : full;
    let g = groups.get(key);
    if (!g) {
      g = { key, label: system ? "System" : r.folder || r.cwd, cwd: system ? "" : r.cwd, system, procs: [], byPid: new Map() };
      groups.set(key, g);
    }
    let p = g.byPid.get(r.pid);
    if (!p) {
      p = { pid: r.pid, name: r.name, ports: [], cpu: r.cpu, rss: r.rss, up: r.up, command: r.command, space: r.space, cwd: r.cwd, folder: r.folder };
      g.byPid.set(r.pid, p);
      g.procs.push(p);
    }
    p.ports.push({ port: r.port, bind: r.bind });
  }
  const score = (g) => by === "cpu" ? -g.procs.reduce((s, p) => s + p.cpu, 0)
    : by === "memory" ? -g.procs.reduce((s, p) => s + p.rss, 0)
    : Math.min(...g.procs.map((p) => p.ports[0].port));
  return [...groups.values()]
    .map(({ byPid, ...g }) => g)
    .sort((a, b) => (a.system - b.system) || score(a) - score(b) || a.label.localeCompare(b.label));
}

// Stop is allowed only for a plain positive pid above 1 that still listens on the port.
export function canStop(pid, port, listeningPids) {
  return Number.isInteger(pid) && pid > 1 && Number.isInteger(port) && port > 0 && listeningPids.has(pid);
}

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

// Opens http://localhost:PORT in the default browser.
export function openCall(port, platform) {
  const url = `http://localhost:${port}`;
  if (platform === "windows") return ["explorer.exe", [url]];
  if (platform === "linux") return ["xdg-open", [url]];
  return ["open", [url]];
}

// The listing calls the Ports page runs, in order of preference.
export const lsofListCall = () => ["lsof", ["-iTCP", "-sTCP:LISTEN", "-nP"]];
export const ssListCall = () => ["ss", ["-ltnp"]];

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
