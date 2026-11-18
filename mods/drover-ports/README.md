# drover-ports

A "Ports" page that lists every TCP port listening on this computer, with the process behind it,
its folder and the Herdr space it runs in. Click a port to open `http://localhost:<port>`. Stop
asks for a second click within 4 seconds and checks again that the process still listens on that
port before it stops it.

## Requirements

macOS: works as is (`lsof`, `ps`, `kill`, `open`).

Linux: needs `ps` and `kill` (procps) and `xdg-open` (xdg-utils) to open links. Ports come from
`lsof`; when lsof isn't installed the page uses `ss -ltnp` (iproute2) and `pwdx` for folders.
With neither lsof nor ss it says "Install lsof (or iproute2 for ss) to list ports". Without root,
both tools only show your own processes.

Windows: ports come from `netstat -ano`, names and memory from `tasklist`, and Stop runs
`taskkill /PID <pid>`. Windows doesn't give the folder, CPU, uptime or command line this way, so
every process lands in the System group with no Herdr space, and CPU sort is hidden. taskkill
without `/F` asks the program to close; console programs such as most dev servers refuse, and the
page then says it couldn't stop them. Links open with `explorer.exe`.

