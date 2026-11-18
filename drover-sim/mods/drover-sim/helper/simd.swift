// simd: drover-sim's helper. It writes a booted iOS Simulator's (or a running Android emulator's)
// screen as small JPEG frames into a fixed ring of files per view, and sends touches, scrolls,
// keys and hardware buttons to iOS Simulators. See NOTICE.
//
// Portions adapted from serve-sim 0.1.49 by Evan Bacon (https://github.com/EvanBacon/serve-sim),
// licensed under the Apache License, Version 2.0 (see LICENSE-APACHE):
// touch phase mapping (move sent as Down), the IndigoHIDEdge values, scroll-as-drag with
// edge re-anchoring, and the Device Hub input repair sequence. Modified for drover-sim.
//
// The Android frame parse (gRPC ImageFormat request and the Image.image field) follows herdr-sim
// by Robert Soriano (MIT, see NOTICE), rewritten in Swift.
//
//   simd --version
//   simd --daemon --home <dir> --developer-dir <dir> --build <hash> --screen-dir <dir>
//        [--avd-dir <dir>] [--fake-source]
//
// --daemon starts the server as its own session (posix_spawn, no fork after Foundation), waits for
// it to write <home>/simd.json {pid, port, token, ts, version} and exits 0, or with the server's
// own code when it stopped while starting (3: another server runs, 4: the simulator frameworks
// aren't there). The server listens on 127.0.0.1 (a random port) and takes JSON POSTs whose body
// carries the token and the caller's `client` id.
//
// Sources are keyed `ios:<udid>` or `android:<serial>`. A view (`panel-<n>` / `pane-<n>`) beats with
// the device it shows and long-polls /next; each frame of its source goes into the view's own ring
// <screen-dir>/<view>-<0..11>.jpg, written to a hidden temp file and renamed onto the slot. A client
// that beats with a device and no view only sends input. The server exits ~5 s after the last
// request, or when /quit removed the last client. One server at a time: it holds a lock on <home>/bin.
// --fake-source (tests only) makes every ios: source a 60 Hz test pattern with no CoreSimulator;
// input still goes through SimulatorKit's message builders, and the messages are freed unsent.
import Foundation
import IOSurface
import CoreImage
import ImageIO
import Network
import Darwin

let PROTOCOL = 2
let RING = 12
let RELOAD_MS = 200.0
let SLOT_GUARD_MS = RELOAD_MS + 175   // a slot revealed this recently may still be the one on screen
let AHEAD = Int64(RING - 4)           // frames written past the view's last acknowledged one
let MAX_VIEWS = 8
let NEXT_WAIT_MS = 900
let TAKEN_MS = 1500.0
let MAX_WIDTH = 640
let BEAT_TIMEOUT_MS = 5000.0
let FIRST_BEAT_MS = 15000.0
let CLIENT_CAPTURE_MS = 2000.0
let SOURCE_IDLE_MS = 5000.0
let CURL_IDLE_MS = 3000.0
let CURL_FAIL_WINDOW_MS = 10000.0
let ENDED_KEEP_MS = 5000.0
let TRAIL_MS = 200.0
let HISTORY = 60
let BOOTED = 3
let CONN_TIMEOUT_S = 2.0
let MAX_CONNS = 32
let MAX_BODY = 65536
let SCROLL_MARGIN = 0.08
let SCROLL_IDLE_MS = 100
let EXIT_RUNNING: Int32 = 3, EXIT_FRAMEWORKS: Int32 = 4
let UNSUPPORTED = "This Xcode isn't supported"

func nowMs() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e6 }
func fail(_ s: String, _ code: Int32 = 1) -> Never { FileHandle.standardError.write((s + "\n").data(using: .utf8)!); exit(code) }

// ---------- arguments ----------

var opts: [String: String] = [:]
var mode = ""
var fake = false
do {
  var it = CommandLine.arguments.dropFirst().makeIterator()
  while let a = it.next() {
    switch a {
    case "--version", "--daemon", "--serve": mode = a
    case "--home", "--developer-dir", "--build", "--screen-dir", "--avd-dir": opts[a] = it.next() ?? ""
    case "--fake-source": fake = true
    default: fail("simd: unknown argument")
    }
  }
}
if mode == "--version" { print("simd \(PROTOCOL)"); exit(0) }
guard let home = opts["--home"], home.hasPrefix("/"), let devDir = opts["--developer-dir"], devDir.hasPrefix("/"),
      let build = opts["--build"], !build.isEmpty, let screenDir = opts["--screen-dir"], screenDir.hasPrefix("/"),
      mode == "--daemon" || mode == "--serve"
else { fail("usage: simd --daemon --home <dir> --developer-dir <dir> --build <hash> --screen-dir <dir>") }
let avdDir = opts["--avd-dir"] ?? "\(NSHomeDirectory())/Library/Caches/TemporaryItems/avd/running"
if !avdDir.hasPrefix("/") { fail("simd: --avd-dir must be absolute") }

let binDir = "\(home)/bin", tmpDir = "\(home)/tmp", infoPath = "\(home)/simd.json"
let fm = FileManager.default
for d in [binDir, tmpDir] { try? fm.createDirectory(atPath: d, withIntermediateDirectories: true) }

/// An exclusive lock on <home>/bin while a server runs; nil when another server holds it.
func takeLock() -> Int32? {
  let fd = open(binDir, O_RDONLY | O_CLOEXEC)
  if fd < 0 { return nil }
  if flock(fd, LOCK_EX | LOCK_NB) != 0 { close(fd); return nil }
  return fd
}

func readInfoPid() -> Int32? {
  guard let d = fm.contents(atPath: infoPath),
        let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let p = o["pid"] as? Int else { return nil }
  return Int32(p)
}

// ---------- --daemon: start the server in its own session and wait for it ----------

if mode == "--daemon" {
  guard let probe = takeLock() else { fail("simd: already running", EXIT_RUNNING) }
  flock(probe, LOCK_UN); close(probe)
  var size: UInt32 = 0
  _ = _NSGetExecutablePath(nil, &size)
  var buf = [CChar](repeating: 0, count: Int(size) + 1)
  guard _NSGetExecutablePath(&buf, &size) == 0 else { fail("simd: can't find itself") }
  let exe = String(cString: buf)
  var argv = [exe, "--serve", "--home", home, "--developer-dir", devDir, "--build", build, "--screen-dir", screenDir]
  if let a = opts["--avd-dir"] { argv += ["--avd-dir", a] }
  if fake { argv.append("--fake-source") }
  var attr = posix_spawnattr_t(nil as OpaquePointer?)
  posix_spawnattr_init(&attr)
  posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSID | POSIX_SPAWN_CLOEXEC_DEFAULT))
  var acts = posix_spawn_file_actions_t(nil as OpaquePointer?)
  posix_spawn_file_actions_init(&acts)
  posix_spawn_file_actions_addopen(&acts, 0, "/dev/null", O_RDONLY, 0)
  posix_spawn_file_actions_addopen(&acts, 1, "/dev/null", O_WRONLY, 0)
  posix_spawn_file_actions_addopen(&acts, 2, "/dev/null", O_WRONLY, 0)
  var cargs: [UnsafeMutablePointer<CChar>?] = argv.map { strdup($0) } + [nil]
  var pid: pid_t = 0
  let rc = posix_spawn(&pid, exe, &acts, &attr, &cargs, environ)
  cargs.forEach { free($0) }
  posix_spawn_file_actions_destroy(&acts)
  posix_spawnattr_destroy(&attr)
  if rc != 0 { fail("simd: couldn't start (\(rc))") }
  let deadline = nowMs() + 8000
  while nowMs() < deadline {
    var status: Int32 = 0
    if waitpid(pid, &status, WNOHANG) == pid {
      // WIFEXITED / WEXITSTATUS: pass on the server's reason (3, 4) so the panel can tell them apart.
      let code = (status & 0x7f) == 0 ? (status >> 8) & 0xff : 1
      fail("simd: the server stopped while starting", code == EXIT_RUNNING || code == EXIT_FRAMEWORKS ? code : 1)
    }
    if readInfoPid() == pid { print("started"); exit(0) }
    usleep(25_000)
  }
  kill(pid, SIGTERM)
  fail("simd: the server didn't answer")
}

