// Pure parts of drover-data: no host calls, so node can test them.

export const MAX_DB_FILES = 50;
export const MAX_DB_BYTES = 2147483648; // 2 GB
export const MAX_CELL = 200;
export const PAGE = 100;
export const DB_EXT = [".db", ".sqlite", ".sqlite3"];

// ---------- text ----------

// The same character set as drover-dispatch's sanitize and drover-goto's clean (copied, not imported).
// Built from strings: the app's regexp parser rejects U+2028/2029 inside a literal.
// Whole terminal escape sequences: OSC, DCS, PM, APC, SOS (7- and 8-bit) up to BEL, ST or the end;
// CSI (7- and 8-bit); then any other ESC sequence or lone ESC.
const ESCAPES = new RegExp([
  "\\x1b[\\]P^_X][\\s\\S]*?(?:\\x07|\\x1b\\\\|\\x9c|$)",
  "[\\x90\\x98\\x9d\\x9e\\x9f][\\s\\S]*?(?:\\x07|\\x1b\\\\|\\x9c|$)",
  "\\x1b\\[[0-?]*[ -/]*[@-~]?",
  "\\x9b[0-?]*[ -/]*[@-~]?",
  "\\x1b[ -/]*[0-~]?",
].join("|"), "g");
const BREAKS = new RegExp("[\\t\\r\\n\\u2028\\u2029]", "g");
// C0, DEL, C1.
const CONTROLS = new RegExp("[\\x00-\\x1f\\x7f-\\x9f]", "g");
// Invisible and format characters: soft hyphen, CGJ, Arabic marks, Hangul fillers, Khmer vowels,
// Mongolian selectors, zero-width, bidi embeddings and isolates, invisible operators, Braille blank,
// variation selectors (both blocks), BOM, interlinear annotation, musical format marks, tag block.
const INVISIBLE = new RegExp("[\\u00ad\\u034f\\u0600-\\u0605\\u061c\\u06dd\\u070f\\u0890\\u0891\\u08e2\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\u2800\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff9-\\ufffb]|\\udb40[\\udc00-\\udc7f\\udd00-\\uddef]|\\ud834[\\udd73-\\udd7a]", "g");

// Escape sequences, control and invisible characters go; tab and line breaks become a space.
// Cut before any regex: names and cells come from untrusted files.
export function stripControl(s, max = 8192) {
  return String(s).slice(0, max)
    .replace(ESCAPES, "")
    .replace(BREAKS, " ")
    .replace(CONTROLS, "")
    .replace(INVISIBLE, "");
}

// What a grid cell shows: {text, dim}. NULL is dim; a long value is cut at `max` characters.
export function formatCell(value, max = MAX_CELL) {
  if (value === null || value === undefined) return { text: "NULL", dim: true };
  const chars = Array.from(stripControl(typeof value === "string" ? value : String(value)));
  if (chars.length > max) return { text: chars.slice(0, max).join("") + "…", dim: false };
  return { text: chars.join(""), dim: false };
}

// ---------- database files ----------

export function hasDbExtension(path) {
  const lower = path.toLowerCase();
  return DB_EXT.some((e) => lower.endsWith(e));
}

