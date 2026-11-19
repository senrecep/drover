# drover-sim

A "Simulator" panel for the drover layout. It shows a live picture of an iOS Simulator or a
running Android emulator, which you can tap, drag, scroll and type into, plus a slower picture of
a physical Android device. It also lists devices and has a few controls. The same view works as a
pane.

## Use

Open it from the panel tabs (System → Simulator) or with `cmd-alt-s`.

The device list shows booted iOS simulators first, then the shut-down ones of the newest iOS
runtime (12 at most). Android shows what `adb devices` reports, then the AVDs that aren't
running. Click a row to show that device. The choice is remembered in this window.

On macOS a booted simulator or a running emulator is drawn live, at up to 30 frames a second
while its screen changes. Click to tap, drag to swipe, and use the wheel or two fingers to
scroll. A press near the bottom edge counts as a swipe from that edge, so the home gesture works.
After a click the picture takes the keyboard (US layout; Command and Control shortcuts stay
Herdr's). Home, App switcher and Lock press those buttons. The first time, the panel builds a
small helper with Xcode's Swift compiler and shows "Building helper" while it does.

A physical Android device, or anything the helper can't stream, gets screenshots at 1 or 2 frames
a second (iOS also offers 4). If the helper can't be built or started, a one-line reason shows
under the picture and iOS falls back to screenshots too. Taps on a physical Android device go
through adb; iOS input needs the live view, and the footer says so when a press can't be sent.
Pause stops taking frames. Frames are taken only while the panel or pane is the one on screen and
the window is active.

Boot and Shut down boot a shut-down iOS simulator or shut down a booted one. Shut down asks for a
second click within 3 seconds. Android emulators can be shut down (`adb emu kill`); physical
devices can't. AVDs are started from Android Studio or a terminal, not from here. Open Simulator
opens Simulator.app. On Android, Home and Back send those keys.

Save copies the current frame to `<app home>/data/drover-sim/shots/`, and Reveal shows the last
saved shot in the file manager.

Xcode 27 can give a simulator's touch input to its Device Hub, after which taps from here do
nothing. The panel checks for that every 30 seconds and then shows Repair input. Its first click
arms it, because the repair restarts the simulator's backboardd and closes open apps; a second
click within 3 seconds runs it.

## Needs

iOS needs macOS with Xcode (`xcrun simctl`). Without it the iOS section is replaced by a one-line
note. The live view also needs Xcode's Swift compiler (`xcrun swiftc`) and a selected developer
folder (`$DEVELOPER_DIR` or `xcode-select -p`); without them iOS uses screenshots.

Android needs `adb` on PATH, or in the Android SDK's `platform-tools` (`$ANDROID_HOME`,
`$ANDROID_SDK_ROOT`, then `~/Library/Android/sdk` on macOS, `~/Android/Sdk` on Linux), or in a
package manager's bin folder (Homebrew on macOS). The AVD list needs the SDK's `emulator` binary.
The live emulator view uses `/usr/bin/curl` and the emulator's own gRPC port.

Per platform:

- macOS: iOS Simulators (needs Xcode) and Android emulators and devices (needs adb).
- Linux: Android only, with adb. iOS shows "iOS simulators need macOS" and no Xcode tool is ever
  run. Frames come from `adb screencap` about once a second; the live emulator view and the
  Simulator button are macOS only. Show in file manager needs `xdg-open` (xdg-utils).
