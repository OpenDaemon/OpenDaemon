# OpenDaemon

Next-generation process manager for Node.js. Built with TypeScript, zero runtime dependencies, and a plugin-first architecture.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **Zero Runtime Dependencies** - Everything built from scratch, no `node_modules` bloat
- **Plugin-First Architecture** - Micro-kernel with extensible plugin system and dependency resolution
- **TypeScript Native** - Written in TypeScript, configured in TypeScript with `defineConfig`
- **Fork & Cluster Modes** - Single process, or N `node:cluster` workers sharing one port (`instances: 4` or `'max'`), with per-worker logs and crash restarts
- **Auto-Restart** - Configurable strategies: `always`, `on-failure`, `unless-stopped`, `never`
- **Backoff Strategies** - Fixed, linear, or exponential restart delays with jitter
- **Metrics** - Host, process and app metrics (`opendaemon/runtime` counters, gauges, histograms) as Prometheus text at `/metrics` or JSON; `maxMemory` restarts
- **Persistent Logs** - JSON-lines log files per process with size rotation, gzip, search (`--grep`, `--since`) and live follow (`-f`)
- **Secrets** - AES-256-GCM secret store, `{ secret: NAME }` env references, rotation that restarts the apps using a secret
- **Scheduled Jobs** - `cron` apps with time zones, overlap control, retries and run history (`od cron`)
- **Watch Mode** - `--watch` restarts on file changes (recursive `fs.watch`, ignore patterns, debounce)
- **Dependencies** - Start order from `dependencies` (waits for healthy dependencies), reverse-order shutdown, cycle detection
- **Health Checks** - HTTP(S), TCP, script, command, memory, CPU and composite checks with automatic restart or stop
- **IPC Communication** - Binary frame protocol + JSON-RPC 2.0 over Unix sockets / TCP
- **Terminal Dashboard** - `od monit`, htop-style, with sparklines, health and live logs (raw ANSI, no dependencies)
- **WebUI Dashboard** - Built-in web interface with authentication and live process monitoring
- **Cross-Platform** - Works on Linux, macOS, and Windows
- **Tested End to End** - Unit and integration tests that spawn real processes, sockets and HTTP servers; CI on Linux, macOS and Windows

## Quick Start

```bash
# Install dependencies & build
npm install
npm run build

# Start the daemon
od daemon start

# Start a process
od start app.js --name my-app

# Start with multiple instances (cluster mode)
od start server.js --name api --instances 4

# List processes
od list

# View process details
od info my-app

# View logs
od logs my-app

# Restart / stop / delete
od restart my-app
od stop my-app
od delete my-app

# Check daemon & process status
od status

# View WebUI
open http://localhost:7777

# Stop the daemon
od daemon stop
```

## Configuration

Create an `opendaemon.config.ts` (or `.js`, `.mjs`, `.json`, `.yaml`, or an `opendaemon` field in `package.json`) in the directory where you run `od daemon start`. TypeScript configs are loaded with Node's built-in type stripping and need Node.js >= 22.18; on older versions use `.js`, `.json` or `.yaml`.

If the daemon fails to start, the reason is printed and its full output is in `~/.opendaemon/daemon.log`.

The daemon keeps its runtime files in `$OPENDAEMON_HOME`, which defaults to `~/.opendaemon` (mode `0700`). They are `opendaemon.pid`, `opendaemon.sock` (Unix), `auth-token`, `daemon.log` and `logs/`. This lets `od` reach the daemon from any directory. To run separate daemons, give each one its own `OPENDAEMON_HOME`. Every CLI request must carry the token. The token file and the socket are readable only by the user who started the daemon (mode `0600`), so other local users cannot control it. That includes Windows, where the daemon listens on TCP `127.0.0.1:9995`.

```typescript
import { defineConfig } from 'opendaemon/sdk';

export default defineConfig({
  daemon: {
    logDir: './logs',          // optional; default ~/.opendaemon/logs
    shutdownTimeout: 10000,
  },
  apps: [
    {
      name: 'api-server',
      script: './dist/server.js',
      instances: 4,
      mode: 'cluster',
      env: { NODE_ENV: 'production', PORT: '3000' },
      autoRestart: 'always',
      maxRestarts: 15,
      restartDelay: 1000,
      backoffStrategy: 'exponential',
      backoffMultiplier: 2,
      maxBackoffDelay: 30000,
    },
    {
      name: 'worker',
      script: './dist/worker.js',
      mode: 'fork',
      autoRestart: 'on-failure',
    },
  ],
  plugins: {
    webui: {
      port: 7777,
      username: 'admin',
      password: 'changeme',
    },
  },
});
```