// ---------- --serve ----------

guard let lockFd = takeLock() else { fail("simd: already running", EXIT_RUNNING) }
_ = lockFd
signal(SIGPIPE, SIG_IGN)
let haveCoreSim = dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW) != nil
if !haveCoreSim && !fake { fail("simd: CoreSimulator not found", EXIT_FRAMEWORKS) }
let devURL = URL(fileURLWithPath: devDir)
let skPath = devURL.deletingLastPathComponent().appendingPathComponent("SharedFrameworks/SimulatorKit.framework/SimulatorKit").path
guard let sk = dlopen(skPath, RTLD_NOW) else { fail("simd: SimulatorKit not found", EXIT_FRAMEWORKS) }

typealias MouseFn = @convention(c) (UnsafeMutablePointer<CGPoint>, UnsafeMutablePointer<CGPoint>?, UInt32, UInt, CGSize, UInt) -> UnsafeMutableRawPointer?
typealias KeyFn = @convention(c) (UInt32, UInt32) -> UnsafeMutableRawPointer?
typealias ButtonFn = @convention(c) (UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?
guard let mouseSym = dlsym(sk, "IndigoHIDMessageForMouseNSEvent"), let keySym = dlsym(sk, "IndigoHIDMessageForKeyboardArbitrary"),
      let buttonSym = dlsym(sk, "IndigoHIDMessageForButton") else { fail("simd: SimulatorKit input functions not found", EXIT_FRAMEWORKS) }
let mouseFn = unsafeBitCast(mouseSym, to: MouseFn.self)
let keyFn = unsafeBitCast(keySym, to: KeyFn.self)
let buttonFn = unsafeBitCast(buttonSym, to: ButtonFn.self)

let q = DispatchQueue(label: "simd")
let hidQ = DispatchQueue(label: "simd.hid")
let ciCtx = CIContext(options: [.cacheIntermediates: false])
let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

var token = [UInt8](repeating: 0, count: 16)
arc4random_buf(&token, token.count)
let tokenHex = token.map { String(format: "%02x", $0) }.joined()
let epoch = "\(getpid())-\(Int(Date().timeIntervalSince1970 * 1000))"

let VIEW_RE = try! NSRegularExpression(pattern: "^(pane|panel)-[0-9]{1,3}$")
let TEMP_RE = try! NSRegularExpression(pattern: "^\\.w-(pane|panel)-[0-9]{1,3}-[0-9]{1,2}$")
let IOS_RE = try! NSRegularExpression(pattern: "^ios:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$")
let ANDROID_RE = try! NSRegularExpression(pattern: "^android:[A-Za-z0-9._:-]{1,64}$")
func matches(_ re: NSRegularExpression, _ s: String) -> Bool { re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil }

func screenDirOk() -> Bool {
  var dir: ObjCBool = false
  return fm.fileExists(atPath: screenDir, isDirectory: &dir) && dir.boolValue
}

/// Temp files an earlier server left: its own `.w-` ring temps and request bodies.
func clearTemps() {
  if screenDirOk() {
    for n in (try? fm.contentsOfDirectory(atPath: screenDir)) ?? [] where matches(TEMP_RE, n) { unlink("\(screenDir)/\(n)") }
  }
  for n in (try? fm.contentsOfDirectory(atPath: tmpDir)) ?? [] where n.hasPrefix("simd-") || n.hasPrefix("grpc-shot-") {
    unlink("\(tmpDir)/\(n)")
  }
}

// ---------- state ----------

enum Kind { case ios, android, fake }

final class Scroll {
  var active = false
  var fx = 0.5, fy = 0.5, ax = 0.5, ay = 0.5
  var end: DispatchWorkItem? = nil
}

final class Source {
  let key: String
  let kind: Kind
  let encQ: DispatchQueue
  var wantedAt = nowMs()
  var ended: String? = nil
  var endedAt = 0.0
  var error: String? = nil
  var unsupported = false
  // iOS
  var device: AnyObject? = nil
  var display: AnyObject? = nil
  var surface: IOSurface? = nil
  var hid: AnyObject? = nil
  var callbackId = UUID()
  // fake
  var fakeTimer: DispatchSourceTimer? = nil
  var fakeCount = 0
  // Android
  var curlPid: pid_t = 0
  var curlExit: DispatchSourceProcess? = nil
  var curlRead: DispatchSourceRead? = nil
  var curlKilled = false
  var curlFails: [Double] = []
  var idleSince: Double? = nil
  var stream: String? = nil   // "fallback" once the gRPC stream can't be used
  var png: Data? = nil
  // frames
  var damage: Int64 = 0
  var lastDamageAt = 0.0
  var trailArmed = false
  var encoding = false
  var pumpAt: Double? = nil
  var frames = 0
  // input
  var edge: UInt = 0
  let scroll = Scroll()
  var ops: [(Double, () -> Void)] = []
  var opsBusy = false

  init(_ key: String, _ kind: Kind) {
    self.key = key; self.kind = kind
    encQ = DispatchQueue(label: "simd.enc")
  }
}

final class Waiter {
  let conn: NWConnection
  let after: Int64
  init(_ conn: NWConnection, _ after: Int64) { self.conn = conn; self.after = after }
}

final class View {
  let id: String
  var client: String
  var clientAt: Double
  var device: String? = nil
  var shown = false
  var seenAt: Double
  var width = 400
  var frameMs = 1000.0 / 30
  var ready = false            // a /next arrived for it in this epoch
  var top: Int? = nil
  var nextSlot = 0
  var seq: Int64
  var acked: Int64 = 0
  var due = 0.0
  var gotGen: Int64 = 0
  var slotAt = [Double](repeating: -1e9, count: RING)
  var writes: [Double] = []
  var acks: [Double] = []
  var topRewrites = 0
  var promoted = 0
  var lastRevealSeq: Int64 = 0
  var last: [String: Any]? = nil
  var waiter: Waiter? = nil

  init(_ id: String, _ client: String, _ now: Double, seq: Int64) {
    self.id = id; self.client = client; clientAt = now; seenAt = now; self.seq = seq
  }

  /// The slot on screen as far as the helper knows: the top the view reported with its last /next.
  func onScreen(_ slot: Int) -> Bool { slot == top }
}

struct Client { var at: Double; var device: String? }

var sources: [String: Source] = [:]
var views: [String: View] = [:]
var retiredSeq: [String: Int64] = [:]
var clients: [String: Client] = [:]
var counters: [String: [String: Int]] = [:]
var lastBeat = nowMs()
var beats = 0
var stopping = false

func count(_ client: String, _ name: String) { counters[client, default: [:]][name, default: 0] += 1 }
func push(_ a: inout [Double], _ v: Double) { a.append(v); if a.count > HISTORY { a.removeFirst(a.count - HISTORY) } }

func clientId(_ body: [String: Any]) -> String {
  let id = body["client"] as? String ?? ""
  return id.isEmpty || id.utf8.count > 64 ? "-" : id
}

func deviceKey(_ v: Any?) -> String? {
  guard let s = v as? String, matches(IOS_RE, s) || matches(ANDROID_RE, s) else { return nil }
  return s
}

func viewId(_ v: Any?) -> String? {
  guard let s = v as? String, matches(VIEW_RE, s) else { return nil }
  return s
}

func num(_ v: Any?) -> Double? {
  guard let n = (v as? NSNumber)?.doubleValue, n.isFinite else { return nil }
  return n
}

func clamp01(_ v: Any?) -> Double? { num(v).map { min(1, max(0, $0)) } }

// ---------- sources ----------

func sourceFor(_ key: String) -> Source {
  let now = nowMs()
  if let s = sources[key] {
    if s.ended == nil || now - s.endedAt < ENDED_KEEP_MS { return s }
    teardown(s)   // a device that comes back is a new source
  }
  let kind: Kind = key.hasPrefix("android:") ? .android : fake ? .fake : .ios
  let s = Source(key, kind)
  sources[key] = s
  switch kind {
  case .ios: attach(s)
  case .fake: startFake(s)
  case .android: break
  }
  return s
}

func hasImage(_ s: Source) -> Bool {
  switch s.kind {
  case .ios: return s.surface != nil
  case .fake: return true
  case .android: return s.png != nil
  }
}

func detach(_ s: Source) {
  if let d = s.display { SimdUnregister(d, s.callbackId) }
  s.display = nil; s.surface = nil; s.device = nil; s.hid = nil
}

func attach(_ s: Source) {
  let id = String(s.key.dropFirst(4))
  guard let uuid = UUID(uuidString: id) else { s.error = "Not a simulator id"; return }
  var bad: ObjCBool = false
  guard let dev = SimdLookupDevice(devDir, uuid, &bad) as AnyObject? else {
    if bad.boolValue { s.unsupported = true; s.error = UNSUPPORTED } else { s.error = "Simulator not found" }
    return
  }
  s.device = dev
  retryDisplay(s)
}

/// A device still booting has no display yet: the watchdog tries again each second.
func retryDisplay(_ s: Source) {
  guard let dev = s.device, s.display == nil, !s.unsupported else { return }
  if SimdDeviceState(dev) != BOOTED { s.error = "Simulator isn't booted"; return }
  var bad: ObjCBool = false
  guard let d = SimdMainDisplay(dev, &bad) as AnyObject?, let fb = SimdFramebuffer(d) else {
    if bad.boolValue { s.unsupported = true; s.error = UNSUPPORTED } else { s.error = "Waiting for the simulator's screen" }
    return
  }
  s.callbackId = UUID()
  let ok = SimdRegister(d, s.callbackId, { fb in
    q.async { if let fb { s.surface = fb }; damaged(s) }
  }, { q.async { damaged(s) } })
  guard ok else { s.unsupported = true; s.error = UNSUPPORTED; return }
  s.display = d; s.surface = fb; s.error = nil
  _ = hidClient(s)  // made now, so the first touch isn't slowed by it
  damaged(s)
}

func startFake(_ s: Source) {
  let t = DispatchSource.makeTimerSource(queue: q)
  t.schedule(deadline: .now(), repeating: .microseconds(16_667))
  t.setEventHandler { s.fakeCount += 1; s.damage += 1; s.lastDamageAt = nowMs(); pump(s) }
  t.resume()
  s.fakeTimer = t
}

/// The screen changed. A re-capture follows TRAIL_MS after the last change, so the final frame of
/// an animation is never lost when the change was reported before its pixels landed.
func damaged(_ s: Source) {
  s.damage += 1
  s.lastDamageAt = nowMs()
  if s.kind == .ios { armTrail(s) }
  pump(s)
}

func armTrail(_ s: Source) {
  guard !s.trailArmed else { return }
  s.trailArmed = true
  q.asyncAfter(deadline: .now() + .milliseconds(Int(TRAIL_MS) + 5)) {
    s.trailArmed = false
    guard s.ended == nil, sources[s.key] === s else { return }
    let quiet = nowMs() - s.lastDamageAt
    if quiet >= TRAIL_MS { s.damage += 1; pump(s) } else { armTrail(s) }
  }
}

func endSource(_ s: Source, _ why: String) {
  guard s.ended == nil else { return }
  s.ended = why
  s.endedAt = nowMs()
  stopSource(s)
  for v in views.values where v.device == s.key {
    if let w = v.waiter { v.waiter = nil; respond(w.conn, 200, ["ok": true, "epoch": epoch, "seq": w.after, "ended": true]) }
  }
}

func stopSource(_ s: Source) {
  detach(s)
  s.fakeTimer?.cancel(); s.fakeTimer = nil
  killCurl(s)
  s.scroll.end?.cancel()
}

func teardown(_ s: Source) {
  stopSource(s)
  if sources[s.key] === s { sources.removeValue(forKey: s.key) }
}

// ---------- frames ----------

func activeViews(_ s: Source, _ now: Double) -> [View] {
  views.values.filter { $0.device == s.key && $0.shown && $0.ready && now - $0.seenAt < CLIENT_CAPTURE_MS }
}

func schedulePump(_ s: Source, _ at: Double) {
  if let p = s.pumpAt, p <= at { return }
  s.pumpAt = at
  let wait = max(0, at - nowMs())
  q.asyncAfter(deadline: .now() + .microseconds(Int(wait * 1000) + 500)) {
    if let p = s.pumpAt, p <= nowMs() { s.pumpAt = nil }
    pump(s)
  }
}

enum Snap { case surface(IOSurface), png(Data), fake(Int) }

/// Encodes the source's newest image once, at the widest width its due views want, and writes it
/// into each of their rings. Per view: one frame per FRAME_MS on a due-time schedule, never more
/// than AHEAD frames past its acknowledged one, and never into the slot on screen.
func pump(_ s: Source) {
  guard s.ended == nil, !s.encoding, !stopping, sources[s.key] === s else { return }
  let now = nowMs()
  let active = activeViews(s, now)
  if s.kind == .android, !active.isEmpty { ensureCurl(s, active.map(\.width).max() ?? 400) }
  let want = active.filter { $0.gotGen < s.damage }
  if want.isEmpty { return }
  guard hasImage(s), screenDirOk() else { return }
  var wake = Double.infinity
  var go: [View] = []
  for v in want {
    if v.seq - v.acked >= AHEAD { continue }      // the next /next (its ack) pumps again
    let slot = v.nextSlot
    if v.onScreen(slot) { continue }              // a newer top arrives with the next /next
    let at = max(v.due, v.slotAt[slot] + SLOT_GUARD_MS)
    if now >= at { go.append(v) } else { wake = min(wake, at) }
  }
  if wake.isFinite { schedulePump(s, wake) }
  guard !go.isEmpty else { return }
  let snap: Snap
  switch s.kind {
  case .ios: guard let fb = s.surface else { return }; snap = .surface(fb)
  case .fake: snap = .fake(s.fakeCount)
  case .android: guard let p = s.png else { return }; snap = .png(p)
  }
  let gen = s.damage
  let width = min(MAX_WIDTH, go.map(\.width).max() ?? 400)
  var targets: [(View, Int, Int64)] = []
  for v in go {
    let slot = v.nextSlot
    if v.onScreen(slot) || now - v.slotAt[slot] < SLOT_GUARD_MS { v.topRewrites += 1 }
    targets.append((v, slot, v.seq + 1))
    v.nextSlot = (slot + 1) % RING
    v.due = max(v.due, now - v.frameMs) + v.frameMs
  }
  s.encoding = true
  let jobs = targets.map { ($0.0.id, $0.1) }
  s.encQ.async {
    var done: [Bool] = []
    var size = (0, 0)
    if let img = ciImage(snap), let (data, w, h) = jpeg(img, width) {
      size = (w, h)
      done = jobs.map { writeSlot($0.0, $0.1, data) }
    }
    q.async {
      s.encoding = false
      let at = nowMs()
      for (i, (v, slot, seq)) in targets.enumerated() {
        v.gotGen = max(v.gotGen, gen)
        guard i < done.count, done[i], views[v.id] === v else { continue }
        v.seq = seq
        v.slotAt[slot] = at
        push(&v.writes, at)
        v.last = ["ok": true, "epoch": epoch, "seq": seq, "slot": slot, "at": Int(at), "w": size.0, "h": size.1, "device": s.key]
        if let w = v.waiter, seq > w.after { v.waiter = nil; respond(w.conn, 200, v.last!) }
      }
      if !done.isEmpty { s.frames += 1 }
      pump(s)
    }
  }
}

func ciImage(_ snap: Snap) -> CIImage? {
  switch snap {
  case .surface(let fb):
    guard fb.width > 0, fb.height > 0 else { return nil }
    return CIImage(ioSurface: fb)
  case .png(let d):
    guard let src = CGImageSourceCreateWithData(d as CFData, nil), let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
    return CIImage(cgImage: cg)
  case .fake(let n):
    let w = 390.0, h = 844.0
    let base = CIImage(color: CIColor(red: CGFloat(n % 60) / 60, green: 0.3, blue: 0.5)).cropped(to: CGRect(x: 0, y: 0, width: w, height: h))
    let mark = CIImage(color: CIColor(red: 1, green: 1, blue: 1)).cropped(to: CGRect(x: Double((n * 7) % 350), y: 400, width: 40, height: 40))
    return mark.composited(over: base)
  }
}

func jpeg(_ img: CIImage, _ width: Int) -> (Data, Int, Int)? {
  let e = img.extent
  guard e.width > 0, e.height > 0 else { return nil }
  let scale = min(1.0, Double(width) / Double(e.width))
  let scaled = img.transformed(by: CGAffineTransform(translationX: -e.origin.x, y: -e.origin.y).scaledBy(x: scale, y: scale))
  let w = Int((Double(e.width) * scale).rounded()), h = Int((Double(e.height) * scale).rounded())
  let o = [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.7]
  guard let data = ciCtx.jpegRepresentation(of: scaled, colorSpace: srgb, options: o) else { return nil }
  return (data, w, h)
}

/// Writes a hidden temp file in the screen folder, then renames it onto the slot.
func writeSlot(_ view: String, _ slot: Int, _ data: Data) -> Bool {
  let tmp = "\(screenDir)/.w-\(view)-\(slot)", dst = "\(screenDir)/\(view)-\(slot).jpg"
  let fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0o644)
  guard fd >= 0 else { return false }
  let ok = data.withUnsafeBytes { p in write(fd, p.baseAddress, p.count) == p.count }
  close(fd)
  guard ok, rename(tmp, dst) == 0 else { unlink(tmp); return false }
  return true
}

