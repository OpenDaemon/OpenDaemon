# OpenDaemon Specification

## 1. Overview

OpenDaemon is a next-generation process manager for Node.js built with TypeScript, featuring a micro-kernel architecture with zero runtime dependencies.

### 1.1 Core Principles
- **Zero Runtime Dependencies**: Core daemon has no npm dependencies
- **Plugin-First Architecture**: Everything is a plugin, including core features
- **TypeScript Native**: Written in and configured with TypeScript
- **MIT Licensed**: Truly open source

### 1.2 Key Differentiators from PM2
- Modern TypeScript codebase with strict typing
- Extensible plugin system
- Advanced health checks (HTTP, TCP, gRPC, custom scripts)
- Zero-downtime deployment strategies
- Structured logging with rotation
- Encrypted secret management
- Process dependencies and DAG-based startup
- Real-time TUI dashboard

## 2. Architecture

### 2.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      User Layer                              │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐   │
│  │  CLI   │ │  SDK   │ │REST API│ │WebSock │ │  TUI   │   │
│  │  (od)  │ │(import)│ │Client  │ │Client  │ │Dashboard│  │
│  └────┬───┘ └────┬───┘ └────┬───┘ └────┬───┘ └────┬───┘   │
├───────┴──────────┴──────────┴──────────┴──────────┴────────┤
│              IPC Layer (Unix Domain Socket)                │
│           JSON-RPC 2.0 + Binary Frames (logs)             │
├────────────────────────────────────────────────────────────┤
│                   Daemon Core (Micro-Kernel)               │
│  ┌─────────────────────────────────────────────────────┐  │
│  │              Plugin Registry & Lifecycle             │  │
│  ├─────────┬──────────┬──────────┬──────────┬──────────┤  │
│  │ Process │  Health  │   Log    │ Metrics  │ Deploy   │  │
│  │ Manager │  Check   │ Manager  │Collector │Strategy  │  │
│  └─────────┴──────────┴──────────┴──────────┴──────────┘  │
│  ┌─────────────────────────────────────────────────────┐  │
│  │                 Event Bus (Pub/Sub)                  │  │
│  └─────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

### 2.2 Micro-Kernel Responsibilities
The kernel (~2KB) handles ONLY:
- Plugin registration, lifecycle, dependency resolution
- Event bus for inter-plugin pub/sub
- Error boundary with circuit breaker per plugin
- Configuration loading and validation
- State machine for daemon lifecycle
- Watchdog timer for self-health monitoring

### 2.3 Plugin Interface
```typescript
export interface Plugin<TConfig = unknown> {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly priority?: number;
  readonly dependencies?: readonly string[];
  readonly conflicts?: readonly string[];
  readonly defaultConfig?: TConfig;
  readonly configSchema?: JsonSchema;
  
  install(context: PluginContext): void | Promise<void>;
  onStart?(context: PluginContext): void | Promise<void>;
  onReady?(context: PluginContext): void | Promise<void>;
  onStop?(context: PluginContext): void | Promise<void>;
  onError?(error: DaemonError, context: PluginContext): void;
  healthCheck?(context: PluginContext): boolean | Promise<boolean>;
}
```

### 2.4 Plugin Context
```typescript
export interface PluginContext {
  readonly config: DaemonConfig;
  readonly pluginConfig: unknown;
  readonly events: EventBus;
  readonly logger: Logger;
  readonly store: StateStore;
  registerMethod(name: string, handler: RpcHandler): void;
  registerHook(hookName: string, handler: HookHandler): void;
  getPlugin<T extends Plugin>(name: string): T | undefined;
  registerMetric(metric: MetricDefinition): void;
}
```

## 3. Core Features

### 3.1 Process Management (process-manager plugin)

**Process States:**
```
created → starting → online → stopping → stopped
  ↑________|    ↓          ↓
  └_________← errored ←___┘
```

**States:**
- `created` - Process definition created but not started
- `starting` - Start signal sent, waiting for ready signal or timeout
- `online` - Process running and healthy
- `stopping` - Stop signal sent, waiting for graceful shutdown
- `stopped` - Process terminated
- `errored` - Process crashed or failed to start