## Health Checks

Give an app a `healthCheck` and the `health-check` plugin runs it on a schedule. After `failureThreshold` consecutive failures the process is marked unhealthy and the `action` runs.

```yaml
apps:
  - name: api
    script: ./dist/server.js
    healthCheck:
      type: http                 # process | http | https | tcp | script | command | memory | cpu | composite
      url: http://127.0.0.1:3000/health
      expectedStatus: 200        # default: any 2xx; also a list, e.g. [200, 204]
      expectedBody: '"ok"'       # optional substring (a RegExp in JS/TS configs)
      interval: 30000            # ms between checks (default 30000)
      timeout: 5000              # ms per check (default 5000)
      failureThreshold: 3        # failures before unhealthy (default 3)
      successThreshold: 1        # successes before healthy again (default 1)
      initialDelay: 0            # ms before the first check (default 0)
      action: restart            # restart | stop | notify | none (default restart)
```

| Type | Passes when | Fields |
|------|-------------|--------|
| `process` | every pid of the process is alive | none |
| `http` / `https` | the response status matches (2xx by default) and the body matches | `url`, `method`, `headers`, `expectedStatus`, `expectedBody`, `rejectUnauthorized` (https) |
| `tcp` | a TCP connection succeeds | `port`, `host` (default `127.0.0.1`) |
| `script` | an executable exits with 0 (no shell) | `command`, `args` |
| `command` | a shell command exits with 0 | `command`, `args` |
| `memory` | resident memory is below the threshold | `threshold` (bytes or `'512M'`) |
| `cpu` | CPU is below the threshold | `threshold` (percent) |
| `composite` | the `checks` pass together (`and`) or any one passes (`or`) | `checks`, `operator` |

Script and command checks get `OD_PROCESS_NAME` and `OD_PROCESS_PID` in their environment. Checks pause while a process is restarting. `notify` and `none` only report the state: it shows in `od health` and is emitted as the `health:status:unhealthy` event. `grpc` checks are not supported yet.

## Secrets

Keep credentials out of config files and repositories. They are encrypted with AES-256-GCM in `~/.opendaemon/secrets.enc` and decrypted only when a process starts:

```bash
od secret set DATABASE_URL 'postgres://user:pass@host/db'
echo -n "$TOKEN" | od secret set API_TOKEN     # from stdin: stays out of shell history
od secret list                                 # names and versions, never values
od secret get DATABASE_URL
od secret rotate DATABASE_URL 'postgres://...' # new version, restarts the apps that use it
od secret export > .env                        # decrypted .env, for local development only
od secret delete API_TOKEN
```

```yaml
apps:
  - name: api
    script: ./api.js
    env:
      PORT: 3000
      DATABASE_URL:
        secret: DATABASE_URL     # latest version; add `version: 2` to pin one
```

The key is a random 256-bit file, `~/.opendaemon/master.key` (mode `0600`). If `OPENDAEMON_SECRET_PASSWORD` is set when the store is created, the key is derived from that password with PBKDF2 instead. The daemon then needs the same variable. Each secret is bound to its name, so tampering or moving ciphertexts is detected. The last five versions are kept. A missing secret stops the app from starting, with an error that names the secret but never the value.

This protects secrets in config files, repositories and copies of `secrets.enc`. It does not protect them from someone who can act as the daemon's user, since that person can read the key.

## Scheduled Jobs

An app with `cron` runs as a job. It does not start with the daemon. It starts at each match of the expression instead, and it is not restarted when it exits:

```yaml
apps:
  - name: cleanup
    script: ./jobs/cleanup.js
    cron: '0 2 * * *'            # every day at 02:00
    cronTimezone: Europe/Istanbul # IANA zone (default: the host's)
    cronOverlap: false           # still running at the next tick: skip it (true: restart it)
    cronRetry: 3                 # re-run a failed run (non-zero exit) up to 3 times
```

Expressions take 5 fields (`minute hour day month weekday`) or 6 with seconds first. Each field accepts `*`, ranges, steps (`*/15`, `9-17/2`), lists, month and day names, and macros (`@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`). When both day fields are restricted, a day matches if either one does, as in classic cron. `od cron` shows each job's next run and last result. Invalid expressions and unknown time zones are rejected when the config loads.

## Watch Mode

