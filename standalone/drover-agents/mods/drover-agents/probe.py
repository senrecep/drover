"""Read-only probe of every installed coding-agent CLI's setup, for the drover-agents mod.

Run as `python3 -I probe.py <command> ...`; prints one JSON object on stdout.
Commands:
  list    [--folder DIR]...                         detected agents with their global and project setup
  session --agent ID --cwd DIR [--pid N] --prices JSON   context and estimated cost (Claude family, Codex)
  read AGENT global|project.KIND INDEX [--name NAME] [--folder DIR]...
                                                    the text of a listed instruction/skill/agent/command file
  tokens ADAPTER                                  token aggregates for claude|codex|opencode|antigravity
Option for every command: --home DIR reads that folder as the home folder (tests); the
DROVER_AGENTS_HOME environment variable does the same.

Security model:
  * Fields are read by allowlist: MCP name + transport + program base name or URL host; skill, agent and
    command names + frontmatter description; hook event names; instruction-file paths and sizes; a model id
    when it is a plain string. Nothing else from a config file reaches the output.
  * JSON and TOML are pruned at parse time: env, headers, args, tokens, keys, auth and provider blocks are
    dropped before any code sees them.
  * Every open of an agent's file (configs, instruction files, transcripts) goes through open_regular, which
    refuses credential files, databases, protobuf state, wrapper scripts, keys, keychains and the large
    private stores (checked case-insensitively on the path and on its resolved target, which must also be
    the file actually opened). The mod's own store and cache files are opened with O_NOFOLLOW instead.
  * Reads for a project folder must resolve inside that folder; its configs can't name files outside it.
  * Folder walks never follow folder symlinks, skip .git/node_modules and stop at MAX_WALK files (the
    transcript walk for `tokens` skips every symlink and stops at MAX_LOGS); the whole run stops after
    DEADLINE seconds and prints what it has.
  * Output strings lose control and bidi characters; the home folder becomes "~".
  * `read` takes no path: it rebuilds that agent's listing, picks the item by index (and name), and re-checks
    the deny guard, the project confinement the item was listed under and the extension (.md/.mdc/.toml/.txt)
    before opening it; at most 256 KB, control/bidi characters dropped and secret-looking strings redacted.
  * `tokens` reads Claude Code and Codex transcripts for usage numbers only (timestamp, model, token counts,
    session and message ids, kept only as salted digests) into its own store and prints aggregates only (no
    paths, prompts or projects). A run that hits its time budget says "incomplete" and the next run resumes.
Never writes anywhere except the mod's own hidden caches beside this file (not with --home) and its usage
store and aggregate cache in <home>/.config/herdr-app/data/drover-agents (usage-store.json, tokens-cache.json).
"""

import base64
import fnmatch
import glob
import hashlib
import json
import os
import re
import shlex
import signal
import socket
import stat
import struct
import sys
import time
from urllib.parse import urlsplit

try:
    import tomllib
except ImportError:  # Python < 3.11: TOML files read as absent
    tomllib = None

HERE = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.expanduser("~")
OVERRIDDEN = False
TAIL_STEPS = (2 * 1024 * 1024, 8 * 1024 * 1024, 32 * 1024 * 1024)
MAX_JSON = 8 * 1024 * 1024
MAX_FM = 16384
CHUNK = 8 * 1024 * 1024
MAX_LINE = 8 * 1024 * 1024
MAX_ITEMS = 400
MAX_WALK = 2000  # files (or folder entries) looked at per folder walk
DEADLINE = 20  # seconds before the probe gives up and prints what it has
MAX_STR = 300
G = glob.escape
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MODEL_RE = re.compile(r"^(?![/.])(?!.*\.\.)(?!.*//)[A-Za-z0-9._:/@\[\]+-]{1,100}$")
PROGRAM_RE = re.compile(r"^[\w.+-]{1,64}$")


def set_home(path):
    global HOME, OVERRIDDEN
    HOME = os.path.abspath(path)
    OVERRIDDEN = True


def hp(*parts):
    return os.path.join(HOME, *parts)


# ---------- the deny guard (every file read goes through open_regular) ----------

DENY_NAMES = {
    "auth.json", ".credentials.json", "credentials", "credentials.json", "mcp-auth.json", "google_accounts.json",
    "oauth_creds.json", "user_settings.pb", "integrations.env", ".env", "installation_id", "oh-my-openagent.json",
    "variant.json.bak", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", ".netrc", ".npmrc", ".pypirc",
}
DENY_SUFFIXES = (".sqlite", ".sqlite3", ".db", ".pb", ".env", ".pem", ".key", ".p12", ".keychain", ".keychain-db", "_sk")
DENY_NAME_RE = re.compile(r"^id_[a-z0-9_]+$")  # ssh private keys of any type (id_rsa, id_ecdsa_sk, ...)
DENY_WORDS = ("oauth", "token", "secret", "credential", "password", "apikey", "api_key", ".db-", ".sqlite-")
DENY_PARTS = {"credentials", "oauth", "node_modules", ".git"}
DENY_UNDER = (
    (".local", "bin"),
    (".local", "share", "opencode"),
    (".gemini", "antigravity-cli"),
    (".gemini", "antigravity", "brain"),
    (".gemini", "antigravity", "conversations"),
    (".gemini", "antigravity", "code_tracker"),
    (".gemini", "antigravity", "knowledge"),
    (".gemini", "antigravity", "implicit"),
    (".gemini", "antigravity", "context_state"),
    (".gemini", "antigravity", "scratch"),
    (".gemini", "antigravity", "playground"),
    (".gemini", "antigravity", "html_artifacts"),
    (".cursor", "projects"),
    (".cursor", "ai-tracking"),
    (".cursor", "worktrees"),
    (".copilot", "config.json"),
    (".kimi-code", "oauth"),
    (".kimi", "oauth"),
    (".ssh",),
    (".gnupg",),
    (".aws",),
    (".netrc",),
    (".docker", "config.json"),
    (".config", "gh", "hosts.yml"),
    (".kube", "config"),
    ("Library", "Keychains"),
)
DATA_VOLUME = "/System/Volumes/Data"  # macOS: the same files under a second absolute path


def _homes():
    out = {os.path.normpath(HOME)}
    try:
        out.add(os.path.realpath(HOME))
    except OSError:
        pass
    for h in list(out):
        if h.startswith("/") and not h.startswith(DATA_VOLUME + "/"):
            out.add(DATA_VOLUME + h)
    return out


def _fold(p):
    """Compare form of a path: APFS is case-insensitive, so ~/.GEMINI/... is ~/.gemini/..."""
    return os.path.normcase(os.path.normpath(p)).casefold()


_DENY_FOLDERS = [None, ()]  # [the HOME they were built for, ((folded DENY_UNDER folder, same + sep), ...)]


def _deny_folders():
    """The DENY_UNDER folders under every form of the home, folded. Built once per HOME: the tokens walk asks
    for every folder it enters, and rebuilding means a realpath and ~80 folded joins each time."""
    if _DENY_FOLDERS[0] != HOME:
        ds = [_fold(os.path.join(h, *under)) for h in _homes() for under in DENY_UNDER]
        _DENY_FOLDERS[:] = [HOME, tuple((d, d + os.sep) for d in ds)]
    return _DENY_FOLDERS[1]


def _denied_one(path):
    p = _fold(path)
    base = os.path.basename(p)
    if base in DENY_NAMES or base.endswith(DENY_SUFFIXES) or DENY_NAME_RE.match(base) or any(w in base for w in DENY_WORDS):
        return True
    return _denied_where(p)


def _denied_where(p):
    """The folder rules alone: denied path parts, denied folders under the home, cc-mirror internals."""
    p = _fold(p)
    if any(part in DENY_PARTS for part in p.split(os.sep)):
        return True
    for d, below in _deny_folders():
        if p == d or p.startswith(below):
            return True
    if re.search(r"/\.cc-mirror/[^/]+/(npm|tweakcc)(/|$)", p, re.I):
        return True
    return False


# The project folder being read, if any. Every path lexically inside it must also resolve inside it, so a
# symlink in a repository can't make the probe read files elsewhere (home stores, keys, other projects).
CONFINE = None


def confined(root, fn, *a):
    """fn(*a) with reads confined to root (None: no confinement, for the agent's own global files)."""
    global CONFINE
    prev, CONFINE = CONFINE, root
    try:
        return fn(*a)
    finally:
        CONFINE = prev


def _escapes(path, real):
    """True when a path inside the confined project resolves outside it."""
    if not CONFINE:
        return False
    root = os.path.normpath(CONFINE)
    p = os.path.normpath(os.path.abspath(path))
    if not (p == root or p.startswith(root.rstrip(os.sep) + os.sep)):
        return False
    try:
        r = os.path.realpath(root)
    except OSError:
        return True
    return not (real == r or real.startswith(r.rstrip(os.sep) + os.sep))


def _resolve(path):
    """(realpath, refused) for a path: refused when denied by path or target, or when it escapes the project."""
    try:
        path = os.fspath(path)
        real = os.path.realpath(path)
    except (TypeError, ValueError, OSError):
        return None, True
    if _denied_one(os.path.abspath(path)) or _denied_one(real) or _escapes(path, real):
        return real, True
    return real, False


def forbidden(path):
    """True for a file this probe must never open: by its path or by what it resolves to."""
    return _resolve(path)[1]


def open_regular(path):
    """A binary file object for an allowed regular file, else None. Never blocks on a FIFO."""
    real, refused = _resolve(path)
    if refused:
        return None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    except (OSError, TypeError, ValueError):
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            os.close(fd)
            return None
        checked = os.stat(real)  # the file opened must be the one the checks resolved (no swap in between)
        if (st.st_dev, st.st_ino) != (checked.st_dev, checked.st_ino):
            os.close(fd)
            return None
        return os.fdopen(fd, "rb")
    except OSError:
        os.close(fd)
        return None


def read_bytes(path, limit, whole=False):
    f = open_regular(path)
    if f is None:
        return None
    with f:
        try:
            data = f.read(limit + 1)
        except OSError:
            return None
    if len(data) > limit:
        return None if whole else data[:limit]
    return data


def read_text(path, limit=MAX_FM):
    data = read_bytes(path, limit)
    return data.decode("utf-8", errors="replace") if data is not None else ""


def size_of(path):
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def isdir(path):
    return not forbidden(path) and os.path.isdir(path)


def isfile(path):
    return not forbidden(path) and os.path.isfile(path)


def exists(path):
    """Existence only (a stat; the file is never opened)."""
    return os.path.lexists(path)


# ---------- config parsing with parse-time pruning ----------

SENSITIVE = {
    "env", "environment", "envvars", "envfile", "headers", "httpheaders", "apikey", "apikeys", "token", "tokens",
    "accesstoken", "refreshtoken", "idtoken", "auth", "authorization", "authtoken", "provider", "providers",
    "modelprovider", "modelproviders", "password", "passwd", "secret", "secrets", "clientsecret", "clientid", "oauth",
    "oauthaccount", "apikeyhelper", "credentials", "credential", "primaryapikey", "bearertoken", "bearertokenenvvar",
    "args", "arguments", "argv", "customapikeyresponses", "services", "cookie", "cookies", "baseurl", "shellenv",
    "awsauthrefresh", "awscredentialexport", "otelheadershelper", "key", "keys", "privatekey",
    "auths", "bearer", "dsn", "connectionstring",
}


def sensitive(key):
    k = re.sub(r"[_\-\s.]", "", str(key)).lower()
    return k in SENSITIVE or k.endswith(("token", "tokens", "secret", "apikey", "password", "headers", "dsn", "connectionstring"))


def _pairs(pairs):
    return {k: v for k, v in pairs if not sensitive(k)}


def prune(value):
    if isinstance(value, dict):
        return {k: prune(v) for k, v in value.items() if not sensitive(k)}
    if isinstance(value, list):
        return [prune(v) for v in value]
    return value


