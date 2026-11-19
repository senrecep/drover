// Credential denylist (refuse to open) and secret redaction (for text we do show).
const BASE_EXACT = new Set([
  "auth.json", ".credentials.json", "credentials", "credentials.json", "mcp-auth.json", "oauth_creds.json", "google_accounts.json",
  ".netrc", "_netrc", ".npmrc", ".pypirc", ".git-credentials", "kubeconfig", ".pgpass", ".my.cnf", "secrets.json", "secret.json",
]);
const BASE_PATTERNS = [
  /^\.env(\..*)?$/, /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/, /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$/,
  /\.(sqlite|sqlite3|db|db3|pb)$/, /^kubeconfig(\..*)?$/, /^\.?htpasswd$/,
];
const SEGMENTS = new Set([".ssh", ".aws", ".gnupg", ".gpg", "keychains", ".kube", ".docker", ".password-store"]);
const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");

// -> null when allowed, else a short reason string
function denyReason(path) {
  const p = norm(path);
  if (p.includes("\0")) return "invalid path";
  const segs = p.split("/").filter(Boolean);
  const name = (segs[segs.length - 1] || "").toLowerCase();
  const dirs = segs.slice(0, -1).map((s) => s.toLowerCase());
  if (BASE_EXACT.has(name)) return "credential file";
  if (BASE_PATTERNS.some((r) => r.test(name))) return "credential or key file";
  for (const d of dirs.concat(name)) if (SEGMENTS.has(d)) return "credential directory";
  // gh CLI hosts file and cloud/CLI auth stores
  if (name === "hosts.yml" || name === "hosts.yaml") { if (dirs.includes("gh")) return "credential file"; }
  if (name === "config.json" && dirs[dirs.length - 1] === ".docker") return "credential file";
  if (dirs.includes("gcloud") && /credentials|access_tokens|legacy_credentials/.test(p.toLowerCase())) return "credential file";
  if (dirs.includes("keychains") || /\.keychain(-db)?$/.test(name)) return "keychain";
  return null;
}
const isDenied = (path) => denyReason(path) !== null;

const MASK = "[redacted]";
// Order matters: block/URL forms first, then key shapes, then assignments.
const RULES = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, () => MASK],
  // URL userinfo: scheme://user:pass@host -> scheme://[redacted]@host ; a bare http(s) userinfo can itself be a token
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"'<>]+:[^\s/@"'<>]*@/gi, (m, s) => s + MASK + "@"],
  [/\b(https?:\/\/|ftp:\/\/)[^\s/@:"'<>]+@/gi, (m, s) => s + MASK + "@"],
  // token-looking query parameters (template placeholders like ${key} are left alone)
  [/([?&](?:access_token|refresh_token|id_token|token|api[_-]?key|apikey|key|secret|sig|signature|password|passwd|pwd|auth|code|client_secret|x-amz-signature|x-amz-credential)=)(?![$({]|%7B)[^&\s"'<>#`]+/gi, (m, p) => p + MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, () => MASK],
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g, () => MASK],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, () => MASK],
  [/\bsk-(?:proj-|live-|svcacct-)?[A-Za-z0-9_-]{20,}/g, () => MASK],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, () => MASK],
  [/\bwhsec_[A-Za-z0-9]{16,}/g, () => MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, () => MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, () => MASK],
  [/\bgl(?:pat|dt|rt|ptt|cbt|oas|soat|imt|agent)-[A-Za-z0-9_-]{16,}/g, () => MASK],
  [/\bATBB[A-Za-z0-9_=-]{20,}/g, () => MASK],
  [/\bATATT[A-Za-z0-9_=-]{20,}/g, () => MASK],
  [/\bxox[abposre]-[A-Za-z0-9-]{10,}/g, () => MASK],
  [/\bxapp-[0-9]-[A-Za-z0-9-]{10,}/g, () => MASK],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, () => MASK],
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, () => MASK],
  [/\bnpm_[A-Za-z0-9]{30,}/g, () => MASK],
  [/\bBearer\s+(?=[A-Za-z0-9._~+\/=-]*[\d.\-_~+\/=])[A-Za-z0-9._~+\/=-]{16,}/g, () => "Bearer " + MASK],
  [/\bBasic\s+[A-Za-z0-9+\/]{12,}={0,2}/g, () => "Basic " + MASK],
  // assignments: password=..., "token": "...", SECRET_KEY: ... (value must be a literal, not a code expression)
  [/(\b[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)(["'])([^"'\n]{4,})\2/gi, (m, pre, q) => pre + q + MASK + q],
  [/(\b[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*\s*[:=]\s*)(?![$({\[<@%])(?=[^\s"',;#)}\]]*\d)([A-Za-z0-9_\-+\/=~!*^&:@]{8,})(?![A-Za-z0-9_\-+\/=~!*^&:@(\[.])/gi, (m, pre) => pre + MASK],
];
// -> {text, redacted}
function redact(text) {
  let out = String(text == null ? "" : text), hit = false;
  for (const [re, fn] of RULES) {
    out = out.replace(re, (...a) => { hit = true; return fn(...a); });
  }
  return { text: out, redacted: hit };
}
// control/bidi characters are dropped from displayed text
const BAD_CHARS = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]", "g");
const stripControl = (t) => String(t == null ? "" : t).replace(BAD_CHARS, " ");
export { denyReason, isDenied, redact, stripControl, MASK };