// ---------- Android: the emulator's gRPC screenshot stream through /usr/bin/curl ----------

func varint(_ v: Int) -> [UInt8] {
  var out: [UInt8] = [], x = UInt64(max(0, v))
  repeat { var b = UInt8(x & 0x7f); x >>= 7; if x != 0 { b |= 0x80 }; out.append(b) } while x != 0
  return out
}

/// The gRPC request: a 5-byte prefix and ImageFormat{format: PNG, width: w, height: 4w}.
/// Both sizes must be set or the emulator ignores them (herdr-sim, MIT).
func grpcShotBody(_ w: Int) -> [UInt8] {
  let msg: [UInt8] = [0x08, 0x00, 0x18] + varint(w) + [0x20] + varint(4 * w)
  let n = UInt32(msg.count)
  return [0, UInt8(n >> 24), UInt8((n >> 16) & 0xff), UInt8((n >> 8) & 0xff), UInt8(n & 0xff)] + msg
}

/// Field 4 (the image bytes) of an emulator `Image` message, or nil.
func imageField(_ b: [UInt8]) -> [UInt8]? {
  var i = 0
  func read() -> UInt64? {
    var v: UInt64 = 0, shift: UInt64 = 0
    while i < b.count, shift < 64 {
      let c = b[i]; i += 1
      v |= UInt64(c & 0x7f) << shift
      if c & 0x80 == 0 { return v }
      shift += 7
    }
    return nil
  }
  while i < b.count {
    guard let tag = read() else { return nil }
    let field = tag >> 3
    switch tag & 7 {
    case 0: guard read() != nil else { return nil }
    case 1: i += 8
    case 5: i += 4
    case 2:
      guard let n = read(), n <= UInt64(b.count - i) else { return nil }
      let start = i; i += Int(n)
      if field == 4 { return Array(b[start..<i]) }
    default: return nil
    }
  }
  return nil
}

