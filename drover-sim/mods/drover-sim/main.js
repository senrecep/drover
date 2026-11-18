// drover-sim: a live picture of an iOS Simulator (xcrun simctl) or an Android emulator / device
// (adb), with a device picker and basic controls. A block in the drover layout's panel-body stack,
// or a pane opened with props {"view":"pane"}.
//
// Nothing runs unless this copy is on screen and the window is active: a hidden stack child stays
// mounted and its timers keep ticking, so every tick asks layout() (a pane asks panes()).
//
// Frames go through a ring of RING fixed image files per view in the drover-sim-screen mod
// (lib/ring.js; Herdr refreshes a changed image only under mods/). Each copy leases its own view id
// (`panel-<n>` / `pane-<n>`) and so its own ring. helper/simd.swift, built on first use into
// <appHome>/data/drover-sim/bin/, writes the frames of a booted iOS simulator or a running Android
// emulator into the ring and answers a long poll (`/next`) with the slot it wrote. The view shows
// that slot RELOAD_MS later, once Herdr has reloaded the file: all RING images stay in the tree,
// newest last, so the one on top is always decoded. Mouse, scroll and keys go to the helper (iOS)
// or to adb (Android). When the helper can't run, iOS falls back to screenshots and a physical
// Android device to screencap, written into the same ring by this view (never both at once).
import { View, div, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, home, appHome, layout, theme, window, readTextFile, panes, focused, shared, setShared, nextCommand } from "herdr";
import * as fs from "fs/promises";
import { TYPE, SPACE, mono, metaColor, panelHeader, button, emptyState, sectionLabel } from "./lib/panel-ui.js";
import {
  MOD, EXEC_TIMEOUT, KEY_HOME, KEY_BACK, OLD_FRAMES_REL, simShown, parseSimctl, parseAdbDevices, parseAvds, avdDevices,
  sdkDirs, sdkOfAdb, adbCandidates, envCall, iosListFailure, pickDevice, deviceKey, iosListCall, iosShotCall, openSimulatorCall,
  adbVersionCall, adbDevicesCall, avdListCall, avdNameCall, probeCall, sizeCall, androidShotCalls, androidKeyCall,
  powerCall, revealCall, parsePngSize, parseJpegSize, shotsDir, tmpDir, oldFramesToRemove, shotName, scaleCall,
  isEmulatorSerial, wmSizeCall, parseWmSize, androidPoint, motionEventCall, swipeCall, androidKeyPress,
  fpsOptions, clampFps, nextDelay, fitBox,
} from "./lib/sim.js";
import {
  HELPER_SRC, BUILD_TIMEOUT, START_TIMEOUT, PROTOCOL, EXIT_RUNNING, EXIT_FRAMEWORKS, helperDir, binDir, binPath,
  infoPath, srcHash, swiftcFindCall, devDirCall, devDirEnvCall, buildCall, versionCall, moveCall, startCall, versionOk,
  pickDeveloperDir, parseInfo, request, beatBody, nextBody, staleBuildTemps, newClientId,
} from "./lib/client.js";
import { RING, RELOAD_MS, Ring, ringPaths, screenDir, slotName, tempName, firstSlot, leaseView, touchLease, freeLease } from "./lib/ring.js";
import { HUB_PROBE_MS, isShadowed, probeArgv, repairArgvs } from "./lib/devicehub.js";
import { toRatio, clampRatio, localPoint, touchEdge } from "./lib/coords.js";
import { InputQueue, Pointer, wheelToScroll } from "./lib/throttle.js";
import { keyToHid } from "./lib/keymap.js";
import { initial, step, isLive, statusText } from "./lib/lifecycle.js";

const UI = (name) => `mods/${MOD}/ui/${name}.svg`;
const TICK = 1000;            // how often the view checks whether it is on screen
const DISCOVER_GAP = 5000;    // device lists while shown
const ADB_RETRY = 30_000;     // looking for adb again when it wasn't found
const LIST_TIMEOUT = 10_000;  // simctl list can be slow while CoreSimulator wakes up
const POWER_TIMEOUT = 60_000; // boot / shut down
const ARM_MS = 3000;          // a second click within this confirms Shut down / Repair input
const WEDGED_MS = 5000;       // no /next or /beat answer this long: the helper is wedged
const POLL_RETRY_MS = 2000;   // after a refused /next (view-taken, too many views, no screen mod)
const WHEEL_IDLE = 150;       // an Android wheel gesture ends after this long without a wheel event
const SEL_KEY = "drover-sim.device";
const FPS_KEY = "drover-sim.fps";
const COPY_KEY = "drover-sim.copy";
const LAST_PICK = "drover-sim.lastPick";
const HIDDEN_GRACE = 60_000;  // keep the helper (not capturing) this long after the copy hides
const BUTTONS = [["sim-ios-home", "Home", "home"], ["sim-ios-switcher", "App switcher", "switcher"], ["sim-ios-lock", "Lock", "lock"]];
const XCODE_DEV = /\.app\/Contents\/Developer\/?$/;

/** A failure with a reason fit for the panel; `permanent` ones fall back until Refresh. */
const fail = (reason, permanent = false) => Object.assign(new Error(reason), { permanent });

