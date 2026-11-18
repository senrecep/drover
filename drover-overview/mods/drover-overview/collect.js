// Reads one machine's CPU, memory, GPU and listening ports with read-only commands.
// A missing tool or a failed command leaves that value null; nothing here throws.
import { exec } from "herdr";
import {
  parsePsCpu, parseSysctl, parseVmStat, parseProcStat, cpuFromSamples, parseLoadAvg,
  parseCores, parseMemInfo, parseNvidiaSmi, parseLsof, parseSs,
} from "./parse.js";

const TIMEOUT = 4000;

export class Host {
  constructor(name) {
    this.on = name; // null: this computer
    this.os = null; // "Darwin" | "Linux" | other, once known
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
      if (!this.os) this.os = (await this.run("uname", ["-s"]))?.trim() || null;
      const next = { ...this.data };
      if (withPorts) this.portsTried = true;
      if (this.os === "Darwin") await this.darwin(next, withPorts);
      else if (this.os === "Linux") await this.linux(next, withPorts);
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
      const ss = await this.run("ss", ["-ltnpH"]);
      if (ss != null) this.portsSeen = true;
      else if (!this.portsSeen) this.noPorts = true; // no ss here: stop asking
      next.ports = ss == null ? null : parseSs(ss);
    }
  }
}