**Configuration:**
```typescript
interface ProcessConfig {
  name: string;
  script: string;
  cwd?: string;
  env?: Record<string, string | SecretReference>;
  instances?: number | 'max';
  mode?: 'fork' | 'cluster';
  
  // Execution
  interpreter?: string;
  interpreterArgs?: string[];
  args?: string[];
  
  // Resource limits
  maxMemory?: string | number;  // "512M" or bytes
  maxCpu?: number;  // percentage
  
  // Lifecycle
  autoRestart?: boolean | RestartStrategy;
  restartDelay?: number;
  maxRestarts?: number;
  minUptime?: number;
  killTimeout?: number;
  
  // Health check
  healthCheck?: HealthCheckConfig;
  
  // Logging
  logFile?: string;
  errorLogFile?: string;
  logLevel?: LogLevel;
  mergeLogs?: boolean;
  
  // Advanced
  uid?: number | string;
  gid?: number | string;
  nice?: number;
  umask?: string | number;
  detached?: boolean;
  cron?: string;
  watch?: boolean | WatchConfig;
  dependencies?: string[];
}
```

**Restart Strategies:**
- `always` - Always restart on exit
- `on-failure` - Restart only on non-zero exit
- `unless-stopped` - Restart unless explicitly stopped
- `never` - Never restart

**Restart Backoff:**
- `fixed` - Constant delay
- `linear` - Delay increases linearly
- `exponential` - Delay doubles each time with jitter

### 3.2 Health Check System (health-check plugin)

**Check Types:**
| Type | Description |
|------|-------------|
| `process` | Process alive check (default) |
| `http` | HTTP GET returns 2xx |
| `https` | HTTPS with optional cert verification |
| `tcp` | TCP connection succeeds |
| `script` | Custom script exits with 0 |
| `grpc` | gRPC health check protocol |
| `command` | Shell command execution |
| `composite` | Multiple checks with AND/OR logic |
| `memory` | Memory below threshold |
| `cpu` | CPU below threshold |

**Configuration:**
```typescript
interface HealthCheckConfig {
  type: HealthCheckType;
  interval?: number;        // default: 30000
  timeout?: number;         // default: 5000
  failureThreshold?: number; // default: 3
  successThreshold?: number; // default: 1
  initialDelay?: number;    // default: 0
  action?: 'restart' | 'stop' | 'notify' | 'none'; // default: 'restart'
  
  // HTTP/HTTPS specific
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  expectedStatus?: number | number[];
  expectedBody?: string | RegExp;
  
  // TCP specific
  host?: string;
  port?: number;
  
  // Script/Command specific
  command?: string;
  args?: string[];
  
  // Composite specific
  checks?: HealthCheckConfig[];
  operator?: 'and' | 'or';
}
```

### 3.3 Log Management (log-manager plugin)

**Features:**
- Structured JSON logging
- Real-time streaming via WebSocket and IPC
- Automatic rotation by size and time
- Gzip compression for rotated files
- Per-process log files (stdout + stderr separate or merged)
- Log levels: trace, debug, info, warn, error, fatal
- Filtering by level, process, pattern (regex)
- Tail with follow mode
- Search across all processes
- Retention policy (time and size based)
- Timestamp formats: ISO8601, Unix, custom
- Colorized terminal output (auto-detect TTY)
- Buffering with flush strategies
- Crash log preservation

**Log Entry Format:**
```typescript
interface LogEntry {
  timestamp: string;        // ISO8601
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  pid: number;
  processName: string;
  instanceId?: number;
  message: string;
  source: 'stdout' | 'stderr';
  metadata?: Record<string, unknown>;
}
```

**Rotation Configuration:**
```typescript
interface RotationConfig {
  enabled: boolean;
  maxSize?: string | number;  // "10M" or bytes
  maxFiles?: number;
  maxAge?: string | number;   // "7d" or seconds
  compress?: boolean;         // gzip
  directory?: string;
  datePattern?: string;       // "YYYY-MM-DD"
}
```