def strip_jsonc(s):
    """JSON with comments and trailing commas → JSON; string contents are left alone."""
    out, i, n, ins = [], 0, len(s), False
    while i < n:
        c = s[i]
        if ins:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(s[i + 1])
                i += 2
                continue
            if c == '"':
                ins = False
            i += 1
            continue
        if c == '"':
            ins = True
            out.append(c)
            i += 1
            continue
        if s.startswith("//", i):
            j = s.find("\n", i)
            i = n if j < 0 else j
            continue
        if s.startswith("/*", i):
            j = s.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        out.append(c)
        i += 1
    t = "".join(out)
    res, i, n, ins = [], 0, len(t), False
    while i < n:  # second string-aware pass: drop commas that only precede a closing bracket
        c = t[i]
        if ins:
            res.append(c)
            if c == "\\" and i + 1 < n:
                res.append(t[i + 1])
                i += 2
                continue
            if c == '"':
                ins = False
            i += 1
            continue
        if c == '"':
            ins = True
        elif c == ",":
            j = i + 1
            while j < n and t[j] in " \t\r\n":
                j += 1
            if j < n and t[j] in "}]":
                i += 1
                continue
        res.append(c)
        i += 1
    return "".join(res)


def read_json(path, jsonc=False):
    data = read_bytes(path, MAX_JSON, whole=True)
    if data is None:
        return None
    try:
        text = data.decode("utf-8-sig")
        if jsonc:
            text = strip_jsonc(text)
        v = json.loads(text, object_pairs_hook=_pairs)
    except ValueError:
        return None
    return v


def read_toml(path):
    if tomllib is None:
        return None
    data = read_bytes(path, MAX_JSON, whole=True)
    if data is None:
        return None
    try:
        return prune(tomllib.loads(data.decode("utf-8-sig")))
    except (ValueError, UnicodeDecodeError):
        return None


def obj(v):
    return v if isinstance(v, dict) else {}


# ---------- pure helpers ----------

def frontmatter(text, keys=("name", "description")):
    """Chosen keys from a markdown file's YAML frontmatter; the body is never used."""
    out = {}
    if not text.startswith("---"):
        return out
    end = text.find("\n---", 3)
    if end < 0:
        return out
    lines = text[3:end].splitlines()
    i = 0
    while i < len(lines):
        m = re.match(r"^([A-Za-z_-]+):\s*(.*)$", lines[i])
        if m and m.group(1) not in keys:
            m = None
        if m:
            key, val = m.group(1), m.group(2).strip()
            if val in ("|", ">", "|-", ">-", ""):
                parts = []
                i += 1
                while i < len(lines) and (lines[i].startswith(" ") or not lines[i].strip()):
                    parts.append(lines[i].strip())
                    i += 1
                out[key] = " ".join(p for p in parts if p)
                continue
            out[key] = val.strip("'\"")
        i += 1
    return out


def one_line(s, n=160):
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


WRAPPERS = {
    "env": {"-u", "-C", "-S", "-P", "--unset", "--chdir", "--split-string"},
    "sudo": {"-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U", "--user", "--group"},
    "exec": {"-a"},
    "command": set(),
    "nohup": set(),
}


def first_word(command):
    """The program a command runs, by base name only: from a command line or an argv list."""
    if isinstance(command, list):
        words = [w for w in command if isinstance(w, str)]
    elif isinstance(command, str) and command.strip():
        try:
            words = shlex.split(command)
        except ValueError:
            words = command.split()
    else:
        return ""
    takes_value, skip_next, options_done = set(), False, False
    for w in words:
        if skip_next:
            skip_next = False
            continue
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", w):
            continue
        if not options_done and w == "--":
            options_done = True
            continue
        if not options_done and w.startswith("-"):
            skip_next = w in takes_value
            continue
        base = os.path.basename(w.rstrip("/"))
        if base in WRAPPERS:
            takes_value, options_done = WRAPPERS[base], False
            continue
        return base if PROGRAM_RE.match(base) else ""
    return ""


def url_host(url):
    """Only the host of a URL: no credentials, port, path or query."""
    if not isinstance(url, str):
        return ""
    try:
        h = urlsplit(url.strip()).hostname
    except ValueError:
        h = None
    return h or ""


TRANSPORTS = {"stdio": "stdio", "local": "stdio", "command": "stdio", "http": "http", "streamable-http": "http",
              "streamablehttp": "http", "remote": "http", "sse": "sse", "ws": "ws", "websocket": "ws"}


def mcp_entry(name, spec):
    """A server's safe summary: name, transport, and the program's base name or the URL's host."""
    spec = obj(spec)
    url = next((spec[k] for k in ("url", "httpUrl", "serverUrl", "uri") if isinstance(spec.get(k), str)), None)
    raw = spec.get("type") or spec.get("transport")
    kind = TRANSPORTS.get(str(raw).lower(), "other") if isinstance(raw, str) else ("http" if url else "stdio")
    out = {"name": str(name), "transport": kind}
    out["detail"] = first_word(spec.get("command")) if kind == "stdio" else url_host(url)
    if spec.get("enabled") is False or spec.get("disabled") is True:
        out["desc"] = "disabled"
    return out


def mcp_list(servers, src=None):
    if not isinstance(servers, dict):
        return []
    rows = [mcp_entry(n, s) for n, s in sorted(servers.items(), key=lambda kv: str(kv[0]))]
    if src:
        for r in rows:
            r["src"] = src
    return rows


def hook_events(hooks):
    """{event: handler count} from the hook shapes agents use: a dict of lists, or a list of {event}."""
    out = {}
    if isinstance(hooks, dict):
        for event, groups in hooks.items():
            if not isinstance(groups, list):
                continue
            n = 0
            for g in groups:
                if isinstance(g, dict) and isinstance(g.get("hooks"), list):
                    n += len(g["hooks"])
                elif g is not None:
                    n += 1
            out[str(event)] = out.get(str(event), 0) + n
    elif isinstance(hooks, list):
        for h in hooks:
            ev = obj(h).get("event")
            if isinstance(ev, str):
                out[ev] = out.get(ev, 0) + 1
    return out


def hook_rows(*maps, src=None):
    merged = {}
    for m in maps:
        for k, v in m.items():
            merged[k] = merged.get(k, 0) + v
    rows = [{"name": k, "desc": f"{v} handler{'' if v == 1 else 's'}"} for k, v in sorted(merged.items())]
    if src:
        for r in rows:
            r["src"] = src
    return rows


def plugin_name(spec):
    """A plugin reference without its version, credentials or URL path."""
    s = str(spec or "").strip().split("#", 1)[0]
    if "://" in s:
        if s.lower().startswith("file:"):
            return os.path.basename(urlsplit(s).path.rstrip("/")) or "file"
        return url_host(s) or "url"
    if s.startswith("@"):
        scope, _, rest = s.partition("/")
        return scope + "/" + rest.split("@")[0] if rest else s
    if "/" in s or s.startswith("~"):
        return os.path.basename(s.rstrip("/"))
    return s.split("@")[0]


def model_id(v):
    if isinstance(v, dict):
        v = v.get("name")
    return v if isinstance(v, str) and MODEL_RE.match(v) else None


def tokens_of(n):
    return int(round(n / 4))


def under(path, root):
    try:
        p, r = os.path.realpath(path), os.path.realpath(root)
    except OSError:
        return False
    return p == r or p.startswith(r + os.sep)


# ---------- item collectors ----------

PRIVATE = ("_path", "_confine")  # where an item's file is and its confinement: used by `read`, never printed


def private(path):
    return {"_path": path, "_confine": CONFINE}


def instr_item(path, label=None):
    if not isfile(path):
        return None
    n = size_of(path)
    return {"name": label or path, "desc": f"{n:,} bytes · ≈{tokens_of(n):,} tok", "size": n, "tokens": tokens_of(n), **private(path)}


def instr_items(paths):
    return [it for it in (instr_item(p) for p in paths) if it]


def tag(items, src):
    if src:
        for it in items:
            it.setdefault("src", src)
    return items


PRUNE = {".git", "node_modules"}


def walk_files(d, pattern):
    """Files named like pattern anywhere under d, as glob's `**` saw them (dot names skipped), but never
    following a folder symlink, skipping .git and node_modules, and looking at no more than MAX_WALK files."""
    out, seen = [], 0
    for top, dirs, files in os.walk(d, followlinks=False):
        dirs[:] = sorted(x for x in dirs if not x.startswith(".") and x not in PRUNE)
        for f in sorted(files):
            seen += 1
            if seen > MAX_WALK:
                return sorted(out)
            if not f.startswith(".") and fnmatch.fnmatchcase(f, pattern):
                out.append(os.path.join(top, f))
    return sorted(out)


def skill_items(d, src=None):
    """Skills in d/<name>/SKILL.md: name and frontmatter description only. A <name> symlink (how skills are
    installed) is resolved for that one SKILL.md only, which must pass the deny and project checks."""
    if not isdir(d):
        return []
    try:
        entries = sorted(n for n in os.listdir(d) if not n.startswith("."))[:MAX_WALK]
    except OSError:
        return []
    items = []
    for n in entries:
        p = os.path.join(d, n, "SKILL.md")
        if forbidden(p) or not os.path.isfile(p):
            continue
        fm = frontmatter(read_text(p))
        items.append({"name": fm.get("name") or n, "desc": one_line(fm.get("description")), **private(p)})
    return tag(items, src)


def md_items(d, pattern="*.md", src=None, strip=".md", recursive=False):
    if not isdir(d):
        return []
    items = []
    found = walk_files(d, pattern) if recursive else glob.glob(os.path.join(G(d), pattern))
    for p in sorted(found):
        if forbidden(p) or not os.path.isfile(p):
            continue
        fm = frontmatter(read_text(p))
        rel = os.path.relpath(p, d)
        base = rel[: -len(strip)] if rel.endswith(strip) else os.path.splitext(rel)[0]
        name = fm.get("name") or base.replace(os.sep, ":")
        items.append({"name": name, "desc": one_line(fm.get("description")), **private(p)})
    return tag(items, src)


def toml_items(d, pattern="*.toml", src=None, recursive=False):
    """TOML-defined agents or commands: name and description keys only."""
    if not isdir(d):
        return []
    items = []
    found = walk_files(d, pattern) if recursive else glob.glob(os.path.join(G(d), pattern))
    for p in sorted(found):
        if forbidden(p) or not os.path.isfile(p):
            continue
        data = obj(read_toml(p))
        rel = os.path.splitext(os.path.relpath(p, d))[0].replace(os.sep, ":")
        name = data.get("name") if isinstance(data.get("name"), str) else rel
        desc = data.get("description") if isinstance(data.get("description"), str) else ""
        items.append({"name": name, "desc": one_line(desc), **private(p)})
    return tag(items, src)


def file_names(d, src=None, exts=None):
    """Plain file names in a folder (plugins), without dot files or package manifests."""
    if not isdir(d):
        return []
    out = []
    for n in sorted(os.listdir(d)):
        if n.startswith(".") or n in ("package.json", "package-lock.json", "bun.lock", "node_modules", "tsconfig.json"):
            continue
        if exts and not n.endswith(exts):
            continue
        out.append({"name": n})
    return tag(out, src)


def dir_names(d, src=None):
    if not isdir(d):
        return []
    return tag([{"name": n} for n in sorted(os.listdir(d)) if not n.startswith(".") and os.path.isdir(os.path.join(d, n))], src)


def config_instructions(lst, base, project=False):
    """`instructions` entries of an OpenCode/Kilo config: file paths with sizes, URLs as their host.
    A project's config may only name files inside the project: absolute, `~` and `..` paths are refused."""
    out = []
    for s in lst if isinstance(lst, list) else []:
        if not isinstance(s, str) or not s.strip():
            continue
        if "://" in s:
            out.append({"name": url_host(s) or "url", "desc": "remote instructions"})
            continue
        if project and (os.path.isabs(s) or s.startswith("~") or ".." in s.replace("\\", "/").split("/")):
            out.append({"name": os.path.basename(s.rstrip("/")) or "path", "desc": "outside the project: not read"})
            continue
        p = hp(s[2:]) if s.startswith("~/") else s
        p = p if os.path.isabs(p) else os.path.join(base, p)
        if any(ch in s for ch in "*?["):
            out.append({"name": p, "desc": "pattern"})
            continue
        it = instr_item(p)
        out.append(it or {"name": p, "desc": "not found"})
    return out


