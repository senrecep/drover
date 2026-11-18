// The helper (helper/simd.swift): where it lives, how it is built and started, and how the panel
// talks to it. Pure: no Herdr calls, so it runs under node:test. Every command is an argv list.

import { MOD } from "./sim.js";
import { screenDir } from "./ring.js";

export const HELPER_SRC = ["simd.swift", "simd.h"];
export const DATA_REL = `data/${MOD}`;
export const BUILD_TIMEOUT = 300_000;  // a first build can take a while on a cold toolchain
export const START_TIMEOUT = 15_000;
export const PROTOCOL = 2;
export const EXIT_RUNNING = 3;     // simd --daemon: another helper holds the lock
export const EXIT_FRAMEWORKS = 4;  // simd --daemon: CoreSimulator / SimulatorKit not found

export const helperDir = (appHomeDir) => `${appHomeDir}/mods/${MOD}/helper`;
export const dataDir = (appHomeDir) => `${appHomeDir}/${DATA_REL}`;
export const binDir = (appHomeDir) => `${dataDir(appHomeDir)}/bin`;
export const infoPath = (appHomeDir) => `${dataDir(appHomeDir)}/simd.json`;
export const binPath = (appHomeDir, hash) => `${binDir(appHomeDir)}/simd-${hash}`;

/** FNV-1a (64-bit) over the helper's source texts, as 16 hex digits: a new source builds a new binary. */
export function srcHash(texts) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n, mask = 0xffffffffffffffffn;
  for (const t of texts ?? []) {
    const s = `${String(t ?? "").length}:${String(t ?? "")}`;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h ^= BigInt(c & 0xff); h = (h * prime) & mask;
      h ^= BigInt(c >> 8); h = (h * prime) & mask;
    }
  }
  return h.toString(16).padStart(16, "0");
}

// ---------- argv builders ----------

export const swiftcFindCall = () => ["xcrun", ["--find", "swiftc"]];
export const devDirCall = () => ["xcode-select", ["-p"]];
export const devDirEnvCall = () => ["printenv", ["DEVELOPER_DIR"]];

/** The build: `xcrun swiftc -O ... -o <bin>.tmp-<n>`, renamed into place once it ran `--version`. */
export function buildCall(appHomeDir, out) {
  const src = helperDir(appHomeDir);
  return ["xcrun", ["swiftc", "-O", "-swift-version", "5", "-import-objc-header", `${src}/simd.h`, `${src}/simd.swift`, "-o", out]];
}
export const versionCall = (bin) => [bin, ["--version"]];
export const moveCall = (from, to) => ["mv", ["-f", from, to]];

/** Starts the helper in its own session; it returns once simd.json is written. Frames go into
 *  the drover-sim-screen mod's folder, which the helper never creates. */
export function startCall(appHomeDir, hash, developerDir) {
  return [binPath(appHomeDir, hash), ["--daemon", "--home", dataDir(appHomeDir), "--developer-dir", developerDir,
    "--build", hash, "--screen-dir", screenDir(appHomeDir)]];
}

/** `simd --version` -> true when it is a helper this panel speaks to. */
export const versionOk = (stdout) => String(stdout ?? "").trim() === `simd ${PROTOCOL}`;

/** The developer folder: $DEVELOPER_DIR when set, else `xcode-select -p`; null when neither is a path.
 *  An app bundle (DEVELOPER_DIR=/…/Xcode.app, which xcrun accepts) means its Contents/Developer. */
export function pickDeveloperDir(envOut, selectOut) {
  for (const s of [envOut, selectOut]) {
    const v = String(s ?? "").trim().split("\n")[0].trim().replace(/\/+$/, "");
    if (v.startsWith("/")) return /\.app$/.test(v) ? `${v}/Contents/Developer` : v;
  }
  return null;
}

/** Temporary builds (simd-<hash>.tmp-<ms>) left by an interrupted build, older than `maxAge`. */
export function staleBuildTemps(names, now, maxAge = BUILD_TIMEOUT) {
  return (names ?? []).filter((n) => {
    const m = /^simd-[0-9a-f]{16}\.tmp-(\d+)$/.exec(n);
    return Boolean(m) && now - Number(m[1]) > maxAge;
  });
}

/** A random id for one panel (one view); the helper keeps each panel's wishes apart by it. */
export function newClientId(rand = Math.random) {
  let s = "";
  for (let i = 0; i < 16; i++) s += Math.floor(rand() * 16).toString(16);
  return s;
}

/** simd.json -> { pid, port, token, ts, version } or null when it isn't a whole, sane record. */
export function parseInfo(text) {
  let o;
  try { o = JSON.parse(String(text ?? "")); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const { pid, port, token, ts, version } = o;
  if (!(Number.isInteger(pid) && pid > 1)) return null;
  if (!(Number.isInteger(port) && port > 0 && port < 65536)) return null;
  if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) return null;
  if (typeof version !== "string" || !version) return null;
  return { pid, port, token, ts: Number(ts) || 0, version };
}

// ---------- requests ----------

/** The URL for a route: 127.0.0.1 only, never the token (it rides in the body). */
export const routeUrl = (info, route) => `http://127.0.0.1:${info.port}/${route}`;

/** fetch() options for a route: a JSON POST whose body carries the token. */
export function requestInit(info, body = {}) {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, token: info.token }) };
}

/** One request through `fetchFn`. Resolves { ok, status, data } and never rejects: a helper
 *  that is gone answers { ok: false, status: 0, error }. Errors never echo the request. */
export async function request(fetchFn, info, route, body = {}) {
  if (!info || typeof fetchFn !== "function") return { ok: false, status: 0, error: "No helper" };
  let res;
  try { res = await fetchFn(routeUrl(info, route), requestInit(info, body)); } catch {
    return { ok: false, status: 0, error: "The helper didn't answer" };
  }
  let data = null;
  try { data = typeof res.json === "function" ? await res.json() : JSON.parse(await res.text()); } catch { data = null; }
  const status = Number(res?.status) || 0;
  const ok = status >= 200 && status < 300 && data?.ok !== false;
  return { ok, status, data, error: ok ? null : String(data?.error ?? `The helper said ${status}`).slice(0, 120) };
}

/** The frame width a view wants: its width in device pixels, 64..640. */
export const frameWidth = (boxWidth, scale = 2) =>
  Math.round(Math.max(64, Math.min(640, (Number(boxWidth) || 200) * (Number(scale) || 2))));

/** The heartbeat body (`boxWidth` in points). A view (`view` set) says which device it shows and whether it is on screen,
 *  plus what it has drawn (`promoted`, `lastRevealSeq`, for /stats). Without `view` it is an
 *  input-only client of `device`. */
export function beatBody({ client, copyKey, view, device, boxWidth, shown, promoted = 0, lastRevealSeq = 0, fps = 30 }) {
  const body = { client, device: device ?? undefined, shown: Boolean(shown), fps };
  if (view) Object.assign(body, { view, copyKey, width: frameWidth(boxWidth), promoted, lastRevealSeq });
  return body;
}

/** The long poll for the view's next frame: `after` is the newest seq it has (the ack), `top` the
 *  slot it shows, `epoch` the helper run those belong to. */
export function nextBody({ client, view, epoch, after, top }) {
  return { client, view, epoch: epoch ?? undefined, after: Math.max(0, Math.floor(Number(after) || 0)), top: Number.isInteger(top) ? top : undefined };
}
