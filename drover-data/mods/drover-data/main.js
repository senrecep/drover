// Data: two panel views chosen by props.view, both following the focused space's folder.
//   sqlite: a browser for the database files in that folder, read-only unless "Edit" is switched on
//           (off again on every mount and database switch). Edit mode writes only on a click or Enter:
//           insert a row, update one cell, delete a row (two clicks), each guarded (see logic.js).
//   todo:   a board drawn from TODO.md at that folder's root. Writes happen only on a click or Enter:
//           tick a box, add/edit/delete/move a card, add/rename a column, create a starter TODO.md.
//           Each one reads the file again, checks the lines it drew are unchanged, then writes.
// Programs it runs (all with argv arrays, never a shell):
//   git ls-files -co --exclude-standard -z     list files (sqlite view)
//   find                                        top-level listing, size and type checks
//   sqlite3 -readonly -init /dev/null [-safe] -json <file> <one SELECT/PRAGMA>
//   sqlite3 -init /dev/null [-safe] -bail -json <file> <one guarded write>   edit mode only
//   realpath -- <folder> <files…>              no file behind a symlinked folder
// A light 1 s timer notices a new space or folder and whether this copy is shown (no programs run
// for that); it reads again no faster than every 15 s, and not at all while hidden or while the
// window is in the background. render only draws.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, spaces, panes, focused, theme, readTextFile, writeTextFile, window, layout, props } from "herdr";
import {
  POLL_MS, MAX_DB_FILES, formatCell, stripControl, filterDbFiles, splitNul, sizeCheckArgs, topLevelArgs, normalizePath,
  listSql, listSqlPlain, viewPlanSql, viewPlanOk, VTAB_REFUSED, infoSql, countSql, pageSql, pageSize, CUT_NOTE, sqliteArgs,
  parseSchema, parseInfo, parseCount, parsePage, sqliteProblem, parseTodo, sortedCards, toggleLine, inlineTokens,
  lossy, LOSSY_NOTE, realInside,
  tableMeta, xinfoSql, parseXinfo, editability, editPageSql, parseEditPage, cellLock, cellPrefill, sqlLiteral,
  insertSql, updateSql, deleteSql, writeScript, writeArgs, writeOutcome, NUL_NOTE, safePath,
  COL_TYPES, RENAME_COLUMN_MIN, RENAME_COLUMN_NOTE, newName, createTableDdl, addColumnDdl, dropTableDdl, renameTableDdl,
  renameColumnDdl, schemaRefusal, ddlScript, ddlOutcome, schemaEditable, parseVersion, versionAtLeast, dbFileName,
  visibleIn, cleanInput, addCard, editCard, deleteCard, moveCard, addColumn, renameColumn, moveColumn, deleteColumn, starterTodo,
} from "./logic.js";

const MOD = "drover-data";
const COUNT_TIMEOUT = 2000;
const COUNT_BUDGET = 20_000;
const MAX_COUNTED = 100;
const COL_W = 140;
const TODO_FILE = "TODO.md";
const TODO_MAX = 1048576;
const TICK_MS = 1000;
const OUTPUT_CAP = 8 * 1024 * 1024 - 4096; // exec's 8 MiB output limit, less a margin
const NO_TODO = "No TODO.md in this folder.";
const ARM_MS = 4000;
const CHANGED_NOTE = "TODO.md changed; reloaded";
const ACT_W = 84;
// The SQLite view's single-field editors (all on this.input).
const SQL_EDITS = ["cell", "rename-table", "rename-col", "create-db"];

// Shown and the window in front. Not in the layout: a mod pane in the focused tab counts (a pane
// can't tell which view it holds); anything else is not live, so nothing is read.
function live(view) {
  if (!window()?.active) return false;
  const shown = visibleIn(layout(), MOD, view);
  if (shown !== null) return shown;
  const tab = focused()?.tab;
  return Boolean(tab) && (panes() ?? []).some((p) => p.mod === MOD && p.tab === tab);
}

function location() {
  const space = spaces().find((s) => s.active) ?? null, f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || "", on, space: space?.id ?? null };
}
const contextKey = () => JSON.stringify(location());

class DataError extends Error {}

export default class Data extends View {
  init(_props, cx) {
    this.view = props()?.view === "todo" ? "todo" : "sqlite";
    this.key = null;
    this.seq = 0;
    this.pageSeq = 0;
    this.safe = null; // does this sqlite3 take -safe; null until probed
    this.sqliteVersion = null; // [major, minor, patch] once probed
    this.ddlInputs = []; this.ddlNext = 0; // the create-table / add-column fields, made on first use and reused
    this.pendingDb = null; // a database just created, chosen once the listing shows it
    this.pendingDbNote = null; // a create-database refusal, kept across the reload it triggers
    this.dormant = true;
    this.lastLoad = 0;
    this.editGen = 0;
    this.focusedGen = null; this.inputFocused = false;
    // One text field for every editor on the board (only one is open at a time).
    this.input = InputState.new({ placeholder: "Enter saves, Esc cancels" });
    this.input.on("submit", (_e, cx) => this.submitEdit(cx));
    this.input.on("focus", () => { this.inputFocused = true; this.focusedGen = this.edit?.gen ?? null; });
    // Leaving the field cancels only the editor it was focused for.
    this.input.on("blur", (_e, cx) => {
      this.inputFocused = false;
      // (todo only: the SQLite cell editor has a "Set NULL" button next to it, and closes with Esc or Cancel)
      if (this.view === "todo" && this.edit && this.edit.gen === this.focusedGen) { this.edit = null; cx.notify(); }
    });
    this.handle = cx.focus_handle();
    this.fieldInputs = []; // the insert form's fields, made on first use and reused
    this.reset();
    this.tasks = [cx.timer.every(TICK_MS, (cx) => this.tick(cx))];
    this.tick(cx);
  }

  // A new place starts over; shown again reads now; otherwise every POLL_MS while shown.
  tick(cx) {
    const key = contextKey(), on = live(this.view);
    if (key !== this.key) {
      this.key = key;
      this.reset();
      this.dormant = !on;
      if (on) this.load(cx, true);
      cx.notify();
      return;
    }
    if (!on) { this.dormant = true; return; }
    if (this.dormant) { this.dormant = false; this.load(cx, true); return; }
    if (Date.now() - this.lastLoad >= POLL_MS) this.load(cx, false);
  }

  async close() {
    for (const task of this.tasks) task.cancel();
  }

  reset() {
    this.seq++; this.pageSeq++;
    this.note = null; this.error = null; this.loaded = false; this.busy = false;
    // sqlite
    this.files = null; this.file = null; this.pickerOpen = false;
    this.schema = null; this.counts = {}; this.table = null; this.info = null; this.rows = null; this.page = 0; this.pageBusy = false;
    this.meta = null; this.editMode = false; this.editInfo = null; this.rowMeta = null; this.pageLen = null; this.writeNote = null;
    this.insert = null; this.creating = null; this.addCol = null; this.dropTarget = null;
    // todo
    this.columns = null; this.lines = null; this.writing = false; this.readOnly = false; this.missing = false;
    this.edit = null; this.armed = null;
    this.viewChecks = new Map(); this.viewSig = null;
  }

  refresh(cx) {
    this.note = null; this.busy = false;
    this.load(cx, true);
    cx.notify();
  }

  load(cx, force) {
    this.lastLoad = Date.now();
    if (this.view === "todo") this.loadTodo(cx);
    else this.loadFiles(cx, force);
  }

  // ---------- sqlite ----------

  async probe(cwd) {
    if (this.safe !== null) return;
    // The version decides whether RENAME COLUMN (3.25+) is offered.
    try {
      const a = await exec("sqlite3", ["-safe", "-readonly", ":memory:", "select sqlite_version()"], { cwd, timeout: 10_000 });
      if (a.code === 0) { this.sqliteVersion = parseVersion(a.stdout); this.safe = true; return; }
      const b = await exec("sqlite3", ["-readonly", ":memory:", "select sqlite_version()"], { cwd, timeout: 10_000 });
      if (b.code === 0) { this.sqliteVersion = parseVersion(b.stdout); this.safe = false; return; }
    } catch {}
    throw new DataError("sqlite3 is not installed or does not run.");
  }

  async runSql(cwd, db, sql, timeout = 10_000) {
    let r;
    try {
      r = await exec("sqlite3", sqliteArgs(db, sql, this.safe), { cwd, timeout });
    } catch (e) {
      // exec keeps at most 8 MiB of output; however it reports going over, say so plainly.
      if (/output|limit|large|exceed|truncat|MiB|buffer/i.test(String(e))) throw new DataError(CUT_NOTE);
      throw new DataError(/time/i.test(String(e)) ? "sqlite3 took too long." : "sqlite3 is not installed or could not start.");
    }
    if (String(r.stdout ?? "").length >= OUTPUT_CAP) throw new DataError(CUT_NOTE);
    if (r.code !== 0) throw new DataError(sqliteProblem(r.stderr) ?? "sqlite3 could not read this database.");
    return r.stdout;
  }