### 3.4 Metrics Collection (metrics-collector plugin)

**Per-Process Metrics:**
- CPU usage (%, user time, system time)
- Memory (RSS, heap total/used, external, array buffers)
- Event loop latency (p50, p95, p99, max)
- Event loop utilization
- Active handles and requests
- GC statistics (if available)
- Restart count
- Uptime
- Custom metrics via plugin API

**System Metrics:**
- Total CPU usage (per core and aggregate)
- Memory (total, free, used, swap)
- Load average (1m, 5m, 15m)
- Disk usage (per mount point)
- Network I/O (per interface)
- Open file descriptors

**Export Formats:**
- Prometheus (text exposition format)
- JSON (REST API)
- OpenTelemetry (OTLP gRPC/HTTP)
- StatsD (UDP push)
- Custom via plugin

### 3.5 Cluster Management (cluster-manager plugin)

**Features:**
- Automatic instance count (CPU detection)
- Manual instance count
- Zero-downtime reload (graceful worker rotation)
- Sticky sessions for WebSocket
- Load balancing strategies: round-robin, least-connections, IP-hash, random, weighted
- Per-instance health checks
- Instance-level metrics
- Auto-scaling based on CPU, memory, request rate, custom metrics
- Scale limits (min/max)
- Graceful scale-down

**Auto-Scaling Config:**
```typescript
interface AutoScaleConfig {
  enabled: boolean;
  min: number;
  max: number;
  scaleUp: {
    metric: 'cpu' | 'memory' | 'eventLoopLatency' | 'custom';
    threshold: number;
    duration: number;
    step: number;
    cooldown: number;
  };
  scaleDown: {
    metric: 'cpu' | 'memory' | 'eventLoopLatency' | 'custom';
    threshold: number;
    duration: number;
    step: number;
    cooldown: number;
  };
}
```

### 3.6 Deployment Strategies (deploy-strategy plugin)

**Strategies:**
| Strategy | Description | Best For |
|----------|-------------|----------|
| `rolling` | Replace instances one-by-one | Most applications |
| `blue-green` | New set, switch traffic, tear down old | Critical apps |
| `canary` | Route % traffic to new version | Risk-sensitive |
| `recreate` | Stop all, start all (has downtime) | Stateful apps |
| `a-b` | Route based on header/cookie | Feature testing |

**Configuration:**
```typescript
interface DeployConfig {
  strategy: 'rolling' | 'blue-green' | 'canary' | 'recreate' | 'a-b';
  
  // Rolling
  maxUnavailable?: number;
  maxSurge?: number;
  
  // Canary
  canaryPercent?: number;
  canarySteps?: number[];
  canaryAnalysis?: {
    metrics: string[];
    threshold: number;
    duration: number;
  };
  
  // Blue-Green
  switchTimeout?: number;
  
  // All strategies
  healthCheck?: HealthCheckConfig;
  rollbackOnFailure?: boolean;
  timeout?: number;
}
```

### 3.7 Secret Management (secret-manager plugin)

**Features:**
- AES-256-GCM encryption at rest
- Master key from machine-id + password (PBKDF2)
- Store: `~/.opendaemon/secrets.enc`
- Environment injection at process start
- Secret rotation without restart
- Secret references in config: `{ secret: 'key-name' }`
- External vault integration via plugin

**API:**
```bash
od secret set <key> <value>
od secret get <key>
od secret list
od secret delete <key>
od secret export --format env
od secret rotate <key>
```

### 3.8 Process Dependencies (dependency-resolver plugin)

**Features:**
- DAG-based dependency resolution
- Parallel start of independent processes
- Health-check-based readiness
- Circular dependency detection
- Cascade stop/restart
- Dependency graph visualization

**Configuration:**
```typescript
interface DependencyConfig {
  dependencies?: string[];  // Wait for these to be healthy
  cascadeStop?: boolean;    // Stop dependents first
  cascadeRestart?: boolean; // Restart dependents
}
```