def dedupe(items):
    seen, out = set(), []
    for it in items:
        key = (it.get("name"), it.get("src"))
        if key in seen:
            continue
        seen.add(key)
        out.append(it)
    return out


def groups(**kw):
    g = {k: [] for k in ("instructions", "skills", "agents", "commands", "hooks", "mcp", "plugins")}
    for k, v in kw.items():
        g[k] = dedupe(v or [])[:MAX_ITEMS]
    return g


AGENTS_SKILLS = ("~/.agents", (".agents", "skills"))


def shared_skills():
    return skill_items(hp(*AGENTS_SKILLS[1]), AGENTS_SKILLS[0])


# ---------- Claude Code and its mirrors (root is a parameter: a mirror never shows ~/.claude) ----------

def claude_plugins(root, settings_list):
    """Enabled plugins and what they bring; install paths are used only when inside root/plugins."""
    data = obj(read_json(os.path.join(root, "plugins", "installed_plugins.json")))
    installs = {}
    for key, entries in obj(data.get("plugins")).items():
        if isinstance(entries, list) and entries and isinstance(entries[-1], dict):
            installs[str(key)] = entries[-1].get("installPath") if isinstance(entries[-1].get("installPath"), str) else ""
    enabled = {}
    for s in settings_list:
        for k, v in obj(obj(s).get("enabledPlugins")).items():
            enabled[str(k)] = bool(v)
    plugins, skills, agents, commands = [], [], [], []
    for key in sorted(set(installs) | set(enabled)):
        name, _, market = key.partition("@")
        on = enabled.get(key, False)
        state = "enabled" if on else "installed, not enabled"
        if key not in installs:
            state = "enabled, not installed"
        plugins.append({"name": name, "desc": f"{market} · {state}" if market else state})
        path = installs.get(key)
        if on and path and under(path, os.path.join(root, "plugins")):
            skills += skill_items(os.path.join(path, "skills"), name)
            agents += md_items(os.path.join(path, "agents"), src=name)
            commands += md_items(os.path.join(path, "commands"), src=name, recursive=True)
    return plugins, skills, agents, commands


def encode_cwd(cwd):
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)


def claude_global(root, cj_path):
    settings = obj(read_json(os.path.join(root, "settings.json")))
    cj = obj(read_json(cj_path))
    plugins, ps, pa, pc = claude_plugins(root, [settings])
    rules = os.path.join(root, "rules")
    instr = [os.path.join(root, "CLAUDE.md")] + (walk_files(rules, "*.md") if isdir(rules) else [])
    g = groups(
        instructions=instr_items(instr),
        skills=skill_items(os.path.join(root, "skills")) + ps,
        agents=md_items(os.path.join(root, "agents")) + pa,
        commands=md_items(os.path.join(root, "commands"), recursive=True) + pc,
        hooks=hook_rows(hook_events(settings.get("hooks"))),
        mcp=mcp_list(cj.get("mcpServers")),
        plugins=plugins,
    )
    return g, model_id(settings.get("model"))


def claude_project(root, cj_path, folder):
    cl = os.path.join(folder, ".claude")
    s1 = obj(read_json(os.path.join(cl, "settings.json")))
    s2 = obj(read_json(os.path.join(cl, "settings.local.json")))
    cj = obj(confined(None, read_json, cj_path))  # the agent's own global file, not the project's
    servers = dict(obj(obj(read_json(os.path.join(folder, ".mcp.json"))).get("mcpServers")))
    servers.update(obj(obj(obj(cj.get("projects")).get(folder)).get("mcpServers")))
    enabled = {}
    for s in (s1, s2):
        for k, v in obj(s.get("enabledPlugins")).items():
            enabled[str(k)] = bool(v)
    instr = [os.path.join(folder, n) for n in ("CLAUDE.md", "CLAUDE.local.md", os.path.join(".claude", "CLAUDE.md"))]
    rules = os.path.join(cl, "rules")
    instr += walk_files(rules, "*.md") if isdir(rules) else []
    memory = confined(None, instr_items, [os.path.join(root, "projects", encode_cwd(folder), "memory", "MEMORY.md")])
    return groups(
        instructions=instr_items(instr) + memory,
        skills=skill_items(os.path.join(cl, "skills")),
        agents=md_items(os.path.join(cl, "agents")),
        commands=md_items(os.path.join(cl, "commands"), recursive=True),
        hooks=hook_rows(hook_events(s1.get("hooks")), hook_events(s2.get("hooks"))),
        mcp=mcp_list(servers),
        plugins=[{"name": k.partition("@")[0], "desc": k.partition("@")[2] or ""} for k, v in sorted(enabled.items()) if v],
    )


def mirror_ids():
    base = hp(".cc-mirror")
    if not isdir(base):
        return []
    return [n for n in sorted(os.listdir(base)) if ID_RE.match(n) and isdir(os.path.join(base, n, "config"))]


def mirror_label(mid):
    """The mirror's name from variant.json (only the `name` field is used)."""
    name = obj(read_json(hp(".cc-mirror", mid, "variant.json"))).get("name")
    return one_line(name, 40) if isinstance(name, str) and name.strip() else mid


# ---------- the other agents ----------

def kimi_root():
    return hp(".kimi-code") if isdir(hp(".kimi-code")) else hp(".kimi")


def bin_path(*cands):
    for c in cands:
        p = hp(*c) if isinstance(c, tuple) else c
        if exists(p):
            return p
    return None


def a_codex(root):
    cfg = obj(read_toml(os.path.join(root, "config.toml")))
    hooks_json = obj(read_json(os.path.join(root, "hooks.json")))
    toml_hooks = {k: v for k, v in obj(cfg.get("hooks")).items() if isinstance(v, list)}
    instr = [os.path.join(root, "AGENTS.md"), os.path.join(root, "AGENTS.override.md")]
    instr += sorted(glob.glob(os.path.join(G(root), "rules", "*.rules")))
    g = groups(
        instructions=instr_items(instr),
        skills=skill_items(os.path.join(root, "skills")) + shared_skills(),
        agents=toml_items(os.path.join(root, "agents")),
        commands=md_items(os.path.join(root, "prompts")),
        hooks=hook_rows(hook_events(hooks_json.get("hooks")), hook_events(toml_hooks)),
        mcp=mcp_list(cfg.get("mcp_servers")),
    )
    return g, model_id(cfg.get("model"))


def p_codex(folder):
    cd = os.path.join(folder, ".codex")
    cfg = obj(read_toml(os.path.join(cd, "config.toml")))
    return groups(
        instructions=instr_items([os.path.join(folder, "AGENTS.md"), os.path.join(folder, "AGENTS.override.md")]),
        skills=skill_items(os.path.join(cd, "skills")) + skill_items(os.path.join(folder, ".agents", "skills"), ".agents"),
        agents=toml_items(os.path.join(cd, "agents")),
        hooks=hook_rows(hook_events(obj(read_json(os.path.join(cd, "hooks.json"))).get("hooks"))),
        mcp=mcp_list(cfg.get("mcp_servers")),
    )


def a_gemini(root):
    s = obj(read_json(os.path.join(root, "settings.json")))
    g = groups(
        instructions=instr_items([os.path.join(root, "GEMINI.md")]),
        skills=skill_items(os.path.join(root, "skills")) + shared_skills(),
        agents=md_items(os.path.join(root, "agents")),
        commands=toml_items(os.path.join(root, "commands"), recursive=True),
        hooks=hook_rows(hook_events(s.get("hooks"))),
        mcp=mcp_list(s.get("mcpServers")),
        plugins=dir_names(os.path.join(root, "extensions")),
    )
    return g, model_id(s.get("model"))


def p_gemini(folder):
    gd = os.path.join(folder, ".gemini")
    s = obj(read_json(os.path.join(gd, "settings.json")))
    return groups(
        instructions=instr_items([os.path.join(folder, "GEMINI.md")]),
        skills=skill_items(os.path.join(gd, "skills")) + skill_items(os.path.join(folder, ".agents", "skills"), ".agents"),
        agents=md_items(os.path.join(gd, "agents")),
        commands=toml_items(os.path.join(gd, "commands"), recursive=True),
        hooks=hook_rows(hook_events(s.get("hooks"))),
        mcp=mcp_list(s.get("mcpServers")),
        plugins=dir_names(os.path.join(gd, "extensions")),
    )


def ext_name(n):
    """`publisher.name-1.2.3-darwin-arm64` → `publisher.name`."""
    m = re.match(r"^(.+?)-\d+(\.\d+)+", n)
    return m.group(1) if m else n


def a_antigravity(root):
    exts = hp(".antigravity", "extensions")
    names = sorted({ext_name(n) for n in os.listdir(exts) if not n.startswith(".") and os.path.isdir(os.path.join(exts, n))}) if isdir(exts) else []
    g = groups(
        instructions=instr_items([hp(".gemini", "GEMINI.md")]),
        skills=skill_items(os.path.join(root, "skills")),
        commands=md_items(os.path.join(root, "global_workflows")),
        mcp=mcp_list(obj(read_json(os.path.join(root, "mcp_config.json"))).get("mcpServers")),
        plugins=[{"name": n} for n in names],
    )
    return g, None


def p_antigravity(folder):
    ad = os.path.join(folder, ".agent")
    return groups(
        instructions=instr_items([os.path.join(folder, "GEMINI.md"), os.path.join(folder, "AGENTS.md")]) + md_items(os.path.join(ad, "rules"), src=".agent/rules"),
        skills=skill_items(os.path.join(ad, "skills")),
        commands=md_items(os.path.join(ad, "workflows")),
    )


def a_kimi(root):
    cfg = obj(read_toml(os.path.join(root, "config.toml")))
    g = groups(
        instructions=instr_items([os.path.join(root, "AGENTS.md")]),
        skills=skill_items(os.path.join(root, "skills")),
        hooks=hook_rows(hook_events(cfg.get("hooks"))),
        mcp=mcp_list(obj(read_json(os.path.join(root, "mcp.json"))).get("mcpServers")),
    )
    return g, model_id(cfg.get("default_model"))


def p_kimi(folder):
    return groups(instructions=instr_items([os.path.join(folder, "AGENTS.md")]))


def opencode_like(cfg, base, project=False):
    """Shared shape of OpenCode and Kilo configs: plugins, MCP, instructions, inline agents and commands."""
    plugs = cfg.get("plugin") if isinstance(cfg.get("plugin"), list) else []
    plugins = [{"name": plugin_name(p), "desc": "config"} for p in plugs if isinstance(p, str)]
    agents = [{"name": str(k), "desc": one_line(obj(v).get("description")) if isinstance(obj(v).get("description"), str) else "inline"} for k, v in obj(cfg.get("agent")).items()]
    commands = [{"name": str(k), "desc": one_line(obj(v).get("description")) if isinstance(obj(v).get("description"), str) else "inline"} for k, v in obj(cfg.get("command")).items()]
    return {
        "plugins": plugins,
        "mcp": mcp_list(cfg.get("mcp")),
        "instructions": config_instructions(cfg.get("instructions"), base, project),
        "agents": agents,
        "commands": commands,
    }


def read_cfg(*paths):
    for p in paths:
        if isfile(p):
            return obj(read_json(p, jsonc=True)), os.path.dirname(p)
    return {}, None


def a_kilo(root):
    cfg, base = read_cfg(os.path.join(root, "kilo.jsonc"), os.path.join(root, "kilo.json"))
    oc = opencode_like(cfg, base or root)
    extra = []
    for p in obj(cfg.get("skills")).get("paths") or []:
        if isinstance(p, str):
            d = hp(p[2:]) if p.startswith("~/") else (p if os.path.isabs(p) else os.path.join(root, p))
            extra += skill_items(d, "skills.paths")
    g = groups(
        instructions=instr_items([os.path.join(root, "AGENTS.md")]) + oc["instructions"] + md_items(os.path.join(root, "rules"), src="rules"),
        skills=skill_items(os.path.join(root, "skills")) + skill_items(hp(".kilo", "skills"), "~/.kilo")
        + skill_items(hp(".kilocode", "skills"), "~/.kilocode") + extra,
        agents=md_items(os.path.join(root, "agents")) + md_items(hp(".kilo", "agent"), src="~/.kilo") + oc["agents"],
        commands=md_items(os.path.join(root, "commands")) + md_items(hp(".kilo", "command"), src="~/.kilo") + oc["commands"],
        mcp=oc["mcp"],
        plugins=oc["plugins"] + file_names(os.path.join(root, "plugin"), "plugin/"),
    )
    return g, model_id(cfg.get("model"))