/// The emulator's gRPC port and token, from the running-AVD file whose console port matches.
/// The token stays in memory: it is only ever written to curl's stdin.
func findGrpc(_ consolePort: Int) -> (Int, String?)? {
  for n in (try? fm.contentsOfDirectory(atPath: avdDir)) ?? [] where n.hasSuffix(".ini") {
    guard let text = try? String(contentsOfFile: "\(avdDir)/\(n)", encoding: .utf8) else { continue }
    var kv: [String: String] = [:]
    for line in text.split(whereSeparator: \.isNewline) {
      let p = line.split(separator: "=", maxSplits: 1)
      if p.count == 2 { kv[p[0].trimmingCharacters(in: .whitespaces)] = p[1].trimmingCharacters(in: .whitespaces) }
    }
    guard kv["port.serial"] == String(consolePort), let port = Int(kv["grpc.port"] ?? ""), port > 0, port < 65536 else { continue }
    let tok = kv["grpc.token"].flatMap { $0.isEmpty ? nil : $0 }
    return (port, tok)
  }
  return nil
}

func consolePort(_ key: String) -> Int? {
  let serial = key.dropFirst("android:".count)
  guard serial.hasPrefix("emulator-") else { return nil }
  return Int(serial.dropFirst("emulator-".count))
}