// Names from a listing, in order, kept when they look like a database file. At most `max`.
export function filterDbFiles(paths, max = MAX_DB_FILES) {
  const seen = new Set(), out = [];
  for (const p of paths) {
    if (!p || seen.has(p) || !hasDbExtension(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

export const splitNul = (text) => (text || "").split("\0").filter(Boolean);

// A path that find and sqlite3 can never read as an option.
export const safePath = (p) => (p.startsWith("/") || p.startsWith("./") ? p : `./${p}`);

// find: regular files (symlinks are not followed) under the size cap, names NUL separated.
export function sizeCheckArgs(paths) {
  return [...paths.map(safePath), "-maxdepth", "0", "-type", "f", "-size", `-${MAX_DB_BYTES + 1}c`, "-print0"];
}
export const topLevelArgs = () => [".", "-maxdepth", "1", "-type", "f", "-print0"];
export const normalizePath = (p) => (p.startsWith("./") ? p.slice(2) : p);

// ---------- SQL (the only statements the mod builds) ----------

export function quoteIdent(name) {
  if (typeof name !== "string" || name === "" || name.includes("\0")) throw new Error("bad identifier");
  return `"${name.replace(/"/g, '""')}"`;
}

const int = (n, what) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`bad ${what}`);
  return n;
};

// Tables and views with the start of their CREATE text, and what SQLite itself calls each
// (pragma_table_list: table, view, virtual, shadow). listSqlPlain is for a sqlite3 without that pragma.
export const listSql = () =>
  "SELECT s.type AS type, s.name AS name, substr(s.sql, 1, 4096) AS sql, l.type AS kind, l.wr AS wr FROM sqlite_schema AS s " +
  "LEFT JOIN pragma_table_list AS l ON l.schema = 'main' AND l.name = s.name " +
  "WHERE s.type IN ('table','view') AND s.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY s.type, s.name";
export const listSqlPlain = () =>
  "SELECT type, name, substr(sql, 1, 4096) AS sql FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name";
// A view is read only when its plan touches no virtual table (zipfile, fsdir, json_each, fts…).
export const viewPlanSql = (view) => `EXPLAIN QUERY PLAN SELECT * FROM ${quoteIdent(view)}`;
export const viewPlanOk = (stdout) => /QUERY PLAN/.test(String(stdout ?? "")) && !/VIRTUAL TABLE/i.test(String(stdout ?? ""));

// ---------- virtual tables ----------

// Virtual tables whose module only reads the database file itself. Any other module (zipfile,
// fsdir, csv, …) can read files outside it, so such a table is listed but never queried.
export const VTAB_OK = ["fts3", "fts4", "fts5", "rtree"];
export const VTAB_REFUSED = "not shown (virtual table)";

// The first tokens of a CREATE statement, comments and whitespace skipped: { q: quoted?, v }.
// null when the text ends inside a comment or a quoted name.
export function sqlTokens(sql, limit = 12) {
  const s = String(sql ?? "");
  const out = [];
  let i = 0;
  while (i < s.length && out.length < limit) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") { i++; continue; }
    if (s.startsWith("--", i)) { const j = s.indexOf("\n", i); if (j < 0) break; i = j + 1; continue; }
    if (s.startsWith("/*", i)) { const j = s.indexOf("*/", i + 2); if (j < 0) return null; i = j + 2; continue; }
    if (c === '"' || c === "`" || c === "'") {
      let j = i + 1, v = "";
      for (;;) {
        const k = s.indexOf(c, j);
        if (k < 0) return null;
        v += s.slice(j, k);
        if (s[k + 1] === c) { v += c; j = k + 2; continue; }
        i = k + 1;
        break;
      }
      out.push({ q: true, v });
      continue;
    }
    if (c === "[") { const k = s.indexOf("]", i + 1); if (k < 0) return null; out.push({ q: true, v: s.slice(i + 1, k) }); i = k + 1; continue; }
    const m = /^[A-Za-z0-9_$\u0080-\uffff]+/.exec(s.slice(i, i + 256));
    if (m) { out.push({ q: false, v: m[0] }); i += m[0].length; continue; }
    out.push({ q: false, v: c });
    i++;
  }
  return out;
}

// What a table's CREATE text says: { virtual: false }, { virtual: true, module, args }, or null when
// unsure. CREATE VIRTUAL TABLE [IF NOT EXISTS] [schema.]name USING module [(arg, …)], any case,
// quoting, comments. args: each argument's tokens (split at top-level commas); null when unreadable.
export function virtualInfo(sql) {
  const t = sqlTokens(sql, 4096);
  if (!t) return null;
  const w = (k) => (t[k] && !t[k].q ? t[k].v.toLowerCase() : null);
  if (w(0) !== "create") return null;
  if (w(1) === "table" || ((w(1) === "temp" || w(1) === "temporary") && w(2) === "table")) return { virtual: false };
  if (w(1) !== "virtual" || w(2) !== "table") return null;
  let k = 3;
  if (w(k) === "if" && w(k + 1) === "not" && w(k + 2) === "exists") k += 3;
  if (!t[k]) return null;
  k++;
  if (w(k) === ".") { if (!t[k + 1]) return null; k += 2; }
  if (w(k) !== "using" || !t[k + 1]) return null;
  const module = t[k + 1].v.toLowerCase();
  return /^[a-z0-9_]+$/.test(module) ? { virtual: true, module, args: moduleArgs(t, k + 2) } : null;
}

// The arguments after the module name: [] with none, null when the list is cut off or odd.
function moduleArgs(t, k) {
  if (k >= t.length) return [];
  if (t[k].q || t[k].v !== "(") return null;
  const args = [];
  let cur = [], depth = 0;
  for (let i = k + 1; i < t.length; i++) {
    const tok = t[i];
    if (!tok.q && tok.v === "(") depth++;
    if (!tok.q && tok.v === ")") {
      if (depth === 0) {
        if (cur.length) args.push(cur);
        // anything after the closing parenthesis (or a list cut at the token limit) is unsure
        return i === t.length - 1 ? args : null;
      }
      depth--;
    }
    if (!tok.q && tok.v === "," && depth === 0) { if (!cur.length) return null; args.push(cur); cur = []; continue; }
    cur.push(tok);
  }
  return null;
}

// Options each allowed module may have. content= is checked apart: it names another table.
// fts3/fts4 compress= and uncompress= name SQL functions, so they are not allowed.
const FTS_OPTIONS = {
  fts3: ["content", "tokenize", "prefix", "order", "languageid", "matchinfo", "notindexed"],
  fts4: ["content", "tokenize", "prefix", "order", "languageid", "matchinfo", "notindexed"],
  fts5: ["content", "content_rowid", "tokenize", "prefix", "columnsize", "detail", "contentless_delete",
    "contentless_unindexed", "locale", "tokendata"],
};

// True when an allowed module's arguments read only its own data, or a plain table in this file
// (plain: lower-case names of the non-virtual tables in main). Unsure: false.
export function vtabArgsOk(info, plain = new Set()) {
  if (!info?.virtual || !Array.isArray(info.args)) return false;
  const { module, args } = info;
  const eq = (arg) => arg.findIndex((x) => !x.q && x.v === "=");
  if (module === "rtree") return args.every((arg) => eq(arg) < 0); // column names only
  const options = FTS_OPTIONS[module];
  if (!options) return false;
  return args.every((arg) => {
    const at = eq(arg);
    if (at < 0) return true; // a column (fts3 also takes "tokenize name" this way)
    if (at !== 1) return false;
    const key = arg[0].v.toLowerCase();
    if (!options.includes(key)) return false;
    if (key !== "content") return true;
    const value = arg.slice(2);
    if (value.length !== 1) return false;
    const name = value[0].v;
    return name === "" || plain.has(name.toLowerCase());
  });
}

// Why a table is not shown, or null. kind: pragma_table_list's type when there is one. Unsure: refused.
// plain: the lower-case names of plain tables in main, for an fts table's content= option.
export function tableRefusal(entry, plain = new Set()) {
  if (entry.type !== "table") return null;
  const text = virtualInfo(entry.sql);
  let virtual;
  if (entry.kind === "virtual") virtual = true;
  else if (entry.kind === "table" || entry.kind === "shadow") virtual = text?.virtual === true;
  else virtual = text ? text.virtual : true;
  if (!virtual) return null;
  return text?.virtual && VTAB_OK.includes(text.module) && vtabArgsOk(text, plain) ? null : VTAB_REFUSED;
}

// A plain (non-virtual, non-shadow) table: what pragma_table_list says, else what its text says.
const isPlain = (e) => e.type === "table" && (e.kind ? e.kind === "table" && virtualInfo(e.sql)?.virtual === false
  : virtualInfo(e.sql)?.virtual === false);
export const infoSql = (table) => `PRAGMA table_info(${quoteIdent(table)})`;
export const countSql = (table) => `SELECT count(*) AS n FROM ${quoteIdent(table)}`;

// Columns come back as c0..cN so odd or repeated names cannot collide. Blobs are never read:
// only their length. Text is cut in SQL; integers travel as text so none loses digits.
export function pageSql(table, columns, limit = PAGE, offset = 0) {
  if (!columns.length) throw new Error("no columns");
  const cols = columns.map((name, i) => {
    const q = quoteIdent(name);
    return `CASE typeof(${q}) WHEN 'blob' THEN '<blob '||length(${q})||' bytes>' WHEN 'text' THEN substr(${q},1,${MAX_CELL + 1}) WHEN 'integer' THEN CAST(${q} AS TEXT) ELSE ${q} END AS c${i}`;
  });
  return `SELECT ${cols.join(", ")} FROM ${quoteIdent(table)} LIMIT ${int(limit, "limit")} OFFSET ${int(offset, "offset")}`;
}

// -readonly opens the file read-only and never makes a journal; -init /dev/null skips ~/.sqliterc;
// -safe (when this sqlite3 knows it) turns off shell commands, ATTACH-like file access and extensions.
export function sqliteArgs(db, sql, safe) {
  return ["-readonly", "-init", "/dev/null", ...(safe ? ["-safe"] : []), "-json", safePath(db), sql];
}

// Rows per page: every cell can be MAX_CELL+1 characters, at most 6 bytes each as JSON. Wide tables
// get fewer rows so a page stays well under exec's 8 MiB output.
export const PAGE_BYTES = 4 * 1024 * 1024;
export const CELL_BYTES = (MAX_CELL + 1) * 6 + 16;
export const pageSize = (columns) => Math.max(1, Math.min(PAGE, Math.floor(PAGE_BYTES / (Math.max(1, columns) * CELL_BYTES))));
export const CUT_NOTE = "Too much output to show (cut at 8 MB).";

export function parseJsonRows(stdout) {
  const text = (stdout || "").trim();
  if (!text) return [];
  let rows;
  try { rows = JSON.parse(text); }
  catch (e) { throw text.length > 1024 * 1024 ? new Error(CUT_NOTE) : e; }
  if (!Array.isArray(rows)) throw new Error("not a row list");
  return rows;
}

// { type, name, refused, checked }: refused is the line to show instead of the table, or null.
// A view starts unchecked; it is read only after viewPlanOk.
export function parseSchema(stdout) {
  const entries = parseJsonRows(stdout)
    .filter((r) => r && typeof r.name === "string" && (r.type === "table" || r.type === "view"))
    .map((r) => ({ type: r.type, name: r.name, sql: typeof r.sql === "string" ? r.sql : null, kind: typeof r.kind === "string" ? r.kind : null }));
  const plain = new Set(entries.filter(isPlain).map((e) => e.name.toLowerCase()));
  return entries.map((e) => ({ type: e.type, name: e.name, refused: tableRefusal(e, plain), checked: e.type === "table" }));
}

export function parseInfo(stdout) {
  return parseJsonRows(stdout).map((r) => ({
    name: String(r.name ?? ""), type: String(r.type ?? ""), pk: Number(r.pk) > 0,
  }));
}

export function parseCount(stdout) {
  const n = parseJsonRows(stdout)[0]?.n;
  return Number.isFinite(Number(n)) ? Number(n) : null;
}

// Rows as arrays in column order.
export function parsePage(stdout, columnCount) {
  return parseJsonRows(stdout).map((r) => Array.from({ length: columnCount }, (_, i) => r[`c${i}`] ?? null));
}

// One plain line for what sqlite3 said. null: nothing recognisable, the caller words it.
export function sqliteProblem(stderr) {
  const s = String(stderr || "").toLowerCase();
  if (s.includes("database is locked") || s.includes("database table is locked")) return "The database is locked by another program.";
  if (s.includes("file is not a database") || s.includes("encrypted")) return "Not a readable SQLite database (encrypted or not SQLite).";
  if (s.includes("malformed") || s.includes("corrupt")) return "The database file is corrupt.";
  if (s.includes("unable to open")) return "Could not open the database file.";
  if (s.includes("foreign key constraint")) return "Refused: a foreign key would break.";
  if (s.includes("unique constraint") || s.includes("primary key constraint")) return "Refused: that value must be unique.";
  if (s.includes("not null constraint")) return "Refused: a column needs a value (NOT NULL).";
  if (s.includes("check constraint")) return "Refused by a CHECK constraint.";
  if (s.includes("datatype mismatch") || s.includes("cannot store")) return "Refused: wrong type for this column.";
  if (s.includes("readonly") || s.includes("read-only")) return "The database file is read-only.";
  const broken = String(stderr || "").match(/error in (view|trigger) ([^:\n]{1,80}):/i);
  if (broken) {
    const what = `${broken[1].toLowerCase()} ${stripControl(broken[2])}`;
    return /no such (table|column)/i.test(String(stderr)) ? `Refused: ${what} refers to a table or column that no longer exists; drop or fix it first.`
      : `Refused: ${what} has an error; drop or fix it first.`;
  }
  if (s.includes("already exists") || s.includes("there is already another")) return "Refused: that name is already taken.";
  if (s.includes("duplicate column name")) return "Refused: a column with that name already exists.";
  if (s.includes("cannot add a not null column")) return "Refused: a NOT NULL column needs a non-NULL default.";
  if (s.includes("constraint failed")) return "Refused by a constraint.";
  return null;
}

// ---------- SQLite writes (edit mode) ----------
// Every statement the edit mode runs is built here. Names go through quoteIdent; values become
// literals through sqlLiteral (typed input) or checkedLiteral (sqlite's own quote() output, shape
// checked). Nothing a person typed, and nothing read from the file, reaches the SQL unquoted.

export const WRITE_TIMEOUT_MS = 2000;
export const GUARD = "drover_row_check";
export const CONFLICT_NOTE = "Row changed or gone; reloaded";
export const NUL_NOTE = "A value can't contain a NUL character.";
const ROWID_NAMES = ["rowid", "_rowid_", "oid"];

// Column affinity from the declared type, in SQLite's order (datatype3.html, 3.1).
export function affinity(declared) {
  const t = String(declared ?? "").toUpperCase();
  if (t.includes("INT")) return "INTEGER";
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "TEXT";
  if (t.includes("BLOB") || t === "") return "BLOB";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return "REAL";
  return "NUMERIC";
}
export const numericAffinity = (declared) => ["INTEGER", "REAL", "NUMERIC"].includes(affinity(declared));

// A plain decimal number, nothing else (no spaces, hex, Infinity, empty).
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
export const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

// The literal for a typed value. NULL only when `isNull` (the explicit toggle). A number only when the
// text is a finite plain number and the column's affinity is numeric; it is used as typed, so no digit
// is lost. Anything else is a quoted string. NUL is refused.
export function sqlLiteral(value, declared, isNull = false) {
  if (isNull) return "NULL";
  const s = String(value ?? "");
  if (s.includes("\0")) throw new Error(NUL_NOTE);
  if (numericAffinity(declared) && NUMBER.test(s) && Number.isFinite(Number(s))) return s;
  return sqlString(s);
}

// What sqlite's quote() printed, accepted only as one plain literal; null otherwise (e.g. "Inf").
export function checkedLiteral(q) {
  if (typeof q !== "string") return null;
  if (q === "NULL" || /^-?\d+$/.test(q) || /^-?\d+\.\d+(?:e[+-]\d+)?$/.test(q) || /^X'(?:[0-9A-F]{2})*'$/.test(q)) return q;
  if (/^'(?:[^'\0]|'')*'$/.test(q)) return q;
  return null;
}