### 3.9 Scheduler / Cron (scheduler plugin)

**Features:**
- Standard cron syntax
- Extended: seconds field, @yearly, @monthly, @weekly, @daily, @hourly
- Timezone support
- Overlap prevention
- Cron parsing from scratch
- Execution history
- Next execution calculation
- On-failure actions

**Configuration:**
```typescript
interface SchedulerConfig {
  cron: string;
  cronTimezone?: string;
  cronOverlap?: boolean;  // Skip if still running
  cronRetry?: number;
  autoRestart?: boolean;
}
```

### 3.10 Watch Mode (watch-mode plugin)

**Features:**
- Recursive directory watching (fs.watch, no chokidar)
- Glob-like pattern matching (from scratch)
- Ignore patterns
- Debounce delay
- Graceful restart
- Clear console option

**Configuration:**
```typescript
interface WatchConfig {
  paths: string[];
  ignore?: string[];
  delay?: number;
  clearConsole?: boolean;
}
```

### 3.11 Notification System (notification plugin)

**Channels:**
- Webhook (HTTP POST)
- Slack (webhook)
- Discord (webhook)
- Email (SMTP from scratch)
- Custom via plugin

**Events:**
- Process crash
- Process unhealthy
- Max memory exceeded
- High CPU sustained
- Deployment events
- Daemon start/stop
- Auto-scale triggered

**Configuration:**
```typescript
interface NotificationConfig {
  channels: Array<{
    type: 'webhook' | 'slack' | 'discord' | 'email';
    url?: string;
    smtp?: SmtpConfig;
    to?: string[];
    events: string[];
  }>;
  throttle?: number;
  batchWindow?: number;
}
```

### 3.12 Resource Limiter (resource-limiter plugin)

**Limits:**
- Max memory (RSS) — action: warn, restart, stop
- Max CPU (%) sustained — action: warn, throttle, restart, stop
- Max open file descriptors
- Max child processes
- Max event loop latency

**Configuration:**
```typescript
interface ResourceLimits {
  memory?: {
    max: string | number;
    action: 'warn' | 'restart' | 'stop';
    grace?: number;
  };
  cpu?: {
    max: number;
    duration: number;
    action: 'warn' | 'throttle' | 'restart' | 'stop';
  };
  eventLoopLatency?: {
    max: number;
    action: 'warn' | 'restart';
  };
}
```

### 3.13 Audit Logger (audit-logger plugin)

**Logged Events:**
- All RPC method calls (who, when, what, result)
- Configuration changes
- Process lifecycle events
- Secret access (keys only, not values)
- Plugin enable/disable
- Authentication events

**Format:**
```json
{
  "timestamp": "2025-01-15T10:30:00.000Z",
  "action": "process.restart",
  "actor": { "type": "cli", "pid": 12345, "user": "ersin" },
  "target": { "type": "process", "name": "api-gateway" },
  "params": { "strategy": "rolling" },
  "result": "success",
  "duration": 3200
}
```

### 3.14 Startup Script Generator (startup-manager plugin)

**Supported Init Systems:**
- systemd (Linux)
- launchd (macOS)
- upstart (Legacy Linux)
- OpenRC (Alpine)
- Windows Service
- rc.d (FreeBSD)

## 4. Configuration System

### 4.1 Config File Discovery (priority order)
1. `opendaemon.config.ts` (TypeScript - recommended)
2. `opendaemon.config.js` (JavaScript ESM)
3. `opendaemon.config.cjs` (JavaScript CJS)
4. `opendaemon.config.json` (JSON)
5. `opendaemon.config.yaml` (YAML)
6. `.opendaemonrc` (JSON)
7. `package.json` → `"opendaemon"` field