func ensureCurl(_ s: Source, _ width: Int) {
  guard s.kind == .android, s.curlPid == 0, s.stream == nil, s.ended == nil else { return }
  guard let cp = consolePort(s.key), let (port, tok) = findGrpc(cp) else { s.stream = "fallback"; return }
  let w = max(64, min(MAX_WIDTH, width))
  let bin = "\(tmpDir)/grpc-shot-\(w).bin"
  if !fm.fileExists(atPath: bin) {
    let body = Data(grpcShotBody(w))
    guard fm.createFile(atPath: bin, contents: body, attributes: [.posixPermissions: 0o600]) else { s.stream = "fallback"; return }
  }
  var argv = ["/usr/bin/curl", "-q", "-sS", "--no-buffer", "--noproxy", "*", "--connect-timeout", "2", "--http2-prior-knowledge",
              "-X", "POST", "-H", "content-type: application/grpc", "-H", "te: trailers", "--data-binary", "@\(bin)"]
  if tok != nil { argv += ["-K", "-"] }
  argv.append("http://127.0.0.1:\(port)/android.emulation.control.EmulatorController/streamScreenshot")
  var inP: [Int32] = [-1, -1], outP: [Int32] = [-1, -1]
  guard pipe(&outP) == 0 else { s.stream = "fallback"; return }
  if tok != nil, pipe(&inP) != 0 { close(outP[0]); close(outP[1]); s.stream = "fallback"; return }
  var attr = posix_spawnattr_t(nil as OpaquePointer?)
  posix_spawnattr_init(&attr)
  posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT))
  var acts = posix_spawn_file_actions_t(nil as OpaquePointer?)
  posix_spawn_file_actions_init(&acts)
  if tok != nil { posix_spawn_file_actions_adddup2(&acts, inP[0], 0) } else { posix_spawn_file_actions_addopen(&acts, 0, "/dev/null", O_RDONLY, 0) }
  posix_spawn_file_actions_adddup2(&acts, outP[1], 1)
  posix_spawn_file_actions_addopen(&acts, 2, "/dev/null", O_WRONLY, 0)
  var cargs: [UnsafeMutablePointer<CChar>?] = argv.map { strdup($0) } + [nil]
  var pid: pid_t = 0
  let rc = posix_spawn(&pid, argv[0], &acts, &attr, &cargs, environ)
  cargs.forEach { free($0) }
  posix_spawn_file_actions_destroy(&acts)
  posix_spawnattr_destroy(&attr)
  close(outP[1])
  if tok != nil { close(inP[0]) }
  guard rc == 0 else { close(outP[0]); if tok != nil { close(inP[1]) }; s.stream = "fallback"; return }
  if let t = tok {
    let line = Array("header = \"authorization: Bearer \(t)\"\n".utf8)
    _ = line.withUnsafeBytes { write(inP[1], $0.baseAddress, $0.count) }
    close(inP[1])
  }
  s.curlPid = pid
  s.curlKilled = false
  let fd = outP[0]
  let rq = DispatchQueue(label: "simd.curl")
  var buf: [UInt8] = []
  var chunk = [UInt8](repeating: 0, count: 65536)
  let rs = DispatchSource.makeReadSource(fileDescriptor: fd, queue: rq)
  rs.setEventHandler {
    let n = read(fd, &chunk, chunk.count)
    if n <= 0 { rs.cancel(); return }
    buf.append(contentsOf: chunk[0..<n])
    while buf.count >= 5 {
      let len = Int(buf[1]) << 24 | Int(buf[2]) << 16 | Int(buf[3]) << 8 | Int(buf[4])
      if len > 64 << 20 { rs.cancel(); kill(pid, SIGTERM); return }
      guard buf.count >= 5 + len else { break }
      let msg = Array(buf[5..<(5 + len)])
      buf.removeFirst(5 + len)
      // An inactive display sends empty images: skip them.
      if let img = imageField(msg), !img.isEmpty {
        let d = Data(img)
        q.async { guard s.ended == nil else { return }; s.png = d; damaged(s) }
      }
    }
  }
  rs.setCancelHandler { close(fd) }
  rs.resume()
  s.curlRead = rs
  let ex = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: q)
  ex.setEventHandler {
    var st: Int32 = 0
    waitpid(pid, &st, 0)
    ex.cancel()
    s.curlExit = nil
    if s.curlPid == pid { s.curlPid = 0 }
    if s.curlKilled { s.curlKilled = false; return }
    let code = (st & 0x7f) == 0 ? (st >> 8) & 0xff : 1
    let now = nowMs()
    if code == 0 { endSource(s, "closed"); return }
    s.curlFails = s.curlFails.filter { now - $0 < CURL_FAIL_WINDOW_MS } + [now]
    if s.curlFails.count >= 2 { s.stream = "fallback" } else { pump(s) }
  }
  ex.resume()
  s.curlExit = ex
}

func killCurl(_ s: Source) {
  guard s.curlPid != 0 else { return }
  s.curlKilled = true
  kill(s.curlPid, SIGTERM)
  s.curlPid = 0
}

// ---------- input ----------

func hidClient(_ s: Source) -> AnyObject? {
  if let h = s.hid { return h }
  switch s.kind {
  case .fake: s.hid = NSObject()
  case .ios:
    guard let dev = s.device, s.display != nil else { return nil }
    s.hid = SimdMakeHIDClient(dev) as AnyObject?
  case .android: return nil
  }
  return s.hid
}

/// Sends messages one after another (each waits for the last to be taken). A fake source frees
/// them unsent.
func sendAll(_ msgs: [UnsafeMutableRawPointer], _ h: AnyObject, _ s: Source) {
  if s.kind == .fake { msgs.forEach { free($0) }; return }
  guard let first = msgs.first else { return }
  let rest = Array(msgs.dropFirst())
  SimdSend(h, first, hidQ) { sendAll(rest, h, s) }
}

/// Touches and scroll steps run in order per source; a step can hold the next one back a little.
func enqueue(_ s: Source, wait: Double, _ op: @escaping () -> Void) {
  s.ops.append((wait, op))
  runOps(s)
}

