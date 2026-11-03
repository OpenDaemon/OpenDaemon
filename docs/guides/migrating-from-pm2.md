# Migrating from PM2

Most `ecosystem.config.js` files start unchanged:

```bash
od start ecosystem.config.js --env production
od save          # what `pm2 save` does; with `od startup` the apps return after a reboot
```

The daemon starts by itself on the first command, like PM2's.

## Commands

| PM2 | OpenDaemon |
|-----|------------|
| `pm2 start app.js -n api -i 4` | `od start app.js -n api -i 4` (`-i max` too) |
| `pm2 start app.js -- --port 80` | `od start app.js -- --port 80` |
| `pm2 start "npm start" --name web` | `od start "npm start" --name web` |
| `pm2 start app.py` / `app.sh` | `od start app.py` (also `--interpreter python3`, `--interpreter none` for a binary) |
| `pm2 start ecosystem.config.js --env production --only api` | the same, with `od` |
| `pm2 list` / `jlist` / `prettylist` | `od list` / `od jlist` |
| `pm2 describe api` | `od describe api` (or `od info api`) |
| `pm2 stop\|restart\|delete api web` / `all` | the same, with `od` |
| `pm2 reload api` | `od reload api` (rolling for cluster apps, a restart otherwise, as in PM2) |
| `pm2 scale api 8` | `od scale api 8` |
| `pm2 logs api --lines 100` | `od logs api --lines 100 -f` (without `-f` it prints and exits) |
| `pm2 flush` | `od flush` |
| `pm2 reset api` | `od reset api` |
| `pm2 sendSignal SIGUSR2 api` | `od signal SIGUSR2 api` |
| `pm2 save` / `resurrect` | `od save` / `od resurrect` |
| `pm2 startup` / `unstartup` | `od startup` / `od unstartup` (systemd, launchd, OpenRC, Windows) |
| `pm2 monit` | `od monit` |
| `pm2 ping` / `pm2 kill` | `od ping` / `od kill` |
| `pm2 ecosystem` | `od ecosystem` |
| `pm2-runtime ecosystem.config.js` | `od-runtime ecosystem.config.js` |
| `pm2 deploy` | not implemented: use `od deploy` (zero-downtime restarts of what is running) with your own CI for the code |
| `pm2 install pm2-logrotate` | built in: `logRotation`, see README |

## ecosystem.config.js keys

These are translated when you start a file (keys OpenDaemon does not support are listed in a warning, not dropped silently):

| PM2 | OpenDaemon |
|-----|------------|
| `name`, `script`, `args` (string or array), `cwd`, `env`, `instances`, `interpreter` | same |
| `exec_mode: 'cluster'` | `mode: 'cluster'` (more than 1 instance without `exec_mode` also runs as a cluster) |
| `instances: 'max'`, `0` or `-1` | `instances: 'max'` |
| `node_args`, `interpreter_args` | `interpreterArgs` |
| `env_<name>` | picked with `--env <name>`, merged over `env` |
| `autorestart: false` | `autoRestart: false` |
| `max_restarts`, `restart_delay`, `min_uptime`, `kill_timeout` | `maxRestarts`, `restartDelay`, `minUptime`, `killTimeout` (numbers or `'5s'`) |
| `exp_backoff_restart_delay` | `backoffStrategy: 'exponential'` |
| `max_memory_restart: '512M'` | `maxMemory: '512M'` |
| `cron_restart` | `cronRestart` |
| `wait_ready`, `listen_timeout` | `waitReady`, `listenTimeout` (fork mode) |
| `watch`, `ignore_watch`, `watch_delay` | `watch: { paths, ignore, delay }` |
| `out_file`, `error_file`, `merge_logs`, `time` | `logFile`, `errorLogFile`, `mergeLogs`, `logTimestamp` |
| `pmx`, `vizion`, `automation`, `source_map_support`, `namespace` ... | ignored, they have no counterpart |

## Differences worth knowing

- The daemon keeps its files in `~/.opendaemon` (`$OPENDAEMON_HOME`), so `od` works from any directory. `dump.json` there is what `od save` writes.
- `od save` is explicit, as in PM2: a process you started and did not save is not restored. The daemon restores the saved list when it starts; `daemon: { resurrect: false }` turns that off.
- Cluster mode runs Node.js scripts only. Fork mode runs anything.
- `od logs` prints the last lines and exits; add `-f` to stream. Log files are JSON lines (`~/.opendaemon/logs`); `logFile` / `errorLogFile` add plain text copies.
- Every IPC request carries a per-start token; the socket and token file are `0600`. The WebUI listens on `127.0.0.1` only unless `host` is set, and a busy port disables the WebUI without stopping the daemon.
- Secrets are encrypted at rest (`od secret`) and injected with `env: { KEY: { secret: 'NAME' } }`.
- Health checks, dependencies between apps, Prometheus metrics, notifications, scheduled jobs (`cron`) and an audit log are built in rather than separate modules.
