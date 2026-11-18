#!/usr/bin/env node
// Leak gate: fails when a file the repo would publish names something private or a mod this
// repo must not credit by name. It reads the git-visible set (tracked plus untracked, minus
// ignored), checks every path and every text file, and prints file:line for each hit.
// Usage: node scripts/leak-gate.mjs     (export.mjs runs it after each export)
// The only allowed hits are the install lines export.mjs renders, matched whole, and whole lines
// listed per file (the root LICENSE copyright line). Binary files are allowed only at the preview
// paths export.mjs names; any other binary file is a hit.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// The terms are put together from pieces so this file does not trip itself.
const j = (...parts) => parts.join("");
const RULES = [
  [j("she", "prd"), "i"],
  [j("recep", "sen"), "i"],
  [j("sen", "recep"), "i"],
  [j("tap", "to", "web"), "i"],
  [j("@", "gmail"), "i"],
  [j("cachy", "os"), "i"],
  [j("easy", "app"), "i"],
  [j("yon", "tu"), "i"],
  [j("herdr-app-", "backup"), "i"],
  [j("\\/", "Users", "\\/", "(?!(?:me|a|ab|x|meow)(?![\\w.-]))[\\w.-]+"), ""],
  [j("\\b", "T", "3", "\\b"), ""],
  [j("t", "3", "[-_]"), ""],
  [j("t", "3", "[A-Z]"), ""],
  [j("t", "3", "code"), "i"],
  [j("ju", "has"), "i"],
  [j("better", "-", "sidebar"), "i"],
  [j("mu", "xy"), "i"],
  [j("\\b", "in", "sights?", "\\b"), "i"],
  [j("2", "code"), "i"],
  [j("agent", "-", "history"), "i"],
  [j("claude", "-", "inspector"), "i"],
].map(([src, flags]) => new RegExp(src, flags));

function visibleFiles(repo) {
  try {
    const out = execFileSync("git", ["-C", repo, "ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf8" });
    return out.split("\0").filter(Boolean).sort();
  } catch {
    // Not a git repo: walk it, leaving out .git.
    const files = [];
    (function walk(dir, rel) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === ".git") continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else if (e.isFile()) files.push(r);
      }
    })(repo, "");
    return files.sort();
  }
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

// Returns { files, hits, binary } and never throws on a hit. `lines` maps a file to the exact lines
// it may carry as they are. `binaries` lists the paths where a binary file is allowed.
export function gate(repo, allowed = [], lines = {}, binaries = []) {
  const binOk = new Set(binaries);
  const allow = [...new Set(allowed)].sort((a, b) => b.length - a.length);
  const clean = (text) => allow.reduce((t, a) => t.split(a).join(""), text);
  const hits = [];
  let binary = 0;
  const files = visibleFiles(repo);
  for (const rel of files) {
    for (const re of RULES) if (re.test(rel)) hits.push(`${rel}: path matches /${re.source}/`);
    const abs = path.join(repo, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const buf = fs.readFileSync(abs);
    if (isBinary(buf)) {
      if (binOk.has(rel)) binary++;
      else hits.push(`${rel}: binary file outside the preview paths`);
      continue;
    }
    buf.toString("utf8").split("\n").forEach((line, i) => {
      if (lines[rel]?.includes(line)) return;
      const text = clean(line);
      for (const re of RULES) if (re.test(text)) hits.push(`${rel}:${i + 1}: /${re.source}/: ${line.trim().slice(0, 160)}`);
    });
  }
  return { files: files.length, hits, binary };
}

export function report(result) {
  if (result.hits.length) {
    console.error(`leak gate: FAIL, ${result.hits.length} hit(s) in ${result.files} files`);
    for (const h of result.hits) console.error("  " + h);
    return false;
  }
  console.log(`leak gate: pass, ${result.files} files (${result.binary} binary, paths only)`);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repo = path.resolve(here, "..");
  // Not awaited: export.mjs imports this file, so it can load only once this one has.
  import(pathToFileURL(path.join(here, "export.mjs")).href)
    .then(({ installLines, LICENSE_LINE, previewPaths }) => { process.exitCode = report(gate(repo, installLines(), { LICENSE: [LICENSE_LINE] }, previewPaths())) ? 0 : 1; });
}