Use `od start app.js --watch` or set `watch` on an app, and the process restarts gracefully when its files change:

```yaml
apps:
  - name: dev-server
    script: ./src/server.js
    watch:
      paths: [./src]              # default: the app's cwd (or its script's directory)
      ignore: ['*.test.js', 'src/generated/**']
      delay: 1000                 # debounce in ms (default 1000)
```

`watch: true` uses the defaults. `node_modules`, `.git`, `*.log`, `logs`, `coverage`, `dist` and the daemon's log directory are always ignored. In a pattern, `*` and `?` match within one path segment and `**` matches across segments. A pattern without `/` matches any segment. A burst of saves causes one restart, and each change is logged.

## Dependencies

List the apps an app needs in `dependencies`. Independent apps start in parallel. An app with dependencies starts once each of them is online, and healthy if it has a `healthCheck`:

```yaml
apps:
  - name: database
    script: ./db-proxy.js
    healthCheck: { type: tcp, port: 5432 }
  - name: api
    script: ./api.js
    dependencies: [database]
    dependencyTimeout: 60000   # ms to wait before giving up (default 60000)
  - name: gateway
    script: ./gateway.js
    dependencies: [api]
```

While an app waits, `od list` shows it as `waiting`. If a dependency fails or the timeout passes, the app is marked `errored` and `od info` shows the reason. Unknown or circular dependencies are rejected when the config loads. When the daemon stops, it stops dependents before the apps they depend on. `od stop <name>` stops only that app.

## Logs

The `log-manager` plugin writes each process's stdout and stderr to `<logDir>/<name>-out.log` and `<name>-error.log`, one JSON object per line (`timestamp`, `level`, `pid`, `processName`, `instanceId`, `message`, `source`). `logDir` comes from `daemon.logDir` and defaults to `~/.opendaemon/logs`. Logs survive daemon restarts.

```bash
od logs api --lines 50             # last 50 lines of api (stdout and stderr, merged by time)
od logs -f                         # follow all processes; --lines 0 to skip history
od logs --grep 'ERROR|WARN' --since 2h
od logs api --json | jq .message   # raw entries
od flush api                       # empty api's log files
```

Rotation is size-based. Set the defaults under `plugins.log-manager`, and override them per app with `logRotation`:

```yaml
plugins:
  log-manager:
    maxSize: 10M      # rotate when a file would pass this size (default 10M)
    maxFiles: 5       # rotated files to keep: name.log.1 ... name.log.5 (default 5)
    compress: true    # gzip rotated files (default true)
apps:
  - name: chatty
    script: ./chatty.js
    logRotation:
      maxSize: 100M
      enabled: true   # false: never rotate
```

Time-based rotation, retention by age and WebSocket streaming are not implemented yet.

## Metrics

The `metrics-collector` plugin reports host metrics (CPU per core, memory, load average, uptime), per-process metrics (up, CPU, memory, restarts, uptime, instances) and the metrics your app defines with the SDK runtime:

```typescript
import { metrics } from 'opendaemon/runtime';

const requests = metrics.counter('http_requests_total', 'HTTP requests');
requests.inc({ method: 'GET' });
const latency = metrics.histogram('http_request_seconds', 'Request latency');
latency.observe(0.042, { route: '/users' });
```

When the app runs under OpenDaemon, the runtime sends a snapshot every 5 seconds over the process's IPC channel (`OD_METRICS_INTERVAL` changes the period). Outside OpenDaemon it does nothing. Cluster workers are labelled with `instance`.

- `od metrics` prints Prometheus text; `od metrics --json` prints the JSON report.
- The WebUI serves `GET /metrics` (Prometheus) and `GET /api/metrics` (JSON). With WebUI auth enabled, configure the scraper with `basic_auth`.

Set `maxMemory: '512M'` on an app (or `od start app.js --max-memory 512M`) to restart it when its resident memory, all instances together, passes the limit. These restarts count in `od list`.

## CLI Commands