### 4.2 TypeScript Config Example
```typescript
// opendaemon.config.ts
import { defineConfig } from 'opendaemon';

export default defineConfig({
  daemon: {
    pidFile: '/var/run/opendaemon.pid',
    logDir: '/var/log/opendaemon',
    socketPath: '/var/run/opendaemon.sock',
    shutdownTimeout: 10000,
  },
  
  defaults: {
    instances: 'max',
    maxMemory: '512M',
    restartStrategy: 'exponential',
    healthCheck: {
      type: 'http',
      interval: 30000,
    },
  },
  
  apps: [
    {
      name: 'api-gateway',
      script: './dist/gateway.js',
      instances: 4,
      port: 3000,
      env: {
        NODE_ENV: 'production',
        DATABASE_URL: { secret: 'db-url' },
      },
      healthCheck: {
        type: 'http',
        url: 'http://localhost:3000/health',
      },
      deploy: {
        strategy: 'rolling',
        maxUnavailable: 1,
      },
      dependencies: ['database-proxy'],
    },
    {
      name: 'worker',
      script: './dist/worker.js',
      instances: 2,
      cron: '*/5 * * * *',
      autoRestart: false,
    },
  ],
  
  plugins: {
    'metrics-collector': {
      prometheus: { enabled: true, port: 9090 },
    },
  },
});
```

## 5. IPC Protocol

### 5.1 Transport
- Unix Domain Sockets (Linux/macOS)
- Named Pipes (Windows)
- Socket path: `/var/run/opendaemon.sock` or user-specific

### 5.2 Protocol: JSON-RPC 2.0

**Frame Format:**
```
┌──────┬──────┬──────────────────────────────┐
│ Type │ Len  │         Payload              │
│  1B  │  4B  │    Variable (JSON/Binary)    │
└──────┴──────┴──────────────────────────────┘
```

**Frame Types:**
- `0x01` - JSON-RPC Request
- `0x02` - JSON-RPC Response
- `0x03` - JSON-RPC Notification
- `0x04` - Binary (log stream)
- `0x05` - Heartbeat
- `0x06` - Auth Challenge
- `0x07` - Auth Response

### 5.3 Security
- Socket file permissions: 0o660
- Optional authentication token: `~/.opendaemon/auth-token`
- Rate limiting per client
- Max message size: 10MB default

### 5.4 RPC Methods

| Method | Description |
|--------|-------------|
| `process.start` | Start a process |
| `process.stop` | Stop a process |
| `process.restart` | Restart a process |
| `process.reload` | Zero-downtime reload |
| `process.delete` | Remove a process |
| `process.list` | List all processes |
| `process.info` | Get process details |
| `process.scale` | Scale instances |
| `log.stream` | Start log streaming |
| `log.flush` | Flush logs |
| `log.search` | Search logs |
| `metric.snapshot` | Get current metrics |
| `metric.history` | Get historical metrics |
| `daemon.status` | Daemon health |
| `daemon.reload` | Reload configuration |
| `daemon.shutdown` | Graceful shutdown |
| `daemon.version` | Version info |
| `plugin.list` | List plugins |
| `plugin.enable` | Enable plugin |
| `plugin.disable` | Disable plugin |
| `secret.get` | Get secret |
| `secret.set` | Set secret |
| `deploy.execute` | Execute deployment |
| `deploy.rollback` | Rollback deployment |
| `deploy.status` | Deploy status |

## 6. CLI Interface

### 6.1 Command Structure
```bash
od <command> [subcommand] [options] [args]
```

### 6.2 Commands

**Process Management:**
```bash
od start <script|config>          # Start process(es)
od stop <name|id|all>             # Stop process(es)
od restart <name|id|all>          # Restart process(es)
od reload <name|id|all>           # Zero-downtime reload
od delete <name|id|all>           # Remove process(es)
od scale <name> <+N|-N|N>         # Scale instances
```

**Monitoring:**
```bash
od list                           # List all processes
od ls                             # Alias for list
od info <name|id>                 # Detailed process info
od monit                          # Real-time TUI dashboard
od status                         # Quick status overview
```

**Logs:**
```bash
od logs [name|id]                 # View logs
od logs -f                        # Follow mode
od logs --grep <pattern>          # Search logs
od logs --since <duration>        # Time-based filter
od logs --json                    # JSON output
od flush [name|id]                # Flush logs
```

