// Vendored with the lib. In a mod check.cjs: require("./lib/assert-lib-hashes.cjs").assertLibHashes(__dirname)
// Every vendored lib/ and icons/ file must match lib/.hashes.json (run sync-lib.mjs to fix drift).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
// assertLibHashes(modDir) throws on any missing or drifted file.
function assertLibHashes(modDir) {
  const want = JSON.parse(fs.readFileSync(path.join(modDir, "lib", ".hashes.json"), "utf8"));
  const bad = [];
  for (const [rel, hash] of Object.entries(want)) {
    const p = rel.startsWith("icons/") ? path.join(modDir, rel) : path.join(modDir, "lib", rel);
    let got = null;
    try { got = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); } catch (e) { /* missing */ }
    if (got !== hash) bad.push(rel);
  }
  if (bad.length) throw new Error("vendored lib drifted from source: " + bad.slice(0, 5).join(", ") + (bad.length > 5 ? ` (+${bad.length - 5})` : "") + " - run sync-lib.mjs");
}
module.exports = { assertLibHashes };