def p_kilo(folder):
    cfg, base = read_cfg(os.path.join(folder, "kilo.jsonc"), os.path.join(folder, "kilo.json"),
                         os.path.join(folder, ".kilo", "kilo.jsonc"), os.path.join(folder, ".kilo", "kilo.json"))
    oc = opencode_like(cfg, base or folder, project=True)
    kd, kc = os.path.join(folder, ".kilo"), os.path.join(folder, ".kilocode")
    return groups(
        instructions=instr_items([os.path.join(folder, "AGENTS.md")]) + oc["instructions"]
        + md_items(os.path.join(kd, "rules"), src=".kilo/rules") + md_items(os.path.join(kc, "rules"), src=".kilocode/rules"),
        skills=skill_items(os.path.join(kd, "skills")) + skill_items(os.path.join(kc, "skills"), ".kilocode"),
        agents=md_items(os.path.join(kd, "agent")) + md_items(os.path.join(kd, "agents")) + oc["agents"],
        commands=md_items(os.path.join(kd, "command")) + md_items(os.path.join(kc, "workflows"), src=".kilocode/workflows") + oc["commands"],
        mcp=oc["mcp"],
        plugins=oc["plugins"],
    )


def a_opencode(root):
    cfg, base = read_cfg(os.path.join(root, "opencode.jsonc"), os.path.join(root, "opencode.json"))
    oc = opencode_like(cfg, base or root)
    g = groups(
        instructions=instr_items([os.path.join(root, "AGENTS.md")]) + oc["instructions"] + md_items(os.path.join(root, "rules"), src="rules"),
        skills=skill_items(os.path.join(root, "skills")) + skill_items(hp(".opencode", "skills"), "~/.opencode") + shared_skills(),
        agents=md_items(os.path.join(root, "agents")) + md_items(os.path.join(root, "agent")) + oc["agents"],
        commands=md_items(os.path.join(root, "commands")) + md_items(os.path.join(root, "command")) + oc["commands"],
        mcp=oc["mcp"],
        plugins=oc["plugins"] + file_names(os.path.join(root, "plugins"), "plugins/") + file_names(os.path.join(root, "plugin"), "plugin/"),
    )
    return g, model_id(cfg.get("model"))


def p_opencode(folder):
    cfg, base = read_cfg(os.path.join(folder, "opencode.jsonc"), os.path.join(folder, "opencode.json"))
    oc = opencode_like(cfg, base or folder, project=True)
    od = os.path.join(folder, ".opencode")
    return groups(
        instructions=instr_items([os.path.join(folder, "AGENTS.md")]) + oc["instructions"],
        skills=skill_items(os.path.join(od, "skills")) + skill_items(os.path.join(folder, ".agents", "skills"), ".agents"),
        agents=md_items(os.path.join(od, "agents")) + md_items(os.path.join(od, "agent")) + oc["agents"],
        commands=md_items(os.path.join(od, "commands")) + md_items(os.path.join(od, "command")) + oc["commands"],
        mcp=oc["mcp"],
        plugins=oc["plugins"] + file_names(os.path.join(od, "plugins"), ".opencode/plugins") + file_names(os.path.join(od, "plugin"), ".opencode/plugin"),
    )


def a_cursor(root):
    g = groups(
        skills=skill_items(os.path.join(root, "skills")),
        agents=md_items(os.path.join(root, "agents")),
        commands=md_items(os.path.join(root, "commands")),
        hooks=hook_rows(hook_events(obj(read_json(os.path.join(root, "hooks.json"))).get("hooks"))),
        mcp=mcp_list(obj(read_json(os.path.join(root, "mcp.json"))).get("mcpServers")),
    )
    return g, None


def p_cursor(folder):
    cd = os.path.join(folder, ".cursor")
    rules = walk_files(os.path.join(cd, "rules"), "*.md*") if isdir(os.path.join(cd, "rules")) else []
    return groups(
        instructions=instr_items([os.path.join(folder, "AGENTS.md"), os.path.join(folder, ".cursorrules")] + rules),
        skills=skill_items(os.path.join(cd, "skills")),
        agents=md_items(os.path.join(cd, "agents")),
        commands=md_items(os.path.join(cd, "commands")),
        hooks=hook_rows(hook_events(obj(read_json(os.path.join(cd, "hooks.json"))).get("hooks"))),
        mcp=mcp_list(obj(read_json(os.path.join(cd, "mcp.json"))).get("mcpServers")),
    )


def copilot_hooks(d):
    maps = []
    for p in sorted(glob.glob(os.path.join(G(d), "*.json"))) if isdir(d) else []:
        maps.append(hook_events(obj(read_json(p)).get("hooks")))
    return hook_rows(*maps)


def a_copilot(root):
    g = groups(
        instructions=instr_items([os.path.join(root, "copilot-instructions.md")]),
        skills=skill_items(os.path.join(root, "skills")),
        agents=md_items(os.path.join(root, "agents"), strip=".agent.md"),
        hooks=copilot_hooks(os.path.join(root, "hooks")),
        mcp=mcp_list(obj(read_json(os.path.join(root, "mcp-config.json"))).get("mcpServers")),
        plugins=dir_names(os.path.join(root, "installed-plugins")),
    )
    return g, None


def p_copilot(folder):
    gh = os.path.join(folder, ".github")
    instr = [os.path.join(folder, "AGENTS.md"), os.path.join(gh, "copilot-instructions.md")]
    instr += sorted(glob.glob(os.path.join(G(gh), "instructions", "*.instructions.md")))
    return groups(
        instructions=instr_items(instr),
        skills=skill_items(os.path.join(gh, "skills")),
        agents=md_items(os.path.join(gh, "agents"), strip=".agent.md"),
        hooks=copilot_hooks(os.path.join(gh, "hooks")),
    )


def a_skills_only(root):
    return groups(skills=skill_items(os.path.join(root, "skills"))), None


# ---------- the agent table ----------

def agent_table():
    """[(id, name, kind, roots, binary, global_fn, project_fn, sessions)] for agents whose folders exist."""
    out = []
    claude = hp(".claude")
    if isdir(claude):
        cj = hp(".claude.json")
        out.append(("claude", "Claude Code", "Claude", [claude, cj], bin_path((".local", "bin", "claude")),
                    lambda r=claude, c=cj: claude_global(r, c), lambda f, r=claude, c=cj: claude_project(r, c, f), "claude"))
    for mid in mirror_ids():
        root = hp(".cc-mirror", mid, "config")
        cj = os.path.join(root, ".claude.json")
        out.append((f"mirror-{mid}", mirror_label(mid), "Claude mirror", [root], bin_path((".local", "bin", mid)),
                    lambda r=root, c=cj: claude_global(r, c), lambda f, r=root, c=cj: claude_project(r, c, f), "claude"))
    simple = [
        ("codex", "Codex", "OpenAI", hp(".codex"), [(".local", "bin", "codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"], a_codex, p_codex, "codex"),
        ("gemini", "Gemini CLI", "Google", hp(".gemini"), ["/opt/homebrew/bin/gemini", "/usr/local/bin/gemini"], a_gemini, p_gemini, None),
        ("antigravity", "Antigravity", "Google", hp(".gemini", "antigravity"), [(".local", "bin", "agy")], a_antigravity, p_antigravity, None),
        ("kimi", "Kimi", "Moonshot", kimi_root(), [(".kimi-code", "bin", "kimi"), (".local", "bin", "kimi-cli")], a_kimi, p_kimi, None),
        ("kilo", "Kilo", "Kilo", hp(".config", "kilo"), ["/opt/homebrew/bin/kilo", "/opt/homebrew/bin/kilocode"], a_kilo, p_kilo, None),
        ("opencode", "OpenCode", "OpenCode", hp(".config", "opencode"), [(".opencode", "bin", "opencode"), "/opt/homebrew/bin/opencode"], a_opencode, p_opencode, None),
        ("cursor", "Cursor", "Cursor", hp(".cursor"), [(".local", "bin", "cursor-agent"), "/opt/homebrew/bin/cursor"], a_cursor, p_cursor, None),
        ("copilot", "Copilot CLI", "GitHub", hp(".copilot"), ["/opt/homebrew/bin/copilot"], a_copilot, p_copilot, None),
    ]
    for aid, name, kind, root, bins, gf, pf, sess in simple:
        if aid == "gemini" and not (isfile(os.path.join(root, "settings.json")) or isfile(os.path.join(root, "GEMINI.md"))):
            continue
        if aid == "kilo" and not isdir(root) and isdir(hp(".kilo")):
            root = hp(".kilo")
        if aid == "opencode" and not isdir(root) and isdir(hp(".opencode")):
            root = hp(".opencode")
        if not isdir(root):
            continue
        out.append((aid, name, kind, [root], bin_path(*bins), lambda r=root, gf=gf: gf(r), pf, sess))
    for aid, name, parts in (("qwen", "Qwen Code", (".qwen",)), ("grok", "Grok CLI", (".grok",)), ("iflow", "iFlow CLI", (".iflow",)),
                             ("qoder", "Qoder", (".qoder",)), ("crush", "Crush", (".config", "crush"))):
        root = hp(*parts)
        if isdir(os.path.join(root, "skills")):
            out.append((aid, name, "skills only", [root], None, lambda r=root: a_skills_only(r), None, None))
    return out


def counts(g):
    return {k: len(v) for k, v in (g or {}).items()}


PARTIAL = {}  # the result so far, printed instead when the deadline passes


def project_roots(folders):
    """(roots, at_home): the focused folders that exist, without the home folder itself."""
    roots = []
    for f in folders:
        f = os.path.normpath(f) if f else ""
        if f and f not in roots and isdir(f):
            roots.append(f)
    at_home = any(os.path.normpath(r) == os.path.normpath(HOME) for r in roots)
    return [r for r in roots if os.path.normpath(r) != os.path.normpath(HOME)], at_home


def build_agent(entry, roots):
    """One agent's record with its items' private fields still attached (see finish_groups)."""
    aid, name, kind, aroots, binary, gf, pf, sess = entry
    a = {"id": aid, "name": name, "kind": kind, "roots": aroots, "binary": binary, "sessions": sess, "model": None}
    try:
        g, model = gf()
        a["global"], a["model"] = g, model
    except Exception:
        a["global"], a["error"] = None, "unreadable"
    a["project"] = None
    if pf and roots:
        try:
            merged = groups()
            for r in roots:
                pg = confined(r, pf, r)
                for k in merged:
                    merged[k] += pg.get(k, [])
            a["project"] = groups(**merged)
        except Exception:
            a["projectError"] = "unreadable"
    return a


def finish_groups(g):
    """Drops the private fields; an item gets `view: true` only when `read` would show its file."""
    for k, items in (g or {}).items():
        for it in items:
            path, conf = it.pop("_path", None), it.pop("_confine", None)
            if k in VIEW_KINDS and path and confined(conf, viewable, path):
                it["view"] = True
    return g


def cmd_list(folders):
    roots, at_home = project_roots(folders)
    agents = []
    PARTIAL.update(agents=agents, folders=roots, note=None)  # what a timeout prints: the agents read so far
    for entry in agent_table():
        a = build_agent(entry, roots)
        finish_groups(a["global"])
        finish_groups(a["project"])
        a["counts"] = {"global": counts(a["global"]), "project": counts(a["project"])}
        agents.append(a)
    note = "The focused folder is the home folder; its agent folders are the global setup." if at_home and not roots else None
    return {"agents": agents, "folders": roots, "note": note}


# ---------- read: one listed instruction, skill, agent or command file ----------

VIEW_KINDS = ("instructions", "skills", "agents", "commands")  # never MCP, hooks, plugins or settings
VIEW_EXTS = (".md", ".mdc", ".toml", ".txt")
MAX_VIEW = 256 * 1024
REDACT = [
    re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|\Z)", re.S),
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{30,}"),
    re.compile(r"\bBearer\s+[^\s\"'`]+", re.I),
]
TEXT_BAD = re.compile("[\x00-\x08\x0b-\x1f\x7f-\x9f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff\U000e0000-\U000e007f]")


