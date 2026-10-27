# OpenDaemon

Next-generation process manager for Node.js. Built with TypeScript, zero runtime dependencies, and a plugin-first architecture.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **Zero Runtime Dependencies** - Everything built from scratch, no `node_modules` bloat
- **Plugin-First Architecture** - Micro-kernel with extensible plugin system and dependency resolution
- **TypeScript Native** - Written in TypeScript, configured in TypeScript with `defineConfig`
- **Fork & Cluster Modes** - Single-instance or multi-instance process management
- **Auto-Restart** - Configurable strategies: `always`, `on-failure`, `unless-stopped`, `never`
- **Backoff Strategies** - Fixed, linear, or exponential restart delays with jitter
- **CPU & Memory Monitoring** - Real-time metrics collection for all managed processes
- **IPC Communication** - Binary frame protocol + JSON-RPC 2.0 over Unix sockets / TCP
- **WebUI Dashboard** - Built-in web interface with authentication and live process monitoring
- **Cross-Platform** - Works on Linux, macOS, and Windows
- **579 Tests** - Comprehensive test suite across 26 test files

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

If the daemon fails to start, the reason is printed and its full output is in `opendaemon.log`.

```typescript
import { defineConfig } from 'opendaemon/sdk';

export default defineConfig({
  daemon: {
    pidFile: 'opendaemon.pid',
    logDir: './logs',
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

## CLI Commands

| Command | Description |
|---------|-------------|
| `od start <script>` | Start a process (`-n` name, `-i` instances) |
| `od stop <name>` | Stop a process |
| `od restart <name>` | Restart a process |
| `od delete <name>` | Delete a process |
| `od list` / `od ls` | List all processes (`--json`, `-q`) |
| `od info <name>` | Detailed process info (CPU, memory, PID, uptime) |
| `od logs <name>` | View process logs |
| `od status` | Daemon & process status overview |
| `od daemon start\|stop\|restart\|status` | Manage the daemon |
| `od help` | Show help |

## Web UI

The built-in dashboard runs at `http://localhost:7777` with the WebUI plugin enabled.

- Real-time process table with status, CPU, memory, uptime, and restart count
- Start, stop, restart, and delete processes from the browser
- Stats overview cards (total, online, errored, stopped)
- Optional authentication (Basic / Bearer token)
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

# Run tests (579 tests, 26 files)
npm test

# Run tests with coverage
npm run test:coverage
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