// "WITHOUT ROWID" after a CREATE TABLE's column list: true, false, or null when unsure.
export function withoutRowidFromSql(sql) {
  if (typeof sql !== "string" || sql.length >= 4096) return null;
  const t = sqlTokens(sql, 4096);
  if (!t || !t.length) return null;
  let close = -1, depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i].q) continue;
    if (t[i].v === "(") depth++;
    else if (t[i].v === ")" && --depth === 0) close = i;
  }
  if (close < 0) return null;
  const words = t.slice(close + 1).filter((x) => x.q || (x.v !== "," && x.v !== ";")).map((x) => (x.q ? null : x.v.toLowerCase()));
  let without = false;
  for (let i = 0; i < words.length; i++) {
    if (words[i] === "strict") continue;
    if (words[i] === "without" && words[i + 1] === "rowid") { without = true; i++; continue; }
    return null;
  }
  return without;
}

// table_xinfo: every column, hidden and generated ones too, with its place in the primary key.
export const xinfoSql = (table) => `PRAGMA table_xinfo(${quoteIdent(table)})`;
export function parseXinfo(stdout) {
  return parseJsonRows(stdout).map((r) => ({ name: String(r.name ?? ""), pk: Number(r.pk) || 0, hidden: Number(r.hidden) || 0 }));
}

