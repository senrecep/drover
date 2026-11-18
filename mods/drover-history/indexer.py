#!/usr/bin/env python3
"""drover-history indexer: a full-text index of past agent sessions (Claude Code, Codex, Pi).

Run as `python3 -I -B indexer.py <command> ...`; stdlib only, Python 3.9+. Prints one JSON
object on stdout. Errors print {"error": "..."} and exit 1.

  update --home APPHOME [--budget SECONDS] [--sources DIR]
  list   --home APPHOME [--cwd PATH ...] [--at PATH ...] [--limit N] [--agent claude|codex|pi]
  search --query=TEXT --home APPHOME [--cwd PATH ...] [--at PATH ...] [--limit N] [--agent ...]

`--cwd` keeps sessions in that folder or below it, `--at` those in exactly that folder.

Transcripts are read only. The index lives at APPHOME/data/drover-history/index.db and is the
only thing written. Only user and assistant prose is indexed: no tool calls or tool output,
no thinking, no system reminders, no command output. Secret-looking tokens are redacted
before anything reaches the database. `--sources` replaces the home folder the transcripts
are looked for in (tests use it); by default it is the user's home.
"""

import argparse
import errno
import glob
import json
import os
import re
import sqlite3
import sys
import time
import urllib.parse
from datetime import datetime

try:
    import fcntl
    msvcrt = None
except ImportError:  # Windows
    fcntl = None
    import msvcrt

SCHEMA = 2              # bumped when what gets indexed or redacted changes: the index is rebuilt
MSG_CAP = 4000          # chars kept per message
SESSION_CAP = 200000    # chars indexed per session; the newest messages win
TITLE_CAP = 120
SNIPPET_CAP = 200
LIMIT_MAX = 500
# A transcript bigger than HUGE is read as its first HEAD and last TAIL bytes only, so one
# file can never outlast a run's budget by much. The newest text is what the caps keep anyway.
HUGE = 768 << 20
HEAD = 16 << 20
TAIL = 256 << 20
AGENTS = ("claude", "codex", "pi")


class Fail(Exception):
    pass


# ---------------------------------------------------------------- redaction