- Windows: Android only, with `adb.exe`, found by `where adb.exe`, on PATH, in
  `%ANDROID_HOME%` or `%ANDROID_SDK_ROOT%`, or in `%LOCALAPPDATA%\Android\Sdk` (Android
  Studio's default). The emulator list needs `emulator\emulator.exe` in the same SDK. Frames
  come from `adb screencap` as on Linux. Show in Explorer uses `explorer.exe /select,<file>`.

The companion mod `drover-sim-screen` must be installed next to this one. It draws nothing and
only holds the frame files.

## How it works

Every command runs as an argument list, never through a shell:

| What | Command |
|---|---|
| iOS devices | `xcrun simctl list devices -j` |
| Xcode check | `xcrun --find simctl`, `printenv DEVELOPER_DIR`, `xcode-select -p` |
| Boot, shut down | `xcrun simctl boot <udid>`, `xcrun simctl shutdown <udid>`, `adb -s <serial> emu kill` |
| Open Simulator (button only) | `open -a Simulator` |
| Helper build | `xcrun --find swiftc`, `xcrun swiftc -O -swift-version 5 -import-objc-header helper/simd.h helper/simd.swift -o <bin>.tmp-<n>`, `<bin>.tmp-<n> --version`, `mv -f` |
| Helper start | `<bin> --daemon --home <app home>/data/drover-sim --developer-dir <dir> --build <hash> --screen-dir <app home>/mods/drover-sim-screen` |
| Device Hub check and repair | `xcrun simctl spawn <udid> notifyutil -g com.apple.coredevice.dtuhidd.active`, then `notifyutil -s ... 0` and `launchctl kickstart -k system/com.apple.backboardd` through the same `simctl spawn` |
| iOS screenshot (fallback) | `xcrun simctl io <udid> screenshot --type=png <tmp>`, `sips -Z 640 -s format jpeg <tmp> --out <slot temp>`, `mv -f` |
| Android devices | `adb devices -l`, `emulator -list-avds`, `adb -s <serial> emu avd name` |
| Android screenshot | `adb -s <serial> shell screencap -p /data/local/tmp/drover-sim.png`, then `adb pull` |
| Android input | `adb -s <serial> shell wm size`, `shell input motionevent DOWN/MOVE/UP <x> <y>`, `shell input swipe <x1> <y1> <x2> <y2> 120`, `shell input keyevent <code>` |
| Emulator frames (helper) | `/usr/bin/curl --http2-prior-knowledge ... streamScreenshot`, with the emulator's gRPC token passed on stdin |
| Frame size check | `file -b <file>` on macOS; on Linux and Windows the PNG header is read directly |
| SDK folder | `printenv ANDROID_HOME`, `printenv ANDROID_SDK_ROOT` (only when adb isn't on PATH); on Windows `where adb.exe` first, then `powershell -NoProfile -NonInteractive -Command [Environment]::GetEnvironmentVariable('<name>')` for ANDROID_HOME, ANDROID_SDK_ROOT and LOCALAPPDATA. Values are never shown |
| adb and emulator probe | `test -x <path>`; on Windows `<adb.exe> version` and `<emulator.exe> -list-avds` |
| Reveal | `open -R <file>` on macOS, `xdg-open <folder>` on Linux, `explorer.exe /select,<file>` on Windows |

### Frames

Herdr caches an image by its path and reloads it about 175 ms after the file changes, but only
for files in another mod's folder. So every open view leases an id such as `panel-0` or `pane-1`
and gets a ring of 12 fixed files in `mods/drover-sim-screen`, named `<view>-<n>.jpg`. All 12 are
drawn stacked, oldest at the bottom. A new frame is written to `.w-<view>-<n>` and renamed onto
its slot; the panel moves that slot to the top 200 ms later, once Herdr has reloaded it, so a
frame is never shown half loaded. The ring never grows: there are 12 files per view, whatever
runs. Version 0.1 frames in `data/drover-sim/frames` are removed once on first mount. Saved shots
(`shots/`, names to the millisecond) are never deleted.

### The helper

`helper/simd.swift` ships as source. The panel hashes it (with `simd.h`) and builds
`<app home>/data/drover-sim/bin/simd-<hash>` on first use, never under `mods/`. Older builds are
removed, and so are temporary builds an interrupted build left behind. `--daemon` starts the
helper in its own session (posix_spawn, no shell) and returns once it wrote
`data/drover-sim/simd.json` (`pid`, `port`, `token`, mode 0600). Only one helper runs, guarded by
a lock on `bin/`, and every view in every window shares it. A helper that can't load the
simulator frameworks (for example when `xcode-select` points at the Command Line Tools) or meets
a CoreSimulator it doesn't know sends the panel to screenshots until Refresh.

The helper listens on 127.0.0.1 only. Every request is a JSON POST with the token in its body
(never in a URL or a log) and the view's own `client` id. The routes are `beat`, `next`, `touch`,
`scroll`, `key`, `button`, `rebind`, `stats`, `ping` and `quit`. Each view sends `beat` once a
second with its device, view id, width and whether it is shown, and keeps one `next` long poll
open. `next` answers as soon as a frame newer than the one the view last drew is in a slot, or
after a short wait with nothing new. The helper writes at most one frame per 33 ms per view, and
never more than 8 frames past the last one the view drew, so a slow view slows its own ring
only. Each helper start has its own epoch, so a restarted helper never gets confused with frames
from the old one. When the device shuts down the helper says so once and the view stops asking.
It exits about five seconds after the last beat, or on the last `quit`.

Touches go to the simulator as HID events with their phase (down, move, up) and, near an edge,
the edge, so system gestures work. Scrolls become a one-finger drag that follows the content.
Mouse moves are sent at most every 16 ms, one request at a time; queued moves merge into the
newest, presses and releases are never dropped, and leaving the picture while pressed releases.

## Credits

The frame ring follows herdr-sim (MIT) and parts of the helper's input follow serve-sim
(Apache-2.0). NOTICE lists every adapted file; LICENSE-APACHE holds the Apache license text.