// What listSql said about each entry, for the edit mode: name -> { type, name, kind, sql, wr }.
export function tableMeta(stdout) {
  const out = new Map();
  for (const r of parseJsonRows(stdout)) {
    if (!r || typeof r.name !== "string") continue;
    out.set(r.name, {
      type: r.type, name: r.name, kind: typeof r.kind === "string" ? r.kind : null,
      sql: typeof r.sql === "string" ? r.sql : null, wr: r.wr === 0 || r.wr === 1 ? r.wr : null,
    });
  }
  return out;
}

// Can rows of this entry be written, and how is a row found? { ok: true, key } or { ok: false, reason }.
// key: { kind: "rowid", name } or { kind: "pk", columns }. Only plain tables (pragma_table_list says
// "table"), never views, virtual or shadow tables, sqlite_* tables. Unsure is read-only.
export function editability(meta, xinfo) {
  const no = (reason) => ({ ok: false, reason: `Read-only: ${reason}` });
  if (!meta) return no("unknown table");
  if (meta.type === "view") return no("view");
  if (/^sqlite_/i.test(meta.name ?? "")) return no("internal table");
  if (meta.kind === "virtual" || virtualInfo(meta.sql)?.virtual === true) return no("virtual table");
  if (meta.kind === "shadow") return no("internal table");
  if (meta.type !== "table" || meta.kind !== "table" || virtualInfo(meta.sql)?.virtual !== false) return no("table kind unknown");
  if (!Array.isArray(xinfo) || !xinfo.length) return no("no row key");
  const without = meta.wr === 1 ? true : meta.wr === 0 ? false : withoutRowidFromSql(meta.sql);
  if (without === null) return no("no row key");
  const pk = xinfo.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  if (!without) {
    const names = new Set(xinfo.map((c) => c.name.toLowerCase()));
    const name = ROWID_NAMES.find((n) => !names.has(n));
    if (name) return { ok: true, key: { kind: "rowid", name } };
  }
  if (pk.length) return { ok: true, key: { kind: "pk", columns: pk } };
  return no("no row key");
}

// pageSql plus, per row, the key as literals (k0..) and each cell as a literal (q0..) when it is short
// enough to check and edit (not a blob, text of at most MAX_CELL characters).
export function editPageSql(table, columns, key, limit = PAGE, offset = 0) {
  const base = pageSql(table, columns, limit, offset);
  const keys = key.kind === "rowid"
    ? [`quote(${ROWID_NAMES.includes(key.name) ? key.name : "rowid"}) AS k0`]
    : key.columns.map((c, i) => `CASE WHEN length(${quoteIdent(c)}) <= ${MAX_CELL} THEN quote(${quoteIdent(c)}) END AS k${i}`);
  const checks = columns.map((name, i) => {
    const q = quoteIdent(name);
    return `CASE typeof(${q}) WHEN 'blob' THEN NULL WHEN 'text' THEN CASE WHEN length(${q}) <= ${MAX_CELL} THEN quote(${q}) END ELSE quote(${q}) END AS q${i}`;
  });
  const from = ` FROM ${quoteIdent(table)} LIMIT `;
  const at = base.lastIndexOf(from);
  return `${base.slice(0, at)}, ${[...keys, ...checks].join(", ")}${base.slice(at)}`;
}

// Rows of editPageSql: { cells, keys, checks }. keys is null when any key literal is unusable;
// a check is null when that cell can't be checked (blob, cut text, odd quote()).
export function parseEditPage(stdout, columnCount, keyCount) {
  return parseJsonRows(stdout).map((r) => {
    const keys = Array.from({ length: keyCount }, (_, i) => checkedLiteral(r[`k${i}`]));
    return {
      cells: Array.from({ length: columnCount }, (_, i) => r[`c${i}`] ?? null),
      keys: keys.every((k) => k !== null) ? keys : null,
      checks: Array.from({ length: columnCount }, (_, i) => checkedLiteral(r[`q${i}`])),
    };
  });
}

const BLOB_SHOWN = /^<blob \d+ bytes>$/;
// Why a shown cell can't be edited in place, or null. raw: the value as read (pageSql's projection).
export function cellLock(raw, check) {
  if (check === null || check === undefined) return typeof raw === "string" && BLOB_SHOWN.test(raw) ? "BLOB" : "Too long to edit here";
  if (typeof raw === "string" && stripControl(raw) !== raw) return "Has line breaks or control characters";
  return null;
}

// The text a cell editor starts with: the stored value exactly (never the cut, cleaned display).
export const cellPrefill = (raw) => (raw === null || raw === undefined ? "" : String(raw));

function keyWhere(key, keys) {
  if (!Array.isArray(keys) || !keys.length || keys.some((k) => checkedLiteral(k) === null)) throw new Error("bad key");
  if (key.kind === "rowid") {
    if (!ROWID_NAMES.includes(key.name) || keys.length !== 1 || !/^-?\d+$/.test(keys[0])) throw new Error("bad key");
    return `${key.name} = ${keys[0]}`;
  }
  if (!key.columns?.length || key.columns.length !== keys.length) throw new Error("bad key");
  return key.columns.map((c, i) => `${quoteIdent(c)} IS ${keys[i]}`).join(" AND ");
}
const checkLit = (lit) => { if (checkedLiteral(lit) === null) throw new Error("bad check"); return lit; };
const valueLit = (lit) => {
  if (lit !== "NULL" && !NUMBER.test(lit) && !/^'(?:[^'\0]|'')*'$/.test(lit)) throw new Error("bad literal");
  return lit;
};

// INSERT of the given fields ([{ column, literal }]); none: DEFAULT VALUES.
export function insertSql(table, fields) {
  if (!fields.length) return `INSERT OR ROLLBACK INTO ${quoteIdent(table)} DEFAULT VALUES`;
  return `INSERT OR ROLLBACK INTO ${quoteIdent(table)} (${fields.map((f) => quoteIdent(f.column)).join(", ")}) VALUES (${fields.map((f) => valueLit(f.literal)).join(", ")})`;
}
// UPDATE of one column on the row with this key, only while that column still holds `old`.
export function updateSql(table, key, keys, column, old, literal) {
  return `UPDATE OR ROLLBACK ${quoteIdent(table)} SET ${quoteIdent(column)} = ${valueLit(literal)} WHERE ${keyWhere(key, keys)} AND ${quoteIdent(column)} IS ${checkLit(old)} COLLATE BINARY`;
}
// DELETE of the row with this key, only while every checked column still holds what was shown.
export function deleteSql(table, key, keys, checks) {
  const more = checks.filter((c) => c.literal !== null).map((c) => ` AND ${quoteIdent(c.column)} IS ${checkLit(c.literal)} COLLATE BINARY`).join("");
  return `DELETE FROM ${quoteIdent(table)} WHERE ${keyWhere(key, keys)}${more}`;
}