class Text(str):
    """File text already cleaned by clean_text: kept whole (newlines, tabs, length) by sanitize."""


def viewable(path):
    """An allowed regular file with a viewable extension, by its listed path and its target."""
    real, refused = _resolve(path)
    if refused or not real:
        return False
    if not (path.lower().endswith(VIEW_EXTS) and real.lower().endswith(VIEW_EXTS)):
        return False
    try:
        return stat.S_ISREG(os.stat(real).st_mode)
    except OSError:
        return False


def redact(text):
    for r in REDACT:
        text = r.sub("[redacted]", text)
    return text


def clean_text(text, limit=None):
    text = TEXT_BAD.sub(" ", text.replace("\r\n", "\n").replace("\r", "\n"))
    for h in sorted(_homes(), key=len, reverse=True):
        if h and h != "/":
            text = text.replace(h, "~")
    text = redact(text)
    return Text(text[:limit] if limit else text)


def cmd_read(aid, which, kind, index, name, folders):
    """A listed file's text: the path comes from this probe's own listing, never from the caller."""
    if which not in ("global", "project") or kind not in VIEW_KINDS:
        return {"error": "not viewable"}
    entry = next((e for e in agent_table() if e[0] == aid), None)
    if entry is None:
        return {"error": "no such agent"}
    roots, _ = project_roots(folders) if which == "project" else ([], False)
    a = build_agent(entry, roots)
    items = (a.get(which) or {}).get(kind) or []
    if not (0 <= index < len(items)):
        return {"error": "no such item"}
    it = items[index]
    if name is not None and clean_str(str(it.get("name"))) != name:  # the UI shows the sanitized name
        return {"error": "changed"}
    path, conf = it.get("_path"), it.get("_confine")
    if not path:
        return {"error": "not a file"}

    def load():
        if not viewable(path):
            return None
        return read_bytes(path, MAX_VIEW + 8192)

    data = confined(conf, load)
    if data is None:
        return {"error": "not viewable"}
    size = size_of(path)
    return {"name": it.get("name"), "kind": kind, "path": path, "size": size,
            "truncated": size > MAX_VIEW,
            "ext": os.path.splitext(path)[1].lower().lstrip("."),
            "content": clean_text(data.decode("utf-8", errors="replace"), MAX_VIEW)}


# ---------- tokens: token aggregates from this mod's own usage ledger ----------
#
# What is read: Claude Code transcripts (every *.jsonl under ~/.claude/projects, subagent and workflow
# transcripts included) and Codex rollouts (*.jsonl under ~/.codex/sessions and ~/.codex/archived_sessions).
# find_logs walks those folders with os.scandir without following any symlink; each file is then opened
# through open_regular, confined to its source folder (open_log). Only lines holding one of the adapter's
# LINE_MARKS are parsed as JSON; of those, only token counts, model id, timestamp and ids are used.
#
# What is kept: a ledger in <home>/.config/herdr-app/data/drover-agents/usage-store.json, mode 0600:
#   events:   {adapter: {event key: [epoch seconds, session slot, model slot, input, output, cacheRead,
#              cacheWrite]}}
#   logs:     {path key: [adapter, dev, ino, size (-1 while part-read by a cut run), mtime_ns, bytes consumed,
#              reading state]}
#   sessions: session keys (a slot is an index here); models: model ids; salt: random, per ledger.
# Every key is a BLAKE2b digest keyed with the ledger's salt, so the file holds no paths, project names,
# session or message ids, prompts or text, and its digests can't be matched against guessed paths.
#
# Identity, not bookkeeping: an event's key is derived from what the transcript says about it (a Claude
# message id; a Codex session, its reset count and its cumulative totals). Reading the same event twice, from
# a streaming snapshot, a resumed session's copy, a subagent copy, a rescan or a rollout moved to the
# archive, lands on the same key; the copy with more tokens wins and the event keeps its earliest time. The
# ledger therefore converges to the same numbers whatever order files are read in, and a file can always be
# re-read from 0 safely.
# Events outlive their transcripts (lifetime totals survive transcript cleanup). Local days are derived from
# the epoch when the aggregates are built, in the current time zone. OpenCode (SQLite) and Antigravity
# (denied folders, databases) are not read: their adapters answer "absent".
#
# Freezing keeps the store bounded per event: after a complete run, events older than FREEZE_AFTER (cut at a
# UTC day, so it moves once a day) leave the event table. Their tokens join an aggregate row per quarter hour
# and model ([q, model, in, out, cache read, cache write]; summary() only ever looks at t // 900, and local
# days start on a quarter hour in every time zone, so the days stay exact under any later zone or DST), their
# session slots join a set (the sessions count is a union), and their key keeps only its first 8 bytes in a
# packed digest list. A re-read of an old file (shrunk, replaced, moved, or a resumed session's copy) finds
# its events among the digests and skips them, so nothing doubles. The trade-offs: a frozen event is final,
# so a bigger or earlier copy that first shows up more than FREEZE_AFTER later is ignored (streaming copies
# are written within the same minute and resumed copies are equal, so this doesn't happen in practice); an
# unseen event whose 64-bit digest collides with a frozen one would be skipped (about n / 2^64 per new event:
# 5e-14 with a million frozen); and the digests still grow, 8 bytes per event instead of ~67. Freezing only
# follows a complete run, so a cut cold scan never freezes an event whose bigger copy is still unread.

TOKENS_ADAPTERS = ("claude", "codex", "opencode", "antigravity")
COLLECTED = ("claude", "codex")
STORE_V = 3
STORE_MIGRATE = (2,)  # older stores read in place: v2 is v3 with nothing frozen yet
FREEZE_AFTER = 7 * 86400
SAVE_LAG = 1024 * 1024  # bytes a log may be read past its saved offset, with no event in them, before it is saved
KEY_RE = re.compile(r"^[0-9a-f]{24}$")
STORE_NAME = "usage-store.json"
VIEW_NAME = "tokens-cache.json"
HEAT_DAYS = 84  # 12 weeks
OWN_MAX = 256 * 1024 * 1024  # largest own file read back
LOG_SOURCES = {"claude": ((".claude", "projects"),), "codex": ((".codex", "sessions"), (".codex", "archived_sessions"))}
LOG_DEPTH = 8  # folder levels below a source root (projects/<p>/<s>/subagents/workflows/<wf>/ is 5)
MAX_LOGS = 200_000
# Claude Code writes compact JSON (no space after a colon); Codex marks are values, so spacing doesn't matter.
LINE_MARKS = {"claude": (b'"usage":{',), "codex": (b"session_meta", b"turn_context", b"token_count")}
READ_CHUNK = 4 * 1024 * 1024
SCAN_BUDGET = 10.0  # seconds of transcript reading per run; a cut run is marked incomplete and resumes next run
SCAN_MARGIN = 4.0  # seconds kept free before the alarm for saving and printing
HARD_STOP = None  # monotonic time of the DEADLINE alarm when run as a program
CLOCK = time.monotonic
UNKNOWN_MODEL = "unknown"


def own_file(name):
    return hp(".config", "herdr-app", "data", "drover-agents", name)


