// GPUI key events -> USB HID keyboard usages (US layout) for the simulator. Pure.
// Chords with Command or Control are left alone, so Herdr's own shortcuts keep working.

export const MOD_SHIFT = 0xe1;
export const MOD_ALT = 0xe2;

const NAMED = {
  enter: 0x28, escape: 0x29, backspace: 0x2a, tab: 0x2b, space: 0x2c,
  "-": 0x2d, "=": 0x2e, "[": 0x2f, "]": 0x30, "\\": 0x31, ";": 0x33, "'": 0x34, "`": 0x35,
  ",": 0x36, ".": 0x37, "/": 0x38,
  home: 0x4a, pageup: 0x4b, delete: 0x4c, end: 0x4d, pagedown: 0x4e,
  right: 0x4f, left: 0x50, down: 0x51, up: 0x52,
};

// Characters typed with Shift on a US keyboard, as the unshifted key.
const SHIFTED = {
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  _: "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "~": "`", "<": ",", ">": ".", "?": "/",
};

function baseUsage(key) {
  if (/^[a-z]$/.test(key)) return 0x04 + key.charCodeAt(0) - 97;
  if (/^[1-9]$/.test(key)) return 0x1e + Number(key) - 1;
  if (key === "0") return 0x27;
  const f = /^f([1-9]|1[0-2])$/.exec(key);
  if (f) return 0x3a + Number(f[1]) - 1;
  return NAMED[key] ?? null;
}

/** A KeyEvent -> { usage, mods } or null when the key has no US usage or is a Command/Control chord. */
export function keyToHid(ev) {
  const m = ev?.modifiers ?? {};
  if (m.platform || m.control) return null;
  let key = String(ev?.key ?? "");
  let shift = Boolean(m.shift);
  if (/^[A-Z]$/.test(key)) { key = key.toLowerCase(); shift = true; }
  else if (SHIFTED[key]) { key = SHIFTED[key]; shift = true; }
  const usage = baseUsage(key);
  if (usage == null) return null;
  const mods = [];
  if (shift) mods.push(MOD_SHIFT);
  if (m.alt) mods.push(MOD_ALT);
  return { usage, mods };
}
