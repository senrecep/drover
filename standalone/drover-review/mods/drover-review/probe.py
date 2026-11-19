"""Read-only, bounded transcript probe for the drover-review mod.

Run as `python3 -I probe.py turns --cwd DIR [--pid N] [--root DIR] [--turns K]`; prints one JSON object.
It finds the Claude Code session of a terminal (by process, else by folder) and reports the file-editing
tool calls of its last K turns: per call, the file path and the lines added and removed. It never prints
prompt text, tool input text, or tool output, and it never writes anywhere.

The transcript is read from the end in chunks of CHUNK bytes, at most CAP bytes in all, and only when it
is a regular file (not a link, device or fifo).
"""

import glob
import json
import os
import re
import stat
import sys

HOME = os.path.expanduser("~")
CLAUDE = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(HOME, ".claude")
CHUNK = 512 * 1024
CAP = 8 * 1024 * 1024
EDIT_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")
NOT_HUMAN = ("<task-notification", "<local-command-", "<command-stdout", "<system-reminder", "<bash-input", "<bash-stdout", "<bash-stderr")


# ---------- session discovery ----------

def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def encode_cwd(cwd):
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)


def transcript_for(session_id):
    if not isinstance(session_id, str) or not re.match(r"^[A-Za-z0-9-]+$", session_id):
        return None
    hits = glob.glob(os.path.join(CLAUDE, "projects", "*", session_id + ".jsonl"))
    return max(hits, key=os.path.getmtime) if hits else None


def find_session(cwd, pid=None):
    """(path, how): how is pid | cwd-live | cwd-live-ambiguous | cwd-newest-file."""
    cwd = os.path.normpath(cwd) if cwd else ""
    if pid:
        info = read_json(os.path.join(CLAUDE, "sessions", f"{pid}.json"))
        path = transcript_for((info or {}).get("sessionId"))
        if path:
            return path, "pid"
    live = []
    for f in glob.glob(os.path.join(CLAUDE, "sessions", "*.json")):
        info = read_json(f)
        if not isinstance(info, dict) or not cwd:
            continue
        if os.path.normpath(str(info.get("cwd") or "")) != cwd or not alive(info.get("pid")):
            continue
        path = transcript_for(info.get("sessionId"))
        if path:
            live.append((info.get("updatedAt") or 0, os.path.getmtime(path), path))
    if live:
        live.sort()
        return live[-1][2], "cwd-live" if len(live) == 1 else "cwd-live-ambiguous"
    if cwd:
        for d in {encode_cwd(cwd), cwd.replace("/", "-").replace(".", "-")}:
            files = glob.glob(os.path.join(CLAUDE, "projects", d, "*.jsonl"))
            if files:
                return max(files, key=os.path.getmtime), "cwd-newest-file"
    return None, None


# ---------- pure parsing ----------

def is_prompt(d):
    """A prompt a person typed: not a tool result, meta line, summary, side chain or notification."""
    if not isinstance(d, dict) or d.get("type") != "user":
        return False
    if d.get("isSidechain") or d.get("isMeta") or d.get("isCompactSummary") or d.get("isVisibleInTranscriptOnly"):
        return False
    origin = d.get("origin")
    if isinstance(origin, dict) and origin.get("kind") not in (None, "human"):
        return False
    content = (d.get("message") or {}).get("content")
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        if any(isinstance(c, dict) and c.get("type") == "tool_result" for c in content):
            return False
        texts = [c.get("text") or "" for c in content if isinstance(c, dict) and c.get("type") == "text"]
        has_image = any(isinstance(c, dict) and c.get("type") == "image" for c in content)
        if not texts and not has_image:
            return False
        text = texts[0] if texts else ""
    else:
        return False
    return not text.lstrip().startswith(NOT_HUMAN)


def line_count(text):
    if not isinstance(text, str) or not text:
        return 0
    return text.count("\n") + (0 if text.endswith("\n") else 1)


def text_delta(old, new):
    """(added, removed) lines between two texts: what remains after their common first and last lines."""
    a = old.split("\n") if isinstance(old, str) and old else []
    b = new.split("\n") if isinstance(new, str) and new else []
    i = 0
    while i < len(a) and i < len(b) and a[i] == b[i]:
        i += 1
    j = 0
    while j < len(a) - i and j < len(b) - i and a[-1 - j] == b[-1 - j]:
        j += 1
    return len(b) - i - j, len(a) - i - j


def patch_counts(patch):
    """(added, removed) from a structuredPatch's hunk lines, or None when it has none."""
    if not isinstance(patch, list) or not patch:
        return None
    add = rem = 0
    for h in patch:
        for line in (h or {}).get("lines") or [] if isinstance(h, dict) else []:
            if isinstance(line, str) and line.startswith("+"):
                add += 1
            elif isinstance(line, str) and line.startswith("-"):
                rem += 1
    return add, rem


def input_counts(name, inp):
    """(added, removed) from the tool call's own old and new text, or (None, None) when unknown."""
    inp = inp if isinstance(inp, dict) else {}
    if name == "Edit":
        return text_delta(inp.get("old_string"), inp.get("new_string"))
    if name == "MultiEdit":
        add = rem = 0
        for e in inp.get("edits") or []:
            if isinstance(e, dict):
                a, r = text_delta(e.get("old_string"), e.get("new_string"))
                add, rem = add + a, rem + r
        return add, rem
    return None, None