def load_own(path, limit=OWN_MAX):
    """JSON from one of this mod's own files, or None. Opened with O_NOFOLLOW; a regular file only."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except (OSError, TypeError, ValueError):
        return None
    try:
        f = os.fdopen(fd, "rb")
    except OSError:
        os.close(fd)
        return None
    with f:
        try:
            st = os.fstat(f.fileno())
            if not stat.S_ISREG(st.st_mode) or st.st_size > limit:
                return None
            data = f.read(limit + 1)
        except OSError:
            return None
    if len(data) > limit:
        return None
    try:
        return json.loads(data)
    except (ValueError, RecursionError):
        return None


def save_own(path, value):
    """Atomically replace one of this mod's own files with JSON, mode 0600. Refuses when the folder or the
    target is a symlink or the target isn't a regular file. True when written."""
    folder = os.path.dirname(path)
    tmp = None
    try:
        os.makedirs(folder, mode=0o700, exist_ok=True)
        if os.path.islink(folder) or not os.path.isdir(folder):
            return False
        try:
            st = os.lstat(path)
            if not stat.S_ISREG(st.st_mode):
                return False
        except FileNotFoundError:
            pass
        tmp = os.path.join(folder, f".{os.path.basename(path)}.{os.getpid()}.{os.urandom(4).hex()}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            os.fchmod(f.fileno(), 0o600)
            json.dump(value, f, separators=(",", ":"))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        return True
    except (OSError, TypeError, ValueError):
        if tmp:
            try:
                os.remove(tmp)
            except OSError:
                pass
        return False


def find_logs(adapter):
    """([(path, root, stat)], whole) for an adapter's transcripts: *.jsonl regular files under its source
    folders, found without following symlinks, skipping dot names and denied folders. whole is False when
    MAX_LOGS stopped the walk."""
    out = []
    for parts in LOG_SOURCES[adapter]:
        root = hp(*parts)
        if not isdir(root):
            continue
        stack = [(root, 0)]
        while stack:
            folder, depth = stack.pop()
            try:
                entries = os.scandir(folder)
            except OSError:
                continue
            with entries:
                for e in entries:
                    if e.name.startswith("."):
                        continue
                    try:
                        if e.is_symlink():
                            continue
                        if e.is_dir(follow_symlinks=False):
                            if depth < LOG_DEPTH and not _denied_where(e.path):
                                stack.append((e.path, depth + 1))
                        elif e.name.endswith(".jsonl") and e.is_file(follow_symlinks=False):
                            out.append((e.path, root, e.stat(follow_symlinks=False)))
                    except OSError:
                        continue
                    if len(out) >= MAX_LOGS:
                        return out, False
    return out, True


def open_log(path, root):
    """A transcript opened through open_regular, confined to its source folder; None when refused."""
    return confined(root, open_regular, path)


def marked_lines(block, marks):
    """The lines of block (complete lines, no newline) holding any of marks, in file order. Found with
    bytes.find, so lines without a mark are never split out or decoded."""
    spans = set()
    for m in marks:
        i = block.find(m)
        while i != -1:
            s = block.rfind(b"\n", 0, i) + 1
            e = block.find(b"\n", i)
            if e == -1:
                e = len(block)
            spans.add((s, e))
            i = block.find(m, e)
    return [block[s:e] for s, e in sorted(spans)]


def count(v):
    """A token count: a non-negative int, else 0 (bools, floats, strings and negatives count as nothing)."""
    return v if type(v) is int and v > 0 else 0


def parse_line(line):
    try:
        d = json.loads(line)
    except (ValueError, RecursionError):
        return None
    return d if isinstance(d, dict) else None


class UsageLedger:
    """The usage store in memory. Events are upserted by identity; logs remember how far each file was read;
    events older than FREEZE_AFTER are frozen into aggregate rows and key digests (see above)."""

    def __init__(self, data=None):
        data = data if isinstance(data, dict) and data.get("v") in (STORE_V, *STORE_MIGRATE) else {}
        try:
            self.salt = bytes.fromhex(data.get("salt") or "")
        except (TypeError, ValueError):
            self.salt = b""
        if len(self.salt) != 16:
            self.salt, data = os.urandom(16), {}
        self.sessions = [s for s in data.get("sessions") or [] if isinstance(s, str)]
        self.models = [m for m in data.get("models") or [] if isinstance(m, str)]
        self.session_slot = {s: i for i, s in enumerate(self.sessions)}
        self.model_slot = {m: i for i, m in enumerate(self.models)}
        self.events = {a: {} for a in COLLECTED}
        for a in COLLECTED:
            for k, rec in obj(obj(data.get("events")).get(a)).items():
                if self.valid_event(rec) and KEY_RE.match(k):
                    self.events[a][k] = rec
        self.frozen, dropped = {}, False
        for a in COLLECTED:
            part = self.load_frozen(obj(obj(data.get("frozen")).get(a)))
            dropped |= part is None
            self.frozen[a] = part or {"rows": {}, "sessions": set(), "keys": b""}
        self.digests = dict.fromkeys(COLLECTED)  # adapter -> set of frozen digests, built on first need
        self.logs = {k: v for k, v in obj(data.get("logs")).items()
                     if isinstance(v, list) and len(v) == 7 and v[0] in COLLECTED
                     and all(type(x) is int for x in v[1:6]) and isinstance(v[6], dict)}
        # new, an older version to write back in this one, or a malformed frozen part to write back without
        self.dirty = dropped or data.get("v") != STORE_V
        self.failed = 0  # logs that could not be opened or read this run (retried next run)
        self.refused = 0  # logs the deny guard refuses (skipped every run, not counted as incomplete)
        self.memo = {}  # (kind, raw id) -> key, for ids repeated on many lines

    def valid_event(self, rec):
        return (isinstance(rec, list) and len(rec) == 7 and all(type(x) is int for x in rec)
                and -1 <= rec[1] < len(self.sessions) and 0 <= rec[2] < len(self.models))

    def load_frozen(self, f):
        """One adapter's frozen part: {"rows": {(q, model): [in, out, cr, cw]}, "sessions": {slot}, "keys":
        packed little-endian 64-bit digests}, an empty one when there is none, or None when it is malformed.
        Rows and digests stand or fall together: a malformed part is dropped whole (old history is lost rather
        than counted twice on a re-read)."""
        if not f:
            return {"rows": {}, "sessions": set(), "keys": b""}
        try:
            keys = base64.b64decode(f.get("keys") or "", validate=True)
        except (TypeError, ValueError):
            return None
        rows_in, sessions_in = f.get("rows"), f.get("sessions")
        if len(keys) % 8 or not isinstance(rows_in, list) or not isinstance(sessions_in, list):
            return None
        rows, n_models = {}, len(self.models)
        for r in rows_in:
            if not (isinstance(r, list) and len(r) == 6 and all(type(x) is int for x in r)
                    and 0 <= r[1] < n_models and min(r[2:]) >= 0 and (r[0], r[1]) not in rows):
                return None
            rows[(r[0], r[1])] = r[2:]
        sessions, n_sessions = set(), len(self.sessions)
        for s in sessions_in:
            if type(s) is not int or not 0 <= s < n_sessions:
                return None
            sessions.add(s)
        return {"rows": rows, "sessions": sessions, "keys": keys}

    @classmethod
    def load(cls, path):
        return cls(load_own(path))

    def to_json(self):
        frozen = {a: {"rows": [[q, m, *c] for (q, m), c in sorted(f["rows"].items())],
                      "sessions": sorted(f["sessions"]), "keys": base64.b64encode(f["keys"]).decode("ascii")}
                  for a, f in self.frozen.items()}
        return {"v": STORE_V, "salt": self.salt.hex(), "sessions": self.sessions, "models": self.models,
                "logs": self.logs, "events": self.events, "frozen": frozen}

    # ----- freezing -----

    @staticmethod
    def digest(k):
        """The part of an event key a frozen event keeps: its first 8 bytes, as an int."""
        return int(k[:16], 16)

    def is_frozen(self, adapter, k):
        ds = self.digests[adapter]
        if ds is None:
            keys = self.frozen[adapter]["keys"]
            if not keys:
                return False
            ds = self.digests[adapter] = set(struct.unpack(f"<{len(keys) // 8}Q", keys))
        return self.digest(k) in ds

    def freeze(self, cutoff):
        """Move every event timed before cutoff into its adapter's frozen part. Returns how many moved; the
        aggregates summary() prints are the same before and after."""
        moved = 0
        for a in COLLECTED:
            events, f = self.events[a], self.frozen[a]
            old = [k for k, rec in events.items() if rec[0] < cutoff]
            if not old:
                continue
            rows, sessions, ds, digests = f["rows"], f["sessions"], self.digests[a], []
            for k in old:
                t, s, m, *c = events.pop(k)
                row = rows.get((t // 900, m))
                if row is None:
                    rows[(t // 900, m)] = c
                else:
                    for i in range(4):
                        row[i] += c[i]
                if s >= 0:
                    sessions.add(s)
                digests.append(self.digest(k))
            if ds is not None:
                ds.update(digests)
            f["keys"] += struct.pack(f"<{len(digests)}Q", *digests)
            moved += len(old)
        self.dirty |= bool(moved)
        return moved

    def key(self, *parts):
        h = hashlib.blake2b(digest_size=12, key=self.salt)
        for p in parts:
            h.update(p if isinstance(p, bytes) else str(p).encode("utf-8", "surrogatepass"))
            h.update(b"\x1f")
        return h.hexdigest()

    def id_key(self, kind, raw):
        k = self.memo.get((kind, raw))
        if k is None:
            k = self.memo[(kind, raw)] = self.key(kind, raw)
        return k

    def slot(self, table, index, value):
        i = index.get(value)
        if i is None:
            i = index[value] = len(table)
            table.append(value)
        return i

    # ----- reading -----

    def sync(self, found, until):
        """Read every changed log until the clock passes `until`. True when every log the deny guard allows was
        read to its last complete line (no budget cut, no failed log); refused logs are skipped and counted."""
        present, todo = set(), []
        for adapter in COLLECTED:
            for path, root, st in found.get(adapter, ()):
                pk = self.key("log", path)
                present.add(pk)
                old = self.logs.get(pk)
                if old and old[0] == adapter and old[1:5] == [st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns]:
                    continue
                todo.append((st.st_mtime_ns, adapter, path, root, st, pk))
        gone = [k for k in self.logs if k not in present]
        for k in gone:  # the file is gone or moved; its events stay in the ledger
            del self.logs[k]
        self.dirty |= bool(gone)
        todo.sort(key=lambda x: x[0], reverse=True)  # newest first, so a cut run still has today right
        for _, adapter, path, root, st, pk in todo:
            if CLOCK() >= until:
                return False
            status = self.read_log(adapter, path, root, st, pk, until)
            if status == "cut":
                return False
            if status == "failed":
                self.failed += 1
            elif status == "refused":
                self.refused += 1
        return not self.failed

    def read_log(self, adapter, path, root, st, pk, until):
        """Read one log's new complete lines. Returns "done", "cut" (budget; progress kept), "refused" (the
        deny guard) or "failed" (unopenable, or an OSError mid-read: nothing from this read is kept and the old
        offset and reading state stay, so the next run reads the same lines again)."""
        old = self.logs.get(pk)
        if old and old[0] == adapter and old[1] == st.st_dev and old[2] == st.st_ino and st.st_size >= old[5]:
            start, state = old[5], dict(old[6]) if isinstance(old[6], dict) else {}
        else:  # new, replaced or shrunk: read it all again (keys are identities, so nothing doubles)
            start, state = 0, {}
        if confined(root, forbidden, path):  # the deny guard's call (e.g. a name with "apikey"): never read
            return "refused"
        f = open_log(path, root)
        if f is None:
            return "failed"
        staged = {}
        on_line = self.claude_line if adapter == "claude" else self.codex_line
        marks = LINE_MARKS[adapter]
        ctx = {"pk": pk, "mtime": int(st.st_mtime)}
        # "z" in the state: the last run stopped inside an overlong line, so skip to its end first
        pos, pending, skipping, status = start, b"", bool(state.pop("z", False)), "done"
        with f:
            try:
                f.seek(start)
                while True:
                    if CLOCK() >= until:
                        status = "cut"
                        break
                    chunk = f.read(READ_CHUNK)
                    if not chunk:
                        break
                    block = pending + chunk if pending else chunk
                    end = block.rfind(b"\n") + 1
                    if not end:
                        pending = block
                        if len(pending) > MAX_LINE:  # one overlong line: drop it up to its newline
                            pos += len(pending)
                            pending, skipping = b"", True
                        continue
                    lines = block[:end]
                    if skipping:
                        first = lines.find(b"\n") + 1
                        pos += first
                        lines, skipping = lines[first:], False
                    for line in marked_lines(lines, marks):
                        on_line(line, state, staged, ctx)
                    pos += len(lines)
                    pending = block[end:]
            except OSError:
                return "failed"
        if skipping:
            state["z"] = 1
        changed = False
        for (adapter_, k), (rec, sess, model) in staged.items():
            changed |= self.put(adapter_, k, rec, sess, model)
        # A cut log records size -1, so sync never takes it for unchanged; the next run resumes it at pos.
        size = st.st_size if status == "done" else -1
        new = [adapter, st.st_dev, st.st_ino, size, st.st_mtime_ns, pos, state]
        self.logs[pk] = new
        # Only a new size or mtime, or a few lines with no usage in them, is not worth rewriting the store: a run
        # that finds the old entry reads the same bytes again from its offset and lands on the same events.
        same = (not changed and old is not None and old[:3] == new[:3] and old[6] == state
                and 0 <= pos - old[5] <= SAVE_LAG)
        self.dirty |= not same
        return status

    @staticmethod
    def stage(staged, adapter, k, t, sess, model, counts):
        """Keep the bigger copy of an event among this read's lines (streaming snapshots grow), timed at the
        earliest copy."""
        prev = staged.get((adapter, k))
        if prev is None:
            staged[(adapter, k)] = ([t, 0, 0, *counts], sess, model)
            return
        t = min(t, prev[0][0])
        if sum(counts) > sum(prev[0][3:]):
            staged[(adapter, k)] = ([t, 0, 0, *counts], sess, model)
        else:
            prev[0][0] = t

    def put(self, adapter, k, rec, sess, model):
        """Upsert one event into the ledger: the copy with more tokens wins (a tie keeps what is there) and the
        event is timed at its earliest copy, so the result doesn't depend on the order logs are read in. A
        frozen event is final and is skipped. True when the ledger changed."""
        prev = self.events[adapter].get(k)
        if prev is None:
            if self.is_frozen(adapter, k):
                return False
        else:
            rec[0] = min(rec[0], prev[0])
            if sum(rec[3:]) <= sum(prev[3:]):
                if rec[0] == prev[0]:
                    return False
                prev[0] = rec[0]
                return True
        rec[1] = self.slot(self.sessions, self.session_slot, sess) if sess else -1
        rec[2] = self.slot(self.models, self.model_slot, model)
        self.events[adapter][k] = rec
        return True

    def claude_line(self, line, state, staged, ctx):
        d = parse_line(line)
        if not d or d.get("type") != "assistant":
            return
        msg = obj(d.get("message"))
        u = msg.get("usage")
        if not isinstance(u, dict):
            return
        counts = (count(u.get("input_tokens")), count(u.get("output_tokens")),
                  count(u.get("cache_read_input_tokens")), count(u.get("cache_creation_input_tokens")))
        if not any(counts):
            return
        mid = msg.get("id")
        k = self.key("claude-message", mid) if isinstance(mid, str) and mid else self.key("claude-line", line)
        sid = d.get("sessionId")
        sess = self.id_key("claude-session", sid) if isinstance(sid, str) and sid else None
        t = int(epoch(d.get("timestamp"))) or ctx["mtime"]
        self.stage(staged, "claude", k, t, sess, model_id(msg.get("model")) or UNKNOWN_MODEL, counts)

    def codex_line(self, line, state, staged, ctx):
        """Codex reports running totals per session; an event's tokens are the step from the previous total.
        A repeated total is skipped. When there is no previous total in this reading (a file read from its
        start) or a total went down (a reset: the reset count goes up), the step is the event's own
        last_token_usage when it fits inside the total, else the whole total."""
        d = parse_line(line)
        if not d:
            return
        p = obj(d.get("payload"))
        kind = d.get("type")
        if kind == "session_meta":
            sid = p.get("id")
            if isinstance(sid, str) and sid:
                state["s"] = self.key("codex-session", sid)
            return
        if kind == "turn_context":
            m = model_id(p.get("model"))
            if m:
                state["m"] = m
            return
        if p.get("type") != "token_count" or not isinstance(p.get("info"), dict):
            return
        info = p["info"]
        tu = info.get("total_token_usage")
        if not isinstance(tu, dict):
            return
        fields = ("input_tokens", "cached_input_tokens", "output_tokens")
        now = [count(tu.get(f)) for f in fields]
        prev = state.get("t")
        if isinstance(prev, list) and now == prev:
            return
        if isinstance(prev, list) and len(prev) == 3 and all(a >= b for a, b in zip(now, prev)):
            step = [a - b for a, b in zip(now, prev)]
        else:
            if isinstance(prev, list):
                state["r"] = int(state.get("r") or 0) + 1
            lu = info.get("last_token_usage")
            last = [count(obj(lu).get(f)) for f in fields]
            step = last if isinstance(lu, dict) and any(last) and all(a <= b for a, b in zip(last, now)) else now
        state["t"] = now
        fresh, cached, out = step
        counts = (max(0, fresh - cached), out, cached, 0)
        if not any(counts):
            return
        sess = state.get("s") or ctx["pk"]
        k = self.key("codex-step", sess, int(state.get("r") or 0), *now)
        t = int(epoch(d.get("timestamp"))) or ctx["mtime"]
        self.stage(staged, "codex", k, t, sess, state.get("m") or UNKNOWN_MODEL, counts)

    # ----- aggregates -----

    def summary(self, adapter, has_logs, now=None):
        """The aggregates printed for one adapter, or None when it has neither transcripts nor events (live or
        frozen). Frozen rows count exactly like their events did: each is timed at its quarter hour."""
        events, frozen = self.events[adapter], self.frozen[adapter]
        if not events and not frozen["rows"] and not has_logs:
            return None
        from datetime import date, timedelta
        now = time.time() if now is None else now
        lt = time.localtime(now)
        today = date(lt.tm_year, lt.tm_mon, lt.tm_mday)
        window = [(today - timedelta(days=HEAT_DAYS - 1 - i)).isoformat() for i in range(HEAT_DAYS)]
        day_of, per_day, per_model, sessions = {}, {}, {}, set()
        sums = [0, 0, 0, 0]
        for t, s, m, *c in events.values():
            q = t // 900  # local days start on a quarter hour in every time zone
            day = day_of.get(q)
            if day is None:
                day = day_of[q] = time.strftime("%Y-%m-%d", time.localtime(t))
            n = c[0] + c[1] + c[2] + c[3]
            per_day[day] = per_day.get(day, 0) + n
            per_model[m] = per_model.get(m, 0) + n
            if s >= 0:
                sessions.add(s)
            for i in range(4):
                sums[i] += c[i]
        for (q, m), c in frozen["rows"].items():
            day = day_of.get(q)
            if day is None:
                day = day_of[q] = time.strftime("%Y-%m-%d", time.localtime(q * 900))
            n = c[0] + c[1] + c[2] + c[3]
            per_day[day] = per_day.get(day, 0) + n
            per_model[m] = per_model.get(m, 0) + n
            for i in range(4):
                sums[i] += c[i]
        sessions |= frozen["sessions"]
        busiest = max(per_day.items(), key=lambda kv: (kv[1], -int(kv[0].replace("-", ""))), default=None)
        top = sorted(((self.models[m], n) for m, n in per_model.items()), key=lambda x: (-x[1], x[0]))[:5]
        inp, out, cr, cw = sums
        return {
            "adapter": adapter,
            "total": inp + out + cr + cw,
            "sessions": len(sessions),
            "today": per_day.get(window[-1], 0),
            "peak": {"day": busiest[0], "tokens": busiest[1]} if busiest and busiest[1] > 0 else None,
            "cacheHit": round(cr / (cr + inp), 4) if cr + inp else None,
            "input": inp,
            "output": out,
            "cacheRead": cr,
            "cacheWrite": cw,
            "models": [{"model": name, "tokens": n} for name, n in top],
            "days": [per_day.get(d, 0) for d in window],
            "lastDay": window[-1],
            "activeDays": sum(1 for n in per_day.values() if n > 0),
        }


def store_id(path):
    """What identifies one write of the store (inode, size, mtime), or None when there is none."""
    try:
        st = os.lstat(path)
    except OSError:
        return None
    return [st.st_ino, st.st_size, st.st_mtime_ns]


def logs_stamp(adapter, logs, store, now=None):
    """A digest of what one adapter's aggregates depend on: its transcripts' paths, sizes and mtimes, the
    store's identity, the local date and the UTC offset (at `now`, when the aggregates were built). Per
    adapter, so a Claude write leaves the Codex entry valid and a Codex check never walks Claude's folders.
    Only the digest is written."""
    lt = time.localtime(now)
    h = hashlib.sha256(f"{STORE_V}|{adapter}|{time.strftime('%Y-%m-%d', lt)}|{lt.tm_gmtoff}|{store}".encode())
    for path, _, st in sorted(logs, key=lambda x: x[0]):
        h.update(f"{path}\0{st.st_size}\0{st.st_mtime_ns}\n".encode("utf-8", "surrogatepass"))
    return h.hexdigest()


def cmd_tokens(adapter):
    if adapter not in TOKENS_ADAPTERS:
        return {"error": "bad adapter"}
    if adapter not in COLLECTED:
        return {"adapter": adapter, "absent": True}
    store_path, view_path = own_file(STORE_NAME), own_file(VIEW_NAME)
    found, whole = {}, True
    found[adapter], whole = find_logs(adapter)
    view = load_own(view_path)
    entry = obj(obj(view).get("by")).get(adapter) if obj(view).get("v") == STORE_V else None
    if whole and isinstance(entry, dict) and entry.get("stamp") == logs_stamp(adapter, found[adapter], store_id(store_path)):
        hit = entry.get("data")
        return dict(hit, cached=True) if isinstance(hit, dict) else {"adapter": adapter, "absent": True}
    for a in COLLECTED:
        if a != adapter:
            found[a], ok = find_logs(a)
            whole = whole and ok
    if not any(found.values()) and not os.path.lexists(store_path):
        return {"adapter": adapter, "absent": True}
    ledger = UsageLedger.load(store_path)
    until = CLOCK() + SCAN_BUDGET
    if HARD_STOP is not None:
        until = min(until, HARD_STOP - SCAN_MARGIN)
    now = time.time()
    complete = ledger.sync(found, until) and whole
    if complete:  # never after a cut or failed run: an unread file may still hold a bigger copy
        ledger.freeze(int(now - FREEZE_AFTER) // 86400 * 86400)
    if ledger.dirty:
        save_own(store_path, ledger.to_json())
    by = {a: ledger.summary(a, bool(found[a]), now) for a in COLLECTED}
    if complete:
        sid = store_id(store_path)
        save_own(view_path, {"v": STORE_V, "by": {a: {"stamp": logs_stamp(a, found[a], sid, now), "data": by[a]}
                                                  for a in COLLECTED}})
    out = by[adapter]
    if out is None:
        return {"adapter": adapter, "absent": True}
    if not complete:
        out = dict(out, incomplete=True)  # not cached: the next run continues where this one stopped
    return out


# ---------- sessions: context and estimated cost ----------

def model_window(model, used):
    return 1_000_000 if "[1m]" in str(model or "").lower() or used > 200_000 else 200_000


def usage_tokens(usage):
    if not isinstance(usage, dict):
        return 0
    its = usage.get("iterations")
    if isinstance(its, list) and its and isinstance(its[-1], dict):
        usage = its[-1]
    return sum(int(usage.get(k) or 0) for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))


def context_from_lines(lines):
    for line in reversed(lines):
        if '"compact_boundary"' in line:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            post = obj(d.get("compactMetadata")).get("postTokens") or d.get("postTokens")
            if post:
                return {"used": int(post), "model": None}
            continue
        if '"assistant"' not in line or '"usage"' not in line:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if not isinstance(d, dict) or d.get("type") != "assistant" or d.get("isSidechain"):
            continue
        msg = obj(d.get("message"))
        n = usage_tokens(msg.get("usage"))
        if n > 0:
            return {"used": n, "model": msg.get("model")}
    return None


def price_for(model, prices):
    m = str(model or "").lower()
    hits = [k for k in (prices or {}) if k.lower() in m]
    return prices[max(hits, key=len)] if hits else None


def epoch(ts):
    try:
        from datetime import datetime
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return 0


def usage_records(lines):
    out = {}
    for line in lines:
        if '"usage"' not in line or '"assistant"' not in line:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if not isinstance(d, dict) or d.get("type") != "assistant":
            continue
        msg = obj(d.get("message"))
        u = msg.get("usage")
        if not isinstance(u, dict):
            continue
        key = f"{msg.get('id') or ''}|{d.get('requestId') or ''}"
        if key == "|":
            key = d.get("uuid") or str(len(out))
        model = msg.get("model")
        out[key] = ["<synthetic>" if model == "<synthetic>" else (model_id(model) or ""), int(u.get("input_tokens") or 0), int(u.get("output_tokens") or 0),
                    int(u.get("cache_creation_input_tokens") or 0), int(u.get("cache_read_input_tokens") or 0), epoch(d.get("timestamp"))]
    return out


def codex_records(lines, st):
    """Token deltas from Codex rollout token_count events; model from the latest turn_context."""
    out = {}
    for line in lines:
        if '"turn_context"' not in line and '"token_count"' not in line:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if not isinstance(d, dict):
            continue
        p = obj(d.get("payload"))
        if d.get("type") == "turn_context" and isinstance(p.get("model"), str):
            if MODEL_RE.match(p["model"]):
                st["model"] = p["model"]
            continue
        if p.get("type") != "token_count" or not isinstance(p.get("info"), dict):
            continue
        info = p["info"]
        last = obj(info.get("last_token_usage"))
        if info.get("model_context_window"):
            st["ctx"] = [int(last.get("input_tokens") or 0) + int(last.get("output_tokens") or 0), int(info.get("model_context_window") or 0)]
        tu = info.get("total_token_usage")
        if not isinstance(tu, dict):
            continue
        total = [int(tu.get("input_tokens") or 0), int(tu.get("cached_input_tokens") or 0), int(tu.get("output_tokens") or 0)]
        prev = st.get("total") or [0, 0, 0]
        delta = [a - b for a, b in zip(total, prev)]
        if any(x < 0 for x in delta):
            delta = total
        st["total"] = total
        if not any(delta):
            continue
        inp, cached, outp = delta
        out[f"{sum(total)}:{total[2]}"] = [st.get("model") or "codex-unknown", max(0, inp - cached), outp, 0, cached, epoch(d.get("timestamp"))]
    return out


def cost_of(records, prices, write_mult=1.25, read_mult=0.1):
    total, tokens, unpriced, models = 0.0, 0, 0, {}
    for model, inp, outp, cw, cr, *_ in records:
        n = inp + outp + cw + cr
        tokens += n
        if model == "<synthetic>":
            continue
        row = models.setdefault(model or "unknown", {"tokens": 0, "cost": 0.0})
        row["tokens"] += n
        p = price_for(model, prices)
        if not p:
            unpriced += 1
            row["cost"] = None
            continue
        pi, po = float(p[0]), float(p[1])
        c = (inp * pi + outp * po + cw * pi * write_mult + cr * pi * read_mult) / 1_000_000
        total += c
        if row["cost"] is not None:
            row["cost"] += c
    for row in models.values():
        if row["cost"] is not None:
            row["cost"] = round(row["cost"], 4)
    return {"tokens": tokens, "cost": None if unpriced else round(total, 4), "unpriced": unpriced, "models": models}


def alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError, OverflowError):
        return False


def transcript_for(root, session_id):
    if not isinstance(session_id, str) or not re.match(r"^[A-Za-z0-9-]+$", session_id):
        return None
    hits = glob.glob(os.path.join(G(root), "projects", "*", G(session_id) + ".jsonl"))
    return max(hits, key=os.path.getmtime) if hits else None


def find_session(root, cwd, pid=None):
    """(path, how) of the Claude-family session for a folder, inside this agent's own root only."""
    cwd = os.path.normpath(cwd) if cwd else ""
    if pid and str(pid).isdigit():
        info = obj(read_json(os.path.join(root, "sessions", f"{int(pid)}.json")))
        path = transcript_for(root, info.get("sessionId"))
        if path:
            return path, "pid"
    live = []
    for f in glob.glob(os.path.join(G(root), "sessions", "*.json")):
        info = read_json(f)
        if not isinstance(info, dict) or not cwd:
            continue
        if os.path.normpath(str(info.get("cwd") or "")) != cwd or not alive(info.get("pid")):
            continue
        path = transcript_for(root, info.get("sessionId"))
        if path:
            live.append((info.get("updatedAt") or 0, os.path.getmtime(path), path))
    if live:
        live.sort(key=lambda x: (x[0] if isinstance(x[0], (int, float)) else 0, x[1]))
        return live[-1][2], "cwd-live" if len(live) == 1 else "cwd-live-ambiguous"
    if cwd:
        for d in {encode_cwd(cwd), cwd.replace("/", "-").replace(".", "-")}:
            files = glob.glob(os.path.join(G(root), "projects", G(d), "*.jsonl"))
            if files:
                return max(files, key=os.path.getmtime), "cwd-newest-file"
    return None, None


def tail_lines(path, nbytes):
    f = open_regular(path)
    if f is None:
        return []
    with f:
        try:
            size = os.fstat(f.fileno()).st_size
            if size > nbytes:
                f.seek(size - nbytes)
            data = f.read(min(size, nbytes))
        except OSError:
            return []
    lines = data.decode("utf-8", errors="replace").splitlines()
    return lines[1:] if size > nbytes else lines


def scan_lines(path, start, size, on_lines, marks=None):
    f = open_regular(path)
    if f is None:
        return None
    pos, carry = start, b""
    with f:
        try:
            f.seek(start)
            while pos < size:
                chunk = f.read(min(CHUNK, size - pos))
                if not chunk:
                    break
                pos += len(chunk)
                buf = carry + chunk
                end = buf.rfind(b"\n") + 1
                if end:
                    raw = buf[:end].split(b"\n")
                    if marks:
                        raw = [l for l in raw if any(m in l for m in marks)]
                    on_lines([l.decode("utf-8", errors="replace") for l in raw if l])
                carry = buf[end:]
                if len(carry) > MAX_LINE:
                    carry = b""
        except OSError:
            return None
    return pos - len(carry)


CLAUDE_MARKS = (b'"usage"',)
CODEX_MARKS = (b'"turn_context"', b'"token_count"')


def cache_path(aid):
    return os.path.join(HERE, f".cost-cache-{aid}.json")


def ck(path):
    """Cache key: a hash, so the cache file holds no transcript paths or project names."""
    return hashlib.sha256(str(path).encode("utf-8", "surrogatepass")).hexdigest()[:32]


def load_cache(aid):
    if OVERRIDDEN:
        return {"v": 2, "files": {}}
    c = read_json(cache_path(aid))
    return c if isinstance(c, dict) and c.get("v") == 2 and isinstance(c.get("files"), dict) else {"v": 2, "files": {}}


def save_cache(aid, cache):
    if OVERRIDDEN:
        return
    target = cache_path(aid)
    tmp = f"{target}.{os.getpid()}.tmp"
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            os.fchmod(f.fileno(), 0o600)
            json.dump(cache, f, separators=(",", ":"))
        os.replace(tmp, target)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass


def records_for(path, cache, kind="claude"):
    try:
        st = os.stat(path)
    except OSError:
        return {}
    entry = cache["files"].get(ck(path))
    if entry and entry.get("mtime") == st.st_mtime and entry.get("size") == st.st_size:
        return entry.get("records") or {}
    start, records, state = 0, {}, {}
    if entry and st.st_size > entry.get("offset", 0) and entry.get("size", 0) <= st.st_size:
        start, records, state = entry.get("offset", 0), dict(entry.get("records") or {}), dict(entry.get("state") or {})

    def on_lines(lines):
        records.update(codex_records(lines, state) if kind == "codex" else usage_records(lines))

    offset = scan_lines(path, start, st.st_size, on_lines, CODEX_MARKS if kind == "codex" else CLAUDE_MARKS)
    if offset is None:
        return {}
    cache["files"][ck(path)] = {"mtime": st.st_mtime, "size": st.st_size, "offset": offset, "records": records, "state": state}
    return records


def local_midnight(now=None):
    lt = time.localtime(now or time.time())
    return time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))


def files_since(patterns, since):
    out = []
    for pat in patterns:
        for f in glob.glob(pat):
            try:
                if os.path.getmtime(f) >= since and not forbidden(f):
                    out.append(f)
            except OSError:
                pass
    return out


def session_claude(aid, root, cwd, pid, prices, wm, rm):
    out = {"kind": "claude"}
    path, how = find_session(root, cwd, pid)
    if path:
        ctx, size = None, size_of(path)
        for n in TAIL_STEPS:
            ctx = context_from_lines(tail_lines(path, n))
            if ctx or n >= size:
                break
        out.update({"session": os.path.basename(path)[:-6], "how": how})
        if ctx:
            model = model_id(ctx["model"])
            out["context"] = {"used": ctx["used"], "model": model, "window": model_window(model, ctx["used"])}
    cache = load_cache(aid)
    midnight = local_midnight()
    base = os.path.join(G(root), "projects", "*")
    files = files_since([os.path.join(base, "*.jsonl"), os.path.join(base, "*", "subagents", "*.jsonl")], midnight)
    merged = {}
    for f in files:
        merged.update(records_for(f, cache))
    sess_files = []
    if path:
        sess_files = [path] + glob.glob(os.path.join(G(path[:-6]), "subagents", "*.jsonl"))
        recs = {}
        for f in sess_files:
            recs.update(records_for(f, cache))
        out["sessionCost"] = cost_of(recs.values(), prices, wm, rm)
    keep = {ck(f) for f in set(files) | set(sess_files)}
    cache["files"] = {k: v for k, v in cache["files"].items() if k in keep}
    save_cache(aid, cache)
    today = [r for r in merged.values() if len(r) > 5 and r[5] >= midnight]
    out["today"] = cost_of(today, prices, wm, rm)
    out["files"] = len(files)
    return out


def codex_meta_cwd(path):
    """The cwd of a rollout from its first line (session_meta); nothing else of that line is used."""
    f = open_regular(path)
    if f is None:
        return None
    with f:
        try:
            line = f.readline(1024 * 1024)
        except OSError:
            return None
    try:
        d = json.loads(line.decode("utf-8", errors="replace"))
    except ValueError:
        return None
    cwd = obj(obj(d).get("payload")).get("cwd")
    return os.path.normpath(cwd) if isinstance(cwd, str) else None


def session_codex(root, cwd, prices, wm, rm):
    out = {"kind": "codex"}
    cache = load_cache("codex")
    midnight = local_midnight()
    files = files_since([os.path.join(G(root), "sessions", "*", "*", "*", "*.jsonl")], midnight)
    recs = {}
    for f in files:
        recs.update(records_for(f, cache, "codex"))
    want = os.path.normpath(cwd) if cwd else ""
    newest = sorted(files, key=lambda f: os.path.getmtime(f), reverse=True)
    hit = next((f for f in newest if want and codex_meta_cwd(f) == want), None)
    if hit:
        st = obj(cache["files"].get(ck(hit))).get("state") or {}
        ctx = st.get("ctx")
        out["session"] = os.path.basename(hit)[:-6]
        out["how"] = "newest rollout for this folder today"
        if isinstance(ctx, list) and len(ctx) == 2 and ctx[1]:
            model = model_id(st.get("model"))
            out["context"] = {"used": ctx[0], "model": model, "window": ctx[1]}
        out["sessionCost"] = cost_of(obj(cache["files"].get(ck(hit))).get("records", {}).values(), prices, wm, rm)
    cache["files"] = {k: v for k, v in cache["files"].items() if k in {ck(f) for f in files}}
    save_cache("codex", cache)
    today = [r for r in recs.values() if r[5] >= midnight]
    out["today"] = cost_of(today, prices, wm, rm)
    out["files"] = len(files)
    return out


def cmd_session(aid, cwd, pid, cfg):
    prices = obj(cfg.get("models"))
    try:
        wm, rm = float(cfg.get("cacheWrite", 1.25)), float(cfg.get("cacheRead", 0.1))
    except (TypeError, ValueError):
        wm, rm = 1.25, 0.1
    out = {"host": socket.gethostname().split(".")[0], "agent": aid}
    PARTIAL.update(out)
    if aid == "claude" and isdir(hp(".claude")):
        out.update(session_claude("claude", hp(".claude"), cwd, pid, prices, wm, rm))
    elif aid.startswith("mirror-") and aid[7:] in mirror_ids():
        out.update(session_claude(aid, hp(".cc-mirror", aid[7:], "config"), cwd, pid, prices, wm, rm))
    elif aid == "codex" and isdir(hp(".codex", "sessions")):
        out.update(session_codex(hp(".codex"), cwd, prices, wm, rm))
    else:
        out["unsupported"] = True
    return out


# ---------- output sanitising ----------

# controls, soft hyphen, Arabic letter mark, zero-width and bidi marks, line/paragraph separators,
# bidi embeddings and isolates, invisible operators, BOM, and Unicode tag characters
BAD_CHARS = re.compile("[\x00-\x1f\x7f-\x9f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff\U000e0000-\U000e007f]")


def clean_str(s):
    s = BAD_CHARS.sub(" ", s)
    for h in sorted(_homes(), key=len, reverse=True):
        if h and h != "/":
            s = s.replace(h, "~")
    s = s.strip()
    return s if len(s) <= MAX_STR else s[: MAX_STR - 1] + "…"


def sanitize(v):
    if isinstance(v, dict):
        return {clean_str(str(k)): sanitize(x) for k, x in v.items()}
    if isinstance(v, list):
        return [sanitize(x) for x in v]
    if isinstance(v, Text):
        return v
    if isinstance(v, str):
        return clean_str(v)
    return v


# ---------- entry ----------

def args_of(argv):
    out = {"folder": []}
    i = 0
    while i < len(argv):
        k = argv[i]
        if k.startswith("--") and i + 1 < len(argv):
            name = k[2:]
            if name == "folder":
                out["folder"].append(argv[i + 1])
            else:
                out[name] = argv[i + 1]
            i += 2
        else:
            i += 1
    return out


def main(argv):
    if not argv:
        return {"error": "no command"}
    cmd, a = argv[0], args_of(argv[1:])
    home = a.get("home") or os.environ.get("DROVER_AGENTS_HOME")
    if home:
        set_home(home)
    if cmd == "list":
        return cmd_list(a["folder"])
    if cmd == "session":
        aid = a.get("agent") or ""
        if not ID_RE.match(aid):
            return {"error": "bad agent"}
        try:
            cfg = obj(json.loads(a.get("prices") or "{}"))
        except ValueError:
            cfg = {}
        return cmd_session(aid, a.get("cwd", ""), a.get("pid"), cfg)
    if cmd == "read":
        pos = argv[1:4]
        if len(pos) < 3 or not ID_RE.match(pos[0]) or not re.match(r"^(global|project)\.[a-z]+$", pos[1]) or not pos[2].isdigit():
            return {"error": "bad arguments"}
        which, kind = pos[1].split(".", 1)
        return cmd_read(pos[0], which, kind, int(pos[2]), a.get("name"), a["folder"])
    if cmd == "tokens":
        adapter = argv[1] if len(argv) > 1 else ""
        return cmd_tokens(adapter)
    return {"error": "unknown command"}


class Deadline(BaseException):
    """Raised by the alarm; a BaseException so collectors' `except Exception` can't swallow it."""


def _on_alarm(signum, frame):
    raise Deadline()


if __name__ == "__main__":
    HARD_STOP = time.monotonic() + DEADLINE
    signal.signal(signal.SIGALRM, _on_alarm)
    signal.alarm(DEADLINE)
    try:
        result = main(sys.argv[1:])
    except Deadline:
        result = dict(PARTIAL, timeout=True)
    except Exception:
        result = {"error": "probe failed"}
    signal.alarm(0)
    sys.stdout.write(json.dumps(sanitize(result)))
