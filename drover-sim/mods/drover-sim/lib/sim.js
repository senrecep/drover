// Pure logic for drover-sim: no Herdr calls here, so it runs under node:test.

export const MOD = "drover-sim";
export const BODY = "panel-body";
export const PANEL = "panel";
export const OLD_FRAMES_REL = `data/${MOD}/frames`;  // before 0.2.0; emptied once on mount
export const SHOTS_REL = `data/${MOD}/shots`;
export const TMP_REL = `data/${MOD}/tmp`;
export const IOS_CAP = 12;
export const EXEC_TIMEOUT = 5000;
export const REMOTE_SHOT = "/data/local/tmp/drover-sim.png";
export const KEY_HOME = 3;
export const KEY_BACK = 4;

// ---------- where the panel is (copied from the drover-history idea; mods stay independent) ----------

/** The node with `id`, or null. Looks in children and floating blocks. */
export function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of [...(node.children ?? []), ...(node.floating ?? [])]) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

/** Whether the side panel column is on screen: it and every node above it shown. */
export function panelShown(root) {
  const walk = (n, shown) => {
    if (!n || typeof n !== "object") return null;
    const here = shown && n.hidden !== true;
    if (n.id === PANEL) return here;
    for (const c of n.children ?? []) {
      const r = walk(c, here && (n.type !== "stack" || n.active == null || n.active === c.id));
      if (r !== null) return r;
    }
    return null;
  };
  return walk(root, true) === true;
}

/** True only while the Simulator is the panel on screen: the side panel shown and panel-body's
 *  selected child is this mod's block. Hidden stack children stay mounted, so the view asks. */
export function simShown(root, id = MOD) {
  const body = findNode(root, BODY);
  if (!body || body.type !== "stack") return false;
  const active = body.active ?? body.children?.[0]?.id;
  return active === id && panelShown(root);
}

// ---------- device discovery ----------

/** "com.apple.CoreSimulator.SimRuntime.iOS-18-2" -> { label: "iOS 18.2", version: [18, 2, 0] }; null
 *  for watchOS, tvOS, xrOS and anything else. */
export function iosRuntime(key) {
  const m = /SimRuntime\.iOS-(\d+)-(\d+)(?:-(\d+))?$/.exec(String(key ?? ""));
  if (!m) return null;
  const version = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  return { label: `iOS ${m[1]}.${m[2]}${m[3] ? `.${m[3]}` : ""}`, version };
}

const cmpVersion = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const STATE = { booted: "booted", shutdown: "shutdown", device: "booted" };
const normState = (s) => STATE[String(s ?? "").toLowerCase()] ?? String(s ?? "unknown").toLowerCase();

/**
 * `xcrun simctl list devices -j` -> iOS devices: every booted one first, then the shutdown
 * devices of the newest iOS runtime, at most `cap` in all. Unavailable devices are left out.
 * `keep` (a udid, e.g. the selected one) stays listed even when that rule would drop it.
 * Throws on text that isn't simctl's JSON.
 */
export function parseSimctl(text, cap = IOS_CAP, keep = null) {
  const data = typeof text === "string" ? JSON.parse(text) : text;
  const all = [];
  for (const [key, list] of Object.entries(data?.devices ?? {})) {
    const rt = iosRuntime(key);
    if (!rt || !Array.isArray(list)) continue;
    for (const d of list) {
      if (!d?.udid || d.isAvailable === false) continue;
      all.push({ platform: "ios", id: String(d.udid), name: String(d.name ?? d.udid), detail: rt.label,
        version: rt.version, state: normState(d.state), emulator: true });
    }
  }
  const booted = all.filter((d) => d.state !== "shutdown");
  const newest = all.filter((d) => d.state === "shutdown").map((d) => d.version).sort(cmpVersion).pop();
  const rest = newest ? all.filter((d) => d.state === "shutdown" && cmpVersion(d.version, newest) === 0) : [];
  const byName = (a, b) => a.name.localeCompare(b.name);
  const out = [...booted.sort(byName), ...rest.sort(byName)].slice(0, cap);
  const kept = keep && !out.some((d) => d.id === keep) ? all.find((d) => d.id === keep) : null;
  if (kept) out.push(kept);
  return out.map(({ version, ...d }) => d);
}

/** Why `exec(xcrun simctl list)` rejected: "missing" when the program couldn't start, else "slow"
 *  (a timeout or anything else; the host's wording isn't specified, so only start failures count). */
