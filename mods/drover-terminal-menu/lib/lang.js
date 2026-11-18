// Filename/extension -> EditorState language token. Tokens verified to highlight: js json py sh go rs yaml css html cs xml sql rb makefile c java scala objective-c.
const NATIVE = new Set(["js", "json", "py", "sh", "go", "rs", "yaml", "css", "html", "cs", "xml", "sql", "rb", "makefile", "c", "java", "scala", "objective-c"]);
const EXT = {
  js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", tsx: "js", mts: "js", cts: "js",
  json: "json", jsonc: "json", json5: "json", webmanifest: "json", geojson: "json",
  py: "py", pyw: "py", pyi: "py", sh: "sh", bash: "sh", zsh: "sh", ksh: "sh", fish: "sh", command: "sh",
  go: "go", rs: "rs", yaml: "yaml", yml: "yaml", toml: "yaml", ini: "yaml", cfg: "yaml", conf: "yaml", properties: "yaml",
  css: "css", scss: "css", sass: "css", less: "css", html: "html", htm: "html", xhtml: "html", vue: "html", svelte: "html",
  cs: "cs", csx: "cs", xml: "xml", xsd: "xml", xsl: "xml", svg: "xml", plist: "xml", csproj: "xml", fsproj: "xml", props: "xml", targets: "xml", resx: "xml",
  sql: "sql", rb: "rb", rake: "rb", gemspec: "rb", mk: "makefile", mak: "makefile",
  c: "c", h: "c", cc: "c", cpp: "c", cxx: "c", hpp: "c", hh: "c", java: "java", scala: "scala", sc: "scala", sbt: "scala",
  kt: "scala", kts: "scala", m: "objective-c", mm: "objective-c", swift: "objective-c",
};
const NAMES = {
  makefile: "makefile", gnumakefile: "makefile", dockerfile: "sh", containerfile: "sh", gemfile: "rb", rakefile: "rb", podfile: "rb", vagrantfile: "rb",
  ".bashrc": "sh", ".zshrc": "sh", ".profile": "sh", ".bash_profile": "sh", ".gitignore": "plain", ".dockerignore": "plain",
  ".editorconfig": "yaml", ".prettierrc": "json", ".eslintrc": "json", ".babelrc": "json", "package.json": "json", "tsconfig.json": "json",
};
const MARKDOWN = new Set(["md", "markdown", "mdx", "mdc"]);
const MAX_BYTES = 1024 * 1024;
const base = (p) => String(p || "").replace(/\\/g, "/").split("/").pop();

function langFor(name) {
  const b = base(name).toLowerCase();
  if (NAMES[b]) return NAMES[b];
  if (/^dockerfile(\.|$)/.test(b)) return "sh";
  const i = b.lastIndexOf(".");
  const ext = i > 0 ? b.slice(i + 1) : i === 0 ? b.slice(1) : "";
  return EXT[ext] || "plain";
}
const isMarkdown = (name) => { const b = base(name).toLowerCase(); const i = b.lastIndexOf("."); return i > 0 && MARKDOWN.has(b.slice(i + 1)); };
// Text looks binary when it has NUL bytes or many control chars / replacement chars in the first 8 KiB. Accepts a string or Uint8Array.
function isBinary(data) {
  if (data == null) return false;
  const n = Math.min(data.length, 8192);
  if (!n) return false;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = typeof data === "string" ? data.charCodeAt(i) : data[i];
    if (c === 0) return true;
    if (c === 0xfffd || (c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12 && c !== 27) || c === 127) bad++;
  }
  return bad / n > 0.1;
}
// UTF-8 byte length without TextEncoder (host runtime may not provide it).
function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1; else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
// size guard: bytes (number) or string -> {ok, reason}
function sizeGuard(sizeOrText) {
  const size = typeof sizeOrText === "number" ? sizeOrText : utf8Length(String(sizeOrText));
  return size > MAX_BYTES ? { ok: false, size, reason: "larger than 1 MiB" } : { ok: true, size };
}
export { NATIVE, MAX_BYTES, utf8Length, langFor, isMarkdown, isBinary, sizeGuard };