| Command | Description |
|---------|-------------|
| `od start <script>` | Start a process (`-n` name, `-i` instances, `--env KEY=value`, `--max-memory 512M`, `--watch`) |
| `od stop <name>` | Stop a process |
| `od restart <name>` | Restart a process |
| `od delete <name>` | Delete a process |
| `od scale <name> <n\|max>` | Change the number of cluster workers without a restart |
| `od list` / `od ls` | List all processes (`--json`, `-q`) |
| `od info <name>` | Detailed process info (CPU, memory, PID, uptime) |
| `od logs [name]` | Logs of one or all processes (`--lines N`, `-f`, `--grep RE`, `--since 2h`, `--json`) |
| `od flush [name]` | Empty log files |
| `od secret <set\|get\|list\|delete\|export\|rotate>` | Encrypted secrets |
| `od cron` | Scheduled jobs: next run and last result |
| `od metrics` | Prometheus metrics (`--json` for the JSON report) |
| `od health [name]` | Health check status (last result, consecutive failures) |
| `od status` | Daemon & process status overview |
| `od monit` | Live terminal dashboard: processes, CPU/memory sparklines, health, logs; `r` restart, `s` stop |
| `od daemon start\|stop\|restart\|status` | Manage the daemon |
| `od help` | Show help |

## Web UI

The built-in dashboard runs at `http://localhost:7777` with the WebUI plugin enabled.

- Real-time process table with status, CPU, memory, uptime, and restart count
- Start, stop, restart, and delete processes from the browser
- Stats overview cards (total, online, errored, stopped)
- Optional authentication (`username`/`password`): each login gets its own Bearer token, which expires after `sessionTtl` ms (default 12 hours) and is revoked by logout; Basic auth also works
- Listens on `127.0.0.1` only unless `host` is set
- Auto-refresh every 3 seconds
- Toast notifications for actions

### REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/processes` | List all processes |
| `POST` | `/api/start` | Start a new process |
| `POST` | `/api/stop/:name` | Stop a process |
| `POST` | `/api/restart/:name` | Restart a process |
| `DELETE` | `/api/delete/:name` | Delete a process |
| `GET` | `/api/daemon` | Daemon status & uptime |
| `POST` | `/api/login` | Authenticate (returns Bearer token) |

## Architecture

```
opendaemon/
├── packages/
│   ├── core/                  # Micro-kernel, event bus, state machine, IPC, plugins
│   ├── cli/                   # CLI (od), daemon entry, argument parser, output formatting
│   ├── sdk/                   # TypeScript SDK, defineConfig, metrics runtime
│   └── plugins/
│       ├── process-manager/   # Process lifecycle, fork/cluster, metrics, restart strategies
│       ├── config-manager/    # Config file loading & validation (TS/JS/JSON/YAML)
│       ├── health-check/      # Scheduled health checks, thresholds, restart/stop actions
│       ├── log-manager/       # Persistent JSON-lines logs, rotation, search, follow
│       ├── metrics-collector/ # Host/process/app metrics, Prometheus and JSON
│       ├── watch-mode/        # Restart on file changes
│       ├── scheduler/         # Cron-scheduled jobs
│       ├── secret-manager/    # Encrypted secrets, env injection
│       └── webui/             # HTTP server, REST API, dashboard HTML
├── tests/
│   ├── unit/                  # Unit tests
│   └── integration/           # IPC, kernel, and daemon integration tests
└── tsup.config.ts             # Build config (core, cli, sdk)
```

### Core Components

| Component | Description |
|-----------|-------------|
| **Kernel** | Micro-kernel managing plugins, state, and lifecycle transitions |
| **EventBus** | Pub/sub with wildcard patterns (`process:*`), sync & async emit |
| **StateMachine** | Generic state machine with before/after transition hooks |
| **StateStore** | Key-value store with subscription support |
| **IPC Server/Client** | Binary frame protocol (type + length + payload) + JSON-RPC 2.0 |
| **PluginRegistry** | Dependency graph resolution via topological sort, conflict detection |
| **Logger** | Structured logging with levels TRACE through FATAL, namespacing |

## Development

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# End-to-end: builds, then drives the real `od` CLI and daemon
npm run test:e2e
```

## Why OpenDaemon?

| | OpenDaemon | PM2 |
|---|---|---|
| Runtime deps | **0** | 30+ |
| Architecture | Micro-kernel + plugins | Monolithic |
| TypeScript | Native | Bolted on |
| Config format | TS, JS, JSON, YAML | JS, JSON, YAML |
| Plugin system | First-class with DI | Limited |
| IPC protocol | Binary frames + JSON-RPC 2.0 | Custom |

## Requirements

- Node.js >= 20.0.0

## Community

- **Twitter/X**: [@ersinkoc](https://x.com/ersinkoc)
- **GitHub**: [github.com/ersinkoc](https://github.com/ersinkoc)

## License

MIT © [Ersin KOC](https://github.com/ersinkoc) & Contributors
