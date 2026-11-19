// Usage: node sync-lib.mjs [--check] [--from <path/to/panel-ui.js>]
// Copies the canonical lib/panel-ui.js into every drover-* mod that already
// has lib/panel-ui.js, and refreshes its sha256 entry in lib/.hashes.json
// where the mod lists it. --check only reports drift and exits 1 if any.
// Default source: mods/drover-files/lib/panel-ui.js under this script's home.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const home = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const check = args.includes("--check");
const fi = args.indexOf("--from");
const from = fi >= 0 && args[fi + 1] ? path.resolve(args[fi + 1]) : path.join(home, "mods", "drover-files", "lib", "panel-ui.js");
const NAME = "panel-ui.js";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

if (!fs.existsSync(from)) { console.error("source not found: " + from); process.exit(2); }
const src = fs.readFileSync(from);
const want = sha(src);
const modsDir = path.join(home, "mods");
let drift = 0;

for (const mod of fs.readdirSync(modsDir).filter((n) => n.startsWith("drover-")).sort()) {
  const lib = path.join(modsDir, mod, "lib");
  const dest = path.join(lib, NAME);
  if (!fs.existsSync(dest)) continue;
  const problems = [];
  if (sha(fs.readFileSync(dest)) !== want) problems.push("file differs");
  const hp = path.join(lib, ".hashes.json");
  let hashes = null;
  if (fs.existsSync(hp)) {
    hashes = JSON.parse(fs.readFileSync(hp, "utf8"));
    if (NAME in hashes && hashes[NAME] !== want) problems.push("hash entry stale");
  }
  if (problems.length) {
    drift++;
    console.log(`${check ? "drift" : "sync "} ${mod}: ${problems.join(", ")}`);
    if (!check) {
      fs.copyFileSync(from, dest);
      if (hashes && NAME in hashes) {
        hashes[NAME] = want;
        fs.writeFileSync(hp, JSON.stringify(hashes, null, 2) + "\n");
      }
    }
  }
}
console.log(drift ? (check ? `${drift} mod(s) drifted` : `${drift} mod(s) synced`) : "clean");
process.exit(check && drift ? 1 : 0);