func runOps(_ s: Source) {
  while !s.opsBusy, !s.ops.isEmpty {
    let (wait, op) = s.ops.removeFirst()
    op()
    if wait > 0 {
      s.opsBusy = true
      q.asyncAfter(deadline: .now() + .microseconds(Int(wait * 1000))) { s.opsBusy = false; runOps(s) }
    }
  }
}

/// One digitizer message. Type 1 is a finger down (also used for moves), type 2 a lift.
@discardableResult
func sendTouch(_ s: Source, _ h: AnyObject, _ type: UInt, _ x: Double, _ y: Double, _ edge: UInt, _ cid: String, wait: Double = 0) -> Bool {
  var p = CGPoint(x: x, y: y)
  guard let m = mouseFn(&p, nil, 0x32, type, CGSize(width: 1, height: 1), edge) else { count(cid, "nilMsg"); return false }
  enqueue(s, wait: wait) { sendAll([m], h, s) }
  return true
}

/// The source an input request is for: its `device`, else its view's, else its client's.
func inputSource(_ body: [String: Any]) -> Source? {
  var key = deviceKey(body["device"])
  if key == nil, let vid = viewId(body["view"]) { key = views[vid]?.device }
  if key == nil { key = clients[clientId(body)]?.device }
  guard let k = key, let s = sources[k], s.ended == nil else { return nil }
  s.wantedAt = nowMs()
  return s
}

func touch(_ body: [String: Any]) -> String? {
  let cid = clientId(body)
  // adapted from serve-sim HIDInjector.touchMessage: the C function rejects Dragged (6), so a move
  // is sent as Down (1) and only the lift is Up (2).
  let type: UInt
  switch body["phase"] as? String {
  case "down", "move": type = 1
  case "up": type = 2
  default: return "Bad phase"
  }
  guard let x = clamp01(body["x"]), let y = clamp01(body["y"]) else { return "Bad point" }
  guard let s = inputSource(body), let h = hidClient(s) else { count(cid, "noDevice"); return "No simulator screen" }
  if body["phase"] as? String == "down" {
    // adapted from serve-sim IndigoHIDEdge: 3 is the bottom edge (home indicator swipes).
    let e = (body["edge"] as? NSNumber)?.intValue ?? 0
    s.edge = (0...4).contains(e) ? UInt(e) : 0
  }
  guard sendTouch(s, h, type, x, y, s.edge, cid) else { return "No touch message" }
  if type == 2 { s.edge = 0 }
  count(cid, "touch")
  return nil
}

func scrollClamp(_ v: Double) -> Double { min(max(v, SCROLL_MARGIN), 1 - SCROLL_MARGIN) }

/// A wheel or trackpad scroll as a one-finger drag. `dx`/`dy` are the scroll amount as a fraction
/// of the screen, in the web's wheel sign (positive scrolls down); the finger moves by -dx/-dy.
func scroll(_ body: [String: Any]) -> String? {
  let cid = clientId(body)
  guard let dx = num(body["dx"]), let dy = num(body["dy"]), dx != 0 || dy != 0 else { return "Bad scroll" }
  guard let s = inputSource(body), let h = hidClient(s) else { count(cid, "noDevice"); return "No simulator screen" }
  // adapted from serve-sim HIDInjector.sendScroll: begin under the pointer, wait 8 ms, move the
  // finger by the step, lift and re-anchor near an edge, and lift 100 ms after the last event.
  let st = s.scroll
  let stepX = -dx, stepY = -dy
  if !st.active {
    st.ax = scrollClamp(clamp01(body["x"]) ?? 0.5); st.ay = scrollClamp(clamp01(body["y"]) ?? 0.5)
    st.fx = st.ax; st.fy = st.ay
    guard sendTouch(s, h, 1, st.fx, st.fy, 0, cid, wait: 8) else { return "No touch message" }
    st.active = true
  }
  var nx = st.fx + stepX, ny = st.fy + stepY
  if nx <= SCROLL_MARGIN || nx >= 1 - SCROLL_MARGIN || ny <= SCROLL_MARGIN || ny >= 1 - SCROLL_MARGIN {
    sendTouch(s, h, 2, st.fx, st.fy, 0, cid)
    st.fx = st.ax; st.fy = st.ay
    sendTouch(s, h, 1, st.fx, st.fy, 0, cid, wait: 8)
    nx = st.fx + stepX; ny = st.fy + stepY
  }
  st.fx = scrollClamp(nx); st.fy = scrollClamp(ny)
  sendTouch(s, h, 1, st.fx, st.fy, 0, cid)
  st.end?.cancel()
  let work = DispatchWorkItem {
    guard st.active else { return }
    st.active = false
    sendTouch(s, h, 2, st.fx, st.fy, 0, cid)
  }
  st.end = work
  q.asyncAfter(deadline: .now() + .milliseconds(SCROLL_IDLE_MS), execute: work)
  count(cid, "scroll")
  return nil
}

func key(_ body: [String: Any]) -> String? {
  let cid = clientId(body)
  guard let usage = (body["usage"] as? NSNumber)?.uint32Value, usage > 0, usage < 0x100 else { return "Bad key" }
  guard let s = inputSource(body), let h = hidClient(s) else { count(cid, "noDevice"); return "No simulator screen" }
  let mods = ((body["mods"] as? [NSNumber]) ?? []).map { $0.uint32Value }.filter { $0 >= 0xE0 && $0 <= 0xE7 }
  var msgs: [UnsafeMutableRawPointer] = []
  for m in mods { if let x = keyFn(m, 1) { msgs.append(x) } }
  if let d = keyFn(usage, 1) { msgs.append(d) }
  if let u = keyFn(usage, 2) { msgs.append(u) }
  for m in mods.reversed() { if let x = keyFn(m, 2) { msgs.append(x) } }
  if msgs.isEmpty { count(cid, "nilMsg"); return "No key message" }
  enqueue(s, wait: 0) { sendAll(msgs, h, s) }
  count(cid, "key")
  return nil
}

let BUTTONS: [String: UInt32] = ["home": 0x0, "lock": 0x1]

func press(_ src: UInt32, _ h: AnyObject, _ s: Source, after: Double) {
  q.asyncAfter(deadline: .now() + after) {
    if let d = buttonFn(src, 1, 0x33) { sendAll([d], h, s) }
    q.asyncAfter(deadline: .now() + 0.06) { if let u = buttonFn(src, 2, 0x33) { sendAll([u], h, s) } }
  }
}

func button(_ body: [String: Any]) -> String? {
  let cid = clientId(body)
  let name = body["name"] as? String ?? ""
  guard name == "switcher" || BUTTONS[name] != nil else { return "Bad button" }
  guard let s = inputSource(body), let h = hidClient(s) else { count(cid, "noDevice"); return "No simulator screen" }
  if name == "switcher" { press(0x0, h, s, after: 0); press(0x0, h, s, after: 0.18) } else { press(BUTTONS[name]!, h, s, after: 0) }
  count(cid, "button")
  return nil
}

