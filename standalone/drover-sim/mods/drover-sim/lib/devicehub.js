// Xcode's Device Hub can take a simulator's HID input away from other clients. This finds out
// and builds the repair: clear the flag, then restart backboardd so it starts with the flag off.
//
// Portions adapted from serve-sim 0.1.49 by Evan Bacon (https://github.com/EvanBacon/serve-sim),
// licensed under the Apache License, Version 2.0 (see LICENSE-APACHE): the notify key, the
// shadowed check and the repair order. Modified for drover-sim. Pure: argv lists only.

export const HUB_KEY = "com.apple.coredevice.dtuhidd.active";
export const HUB_PROBE_MS = 30_000;

/** `notifyutil -g <key>` output -> true when the key is published and set to a non-zero value. */
export function isShadowed(out) {
  const m = new RegExp(`^${HUB_KEY.replace(/\./g, "\\.")}\\s+(-?\\d+)\\s*$`, "m").exec(String(out ?? ""));
  return Boolean(m) && Number(m[1]) !== 0;
}

export const probeArgv = (udid) => ["xcrun", ["simctl", "spawn", udid, "notifyutil", "-g", HUB_KEY]];

/** The repair, in this order (adapted from serve-sim repairDeviceHubInput): read the flag again
 *  (stop when it is clear), set it to 0, then restart backboardd, which reads it on start. */
export function repairArgvs(udid) {
  return [
    probeArgv(udid),
    ["xcrun", ["simctl", "spawn", udid, "notifyutil", "-s", HUB_KEY, "0"]],
    ["xcrun", ["simctl", "spawn", udid, "launchctl", "kickstart", "-k", "system/com.apple.backboardd"]],
  ];
}