**Deploy:**
```bash
od deploy <name> --strategy <s>   # Execute deployment
od rollback <name>                # Rollback
od deploy status <name>           # Deployment status
```

**Configuration:**
```bash
od init                           # Generate config file
od validate                       # Validate config
od env <name>                     # Show environment
od set <name> <key> <value>       # Set environment variable
```

**Secrets:**
```bash
od secret set <key> <value>
od secret get <key>
od secret list
od secret delete <key>
od secret export --format env
od secret rotate <key>
```

**Daemon:**
```bash
od daemon start                   # Start daemon
od daemon stop                    # Stop daemon
od daemon restart                 # Restart daemon
od daemon status                  # Daemon status
od daemon logs                    # Daemon's own logs
```

**System:**
```bash
od startup                        # Generate startup script
od unstartup                      # Remove startup script
od save                           # Save process list
od resurrect                      # Restore saved processes
od update                         # Update OpenDaemon
od doctor                         # Diagnose issues
```

**Plugins:**
```bash
od plugin list                    # List installed plugins
od plugin enable <name>
od plugin disable <name>
od plugin info <name>
```

**Metrics:**
```bash
od metrics [name]                 # Prometheus format
od metrics --json                 # JSON metrics
od top                            # Like Linux top
```

### 6.3 Global Options
```bash
--json        # Output as JSON
--quiet, -q   # Minimal output
--verbose, -v # Debug output
--no-color    # Disable colors
--config, -c  # Config file path
```

## 7. TUI Dashboard

### 7.1 Layout
```
┌─ OpenDaemon v1.0.0 ─ cpu: 23% ─ mem: 2.1G/8G ─ uptime: 14d ─────┐
│                                                                  │
│  Processes (6 online, 0 stopped, 0 errored)                     │
│  ┌─────┬──────────────┬───────┬────┬──────┬───────┬─────────┐   │
│  │  ID │     Name     │  Mode │ ↺  │  CPU │  Mem  │  Uptime │   │
│  ├─────┼──────────────┼───────┼────┼──────┼───────┼─────────┤   │
│  │  0  │ api-gateway  │cluster│ 0  │ 12%  │ 128M  │   14d   │   │
│  │  1  │ worker       │ fork  │ 2  │  3%  │  64M  │    2h   │   │
│  └─────┴──────────────┴───────┴────┴──────┴───────┴─────────┘   │
│                                                                  │
│  ┌─ api-gateway (selected) ─────────────────────────────────┐   │
│  │  CPU ▁▂▃▅▇▅▃▂  Memory ▁▁▂▂▃▃▄▄▄▄▄▄                      │   │
│  │  12% avg | 45% peak   128M / 512M limit                  │   │
│  │                                                           │   │
│  │  Event Loop ▁▁▁▁▂▁▁  Health: ● HTTP 200 (4ms)            │   │
│  │  2.3ms p99              Last check: 5s ago               │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  Recent Logs ────────────────────────────────────────────────   │
│  14:23:01 [api] [INFO] Request processed in 12ms                │
│  14:23:01 [api] [INFO] Request processed in 8ms                 │
│  14:23:02 [api] [WARN] Slow query detected: 450ms               │
│                                                                  │
│  [↑↓] Navigate [Enter] Details [r] Restart [s] Stop [l] Logs    │
└──────────────────────────────────────────────────────────────────┘
```

### 7.2 Keyboard Shortcuts
- `↑/↓` - Navigate processes
- `Enter` - Process details
- `r` - Restart selected
- `s` - Stop selected
- `l` - View logs
- `q` - Quit

## 8. REST API & WebSocket

### 8.1 REST Endpoints
```
GET    /api/v1/processes              # List all processes
GET    /api/v1/processes/:name        # Get process info
POST   /api/v1/processes              # Start new process
PUT    /api/v1/processes/:name/restart # Restart process
PUT    /api/v1/processes/:name/stop   # Stop process
PUT    /api/v1/processes/:name/reload # Reload process
DELETE /api/v1/processes/:name        # Delete process
PUT    /api/v1/processes/:name/scale  # Scale process
GET    /api/v1/processes/:name/logs   # Get logs
GET    /api/v1/processes/:name/metrics # Get metrics
GET    /api/v1/metrics                # Prometheus metrics
GET    /api/v1/daemon/status          # Daemon status
POST   /api/v1/daemon/reload          # Reload config
GET    /api/v1/health                 # API health check
```