// A tool's first error line for the footer, with file paths cut out (sips, mv and simctl name them).
const firstLine = (s) => String(s ?? "").trim().split("\n")[0].replace(/(~|\/)[^\s:'"]*\/[^\s:'"]*/g, "<path>").slice(0, 160);
const store = {
  get(k) { try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; } },
  set(k, v) { try { globalThis.localStorage?.setItem(k, String(v)); } catch { /* no storage here */ } },
};
/** The view leases every copy in this Herdr process shares (created on first use, not at load). */
const leases = () => (globalThis.__droverSimViews ??= new Map());
const RING_ERRORS = {
  "screen-mod-missing": "The drover-sim-screen mod isn't installed",
  "view-taken": "Another Herdr is drawing into this view's frames",
  "too-many-views": "Too many simulator views are open",
};

export default class extends View {
  init(props, cx) {
    this.platform = (() => { try { return window().platform; } catch { return "macos"; } })();
    this.kind = props?.view === "pane" ? "pane" : "panel";
    this.copyKey = store.get(COPY_KEY);
    if (!this.copyKey) { this.copyKey = newClientId(); store.set(COPY_KEY, this.copyKey); }
    this.viewId = null;
    this.ring = new Ring();
    this.paths = [];
    this.ios = { tool: "unknown", devices: [], note: null };
    this.android = { tool: "unknown", devices: [], avds: [], note: null };
    this.xcode = null;          // { ok, dev } once checked
    this.adb = null;
    this.adbProbeAt = 0;
    this.emulator = undefined;  // path, null when not found
    this.envSdks = [];          // $ANDROID_HOME / $ANDROID_SDK_ROOT, read when adb isn't on PATH
    this.selKey = store.get(SEL_KEY) ?? (() => { try { const v = shared(LAST_PICK); return typeof v === "string" ? v : null; } catch { return null; } })();
    this.fps = Number(store.get(FPS_KEY)) || 1;
    this.paused = false;
    this.frameError = null;
    this.capturing = false;
    this.pending = false;
    this.localSeq = 0;
    this.discovering = false;
    this.discovered = false;
    this.nextDiscover = 0;
    this.shown = false;
    this.armed = null;          // device key armed for Shut down
    this.powering = false;
    this.box = null;
    this.lastBounds = null;
    this.lastShot = null;
    this.note = null;
    // The live view.
    this.fast = initial();
    this.helper = null;         // simd.json of the running helper
    this.bringing = false;
    this.beating = false;
    this.beatSentAt = 0;
    this.closed = false;
    this.client = newClientId();
    this.hiddenAt = 0;
    this.liveError = null;
    this.polling = false;
    this.pollGen = 0;
    this.pollSentAt = 0;
    this.pollRetryAt = 0;
    this.ringError = null;
    this.epoch = null;          // the helper epoch `after` belongs to
    this.after = 0;
    this.screen = null;         // { key, width, height } of the frame on top
    this.reveals = [];          // when promotes changed the top (for the fps line)
    this.endedKey = null;       // a device the helper said shut down mid-stream
    this.streamFallback = new Set();  // emulators whose gRPC stream can't be used: screencap
    this.pointer = new Pointer();
    this.input = new InputQueue({ send: (item) => this.deliver(item), later: () => {} });
    this.inputDropped = 0;
    this.inputUnpainted = 0;
    this.wmSizes = new Map();
    this.wheel = null;
    this.hub = null;            // { key, shadowed } from the Device Hub probe
    this.hubAt = 0;
    this.repairArmed = null;
    this.repairing = false;
    this.focusHandle = (() => { try { return cx.focus_handle(); } catch { return null; } })();
    this.lease();
    cx.spawn(async () => { await this.migrate(); });
    cx.spawn(async (cx) => {
      for (;;) {
        let c;
        try { c = await nextCommand(); } catch { return; }
        if (this.closed) return;
        if (c === "focus") { try { this.focusHandle?.focus(); } catch { /* nothing to focus */ } }
        cx.notify();
      }
    });
    cx.timer.every(TICK, (cx) => this.tick(cx));
    this.tick(cx);
  }

  /** Keeps this copy's view id; a lost or missing lease leases again (a new, empty ring). */
  lease(now = Date.now()) {
    const map = leases();
    if (this.viewId && touchLease(map, this.viewId, this.copyKey, now)) return;
    const id = leaseView(map, this.kind, this.copyKey, now);
    if (id !== this.viewId) {
      this.viewId = id;
      this.paths = ringPaths(id);
      this.ring = new Ring();
      this.screen = null;
      this.epoch = null;
      this.after = 0;
      this.pollGen++;
      this.polling = false;
    }
  }

  /** Whether the window is the active app (platform focus, not "on screen"). */
  appActive() { try { return window().active !== false; } catch { return false; } }

  visible() {
    if (!this.appActive()) return false;
    try { return this.kind === "pane" ? this.paneShown() : simShown(layout()); } catch { return false; }
  }

  /** A pane copy shows when a drover-sim pane is in the focused tab and no other pane there is
   *  zoomed. A Herdr whose panes() lists no mod panes: the window being active is all we know. */
  paneShown() {
    const list = panes() ?? [];
    if (!list.some((p) => p.mod)) return true;
    const tab = focused()?.tab;
    const here = list.filter((p) => p.tab === tab);
    if (!here.some((p) => p.mod === MOD)) return false;
    return !here.some((p) => p.zoomed && p.mod !== MOD);
  }

  devices() {
    const ios = this.ios.tool === "ok" ? this.ios.devices : [];
    const android = this.android.tool === "ok" ? [...this.android.devices, ...this.android.avds] : [];
    return [...ios, ...android];
  }

  device() { return this.devices().find((d) => deviceKey(d) === this.selKey) ?? null; }

  tick(cx) {
    const now = Date.now();
    this.lease(now);
    this.checkWedged(now, cx);
    if (!this.visible()) { this.shown = false; this.stopPoll(); this.helperTick(false, cx); return; }
    if (!this.shown) { this.shown = true; this.nextDiscover = 0; }
    if (!this.discovering && now >= this.nextDiscover) this.discover(cx);
    this.helperTick(true, cx);
    this.hubTick(cx);
    this.kick(cx);
  }

  /** Best effort on unmount (250 ms budget): free the lease and leave the helper (it quits once no
   *  view is left). */
  async close() {
    this.closed = true;
    this.pollGen++;
    freeLease(leases(), this.viewId, this.copyKey);
    const info = this.helper;
    this.helper = null;
    if (info) await request(globalThis.fetch, info, "quit", { client: this.client });
  }

  /** A request to the running helper, tagged with this copy's client id. */
  call(route, body = {}, info = this.helper) { return request(globalThis.fetch, info, route, { ...body, client: this.client }); }

  /** exec that never throws: { code, stdout, stderr }, code -1 when it couldn't run. */
  async run([cmd, args], timeout = EXEC_TIMEOUT) {
    try { return await exec(cmd, args, { timeout }); } catch { return { code: -1, stdout: "", stderr: "" }; }
  }

  // ---------- live view (helper) ----------

  /** The device the helper streams: a booted iOS simulator or a running emulator, on macOS. */
  liveTarget() {
    const d = this.device();
    if (this.platform !== "macos" || d?.state !== "booted") return null;
    if (d.platform === "ios") return this.xcode?.ok === false ? null : d;
    if (d.platform === "android" && isEmulatorSerial(d.id) && !this.streamFallback.has(deviceKey(d))) return d;
    return null;
  }

  /** Whether `d` is streamed by the helper right now. */
  isLiveFor(d) { return isLive(this.fast) && Boolean(d) && deviceKey(d) === deviceKey(this.liveTarget() ?? {}); }

  /** Frames wanted now: shown, not paused. */
  wantFrames() { return this.shown && !this.paused; }

  helperTick(shown, cx) {
    const now = Date.now();
    if (shown) this.hiddenAt = 0; else if (!this.hiddenAt) this.hiddenAt = now;
    const d = this.liveTarget();
    if (isLive(this.fast)) {
      this.fast = step(this.fast, { type: "healthy" }, now);
      if (d && (shown || now - this.hiddenAt < HIDDEN_GRACE)) {
        this.beat(d, shown && !this.paused, cx);
        if (shown && !this.paused && !this.capturing && now >= this.pollRetryAt && this.endedKey !== deviceKey(d)) this.startPoll(cx);
      } else this.stopHelper(cx);
      return;
    }
    if (shown && d && !this.paused) this.ensureHelper(cx);
  }

  /** A helper that answers nothing for WEDGED_MS (stopped before accept) is replaced. */
  checkWedged(now, cx) {
    if (!this.helper) return;
    const waiting = [this.polling && this.pollSentAt, this.beating && this.beatSentAt].filter(Boolean);
    if (waiting.length && now - Math.min(...waiting) > WEDGED_MS) this.lostHelper(cx);
  }

  dropHelper() {
    this.helper = null;
    this.pollGen++;
    this.polling = false;
    this.beating = false;
  }

  /** Leave the helper: it quits when no other view uses it (and ~5 s after the last heartbeat). */
  stopHelper(cx) {
    const info = this.helper;
    this.dropHelper();
    this.fast = step(this.fast, { type: "stop" });
    if (info) cx.spawn(async () => { await this.call("quit", {}, info); });
    cx.notify();
  }

  lostHelper(cx) {
    this.dropHelper();
    this.pointer = new Pointer();
    this.input.clear();
    this.fast = step(this.fast, { type: "lost" });
    cx.notify();
  }

  ensureHelper(cx) {
    if (this.bringing) return;
    const next = step(this.fast, { type: "check" });
    if (next === this.fast) return;
    this.fast = next;
    this.bringing = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.bringUp(cx);
      } catch (e) {
        this.fast = step(this.fast, { type: "fail", reason: e?.permanent !== undefined ? e.message : "The helper failed",
          permanent: Boolean(e?.permanent) });
      } finally {
        this.bringing = false;
        cx.notify();
        this.kick(cx);   // a helper that failed hands over to screenshots now, not on the next tick
      }
    });
  }

  /** Source -> binary (built if missing) -> a running helper that answers. */
  async bringUp(cx) {
    const root = appHome();
    const texts = [];
    for (const name of HELPER_SRC) {
      const text = await readTextFile(`${helperDir(root)}/${name}`);
      if (text == null) throw fail("The helper's source is missing", true);
      texts.push(text);
    }
    const hash = srcHash(texts);
    const dev = this.xcode?.dev ?? pickDeveloperDir((await this.run(devDirEnvCall())).stdout, (await this.run(devDirCall())).stdout);
    if (!dev) throw fail("No Xcode selected (xcode-select -p)", true);
    const bin = binPath(root, hash);
    if (!versionOk((await this.run(versionCall(bin))).stdout)) {
      this.fast = step(this.fast, { type: "build" });
      cx.notify();
      await this.build(root, bin, hash);
    }
    this.fast = step(this.fast, { type: "start" });
    cx.notify();
    this.helper = await this.connect(root, hash, dev);
    this.fast = step(this.fast, { type: "ready" });
    const d = this.liveTarget();
    if (d) this.beat(d, this.visible() && !this.paused, cx);
  }

  /** `xcrun swiftc` into a temporary name, check it runs, move it into place, drop older builds. */
  async build(root, bin, hash) {
    if ((await this.run(swiftcFindCall())).code !== 0) throw fail("No Swift compiler (install Xcode)", true);
    const dir = binDir(root);
    try { await fs.mkdir(dir, { recursive: true }); } catch { /* the build reports it */ }
    const tmp = `${bin}.tmp-${Date.now()}`;
    const built = (await this.run(buildCall(root, tmp), BUILD_TIMEOUT)).code === 0
      && versionOk((await this.run(versionCall(tmp))).stdout)
      && (await this.run(moveCall(tmp, bin))).code === 0;
    if (!built) {
      try { await fs.unlink(tmp); } catch { /* never written */ }
      throw fail("The helper didn't build", true);
    }
    let names = [];
    try { names = await fs.readdir(dir); } catch { /* nothing to tidy */ }
    const old = [...names.filter((n) => /^simd-[0-9a-f]{16}$/.test(n) && n !== `simd-${hash}`), ...staleBuildTemps(names, Date.now())];
    for (const n of old) { try { await fs.unlink(`${dir}/${n}`); } catch { /* in use */ } }
  }

  /** Reuse a running helper of this build, else start one; resolves its simd.json. */
  async connect(root, hash, dev) {
    const old = parseInfo(await readTextFile(infoPath(root)));
    if (old) {
      const p = await this.call("ping", {}, old);
      if (p.ok && old.version === hash && p.data?.protocol === PROTOCOL) return old;
      if (p.ok) await this.call("quit", { force: true }, old);  // another build: make way
    }
    const r = await this.run(startCall(root, hash, dev), START_TIMEOUT);
    if (r.code === EXIT_FRAMEWORKS) throw fail("This Xcode can't run the helper (simulator frameworks not found)", true);
    if (r.code !== 0) throw fail(r.code === EXIT_RUNNING ? "Another helper is still running" : "The helper didn't start");
    const info = parseInfo(await readTextFile(infoPath(root)));
    if (!info || info.version !== hash) throw fail("The helper didn't start");
    if (!(await this.call("ping", {}, info)).ok) throw fail("The helper didn't answer");
    return info;
  }

  /** The heartbeat: this view, its device, whether it wants frames, and what it has shown. */
  beat(d, shown, cx) {
    if (this.beating || !this.helper) return;
    this.beating = true;
    this.beatSentAt = Date.now();
    const info = this.helper;
    const body = beatBody({ client: this.client, copyKey: this.copyKey, view: this.viewId, device: deviceKey(d),
      boxWidth: this.box?.width, shown, promoted: this.ring.promoted, lastRevealSeq: this.ring.lastRevealSeq });
    cx.spawn(async (cx) => {
      const r = await request(globalThis.fetch, info, "beat", body);
      if (info !== this.helper) return;
      this.beating = false;
      if (r.status === 0 || r.status === 403) { this.lostHelper(cx); return; }
      if (r.data?.unsupported && d.platform === "ios") {
        this.stopHelper(cx);
        this.fast = step(this.fast, { type: "unsupported", reason: firstLine(r.data.error) || "This Xcode isn't supported" });
        return;
      }
      if (r.data?.stream === "fallback") this.streamFallback.add(deviceKey(d));
      if (r.data?.ended && this.endedKey !== deviceKey(d)) this.simEnded(d, cx);
      this.liveError = r.ok ? (r.data?.error ? firstLine(r.data.error) : null) : r.error;
      this.ringError = typeof r.data?.view === "string" ? (RING_ERRORS[r.data.view] ?? r.data.view) : this.ringError;
      cx.notify();
    });
  }

  /** The device went away mid-stream: only this view's frames stop; the helper and other views
   *  carry on. Until the next device list says otherwise, it reads as shut down. */
  simEnded(d, cx) {
    this.endedKey = deviceKey(d);
    this.stopPoll();
    if (d) d.state = "shutdown";
    this.nextDiscover = 0;
    cx.notify();
  }

  stopPoll() { if (this.polling) { this.pollGen++; this.polling = false; } }

  /** The long poll: one `/next` at a time; each reply's slot is promoted RELOAD_MS later. The next
   *  `/next` carries `after` (the acknowledgement) and the slot on top. */
  startPoll(cx) {
    if (this.polling || !this.helper || !this.viewId) return;
    this.polling = true;
    const gen = ++this.pollGen;
    const info = this.helper;
    const current = () => gen === this.pollGen && info === this.helper && !this.closed;
    cx.spawn(async (cx) => {
      try {
        while (current()) {
          const d = this.liveTarget();
          if (!d || !this.wantFrames()) break;
          const key = deviceKey(d);
          this.pollSentAt = Date.now();
          const r = await this.call("next", nextBody({ client: this.client, view: this.viewId, epoch: this.epoch, after: this.after,
            top: this.ring.top }), info);
          this.pollSentAt = 0;
          if (!current()) break;
          if (r.status === 0 || r.status === 403) { this.lostHelper(cx); break; }
          if (!r.ok) {
            this.ringError = RING_ERRORS[r.error] ?? firstLine(r.error) ?? "The helper refused the view";
            this.pollRetryAt = Date.now() + POLL_RETRY_MS;
            cx.notify();
            break;
          }
          this.ringError = null;
          const m = r.data ?? {};
          if (m.epoch !== this.epoch) { this.epoch = m.epoch ?? null; this.after = 0; }
          if (m.ended) { this.simEnded(d, cx); break; }
          const seq = Number(m.seq) || 0;
          if (seq > this.after && Number.isInteger(m.slot)) {
            this.after = seq;
            this.reveal(m.slot, seq, this.epoch, { key: m.device ?? key, width: Number(m.w), height: Number(m.h) }, cx);
          }
        }
      } finally {
        if (gen === this.pollGen) this.polling = false;
      }
    });
  }

  /** Shows `slot` on top RELOAD_MS from now, once Herdr has reloaded the file. */
  reveal(slot, seq, epoch, meta, cx) {
    const ring = this.ring;
    cx.timer.after(RELOAD_MS, (cx) => {
      if (ring !== this.ring) return;
      if (ring.promote(slot, seq, epoch)) {
        if (meta.width > 0 && meta.height > 0) this.screen = meta;
        const now = Date.now();
        this.reveals.push(now);
        while (this.reveals.length && now - this.reveals[0] > 1000) this.reveals.shift();
        cx.notify();
      }
    });
  }

  /** Frames shown in the last second. */
  measuredFps(now = Date.now()) { return this.reveals.filter((t) => now - t <= 1000).length; }

  // ---------- input ----------

  /** Where input for `d` goes: "helper" (iOS live), "adb" (a booted Android device) or null. */
  inputRoute(d) {
    if (d?.state !== "booted") return null;
    if (d.platform === "ios") return this.isLiveFor(d) && this.helper ? "helper" : null;
    if (d.platform === "android") return this.adb ? "adb" : null;
    return null;
  }

  /** Sends one queued item: to the helper, or as adb argv for Android. */
  async deliver(item) {
    const key = item.body?.device ?? "";
    if (!key.startsWith("android:")) return this.call(item.route, item.body);
    const serial = key.slice("android:".length);
    if (item.route === "touch") {
      const size = await this.wmSize(serial);
      const call = motionEventCall(this.adb, serial, item.body.phase, androidPoint(item.body, size));
      if (call) await this.run(call);
    } else if (item.route === "argv") await this.run(item.body.argv);
    return { ok: true };
  }

  /** The device's screen size in pixels, read once per serial. */
  async wmSize(serial) {
    if (this.wmSizes.has(serial)) return this.wmSizes.get(serial);
    const size = parseWmSize((await this.run(wmSizeCall(this.adb, serial))).stdout);
    if (size) this.wmSizes.set(serial, size);
    return size;
  }

  sendInput(items, cx) {
    this.input.later = (ms, fn) => cx.timer.after(ms, () => fn());
    for (const it of [items].flat()) if (it) this.input.push(it);
  }

  /** The press as a ratio on the picture; null (and counted) when the host gave no usable point. */
  pointRatio(e, clamp = false) {
    if (e?.bounds) this.lastBounds = e.bounds;
    const p = localPoint(e, this.lastBounds);
    if (!p) return null;
    return clamp ? clampRatio(p, this.fit) : toRatio(p, this.fit);
  }

  withDevice(item, d) { return item ? { ...item, body: { ...item.body, device: deviceKey(d) } } : null; }

  touchDown(e, cx) {
    cx.stop_propagation();
    try { this.focusHandle?.focus(); } catch { /* keys just won't reach it */ }
    const d = this.device();
    const route = this.inputRoute(d);
    if (!route) { this.inputDropped++; cx.notify(); return; }
    if (e?.bounds) this.lastBounds = e.bounds;
    const p = localPoint(e, this.lastBounds);
    if (!p) { this.inputUnpainted++; cx.notify(); return; }
    const ratio = toRatio(p, this.fit);
    if (!ratio) return;
    const item = this.withDevice(this.pointer.down(ratio), d);
    const edge = d.platform === "ios" ? touchEdge(ratio) : 0;
    if (item && edge) item.body.edge = edge;
    this.sendInput(item, cx);
  }

  touchMove(e, cx) {
    if (e?.bounds) this.lastBounds = e.bounds;
    if (!this.pointer.held) return;
    this.sendInput(this.withDevice(this.pointer.move(this.pointRatio(e, true)), this.device()), cx);
  }

  touchUp(e, cx) {
    if (this.pointer.held) this.sendInput(this.withDevice(this.pointer.up(this.pointRatio(e, true)), this.device()), cx);
  }

  touchLeave(cx) {
    if (this.pointer.held) this.sendInput(this.withDevice(this.pointer.leave(), this.device()), cx);
  }

  scroll(e, cx) {
    cx.stop_propagation();
    const d = this.device();
    const route = this.inputRoute(d);
    if (!route) { this.inputDropped++; cx.notify(); return; }
    const s = wheelToScroll(e, this.pointRatio(e), this.fit);
    if (!s) return;
    if (route === "helper") { this.sendInput({ route: "scroll", body: { ...s, device: deviceKey(d) } }, cx); return; }
    // Android: one swipe per gesture, sent once the wheel has gone idle.
    const now = Date.now();
    const w = this.wheel && this.wheel.key === deviceKey(d) ? this.wheel : { key: deviceKey(d), x: s.x, y: s.y, dx: 0, dy: 0 };
    w.dx += s.dx; w.dy += s.dy; w.at = now;
    this.wheel = w;
    cx.timer.after(WHEEL_IDLE, (cx) => this.wheelIdle(w, d, cx));
  }

  async wheelIdle(w, d, cx) {
    if (this.wheel !== w || Date.now() - w.at < WHEEL_IDLE - 10) return;
    this.wheel = null;
    const serial = d.id;
    const size = await this.wmSize(serial);
    const c = (v) => Math.min(1, Math.max(0, v));
    const call = swipeCall(this.adb, serial, androidPoint(w, size), androidPoint({ x: c(w.x + w.dx), y: c(w.y + w.dy) }, size));
    if (call) this.sendInput({ route: "argv", body: { argv: call, device: w.key } }, cx);
  }

  typeKey(e, cx) {
    const k = keyToHid(e);
    if (!k) return;
    const d = this.device();
    const route = this.inputRoute(d);
    if (!route) return;
    cx.stop_propagation();
    if (route === "helper") { this.sendInput({ route: "key", body: { ...k, device: deviceKey(d) } }, cx); return; }
    const call = androidKeyPress(this.adb, d.id, k);
    if (call) this.sendInput({ route: "argv", body: { argv: call, device: deviceKey(d) } }, cx);
  }

  // ---------- Device Hub (Xcode 27) ----------

  hubTick(cx) {
    const d = this.device();
    if (this.platform !== "macos" || d?.platform !== "ios" || d.state !== "booted") { this.hub = null; return; }
    const key = deviceKey(d);
    const now = Date.now();
    if (this.hub?.key === key && now < this.hubAt) return;
    this.hubAt = now + HUB_PROBE_MS;
    cx.spawn(async (cx) => {
      const r = await this.run(probeArgv(d.id));
      this.hub = { key, shadowed: r.code === 0 && isShadowed(r.stdout) };
      cx.notify();
    });
  }

  /** Repair input: the first click arms it, a second within ARM_MS runs the three steps in
   *  order (stopping when the flag is already clear), then asks the helper to rebind. */
  repair(cx) {
    const d = this.device();
    if (!d || d.platform !== "ios" || this.repairing) return;
    const key = deviceKey(d);
    if (this.repairArmed !== key) {
      this.repairArmed = key;
      cx.timer.after(ARM_MS, (cx) => { if (this.repairArmed === key) { this.repairArmed = null; cx.notify(); } });
      cx.notify();
      return;
    }
    this.repairArmed = null;
    this.repairing = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const [probe, ...rest] = repairArgvs(d.id);
        const r = await this.run(probe);
        if (r.code === 0 && isShadowed(r.stdout)) {
          for (const argv of rest) {
            if ((await this.run(argv, POWER_TIMEOUT)).code !== 0) { this.say("Repair input failed", true, cx); return; }
          }
        }
        if (this.helper) await this.call("rebind", { device: key });
        this.hubAt = 0;
        this.say("Input repaired", false, cx);
      } finally {
        this.repairing = false;
        cx.notify();
      }
    });
  }

  // ---------- fallback frames (this view writes its own ring) ----------

  /** Once on mount: the pre-0.2.0 frame files, then their folder when empty. Nothing else. */
  async migrate() {
    const dir = `${appHome()}/${OLD_FRAMES_REL}`;
    let names;
    try { names = await fs.readdir(dir); } catch { return; }
    for (const n of oldFramesToRemove(names)) { try { await fs.unlink(`${dir}/${n}`); } catch { /* in use or gone */ } }
    try { if (!(await fs.readdir(dir)).length) await fs.rmdir(dir); } catch { /* not empty or gone */ }
  }

  /** The fallback runs when the helper can't stream this device (a physical Android device, an
   *  emulator without a usable stream, or a failed helper) and no `/next` is out. */
  ready() {
    const d = this.device();
    if (this.paused || d?.state !== "booted" || !this.visible() || this.polling || this.isLiveFor(d)) return false;
    if (this.endedKey === deviceKey(d)) return false;
    // A device the helper can stream gets screenshots only once the helper has failed.
    const helperDown = this.fast.phase === "fallback" || this.fast.phase === "error";
    if (d.platform === "ios") return this.platform === "macos" && this.xcode?.ok !== false && helperDown;
    return Boolean(this.adb) && (!this.liveTarget() || helperDown);
  }

  /** Start a frame unless one is running or already scheduled. */
  kick(cx) {
    if (this.capturing || this.pending || !this.ready()) return;
    this.capture(cx);
  }

  capture(cx) {
    const d = this.device();
    const started = Date.now();
    this.capturing = true;
    cx.spawn(async (cx) => {
      try {
        await this.grab(d, cx);
        this.frameError = null;
      } catch (e) {
        this.frameError = firstLine(e?.message) || "Couldn't take a frame";
      } finally {
        this.capturing = false;
        if (this.ready()) {
          this.pending = true;
          const fps = clampFps(this.fps, this.device()?.platform ?? d.platform);
          cx.timer.after(nextDelay(fps, Date.now() - started), (cx) => { this.pending = false; this.kick(cx); });
        }
        cx.notify();
      }
    });
  }

  /** One frame into the ring: a screenshot (iOS) or screencap (Android) to a temp file, scaled to
   *  a JPEG at `.w-<view>-<i>` (on macOS), renamed onto the slot past the one on top, and shown
   *  RELOAD_MS later like a helper frame. */
  async grab(d, cx) {
    const root = appHome();
    const screen = screenDir(root);
    const view = this.viewId;
    const slot = firstSlot(this.ring.top);
    const tmp = `${tmpDir(root)}/shot-${view}.png`;
    const wip = `${screen}/${tempName(view, slot)}`;
    const dst = `${screen}/${slotName(view, slot)}`;
    try { await fs.mkdir(tmpDir(root), { recursive: true }); } catch { /* the shot reports it */ }
    const run = async (call) => {
      const r = await this.run(call);
      if (r.code !== 0) throw new Error(firstLine(r.stderr) || `${call[0]} exited ${r.code}`);
      return r;
    };
    try {
      for (const call of d.platform === "ios" ? [iosShotCall(d.id, tmp)] : androidShotCalls(this.adb, d.id, tmp)) await run(call);
      await run(this.platform === "macos" ? scaleCall(tmp, wip) : moveCall(tmp, wip));
      await run(moveCall(wip, dst));
    } finally {
      try { await fs.unlink(tmp); } catch { /* never written or moved */ }
      try { await fs.unlink(wip); } catch { /* moved */ }
    }
    const out = (await this.run(sizeCall(dst))).stdout;
    const size = parseJpegSize(out) ?? parsePngSize(out);
    if (!size) throw new Error("The screenshot wasn't an image");
    this.localSeq++;
    this.reveal(slot, this.localSeq, "local", { key: deviceKey(d), ...size }, cx);
  }

  // ---------- discovery ----------

  discover(cx) {
    this.discovering = true;
    cx.spawn(async (cx) => {
      try {
        await Promise.all([this.findIos(), this.findAndroid()]);
      } finally {
        this.discovering = false;
        this.discovered = true;
        this.nextDiscover = Date.now() + DISCOVER_GAP;
        this.fixSelection();
        cx.notify();
        if (this.visible()) this.helperTick(true, cx);
        this.kick(cx);
      }
    });
  }

  /** simctl needs Xcode itself: Command Line Tools alone list nothing. Checked once, and again on
   *  Refresh. */
  async checkXcode() {
    if (this.xcode) return this.xcode;
    const found = (await this.run(["xcrun", ["--find", "simctl"]])).code === 0;
    const dev = pickDeveloperDir((await this.run(devDirEnvCall())).stdout, (await this.run(devDirCall())).stdout);
    return (this.xcode = { ok: found && XCODE_DEV.test(dev ?? ""), dev });
  }

  async findIos() {
    if (this.platform !== "macos") { this.ios = { tool: "missing", devices: [], note: "iOS simulators need macOS" }; return; }
    const x = await this.checkXcode();
    if (!x.ok) { this.ios = { tool: "missing", devices: [], note: "iOS simulators need Xcode" }; return; }
    const [cmd, args] = iosListCall();
    let r;
    try { r = await exec(cmd, args, { timeout: LIST_TIMEOUT }); } catch (e) {
      if (iosListFailure(e?.message) === "missing") { this.ios = { tool: "missing", devices: [], note: "iOS: Xcode not found (xcrun)" }; return; }
      // A timeout (CoreSimulator waking up) or another transient failure: keep what we had.
      this.ios = { ...this.ios, note: "iOS: simctl is slow to answer" };
      return;
    }
    if (r.code !== 0) { this.ios = { tool: "missing", devices: [], note: "iOS: xcrun simctl unavailable (install Xcode)" }; return; }
    const keep = this.selKey?.startsWith("ios:") ? this.selKey.slice(4) : null;
    try { this.ios = { tool: "ok", devices: parseSimctl(r.stdout, undefined, keep), note: null }; } catch {
      this.ios = { tool: "missing", devices: [], note: "iOS: couldn't read simctl's device list" };
    }
    if (this.endedKey && !this.ios.devices.some((d) => deviceKey(d) === this.endedKey && d.state === "booted")) return;
    this.endedKey = this.endedKey?.startsWith("ios:") ? null : this.endedKey;
  }

  async ok(cmd, args, timeout = EXEC_TIMEOUT) {
    try { return (await exec(cmd, args, { timeout })).code === 0; } catch { return false; }
  }

  /** $ANDROID_HOME and $ANDROID_SDK_ROOT from the user's environment (empty when unset). */
  async readEnvSdks() {
    const out = [];
    for (const name of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
      try {
        const r = await exec(...envCall(name), { timeout: EXEC_TIMEOUT });
        const v = String(r.stdout ?? "").trim().split("\n")[0];
        if (r.code === 0 && v) out.push(v);
      } catch { /* not readable */ }
    }
    return out;
  }

  /** adb on PATH, else an SDK's platform-tools or a package manager's bin (probed with test -x). */
  async resolveAdb() {
    if (this.adb) return this.adb;
    if (Date.now() < this.adbProbeAt) return null;
    this.adbProbeAt = Date.now() + ADB_RETRY;
    if (await this.ok(...adbVersionCall("adb"))) return (this.adb = "adb");
    this.envSdks = await this.readEnvSdks();
    for (const p of adbCandidates(sdkDirs(home(), this.platform, this.envSdks), this.platform)) {
      if (await this.ok(...probeCall(p))) return (this.adb = p);
    }
    return null;
  }

  async resolveEmulator() {
    if (this.emulator !== undefined) return this.emulator;
    const sdks = [...new Set([sdkOfAdb(this.adb), ...sdkDirs(home(), this.platform, this.envSdks)].filter(Boolean))];
    for (const sdk of sdks) {
      const p = `${sdk}/emulator/emulator`;
      if (await this.ok(...probeCall(p))) return (this.emulator = p);
    }
    return (this.emulator = null);
  }

  async findAndroid() {
    const adb = await this.resolveAdb();
    if (!adb) { this.android = { tool: "missing", devices: [], avds: [], note: "Android: adb not found" }; return; }
    let devices = [], note = null;
    try {
      const [cmd, args] = adbDevicesCall(adb);
      const r = await exec(cmd, args, { timeout: EXEC_TIMEOUT });
      if (r.code === 0) devices = parseAdbDevices(r.stdout);
      else note = `Android: ${firstLine(r.stderr) || "adb devices failed"}`;
    } catch { note = "Android: adb didn't answer"; }
    const running = [];
    for (const d of devices.filter((x) => x.emulator && x.state === "booted")) {
      try {
        const [cmd, args] = avdNameCall(adb, d.id);
        const r = await exec(cmd, args, { timeout: EXEC_TIMEOUT });
        const name = String(r.stdout ?? "").split("\n")[0].trim();
        if (r.code === 0 && name) running.push(name);
      } catch { /* unknown AVD name */ }
    }
    let avds = [];
    const emulator = await this.resolveEmulator();
    if (emulator) {
      try {
        const [cmd, args] = avdListCall(emulator);
        const r = await exec(cmd, args, { timeout: EXEC_TIMEOUT });
        if (r.code === 0) avds = avdDevices(parseAvds(r.stdout), running);
      } catch { /* no AVD list */ }
    }
    this.android = { tool: "ok", devices, avds, note };
    if (this.endedKey?.startsWith("android:") && devices.some((d) => deviceKey(d) === this.endedKey && d.state === "booted")) this.endedKey = null;
  }

  fixSelection() {
    const d = pickDevice(this.devices(), this.selKey);
    const key = deviceKey(d);
    if (key !== this.selKey) this.select(d);
  }

  select(d) {
    const key = deviceKey(d);
    if (key !== this.selKey) { this.stopPoll(); this.inputDropped = 0; this.inputUnpainted = 0; this.hub = null; }
    this.selKey = key;
    if (d) { store.set(SEL_KEY, key); try { setShared(LAST_PICK, key); } catch { /* a hint only */ } }
    if (d) this.fps = clampFps(this.fps, d.platform);
    // A new pick may try the helper again after a failed build.
    if (this.fast.phase === "fallback" || this.fast.phase === "error") this.fast = step(this.fast, { type: "reset" });
    this.armed = null;
    this.repairArmed = null;
  }

  // ---------- actions ----------

  say(text, bad, cx) {
    const at = Date.now();
    this.note = { text, bad, at };
    cx.timer.after(bad ? 6000 : 3000, (cx) => { if (this.note?.at === at) { this.note = null; cx.notify(); } });
    cx.notify();
  }

  async act(cmd, args, timeout, failText, cx) {
    try {
      const r = await exec(cmd, args, { timeout });
      if (r.code !== 0) { this.say(firstLine(r.stderr) || failText, true, cx); return false; }
      return true;
    } catch (e) { this.say(firstLine(e?.message) || failText, true, cx); return false; }
  }

  power(cx) {
    const d = this.device();
    const p = powerCall(d, this.adb);
    if (p.reason) { this.say(p.reason, true, cx); return; }
    if (p.action === "shutdown" && this.armed !== deviceKey(d)) {
      const key = deviceKey(d);
      this.armed = key;
      cx.timer.after(ARM_MS, (cx) => { if (this.armed === key) { this.armed = null; cx.notify(); } });
      cx.notify();
      return;
    }
    this.armed = null;
    this.powering = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const done = await this.act(p.call[0], p.call[1], POWER_TIMEOUT, p.action === "boot" ? "Boot failed" : "Shut down failed", cx);
      this.powering = false;
      if (done) this.say(p.action === "boot" ? `Booted ${d.name}` : `Shut down ${d.name}`, false, cx);
      if (done && p.action === "boot" && this.endedKey === deviceKey(d)) this.endedKey = null;
      this.nextDiscover = 0;
      if (!this.discovering) this.discover(cx);
      cx.notify();
    });
  }

  openSimulator(cx) {
    const [cmd, args] = openSimulatorCall();
    cx.spawn(async (cx) => { await this.act(cmd, args, EXEC_TIMEOUT, "Couldn't open Simulator.app", cx); });
  }

  key(code, cx) {
    const d = this.device();
    if (d?.platform !== "android" || d.state !== "booted") return;
    const [cmd, args] = androidKeyCall(this.adb, d.id, code);
    cx.spawn(async (cx) => { await this.act(cmd, args, EXEC_TIMEOUT, "adb input failed", cx); });
  }

  /** A fresh full-size screenshot into shots/ (never a ring file). */
  save(cx) {
    const d = this.device();
    if (d?.state !== "booted") return;
    cx.spawn(async (cx) => {
      const dir = shotsDir(appHome());
      const dst = `${dir}/${shotName(d.name)}`;
      try { await fs.mkdir(dir, { recursive: true }); } catch { /* the shot reports it */ }
      const calls = d.platform === "ios" ? [iosShotCall(d.id, dst)] : androidShotCalls(this.adb, d.id, dst);
      for (const [cmd, args] of calls) {
        if (!(await this.act(cmd, args, EXEC_TIMEOUT, "Couldn't save the screenshot", cx))) return;
      }
      this.lastShot = dst;
      this.say(`Saved shots/${dst.slice(dir.length + 1)}`, false, cx);
    });
  }

  reveal_(cx) {
    if (!this.lastShot) return;
    const [cmd, args] = revealCall(this.lastShot, this.platform);
    cx.spawn(async (cx) => { await this.act(cmd, args, EXEC_TIMEOUT, "Couldn't reveal the screenshot", cx); });
  }

  setFps(n, cx) { this.fps = n; store.set(FPS_KEY, n); cx.notify(); }

  togglePause(cx) { this.paused = !this.paused; if (this.paused) this.stopPoll(); cx.notify(); if (!this.paused) this.kick(cx); }

  // ---------- render ----------

  toggle({ id, label, active, onClick }, t) {
    return h_flex().id(id).h(22).px(8).flex_none().items_center().rounded(5).cursor_pointer()
      .role("radio_button").accessibility_label(active ? `${label}, selected` : label).tab_index(0)
      .text_size(TYPE.xs).font_medium()
      .text_color(active ? t.foreground : metaColor(t))
      .when(active, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover)).focus((s) => s.border_1().border_color(t.accent))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); cx.notify(); })
      .on_key_down((e, cx) => { if (e.key === "enter" || e.key === "space") { cx.stop_propagation(); onClick(cx); cx.notify(); } })
      .child(label);
  }

  deviceRow(d, i, t) {
    const selected = deviceKey(d) === this.selKey;
    const dot = d.state === "booted" ? t.done : d.state === "avd" || d.state === "shutdown" ? t.dim : t.blocked;
    return h_flex().id(`sim-dev-${i}`).h(SPACE.ROW_H).flex_none().px(8).gap(6).items_center().rounded(6).cursor_pointer()
      .role("list_item").accessibility_label(`${d.name}, ${d.detail}, ${d.state}`)
      .tab_index(0)
      .when(selected, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
      .focus((s) => s.border_1().border_color(t.accent))
      .on_click((_e, cx) => { this.select(d); cx.notify(); this.kick(cx); })
      .on_key_down((e, cx) => {
        if (e.key === "enter" || e.key === "space") { cx.stop_propagation(); this.select(d); cx.notify(); this.kick(cx); }
      })
      .child(div().size(8).flex_none().rounded(4).bg(dot))
      .child(div().flex_1().min_w(0).truncate().text_size(TYPE.sm).text_color(t.foreground).child(d.name))
      .child(div().flex_none().text_size(TYPE.xs).text_color(metaColor(t, selected ? t.selected : t.background))
        .child(d.state === "booted" || d.state === "shutdown" || d.state === "avd" ? d.detail : `${d.detail} · ${d.state}`));
  }

  deviceList(t) {
    const rows = [];
    let i = 0;
    for (const [label, list, tool] of [["iOS", this.ios.devices, this.ios.tool], ["Android", [...this.android.devices, ...this.android.avds], this.android.tool]]) {
      if (tool !== "ok") continue;
      rows.push(sectionLabel(label, t, { id: `sim-sec-${label.toLowerCase()}` }));
      if (!list.length) rows.push(div().id(`sim-none-${label.toLowerCase()}`).px(8).pb(2).text_size(TYPE.xs).text_color(metaColor(t))
        .child(label === "iOS" ? "No simulators" : "No devices or AVDs"));
      for (const d of list) rows.push(this.deviceRow(d, i++, t));
    }
    return v_flex().id("sim-devices").flex_none().max_h(176).overflow_y_scrollbar().px(4).pb(4)
      .role("list").accessibility_label("Devices").children(rows);
  }

  toolbar(d, t) {
    const p = powerCall(d, this.adb);
    const armed = this.armed === deviceKey(d);
    const booted = d.state === "booted";
    const powerLabel = p.action === "boot" ? "Boot" : armed ? "Confirm shut down" : "Shut down";
    const live = this.isLiveFor(d);
    const actions = h_flex().id("sim-actions").flex_none().px(SPACE.PX).pt(SPACE.GAP).gap(6).items_center().flex_wrap()
      .when(Boolean(p.action), (el) => el.child(button({ id: "sim-power", label: this.powering ? "Working…" : powerLabel,
        kind: armed ? "danger" : "secondary", disabled: this.powering, onClick: (cx) => this.power(cx) }, t)))
      .when(d.state === "avd", (el) => el.child(button({ id: "sim-start", label: "Start", disabled: true,
        tooltip: p.reason, onClick: () => {} }, t)))
      .when(d.platform === "ios", (el) => el.child(button({ id: "sim-open", label: "Open Simulator", onClick: (cx) => this.openSimulator(cx) }, t)))
      .when(live && d.platform === "ios", (el) => el.children(BUTTONS.map(([id, label, name]) => button({ id, label,
        onClick: (cx) => this.sendInput({ route: "button", body: { name, device: deviceKey(d) } }, cx) }, t))))
      .when(d.platform === "android" && booted, (el) => el
        .child(button({ id: "sim-home", label: "Home", onClick: (cx) => this.key(KEY_HOME, cx) }, t))
        .child(button({ id: "sim-back", label: "Back", onClick: (cx) => this.key(KEY_BACK, cx) }, t)))
      .when(booted, (el) => el.child(button({ id: "sim-save", label: "Save", onClick: (cx) => this.save(cx) }, t)))
      .when(Boolean(this.lastShot), (el) => el.child(button({ id: "sim-reveal", label: "Reveal", onClick: (cx) => this.reveal_(cx) }, t)));
    const rate = h_flex().id("sim-rate").flex_none().px(SPACE.PX).pt(6).gap(4).items_center()
      .children(live ? [] : fpsOptions(d.platform).map((n) => this.toggle({ id: `sim-fps-${n}`, label: `${n} fps`,
        active: !this.paused && clampFps(this.fps, d.platform) === n, onClick: (cx) => { this.paused = false; this.setFps(n, cx); this.kick(cx); } }, t)))
      .child(this.toggle({ id: "sim-pause", label: this.paused ? "Paused" : "Pause", active: this.paused, onClick: (cx) => this.togglePause(cx) }, t));
    return v_flex().flex_none().child(actions).when(booted, (el) => el.child(rate));
  }

  preview(d, t) {
    const box = v_flex().id("sim-preview").flex_1().min_h(0).m(SPACE.PX).items_center().justify_center().overflow_hidden()
      .on_size_change((size, cx) => { this.box = size; cx.notify(); });
    const f = this.screen?.key === deviceKey(d) ? this.screen : null;
    if (d.state === "booted" && f && this.endedKey !== deviceKey(d)) {
      const fit = fitBox(f, this.box);
      this.fit = fit;
      // Every ring image stays in the tree, oldest first and the one on top last, so a slot is
      // decoded before it is ever on top (herdr-sim's stack render, MIT, see NOTICE).
      const screen = div().id("sim-screen").relative().flex_none().rounded(6).overflow_hidden()
        .role("image").accessibility_label(`${d.name} screen`).cursor_pointer()
        .when(Boolean(fit), (el) => el.w(fit.width).h(fit.height))
        .when(!fit, (el) => el.size_full())
        .on_mouse_down("left", (e, cx) => this.touchDown(e, cx))
        .on_mouse_move((e, cx) => this.touchMove(e, cx))
        .on_mouse_up("left", (e, cx) => this.touchUp(e, cx))
        .on_hover((hovered, cx) => { if (!hovered) this.touchLeave(cx); })
        .on_scroll_wheel((e, cx) => this.scroll(e, cx))
        .children(this.ring.stack.map((i) => image(this.paths[i]).absolute().inset_0().size_full()));
      return box.child(screen);
    }
    if (d.state === "booted" && this.endedKey !== deviceKey(d)) return box.child(emptyState({ id: "sim-waiting", icon: UI("smartphone"),
      title: this.paused ? "Paused" : this.frameError ? "No frame" : "Waiting for the first frame…",
      body: this.frameError ?? undefined }, t));
    if (d.state === "avd") return box.child(emptyState({ id: "sim-avd", icon: UI("smartphone"), title: `${d.name} isn't running`,
      body: "Start it from Android Studio or a terminal (emulator -avd)." }, t));
    const p = powerCall(d, this.adb);
    return box.child(emptyState({ id: "sim-off", icon: UI("smartphone"), title: `${d.name} is ${d.state === "shutdown" || this.endedKey === deviceKey(d) ? "shut down" : d.state}`,
      body: d.state === "unauthorized" ? "Allow USB debugging on the device." : undefined,
      action: p.action === "boot" ? { id: "sim-boot", label: "Boot", onClick: (cx) => this.power(cx) } : undefined }, t));
  }

  footer(d, t) {
    const live = this.isLiveFor(d);
    const key = deviceKey(d);
    const f = this.screen?.key === key ? this.screen : null;
    const rate = !this.appActive() ? "paused: Herdr isn't the active app"
      : this.paused ? "paused" : live ? `${this.measuredFps()} fps` : `${clampFps(this.fps, d.platform)} fps`;
    const parts = [d.name, rate];
    if (f) parts.push(`${f.width}×${f.height}`);
    const lines = [];
    if (this.endedKey === key) lines.push(["sim-ended", `${d.name} is shut down`, true]);
    if (d.state === "booted" && this.ringError && live) lines.push(["sim-ring", this.ringError, true]);
    const helperLine = d.state === "booted" && (d.platform === "ios" || this.liveTarget()) ? (live ? this.liveError : statusText(this.fast)) : null;
    if (helperLine) lines.push(["sim-helper", helperLine, this.fast.phase === "error" || this.fast.phase === "fallback" || live]);
    if (this.streamFallback.has(key)) lines.push(["sim-stream", "The emulator's stream isn't available; using screencap", false]);
    if (this.inputDropped && !this.inputRoute(d)) lines.push(["sim-input", "input needs the live view", true]);
    if (this.inputUnpainted) lines.push(["sim-input-unpainted", `${this.inputUnpainted} press${this.inputUnpainted === 1 ? "" : "es"} had no position`, true]);
    const shadowed = d.platform === "ios" && this.hub?.key === key && this.hub.shadowed;
    return v_flex().id("sim-footer").flex_none().px(SPACE.PX).pb(SPACE.GAP).gap(2)
      .when(shadowed, (el) => el.child(h_flex().id("sim-hub").gap(6).items_center().flex_wrap()
        .child(div().flex_1().min_w(0).truncate().text_size(TYPE.xs).text_color(t.blocked).role("status")
          .child("Xcode's Device Hub took this simulator's input."))
        .child(button({ id: "sim-repair", kind: this.repairArmed === key ? "danger" : "secondary", disabled: this.repairing,
          label: this.repairing ? "Working…" : this.repairArmed === key ? "Restarts SpringBoard and closes open apps. Click again." : "Repair input",
          onClick: (cx) => this.repair(cx) }, t))))
      .children(lines.map(([id, text, bad]) => div().id(id).truncate().text_size(TYPE.xs)
        .text_color(bad ? t.blocked : metaColor(t)).role("status").child(text)))
      .when(live && !lines.length, (el) => el.child(div().id("sim-live-hint").truncate().text_size(TYPE.xs)
        .text_color(metaColor(t)).child("Click to tap, drag or scroll to swipe, type when focused")))
      .child(mono(div().id("sim-status").truncate().text_size(TYPE.xs).text_color(metaColor(t)).child(parts.join(" · "))));
  }

  body(t) {
    const notes = [this.ios.note, this.android.note].filter(Boolean);
    const lines = notes.map((n, i) => div().id(`sim-tool-note-${i}`).flex_none().px(SPACE.PX).pt(4).truncate()
      .text_size(TYPE.xs).text_color(metaColor(t)).child(n));
    if (!this.discovered) return [emptyState({ id: "sim-loading", icon: UI("smartphone"), title: "Looking for devices…" }, t)];
    if (this.ios.tool === "missing" && this.android.tool === "missing") return [emptyState({ id: "sim-no-tools", icon: UI("smartphone"),
      title: "No simulator tools found", body: "Install Xcode for iOS Simulators or Android platform-tools (adb) for Android." }, t), ...lines];
    if (this.ios.tool !== "ok" && this.android.tool !== "ok") return [emptyState({ id: "sim-waiting-tools", icon: UI("smartphone"),
      title: "Waiting for simctl…" }, t), ...lines];
    const d = this.device();
    const out = [this.deviceList(t), ...lines];
    if (!d) return [...out, emptyState({ id: "sim-no-devices", icon: UI("smartphone"), title: "No simulators or devices",
      body: "Create one in Xcode or Android Studio; it shows up here." }, t)];
    return [...out, this.toolbar(d, t), this.preview(d, t), this.footer(d, t)];
  }

  render(cx) {
    const t = theme();
    const header = panelHeader({ id: "sim-header", title: "Simulator", meta: this.discovered ? this.devices().length : undefined,
      busy: this.discovering || this.powering,
      actions: [{ id: "sim-refresh", icon: UI("refresh"), label: "Refresh devices", onClick: (cx) => {
        this.nextDiscover = 0; this.adbProbeAt = 0;
        this.xcode = null;
        this.streamFallback.clear();
        if (this.fast.phase === "fallback" || this.fast.phase === "error") this.fast = step(this.fast, { type: "reset" });
        if (!this.discovering && this.visible()) this.discover(cx);
      } }] }, t);
    return v_flex().id("drover-sim").size_full().bg(t.background).text_color(t.foreground).text_size(TYPE.sm)
      .when(Boolean(this.focusHandle), (el) => el.track_focus(this.focusHandle).on_key_down((e, cx) => this.typeKey(e, cx)))
      .child(header)
      .children(this.body(t))
      .when(Boolean(this.note), (el) => el.child(div().id("sim-note").flex_none().px(SPACE.PX).pb(6).truncate().text_size(TYPE.xs)
        .text_color(this.note.bad ? t.blocked : metaColor(t)).role("status").child(this.note.text)));
  }
}