_SECRET_NAME = r"[\w.-]*(?:secret|token|passw(?:or)?d|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth[_-]?key|session[_-]?key)[\w.-]*"
_REDACT = [
    # PEM private keys, whole block.
    (re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)"), "[redacted key]"),
    # Well-known token shapes.
    (re.compile(r"\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}"), "[redacted]"),
    (re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}"), "[redacted]"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"), "[redacted]"),
    (re.compile(r"\bglpat-[A-Za-z0-9_-]{16,}"), "[redacted]"),
    (re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"), "[redacted]"),
    (re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"), "[redacted]"),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{30,}"), "[redacted]"),
    (re.compile(r"\bnpm_[A-Za-z0-9]{30,}"), "[redacted]"),
    (re.compile(r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}"), "[redacted]"),
    (re.compile(r"\bhf_[A-Za-z0-9]{30,}"), "[redacted]"),
    (re.compile(r"\bya29\.[A-Za-z0-9_-]{20,}"), "[redacted]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), "[redacted]"),
    # Authorization headers: Bearer / Basic / Token values (the value must hold a digit, so prose survives).
    (re.compile(r"(?i)\b(bearer|basic|token)(\s+)(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{12,}"), r"\1\2[redacted]"),
    # URL userinfo: scheme://user:password@host
    (re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://[^/\s:@]+:)[^/\s@]+@"), r"\1[redacted]@"),
    # URL query values with secret-ish names.
    (re.compile(r"(?i)([?&](?:[\w.-]*(?:token|key|secret|sig|signature|password|passwd|auth|code|credential)[\w.-]*)=)[^&#\s\"'<>]+"), r"\1[redacted]"),
    # NAME=value / "name": "value" with a secret-ish name (the value must hold a letter).
    (re.compile(r"(?i)(" + _SECRET_NAME + r")([\"']?\s*[:=]\s*[\"']?)(?=[^\s\"'`,;&]*[A-Za-z])[^\s\"'`,;&]{4,}"), r"\1\2[redacted]"),
]


def redact(text):
    """The text with secret-looking tokens replaced by "[redacted]". Pure."""
    if not text:
        return ""
    for rx, rep in _REDACT:
        text = rx.sub(rep, text)
    return text


# ---------------------------------------------------------------- text helpers

_REMINDER = re.compile(r"<system-reminder>[\s\S]*?(?:</system-reminder>|$)")
_HARNESS_TAG = re.compile(r"^<([a-z]+(?:[-_][a-z]+)*)[\s>]")
_SKIP_TAGS = {
    "command-name", "command-message", "command-args", "local-command-stdout", "local-command-stderr",
    "local-command-caveat", "system-reminder", "task-notification", "bash-input", "bash-stdout",
    "bash-stderr", "user-memory-input", "environment_context", "turn_aborted", "user_instructions",
    "user_shell_command", "subagent_notification", "user-prompt-submit-hook",
}
_SPACE = re.compile(r"\s+")
_SURROGATE = re.compile(r"[\ud800-\udfff]")


def scrub(text):
    """The text with lone surrogates (JSON allows them, UTF-8 does not) replaced by U+FFFD."""
    return _SURROGATE.sub("\ufffd", text) if text else ""


def harness_text(text):
    """True for user-role text the harness wrote (command echoes, caveats, notices), not the person."""
    s = text.lstrip()
    if not s:
        return True
    if s.startswith("Caveat:") or s.startswith("[Request interrupted"):
        return True
    m = _HARNESS_TAG.match(s)
    if m and m.group(1) in _SKIP_TAGS:
        return True
    return False


def clean(text):
    """Prose for the index: system reminders removed, redacted, then capped at MSG_CAP. Redaction
    runs on a little more than the cap, so a token cut at the edge is still whole when matched."""
    text = _REMINDER.sub("", scrub(text)).strip()
    return redact(text[:MSG_CAP + 256])[:MSG_CAP]


def one_line(text, cap=TITLE_CAP):
    s = _SPACE.sub(" ", scrub(text)).strip()
    return s if len(s) <= cap else s[:cap - 1].rstrip() + "…"


def epoch(value):
    """ISO-8601 (or epoch ms) -> epoch seconds, or None."""
    if isinstance(value, (int, float)):
        return value / 1000.0 if value > 1e11 else float(value)
    if not isinstance(value, str) or not value:
        return None
    s = value.strip().replace("Z", "+00:00")
    m = re.match(r"^(.*T\d\d:\d\d:\d\d)(\.\d+)?(.*)$", s)
    if m:  # Python 3.9's fromisoformat wants 0, 3 or 6 fraction digits
        frac = m.group(2)[:7].ljust(7, "0") if m.group(2) else ""
        s = m.group(1) + frac + m.group(3)
    try:
        return datetime.fromisoformat(s).timestamp()
    except ValueError:
        return None


def iter_records(path, size):
    """Decoded JSON objects of a JSONL file; bad lines are skipped. Huge files: head and tail only."""
    with open(path, "rb") as fh:
        if size <= HUGE:
            chunks = [fh]
        else:
            head = fh.read(HEAD)
            head = head[: head.rfind(b"\n") + 1]
            fh.seek(max(size - TAIL, 0))
            fh.readline()  # drop the partial first line
            chunks = [head.splitlines(True), fh]
        for chunk in chunks:
            for line in chunk:
                if not line.strip():
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if isinstance(obj, dict):
                    yield obj


def text_blocks(content, kinds):
    """The text of `content` (a string, or a list of blocks whose type is in `kinds`)."""
    if isinstance(content, str):
        return [content]
    out = []
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get("type") in kinds and isinstance(b.get("text"), str):
                out.append(b["text"])
    return out


class Session(object):
    def __init__(self, agent, sid):
        self.agent = agent
        self.sid = sid
        self.cwd = None
        self.started = None
        self.title = None       # explicit name (custom title / summary / session name)
        self.first = None       # first real user prompt
        self.msgs = []          # (role, text), oldest first

    def add(self, role, text):
        text = clean(text)
        if not text:
            return
        self.msgs.append((role, text))
        if role == "user" and self.first is None and not text.lstrip().startswith("/"):
            self.first = text

    def result(self):
        if not self.msgs:
            return None
        title = one_line(redact(self.title or "")) or one_line(self.first or "") or one_line(self.msgs[0][1])
        body, total = [], 0
        for _role, text in reversed(self.msgs):
            if total + len(text) > SESSION_CAP:
                room = SESSION_CAP - total
                if room > 200:
                    body.append(text[-room:])
                break
            body.append(text)
            total += len(text) + 2
        body.reverse()
        return {"agent": self.agent, "sid": scrub(self.sid), "cwd": scrub(self.cwd), "title": title,
                "started": self.started, "msgs": len(self.msgs), "body": "\n\n".join(body)}


# ---------------------------------------------------------------- parsers

def parse_claude(path, size):
    s = Session("claude", os.path.splitext(os.path.basename(path))[0])
    summary = None
    for o in iter_records(path, size):
        t = o.get("type")
        if t == "custom-title" and isinstance(o.get("customTitle"), str):
            s.title = o["customTitle"]
        elif t == "summary" and isinstance(o.get("summary"), str):
            summary = o["summary"]
        elif t in ("user", "assistant"):
            if o.get("isSidechain") is True:
                return None
            if s.cwd is None and isinstance(o.get("cwd"), str):
                s.cwd = o["cwd"]
            if s.started is None:
                s.started = epoch(o.get("timestamp"))
            msg = o.get("message")
            if not isinstance(msg, dict):
                continue
            if t == "assistant":
                for text in text_blocks(msg.get("content"), ("text",)):
                    s.add("assistant", text)
                continue
            if o.get("isMeta") or o.get("isCompactSummary") or o.get("isVisibleInTranscriptOnly") or "toolUseResult" in o:
                continue
            origin = o.get("origin")
            if isinstance(origin, dict) and origin.get("kind") not in (None, "human"):
                continue
            for text in text_blocks(msg.get("content"), ("text",)):
                if not harness_text(_REMINDER.sub("", text)):
                    s.add("user", text)
    if s.title is None and summary:
        s.title = summary
    return s.result()


def parse_codex(path, size):
    s = None
    events, items = [], []
    for o in iter_records(path, size):
        t, p = o.get("type"), o.get("payload")
        if not isinstance(p, dict):
            continue
        if t == "session_meta":
            if s is not None:
                continue
            src = p.get("source")
            if src == "exec" or isinstance(src, dict):
                return None  # non-interactive or a sub-agent thread
            sid = p.get("id") if isinstance(p.get("id"), str) else None
            if not sid:
                m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", os.path.basename(path))
                sid = m.group(1) if m else None
            if not sid:
                return None
            s = Session("codex", sid)
            s.cwd = p.get("cwd") if isinstance(p.get("cwd"), str) else None
            s.started = epoch(p.get("timestamp") or o.get("timestamp"))
        elif t == "event_msg":
            if p.get("type") == "user_message" and isinstance(p.get("message"), str):
                events.append(("user", p["message"]))
            elif p.get("type") == "agent_message" and isinstance(p.get("message"), str):
                events.append(("assistant", p["message"]))
        elif t == "response_item" and p.get("type") == "message":
            role = p.get("role")
            if role == "user":
                for text in text_blocks(p.get("content"), ("input_text",)):
                    items.append(("user", text))
            elif role == "assistant":
                for text in text_blocks(p.get("content"), ("output_text",)):
                    items.append(("assistant", text))
    if s is None:
        return None
    # The event stream is the conversation as shown; response items carry injected context
    # (AGENTS.md, environment) as user text, so they are only the fallback.
    # In the fallback, user text that starts with "#" is injected instructions (AGENTS.md); a typed
    # prompt that starts with a markdown heading comes through the event stream and is kept.
    fallback = not any(r == "user" for r, _ in events)
    for role, text in (items if fallback else events):
        if role == "user" and (harness_text(text) or (fallback and text.lstrip().startswith("#"))):
            continue
        s.add(role, text)
    return s.result()


def parse_pi(path, size):
    s = None
    for o in iter_records(path, size):
        t = o.get("type")
        if t == "session":
            if s is None and isinstance(o.get("id"), str):
                s = Session("pi", o["id"])
                s.cwd = o.get("cwd") if isinstance(o.get("cwd"), str) else None
                s.started = epoch(o.get("timestamp"))
        elif s is None:
            continue
        elif t == "session_info" and isinstance(o.get("name"), str) and o["name"].strip():
            s.title = o["name"]
        elif t == "message":
            msg = o.get("message")
            if not isinstance(msg, dict) or msg.get("role") not in ("user", "assistant"):
                continue
            for text in text_blocks(msg.get("content"), ("text",)):
                if msg["role"] == "user" and harness_text(text):
                    continue
                s.add(msg["role"], text)
    return s.result() if s else None


PARSERS = {"claude": parse_claude, "codex": parse_codex, "pi": parse_pi}


def discover(src_home):
    """(agent, path) of every transcript. Depth-limited globs keep sub-agent folders out."""
    pats = [
        ("claude", os.path.join(src_home, ".claude", "projects", "*", "*.jsonl")),
        ("codex", os.path.join(src_home, ".codex", "sessions", "*", "*", "*", "rollout-*.jsonl")),
        ("pi", os.path.join(src_home, ".pi", "agent", "sessions", "*", "*.jsonl")),
    ]
    out = []
    for agent, pat in pats:
        for p in glob.glob(pat):
            try:
                p.encode("utf-8")  # a name that isn't UTF-8 can't be stored; skip it
            except UnicodeEncodeError:
                continue
            out.append((agent, p))
    return out


# ---------------------------------------------------------------- database

def data_dir(home):
    if not home or not os.path.isabs(home):
        raise Fail("--home must be an absolute path")
    return os.path.join(home, "data", "drover-history")


def db_path(home):
    return os.path.join(data_dir(home), "index.db")


def open_rw(home):
    d = data_dir(home)
    os.makedirs(d, exist_ok=True)
    db = sqlite3.connect(os.path.join(d, "index.db"), timeout=10)
    db.execute("PRAGMA busy_timeout=10000")
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=NORMAL")
    row = db.execute("PRAGMA user_version").fetchone()
    if row[0] != SCHEMA:
        db.executescript("DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS text;")
        try:
            db.execute("CREATE VIRTUAL TABLE text USING fts5(title, body, tokenize='unicode61 remove_diacritics 2')")
        except sqlite3.OperationalError:
            raise Fail("this python3's SQLite has no FTS5")
        db.execute("""CREATE TABLE sessions (
            id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, size INTEGER, mtime INTEGER,
            agent TEXT, sid TEXT, cwd TEXT, title TEXT, started REAL, updated REAL, msgs INTEGER,
            indexed INTEGER NOT NULL DEFAULT 0)""")
        db.execute("CREATE INDEX sessions_updated ON sessions(indexed, updated)")
        db.execute("PRAGMA user_version=%d" % SCHEMA)
        db.commit()
    return db


def open_ro(home):
    p = db_path(home)
    if not os.path.exists(p):
        return None
    db = sqlite3.connect("file:" + urllib.parse.quote(p) + "?mode=ro", uri=True, timeout=10)
    db.execute("PRAGMA busy_timeout=10000")
    if db.execute("PRAGMA user_version").fetchone()[0] != SCHEMA:
        db.close()
        return None
    return db


def store(db, path, size, mtime, rec):
    old = db.execute("SELECT id FROM sessions WHERE path=?", (path,)).fetchone()
    if old:
        db.execute("DELETE FROM text WHERE rowid=?", (old[0],))
        db.execute("DELETE FROM sessions WHERE id=?", (old[0],))
    if rec is None:  # remembered so it is not parsed again, never listed
        db.execute("INSERT INTO sessions(path, size, mtime, indexed) VALUES (?,?,?,0)", (path, size, mtime))
        return
    cur = db.execute(
        "INSERT INTO sessions(path,size,mtime,agent,sid,cwd,title,started,updated,msgs,indexed) VALUES (?,?,?,?,?,?,?,?,?,?,1)",
        (path, size, mtime, rec["agent"], rec["sid"], rec["cwd"], rec["title"], rec["started"], mtime / 1e9, rec["msgs"]))
    db.execute("INSERT INTO text(rowid, title, body) VALUES (?,?,?)", (cur.lastrowid, rec["title"], rec["body"]))


def try_lock(fh):
    """Takes the run lock without waiting: flock, or on Windows a one-byte msvcrt lock. False when
    another run holds it."""
    try:
        if fcntl:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        else:
            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError as e:
        busy = (errno.EAGAIN, errno.EACCES, errno.EWOULDBLOCK) + ((errno.EDEADLK,) if not fcntl else ())
        if e.errno in busy:
            return False
        raise
    return True


def unlock(fh):
    """Releases the run lock try_lock took: flock LOCK_UN, or on Windows the same one-byte msvcrt
    region. A failure is ignored, as closing the file releases it too."""
    try:
        if fcntl:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        else:
            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
    except OSError:
        pass


def update(home, budget, src_home):
    d = data_dir(home)
    os.makedirs(d, exist_ok=True)
    lock = open(os.path.join(d, "index.lock"), "a+")
    locked = False
    try:
        if not try_lock(lock):
            return {"done": False, "busy": True}
        locked = True
        started = time.monotonic()
        db = open_rw(home)
        try:
            files = []
            for agent, p in discover(src_home):
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                files.append((agent, p, st.st_size, st.st_mtime_ns))
            known = dict((r[0], (r[1], r[2])) for r in db.execute("SELECT path, size, mtime FROM sessions"))
            here = set(f[1] for f in files)
            removed = 0
            for p in [k for k in known if k not in here]:
                row = db.execute("SELECT id FROM sessions WHERE path=?", (p,)).fetchone()
                db.execute("DELETE FROM text WHERE rowid=?", (row[0],))
                db.execute("DELETE FROM sessions WHERE id=?", (row[0],))
                removed += 1
            db.commit()
            todo = [f for f in files if known.get(f[1]) != (f[2], f[3])]
            todo.sort(key=lambda f: -f[3])  # newest first: recent sessions show up soonest
            processed = 0
            for agent, p, size, mtime in todo:
                if processed and time.monotonic() - started > budget:
                    break
                try:
                    store(db, p, size, mtime, PARSERS[agent](p, size))
                except sqlite3.Error:
                    raise
                except OSError as e:
                    db.rollback()
                    if e.errno == errno.ENOENT:
                        continue  # vanished; the next run no longer finds it
                    # Unreadable (permissions, I/O): remembered as skipped until it changes.
                    store(db, p, size, mtime, None)
                except Exception:
                    # A transcript this indexer can't handle (odd text, deep nesting...): remembered
                    # as skipped, so it never blocks the files after it.
                    db.rollback()
                    store(db, p, size, mtime, None)
                db.commit()
                processed += 1
            pending = len(todo) - processed
            return {"done": pending == 0, "total": len(files), "indexed": len(files) - pending,
                    "processed": processed, "removed": removed, "elapsed": round(time.monotonic() - started, 3)}
        finally:
            db.close()
    finally:
        if locked:
            unlock(lock)
        lock.close()


# ---------------------------------------------------------------- queries

_WORD = re.compile(r"\w+", re.UNICODE)
MAX_WORDS = 12


def fts_query(q):
    """A safe FTS5 MATCH string: each word (2+ chars) quoted, ANDed, the last one a prefix.
    None when no word remains. Raw input never reaches MATCH."""
    words = [w for w in _WORD.findall(q or "") if len(w) >= 2][:MAX_WORDS]
    if not words:
        return None
    parts = ['"%s"' % w.replace('"', '""') for w in words]
    parts[-1] += "*"
    return " AND ".join(parts)


def norm_dir(p):
    p = os.path.normpath(p) if p else ""
    return p if p.startswith("/") else ""


def scope_sql(cwds, exact=None):
    """SQL (and params) keeping sessions whose cwd is one of `cwds` or under one, or is exactly
    one of `exact`. Neither given: no filter."""
    dirs = sorted(set(d for d in (norm_dir(c) for c in cwds or []) if d))
    at = sorted(set(d for d in (norm_dir(c) for c in exact or []) if d))
    if not cwds and not exact:
        return "", []
    if not dirs and not at:
        return " AND 0", []
    if "/" in dirs:
        return "", []
    sql, params = [], []
    for d in dirs:
        sql.append("(s.cwd = ? OR substr(s.cwd, 1, ?) = ?)")
        params += [d, len(d) + 1, d + "/"]
    if at:
        sql.append("s.cwd IN (%s)" % ",".join("?" * len(at)))
        params += at
    return " AND (" + " OR ".join(sql) + ")", params


def snippet_parts(raw, cap=SNIPPET_CAP):
    """FTS5 snippet text (hits wrapped in \\x02..\\x03) -> {pre, hit, post}, one line, <= cap chars."""
    raw = redact(_SPACE.sub(" ", raw or "")).strip()
    a = raw.find("\x02")
    b = raw.find("\x03", a + 1) if a >= 0 else -1
    if a < 0 or b < 0:
        pre, hit, post = "", "", raw
    else:
        pre, hit, post = raw[:a], raw[a + 1:b], raw[b + 1:]
    strip = lambda s: s.replace("\x02", "").replace("\x03", "")
    pre, hit, post = strip(pre), strip(hit), strip(post)
    hit = hit[:60]
    room = max(cap - len(hit), 0)
    if len(pre) > room // 2:
        pre = "…" + pre[-(room // 2 - 1):] if room // 2 > 1 else ""
    post = post[:max(room - len(pre), 0)]
    return {"pre": pre, "hit": hit, "post": post}


def row_of(r, snip=None):
    out = {"agent": r[0], "id": r[1], "cwd": r[2], "title": r[3], "started": r[4], "updated": r[5],
           "msgs": r[6], "path": r[7], "exists": bool(r[2]) and os.path.isdir(r[2])}
    if snip is not None:
        out["snippet"] = snippet_parts(snip)
    return out


COLS = "s.agent, s.sid, s.cwd, s.title, s.started, s.updated, s.msgs, s.path"


def agent_counts(db, scope, params):
    q = "SELECT s.agent, count(*) FROM sessions s WHERE s.indexed=1" + scope + " GROUP BY s.agent"
    return dict(db.execute(q, params).fetchall())


def do_list(home, cwds, limit, agent, exact=None):
    db = open_ro(home)
    if db is None:
        return {"rows": [], "agents": {}, "empty": True}
    try:
        scope, params = scope_sql(cwds, exact)
        filt, fparams = ((" AND s.agent=?", [agent]) if agent else ("", []))
        rows = db.execute("SELECT " + COLS + " FROM sessions s WHERE s.indexed=1" + scope + filt +
                          " ORDER BY s.updated DESC LIMIT ?", params + fparams + [limit]).fetchall()
        return {"rows": [row_of(r) for r in rows], "agents": agent_counts(db, scope, params)}
    finally:
        db.close()


def do_search(home, query, cwds, limit, agent, exact=None):
    match = fts_query(query)
    if match is None:
        out = do_list(home, cwds, limit, agent, exact)
        if (query or "").strip():
            out["hint"] = "Type at least 2 letters to search."
        return out
    db = open_ro(home)
    if db is None:
        return {"rows": [], "agents": {}, "empty": True, "query": match}
    try:
        scope, params = scope_sql(cwds, exact)
        filt, fparams = ((" AND s.agent=?", [agent]) if agent else ("", []))
        rows = db.execute(
            "SELECT " + COLS + ", snippet(text, -1, char(2), char(3), '…', 24) FROM text JOIN sessions s ON s.id = text.rowid"
            " WHERE text MATCH ? AND s.indexed=1" + scope + filt + " ORDER BY s.updated DESC LIMIT ?",
            [match] + params + fparams + [limit]).fetchall()
        return {"rows": [row_of(r[:8], r[8]) for r in rows], "agents": agent_counts(db, scope, params), "query": match}
    finally:
        db.close()


# ---------------------------------------------------------------- cli

class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise Fail(message)


def main(argv):
    ap = Parser(prog="indexer.py", add_help=False)
    sub = ap.add_subparsers(dest="cmd")
    up = sub.add_parser("update", add_help=False)
    up.add_argument("--home", required=True)
    up.add_argument("--budget", type=float, default=8.0)
    up.add_argument("--sources")
    for name in ("list", "search"):
        sp = sub.add_parser(name, add_help=False)
        if name == "search":
            # An option, passed as one "--query=<text>" word, so text that starts with "-" stays text.
            sp.add_argument("--query", default="")
        sp.add_argument("--home", required=True)
        sp.add_argument("--cwd", action="append", default=[])   # this folder or below it
        sp.add_argument("--at", action="append", default=[])    # exactly this folder
        sp.add_argument("--limit", type=int, default=100)
        sp.add_argument("--agent", choices=AGENTS)
    a = ap.parse_args(argv)
    if a.cmd is None:
        raise Fail("usage: indexer.py update|list|search ...")
    if a.cmd == "update":
        src = a.sources or os.path.expanduser("~")
        return update(a.home, max(a.budget, 0.0), src)
    limit = min(max(a.limit, 1), LIMIT_MAX)
    if a.cmd == "list":
        return do_list(a.home, a.cwd, limit, a.agent, a.at)
    return do_search(a.home, a.query, a.cwd, limit, a.agent, a.at)


def cli(argv):
    try:
        out = main(argv)
    except Fail as e:
        sys.stdout.write(json.dumps({"error": str(e)}) + "\n")
        return 1
    except OSError as e:  # strerror only: never echo a path
        sys.stdout.write(json.dumps({"error": "%s: %s" % (type(e).__name__, e.strerror or "I/O error")}) + "\n")
        return 1
    except sqlite3.Error as e:
        sys.stdout.write(json.dumps({"error": "%s: %s" % (type(e).__name__, str(e).split("\n")[0][:160])}) + "\n")
        return 1
    except Exception as e:  # the type only: a message could echo a path or transcript text
        sys.stdout.write(json.dumps({"error": type(e).__name__}) + "\n")
        return 1
    sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(cli(sys.argv[1:]))
