# Migrating from PM2

| PM2 | OpenDaemon |
|-----|------------|
| `pm2 start app.js -n api -i 4` | `od start app.js -n api -i 4` |
| `pm2 start ecosystem.config.js` | `od daemon start` in the directory with `opendaemon.config.*` |
| `pm2 list` / `ls` | `od list` |
| `pm2 describe api` | `od info api` |
| `pm2 stop|restart|delete api` | `od stop|restart|delete api` |
| `pm2 scale api 8` | `od scale api 8` |
| `pm2 logs api --lines 100` | `od logs api --lines 100` (also `-f`, `--grep`, `--since`) |
| `pm2 flush` | `od flush` |
| `pm2 monit` | `od monit` |
| `pm2 startup` / `unstartup` | `od startup` / `od unstartup` |
| `pm2 reload` | `od restart` (zero-downtime reload is not implemented) |
| `pm2 deploy` | not implemented |

## Config mapping

| ecosystem.config.js | opendaemon.config |
|---------------------|-------------------|
| `apps: [...]` | `apps: [...]` |
| `name`, `script`, `args`, `cwd`, `env` | same |
| `instances`, `exec_mode: 'cluster'` | `instances`, `mode: 'cluster'` |
| `autorestart: false` | `autoRestart: 'never'` (`always`, `on-failure`) |
| `max_restarts`, `restart_delay` | `maxRestarts`, `restartDelay` |
| `exp_backoff_restart_delay` | `backoffStrategy: 'exponential'`, `maxBackoffDelay` |
| `max_memory_restart: '512M'` | `maxMemory: '512M'` (or `limits.memory`) |
| `watch`, `ignore_watch` | `watch: { paths, ignore }` |
| `cron_restart` | a scheduled job (`cron`), see README |
| `env_production` | not supported; use separate config files |

```js
// before
module.exports = { apps: [{ name: 'api', script: './server.js', instances: 4, exec_mode: 'cluster', max_memory_restart: '512M' }] };
// after
import { defineConfig } from 'opendaemon/sdk';
export default defineConfig({ apps: [{ name: 'api', script: './server.js', instances: 4, mode: 'cluster', maxMemory: '512M' }] });
```

## Differences worth knowing

- The daemon keeps its files in `~/.opendaemon` (`$OPENDAEMON_HOME`), so `od` works from any directory.
- Every IPC request carries a per-start token; the socket and token file are `0600`.
- The WebUI listens on `127.0.0.1` only unless `host` is set.
- Secrets are encrypted at rest (`od secret`) and injected with `env: { KEY: { secret: 'NAME' } }`.
- Health checks, dependencies between apps, Prometheus metrics, notifications and an audit log are built in rather than separate modules.
