// "Search in files": a fixed-string search under a folder with ripgrep, falling back to grep.
// Pure argv builders and output parsing; main.js runs them through the host's exec.
import { isDenied, redact, stripControl } from "./lib/guard.js";
import { resolve as resolvePath } from "./lib/paths.js";

export const MAX_RESULTS = 200;
export const SHOWN_CHARS = 200;

// Files a search must never look into (the viewer would refuse them anyway).
const SKIP_GLOBS = [
  ".env*", "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore", "*.kdbx", "*.ppk", "id_rsa*", "id_dsa*", "id_ecdsa*", "id_ed25519*",
  "*.sqlite", "*.sqlite3", "*.db", "*.db3", "*.pb", "auth.json", ".credentials.json", "credentials", "credentials.json", "mcp-auth.json",
  "oauth_creds.json", "google_accounts.json", ".netrc", "_netrc", ".npmrc", ".pypirc", ".git-credentials", ".pgpass", ".my.cnf",
  "secrets.json", "secret.json", "kubeconfig*", "*.keychain*",
];
const SKIP_DIRS = [".git", "node_modules", ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".password-store", "keychains"];

export function rgArgv(query) {
  const args = ["--line-number", "--column", "--no-heading", "--color", "never", "--fixed-strings", "--smart-case",
    "--max-count", "5", "--max-filesize", "1M", "--max-columns", "300", "--max-columns-preview"];
  for (const g of SKIP_GLOBS) args.push("-g", "!" + g);
  for (const d of SKIP_DIRS) args.push("-g", `!**/${d}/**`);
  args.push("--", query, ".");
  return ["rg", args];
}

export function grepArgv(query) {
  const args = ["-rnIF", "-m", "5"];
  for (const g of SKIP_GLOBS) args.push(`--exclude=${g}`);
  for (const d of SKIP_DIRS) args.push(`--exclude-dir=${d}`);
  args.push("--", query, ".");
  return ["grep", args];
}

// The query as it may be searched: one line, no control characters, bounded.
export function cleanQuery(q) {
  return stripControl(String(q ?? "").split("\n")[0]).trim().slice(0, 200);
}

// rg: "./a/b.js:12:5:text" ; grep: "./a/b.js:12:text". Paths are relative to the searched folder.
export function parseResults(stdout, folder, withColumn) {
  const out = [];
  const re = withColumn ? /^(.+?):(\d+):(\d+):(.*)$/ : /^(.+?):(\d+):(.*)$/;
  let dropped = 0;
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line) continue;
    const m = re.exec(line);
    if (!m) continue;
    const rel = m[1].replace(/^\.\//, "");
    const file = resolvePath(folder + "/" + rel);
    if (!file || !file.startsWith(folder === "/" ? "/" : folder + "/")) continue;
    if (isDenied(file)) { dropped++; continue; }
    const text = withColumn ? m[4] : m[3];
    out.push({
      file, rel,
      line: +m[2],
      col: withColumn ? +m[3] : null,
      text: stripControl(redact(text).text).trim().slice(0, SHOWN_CHARS),
    });
    if (out.length >= MAX_RESULTS) break;
  }
  return { results: out, dropped };
}

// exit 0 = matches, 1 = none, 2 = an error (an unreadable file) that may still come with matches;
// 126/127 = the program is missing on that machine (a remote shell reports it instead of failing to start).
export function outcome(res) {
  if (!res) return "error";
  if (res.code === 0) return "matches";
  if (res.code === 1) return "none";
  if (res.code === 126 || res.code === 127) return "missing";
  if (res.code === 2 && String(res.stdout || "").trim()) return "matches";
  return "error";
}