// The whole write: foreign keys on (outside a transaction, where the pragma works), a 2 s busy wait,
// one statement in BEGIN IMMEDIATE, then the guard: unless exactly one row changed, inserting into a
// CHECK-ed temp table fails with OR ROLLBACK, which rolls the transaction back before sqlite3 stops
// (-bail). COMMIT is never reached then.
// safe false (no -safe): trusted_schema=OFF also stops triggers and views in the file from calling
// unsafe functions (writefile and the like).
export function writeScript(statement, safe = true) {
  return `${safe ? "" : "PRAGMA trusted_schema=OFF; "}PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${WRITE_TIMEOUT_MS}; ` +
    `CREATE TEMP TABLE drover_guard(n, CONSTRAINT ${GUARD} CHECK (n = 1)); BEGIN IMMEDIATE; ${statement}; ` +
    `SELECT changes() AS drover_changes; INSERT OR ROLLBACK INTO temp.drover_guard VALUES (changes()); COMMIT;`;
}

// Same as sqliteArgs but writable: no -readonly, and -bail so nothing runs after a failure.
// The file is opened as a mode=rw URI, so a file removed after the checks is an error, never a new empty db.
export const rwUri = (db) => `file:${safePath(db).replace(/[%?#]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}?mode=rw`;
export function writeArgs(db, script, safe) {
  return ["-init", "/dev/null", ...(safe ? ["-safe"] : []), "-bail", "-json", rwUri(db), script];
}

// What a write's exit means: { ok: true } or { ok: false, conflict, message }. Never echoes stderr.
// stdout is not parsed: busy_timeout prints its own row, and exit code 0 already means committed.
export function writeOutcome(code, stderr) {
  if (code === 0) return { ok: true };
  const s = String(stderr || "");
  if (s.includes(GUARD)) return { ok: false, conflict: true, message: CONFLICT_NOTE };
  return { ok: false, conflict: false, message: sqliteProblem(s) ?? "sqlite3 could not change this database." };
}

// ---------- SQLite schema changes (edit mode) ----------
// CREATE TABLE, ADD COLUMN, DROP TABLE and the two RENAMEs. Every name goes through quoteIdent, every
// default through sqlLiteral. A change to an existing table first checks, inside the same BEGIN
// IMMEDIATE, that the table still has the CREATE text that was drawn (and the column its shown name):
// otherwise the guard insert fails with OR ROLLBACK and nothing after it runs (-bail).

export const SCHEMA_GUARD = "drover_schema_check";
export const SCHEMA_NOTE = "Schema changed; reloaded";
export const COL_TYPES = ["INTEGER", "TEXT", "REAL", "BLOB", "NUMERIC", ""];
export const RENAME_COLUMN_MIN = [3, 25, 0];
export const RENAME_COLUMN_NOTE = "Needs SQLite 3.25+";
export const MAX_DB_NAME = 100;

class SchemaError extends Error {}
const refuse = (msg) => { throw new SchemaError(msg); };

// A new table or column name: trimmed, not empty, no NUL, not sqlite_* (SQLite's own, any case).
export function newName(input, what = "name") {
  const s = String(input ?? "").trim();
  if (s === "") refuse(`The ${what} can't be empty.`);
  if (s.includes("\0")) refuse(`The ${what} can't contain a NUL character.`);
  if (/^sqlite_/i.test(s)) refuse(`Names starting with "sqlite_" are reserved.`);
  return s;
}
const colType = (type) => {
  const t = String(type ?? "").toUpperCase();
  if (!COL_TYPES.includes(t)) refuse("Unknown column type.");
  return t;
};
// " DEFAULT <literal>" or "": NULL only through the toggle, an empty value means no default.
const defaultClause = (def, type) => {
  if (!def) return "";
  if (def.isNull) return " DEFAULT NULL";
  const v = String(def.value ?? "");
  if (v === "") return "";
  try { return ` DEFAULT ${sqlLiteral(v, type)}`; } catch { refuse(NUL_NOTE); }
};

// columns: [{ name, type, pk, notNull, def: { value, isNull } }]. One PK column is declared inline
// (INTEGER PRIMARY KEY is the rowid alias); several become a PRIMARY KEY(a, b) table constraint.
// Never IF NOT EXISTS: a taken name is an error from sqlite3.
export function createTableSql(name, columns) {
  const table = newName(name, "table name");
  if (!Array.isArray(columns) || !columns.length) refuse("A table needs at least one column.");
  const seen = new Set();
  const cols = columns.map((c) => {
    const n = newName(c.name, "column name");
    const lower = n.toLowerCase();
    if (seen.has(lower)) refuse(`Two columns are named "${n}".`);
    seen.add(lower);
    return { ...c, name: n, type: colType(c.type) };
  });
  const pks = cols.filter((c) => c.pk);
  const defs = cols.map((c) => `${quoteIdent(c.name)}${c.type ? ` ${c.type}` : ""}${pks.length === 1 && c.pk ? " PRIMARY KEY" : ""}` +
    `${c.notNull ? " NOT NULL" : ""}${defaultClause(c.def, c.type)}`);
  if (pks.length > 1) defs.push(`PRIMARY KEY(${pks.map((c) => quoteIdent(c.name)).join(", ")})`);
  return `CREATE TABLE ${quoteIdent(table)} (${defs.join(", ")})`;
}

// The guard: 1 only while table `table` still has the drawn CREATE text (as listSql cut it) and, when
// given, a column named exactly `column`.
export function schemaGuardSql(table, shownSql, column = null) {
  if (typeof shownSql !== "string" || shownSql === "" || shownSql.includes("\0")) refuse("Unknown table definition.");
  quoteIdent(table);
  const tbl = `(SELECT count(*) FROM main.sqlite_master WHERE type = 'table' AND name = ${sqlString(table)} AND substr(sql, 1, 4096) = ${sqlString(shownSql)})`;
  const col = column === null ? "" : (quoteIdent(column), ` * (SELECT count(*) FROM pragma_table_info(${sqlString(table)}) WHERE name = ${sqlString(column)})`);
  return `INSERT OR ROLLBACK INTO temp.drover_schema VALUES (${tbl}${col})`;
}

// Each builder returns { guard, statement } for ddlScript; guard null for CREATE TABLE.
export const createTableDdl = (name, columns) => ({ guard: null, statement: createTableSql(name, columns) });