def result_counts(name, inp, result):
    """Counts from the tool's recorded result when it has a patch or says it created the file."""
    if isinstance(result, dict):
        pc = patch_counts(result.get("structuredPatch"))
        if pc is not None:
            return pc
        if name == "Write" and result.get("type") == "create":
            return line_count((inp or {}).get("content")), 0
        if name in ("Edit", "MultiEdit"):
            return input_counts(name, inp)
    return input_counts(name, inp)


def events_from_lines(lines):
    """[{k:"p"}, {k:"e", path, add, del}, ...] in file order. Only paths and numbers leave this function."""
    uses = []  # (order, id, name, path, input)
    results = {}  # tool_use_id -> (is_error, toolUseResult)
    order = []
    for n, line in enumerate(lines):
        if '"user"' not in line and '"tool_use"' not in line:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if not isinstance(d, dict) or d.get("isSidechain"):
            continue
        t = d.get("type")
        content = (d.get("message") or {}).get("content")
        if t == "user":
            if is_prompt(d):
                order.append((n, "p", None))
                continue
            if isinstance(content, list):
                ids = [c for c in content if isinstance(c, dict) and c.get("type") == "tool_result"]
                for c in ids:
                    tr = d.get("toolUseResult") if len(ids) == 1 else None
                    results[c.get("tool_use_id")] = (bool(c.get("is_error")), tr)
        elif t == "assistant" and isinstance(content, list):
            for c in content:
                if not isinstance(c, dict) or c.get("type") != "tool_use" or c.get("name") not in EDIT_TOOLS:
                    continue
                inp = c.get("input") if isinstance(c.get("input"), dict) else {}
                path = inp.get("file_path") or inp.get("notebook_path")
                if isinstance(path, str) and path:
                    order.append((n, "e", (c.get("id"), c.get("name"), path, inp)))
    out = []
    for _, kind, data in order:
        if kind == "p":
            out.append({"k": "p"})
            continue
        uid, name, path, inp = data
        is_error, tr = results.get(uid, (False, None))
        if is_error:
            continue
        if uid not in results and name in ("Write", "NotebookEdit"):
            add, rem = None, None  # not finished yet, or its result is beyond the window
        elif name == "NotebookEdit":
            add, rem = None, None
        else:
            add, rem = result_counts(name, inp, tr)
        out.append({"k": "e", "path": os.path.normpath(path), "add": add, "del": rem})
    return out


def relative(path, root):
    if not root:
        return path
    r = os.path.normpath(root)
    return os.path.relpath(path, r) if path == r or path.startswith(r + os.sep) else path


# ---------- bounded reading ----------

def open_regular(path):
    """A binary file object for a regular file, refusing links and special files; None otherwise."""
    try:
        if not stat.S_ISREG(os.lstat(path).st_mode):
            return None
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    f = os.fdopen(fd, "rb")
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            f.close()
            return None
    except OSError:
        f.close()
        return None
    return f


def tail_until(path, want_prompts, chunk=CHUNK, cap=CAP):
    """(complete lines oldest first, reached_start): read backwards until want_prompts real prompts are in hand."""
    f = open_regular(path)
    if f is None:
        return [], True
    with f:
        size = os.fstat(f.fileno()).st_size
        pos, carry, lines, prompts, read = size, b"", [], 0, 0
        while pos > 0 and read < cap:
            step = min(chunk, pos, cap - read)
            pos -= step
            f.seek(pos)
            data = f.read(step) + carry
            read += step
            parts = data.split(b"\n")
            carry = parts[0] if pos > 0 else b""
            fresh = [p.decode("utf-8", errors="replace") for p in (parts[1:] if pos > 0 else parts) if p]
            for line in fresh:
                if '"user"' in line:
                    try:
                        if is_prompt(json.loads(line)):
                            prompts += 1
                    except ValueError:
                        pass
            lines = fresh + lines
            if prompts >= want_prompts:
                break
        return lines, pos == 0


def cmd_turns(cwd, pid, root, want):
    path, how = find_session(cwd, pid)
    if not path:
        return {"session": None}
    lines, at_start = tail_until(path, want)
    events = events_from_lines(lines)
    first = next((i for i, e in enumerate(events) if e["k"] == "p"), None)
    # Edits before the first prompt in the window: a turn whose prompt is beyond the cap
    # (kept and marked partial by the mod), or nothing to show when the file starts there.
    if first is not None and (at_start or sum(1 for e in events if e["k"] == "p") >= want):
        events = events[first:]
    for e in events:
        if e["k"] == "e":
            e["path"] = relative(e["path"], root)
    return {"session": os.path.basename(path)[:-6], "how": how, "events": events, "start": at_start}


def args_of(argv):
    out = {}
    i = 0
    while i + 1 < len(argv):
        if argv[i].startswith("--"):
            out[argv[i][2:]] = argv[i + 1]
            i += 2
        else:
            i += 1
    return out


def main(argv):
    if not argv or argv[0] != "turns":
        return {"error": "unknown command"}
    a = args_of(argv[1:])
    want = max(1, min(10, int(a.get("turns") or 5)))
    pid = a.get("pid") if (a.get("pid") or "").isdigit() else None
    return cmd_turns(a.get("cwd", ""), pid, a.get("root") or "", want)


if __name__ == "__main__":
    try:
        result = main(sys.argv[1:])
    except Exception:
        result = {"error": "probe failed"}
    sys.stdout.write(json.dumps(result))