/// Drops and re-creates a simulator's HID client (after the Device Hub repair restarted backboardd).
func rebind(_ body: [String: Any]) -> String? {
  var key = deviceKey(body["device"])
  if key == nil, let u = body["udid"] as? String { key = deviceKey("ios:\(u)") }
  guard let k = key, let s = sources[k], s.ended == nil else { return "No simulator screen" }
  s.hid = nil
  return hidClient(s) == nil ? "No simulator screen" : nil
}

// ---------- lifetime ----------

func shutdown() -> Never {
  stopping = true
  for s in Array(sources.values) { teardown(s) }
  clearTemps()
  if readInfoPid() == getpid() { try? fm.removeItem(atPath: infoPath) }
  exit(0)
}

var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT, SIGHUP] {
  signal(sig, SIG_IGN)
  let src = DispatchSource.makeSignalSource(signal: sig, queue: q)
  src.setEventHandler { shutdown() }
  src.resume()
  signalSources.append(src)
}

func dropView(_ v: View) {
  if let w = v.waiter { v.waiter = nil; respond(w.conn, 200, ["ok": true, "epoch": epoch, "seq": w.after]) }
  retiredSeq[v.id] = v.seq
  views.removeValue(forKey: v.id)
}

let watchdog = DispatchSource.makeTimerSource(queue: q)
watchdog.schedule(deadline: .now() + 1, repeating: 1)
watchdog.setEventHandler {
  let now = nowMs()
  if now - lastBeat > (beats == 0 ? FIRST_BEAT_MS : BEAT_TIMEOUT_MS) { shutdown() }
  clients = clients.filter { now - $0.value.at <= BEAT_TIMEOUT_MS }
  for v in Array(views.values) where now - v.seenAt > BEAT_TIMEOUT_MS { dropView(v) }
  for s in Array(sources.values) {
    if now - s.wantedAt > SOURCE_IDLE_MS { teardown(s); continue }
    if s.ended != nil { continue }
    if s.kind == .ios {
      // Its simulator shut down: only this source ends.
      if let dev = s.device, s.display != nil, SimdDeviceState(dev) != BOOTED { endSource(s, "shutdown"); continue }
      if s.display == nil, s.device != nil { retryDisplay(s) }
    }
    if s.kind == .android, s.curlPid != 0 {
      if activeViews(s, now).isEmpty {
        if let t = s.idleSince { if now - t > CURL_IDLE_MS { killCurl(s); s.idleSince = nil } } else { s.idleSince = now }
      } else { s.idleSince = nil }
    }
    pump(s)
  }
}
watchdog.resume()

// ---------- control: HTTP on 127.0.0.1 ----------

/// The view a request names, held by one client. Another client may take it over only once the
/// holder has been silent for TAKEN_MS (a reloaded copy); a second live holder is refused.
func claimView(_ id: String, _ cid: String, _ now: Double) -> (View?, String?) {
  if let v = views[id] {
    if v.client != cid {
      if now - v.clientAt < TAKEN_MS { return (nil, "view-taken") }
      if let w = v.waiter { v.waiter = nil; respond(w.conn, 200, ["ok": true, "epoch": epoch, "seq": w.after]) }
      v.client = cid
      v.ready = false
    }
    v.clientAt = now
    return (v, nil)
  }
  if views.count >= MAX_VIEWS { return (nil, "too-many-views") }
  let v = View(id, cid, now, seq: retiredSeq[id] ?? 0)
  views[id] = v
  return (v, nil)
}

func beat(_ body: [String: Any]) -> [String: Any] {
  beats += 1
  let now = nowMs()
  lastBeat = now
  let cid = clientId(body)
  let dev = deviceKey(body["device"])
  clients[cid] = Client(at: now, device: dev)
  var out: [String: Any] = ["ok": true, "version": build, "epoch": epoch]
  let src = dev.map { sourceFor($0) }
  src?.wantedAt = now
  if let vid = viewId(body["view"]) {
    let (v, err) = claimView(vid, cid, now)
    if let v {
      if v.device != dev { v.device = dev; v.gotGen = 0 }
      let shown = (body["shown"] as? Bool) ?? false
      if shown && !v.shown { v.gotGen = 0 }
      v.shown = shown
      v.seenAt = now
      if let w = (body["width"] as? NSNumber)?.intValue { v.width = min(MAX_WIDTH, max(64, w)) }
      if let f = num(body["fps"]) { v.frameMs = 1000.0 / min(30, max(1, f)) }
      if let p = (body["promoted"] as? NSNumber)?.intValue, p >= 0 { v.promoted = p }
      if let r = (body["lastRevealSeq"] as? NSNumber)?.int64Value, r >= 0 { v.lastRevealSeq = r }
    } else if let err { out["view"] = err }
  }
  if let s = src {
    out["device"] = s.key
    out["attached"] = hasImage(s)
    if let e = s.error, !hasImage(s) { out["error"] = e }
    if s.unsupported { out["unsupported"] = true; out["error"] = UNSUPPORTED }
    if let e = s.ended { out["ended"] = e }
    if let st = s.stream { out["stream"] = st }
    pump(s)
  }
  return out
}

func inputSeen(_ body: [String: Any]) {
  let now = nowMs()
  lastBeat = now
  let id = clientId(body)
  if var c = clients[id] { c.at = now; clients[id] = c }
}

func stats() -> [String: Any] {
  var vs: [String: Any] = [:]
  for v in views.values {
    vs[v.id] = ["device": v.device ?? "", "seq": v.seq, "acked": v.acked, "writes": v.writes.map { Int($0) },
                "acks": v.acks.map { Int($0) }, "topRewrites": v.topRewrites, "promoted": v.promoted,
                "lastRevealSeq": v.lastRevealSeq, "shown": v.shown]
  }
  var ss: [String: Any] = [:]
  for s in sources.values {
    var o: [String: Any] = ["frames": s.frames, "attached": hasImage(s), "views": activeViews(s, nowMs()).count]
    if let e = s.ended { o["ended"] = e }
    if let st = s.stream { o["stream"] = st }
    if s.curlPid != 0 { o["streaming"] = true }
    ss[s.key] = o
  }
  return ["ok": true, "epoch": epoch, "now": Int(nowMs()), "views": vs, "sources": ss, "input": counters]
}