export function addColumnDdl(table, shownSql, col) {
  const name = newName(col?.name, "column name"), type = colType(col?.type);
  const hasValue = Boolean(col?.def) && !col.def.isNull && String(col.def.value ?? "") !== "";
  if (col?.notNull && !hasValue) refuse("NOT NULL needs a non-NULL default when adding a column.");
  const statement = `ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${quoteIdent(name)}${type ? ` ${type}` : ""}` +
    `${col?.notNull ? " NOT NULL" : ""}${defaultClause(col?.def, type)}`;
  return { guard: schemaGuardSql(table, shownSql), statement };
}
export const DEP_GUARD = "drover_dep_check";
export const DEP_NOTE = "Refused: a view or trigger uses this table; drop or fix it first.";
// Another table's trigger or any view whose SQL mentions the name (a plain text match: it may refuse
// too much, never too little). A dropped table under a view makes every later RENAME fail.
export function dropDepsSql(table) {
  const n = sqlString(table);
  return `CREATE TEMP TABLE drover_dep(n, CONSTRAINT ${DEP_GUARD} CHECK (n = 0)); INSERT OR ROLLBACK INTO temp.drover_dep VALUES ` +
    `((SELECT count(*) FROM main.sqlite_master WHERE type IN ('view', 'trigger') AND tbl_name <> ${n} COLLATE NOCASE AND instr(lower(sql), lower(${n})) > 0))`;
}
export const dropTableDdl = (table, shownSql) => ({ guard: schemaGuardSql(table, shownSql), deps: dropDepsSql(table), statement: `DROP TABLE ${quoteIdent(table)}` });
export function renameTableDdl(table, shownSql, to) {
  const name = newName(to, "table name");
  return { guard: schemaGuardSql(table, shownSql), statement: `ALTER TABLE ${quoteIdent(table)} RENAME TO ${quoteIdent(name)}` };
}
export function renameColumnDdl(table, shownSql, column, to) {
  const name = newName(to, "column name");
  return { guard: schemaGuardSql(table, shownSql, column), statement: `ALTER TABLE ${quoteIdent(table)} RENAME COLUMN ${quoteIdent(column)} TO ${quoteIdent(name)}` };
}
// The message a builder refused with (shown to the person), or null for any other error.
export const schemaRefusal = (e) => (e instanceof SchemaError ? e.message : null);

// Same session setup as writeScript; the guard (if any) runs first under the write lock.
// legacy_alter_table=OFF: some sqlite3 builds default it ON, and then a table rename leaves the
// views and triggers that use it pointing at the old name (and later ALTERs fail on them).
export function ddlScript({ guard, deps, statement }, safe = true) {
  return `${safe ? "" : "PRAGMA trusted_schema=OFF; "}PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF; PRAGMA busy_timeout=${WRITE_TIMEOUT_MS}; ` +
    `CREATE TEMP TABLE drover_schema(n, CONSTRAINT ${SCHEMA_GUARD} CHECK (n = 1)); BEGIN IMMEDIATE; ` +
    `${guard ? `${guard}; ` : ""}${deps ? `${deps}; ` : ""}${statement}; COMMIT;`;
}
export function ddlOutcome(code, stderr) {
  if (code !== 0 && String(stderr || "").includes(SCHEMA_GUARD)) return { ok: false, conflict: true, message: SCHEMA_NOTE };
  if (code !== 0 && String(stderr || "").includes(DEP_GUARD)) return { ok: false, message: DEP_NOTE };
  return writeOutcome(code, stderr);
}

// Can this entry's schema be changed (drop, rename, add column)? Plain tables only; unsure: no.
export function schemaEditable(meta) {
  return Boolean(meta) && meta.type === "table" && meta.kind === "table" && !/^sqlite_/i.test(meta.name ?? "") &&
    virtualInfo(meta.sql)?.virtual === false;
}

// "3.44.4" -> [3, 44, 4]; null when unreadable.
export function parseVersion(text) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text ?? ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}
export function versionAtLeast(v, min) {
  if (!v) return false;
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}

// A new database file name: { ok: true, name } (".sqlite" added unless it ends in .db/.sqlite/.sqlite3)
// or { ok: false, reason }. No path separators, NUL or other control characters, no leading ".".
export function dbFileName(input) {
  const s = String(input ?? "").trim();
  const no = (reason) => ({ ok: false, reason });
  if (s === "") return no("Type a name.");
  if (Array.from(s).length > MAX_DB_NAME) return no(`At most ${MAX_DB_NAME} characters.`);
  if (/[/\\]/.test(s)) return no("No / or \\ in the name.");
  if (s.includes("\0") || stripControl(s) !== s) return no("No control characters in the name.");
  if (s.startsWith(".")) return no("The name can't start with a dot.");
  return { ok: true, name: hasDbExtension(s) ? s : `${s}.sqlite` };
}

// ---------- TODO.md ----------