  // Paths whose real path is exactly <real folder>/<path>: a symlinked part (a folder or the file)
  // could lead outside the folder, so such a file is left out.
  async realOnly(cwd, names) {
    if (!names.length) return [];
    const r = await exec("realpath", ["--", ".", ...names.map((n) => `./${normalizePath(n)}`)], { cwd, timeout: 15_000 }).catch(() => null);
    const lines = String(r?.stdout ?? "").split("\n");
    return realInside(lines[0], names, lines.slice(1).join("\n"));
  }

  loadFiles(cx, force) {
    const { cwd, on } = location(), key = this.key;
    if (!cwd || on) { this.loaded = true; return; }
    if (this.busy) return;
    this.busy = true;
    const seq = ++this.seq;
    this.busyId = seq;
    const stale = () => key !== this.key || seq !== this.seq;
    cx.spawn(async (cx) => {
      try {
        let names = [];
        const g = await exec("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd, timeout: 15_000 }).catch(() => null);
        if (g && g.code === 0) names = filterDbFiles(splitNul(g.stdout));
        else {
          const f = await exec("find", topLevelArgs(), { cwd, timeout: 15_000 }).catch(() => null);
          names = filterDbFiles(splitNul(f?.stdout).map(normalizePath).sort());
        }
        let files = [];
        if (names.length) {
          const ok = await exec("find", sizeCheckArgs(names), { cwd, timeout: 15_000 }).catch(() => null);
          const set = new Set(splitNul(ok?.stdout).map(normalizePath));
          files = await this.realOnly(cwd, names.filter((n) => set.has(n) && !n.includes("\n")).slice(0, MAX_DB_FILES));
        }
        if (stale()) return;
        this.files = files;
        this.error = null;
        // A database just created: open it, or say why it isn't listed.
        let made = null, madeNote = null;
        if (this.pendingDb) {
          made = files.includes(this.pendingDb) ? this.pendingDb : null;
          madeNote = made ? `Created ${stripControl(made)}` : `Created ${stripControl(this.pendingDb)}, but the listing doesn't show it (ignored by git?).`;
          this.pendingDb = null;
        } else if (this.pendingDbNote) {
          madeNote = this.pendingDbNote;
        }
        this.pendingDbNote = null;
        if (!files.includes(this.file) || (made && made !== this.file)) {
          this.file = made ?? files[0] ?? null; this.schema = null; this.counts = {}; this.table = null; this.info = null; this.rows = null; this.page = 0;
          // another database now: edit mode is off again, like a switch from the picker
          this.editMode = false; this.closeEditors(); this.writeNote = null; this.editInfo = null; this.rowMeta = null; this.meta = null;
        }
        if (madeNote) this.writeNote = madeNote;
        this.loaded = true;
        cx.notify();
        if (this.file) await this.loadSchema(cx, cwd, force, stale);
      } catch (e) {
        if (!stale()) { this.error = e instanceof DataError ? e.message : "Could not list the database files."; this.loaded = true; }
      } finally {
        if (this.busyId === seq) this.busy = false;
        cx.notify();
      }
    });
  }

  async loadSchema(cx, cwd, force, stale) {
    const db = this.file;
    try {
      await this.probe(cwd);
      let listed;
      try { listed = await this.runSql(cwd, db, listSql()); }
      catch { listed = await this.runSql(cwd, db, listSqlPlain()); } // no pragma_table_list: unsure tables are refused
      const schema = parseSchema(listed);
      const meta = tableMeta(listed);
      // Views: read only when their plan uses no virtual table. At most MAX_COUNTED are checked
      // here (the rest when chosen); results are kept only while the whole schema is unchanged.
      const sig = `${db}\0${listed}`;
      if (this.viewSig !== sig) { this.viewSig = sig; this.viewChecks = new Map(); }
      let views = 0;
      for (const s of schema) {
        if (s.type !== "view") continue;
        const known = this.viewChecks.get(s.name);
        if (known) { Object.assign(s, known); continue; }
        if (views++ < MAX_COUNTED) await this.checkView(cwd, db, s);
      }
      if (stale() || db !== this.file) return;
      this.schema = schema; this.meta = meta; this.error = null;
      if (this.table && !schema.some((s) => s.name === this.table)) { this.table = null; this.info = null; this.rows = null; this.page = 0; }
      cx.notify();
      if (this.table) this.loadPage(cx, cwd, db, this.table, this.page);
      // Counts: one query each, two seconds at most; a slow table shows "—". They are not repeated on timer ticks.
      const started = Date.now();
      for (const s of schema.slice(0, MAX_COUNTED)) {
        if (stale() || db !== this.file) return;
        if (s.refused || !s.checked) { this.counts[s.name] = null; continue; }
        if (!force && s.name in this.counts) continue;
        if (Date.now() - started > COUNT_BUDGET) { this.counts[s.name] = null; continue; }
        try { this.counts[s.name] = parseCount(await this.runSql(cwd, db, countSql(s.name), COUNT_TIMEOUT)); }
        catch { this.counts[s.name] = null; }
        cx.notify();
      }
      for (const s of schema.slice(MAX_COUNTED)) this.counts[s.name] = null;
      cx.notify();
    } catch (e) {
      if (stale() || db !== this.file) return;
      this.schema = null;
      this.error = e instanceof DataError ? e.message : "Could not read this database.";
    }
  }

  // Marks a view checked, or refused when its plan touches a virtual table or can't be made.
  async checkView(cwd, db, entry) {
    if (entry.checked || entry.refused) return;
    let ok = false;
    try { ok = viewPlanOk(await this.runSql(cwd, db, viewPlanSql(entry.name), COUNT_TIMEOUT)); } catch {}
    if (ok) entry.checked = true;
    else entry.refused = "not shown (view over a virtual table)";
    if (this.viewSig?.startsWith(`${db}\0`)) this.viewChecks.set(entry.name, { checked: entry.checked, refused: entry.refused });
  }

  chooseFile(file, cx) {
    if (file === this.file) { this.pickerOpen = false; cx.notify(); return; }
    this.pageSeq++;
    this.file = file; this.pickerOpen = false; this.schema = null; this.counts = {}; this.table = null; this.info = null; this.rows = null; this.page = 0; this.error = null;
    this.editMode = false; this.closeEditors(); this.writeNote = null; this.editInfo = null; this.rowMeta = null;
    this.busy = false;
    this.loadFiles(cx, true);
    cx.notify();
  }

  chooseTable(name, cx) {
    // Only a name that came from sqlite_schema is ever used in SQL, and never a refused one.
    const entry = this.schema?.find((s) => s.name === name);
    if (!entry) return;
    this.pageSeq++;
    this.table = name; this.info = null; this.rows = null; this.page = 0; this.note = entry.refused;
    this.closeEditors(); this.writeNote = null; this.editInfo = null; this.rowMeta = null;
    if (entry.refused) { this.pageBusy = false; cx.notify(); return; }
    const { cwd } = location();
    this.loadPage(cx, cwd, this.file, name, 0);
    cx.notify();
  }

  loadPage(cx, cwd, db, table, page) {
    const key = this.key, seq = ++this.pageSeq;
    this.pageBusy = true;
    cx.spawn(async (cx) => {
      const stale = () => key !== this.key || seq !== this.pageSeq;
      try {
        const entry = this.schema?.find((s) => s.name === table);
        if (!entry || entry.refused) throw new DataError(entry?.refused ?? VTAB_REFUSED);
        await this.probe(cwd);
        await this.checkView(cwd, db, entry);
        if (!entry.checked) throw new DataError(entry.refused ?? VTAB_REFUSED);
        const info = parseInfo(await this.runSql(cwd, db, infoSql(table)));
        if (stale()) return;
        if (!info.length) { this.info = info; this.rows = []; this.rowMeta = null; this.editInfo = null; this.note = "This table has no readable columns."; this.page = page; return; }
        // Edit mode: can this table be written, and how is a row found (rowid or primary key)?
        let edit = null;
        if (this.editMode) {
          const meta = this.meta?.get(table) ?? null;
          const xinfo = meta?.type === "table" && meta.kind === "table" ? parseXinfo(await this.runSql(cwd, db, xinfoSql(table))) : null;
          edit = editability(meta, xinfo);
          if (stale()) return;
        }
        const names = info.map((c) => c.name);
        let rows, rowMeta = null, size;
        if (edit?.ok) {
          const keyCount = edit.key.kind === "rowid" ? 1 : edit.key.columns.length;
          size = pageSize(info.length * 2 + keyCount); // each cell may come twice (shown and as a literal)
          rowMeta = parseEditPage(await this.runSql(cwd, db, editPageSql(table, names, edit.key, size, page * size)), info.length, keyCount);
          rows = rowMeta.map((m) => m.cells);
        } else {
          size = pageSize(info.length);
          rows = parsePage(await this.runSql(cwd, db, pageSql(table, names, size, page * size)), info.length);
        }
        if (stale()) return;
        this.info = info; this.rows = rows; this.rowMeta = rowMeta; this.editInfo = edit; this.pageLen = size; this.page = page; this.note = null;
      } catch (e) {
        if (!stale()) {
          this.rows = null; this.info = null; this.rowMeta = null; this.editInfo = null;
          this.note = e instanceof DataError ? e.message : e?.message === CUT_NOTE ? CUT_NOTE : "Could not read this table.";
        }
      } finally {
        if (!stale()) this.pageBusy = false;
        cx.notify();
      }
    });
  }

  goPage(delta, cx) {
    if (!this.table || this.pageBusy) return;
    const next = this.page + delta;
    if (next < 0) return;
    this.closeEditors();
    this.loadPage(cx, location().cwd, this.file, this.table, next);
    cx.notify();
  }

  pageRows() {
    return this.pageLen ?? pageSize(this.info?.length ?? 1);
  }

  hasNext() {
    const size = this.pageRows();
    if (!this.rows || this.rows.length < size) return false;
    const n = this.counts[this.table];
    return n == null ? true : (this.page + 1) * size < n;
  }

  // ---------- sqlite edit mode ----------
  // Rows are found by the key literals read with the page (rowid or primary key, from sqlite's quote()),
  // never by their place on the page, so a reload while an editor is open can't retarget it.

  toggleEditMode(cx) {
    if (this.writing) return;
    this.editMode = !this.editMode;
    this.closeEditors(); this.writeNote = null; this.editInfo = null; this.rowMeta = null;
    if (this.table && !this.schema?.find((s) => s.name === this.table)?.refused) this.loadPage(cx, location().cwd, this.file, this.table, 0);
    cx.notify();
  }

  closeEditors() {
    if (SQL_EDITS.includes(this.edit?.kind)) this.edit = null;
    this.armed = null; this.dropTarget = null;
    this.insert = null; this.creating = null; this.addCol = null;
  }

  editable() {
    return this.view === "sqlite" && this.editMode && Boolean(this.editInfo?.ok) && Array.isArray(this.rowMeta);
  }

  // One retained field per insert-form column, made on first use (an event handler) and reused.
  fieldInput(i) {
    while (this.fieldInputs.length <= i) {
      const state = InputState.new({ placeholder: "empty: default" });
      state.on("submit", (_e, cx) => this.submitInsert(cx));
      this.fieldInputs.push(state);
    }
    return this.fieldInputs[i];
  }

  openInsert(cx) {
    if (this.writing || !this.editable() || !this.info?.length) return;
    const gen = ++this.editGen;
    const fields = this.info.map((c, i) => {
      const input = this.fieldInput(i);
      input.set_value("");
      return { column: c.name, type: c.type, input, isNull: false };
    });
    this.edit = null; this.armed = null; this.writeNote = null;
    this.insert = { gen, table: this.table, file: this.file, fields };
    fields[0].input.focus();
    cx.timer.after(60, () => { if (this.insert?.gen === gen) this.insert.fields[0].input.focus(); });
    cx.notify();
  }

  cancelInsert(cx) {
    this.insert = null;
    cx.notify();
  }

  submitInsert(cx) {
    const ins = this.insert;
    if (!ins) return;
    if (this.writing) { this.writeNote = "Busy saving; press Enter again."; cx.notify(); return; }
    const fields = [];
    for (const f of ins.fields) {
      if (f.isNull) { fields.push({ column: f.column, literal: "NULL" }); continue; }
      const value = f.input.value();
      if (value === "") continue; // left empty: the column's default (or NULL) applies
      try { fields.push({ column: f.column, literal: sqlLiteral(value, f.type) }); }
      catch { this.writeNote = NUL_NOTE; cx.notify(); return; }
    }
    this.writeRow(cx, () => insertSql(ins.table, fields), "1 row inserted", ins, () => { if (this.insert === ins) this.insert = null; });
  }

  // Double-click on a cell: an editor prefilled with the stored value (not the cut, cleaned display).
  openCell(cx, r, c) {
    const meta = this.rowMeta?.[r], col = this.info?.[c];
    if (!this.editable() || this.writing || !meta?.keys || !col) return;
    const raw = this.rows[r][c];
    const lock = cellLock(raw, meta.checks[c]);
    if (lock) { this.writeNote = `${lock}: not editable here.`; cx.notify(); return; }
    this.insert = null; this.writeNote = null;
    const prefill = cellPrefill(raw);
    this.openEditor(cx, "cell", {
      table: this.table, file: this.file, key: this.editInfo.key, keys: meta.keys, col: c,
      column: col.name, type: col.type, old: meta.checks[c], prefill,
    }, prefill);
  }

  saveCell(cx, e, value, isNull) {
    if (!e || e.kind !== "cell") return;
    if (this.writing) { this.writeNote = "Busy saving; press Enter again."; cx.notify(); return; }
    if (!isNull && value === e.prefill) { this.edit = null; cx.notify(); return; } // unchanged: nothing to write
    let literal;
    try { literal = sqlLiteral(value, e.type, isNull); }
    catch { this.writeNote = NUL_NOTE; cx.notify(); return; }
    this.edit = null;
    this.writeRow(cx, () => updateSql(e.table, e.key, e.keys, e.column, e.old, literal), "1 row updated", e);
  }

  // First click arms, a second click on the same row deletes it (only while it still reads as shown).
  removeRow(r, cx) {
    const meta = this.rowMeta?.[r];
    if (!this.editable() || this.writing || !meta?.keys) return;
    const id = `${this.table}\0${meta.keys.join("\0")}`;
    if (this.armed !== id) {
      this.armed = id; this.edit = null; this.insert = null; this.writeNote = null; cx.notify();
      cx.timer.after(ARM_MS, () => { if (this.armed === id) { this.armed = null; cx.notify(); } });
      return;
    }
    const key = this.editInfo.key, table = this.table;
    const checks = this.info.map((c, i) => ({ column: c.name, literal: meta.checks[i] }));
    this.writeRow(cx, () => deleteSql(table, key, meta.keys, checks), "1 row deleted", { table, file: this.file });
  }

  // The one SQLite write path: only from a click or Enter, only in edit mode, only on the file and
  // table that were drawn, only while that file is still a regular file inside the folder. Then the
  // list, counts and page are read again.
  // ddl: build returns { guard, statement } for ddlScript (schema changes, guarded by the drawn schema).
  writeRow(cx, build, doneNote, target, onDone, ddl = false) {
    if (this.writing || !this.editMode) return;
    const { cwd, on } = location(), key = this.key, file = target.file;
    if (!cwd || on || !file || file !== this.file || target.table !== this.table || !this.files?.includes(file)) return;
    let statement;
    try { statement = build(); }
    catch (e) { this.writeNote = schemaRefusal(e) ?? "Could not build that change; nothing written."; cx.notify(); return; }
    this.writing = true; this.armed = null; this.writeNote = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let note;
      try {
        await this.probe(cwd);
        const ok = await exec("find", sizeCheckArgs([file]), { cwd, timeout: 15_000 }).catch(() => null);
        const still = new Set(splitNul(ok?.stdout).map(normalizePath)).has(file);
        if (!still || (await this.realOnly(cwd, [file])).length !== 1) throw new DataError("The database file moved or leads outside this folder; nothing written.");
        let r;
        const script = ddl ? ddlScript(statement, this.safe === true) : writeScript(statement, this.safe === true);
        try { r = await exec("sqlite3", writeArgs(file, script, this.safe), { cwd, timeout: 15_000 }); }
        catch (e) { throw new DataError(/time/i.test(String(e)) ? "sqlite3 took too long." : "sqlite3 is not installed or could not start."); }
        const out = ddl ? ddlOutcome(r.code, r.stderr) : writeOutcome(r.code, r.stderr);
        note = out.ok ? doneNote : out.message;
        if (out.ok) onDone?.();
      } catch (e) {
        note = e instanceof DataError ? e.message : "Could not change the database.";
      } finally {
        this.writing = false;
        if (key === this.key && file === this.file) { this.writeNote = note; this.busy = false; this.loadFiles(cx, true); }
        cx.notify();
      }
    });
  }

  // ---------- sqlite schema changes (edit mode) ----------
  // Each change to an existing table carries the CREATE text drawn when its editor opened (or the drop
  // armed); the write checks it is still the same (logic.js ddlScript), else "Schema changed; reloaded".

  // The selected table as drawn, when its schema may be changed: { table, sql } or null.
  ddlTarget() {
    const meta = this.table ? this.meta?.get(this.table) : null;
    return this.editMode && schemaEditable(meta) && meta.name === this.table ? { table: meta.name, sql: meta.sql } : null;
  }

  renameColumnOk() {
    return versionAtLeast(this.sqliteVersion, RENAME_COLUMN_MIN);
  }

  // The next retained field of the create-table / add-column forms (made in an event handler, reused).
  ddlInput(placeholder) {
    if (this.ddlNext >= this.ddlInputs.length) {
      const state = InputState.new({ placeholder });
      state.on("submit", (_e, cx) => { if (this.creating) this.submitCreate(cx); else if (this.addCol) this.submitAddCol(cx); });
      this.ddlInputs.push(state);
    }
    const input = this.ddlInputs[this.ddlNext++];
    input.set_value("");
    return input;
  }
  ddlRow(name = "", type = "TEXT", pk = false) {
    const row = { name: this.ddlInput("column name"), type, pk, notNull: false, def: this.ddlInput("default (empty: none)"), defNull: false };
    row.name.set_value(name);
    return row;
  }

  // After a schema change: show this table (or none) from the first page.
  selectAfter(name) {
    this.table = name; this.info = null; this.rows = null; this.page = 0; this.note = null;
    this.editInfo = null; this.rowMeta = null;
  }

  // + Table: a name and column rows; starts with "id INTEGER PRIMARY KEY" and one empty row.
  openCreate(cx) {
    if (this.writing || !this.editMode || !this.schema) return;
    this.closeEditors(); this.writeNote = null;
    this.ddlNext = 0;
    const gen = ++this.editGen;
    const name = this.ddlInput("table name");
    this.creating = { gen, file: this.file, table: this.table, name, rows: [this.ddlRow("id", "INTEGER", true), this.ddlRow()] };
    name.focus();
    cx.timer.after(60, () => { if (this.creating?.gen === gen) this.creating.name.focus(); });
    cx.notify();
  }

  addCreateRow(cx) {
    if (!this.creating) return;
    this.creating.rows.push(this.ddlRow());
    cx.notify();
  }

  // A row nobody touched (no name, default, PK, NOT NULL or NULL default) is left out.
  submitCreate(cx) {
    const form = this.creating;
    if (!form) return;
    if (this.writing) { this.writeNote = "Busy saving; press Enter again."; cx.notify(); return; }
    const untouched = (r) => r.name.value().trim() === "" && r.def.value() === "" && !r.pk && !r.notNull && !r.defNull;
    const columns = form.rows.filter((r) => !untouched(r)).map((r) => ({
      name: r.name.value(), type: r.type, pk: r.pk, notNull: r.notNull, def: { value: r.def.value(), isNull: r.defNull },
    }));
    let made;
    try { made = newName(form.name.value(), "table name"); }
    catch (e) { this.writeNote = schemaRefusal(e) ?? "Could not build that change; nothing written."; cx.notify(); return; }
    this.writeRow(cx, () => createTableDdl(form.name.value(), columns), `Table ${stripControl(made)} created`, form,
      () => { if (this.creating === form) this.creating = null; this.selectAfter(made); }, true);
  }

  // + Column in the table header: name, type, NOT NULL, default (NULL by toggle).
  openAddCol(cx) {
    const target = this.ddlTarget();
    if (this.writing || !target) return;
    this.closeEditors(); this.writeNote = null;
    this.ddlNext = 0;
    const gen = ++this.editGen;
    this.addCol = { gen, file: this.file, ...target, name: this.ddlInput("column name"), type: "TEXT", notNull: false,
      def: this.ddlInput("default (empty: none)"), defNull: false };
    this.addCol.name.focus();
    cx.timer.after(60, () => { if (this.addCol?.gen === gen) this.addCol.name.focus(); });
    cx.notify();
  }

  submitAddCol(cx) {
    const f = this.addCol;
    if (!f) return;
    if (this.writing) { this.writeNote = "Busy saving; press Enter again."; cx.notify(); return; }
    const col = { name: f.name.value(), type: f.type, notNull: f.notNull, def: { value: f.def.value(), isNull: f.defNull } };
    this.writeRow(cx, () => addColumnDdl(f.table, f.sql, col), "Column added", f,
      () => { if (this.addCol === f) this.addCol = null; this.selectAfter(f.table); }, true);
  }

  // First click arms ("Drop table + N rows?" for ARM_MS), the second drops it while its schema is unchanged.
  dropTable(cx) {
    const target = this.ddlTarget();
    if (this.writing || !target) return;
    const id = `drop\0${target.table}`;
    if (this.armed !== id) {
      this.closeEditors(); this.writeNote = null;
      this.armed = id; this.dropTarget = { ...target, file: this.file };
      cx.timer.after(ARM_MS, () => { if (this.armed === id) { this.armed = null; this.dropTarget = null; cx.notify(); } });
      cx.notify();
      return;
    }
    const d = this.dropTarget;
    if (!d || d.table !== target.table) return;
    this.writeRow(cx, () => dropTableDdl(d.table, d.sql), `Table ${stripControl(d.table)} dropped`, d, () => this.selectAfter(null), true);
  }

  openRenameTable(cx) {
    const target = this.ddlTarget();
    if (this.writing || !target) return;
    this.closeEditors(); this.writeNote = null;
    this.openEditor(cx, "rename-table", { ...target, file: this.file }, target.table);
  }

  openRenameCol(cx, i) {
    const target = this.ddlTarget(), col = this.info?.[i];
    if (this.writing || !target || !col) return;
    if (!this.renameColumnOk()) { this.writeNote = RENAME_COLUMN_NOTE; cx.notify(); return; }
    this.closeEditors(); this.writeNote = null;
    this.openEditor(cx, "rename-col", { ...target, file: this.file, col: i, column: col.name }, col.name);
  }

  saveRename(cx, e, value) {
    if (this.writing) { this.writeNote = "Busy saving; press Enter again."; cx.notify(); return; }
    const from = e.kind === "rename-table" ? e.table : e.column;
    if (value.trim() === from) { this.edit = null; cx.notify(); return; } // unchanged
    let to;
    try { to = newName(value, e.kind === "rename-table" ? "table name" : "column name"); }
    catch (err) { this.writeNote = schemaRefusal(err); cx.notify(); return; } // the field stays open
    this.edit = null;
    if (e.kind === "rename-table") {
      this.writeRow(cx, () => renameTableDdl(e.table, e.sql, to), "Table renamed", e, () => this.selectAfter(to), true);
    } else {
      this.writeRow(cx, () => renameColumnDdl(e.table, e.sql, e.column, to), "Column renamed", e, () => this.selectAfter(e.table), true);
    }
  }

  // ---------- create a database ----------

  openCreateDb(cx) {
    if (this.writing || !this.files) return;
    this.closeEditors(); this.writeNote = null; this.pickerOpen = false;
    this.openEditor(cx, "create-db", {}, "");
  }

  // <folder>/<name>, never over an existing file: find (no symlink following) must report nothing
  // there, then writeTextFile(path, "", null) creates it only while no file exists (it rejects a
  // stale snapshot, and null means "there is none"). An empty file is a valid empty SQLite database.
  createDatabase(cx, value) {
    if (this.writing) { this.writeNote = "Busy saving; press Enter again."; cx.notify(); return; }
    const { cwd, on } = location(), key = this.key;
    if (!cwd || on) return;
    const checked = dbFileName(value);
    if (!checked.ok) { this.writeNote = checked.reason; cx.notify(); return; } // the field stays open
    const name = checked.name;
    this.edit = null; this.writing = true; this.writeNote = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let note = null, made = false;
      try {
        const f = await exec("find", [safePath(name), "-maxdepth", "0", "-print"], { cwd, timeout: 10_000 }).catch(() => null);
        const absent = f && f.code !== 0 && !String(f.stdout ?? "").trim(); // exit status only: stderr is localised
        if (f && f.code === 0 && String(f.stdout ?? "").trim()) note = `${stripControl(name)} already exists; nothing written.`;
        else if (!absent) note = "Could not check the folder; nothing written.";
        else {
          try { await writeTextFile(`${cwd}/${name}`, "", null); made = true; }
          catch { note = `${stripControl(name)} already exists; nothing written.`; }
        }
      } catch {
        note = "Could not create the database.";
      } finally {
        this.writing = false;
        if (key === this.key) {
          if (made) this.pendingDb = name;
          else this.pendingDbNote = note;
          this.writeNote = note;
          this.busy = false; this.loadFiles(cx, true);
        }
        cx.notify();
      }
    });
  }

  // ---------- todo ----------

  loadTodo(cx) {
    const { cwd, on } = location(), key = this.key;
    if (!cwd || on) { this.loaded = true; return; }
    if (this.busy) return;
    this.busy = true;
    const seq = ++this.seq;
    this.busyId = seq;
    cx.spawn(async (cx) => {
      const stale = () => key !== this.key || seq !== this.seq;
      try {
        const state = await this.todoState(cwd);
        if (stale()) return;
        this.missing = state === NO_TODO;
        if (state !== "ok") { this.columns = null; this.error = state; this.loaded = true; return; }
        const text = await readTextFile(`${cwd}/${TODO_FILE}`);
        if (stale()) return;
        if (text == null) { this.columns = null; this.missing = true; this.error = NO_TODO; this.loaded = true; return; }
        const lines = text.split("\n");
        if (!this.lines || this.lines.join("\n") !== text) this.armed = null; // the drawn card may be gone
        this.columns = parseTodo(text);
        this.lines = lines;
        this.readOnly = lossy(text);
        this.error = null; this.loaded = true;
      } catch {
        if (!stale()) { this.columns = null; this.error = "Could not read TODO.md."; this.loaded = true; }
      } finally {
        if (this.busyId === seq) this.busy = false;
        cx.notify();
      }
    });
  }

  // "ok", or the one line to show. find does not follow a symlink, so -type f is "regular file, not a
  // link"; realpath then checks that it really is <real folder>/TODO.md.
  async todoState(cwd) {
    // Listing the folder: code 0 with nothing printed is the only "not there"; a failed run is not.
    const present = await exec("find", [".", "-maxdepth", "1", "-name", TODO_FILE, "-print"], { cwd, timeout: 10_000 }).catch(() => null);
    if (!present || present.code !== 0) return "Could not check for TODO.md.";
    if (!present.stdout.trim()) return NO_TODO;
    const ok = await exec("find", [TODO_FILE, "-maxdepth", "0", "-type", "f", "-size", `-${TODO_MAX + 1}c`, "-print"], { cwd, timeout: 10_000 }).catch(() => null);
    if (!(ok && ok.code === 0 && ok.stdout.trim())) return "TODO.md is not a regular file, or is over 1 MB.";
    const inside = await this.realOnly(cwd, [TODO_FILE]);
    return inside.length === 1 ? "ok" : "TODO.md leads outside this folder (a symlink).";
  }

  toggle(card, cx) {
    this.write(cx, (text) => toggleLine(text, card.line, card.raw));
  }

  // The one write path. `change(text)` is a pure transform from logic.js that re-checks the lines it
  // touches; it runs on the file as read right now, and writeTextFile refuses if the file moved on
  // since. create: write the starter file, only while there is still none.
  write(cx, change, { create = false } = {}) {
    if (this.writing) return;
    if (this.readOnly && !create) { this.note = LOSSY_NOTE; cx.notify(); return; }
    const { cwd, on } = location(), key = this.key;
    if (!cwd || on) return;
    this.writing = true; this.note = null; this.armed = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const path = `${cwd}/${TODO_FILE}`;
      let changed = false;
      try {
        // Read again right before writing; the file may have changed since it was drawn.
        const state = await this.todoState(cwd);
        if (create) {
          if (state !== NO_TODO) changed = true;
          else {
            try { await writeTextFile(path, starterTodo(), null); }
            catch { changed = true; }
          }
        } else {
          const text = state === "ok" ? await readTextFile(path) : null;
          const r = text == null ? { ok: false } : change(text);
          if (r.lossy) this.note = LOSSY_NOTE;
          else if (!r.ok) changed = true;
          else {
            try { await writeTextFile(path, r.text, text); }
            catch { changed = true; }
          }
        }
      } catch {
        this.note = "Could not change TODO.md.";
      } finally {
        this.writing = false;
        if (changed) this.note = CHANGED_NOTE;
        if (key === this.key) { this.busy = false; this.loadTodo(cx); }
        cx.notify();
      }
    });
  }

  // A card as the board drew it: its line, its text and its note lines, all checked before a write.
  cardRef(card) {
    return { line: card.line, raw: card.raw, block: this.lines ? this.lines.slice(card.line, card.end + 1) : null };
  }
  colRef(col) {
    const ref = { line: col.line, raw: col.raw };
    const k = col.line === -1 ? col.cards[col.cards.length - 1] : null;
    if (k) ref.last = { line: k.line, raw: k.raw, end: k.end };
    return ref;
  }

  // A real column as the board drew it: heading ref plus its section's lines and top-level card count.
  sectionRef(col, i) {
    const ref = { line: col.line, raw: col.raw, count: col.cards.length };
    if (this.lines) {
      const next = this.columns.slice(i + 1).find((c) => c.line >= 0);
      const total = this.lines.length - (this.lines[this.lines.length - 1] === "" ? 1 : 0);
      ref.block = this.lines.slice(col.line, next ? next.line : total);
    }
    return ref;
  }

  shiftColumn(col, i, dir, cx) {
    if (this.readOnly || this.writing || col.line < 0) return;
    const ref = this.sectionRef(col, i);
    this.edit = null; this.armed = null;
    this.write(cx, (text) => moveColumn(text, ref, dir));
  }

  // First click arms ("Delete column?" / "Delete column + N cards?"), a second one removes the section.
  removeColumn(col, i, cx) {
    if (this.readOnly || this.writing || col.line < 0) return;
    const key = `col\0${col.line}\0${col.raw}`;
    if (this.armed !== key) {
      this.armed = key; this.edit = null; this.note = null; cx.notify();
      cx.timer.after(ARM_MS, () => { if (this.armed === key) { this.armed = null; cx.notify(); } });
      return;
    }
    const ref = this.sectionRef(col, i);
    this.write(cx, (text) => deleteColumn(text, ref));
  }

  openEditor(cx, kind, target, value) {
    if (this.readOnly || this.writing) return;
    const gen = ++this.editGen;
    this.edit = { kind, gen, ...target };
    this.armed = null; this.note = null;
    this.input.set_value(value ?? "");
    if (this.inputFocused) this.focusedGen = gen;
    this.input.focus();
    // Again once the field is drawn (as drover-files' name prompt does); only for this editor.
    cx.timer.after(60, () => { if (this.edit?.gen === gen) this.input.focus(); });
    cx.notify();
  }

  cancelEdit(cx) {
    this.edit = null; this.armed = null;
    cx.notify();
  }

  submitEdit(cx) {
    const e = this.edit;
    if (!e) return;
    if (this.writing) { this.note = "Busy saving; press Enter again."; cx.notify(); return; } // keep the text
    const value = this.input.value();
    if (e.kind === "cell") { this.saveCell(cx, e, value, false); return; }
    if (e.kind === "rename-table" || e.kind === "rename-col") { this.saveRename(cx, e, value); return; }
    if (e.kind === "create-db") { this.createDatabase(cx, value); return; }
    this.edit = null;
    cx.notify();
    if (cleanInput(value) === null) return; // empty: nothing to write
    if (e.kind === "add") this.write(cx, (text) => addCard(text, e.col, value));
    else if (e.kind === "edit") this.write(cx, (text) => editCard(text, e.card, value));
    else if (e.kind === "column") this.write(cx, (text) => addColumn(text, value));
    else if (e.kind === "rename") this.write(cx, (text) => renameColumn(text, e.col, value));
  }

  // First click arms, a second click on the same card deletes it with its notes.
  removeCard(card, cx) {
    if (this.readOnly || this.writing) return;
    const key = `${card.line}\0${card.raw}`;
    if (this.armed !== key) {
      this.armed = key; this.edit = null; this.note = null; cx.notify();
      cx.timer.after(ARM_MS, () => { if (this.armed === key) { this.armed = null; cx.notify(); } });
      return;
    }
    const ref = this.cardRef(card);
    this.write(cx, (text) => deleteCard(text, ref));
  }

  shiftCard(card, to, cx) {
    if (this.readOnly || this.writing || !to) return;
    const ref = this.cardRef(card), dest = this.colRef(to);
    this.edit = null;
    this.write(cx, (text) => moveCard(text, ref, dest));
  }

  createTodo(cx) {
    this.write(cx, null, { create: true });
  }

  // ---------- drawing ----------

  dim(t, text) {
    return div().text_size(11).text_color(t.dim).child(text);
  }

  button(t, id, label, onClick, { active = false, disabled = false } = {}) {
    return div().id(id).px(8).h(22).rounded(5).flex().items_center().flex_none().text_size(11)
      .when(disabled, (el) => el.text_color(t.dim).bg(t.raised))
      .when(!disabled && active, (el) => el.cursor_pointer().bg(t.selected).text_color(t.foreground))
      .when(!disabled && !active, (el) => el.cursor_pointer().bg(t.raised).text_color(t.muted).hover((el) => el.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => { cx.stop_propagation(); if (!disabled) onClick(cx); })
      .child(label);
  }

  bar(t, title, extra) {
    return h_flex().flex_none().items_center().gap(6).px(12).h(34).border_b_1().border_color(t.border)
      .child(div().text_size(11).font_semibold().text_color(t.muted).child(title))
      .child(div().flex_1().min_w(0))
      .when(Boolean(extra), (el) => el.child(extra))
      .child(this.button(t, "refresh", "↻", (cx) => this.refresh(cx)));
  }

  message(t, text) {
    return div().px(12).py(10).text_size(11).text_color(t.dim).child(text);
  }

  render() {
    const t = theme();
    const root = v_flex().id(`drover-data-${this.view}`).size_full().bg(t.chrome).text_color(t.foreground);
    const { cwd, on } = location();
    const title = this.view === "todo" ? "TODO" : "SQLite";
    if (!cwd) return root.child(this.bar(t, title)).child(this.message(t, "No folder in this space."));
    if (on) return root.child(this.bar(t, title)).child(this.message(t, "Remote space: this panel reads local folders only."));
    if (contextKey() !== this.key) return root.child(this.bar(t, title)).child(this.message(t, "Reading…"));
    return this.view === "todo" ? this.renderTodo(root, t) : this.renderSqlite(root, t);
  }

  // ----- sqlite -----

  renderSqlite(root, t) {
    // The picker also holds "+ Database", so it shows from the first file on.
    const picker = this.files && this.files.length >= 1
      ? this.button(t, "picker", `${this.file ?? ""} ▾`, (cx) => { this.pickerOpen = !this.pickerOpen; cx.notify(); }, { active: this.pickerOpen })
      : null;
    const toggle = this.schema && this.file
      ? this.button(t, "edit-mode", this.editMode ? "Editing" : "Edit", (cx) => this.toggleEditMode(cx), { active: this.editMode, disabled: this.writing })
      : null;
    const extra = picker || toggle ? h_flex().gap(6).items_center().when(Boolean(picker), (el) => el.child(picker)).when(Boolean(toggle), (el) => el.child(toggle)) : null;
    root.child(this.bar(t, "SQLite", extra));
    if (this.pickerOpen && this.files) {
      root.child(v_flex().id("picker-list").flex_none().max_h(160).overflow_y_scrollbar().px(8).py(4).gap(1).border_b_1().border_color(t.border)
        .children(this.files.map((f, i) => div().id(`f-${i}`).px(6).h(22).flex().items_center().rounded(4).cursor_pointer().text_size(11.5)
          .text_color(f === this.file ? t.foreground : t.muted).when(f === this.file, (el) => el.bg(t.selected)).hover((el) => el.bg(t.hover))
          .on_click((_e, cx) => this.chooseFile(f, cx)).child(div().truncate().child(stripControl(f)))))
        .child(div().id("picker-new-db").px(6).h(22).flex().items_center().rounded(4).cursor_pointer().text_size(11).text_color(t.dim)
          .hover((el) => el.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); this.openCreateDb(cx); }).child("+ Database")));
    }
    if (this.edit?.kind === "create-db") root.child(this.createDbBox(t));
    // Notes of writes and schema changes, wherever the panel is.
    root.when(Boolean(this.writeNote) || this.writing, (el) => el.child(div().id("write-note").flex_none().px(12).py(4).text_size(11).text_color(t.accent)
      .child(this.writing ? "Saving…" : this.writeNote)));
    if (!this.loaded) return root.child(this.message(t, "Reading…"));
    if (this.files && !this.files.length) {
      root.child(this.message(t, "No database files (.db, .sqlite, .sqlite3) in this folder."));
      if (this.edit?.kind !== "create-db") root.child(h_flex().px(12).child(this.button(t, "create-db", "Create database", (cx) => this.openCreateDb(cx), { disabled: this.writing })));
      return root;
    }
    if (this.error) return root.child(this.message(t, this.error));
    if (!this.schema) return root.child(this.message(t, "Reading…"));
    const creating = this.editMode && Boolean(this.creating) && this.creating.file === this.file;
    if (!this.schema.length) {
      root.child(this.message(t, "This database has no tables or views."));
      if (this.editMode && !creating) root.child(h_flex().px(12).child(this.button(t, "add-table", "+ Table", (cx) => this.openCreate(cx), { disabled: this.writing })));
      return creating ? root.child(this.createForm(t)) : root;
    }
    return root
      .when(creating, (el) => el.child(this.createForm(t)))
      .child(h_flex().flex_1().min_h(0).items_start()
        .child(this.tableList(t))
        .child(this.tablePane(t)));
  }

  // Name prompt for a new database file in this folder.
  createDbBox(t) {
    return v_flex().id("create-db-box").flex_none().gap(4).px(12).py(6).border_b_1().border_color(t.border)
      .child(div().text_size(11).text_color(t.dim).child("New database file name (.sqlite added unless it ends in .db, .sqlite or .sqlite3). Enter creates, Esc cancels."))
      .child(this.editor(t, "create-db-input"));
  }

  tableList(t) {
    return v_flex().id("tables").flex_none().w(150).h_full().overflow_y_scrollbar().p(6).gap(1).border_r_1().border_color(t.border)
      .children(this.schema.map((s, i) => {
        const sel = s.name === this.table, n = this.counts[s.name];
        const count = s.name in this.counts ? (n == null ? "—" : String(n)) : "…";
        return h_flex().id(`t-${i}`).gap(6).items_center().px(6).h(22).rounded(4).cursor_pointer().text_size(11.5)
          .when(sel, (el) => el.bg(t.selected)).hover((el) => el.bg(t.hover))
          .on_click((_e, cx) => this.chooseTable(s.name, cx))
          .child(div().flex_1().min_w(0).truncate().text_color(s.refused ? t.dim : sel ? t.foreground : t.muted)
            .child(stripControl(s.name) + (s.refused ? ` (${s.refused})` : s.type === "view" ? " (view)" : "")))
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child(s.refused ? "" : count));
      }))
      .when(this.editMode, (el) => el.child(div().id("add-table").mt(4).px(6).h(22).rounded(4).flex().items_center().text_size(11)
        .when(this.writing || Boolean(this.creating), (el) => el.text_color(t.border))
        .when(!this.writing && !this.creating, (el) => el.cursor_pointer().text_color(t.dim).hover((el) => el.bg(t.hover).text_color(t.foreground)))
        .on_click((_e, cx) => { cx.stop_propagation(); if (!this.writing && !this.creating) this.openCreate(cx); })
        .child("+ Table")));
  }

  // Edit mode, a plain table: its name (double-click or ✎ renames), + Column, and drop (two clicks).
  tableHead(t, target) {
    const renaming = this.edit?.kind === "rename-table" && this.edit.table === target.table;
    const armed = this.armed === `drop\0${target.table}`;
    const n = this.counts[target.table];
    const dropText = n == null ? "Drop table?" : `Drop table + ${n} row${n === 1 ? "" : "s"}?`;
    const head = h_flex().id("table-head").flex_none().gap(6).items_center().px(8).py(4).border_b_1().border_color(t.border);
    if (renaming) return head.child(div().flex_1().min_w(0).child(this.editor(t, "rename-table-input")));
    return head
      .child(div().id("table-title").flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground)
        .on_mouse_down("left", (e, cx) => { if (e.click_count === 2) { cx.stop_propagation(); this.openRenameTable(cx); } })
        .child(stripControl(target.table)))
      .child(this.icon(t, "rename-table", "✎", "Rename table", (cx) => this.openRenameTable(cx), { disabled: this.writing }))
      // Column renames: ✎ on each column header, or why not.
      .when(!this.renameColumnOk(), (el) => el.child(div().id("rename-col-needs").flex_none().text_size(10.5).text_color(t.dim).child(RENAME_COLUMN_NOTE)))
      .child(this.button(t, "add-col", "+ Column", (cx) => this.openAddCol(cx), { disabled: this.writing || Boolean(this.addCol) }))
      .child(this.icon(t, "drop-table", armed ? dropText : "✕", armed ? "Click again to drop the table" : "Drop table",
        (cx) => this.dropTable(cx), { danger: armed, disabled: this.writing }));
  }

  // A clickable on/off chip for the schema forms.
  chip(t, id, label, on, onClick) {
    return this.button(t, id, label, onClick, { active: on });
  }
  nextType(type) {
    return COL_TYPES[(COL_TYPES.indexOf(type) + 1) % COL_TYPES.length];
  }
  // One text field of a schema form; a NULL default shows "NULL" instead.
  formField(t, id, input, isNull) {
    return div().id(id).flex_1().min_w(0)
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); if (!isNull) input.focus(); })
      .child(isNull
        ? div().h(26).px(6).flex().items_center().rounded(5).border_1().border_color(t.border).text_size(12).text_color(t.dim).child("NULL")
        : Input.new(input).w_full().h(26).px(6).rounded(5).border_1().border_color(t.input).bg(t.background).text_size(12).text_color(t.foreground));
  }
  formBox(t, id, onEscape) {
    return v_flex().id(id).flex_none().gap(4).px(8).py(6).mx(8).my(6).rounded(6).border_1().border_color(t.border).bg(t.surface)
      .track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); onEscape(cx); } });
  }

  // + Table: name, then per column name · type · PK · NOT NULL · default / NULL · remove.
  createForm(t) {
    const f = this.creating;
    return this.formBox(t, "create-table-form", (cx) => { this.creating = null; cx.notify(); })
      .child(div().text_size(11).text_color(t.dim).child("New table: type cycles on click; several PK make a composite key. Enter saves, Esc cancels."))
      .child(h_flex().gap(6).items_center()
        .child(div().w(80).flex_none().text_size(11).text_color(t.foreground).child("Table"))
        .child(this.formField(t, "ct-name", f.name, false)))
      .children(f.rows.map((r, i) => h_flex().id(`ct-row-${i}`).gap(4).items_center()
        .child(this.formField(t, `ct-col-${i}`, r.name, false))
        .child(this.chip(t, `ct-type-${i}`, r.type || "none", false, (cx) => { r.type = this.nextType(r.type); cx.notify(); }))
        .child(this.chip(t, `ct-pk-${i}`, "PK", r.pk, (cx) => { r.pk = !r.pk; cx.notify(); }))
        .child(this.chip(t, `ct-nn-${i}`, "NOT NULL", r.notNull, (cx) => { r.notNull = !r.notNull; cx.notify(); }))
        .child(this.formField(t, `ct-def-${i}`, r.def, r.defNull))
        .child(this.chip(t, `ct-def-null-${i}`, "NULL", r.defNull, (cx) => { r.defNull = !r.defNull; cx.notify(); }))
        .child(this.icon(t, `ct-remove-${i}`, "✕", "Remove this column", (cx) => { f.rows.splice(i, 1); cx.notify(); }))))
      .child(h_flex().gap(6).pt(2)
        .child(this.button(t, "ct-add-row", "+ Column row", (cx) => this.addCreateRow(cx)))
        .child(div().flex_1())
        .child(this.button(t, "ct-save", this.writing ? "Saving…" : "Create", (cx) => this.submitCreate(cx), { disabled: this.writing }))
        .child(this.button(t, "ct-cancel", "Cancel", (cx) => { this.creating = null; cx.notify(); })));
  }

  // + Column: name, type, NOT NULL, default / NULL.
  addColForm(t) {
    const f = this.addCol;
    return this.formBox(t, "add-col-form", (cx) => { this.addCol = null; cx.notify(); })
      .child(div().text_size(11).text_color(t.dim).child(`New column in ${stripControl(f.table)}. NOT NULL needs a default. Enter saves, Esc cancels.`))
      .child(h_flex().gap(4).items_center()
        .child(this.formField(t, "ac-name", f.name, false))
        .child(this.chip(t, "ac-type", f.type || "none", false, (cx) => { f.type = this.nextType(f.type); cx.notify(); }))
        .child(this.chip(t, "ac-nn", "NOT NULL", f.notNull, (cx) => { f.notNull = !f.notNull; cx.notify(); }))
        .child(this.formField(t, "ac-def", f.def, f.defNull))
        .child(this.chip(t, "ac-def-null", "NULL", f.defNull, (cx) => { f.defNull = !f.defNull; cx.notify(); })))
      .child(h_flex().gap(6).pt(2)
        .child(this.button(t, "ac-save", this.writing ? "Saving…" : "Add", (cx) => this.submitAddCol(cx), { disabled: this.writing }))
        .child(this.button(t, "ac-cancel", "Cancel", (cx) => { this.addCol = null; cx.notify(); })));
  }

  tablePane(t) {
    const pane = v_flex().id("table-pane").flex_1().min_w(0).h_full().overflow_y_scrollbar();
    if (!this.table) return pane.child(this.message(t, "Pick a table or a view."));
    const target = this.ddlTarget();
    if (target) pane.child(this.tableHead(t, target));
    if (target && this.addCol?.table === target.table && this.addCol.file === this.file) pane.child(this.addColForm(t));
    if (!this.info || !this.rows) return pane.child(this.message(t, this.note ?? "Reading…"));
    const editing = this.editable();
    const width = this.info.length * COL_W + (editing ? ACT_W : 0);
    const renameCols = Boolean(target), canRename = this.renameColumnOk();
    const head = h_flex().w(width).flex_none().border_b_1().border_color(t.border)
      .when(editing, (el) => el.child(div().w(ACT_W).flex_none()))
      .children(this.info.map((c, i) => {
        const open = renameCols && this.edit?.kind === "rename-col" && this.edit.table === target.table && this.edit.col === i && this.edit.column === c.name;
        const name = open ? div().pr(2).child(this.editor(t, `rename-col-input-${i}`))
          : h_flex().gap(2).items_center()
            .child(div().id(`col-name-${i}`).flex_1().min_w(0).truncate().text_size(11).font_semibold().text_color(t.foreground)
              .when(renameCols && canRename, (el) => el.on_mouse_down("left", (e, cx) => { if (e.click_count === 2) { cx.stop_propagation(); this.openRenameCol(cx, i); } }))
              .child(stripControl(c.name)))
            .when(renameCols && canRename, (el) => el.child(this.icon(t, `rename-col-${i}`, "✎", "Rename column", (cx) => this.openRenameCol(cx, i), { disabled: this.writing })));
        return v_flex().w(COL_W).flex_none().px(6).py(3)
          .child(name)
          .child(div().truncate().text_size(10).text_color(t.dim).child(`${stripControl(c.type) || "any"}${c.pk ? " · PK" : ""}`));
      }));
    const body = v_flex().w(width).flex_none().children(this.rows.map((row, r) => {
      const meta = editing ? this.rowMeta[r] : null;
      const open = editing && this.edit?.kind === "cell" && this.edit.table === this.table && this.sameKeys(this.edit.keys, meta?.keys) ? this.edit.col : -1;
      return h_flex().w(width).flex_none().h(open >= 0 ? 30 : 20).items_center()
        .when(r % 2 === 1, (el) => el.bg(t.raised))
        .when(editing, (el) => el.child(this.rowActions(t, r, meta)))
        .children(row.map((v, c) => {
          if (c === open) return div().w(COL_W).flex_none().px(2).child(this.editor(t, `cell-input-${r}-${c}`));
          const cell = formatCell(v);
          return div().w(COL_W).flex_none().px(6).truncate().text_size(11).text_color(cell.dim ? t.dim : t.foreground)
            .when(editing, (el) => el.id(`cell-${r}-${c}`).on_mouse_down("left", (e, cx) => {
              if (e.click_count === 2) { cx.stop_propagation(); this.openCell(cx, r, c); }
            }))
            .child(cell.text);
        }));
    }));
    const size = this.pageRows();
    const from = this.page * size + 1, to = this.page * size + this.rows.length;
    const total = this.counts[this.table];
    const nav = h_flex().gap(6).items_center().px(8).py(6)
      .child(this.button(t, "prev", "Previous", (cx) => this.goPage(-1, cx), { disabled: this.page === 0 || this.pageBusy }))
      .child(this.button(t, "next", "Next", (cx) => this.goPage(1, cx), { disabled: !this.hasNext() || this.pageBusy }))
      .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).child(this.rows.length ? `Rows ${from}–${to}${total != null ? ` of ${total}` : ""}` : "No rows"))
      .when(editing, (el) => el.child(this.button(t, "add-row", "+ Row", (cx) => this.openInsert(cx), { disabled: this.writing || Boolean(this.insert) })));
    const reason = this.editMode && this.editInfo && !this.editInfo.ok ? this.editInfo.reason : null;
    return pane.child(nav)
      .when(Boolean(reason), (el) => el.child(div().id("read-only-reason").px(12).pb(4).text_size(11).text_color(t.dim).child(reason)))
      .when(editing && Boolean(this.insert) && this.insert.table === this.table, (el) => el.child(this.insertForm(t)))
      .when(editing && this.edit?.kind === "cell", (el) => el.child(this.cellBar(t)))
      .child(div().id("grid").overflow_x_scrollbar().child(v_flex().w(width).flex_none().child(head).child(body)))
      .when(Boolean(this.note), (el) => el.child(this.message(t, this.note)));
  }

  sameKeys(a, b) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((k, i) => k === b[i]);
  }

  // The delete control at the start of a row: ✕, then "Delete row?" for ARM_MS.
  rowActions(t, r, meta) {
    const cell = h_flex().w(ACT_W).flex_none().px(4).items_center();
    if (!meta?.keys) return cell;
    const armed = this.armed === `${this.table}\0${meta.keys.join("\0")}`;
    return cell.child(this.icon(t, `del-row-${r}`, armed ? "Delete row?" : "✕", armed ? "Click again to delete this row" : "Delete row",
      (cx) => this.removeRow(r, cx), { danger: armed, disabled: this.writing }));
  }

  // Shown while a cell editor is open: which column, and NULL / Cancel (the field itself takes Enter and Esc).
  cellBar(t) {
    const e = this.edit;
    return h_flex().id("cell-bar").gap(6).items_center().px(8).pb(4)
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(`Editing ${stripControl(e.column)}: Enter saves, Esc cancels`))
      .child(this.button(t, "cell-null", "Set NULL", (cx) => this.saveCell(cx, this.edit, "", true), { disabled: this.writing }))
      .child(this.button(t, "cell-cancel", "Cancel", (cx) => this.cancelEdit(cx)));
  }

  // + Row: one field per column with its declared type; empty means "leave it to the default",
  // NULL only through the toggle. Enter in any field or Save inserts; Esc or Cancel closes.
  insertForm(t) {
    const ins = this.insert;
    return v_flex().id("insert-form").gap(4).px(8).py(6).mx(8).mb(6).rounded(6).border_1().border_color(t.border).bg(t.surface)
      .track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.cancelInsert(cx); } })
      .child(div().text_size(11).text_color(t.dim).child("New row: empty fields take the default. Enter saves, Esc cancels."))
      .children(ins.fields.map((f, i) => h_flex().gap(6).items_center()
        .child(v_flex().w(120).flex_none()
          .child(div().truncate().text_size(11).text_color(t.foreground).child(stripControl(f.column)))
          .child(div().truncate().text_size(10).text_color(t.dim).child(stripControl(f.type) || "any")))
        .child(div().id(`ins-field-${i}`).flex_1().min_w(0)
          .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); if (!f.isNull) f.input.focus(); })
          .child(f.isNull
            ? div().h(26).px(6).flex().items_center().rounded(5).border_1().border_color(t.border).text_size(12).text_color(t.dim).child("NULL")
            : Input.new(f.input).w_full().h(26).px(6).rounded(5).border_1().border_color(t.input).bg(t.background).text_size(12).text_color(t.foreground)))
        .child(this.button(t, `ins-null-${i}`, "NULL", (cx) => { f.isNull = !f.isNull; cx.notify(); }, { active: f.isNull }))))
      .child(h_flex().gap(6).pt(2)
        .child(this.button(t, "insert-save", this.writing ? "Saving…" : "Save", (cx) => this.submitInsert(cx), { disabled: this.writing }))
        .child(this.button(t, "insert-cancel", "Cancel", (cx) => this.cancelInsert(cx))));
  }

  // ----- todo -----

  renderTodo(root, t) {
    root.child(this.bar(t, "TODO"));
    if (!this.loaded) return root.child(this.message(t, "Reading…"));
    if (this.error) {
      root.child(this.message(t, this.error));
      if (this.missing) {
        root.child(h_flex().px(12).child(this.button(t, "create-todo", this.writing ? "Creating…" : "Create TODO.md", (cx) => this.createTodo(cx), { disabled: this.writing })));
        if (this.note) root.child(this.message(t, this.note));
      }
      return root;
    }
    if (!this.columns) return root.child(this.message(t, "Reading…"));
    // Columns wrap onto the next row when the panel is narrower than the board, so none is cut off.
    const board = h_flex().flex_wrap().items_start().gap(10).p(10).w_full()
      .children(this.columns.map((col, i) => this.column(t, col, i)))
      .when(!this.readOnly, (el) => el.child(this.columnAdder(t)));
    return root
      .when(this.readOnly, (el) => el.child(div().flex_none().px(12).pt(6).text_size(11).text_color(t.dim).child(LOSSY_NOTE)))
      .when(Boolean(this.note) && this.note !== LOSSY_NOTE, (el) => el.child(div().flex_none().px(12).pt(6).text_size(11).text_color(t.accent).child(this.note)))
      .when(!this.columns.length, (el) => el.child(this.message(t, "TODO.md has no items. Items are lines like \"- [ ] text\" under \"##\" headings.")))
      .child(div().id("board").flex_1().min_h(0).min_w(0).w_full().overflow_y_scrollbar().child(board));
  }

  // The one text field, wherever the open editor is. Enter saves (the field's submit), Esc cancels.
  editor(t, id) {
    return div().id(id).w_full().track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.cancelEdit(cx); } })
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.input.focus(); })
      .child(Input.new(this.input).w_full().h(26).px(6).rounded(5).border_1().border_color(t.accent).bg(t.background).text_size(12).text_color(t.foreground));
  }

  // A small control on a card or column; dim until hovered.
  icon(t, id, glyph, label, onClick, { disabled = false, danger = false } = {}) {
    return div().id(id).flex_none().h(18).min_w(18).px(3).rounded(4).flex().items_center().justify_center().text_size(10.5)
      .accessibility_label(label)
      .when(disabled, (el) => el.text_color(t.border))
      .when(!disabled && danger, (el) => el.cursor_pointer().bg(t.accent).text_color(t.accent_foreground))
      .when(!disabled && !danger, (el) => el.cursor_pointer().text_color(t.dim).hover((el) => el.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => { cx.stop_propagation(); if (!disabled) onClick(cx); })
      .child(glyph);
  }

  sameCol(ref, col) {
    return Boolean(ref) && ref.line === col.line && ref.raw === col.raw;
  }

  column(t, col, i) {
    const open = col.cards.filter((c) => !c.done).length;
    const editable = !this.readOnly;
    const renaming = this.edit?.kind === "rename" && this.sameCol(this.edit.col, col);
    const adding = this.edit?.kind === "add" && this.sameCol(this.edit.col, col);
    const canLeft = i > 0 && this.columns[i - 1].line >= 0, canRight = i < this.columns.length - 1;
    const armedCol = this.armed === `col\0${col.line}\0${col.raw}`;
    const delText = col.cards.length ? `Delete column + ${col.cards.length} card${col.cards.length === 1 ? "" : "s"}?` : "Delete column?";
    const head = renaming ? this.editor(t, `rename-input-${i}`)
      : h_flex().items_center().gap(6)
        .child(div().id(`colname-${i}`).flex_1().min_w(0).truncate().text_size(11).font_semibold().text_color(t.muted)
          .when(editable && col.line >= 0, (el) => el.on_mouse_down("left", (e, cx) => {
            if (e.click_count === 2) { cx.stop_propagation(); this.openEditor(cx, "rename", { col: this.colRef(col) }, col.name); }
          }))
          .child(col.name))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`${open}/${col.cards.length}`))
        .when(editable && col.line >= 0, (el) => el.child(this.icon(t, `rename-${i}`, "✎", "Rename column",
          (cx) => this.openEditor(cx, "rename", { col: this.colRef(col) }, col.name))))
        .when(editable && col.line >= 0, (el) => el.child(this.icon(t, `colleft-${i}`, "←", "Move column left",
          (cx) => this.shiftColumn(col, i, -1, cx), { disabled: !canLeft })))
        .when(editable && col.line >= 0, (el) => el.child(this.icon(t, `colright-${i}`, "→", "Move column right",
          (cx) => this.shiftColumn(col, i, 1, cx), { disabled: !canRight })))
        .when(editable && col.line >= 0, (el) => el.child(this.icon(t, `coldel-${i}`, armedCol ? delText : "✕", armedCol ? "Click again to delete the column" : "Delete column",
          (cx) => this.removeColumn(col, i, cx), { danger: armedCol })));
    const left = i > 0 ? this.columns[i - 1] : null, right = this.columns[i + 1] ?? null;
    return v_flex().w(240).flex_none().gap(6).p(8).rounded(8).bg(t.surface).border_1().border_color(t.border)
      .child(head)
      .children(col.cards.length ? sortedCards(col.cards).map((c, j) => this.card(t, c, `${i}-${j}`, left, right)) : [this.dim(t, "No items")])
      .when(editable, (el) => el.child(adding ? this.editor(t, `add-input-${i}`)
        : div().id(`add-${i}`).h(22).px(6).rounded(5).flex().items_center().cursor_pointer().text_size(11).text_color(t.dim)
          .hover((el) => el.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); this.openEditor(cx, "add", { col: this.colRef(col) }, ""); })
          .child("+ Add")));
  }

  columnAdder(t) {
    if (this.edit?.kind === "column") return v_flex().w(240).flex_none().p(8).child(this.editor(t, "column-input"));
    return div().id("add-column").flex_none().h(30).px(10).rounded(8).flex().items_center().cursor_pointer()
      .border_1().border_color(t.border).text_size(11).text_color(t.dim)
      .hover((el) => el.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); this.openEditor(cx, "column", {}, ""); })
      .child("+ Column");
  }

  card(t, card, id, left, right) {
    const editable = !this.readOnly;
    const editing = this.edit?.kind === "edit" && this.edit.card.line === card.line && this.edit.card.raw === card.raw;
    const armed = this.armed === `${card.line}\0${card.raw}`;
    const box = div().id(`box-${id}`).flex_none().mt(1).size(14).rounded(3).border_1().flex().items_center().justify_center().text_size(10)
      .when(editable, (el) => el.cursor_pointer()).border_color(card.done ? t.accent : t.input)
      .when(card.done, (el) => el.bg(t.accent).text_color(t.accent_foreground).child("✓"))
      .on_click((_e, cx) => { cx.stop_propagation(); this.toggle(card, cx); });
    const startEdit = (cx) => this.openEditor(cx, "edit", { card: { line: card.line, raw: card.raw } }, card.text);
    const words = h_flex().id(`text-${id}`).flex_wrap().min_w(0).text_size(12).text_color(card.done ? t.dim : t.foreground)
      .when(editable, (el) => el.on_mouse_down("left", (e, cx) => { if (e.click_count === 2) { cx.stop_propagation(); startEdit(cx); } }))
      .children(inlineTokens(card.text).map((tk) => {
        const el = div().child(tk.text);
        if (tk.code) return el.px(3).rounded(3).bg(t.raised).text_size(11).text_color(card.done ? t.dim : t.muted);
        if (tk.bold) return el.font_semibold();
        return el;
      }));
    const actions = h_flex().gap(2).items_center()
      .child(this.icon(t, `left-${id}`, "←", "Move to the previous column", (cx) => this.shiftCard(card, left, cx), { disabled: !left }))
      .child(this.icon(t, `right-${id}`, "→", "Move to the next column", (cx) => this.shiftCard(card, right, cx), { disabled: !right }))
      .child(div().flex_1())
      .child(this.icon(t, `edit-${id}`, "✎", "Edit", startEdit))
      .child(this.icon(t, `del-${id}`, armed ? "Delete?" : "✕", armed ? "Click again to delete" : "Delete", (cx) => this.removeCard(card, cx), { danger: armed }));
    return h_flex().id(`card-${id}`).gap(8).items_start().p(6).rounded(6).bg(t.raised)
      .child(box)
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(editing ? this.editor(t, `edit-input-${id}`) : words)
        .when(card.notes.length > 0, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`${card.notes.length} note${card.notes.length === 1 ? "" : "s"}`)))
        .when(editable && !editing, (el) => el.child(actions)));
  }
}