### 8.2 WebSocket
```
ws://localhost:9615/ws
```

**Events:**
```javascript
// Subscribe
→ { "subscribe": ["process:*", "log:my-app", "metric:*"] }

// Events
← { "event": "process:started", "data": { ... } }
← { "event": "log:my-app", "data": { ... } }
← { "event": "metric:snapshot", "data": { ... } }
```

## 9. TypeScript SDK

### 9.1 Basic Usage
```typescript
import { OpenDaemon } from 'opendaemon';

const od = new OpenDaemon();
await od.connect();

// Start a process
await od.start({
  name: 'my-app',
  script: './app.js',
  instances: 4,
  maxMemory: '512M',
  env: { NODE_ENV: 'production' },
  healthCheck: {
    type: 'http',
    url: 'http://localhost:3000/health',
    interval: 10000,
    timeout: 5000,
  },
});

// List processes
const processes = await od.list();
console.log(processes);

// Stream logs
const logStream = od.logs('my-app', { follow: true });
logStream.on('data', (entry) => {
  console.log(entry.timestamp, entry.level, entry.message);
});

// Stop process
await od.stop('my-app');
await od.disconnect();
```

### 9.2 Runtime Metrics
```typescript
import { metrics } from 'opendaemon/runtime';

// Counter
const requestCounter = metrics.counter('http_requests_total', 'Total HTTP requests');
requestCounter.inc({ method: 'GET', path: '/api/users' });

// Histogram
const requestDuration = metrics.histogram('http_request_duration_ms', 'Request duration');
requestDuration.observe(42, { status: '200' });

// Gauge
const activeConnections = metrics.gauge('active_connections', 'Active connections');
activeConnections.set(150);
```

## 10. Error Handling

### 10.1 Error Codes
```typescript
enum ErrorCode {
  // System errors
  DAEMON_NOT_RUNNING = 'DAEMON_NOT_RUNNING',
  DAEMON_ALREADY_RUNNING = 'DAEMON_ALREADY_RUNNING',
  SOCKET_ERROR = 'SOCKET_ERROR',
  
  // Process errors
  PROCESS_NOT_FOUND = 'PROCESS_NOT_FOUND',
  PROCESS_ALREADY_EXISTS = 'PROCESS_ALREADY_EXISTS',
  PROCESS_START_FAILED = 'PROCESS_START_FAILED',
  PROCESS_STOP_FAILED = 'PROCESS_STOP_FAILED',
  
  // Configuration errors
  CONFIG_NOT_FOUND = 'CONFIG_NOT_FOUND',
  CONFIG_INVALID = 'CONFIG_INVALID',
  CONFIG_VALIDATION_ERROR = 'CONFIG_VALIDATION_ERROR',
  
  // Plugin errors
  PLUGIN_NOT_FOUND = 'PLUGIN_NOT_FOUND',
  PLUGIN_ALREADY_REGISTERED = 'PLUGIN_ALREADY_REGISTERED',
  PLUGIN_DEPENDENCY_MISSING = 'PLUGIN_DEPENDENCY_MISSING',
  PLUGIN_CONFLICT = 'PLUGIN_CONFLICT',
  
  // Health check errors
  HEALTH_CHECK_FAILED = 'HEALTH_CHECK_FAILED',
  HEALTH_CHECK_TIMEOUT = 'HEALTH_CHECK_TIMEOUT',
  
  // IPC errors
  IPC_TIMEOUT = 'IPC_TIMEOUT',
  IPC_ERROR = 'IPC_ERROR',
  
  // Secret errors
  SECRET_NOT_FOUND = 'SECRET_NOT_FOUND',
  SECRET_DECRYPTION_FAILED = 'SECRET_DECRYPTION_FAILED',
  
  // General errors
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  TIMEOUT = 'TIMEOUT',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}
```