export function iosListFailure(message) {
  return /ENOENT|no such file|not found|cannot start|can't start|couldn't start|failed to (start|spawn)/i
    .test(String(message ?? "")) ? "missing" : "slow";
}

/** `adb devices -l` -> Android devices. Emulators are `emulator-<port>`; anything else is a
 *  physical device (never killed). States: booted (adb "device"), offline, unauthorized, ... */
export function parseAdbDevices(text) {
  const out = [];
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("*") || /^List of devices/i.test(line)) continue;
    const m = /^(\S+)\s+(\S+)(.*)$/.exec(line);
    if (!m) continue;
    const model = /\bmodel:(\S+)/.exec(m[3])?.[1];
    const emulator = /^emulator-\d+$/.test(m[1]);
    out.push({ platform: "android", id: m[1], name: model ? model.replace(/_/g, " ") : m[1],
      detail: emulator ? "Emulator" : "Device", state: normState(m[2]), emulator });
  }
  return out;
}

/** `emulator -list-avds` -> AVD names (log lines such as "INFO | ..." are skipped). */
export function parseAvds(text) {
  return String(text ?? "").split("\n").map((l) => l.trim()).filter((l) => /^[A-Za-z0-9._-]+$/.test(l));
}

/** AVDs that aren't running, as list rows (state "avd"; they can't be started from here).
 *  `running`: the AVD names running emulators report (`adb emu avd name`). */
export function avdDevices(names, running = []) {
  const seen = new Set((running ?? []).map((n) => String(n).toLowerCase()));
  return (names ?? []).filter((n) => !seen.has(String(n).toLowerCase()))
    .map((n) => ({ platform: "android", id: `avd:${n}`, name: n.replace(/_/g, " "), detail: "AVD, not running", state: "avd", emulator: true }));
}

/** Android SDK folders to look in when adb is not on PATH: `envDirs` ($ANDROID_HOME,
 *  $ANDROID_SDK_ROOT) first, then the platform's default under home. No duplicates. */
export function sdkDirs(homeDir, platform, envDirs = []) {
  const out = (envDirs ?? []).filter((d) => typeof d === "string" && d.startsWith("/")).map((d) => d.replace(/\/+$/, ""));
  if (typeof homeDir === "string" && homeDir) {
    const h = homeDir.replace(/\/+$/, "");
    if (platform === "macos") out.push(`${h}/Library/Android/sdk`);
    if (platform === "linux") out.push(`${h}/Android/Sdk`);
  }
  return [...new Set(out.filter(Boolean))];
}

/** adb paths to probe (test -x) when adb isn't on PATH: each SDK's platform-tools, then the
 *  package managers' bin folders (a Dock-started app often has a minimal PATH). */
export function adbCandidates(sdks, platform) {
  const out = (sdks ?? []).map((s) => `${s}/platform-tools/adb`);
  if (platform === "macos") out.push("/opt/homebrew/bin/adb", "/usr/local/bin/adb");
  if (platform === "linux") out.push("/usr/local/bin/adb", "/usr/bin/adb");
  return [...new Set(out)];
}

export const envCall = (name) => ["printenv", [name]];

/** The SDK folder an adb path lives in ("<sdk>/platform-tools/adb"), or null. */
export function sdkOfAdb(adbPath) {
  const m = /^(.*)\/platform-tools\/adb$/.exec(String(adbPath ?? ""));
  return m ? m[1] : null;
}

export const deviceKey = (d) => (d ? `${d.platform}:${d.id}` : null);

/** The device to show: the remembered one if still listed, else the first booted, else the first. */
export function pickDevice(list, remembered) {
  const all = list ?? [];
  return all.find((d) => deviceKey(d) === remembered) ?? all.find((d) => d.state === "booted") ?? all[0] ?? null;
}

// ---------- argv builders (argv only, never a shell string) ----------

export const iosListCall = () => ["xcrun", ["simctl", "list", "devices", "-j"]];
export const iosShotCall = (udid, abs) => ["xcrun", ["simctl", "io", udid, "screenshot", "--type=png", abs]];
export const iosBootCall = (udid) => ["xcrun", ["simctl", "boot", udid]];
export const iosShutdownCall = (udid) => ["xcrun", ["simctl", "shutdown", udid]];
export const openSimulatorCall = () => ["open", ["-a", "Simulator"]];
export const adbVersionCall = (adb) => [adb, ["version"]];
export const adbDevicesCall = (adb) => [adb, ["devices", "-l"]];
export const avdListCall = (emulator) => [emulator, ["-list-avds"]];
export const avdNameCall = (adb, serial) => [adb, ["-s", serial, "emu", "avd", "name"]];
export const probeCall = (path) => ["test", ["-x", path]];
export const sizeCall = (abs) => ["file", ["-b", abs]];

