// Reads one machine's CPU, memory, GPU and listening ports with read-only commands.
// A missing tool or a failed command leaves that value null; nothing here throws.
import { exec } from "herdr";
import {
  parsePsCpu, parseSysctl, parseVmStat, parseProcStat, cpuFromSamples, parseLoadAvg,
  parseCores, parseMemInfo, parseNvidiaSmi, parseLsof, parseSs, windowsPorts, osName,
} from "./parse.js";

const TIMEOUT = 4000;
const LSOF = ["+c", "0", "-nP", "-iTCP", "-sTCP:LISTEN"];

export class Host {
  // platform: the window's ("macos" | "linux" | "windows"); it describes this computer only.
  constructor(name, platform = "macos") {
    this.on = name; // null: this computer
    this.platform = platform;
    this.os = null; // "Darwin" | "Linux" | "Windows" | other, once known
    this.note = null; // what this host cannot show, and why
    this.portTool = null; // Linux: "ss" or "lsof", once one answered
    this.sys = null; // macOS: { memBytes, cores }
    this.prevStat = null; // Linux: last /proc/stat sample
    this.noGpu = false;
    this.noPorts = false;
    this.gpuSeen = false;
    this.portsSeen = false;
    this.portsTried = false;
    this.busy = false;
    this.data = { cpu: null, mem: null, gpu: null, vram: null, ports: null };
  }

  // stdout of a successful run, else null (not installed, unreachable, nonzero exit).
  async run(cmd, args, okCodes = [0]) {
    try {
      const r = await exec(cmd, args, { on: this.on, timeout: TIMEOUT });
      return okCodes.includes(r.code) ? r.stdout : null;
    } catch {
      return null;
    }
  }

  async poll(withPorts) {
    if (this.busy) return false;
    this.busy = true;
    try {
      // Only this computer is taken as Windows from the window's platform (it may lack uname); a remote
      // host is whatever its uname says (Git Bash's MINGW counts as Windows), and nothing without one.
      if (!this.os && this.on == null && this.platform === "windows") this.os = "Windows";
      if (!this.os) this.os = osName((await this.run("uname", ["-s"]))?.trim()) ?? this.os;
      const next = { ...this.data };
      if (withPorts) this.portsTried = true;
      if (this.os === "Darwin") await this.darwin(next, withPorts);
      else if (this.os === "Linux") await this.linux(next, withPorts);
      else if (this.os === "Windows") await this.windows(next, withPorts);
      this.data = next;
      return true;
    } finally {
      this.busy = false;
    }
  }

  async darwin(next, withPorts) {
    if (!this.sys) this.sys = parseSysctl(await this.run("sysctl", ["-n", "hw.memsize", "hw.ncpu"]));
    next.cpu = parsePsCpu(await this.run("ps", ["-A", "-o", "%cpu="]), this.sys?.cores);
    next.mem = parseVmStat(await this.run("vm_stat", []), this.sys?.memBytes);
    if (withPorts && !this.noPorts) {
      // lsof exits 1 when nothing listens.
      const out = await this.run("lsof", ["+c", "0", "-nP", "-iTCP", "-sTCP:LISTEN"], [0, 1]);
      next.ports = out == null ? null : parseLsof(out);
    }
  }

  async linux(next, withPorts) {
    const out = await this.run("cat", ["/proc/stat", "/proc/meminfo", "/proc/loadavg"]);
    const stat = parseProcStat(out);
    // Busy share since the last poll; on the first one, the load average per core.
    next.cpu = stat ? (cpuFromSamples(this.prevStat, stat) ?? parseLoadAvg(out, parseCores(out))) : null;
    if (stat) this.prevStat = stat;
    next.mem = parseMemInfo(out);
    if (!this.noGpu) {
      const smi = await this.run("nvidia-smi", ["--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"]);
      const g = parseNvidiaSmi(smi);
      if (g) this.gpuSeen = true;
      else if (!this.gpuSeen) this.noGpu = true; // no NVIDIA GPU here: stop asking
      next.gpu = g?.gpu ?? null;
      next.vram = g?.vram ?? null;
    }
    if (withPorts && !this.noPorts) {
      // ss, else lsof (old iproute2 has no -H; some systems have no ss). Once one answered, only that one.
      let ports = null;
      if (this.portTool !== "lsof") {
        const ss = await this.run("ss", ["-ltnp"]);
        if (ss != null) { this.portTool = "ss"; ports = parseSs(ss); }
      }
      if (ports == null && this.portTool !== "ss") {
        const out = await this.run("lsof", LSOF, [0, 1]); // lsof exits 1 when nothing listens
        if (out != null) { this.portTool = "lsof"; ports = parseLsof(out); }
      }
      if (!this.portTool) { this.noPorts = true; this.note = "Install iproute2 (ss) or lsof to list listening ports."; }
      next.ports = ports;
    }
  }

  // Ports from netstat and tasklist, both part of Windows. CPU and memory are not read: Windows has no
  // light command for them (PowerShell every few seconds costs more than it shows).
  async windows(next, withPorts) {
    this.note = "Windows: listening ports only, no CPU or memory.";
    if (withPorts && !this.noPorts) {
      const net = await this.run("netstat", ["-ano"]); // -p TCP would leave out IPv6 (TCPv6) listeners
      if (net == null) { if (!this.portsSeen) this.noPorts = true; next.ports = null; return; }
      this.portsSeen = true;
      next.ports = windowsPorts(net, await this.run("tasklist", ["/FO", "CSV", "/NH"]));
    }
  }
}