// A closing "#" run counts only after whitespace ("C#" keeps its "#"); a trailing "\#" is a literal "#".
const HEADING = /^##(?!#)[ \t]*(.*?)(?:[ \t]+#+)?[ \t]*$/;
const unescapeHeading = (name) => name.replace(/\\(#+)$/, "$1");
// Heading text for a typed value: a "#" run that would read as a closing sequence gets a backslash.
export const headingText = (value) => value.replace(/(^|[ \t])(#+)$/, "$1\\$2");
const ITEM = /^-[ \t]+\[([ xX])\][ \t]+(.*)$/;

// Columns from "##" headings; items before the first one go in "Todo" (line -1, raw null). `line` is
// the 0-based index into text.split("\n"), which is how toggleLine finds it again; a card's `end` is
// its last note line (its own line when it has none); a column's `line`/`raw` are its heading's.
export function parseTodo(text) {
  const lines = String(text).split("\n");
  const columns = [];
  let col = null, card = null;
  lines.forEach((raw, line) => {
    const l = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    // raw stays exactly as split (a CRLF line keeps its \r): toggleLine compares against it.
    const h = HEADING.exec(l);
    if (h) { col = { name: stripControl(unescapeHeading(h[1])) || "Untitled", line, raw, cards: [] }; columns.push(col); card = null; return; }
    const m = ITEM.exec(l);
    if (m) {
      if (!col) { col = { name: "Todo", line: -1, raw: null, cards: [] }; columns.push(col); }
      card = { line, raw, end: line, done: m[1] !== " ", text: stripControl(m[2]), notes: [] };
      col.cards.push(card);
      return;
    }
    if (card && /^[ \t]+\S/.test(l)) { card.notes.push(stripControl(l.trim())); card.end = line; return; }
    if (l.trim() !== "") card = null; // a paragraph or a "#" title ends the item's notes
  });
  return columns;
}

// Open cards first, done last; file order otherwise.
export function sortedCards(cards) {
  return [...cards.filter((c) => !c.done), ...cards.filter((c) => c.done)];
}

// TODO.md read with invalid UTF-8 comes back with U+FFFD; writing it back would change those bytes.
export const lossy = (text) => String(text ?? "").includes("\uFFFD");
export const LOSSY_NOTE = "TODO.md has bytes that are not UTF-8 (or a U+FFFD); the board is read-only.";

// Flips the box on line `line` of `text` if that line still reads exactly `expected` (as split on
// "\n", so a CRLF line includes its \r). Every other byte stays: line endings, the final newline,
// the rest of the line. Refused ({ ok: false, lossy: true }) when the text may have lost bytes.
export function toggleLine(text, line, expected) {
  if (lossy(text)) return { ok: false, lossy: true };
  const lines = String(text).split("\n");
  if (!Number.isInteger(line) || line < 0 || line >= lines.length) return { ok: false };
  const current = lines[line];
  if (current !== expected) return { ok: false };
  const m = /^(-[ \t]+\[)([ xX])(\][ \t]+)/.exec(current);
  if (!m) return { ok: false };
  const done = m[2] === " ";
  lines[line] = m[1] + (done ? "x" : " ") + current.slice(m[1].length + 1);
  return { ok: true, text: lines.join("\n"), done };
}

// ---------- TODO.md edits ----------
// Each transform re-parses the text it is given, checks that the lines the board drew are still
// there (by index and exact text), and returns { ok: true, text } or { ok: false } (or lossy).
// Every line it does not add, remove or rewrite stays byte-identical, line endings included.

export const MAX_INPUT = 500;
export const STARTER_TODO = "## Todo\n\n## Doing\n\n## Done\n";
export const starterTodo = () => STARTER_TODO;

// What a person typed, as one line of plain text: no control characters or line breaks, trimmed,
// at most MAX_INPUT characters. null when nothing is left.
export function cleanInput(s) {
  const one = stripControl(String(s ?? "").slice(0, 8 * MAX_INPUT)).trim();
  const chars = Array.from(one);
  const out = (chars.length > MAX_INPUT ? chars.slice(0, MAX_INPUT).join("") : one).trim();
  return out === "" ? null : out;
}

// The file as pieces that each keep their own "\n"; index i is line i of text.split("\n").
const pieces = (text) => (text === "" ? [] : String(text).split(/(?<=\n)/));
const bare = (p) => (p.endsWith("\n") ? p.slice(0, -1) : p);
const crOf = (text) => (String(text).includes("\r\n") ? "\r" : "");

// Inserts pieces (each ending in "\n") before piece `at`. After a last line with no newline, that
// line gets one (`cr` + "\n") and the file still ends without one.
function insertPieces(ps, at, add, cr) {
  add = [...add];
  if (at >= ps.length && ps.length && !ps[ps.length - 1].endsWith("\n")) {
    ps[ps.length - 1] += cr + "\n";
    add[add.length - 1] = bare(add[add.length - 1]).replace(/\r$/, "");
  }
  ps.splice(Math.min(at, ps.length), 0, ...add);
  return ps;
}
const insertLines = (ps, at, lines, cr) => insertPieces(ps, at, lines.map((l) => l + cr + "\n"), cr);
// The ending a new line next to piece `i` takes: that line's own, else the file's.
const crNear = (ps, i, text) => (ps[i]?.endsWith("\r\n") ? "\r" : ps[i]?.endsWith("\n") ? "" : crOf(text));

// Removes pieces from..to (inclusive). When that took the last line of a file with no final newline,
// the new last line loses its ending too.
function removeLines(ps, from, to) {
  const tail = to === ps.length - 1 && !ps[to].endsWith("\n");
  ps.splice(from, to - from + 1);
  if (tail && from > 0) ps[from - 1] = bare(ps[from - 1]).replace(/\r$/, "");
  return ps;
}

const findCard = (cols, line, raw) => {
  for (const c of cols) for (const k of c.cards) if (k.line === line && k.raw === raw) return k;
  return null;
};
// A column by its heading ({ line, raw }); the implicit "Todo" column is { line: -1 }.
const findColumn = (cols, line, raw) => (line === -1 ? cols.find((c) => c.line === -1) : cols.find((c) => c.line === line && c.raw === raw)) ?? null;
// Where a new last card of `col` goes: after its last card's notes, else right after its heading.
const columnEnd = (col) => (col.cards.length ? Math.max(...col.cards.map((k) => k.end)) + 1 : col.line + 1);
const cardLines = (ps, k) => ps.slice(k.line, k.end + 1).map(bare);

// The column's last card must be the one drawn (`last`: { line, raw, end }). Required when `need`.
const lastOk = (c, last, need = false) => {
  if (!last) return !need;
  const k = c.cards[c.cards.length - 1];
  return Boolean(k) && k.line === last.line && k.raw === last.raw && k.end === last.end;
};

// Adds "- [ ] text" as the last card of the column whose heading is { line, raw }.
export function addCard(text, col, input) {
  if (lossy(text)) return { ok: false, lossy: true };
  const value = cleanInput(input);
  if (value === null || !col) return { ok: false };
  const c = findColumn(parseTodo(text), col.line, col.raw);
  if (!c || (c.line === -1 && !c.cards.length)) return { ok: false };
  // The implicit column has no heading to check: its drawn last card must still be its last.
  if (c.line === -1 && !lastOk(c, col.last, true)) return { ok: false };
  const ps = pieces(text), at = columnEnd(c);
  return { ok: true, text: insertLines(ps, at, [`- [ ] ${value}`], crNear(ps, at - 1, text)).join("") };
}

// Replaces the text of card { line, raw }; its bullet, spacing, box and notes stay.
export function editCard(text, card, input) {
  if (lossy(text)) return { ok: false, lossy: true };
  const value = cleanInput(input);
  if (value === null || !card) return { ok: false };
  const k = findCard(parseTodo(text), card.line, card.raw);
  if (!k) return { ok: false };
  const cr = k.raw.endsWith("\r") ? "\r" : "";
  const m = /^(-[ \t]+\[[ xX]\][ \t]+)/.exec(k.raw);
  if (!m) return { ok: false };
  const ps = pieces(text);
  const nl = ps[k.line].endsWith("\n") ? "\n" : "";
  ps[k.line] = m[1] + value + cr + nl;
  return { ok: true, text: ps.join("") };
}

// Removes card { line, raw } and its note lines (which must still read `notes`, if given).
export function deleteCard(text, card) {
  if (lossy(text)) return { ok: false, lossy: true };
  if (!card) return { ok: false };
  const k = findCard(parseTodo(text), card.line, card.raw);
  const ps = pieces(text);
  if (!k || (card.block && JSON.stringify(cardLines(ps, k)) !== JSON.stringify(card.block))) return { ok: false };
  return { ok: true, text: removeLines(ps, k.line, k.end).join("") };
}

// Moves card { line, raw } with its notes to the end of the column whose heading is `to`.
export function moveCard(text, card, to) {
  if (lossy(text)) return { ok: false, lossy: true };
  if (!card || !to) return { ok: false };
  const cols = parseTodo(text);
  const k = findCard(cols, card.line, card.raw), dest = findColumn(cols, to.line, to.raw);
  if (!k || !dest || (dest.line === -1 && !dest.cards.length)) return { ok: false };
  const ps = pieces(text);
  const block = cardLines(ps, k);
  if (card.block && JSON.stringify(block) !== JSON.stringify(card.block)) return { ok: false };
  if (dest.cards.includes(k)) return { ok: false };
  if (dest.line === -1 && !lastOk(dest, to.last)) return { ok: false };
  // The moved lines keep their own endings; one that ended the file gets the file's.
  const cr = crOf(text);
  const moved = ps.slice(k.line, k.end + 1).map((p) => (p.endsWith("\n") ? p : p + cr + "\n"));
  let at = columnEnd(dest);
  const destCr = crNear(ps, at - 1, text);
  removeLines(ps, k.line, k.end);
  if (at > k.end) at -= k.end - k.line + 1;
  return { ok: true, text: insertPieces(ps, at, moved, destCr).join("") };
}

// Appends a "## name" column at the end of the file.
export function addColumn(text, input) {
  if (lossy(text)) return { ok: false, lossy: true };
  const value = cleanInput(input);
  if (value === null) return { ok: false };
  const s = String(text), eol = crOf(s) + "\n";
  const head = `## ${headingText(value)}`;
  if (s === "") return { ok: true, text: head + eol };
  // No final newline stays missing, as in addCard and moveCard.
  return { ok: true, text: s.endsWith("\n") ? `${s}${eol}${head}${eol}` : `${s}${eol}${eol}${head}` };
}

// Renames the column whose heading is { line, raw }; the "##" and its spacing stay.
export function renameColumn(text, col, input) {
  if (lossy(text)) return { ok: false, lossy: true };
  const value = cleanInput(input);
  if (value === null || !col || col.line < 0) return { ok: false };
  const c = findColumn(parseTodo(text), col.line, col.raw);
  if (!c) return { ok: false };
  const m = /^(##[ \t]*)/.exec(c.raw);
  const cr = c.raw.endsWith("\r") ? "\r" : "";
  const ps = pieces(text);
  const nl = ps[c.line].endsWith("\n") ? "\n" : "";
  ps[c.line] = m[1] + (m[1] === "##" ? " " : "") + headingText(value) + cr + nl;
  return { ok: true, text: ps.join("") };
}

// A real column (not the implicit "Todo") as a section: its heading line up to the next "##" or EOF.
// `col` is a { line, raw } heading ref (optionally `block`: the drawn section lines, `count`: its
// top-level cards) or an index into parseTodo(text). Returns { cols, k, c, from, to } or null.
function sectionOf(text, col) {
  const cols = parseTodo(text);
  let k = -1;
  if (Number.isInteger(col)) k = col;
  else if (col && Number.isInteger(col.line) && col.line >= 0) k = cols.findIndex((c) => c.line === col.line && c.raw === col.raw);
  const c = cols[k];
  if (!c || c.line < 0) return null;
  const nextCol = cols[k + 1];
  const total = pieces(text).length;
  return { cols, k, c, from: c.line, to: (nextCol ? nextCol.line : total) - 1 };
}
const sameLines = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Swaps column `col` with its neighbour: dir -1 (left) or +1 (right). The whole section moves (heading,
// cards, notes, blank lines). The implicit "Todo" column neither moves nor can be passed.
export function moveColumn(text, col, dir) {
  if (lossy(text)) return { ok: false, lossy: true };
  if (dir !== -1 && dir !== 1) return { ok: false };
  const s = sectionOf(text, col);
  if (!s) return { ok: false };
  const other = s.cols[s.k + dir];
  if (!other || other.line < 0) return { ok: false };
  const ps = pieces(text);
  if (col && typeof col === "object" && col.block && !sameLines(ps.slice(s.from, s.to + 1).map(bare), col.block)) return { ok: false };
  const o = sectionOf(text, s.k + dir);
  const [a, b] = dir === -1 ? [o, s] : [s, o]; // a is the earlier section
  const last = ps.length - 1;
  const noNl = !ps[last].endsWith("\n");
  if (noNl) ps[last] += crNear(ps, last - 1, text) + "\n";
  const first = ps.slice(a.from, a.to + 1), second = ps.slice(b.from, b.to + 1);
  ps.splice(a.from, b.to - a.from + 1, ...second, ...first);
  // The file still ends without a newline, unless its new last line is blank (that blank line stays).
  const end = bare(ps[ps.length - 1]).replace(/\r$/, "");
  if (noNl && end !== "") ps[ps.length - 1] = end;
  return { ok: true, text: ps.join("") };
}

// Removes column `col`: its heading and every line up to the next "##" or EOF (cards, notes, blanks).
export function deleteColumn(text, col) {
  if (lossy(text)) return { ok: false, lossy: true };
  const s = sectionOf(text, col);
  if (!s) return { ok: false };
  const ps = pieces(text);
  if (col && typeof col === "object") {
    if (col.block && !sameLines(ps.slice(s.from, s.to + 1).map(bare), col.block)) return { ok: false };
    if (Number.isInteger(col.count) && col.count !== s.c.cards.length) return { ok: false };
  }
  return { ok: true, text: removeLines(ps, s.from, s.to).join("") };
}

// Words with `code` and **bold** marked, each token one wrappable piece: {text, code?, bold?}.
export function inlineTokens(text) {
  const out = [];
  const plain = (s, bold) => {
    for (const w of s.split(/(?<=\s)/)) if (w !== "") out.push(bold ? { text: w, bold: true } : { text: w });
  };
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) plain(text.slice(last, m.index));
    if (m[1] !== undefined) out.push({ text: m[1], code: true });
    else plain(m[2], true);
    last = m.index + m[0].length;
  }
  if (last < text.length) plain(text.slice(last));
  return out;
}

// ---------- files ----------

// Paths (relative to the folder) whose real path is exactly <realDir>/<path>: no symlinked part, so
// nothing outside the folder. reals: what `realpath -- <paths…>` printed, one per line.
export function realInside(realDir, paths, reals) {
  const dir = String(realDir ?? "").replace(/\/+$/, "");
  if (!dir.startsWith("/")) return [];
  const seen = new Set(String(reals ?? "").split("\n").filter(Boolean));
  return paths.filter((p) => !p.includes("\n") && seen.has(`${dir}/${normalizePath(p)}`));
}

// ---------- polling ----------

export const POLL_MS = 15_000;

// Is the block for this view (props.view; sqlite when unset) shown? null when the layout has none.
export function visibleIn(node, mod, view) {
  const walk = (n, shown) => {
    if (!n || typeof n !== "object") return null;
    const here = shown && !n.hidden;
    if (n.content?.mod === mod && (n.content.props?.view === "todo" ? "todo" : "sqlite") === view) return here;
    let found = null;
    // A stack shows one child: its active one, else the first (as goto's shownMods).
    const pick = n.type === "stack" ? (n.children?.find((c) => c.id === n.active)?.id ?? n.children?.[0]?.id) : null;
    for (const c of n.children ?? []) {
      const r = walk(c, here && (n.type !== "stack" || c.id === pick));
      if (r === true) return true;
      if (r === false) found = false;
    }
    for (const f of n.floating ?? []) {
      const r = walk(f, here);
      if (r === true) return true;
      if (r === false) found = false;
    }
    return found;
  };
  return walk(node, true);
}