/** iOS screenshots are full device size (~1200×2600, 12 MB decoded): the fallback scales each one
 *  down to IOS_MAX_PX on the long side before image() loads it. */
export const IOS_MAX_PX = 640;
export const scaleCall = (src, dst, max = IOS_MAX_PX) => ["sips", ["-Z", String(max), "-s", "format", "jpeg", src, "--out", dst]];

/** Android frame: screencap on the device, then pull it here (exec stdout can't carry binary). */
export function androidShotCalls(adb, serial, abs) {
  return [
    [adb, ["-s", serial, "shell", "screencap", "-p", REMOTE_SHOT]],
    [adb, ["-s", serial, "pull", REMOTE_SHOT, abs]],
  ];
}

// ---------- Android input (argv only) ----------
// The shapes follow herdr-sim's android.js (MIT, see NOTICE): motionevent DOWN/MOVE/UP for a drag,
// one `input swipe ... 120` per wheel gesture, keyevent codes from a USB usage table and
// `keycombination 59 <code>` for Shift. herdr-sim runs them through sh -c; here each is an argv.

/** An emulator's serial (emulator-<console port>); physical devices have other serials. */
export const isEmulatorSerial = (serial) => /^emulator-\d+$/.test(String(serial ?? ""));

export const wmSizeCall = (adb, serial) => [adb, ["-s", serial, "shell", "wm", "size"]];