### 10.2 Error Format
```typescript
interface DaemonError extends Error {
  code: ErrorCode;
  context?: Record<string, unknown>;
  cause?: Error;
}
```

## 11. Testing Requirements

### 11.1 Test Coverage
- **Target**: 100% coverage (lines, branches, functions, statements)
- **Unit Tests**: Mock child_process, fs, net, os
- **Integration Tests**: Real process spawning
- **E2E Tests**: Full CLI workflows

### 11.2 Test Structure
```
tests/
├── unit/                    # Unit tests
│   ├── kernel.test.ts
│   ├── event-bus.test.ts
│   ├── state-machine.test.ts
│   ├── plugins/
│   │   ├── process-manager.test.ts
│   │   ├── health-check.test.ts
│   │   └── log-manager.test.ts
│   └── utils/
│       ├── logger.test.ts
│       └── ipc.test.ts
├── integration/             # Integration tests
│   ├── process-lifecycle.test.ts
│   ├── ipc-protocol.test.ts
│   └── plugin-system.test.ts
└── e2e/                     # E2E tests
    ├── cli.test.ts
    └── full-workflow.test.ts
```

### 11.3 Testing Tools
- Vitest for test runner
- Built-in mocking (no external libs)
- Coverage with @vitest/coverage-v8

## 12. Performance Requirements

### 12.1 Resource Usage
- **Daemon Memory**: < 50MB RSS baseline
- **Daemon CPU**: < 1% baseline
- **Startup Time**: < 500ms to accept first command
- **IPC Latency**: < 1ms for local operations
- **Log Throughput**: > 10000 lines/second

### 12.2 Scalability
- **Concurrent Processes**: 1000+ managed processes
- **Metrics Retention**: 1 hour at 5s intervals
- **Log History**: 100MB per process (configurable)

## 13. Security Requirements

### 13.1 Process Isolation
- UID/GID switching support
- Process groups and namespaces
- Resource limits enforcement
- File permission management

### 13.2 Communication Security
- Encrypted IPC (TLS for remote)
- Authentication tokens
- Rate limiting
- Input validation

### 13.3 Secret Security
- AES-256-GCM encryption
- PBKDF2 key derivation
- Secure memory handling
- No secrets in logs or error messages

## 14. Platform Support

### 14.1 Supported Platforms
- **Linux**: Primary target (systemd)
- **macOS**: Full support (launchd)
- **Windows**: Supported (services)
- **FreeBSD**: Community support (rc.d)

### 14.2 Runtime Requirements
- **Node.js**: >= 20.0.0
- **TypeScript**: 5.x (dev only)
- **Architecture**: x64, ARM64

## 15. Documentation

### 15.1 Required Documentation
- API reference (JSDoc generated)
- CLI reference
- Configuration guide
- Plugin development guide
- Migration guide from PM2
- Troubleshooting guide

### 15.2 Documentation Site
- URL: https://opendaemon.dev
- Built with: Custom static generator (zero deps)
- Includes: Examples, tutorials, API docs

## 16. Versioning & Releases

### 16.1 Versioning Scheme
- Semantic Versioning (SemVer)
- Format: MAJOR.MINOR.PATCH

### 16.2 Release Cycle
- **Major**: Breaking changes, ~yearly
- **Minor**: Features, ~monthly
- **Patch**: Bug fixes, as needed

### 16.3 Compatibility
- Plugin API: Stable within major versions
- Config format: Backward compatible within major versions
- CLI: No breaking changes within major versions

## 17. Compliance

### 17.1 Standards
- **License**: MIT
- **Open Source**: OSI approved
- **Security**: Follows Node.js security best practices
- **Privacy**: No telemetry or data collection

### 17.2 Legal
- No AGPL or copyleft dependencies (zero deps anyway)
- No patented algorithms
- Trademark: OpenDaemon™

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2025-02-21 | OpenDaemon Team | Initial specification |
