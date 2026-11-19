# drover-ports

A "Ports" page that lists every TCP port listening on this computer, with the program behind it
(its name only, never its arguments), its folder and the Herdr space it runs in.

Each port chip says what kind of port it is. A web port opens in the browser; the address
follows the bind, so a server bound only to `127.0.0.1` opens `http://127.0.0.1:<port>` and a
wildcard or dual loopback bind opens `http://localhost:<port>`. Database, debugger and other
ports (Postgres on 5432, a Node `--inspect` process, RabbitMQ on 5672 and so on) show `db`,
`debug` or `other` and don't open. Kinds come from a fixed list of ports and program names; ports
are never probed. A process started with `--inspect` counts as `debug` on all of its ports.

Ports published by Docker Desktop, OrbStack, vpnkit, docker-proxy, rootless Docker or Podman
helpers, Lima or WSL go into a Containers group, labelled Docker, Containers or WSL. They have no
Stop: stop the container in its own tool. A row whose program name is unknown (for example when
tasklist fails on Windows, or the name was hidden because it looked like a secret) has no Stop
either.

Stop asks for a second click within 4 seconds. Before it signals, it reads the port again: if the
read fails, the port is already free, another process holds it now, or the pid now belongs to a
different process (its start time moved by more than 2 seconds), nothing is sent. After the
signal it reads the port once a second for up to 10 seconds and the card says Stopped, Still
running, Started again (a watcher may have restarted it, with the new pid when it can be seen) or
Could not check. A clean stop also shows a short "Stopped." notice, since the card goes away on
the next refresh. A failed read never counts as stopped. Every lsof, ss, ps, netstat, tasklist,
pwdx, kill, taskkill and open call has a 4 second timeout.

## Requirements

macOS: works as is (`lsof`, `ps`, `kill`, `open`).

Linux: needs `ps` and `kill` (procps) and `xdg-open` (xdg-utils) to open links. Ports come from
`lsof`; when lsof isn't installed the page uses `ss -ltnp` (iproute2) and `pwdx` for folders.
With neither lsof nor ss it says "Install lsof (or iproute2 for ss) to list ports". Without root,
both tools only show your own processes, so a rootful `docker-proxy` is not listed at all. After a
stop, `ss` still counts a socket it can't name as held, so another account's restart shows as
Started again.

Windows: ports come from `netstat -ano`, names and memory from `tasklist`, and Stop runs
`taskkill /PID <pid>`. The check after a stop reads `netstat -ano` again. There is no start time,
so the pid reuse check relies on that netstat read alone. Windows doesn't give the folder, CPU,
uptime or command line this way, so every process lands in the System group (or Containers, for
Docker Desktop and `wslrelay`) with no Herdr space, and CPU sort is hidden. taskkill
without `/F` asks the program to close; console programs such as most dev servers refuse, and the
page then says it couldn't stop them. Links open with `explorer.exe`.