/** `wm size` output -> { width, height } in device pixels; an "Override size" line wins. */
export function parseWmSize(text) {
  const s = String(text ?? "");
  const m = /Override size:\s*(\d+)x(\d+)/.exec(s) ?? /Physical size:\s*(\d+)x(\d+)/.exec(s);
  if (!m) return null;
  const width = Number(m[1]), height = Number(m[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** A 0..1 ratio -> a device pixel, as herdr-sim rounds it: round(r * (size - 1)). */
export function androidPoint(ratio, size) {
  if (!ratio || !size) return null;
  const c = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  return { x: Math.round(c(ratio.x) * (size.width - 1)), y: Math.round(c(ratio.y) * (size.height - 1)) };
}

const MOTION = { down: "DOWN", move: "MOVE", up: "UP" };

export function motionEventCall(adb, serial, phase, pt) {
  const action = MOTION[phase];
  if (!action || !pt) return null;
  return [adb, ["-s", serial, "shell", "input", "motionevent", action, String(pt.x), String(pt.y)]];
}

export const SWIPE_MS = 120;
export function swipeCall(adb, serial, from, to, ms = SWIPE_MS) {
  if (!from || !to) return null;
  return [adb, ["-s", serial, "shell", "input", "swipe", String(from.x), String(from.y), String(to.x), String(to.y), String(ms)]];
}

/** USB HID usage -> Android keycode (herdr-sim's table). */
export function androidKeycode(usage) {
  const u = Number(usage);
  if (u >= 4 && u <= 29) return u + 25;   // a..z
  if (u >= 30 && u <= 38) return u - 22;  // 1..9
  if (u === 39) return 7;                 // 0
  return ANDROID_KEYS[u] ?? null;
}
export const ANDROID_KEYS = {
  40: 66, 41: 111, 42: 67, 43: 61, 44: 62, 45: 69, 46: 70, 47: 71, 48: 72, 49: 73, 51: 74, 52: 75, 53: 68,
  54: 55, 55: 56, 56: 76, 74: 122, 75: 92, 76: 112, 77: 123, 78: 93, 79: 22, 80: 21, 81: 20, 82: 19,
};
export const SHIFT_LEFT = 59;
const SHIFT_MODS = [0xe1, 0xe5];

/** A keymap press { usage, mods } -> the adb argv, or null when Android has no such key. Shift uses
 *  `input keycombination` (API 33+; older devices reject it and the press is lost). Other
 *  modifiers aren't sent. */
export function androidKeyPress(adb, serial, press) {
  const code = androidKeycode(press?.usage);
  if (code == null) return null;
  const shift = (press?.mods ?? []).some((m) => SHIFT_MODS.includes(m));
  return shift
    ? [adb, ["-s", serial, "shell", "input", "keycombination", String(SHIFT_LEFT), String(code)]]
    : [adb, ["-s", serial, "shell", "input", "keyevent", String(code)]];
}

export function androidKeyCall(adb, serial, code) {
  return [adb, ["-s", serial, "shell", "input", "keyevent", String(code)]];
}

/** `adb emu kill` for emulators only; null for a physical device. */
export function androidKillCall(adb, device) {
  if (!device?.emulator || !/^emulator-\d+$/.test(String(device.id))) return null;
  return [adb, ["-s", device.id, "emu", "kill"]];
}

/** Boot / shut down for a device, or `{ reason }` when the panel can't do it. */
export function powerCall(device, adb) {
  if (!device) return { reason: "No device selected" };
  if (device.platform === "ios") {
    if (device.state === "shutdown") return { action: "boot", call: iosBootCall(device.id) };
    if (device.state === "booted") return { action: "shutdown", call: iosShutdownCall(device.id) };
    return { reason: `Simulator is ${device.state}` };
  }
  if (device.platform === "android") {
    if (device.state === "avd") return { reason: "Start AVDs from Android Studio or a terminal" };
    const call = androidKillCall(adb, device);
    return call ? { action: "shutdown", call } : { reason: "Physical devices aren't shut down from here" };
  }
  return { reason: "Unknown device" };
}

/** Show a saved shot in the file manager. */
export function revealCall(abs, platform) {
  if (platform === "macos") return ["open", ["-R", abs]];
  return ["xdg-open", [abs.replace(/\/[^/]*$/, "") || "/"]];
}

/** `file -b` on a PNG -> { width, height }; null when it isn't a complete PNG header. */
export function parsePngSize(text) {
  const m = /PNG image data, (\d+) x (\d+)/.exec(String(text ?? ""));
  if (!m) return null;
  const width = Number(m[1]), height = Number(m[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** `file -b` on a JPEG -> { width, height } ("..., 640x1390, components 3"); null otherwise. */
export function parseJpegSize(text) {
  const s = String(text ?? "");
  if (!/^JPEG image data/.test(s)) return null;
  const m = /,\s*(\d+)x(\d+),/.exec(s);
  if (!m) return null;
  const width = Number(m[1]), height = Number(m[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

export const shotsDir = (appHomeDir) => `${appHomeDir}/${SHOTS_REL}`;
export const tmpDir = (appHomeDir) => `${appHomeDir}/${TMP_REL}`;

/** The pre-0.2.0 frame names in data/drover-sim/frames/: the only files the one-time migration
 *  deletes. */
export const OLD_FRAME_RE = /^(frame-\d+\.png|raw-\d+\.png|live-\d+-\d+x\d+\.jpg)$/;
export const oldFramesToRemove = (names) => (names ?? []).filter((n) => typeof n === "string" && OLD_FRAME_RE.test(n));

const pad = (n) => String(n).padStart(2, "0");

/** A saved screenshot's file name: "<device>-YYYYMMDD-HHMMSS-mmm.png" (milliseconds, so two
 *  saves in one second don't overwrite each other). */
export function shotName(deviceName, date = new Date()) {
  const slug = String(deviceName ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 40) || "device";
  const d = date;
  return `${slug}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, "0")}.png`;
}

// ---------- fps scheduling ----------

export const fpsOptions = (platform) => (platform === "android" ? [1, 2] : [1, 2, 4]);

/** The fps a device can run at: the asked one if offered, else the fastest offered below it. */
export function clampFps(fps, platform) {
  const opts = fpsOptions(platform);
  const n = Number(fps);
  return opts.filter((o) => o <= n).pop() ?? opts[0];
}

export const intervalMs = (fps) => Math.round(1000 / Math.max(1, Number(fps) || 1));

/** How long to wait before the next frame so frames start `interval` apart (never negative). */
export function nextDelay(fps, elapsedMs) {
  return Math.max(0, intervalMs(fps) - Math.max(0, Number(elapsedMs) || 0));
}

// ---------- preview geometry and taps ----------

/** The image size that fits `frame` inside `box` keeping its aspect ratio (contain). */
export function fitBox(frame, box) {
  const fw = frame?.width, fh = frame?.height, bw = box?.width, bh = box?.height;
  if (!(fw > 0 && fh > 0 && bw > 0 && bh > 0)) return null;
  const scale = Math.min(bw / fw, bh / fh);
  return { width: Math.max(1, Math.floor(fw * scale)), height: Math.max(1, Math.floor(fh * scale)), scale };
}