/// The long poll: answers with the view's newest frame past `after` as soon as there is one, or
/// with `{seq: after}` after NEXT_WAIT_MS. One parked request per view.
func next(_ body: [String: Any], _ conn: NWConnection) {
  let now = nowMs()
  beats += 1
  lastBeat = now
  let cid = clientId(body)
  guard screenDirOk() else { respond(conn, 409, ["ok": false, "error": "screen-mod-missing"]); return }
  guard let vid = viewId(body["view"]) else { respond(conn, 400, ["ok": false, "error": "Bad view"]); return }
  let (got, err) = claimView(vid, cid, now)
  guard let v = got else { respond(conn, 409, ["ok": false, "error": err ?? "view-taken"]); return }
  let sameEpoch = (body["epoch"] as? String) == epoch
  let after = sameEpoch ? max(0, (body["after"] as? NSNumber)?.int64Value ?? 0) : 0
  var top: Int? = nil
  if let t = (body["top"] as? NSNumber)?.intValue, t >= 0, t < RING { top = t }
  if !v.ready {
    // The first write for a view new to this epoch goes past whatever it shows now.
    v.ready = true
    v.nextSlot = top.map { ($0 + 1) % RING } ?? 0
    v.gotGen = 0
  }
  if after > v.acked { v.acked = min(after, v.seq); push(&v.acks, now) }
  v.top = top
  v.seenAt = now
  if let w = v.waiter { v.waiter = nil; respond(w.conn, 200, ["ok": true, "epoch": epoch, "seq": w.after]) }
  let src = v.device.flatMap { sources[$0] }
  src?.wantedAt = now
  if src?.ended != nil { respond(conn, 200, ["ok": true, "epoch": epoch, "seq": after, "ended": true]); return }
  if v.seq > after, let last = v.last { respond(conn, 200, last); if let s = src { pump(s) }; return }
  let w = Waiter(conn, after)
  v.waiter = w
  q.asyncAfter(deadline: .now() + .milliseconds(NEXT_WAIT_MS)) {
    if v.waiter === w { v.waiter = nil; respond(w.conn, 200, ["ok": true, "epoch": epoch, "seq": w.after]) }
  }
  if let s = src { pump(s) }
}

func route(_ path: String, _ body: [String: Any], _ conn: NWConnection) {
  guard let t = body["token"] as? String, t.utf8.count == tokenHex.utf8.count,
        zip(t.utf8, tokenHex.utf8).reduce(0, { $0 | ($1.0 ^ $1.1) }) == 0 else { respond(conn, 403, ["ok": false, "error": "Forbidden"]); return }
  if path == "/next" { next(body, conn); return }
  let (s, o) = handle(path, body)
  respond(conn, s, o)
}

func handle(_ path: String, _ body: [String: Any]) -> (Int, [String: Any]) {
  switch path {
  case "/ping": return (200, ["ok": true, "version": build, "pid": Int(getpid()), "protocol": PROTOCOL, "epoch": epoch, "input": counters])
  case "/beat": return (200, beat(body))
  case "/stats": return (200, stats())
  case "/touch", "/scroll", "/key", "/button", "/rebind":
    inputSeen(body)
    let err: String?
    switch path {
    case "/touch": err = touch(body)
    case "/scroll": err = scroll(body)
    case "/key": err = key(body)
    case "/button": err = button(body)
    default: err = rebind(body)
    }
    return err == nil ? (200, ["ok": true]) : (400, ["ok": false, "error": err!])
  case "/fake-end":
    guard fake, let k = deviceKey(body["device"]), let s = sources[k] else { return (404, ["ok": false, "error": "Not found"]) }
    endSource(s, "shutdown")
    return (200, ["ok": true])
  case "/quit":
    // Only the asking client leaves (with its views); the server goes with the last one, or when
    // told to `force`.
    let cid = clientId(body)
    clients.removeValue(forKey: cid)
    for v in Array(views.values) where v.client == cid { dropView(v) }
    let force = (body["force"] as? Bool) ?? false
    if force || clients.isEmpty {
      q.asyncAfter(deadline: .now() + 0.05) { shutdown() }
      return (200, ["ok": true, "quitting": true])
    }
    return (200, ["ok": true, "quitting": false, "clients": clients.count])
  default: return (404, ["ok": false, "error": "Not found"])
  }
}

func respond(_ conn: NWConnection, _ status: Int, _ obj: [String: Any]) {
  let body = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
  let reason = status == 200 ? "OK" : status == 403 ? "Forbidden" : status == 404 ? "Not Found" : status == 409 ? "Conflict" : "Bad Request"
  var out = Data("HTTP/1.1 \(status) \(reason)\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8)
  out.append(body)
  conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
}

let HEADER_END = Data("\r\n\r\n".utf8)

func readRequest(_ conn: NWConnection, _ buf: Data) {
  conn.receive(minimumIncompleteLength: 1, maximumLength: MAX_BODY) { chunk, _, done, err in
    var data = buf
    if let chunk { data.append(chunk) }
    if err != nil || data.count > MAX_BODY + 8192 { conn.cancel(); return }
    guard let end = data.range(of: HEADER_END) else {
      if done || data.count > 8192 { conn.cancel() } else { readRequest(conn, data) }
      return
    }
    let head = String(decoding: data[..<end.lowerBound], as: UTF8.self)
    let lines = head.components(separatedBy: "\r\n")
    let parts = lines.first?.split(separator: " ") ?? []
    var length: Int? = 0
    for l in lines.dropFirst() {
      let kv = l.split(separator: ":", maxSplits: 1)
      if kv.count == 2, kv[0].trimmingCharacters(in: .whitespaces).lowercased() == "content-length" {
        length = Int(kv[1].trimmingCharacters(in: .whitespaces))
      }
    }
    guard let length, length >= 0, length <= MAX_BODY else {
      q.async { respond(conn, 400, ["ok": false, "error": "Bad length"]) }
      return
    }
    let bodyStart = end.upperBound
    if data.count - bodyStart < length {
      if done { conn.cancel() } else { readRequest(conn, data) }
      return
    }
    guard parts.count >= 2, parts[0] == "POST" else { q.async { respond(conn, 404, ["ok": false]) }; return }
    let path = String(parts[1])
    let body = (try? JSONSerialization.jsonObject(with: data[bodyStart..<(bodyStart + length)])) as? [String: Any] ?? [:]
    q.async { route(path, body, conn) }
  }
}

let params = NWParameters.tcp
params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
guard let listener = try? NWListener(using: params) else { fail("simd: can't listen") }
var openConns = 0
listener.newConnectionHandler = { conn in
  // Few at a time, and none lingers: a silent or half-sent request is cut after CONN_TIMEOUT_S.
  if openConns >= MAX_CONNS { conn.cancel(); return }
  openConns += 1
  var counted = true
  conn.stateUpdateHandler = { st in
    switch st {
    case .failed: conn.cancel()
    case .cancelled: if counted { counted = false; openConns -= 1 }
    default: break
    }
  }
  conn.start(queue: q)
  q.asyncAfter(deadline: .now() + CONN_TIMEOUT_S) { conn.cancel() }
  readRequest(conn, Data())
}
listener.stateUpdateHandler = { st in
  switch st {
  case .ready:
    guard let port = listener.port?.rawValue else { shutdown() }
    clearTemps()
    let info: [String: Any] = ["pid": Int(getpid()), "port": Int(port), "token": tokenHex,
                               "ts": Int(Date().timeIntervalSince1970 * 1000), "version": build]
    let tmp = "\(tmpDir)/simd-info-\(getpid()).json"
    guard let d = try? JSONSerialization.data(withJSONObject: info),
          fm.createFile(atPath: tmp, contents: d, attributes: [.posixPermissions: 0o600]),
          rename(tmp, infoPath) == 0 else { shutdown() }
  case .failed: shutdown()
  default: break
  }
}
listener.start(queue: q)
dispatchMain()
