# OpenDaemon — Next-Generation Process Manager for Node.js

## Project Identity

| Field | Value |
|-------|-------|
| **Name** | OpenDaemon |
| **npm Package** | `opendaemon` |
| **CLI Binary** | `od` (primary), `opendaemon` (alias) |
| **GitHub Organization** | `https://github.com/opendaemon` |
| **GitHub Repository** | `https://github.com/opendaemon/opendaemon` |
| **Documentation Site** | `https://opendaemon.dev` |
| **License** | MIT |
| **Author** | Ersin Koç (OpenDaemon Organization) |
| **Runtime** | Node.js >= 20.0.0 |
| **Language** | TypeScript 5.x (strict mode) |
| **Module Format** | ESM + CJS dual |

---

## Vision & Philosophy

OpenDaemon is not just another process manager — it is a **complete process orchestration platform** for Node.js and beyond. While PM2 was revolutionary in 2013, it was designed in a pre-TypeScript, pre-modern-JavaScript era with architectural decisions that cannot be undone. OpenDaemon is built from the ground up with 2025+ engineering principles:

### Why Not PM2?

PM2 suffers from fundamental architectural limitations:

1. **Legacy JavaScript Codebase** — Written in old-style JavaScript, no native TypeScript, poor type safety
2. **Monolithic Architecture** — All features baked in, impossible to extend without forking
3. **No Plugin System** — Zero extensibility model; users cannot add custom health checks, metrics exporters, or deployment strategies
4. **Primitive IPC** — Uses Node.js built-in IPC which is limited and unreliable for complex orchestration
5. **Basic Health Checks** — Only process alive/dead; no HTTP, TCP, gRPC, script-based, or composite health checks
6. **No Deployment Strategies** — No blue/green, canary, rolling, or A/B deployment support
7. **Weak Log Management** — No structured logging, no real-time streaming, rotation requires separate module
8. **No Process Dependencies** — Cannot define start order or dependency graphs between processes
9. **No Resource Limits** — Cannot set memory/CPU hard limits with automatic action
10. **AGPL Licensed** — Restrictive license for enterprise usage
11. **Paid Monitoring** — Core monitoring features locked behind PM2+ commercial product
12. **Outdated Ecosystem Config** — JavaScript-only config files, no TypeScript, no validation, no IDE support
13. **No WebSocket Real-time** — Dashboard requires polling, no real-time process state streaming
14. **No Secret Management** — Environment variables in plain text in ecosystem files
15. **No Multi-host** — Cannot manage processes across multiple servers from single CLI
16. **No Sandboxing** — Processes share everything, no isolation between applications

### OpenDaemon Principles

1. **Plugin-First Architecture** — Micro-kernel core with everything as a plugin. Users extend every aspect.
2. **TypeScript-Native** — Written in TypeScript, configured in TypeScript, typed SDK, typed plugins.
3. **Zero Dependencies** — Core daemon has ZERO runtime npm dependencies. Everything implemented from scratch.
4. **Observable by Default** — OpenTelemetry-compatible traces, metrics, and logs from day one.
5. **Secure by Default** — Encrypted IPC, secret management, process sandboxing, audit logging.
6. **Developer Experience** — Beautiful CLI, real-time TUI dashboard, comprehensive error messages, IDE integration.
7. **Production-Grade** — Battle-tested patterns: circuit breakers, graceful degradation, self-healing watchdog.
8. **MIT Licensed** — Truly open source, no commercial lock-in, no feature gating.

---

## NON-NEGOTIABLE RULES

### 1. ZERO RUNTIME DEPENDENCIES

```json
{
  "dependencies": {}  // MUST BE EMPTY — NO EXCEPTIONS
}
```

- Implement EVERYTHING from scratch: HTTP server, WebSocket, JSON-RPC, YAML parser, CLI parser, log rotation, cron parser, signal handling, color output, table rendering, process management
- No lodash, no express, no ws, no chalk, no commander, no nothing
- If you think you need a dependency, you don't — implement it
- The entire daemon, CLI, SDK, and TUI must have zero runtime dependencies

**Allowed devDependencies only:**
```json
{
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "@vitest/coverage-v8": "^3.0.0",
    "tsup": "^8.0.0",
    "@types/node": "^22.0.0",
    "prettier": "^3.0.0",
    "eslint": "^9.0.0"
  }
}
```

### 2. 100% TEST COVERAGE

- Every line, branch, function, and statement must be tested
- All tests must pass (100% success rate)
- Use Vitest
- Separate unit, integration, and e2e tests
- Test edge cases, error conditions, race conditions, and timeout scenarios
- Mock child_process, fs, net, and os for unit tests
- Real process spawning for integration tests

### 3. TYPESCRIPT STRICT MODE

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "exactOptionalPropertyTypes": true,
    "noEmit": true,
    "declaration": true,
    "declarationMap": true,
    "moduleResolution": "bundler",
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022"],
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true
  }
}
```

### 4. DEVELOPMENT WORKFLOW

Create these documents FIRST, before any code:

1. **SPECIFICATION.md** — Complete system specification (every feature, every API, every edge case)
2. **IMPLEMENTATION.md** — Architecture decisions, module breakdown, data flow, IPC protocol design
3. **TASKS.md** — Ordered task list with dependencies, complexity estimates, test requirements

Only after all three documents are complete, implement code following TASKS.md sequentially.

### 5. CODE QUALITY

- JSDoc on every public API with `@example`
- No `any` type — use `unknown` and narrow
- Maximum function length: 50 lines
- Maximum file length: 400 lines
- Single responsibility per function and module
- Prefer composition over inheritance
- Immutable data patterns where possible
- All async code properly awaited and error-handled

---

## HIGH-LEVEL ARCHITECTURE

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          User Layer                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │   CLI    │  │   SDK    │  │ REST API │  │ WebSocket│  │   TUI    │ │
│  │  (od)    │  │(program.)|  │  Client  │  │  Client  │  │Dashboard │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘ │
│       │              │              │              │              │       │
├───────┴──────────────┴──────────────┴──────────────┴──────────────┴───────┤
│                      IPC Layer (Unix Domain Socket)                       │
│              JSON-RPC 2.0 Protocol + Binary Frames (logs)                │
├──────────────────────────────────────────────────────────────────────────┤
│                         Daemon Core (Micro-Kernel)                       │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                     Plugin Registry & Lifecycle                     │ │
│  │        register() · unregister() · enable() · disable()           │ │
│  ├─────────┬──────────┬──────────┬──────────┬──────────┬─────────────┤ │
│  │ Process │  Health  │   Log    │ Metrics  │  Deploy  │  Scheduler  │ │
│  │ Manager │  Check   │  Manager │ Collector│ Strategy │   (Cron)    │ │
│  │ Plugin  │  Plugin  │  Plugin  │  Plugin  │  Plugin  │   Plugin    │ │
│  ├─────────┼──────────┼──────────┼──────────┼──────────┼─────────────┤ │
│  │ Cluster │ Resource │  Secret  │  Audit   │  Watch   │  Notify     │ │
│  │ Manager │  Limiter │  Manager │  Logger  │  Mode    │  Plugin     │ │
│  │ Plugin  │  Plugin  │  Plugin  │  Plugin  │  Plugin  │             │ │
│  ├─────────┴──────────┴──────────┴──────────┴──────────┴─────────────┤ │
│  │                        Event Bus (Pub/Sub)                         │ │
│  ├────────────────────────────────────────────────────────────────────┤ │
│  │                     Micro Kernel Core                              │ │
│  │  Config · Lifecycle · Error Boundary · State Machine · Watchdog   │ │
│  └────────────────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────────────┤
│                         Operating System Layer                           │
│  child_process · signals · fs · net · os · cluster                      │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## MICRO-KERNEL ARCHITECTURE

### Kernel Responsibilities (Minimal — ~2KB)

The kernel does ONLY:
- Plugin registration, lifecycle management, and dependency resolution
- Event bus for inter-plugin pub/sub communication
- Error boundary with circuit breaker per plugin
- Configuration loading and validation
- State machine for daemon lifecycle (starting → ready → running → stopping → stopped)
- Watchdog timer for self-health monitoring

### Plugin Interface

```typescript
/**
 * Base plugin interface for OpenDaemon.
 * Every feature of OpenDaemon is implemented as a plugin.
 *
 * @typeParam TConfig - Plugin-specific configuration type
 */
export interface Plugin<TConfig = unknown> {
  /** Unique plugin identifier (kebab-case, e.g., "process-manager") */
  readonly name: string;

  /** Semantic version (e.g., "1.0.0") */
  readonly version: string;

  /** Human-readable description */
  readonly description: string;

  /** Plugin priority (lower = loaded first, default: 100) */
  readonly priority?: number;

  /** Plugin dependencies (other plugin names that must be loaded first) */
  readonly dependencies?: readonly string[];

  /** Plugin conflicts (other plugin names that cannot coexist) */
  readonly conflicts?: readonly string[];

  /** Default configuration for this plugin */
  readonly defaultConfig?: TConfig;

  /** JSON Schema for config validation (implemented from scratch, no ajv) */
  readonly configSchema?: JsonSchema;

  /**
   * Called when the plugin is registered with the kernel.
   * Use this to register event handlers, extend the API, etc.
   */
  install(context: PluginContext): void | Promise<void>;

  /**
   * Called after ALL plugins are installed and daemon is starting.
   * Use this for initialization that depends on other plugins.
   */
  onStart?(context: PluginContext): void | Promise<void>;

  /**
   * Called when daemon is ready to accept commands.
   */
  onReady?(context: PluginContext): void | Promise<void>;

  /**
   * Called during graceful shutdown.
   * Must complete within the configured shutdown timeout.
   */
  onStop?(context: PluginContext): void | Promise<void>;

  /**
   * Called when an error occurs within this plugin's scope.
   */
  onError?(error: DaemonError, context: PluginContext): void;

  /**
   * Health check for this plugin. Called periodically by watchdog.
   * Return true if healthy, false if unhealthy.
   */
  healthCheck?(context: PluginContext): boolean | Promise<boolean>;
}
```

### Plugin Context

```typescript
/**
 * Context object provided to every plugin.
 * This is the plugin's window into the kernel and other plugins.
 */
export interface PluginContext {
  /** Kernel configuration (read-only) */
  readonly config: DaemonConfig;

  /** Plugin's own configuration (read-only) */
  readonly pluginConfig: unknown;

  /** Event bus for pub/sub */
  readonly events: EventBus;

  /** Structured logger scoped to this plugin */
  readonly logger: Logger;

  /** Access to the state store */
  readonly store: StateStore;

  /** Register RPC methods that CLI/SDK can call */
  registerMethod(name: string, handler: RpcHandler): void;

  /** Register a hook into another plugin's lifecycle */
  registerHook(hookName: string, handler: HookHandler): void;

  /** Get a reference to another plugin (must be declared as dependency) */
  getPlugin<T extends Plugin>(name: string): T | undefined;

  /** Expose metrics for this plugin */
  registerMetric(metric: MetricDefinition): void;
}
```

### Event Bus

```typescript
/**
 * Typed event bus for inter-plugin communication.
 * Supports wildcards, namespaces, and async handlers.
 */
export interface EventBus {
  /**
   * Subscribe to an event.
   * @example
   * events.on('process:started', (data) => { ... });
   * events.on('process:*', (data) => { ... }); // wildcard
   */
  on(event: string, handler: EventHandler): Unsubscribe;

  /** Subscribe once */
  once(event: string, handler: EventHandler): Unsubscribe;

  /** Emit event to all subscribers */
  emit(event: string, data?: unknown): void;

  /** Emit and wait for all async handlers to complete */
  emitAsync(event: string, data?: unknown): Promise<void>;

  /** Remove all listeners for an event */
  off(event: string, handler?: EventHandler): void;

  /** Get listener count */
  listenerCount(event: string): number;
}
```

---

## CORE FEATURES

### 1. Process Management (Core Plugin: `process-manager`)

The heart of OpenDaemon. Manages the full lifecycle of processes.

**Process States (State Machine):**
```
                    ┌─────────┐
         ┌─────────│ created │─────────┐
         │         └────┬────┘         │
         │              │ start()      │ remove()
         │              ▼              │
         │         ┌─────────┐         │
    stop()│    ┌───│ starting│───┐     │
         │    │   └─────────┘   │     │
         │    │ ready            │ error│
         │    ▼                  ▼     │
         │ ┌──────┐        ┌────────┐  │
         ├─│online│        │errored │──┤
         │ └──┬───┘        └───┬────┘  │
         │    │                │       │
         │    │ crash/exit     │ retry │
         │    ▼                │       │
         │ ┌──────────┐       │       │
         ├─│ stopping │◄──────┘       │
         │ └────┬─────┘               │
         │      │                     │
         │      ▼                     │
         │ ┌──────────┐               │
         └►│ stopped  │◄──────────────┘
           └──────────┘
```

**Features:**
- Fork mode (single process) and Cluster mode (multiple instances)
- Graceful start with ready signal (`process.send('ready')`) or timeout
- Graceful stop with configurable SIGTERM → SIGKILL escalation
- Automatic restart with configurable strategies: always, on-failure, unless-stopped, never
- Restart backoff: fixed, linear, exponential, with jitter
- Max restart count with cooldown period
- Max memory restart (auto-restart when memory exceeds threshold)
- PID file management
- Process metadata (name, version, started_at, restart_count, etc.)
- Process groups (namespaces) for batch operations
- Environment variable management per process
- Working directory configuration
- Custom interpreter support (node, bun, deno, python, ruby, any binary)
- Process affinity (CPU pinning)
- Nice value / priority setting
- UID/GID switching (run as different user)
- umask configuration

**API:**
```typescript
// CLI
od start app.js
od start app.js --name my-app --instances 4 --max-memory 512M
od start ecosystem.config.ts
od stop my-app
od restart my-app --strategy rolling
od reload my-app          // Zero-downtime reload (cluster mode)
od delete my-app
od list                   // Beautiful table output
od info my-app            // Detailed process info
od monit                  // Real-time TUI dashboard

// SDK
import { OpenDaemon } from 'opendaemon';

const od = new OpenDaemon();
await od.connect();

await od.start({
  name: 'my-app',
  script: './app.js',
  instances: 4,
  maxMemory: '512M',
  env: { NODE_ENV: 'production' },
  healthCheck: {
    type: 'http',
    url: 'http://localhost:3000/health',
    interval: 10_000,
    timeout: 5_000,
  },
  deploy: {
    strategy: 'rolling',
    maxUnavailable: 1,
  },
});

const processes = await od.list();
await od.stop('my-app');
await od.disconnect();
```

### 2. Health Check System (Core Plugin: `health-check`)

Multi-strategy health checking that PM2 completely lacks.

**Health Check Types:**

| Type | Description | Use Case |
|------|-------------|----------|
| `process` | Check if process is alive (default) | Basic daemon |
| `http` | HTTP GET returns 2xx | Web servers |
| `https` | HTTPS with optional cert verification | Secure web servers |
| `tcp` | TCP connection succeeds | Database proxies, TCP servers |
| `script` | Custom script exits with 0 | Complex health logic |
| `grpc` | gRPC health check protocol | Microservices |
| `command` | Execute shell command | Infrastructure checks |
| `composite` | Multiple checks with AND/OR logic | Multi-dependency apps |
| `memory` | Memory below threshold | Memory-sensitive apps |
| `cpu` | CPU below threshold | CPU-sensitive apps |
| `event-loop` | Event loop latency below threshold | Latency-sensitive apps |

**Configuration:**
```typescript
interface HealthCheckConfig {
  /** Health check type */
  type: HealthCheckType;

  /** Check interval in milliseconds (default: 30000) */
  interval?: number;

  /** Timeout per check in milliseconds (default: 5000) */
  timeout?: number;

  /** Number of consecutive failures before marking unhealthy (default: 3) */
  failureThreshold?: number;

  /** Number of consecutive successes before marking healthy (default: 1) */
  successThreshold?: number;

  /** Initial delay before first check in milliseconds (default: 0) */
  initialDelay?: number;

  /** Action on unhealthy: 'restart' | 'stop' | 'notify' | 'none' (default: 'restart') */
  action?: HealthCheckAction;

  /** Type-specific configuration */
  // For HTTP/HTTPS:
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  expectedStatus?: number | number[];
  expectedBody?: string | RegExp;

  // For TCP:
  host?: string;
  port?: number;

  // For Script/Command:
  command?: string;
  args?: string[];

  // For Composite:
  checks?: HealthCheckConfig[];
  operator?: 'and' | 'or';
}
```

**Events:**
```
health:check:start    — Check initiated
health:check:pass     — Check passed
health:check:fail     — Check failed
health:status:healthy — Process transitioned to healthy
health:status:unhealthy — Process transitioned to unhealthy
health:action:restart — Restart triggered by health check
health:action:stop    — Stop triggered by health check
```

### 3. Log Management (Core Plugin: `log-manager`)

Enterprise-grade structured logging system.

**Features:**
- Structured JSON logging (timestamp, level, pid, process name, message, metadata)
- Real-time log streaming via WebSocket and IPC
- Automatic log rotation by size, time, or both
- Log compression (gzip) for rotated files
- Per-process log files (stdout + stderr separate)
- Combined log file option
- Log levels: trace, debug, info, warn, error, fatal
- Log filtering by level, process, pattern (regex)
- Log tailing with follow mode (`od logs my-app -f`)
- Log search across all processes (`od logs --grep "error" --since 1h`)
- Log retention policy (auto-delete after N days or N size)
- Custom log formatters via plugin
- Timestamp formats: ISO8601, Unix, custom
- Colorized output for terminal (auto-detect TTY)
- Log buffering with flush strategies (immediate, batch, interval)
- Crash log preservation (last N lines kept even after rotation)

**API:**
```typescript
// CLI
od logs                          // All process logs, interleaved
od logs my-app                   // Specific process
od logs my-app -f                // Follow mode (real-time)
od logs my-app --lines 100       // Last 100 lines
od logs --grep "ERROR" --since 2h // Search
od logs --json                   // Raw JSON output
od flush                         // Flush all logs
od flush my-app                  // Flush specific process

// SDK
const logStream = od.logs('my-app', {
  follow: true,
  filter: { level: 'error' },
});

logStream.on('data', (entry) => {
  console.log(entry.timestamp, entry.level, entry.message);
});
```

**Log Entry Format:**
```typescript
interface LogEntry {
  /** ISO8601 timestamp */
  timestamp: string;
  /** Log level */
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  /** Process ID */
  pid: number;
  /** Process name */
  processName: string;
  /** Process instance ID (for cluster mode) */
  instanceId?: number;
  /** Log message */
  message: string;
  /** Source: stdout or stderr */
  source: 'stdout' | 'stderr';
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}
```

### 4. Metrics & Monitoring (Core Plugin: `metrics-collector`)

Built-in observability without paid add-ons (unlike PM2+).

**Collected Metrics (per process):**
- CPU usage (%, user time, system time)
- Memory usage (RSS, heap total, heap used, external, array buffers)
- Event loop latency (p50, p95, p99, max)
- Event loop utilization
- Active handles and requests
- GC statistics (if available)
- Restart count
- Uptime
- Custom metrics (via plugin API)

**System Metrics:**
- Total CPU usage (per core and aggregate)
- Memory (total, free, used, swap)
- Load average (1m, 5m, 15m)
- Disk usage (per mount point)
- Network I/O (bytes in/out per interface)
- Open file descriptors

**Export Formats:**
- Prometheus (text exposition format at /metrics endpoint)
- JSON (via REST API)
- OpenTelemetry (OTLP gRPC/HTTP)
- StatsD (UDP push)
- Custom exporter (via plugin)

**API:**
```typescript
// CLI
od monit                         // Real-time TUI dashboard
od status                        // Current metrics snapshot
od status my-app --json          // JSON output
od metrics                       // Prometheus-format output

// SDK
const metrics = await od.metrics('my-app');
// { cpu: 12.5, memory: { rss: 52428800, heapUsed: 31457280 }, ... }

// Custom metrics in your app
import { metrics } from 'opendaemon/runtime';
const requestCounter = metrics.counter('http_requests_total', 'Total HTTP requests');
requestCounter.inc({ method: 'GET', path: '/api/users' });
```

### 5. Cluster Management (Core Plugin: `cluster-manager`)

Advanced multi-instance management with load balancing.

**Features:**
- Automatic instance count (CPU count detection)
- Manual instance count configuration
- Zero-downtime reload (graceful worker rotation)
- Sticky sessions (for WebSocket applications)
- Custom load balancing strategies: round-robin (default), least-connections, IP-hash, random, weighted
- Per-instance health checks
- Instance-level metrics
- Auto-scale: scale up/down based on CPU, memory, request rate, or custom metrics
- Scale limits (min/max instances)
- Graceful scale-down (drain connections before removing instance)

**Auto-Scaling Configuration:**
```typescript
interface AutoScaleConfig {
  /** Enable auto-scaling */
  enabled: boolean;
  /** Minimum instances */
  min: number;
  /** Maximum instances */
  max: number;
  /** Scale-up rules */
  scaleUp: {
    metric: 'cpu' | 'memory' | 'eventLoopLatency' | 'custom';
    threshold: number;
    /** Duration above threshold before scaling (ms) */
    duration: number;
    /** Number of instances to add per scale event */
    step: number;
    /** Cooldown between scale events (ms) */
    cooldown: number;
  };
  /** Scale-down rules */
  scaleDown: {
    metric: 'cpu' | 'memory' | 'eventLoopLatency' | 'custom';
    threshold: number;
    duration: number;
    step: number;
    cooldown: number;
  };
}
```

### 6. Deployment Strategies (Core Plugin: `deploy-strategy`)

Zero-downtime deployment patterns that PM2 doesn't have.

**Strategies:**

| Strategy | Description | Best For |
|----------|-------------|----------|
| `rolling` | Replace instances one-by-one | Most applications |
| `blue-green` | Spin up new set, switch traffic, tear down old | Critical apps |
| `canary` | Route percentage of traffic to new version | Risk-sensitive deploys |
| `recreate` | Stop all, then start all (fast but has downtime) | Stateful apps |
| `a-b` | Route based on header/cookie to new version | Feature testing |

**Rolling Deploy Flow:**
```
Instance 1: v1 ──stop──► v2 ──ready──► serving
Instance 2: v1 ────────── v1 ──stop──► v2 ──ready──► serving
Instance 3: v1 ────────── v1 ────────── v1 ──stop──► v2 ──ready──► serving
             │            │              │              │
             ▼            ▼              ▼              ▼
            100%         66%            33%            0%  ← v1 traffic
              0%         33%            66%           100% ← v2 traffic
```

**Configuration:**
```typescript
interface DeployConfig {
  strategy: 'rolling' | 'blue-green' | 'canary' | 'recreate' | 'a-b';
  
  // Rolling
  maxUnavailable?: number;      // Max instances down during deploy
  maxSurge?: number;            // Max extra instances during deploy
  
  // Canary
  canaryPercent?: number;       // Initial traffic % to canary (default: 10)
  canarySteps?: number[];       // Traffic ramp: [10, 25, 50, 100]
  canaryAnalysis?: {            // Auto-promote/rollback based on metrics
    metrics: string[];
    threshold: number;
    duration: number;
  };
  
  // Blue-Green
  switchTimeout?: number;       // Time to keep old version alive after switch
  
  // All strategies
  healthCheck?: HealthCheckConfig; // Health check before considering ready
  rollbackOnFailure?: boolean;     // Auto-rollback on deploy failure
  timeout?: number;                // Max deploy duration before rollback
}
```

### 7. Configuration System (Core Plugin: `config-manager`)

TypeScript-first configuration with validation and IDE support.

**Config File Formats (priority order):**
1. `opendaemon.config.ts` (TypeScript — recommended)
2. `opendaemon.config.js` (JavaScript ESM)
3. `opendaemon.config.cjs` (JavaScript CJS)
4. `opendaemon.config.json` (JSON)
5. `opendaemon.config.yaml` (YAML — parsed from scratch, no external lib)
6. `.opendaemonrc` (JSON)
7. `package.json` → `"opendaemon"` field

**TypeScript Config Example:**
```typescript
// opendaemon.config.ts
import { defineConfig } from 'opendaemon';

export default defineConfig({
  // Daemon settings
  daemon: {
    pidFile: '/var/run/opendaemon.pid',
    logDir: '/var/log/opendaemon',
    socketPath: '/var/run/opendaemon.sock',
    shutdownTimeout: 10_000,
  },

  // Global defaults for all apps
  defaults: {
    instances: 'max',
    maxMemory: '512M',
    restartStrategy: 'exponential',
    healthCheck: {
      type: 'http',
      interval: 30_000,
    },
  },

  // Application definitions
  apps: [
    {
      name: 'api-gateway',
      script: './dist/gateway.js',
      instances: 4,
      port: 3000,
      env: {
        NODE_ENV: 'production',
        DATABASE_URL: { secret: 'db-url' }, // Reference to secret store
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
      cron: '*/5 * * * *',        // Run every 5 minutes
      autoRestart: false,           // Don't restart after cron execution
    },
    {
      name: 'database-proxy',
      script: './dist/proxy.js',
      instances: 1,
      healthCheck: {
        type: 'tcp',
        port: 5433,
      },
    },
  ],

  // Plugin configuration
  plugins: {
    'metrics-collector': {
      prometheus: { enabled: true, port: 9090 },
      opentelemetry: { enabled: true, endpoint: 'http://otel-collector:4318' },
    },
    'notification': {
      channels: [
        { type: 'webhook', url: 'https://hooks.slack.com/...' },
        { type: 'email', smtp: { host: 'smtp.example.com' } },
      ],
    },
  },
});
```

**`defineConfig` provides full TypeScript IntelliSense and validation at author-time.**

### 8. IPC & Communication Protocol

Custom high-performance IPC over Unix Domain Sockets.

**Protocol: JSON-RPC 2.0 over UDS**

```
┌─────────────────────────────────────────────────┐
│  Frame Format                                    │
│  ┌──────┬──────┬──────────────────────────────┐ │
│  │ Type │ Len  │         Payload              │ │
│  │ 1B   │ 4B   │    Variable (JSON/Binary)    │ │
│  └──────┴──────┴──────────────────────────────┘ │
│                                                  │
│  Type: 0x01 = JSON-RPC Request                  │
│        0x02 = JSON-RPC Response                 │
│        0x03 = JSON-RPC Notification (no reply)  │
│        0x04 = Binary (log stream)               │
│        0x05 = Heartbeat                         │
│        0x06 = Auth Challenge                    │
│        0x07 = Auth Response                     │
└─────────────────────────────────────────────────┘
```

**Security:**
- Socket file permissions: 0o660 (owner + group only)
- Optional authentication token (stored in `~/.opendaemon/auth-token`)
- Rate limiting per client connection
- Max message size limit (default: 10MB)

**Built-in RPC Methods:**

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

### 9. CLI Interface

Beautiful, fast, informative CLI with the binary name `od`.

**Command Structure:**
```
od <command> [subcommand] [options] [args]
```

**Commands:**

```bash
# Process Management
od start <script|config>          # Start process(es)
od stop <name|id|all>             # Stop process(es)
od restart <name|id|all>          # Restart process(es)
od reload <name|id|all>           # Zero-downtime reload
od delete <name|id|all>           # Remove process(es)
od scale <name> <+N|-N|N>         # Scale instances

# Monitoring
od list                           # List all processes (beautiful table)
od ls                             # Alias for list
od info <name|id>                 # Detailed process information
od monit                          # Real-time TUI dashboard
od status                         # Quick status overview

# Logs
od logs [name|id]                 # View logs
od logs -f                        # Follow mode
od logs --grep <pattern>          # Search logs
od logs --since <duration>        # Time-based filter
od logs --json                    # JSON output
od flush [name|id]                # Flush logs

# Deploy
od deploy <name> --strategy <s>   # Execute deployment
od rollback <name>                # Rollback to previous version
od deploy status <name>           # Deployment status

# Configuration
od init                           # Generate config file
od validate                       # Validate config
od env <name>                     # Show environment variables
od set <name> <key> <value>       # Set environment variable

# Secrets
od secret set <key> <value>       # Store secret
od secret get <key>               # Retrieve secret
od secret list                    # List secret keys
od secret delete <key>            # Delete secret

# Daemon
od daemon start                   # Start daemon
od daemon stop                    # Stop daemon
od daemon restart                 # Restart daemon
od daemon status                  # Daemon status
od daemon logs                    # Daemon's own logs

# System
od startup                        # Generate startup script
od unstartup                      # Remove startup script
od save                           # Save process list for resurrection
od resurrect                      # Restore saved process list
od update                         # Update OpenDaemon
od doctor                         # Diagnose common issues

# Plugins
od plugin list                    # List installed plugins
od plugin enable <name>           # Enable plugin
od plugin disable <name>          # Disable plugin
od plugin info <name>             # Plugin information

# Metrics
od metrics [name]                 # Prometheus-format metrics
od metrics --json                 # JSON metrics
od top                            # Like Linux top, for processes

# Help
od help [command]                 # Show help
od --version                      # Show version
```

**Output Design:**
- Colorized output (auto-detect TTY, respect NO_COLOR)
- Spinner animations for async operations
- Progress bars for deployments
- Beautiful table formatting (like pm2 list but better)
- JSON output mode for scripting (`--json` flag on every command)
- Quiet mode (`--quiet` or `-q`) for scripts
- Verbose mode (`--verbose` or `-v`) for debugging

### 10. TUI Dashboard (Core Plugin: `tui-dashboard`)

Interactive terminal dashboard (like `htop` for your processes).

```
┌─ OpenDaemon v1.0.0 ──── cpu: 23% ──── mem: 2.1G/8G ──── uptime: 14d 3h ─┐
│                                                                             │
│  Processes (6 online, 0 stopped, 0 errored)                                │
│  ┌─────┬──────────────┬───────┬────┬──────┬───────┬─────────┬────────────┐ │
│  │  ID │     Name     │  Mode │ ↺  │  CPU │  Mem  │  Uptime │   Status   │ │
│  ├─────┼──────────────┼───────┼────┼──────┼───────┼─────────┼────────────┤ │
│  │  0  │ api-gateway  │ cluster/4│ 0│ 12%  │ 128M  │   14d   │  ● online  │ │
│  │  1  │ worker       │ fork  │ 2 │  3%  │  64M  │    2h   │  ● online  │ │
│  │  2  │ scheduler    │ fork  │ 0 │  1%  │  32M  │   14d   │  ● online  │ │
│  │  3  │ db-proxy     │ fork  │ 0 │  0%  │  16M  │   14d   │  ● online  │ │
│  └─────┴──────────────┴───────┴────┴──────┴───────┴─────────┴────────────┘ │
│                                                                             │
│  ┌─ api-gateway (selected) ────────────────────────────────────────────────┐│
│  │  CPU ▁▂▃▅▇▅▃▂▁▂▃▅▃▂▁▂▃▅▇█▇▅▃▂  Memory ▁▁▂▂▃▃▃▃▄▄▄▄▄▄▃▃▃▃▃▃▃▃▂▂▂▁▁ ││
│  │  12% avg | 45% peak              128M / 512M limit                     ││
│  │                                                                         ││
│  │  Event Loop ▁▁▁▁▂▁▁▁▁▁▂▃▂▁▁▁▁  Health: ● HTTP 200 (4ms)            ││
│  │  2.3ms p99                       Last check: 5s ago                    ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                             │
│  Recent Logs ─────────────────────────────────────────────────────────────  │
│  14:23:01 [api] [INFO]  Request processed in 12ms                          │
│  14:23:01 [api] [INFO]  Request processed in 8ms                           │
│  14:23:02 [api] [WARN]  Slow query detected: 450ms                        │
│  14:23:03 [api] [INFO]  Health check passed                               │
│                                                                             │
│  [↑↓] Navigate  [Enter] Details  [r] Restart  [s] Stop  [l] Logs  [q] Quit│
└─────────────────────────────────────────────────────────────────────────────┘
```

**Features:**
- Real-time CPU/Memory sparkline graphs
- Process list with sorting and filtering
- Per-process detail view with metrics history
- Live log view with scrolling
- Keyboard shortcuts for all actions
- Mouse support (optional)
- Responsive layout (adapts to terminal size)
- Color themes (dark/light/auto)
- Built with raw ANSI escape sequences (no blessed, no ink — zero deps)

### 11. REST API & WebSocket (Optional Plugin: `api-server`)

HTTP API for external integrations and web dashboards.

**REST API:**
```
GET    /api/v1/processes                    — List all processes
GET    /api/v1/processes/:name              — Get process info
POST   /api/v1/processes                    — Start new process
PUT    /api/v1/processes/:name/restart      — Restart process
PUT    /api/v1/processes/:name/stop         — Stop process
PUT    /api/v1/processes/:name/reload       — Reload process
DELETE /api/v1/processes/:name              — Delete process
PUT    /api/v1/processes/:name/scale        — Scale process
GET    /api/v1/processes/:name/logs         — Get logs
GET    /api/v1/processes/:name/metrics      — Get metrics
GET    /api/v1/metrics                      — Prometheus metrics
GET    /api/v1/daemon/status                — Daemon status
POST   /api/v1/daemon/reload                — Reload config
GET    /api/v1/health                       — API health check
```

**WebSocket:**
```
ws://localhost:9615/ws

Events:
→ { "subscribe": ["process:*", "log:my-app", "metric:*"] }
← { "event": "process:started", "data": { ... } }
← { "event": "log:my-app", "data": { ... } }
← { "event": "metric:snapshot", "data": { ... } }
```

**Security:**
- Bearer token authentication
- CORS configuration
- Rate limiting
- Request size limits
- HTTPS support with custom certificates

**NOTE: The HTTP server, WebSocket server, and all routing must be implemented FROM SCRATCH using Node.js `http` and `net` modules. NO express, fastify, koa, ws, or any other library.**

### 12. Secret Management (Optional Plugin: `secret-manager`)

Encrypted storage for sensitive environment variables.

**Features:**
- AES-256-GCM encryption at rest
- Master key derived from machine-id + user password (PBKDF2)
- Secret store file: `~/.opendaemon/secrets.enc`
- Environment variable injection at process start (never written to disk unencrypted)
- Secret rotation without process restart
- Secret references in config: `{ secret: 'key-name' }`
- Integration with external vaults via plugin (HashiCorp Vault, AWS SSM, etc.)

**API:**
```typescript
// CLI
od secret set DATABASE_URL "postgres://user:pass@host/db"
od secret get DATABASE_URL
od secret list
od secret delete DATABASE_URL
od secret export --format env       // Export as .env (for development only)
od secret rotate DATABASE_URL       // Rotate + restart dependent processes

// Config
{
  env: {
    DATABASE_URL: { secret: 'DATABASE_URL' },
    API_KEY: { secret: 'api-key', version: 2 },
  }
}
```

### 13. Scheduler / Cron (Optional Plugin: `scheduler`)

Built-in cron scheduling for periodic tasks.

**Features:**
- Standard cron syntax (minute, hour, day, month, weekday)
- Extended cron syntax (seconds field, @yearly, @monthly, @weekly, @daily, @hourly)
- Timezone support
- Overlap prevention (skip if previous run still active)
- Cron expression parsing implemented from scratch
- Execution history tracking
- Next execution time calculation
- On-failure actions (retry, notify, skip)

**Configuration:**
```typescript
{
  name: 'cleanup-job',
  script: './jobs/cleanup.js',
  cron: '0 2 * * *',          // Every day at 2 AM
  cronTimezone: 'Europe/Istanbul',
  cronOverlap: false,          // Skip if still running
  cronRetry: 3,                // Retry 3 times on failure
  autoRestart: false,          // Don't restart after cron exit
}
```

### 14. Watch Mode (Optional Plugin: `watch-mode`)

File watching for development with intelligent restart.

**Features:**
- Recursive directory watching using `fs.watch` (no chokidar dependency)
- Configurable file patterns (glob-like matching, implemented from scratch)
- Ignore patterns (node_modules, .git, etc.)
- Debounce delay (prevent multiple restarts on batch saves)
- Graceful restart on change
- Clear console option on restart
- File change notification in log

**Configuration:**
```typescript
{
  name: 'dev-server',
  script: './src/server.ts',
  watch: true,
  watchPaths: ['./src'],
  watchIgnore: ['node_modules', '.git', 'dist', '*.test.ts'],
  watchDelay: 1000,            // 1s debounce
  watchClearConsole: true,
}
```

### 15. Notification System (Optional Plugin: `notification`)

Alert on critical events.

**Channels:**
- Webhook (generic HTTP POST with JSON payload)
- Slack (via webhook URL)
- Discord (via webhook URL)
- Email (SMTP — implemented from scratch, basic SMTP client)
- Custom channel (via plugin)

**Events that trigger notifications:**
- Process crash
- Process unhealthy (health check failure)
- Max memory exceeded
- High CPU usage sustained
- Deployment started/completed/failed
- Daemon started/stopped
- Auto-scale triggered

**Configuration:**
```typescript
plugins: {
  notification: {
    channels: [
      {
        type: 'webhook',
        url: 'https://hooks.slack.com/services/...',
        events: ['process:crash', 'process:unhealthy', 'deploy:failed'],
      },
      {
        type: 'email',
        smtp: { host: 'smtp.gmail.com', port: 587, user: '...', pass: { secret: 'smtp-pass' } },
        to: ['ops@example.com'],
        events: ['process:crash'],
      },
    ],
    // Global settings
    throttle: 60_000,            // Max 1 notification per event type per minute
    batchWindow: 5_000,          // Batch events within 5s window
  },
}
```

### 16. Process Dependencies (Core Plugin: `dependency-resolver`)

Define start order and dependency graphs between processes.

**Features:**
- DAG-based dependency resolution
- Parallel start of independent processes
- Health-check-based readiness (wait for dependency to be healthy before starting dependent)
- Circular dependency detection with clear error message
- Cascade stop (stop dependents before stopping dependency)
- Cascade restart option
- Dependency graph visualization in CLI

**Configuration:**
```typescript
apps: [
  {
    name: 'database',
    script: './db-proxy.js',
    healthCheck: { type: 'tcp', port: 5432 },
  },
  {
    name: 'cache',
    script: './cache-proxy.js',
    healthCheck: { type: 'tcp', port: 6379 },
  },
  {
    name: 'api',
    script: './api.js',
    dependencies: ['database', 'cache'],  // Wait for both before starting
  },
  {
    name: 'worker',
    script: './worker.js',
    dependencies: ['database'],
  },
  {
    name: 'gateway',
    script: './gateway.js',
    dependencies: ['api'],
  },
]
```

**Dependency Graph:**
```
database ──┬──► api ──► gateway
cache ─────┘     │
database ──────► worker
```

### 17. Resource Limiter (Optional Plugin: `resource-limiter`)

Enforce resource limits on processes.

**Limits:**
- Max memory (RSS) — action: warn, restart, stop
- Max CPU (%) — sustained for duration — action: warn, throttle, restart, stop
- Max open file descriptors
- Max child processes
- Max event loop latency — action: warn, restart
- Network bandwidth (if measurable)

**Configuration:**
```typescript
{
  name: 'api',
  limits: {
    memory: {
      max: '512M',
      action: 'restart',
      grace: 30_000,         // Grace period before action
    },
    cpu: {
      max: 90,                // 90%
      duration: 60_000,       // Sustained for 1 minute
      action: 'warn',
    },
    eventLoopLatency: {
      max: 100,               // 100ms
      action: 'warn',
    },
  },
}
```

### 18. Audit Logger (Optional Plugin: `audit-logger`)

Track all operations for compliance and debugging.

**Logged Events:**
- All RPC method calls (who, when, what, result)
- Configuration changes
- Process lifecycle events
- Secret access (not values)
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

### 19. Startup Script Generator (Core Plugin: `startup-manager`)

Generate platform-specific startup scripts.

**Supported Init Systems:**
- systemd (Linux)
- launchd (macOS)
- upstart (Legacy Linux)
- OpenRC (Alpine Linux)
- Windows Service (via NSSM pattern)
- rc.d (FreeBSD)

**Auto-detection of init system with manual override option.**

---

## PROJECT STRUCTURE

```
opendaemon/
├── .github/
│   └── workflows/
│       ├── ci.yml                    # Test + Lint + Build
│       ├── release.yml               # npm publish + GitHub Release
│       └── docs.yml                  # Documentation site deploy
├── packages/                          # Monorepo structure
│   ├── core/                          # Daemon core (micro-kernel)
│   │   ├── src/
│   │   │   ├── index.ts              # Main entry
│   │   │   ├── kernel.ts             # Micro kernel
│   │   │   ├── event-bus.ts          # Event bus implementation
│   │   │   ├── state-machine.ts      # Process state machine
│   │   │   ├── state-store.ts        # In-memory state store
│   │   │   ├── config/
│   │   │   │   ├── loader.ts         # Config file discovery & loading
│   │   │   │   ├── validator.ts      # Config validation (JSON Schema, from scratch)
│   │   │   │   ├── schema.ts         # Config schema definition
│   │   │   │   └── types.ts          # Config types
│   │   │   ├── ipc/
│   │   │   │   ├── server.ts         # UDS server
│   │   │   │   ├── client.ts         # UDS client
│   │   │   │   ├── protocol.ts       # Frame encoding/decoding
│   │   │   │   └── rpc.ts            # JSON-RPC 2.0 implementation
│   │   │   ├── plugins/
│   │   │   │   ├── registry.ts       # Plugin registration & lifecycle
│   │   │   │   ├── context.ts        # Plugin context factory
│   │   │   │   └── types.ts          # Plugin interfaces
│   │   │   ├── errors/
│   │   │   │   ├── base.ts           # Base error classes
│   │   │   │   ├── codes.ts          # Error code constants
│   │   │   │   └── index.ts          # Error exports
│   │   │   ├── utils/
│   │   │   │   ├── logger.ts         # Internal logger
│   │   │   │   ├── fs.ts             # File system helpers
│   │   │   │   ├── parse-bytes.ts    # Parse "512M" → number
│   │   │   │   ├── parse-duration.ts # Parse "10s" → number
│   │   │   │   ├── env.ts            # Environment utilities
│   │   │   │   ├── signal.ts         # Signal handling
│   │   │   │   ├── pid.ts            # PID file management
│   │   │   │   └── platform.ts       # OS detection utilities
│   │   │   └── types.ts              # Core type definitions
│   │   ├── tests/
│   │   │   ├── unit/
│   │   │   ├── integration/
│   │   │   └── fixtures/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── tsup.config.ts
│   │
│   ├── daemon/                        # Daemon process (runs as background service)
│   │   ├── src/
│   │   │   ├── index.ts              # Daemon entry point
│   │   │   ├── daemon.ts             # Main daemon class
│   │   │   ├── watchdog.ts           # Self-health watchdog
│   │   │   ├── resurrector.ts        # Process list save/restore
│   │   │   └── shutdown.ts           # Graceful shutdown orchestration
│   │   ├── tests/
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── cli/                           # CLI binary (`od`)
│   │   ├── src/
│   │   │   ├── index.ts              # CLI entry point
│   │   │   ├── parser.ts             # Argument parser (from scratch)
│   │   │   ├── commands/
│   │   │   │   ├── start.ts
│   │   │   │   ├── stop.ts
│   │   │   │   ├── restart.ts
│   │   │   │   ├── reload.ts
│   │   │   │   ├── delete.ts
│   │   │   │   ├── list.ts
│   │   │   │   ├── info.ts
│   │   │   │   ├── logs.ts
│   │   │   │   ├── monit.ts
│   │   │   │   ├── scale.ts
│   │   │   │   ├── deploy.ts
│   │   │   │   ├── secret.ts
│   │   │   │   ├── daemon.ts
│   │   │   │   ├── startup.ts
│   │   │   │   ├── save.ts
│   │   │   │   ├── resurrect.ts
│   │   │   │   ├── doctor.ts
│   │   │   │   ├── init.ts
│   │   │   │   ├── env.ts
│   │   │   │   ├── plugin.ts
│   │   │   │   ├── metrics.ts
│   │   │   │   ├── top.ts
│   │   │   │   └── help.ts
│   │   │   ├── ui/
│   │   │   │   ├── table.ts          # Table renderer
│   │   │   │   ├── spinner.ts        # Spinner animation
│   │   │   │   ├── progress.ts       # Progress bar
│   │   │   │   ├── colors.ts         # ANSI color helpers
│   │   │   │   ├── box.ts            # Box drawing
│   │   │   │   ├── sparkline.ts      # ASCII sparkline charts
│   │   │   │   └── prompt.ts         # Interactive prompts
│   │   │   ├── tui/
│   │   │   │   ├── dashboard.ts      # TUI dashboard (monit)
│   │   │   │   ├── renderer.ts       # Terminal renderer (raw ANSI)
│   │   │   │   ├── layout.ts         # Responsive layout engine
│   │   │   │   ├── widgets/
│   │   │   │   │   ├── process-table.ts
│   │   │   │   │   ├── metrics-graph.ts
│   │   │   │   │   ├── log-viewer.ts
│   │   │   │   │   └── status-bar.ts
│   │   │   │   └── input.ts          # Keyboard/mouse input handler
│   │   │   └── client.ts             # IPC client wrapper
│   │   ├── tests/
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── sdk/                           # Programmatic SDK
│   │   ├── src/
│   │   │   ├── index.ts              # SDK entry
│   │   │   ├── client.ts             # OpenDaemon client class
│   │   │   ├── types.ts              # Public SDK types
│   │   │   └── streams.ts            # Log/metric stream helpers
│   │   ├── tests/
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── runtime/                       # In-process runtime (metrics from app code)
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── metrics.ts            # Custom metric registration
│   │   │   ├── health.ts             # Programmatic health reporting
│   │   │   └── ready.ts              # Ready signal helpers
│   │   ├── tests/
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── plugins/                       # Built-in plugins
│       ├── process-manager/
│       │   ├── src/
│       │   │   ├── index.ts
│       │   │   ├── process-controller.ts  # Spawn, kill, signal management
│       │   │   ├── cluster-controller.ts  # Cluster mode management
│       │   │   ├── restart-strategy.ts    # Restart backoff strategies
│       │   │   └── types.ts
│       │   ├── tests/
│       │   └── package.json
│       ├── health-check/
│       │   ├── src/
│       │   │   ├── index.ts
│       │   │   ├── checkers/
│       │   │   │   ├── http.ts
│       │   │   │   ├── tcp.ts
│       │   │   │   ├── script.ts
│       │   │   │   ├── memory.ts
│       │   │   │   ├── cpu.ts
│       │   │   │   ├── event-loop.ts
│       │   │   │   └── composite.ts
│       │   │   └── types.ts
│       │   ├── tests/
│       │   └── package.json
│       ├── log-manager/
│       │   ├── src/
│       │   │   ├── index.ts
│       │   │   ├── writer.ts           # Log file writer with rotation
│       │   │   ├── rotator.ts          # Log rotation logic
│       │   │   ├── compressor.ts       # Gzip compression (using zlib)
│       │   │   ├── streamer.ts         # Real-time log streaming
│       │   │   ├── searcher.ts         # Log search engine
│       │   │   ├── formatter.ts        # Log formatters (json, text, custom)
│       │   │   └── types.ts
│       │   ├── tests/
│       │   └── package.json
│       ├── metrics-collector/
│       │   ├── src/
│       │   │   ├── index.ts
│       │   │   ├── collectors/
│       │   │   │   ├── process.ts      # Process metrics (cpu, mem, etc.)
│       │   │   │   ├── system.ts       # System metrics (os-level)
│       │   │   │   └── custom.ts       # Custom metric aggregation
│       │   │   ├── exporters/
│       │   │   │   ├── prometheus.ts   # Prometheus text format
│       │   │   │   ├── json.ts         # JSON format
│       │   │   │   ├── otlp.ts         # OpenTelemetry OTLP
│       │   │   │   └── statsd.ts       # StatsD UDP
│       │   │   ├── store.ts            # Time-series ring buffer
│       │   │   └── types.ts
│       │   ├── tests/
│       │   └── package.json
│       ├── cluster-manager/
│       │   ├── src/
│       │   │   ├── index.ts
│       │   │   ├── balancer.ts         # Load balancing strategies
│       │   │   ├── autoscaler.ts       # Auto-scale logic
│       │   │   ├── sticky.ts           # Sticky session support
│       │   │   └── types.ts
│       │   ├── tests/
│       │   └── package.json
│       ├── deploy-strategy/
│       │   ├── src/
│       │   │   ├── index.ts
│       │   │   ├── strategies/
│       │   │   │   ├── rolling.ts
│       │   │   │   ├── blue-green.ts
│       │   │   │   ├── canary.ts
│       │   │   │   ├── recreate.ts
│       │   │   │   └── a-b.ts
│       │   │   ├── rollback.ts
│       │   │   └── types.ts
│       │   ├── tests/
│       │   └── package.json
│       ├── config-manager/
│       │   ├── src/
│       │   │   ├── index.ts
│       │   │   ├── parsers/
│       │   │   │   ├── typescript.ts   # TS config loader (via child_process)
│       │   │   │   ├── javascript.ts   # JS config loader
│       │   │   │   ├── json.ts         # JSON parser
│       │   │   │   └── yaml.ts         # YAML parser (from scratch!)
│       │   │   └── types.ts
│       │   ├── tests/
│       │   └── package.json
│       ├── dependency-resolver/
│       │   ├── src/
│       │   │   ├── index.ts
│       │   │   ├── graph.ts            # DAG implementation
│       │   │   ├── resolver.ts         # Topological sort
│       │   │   └── types.ts
│       │   ├── tests/
│       │   └── package.json
│       ├── secret-manager/
│       │   ├── src/
│       │   │   ├── index.ts
│       │   │   ├── crypto.ts           # AES-256-GCM encryption (using Node crypto)
│       │   │   ├── store.ts            # Encrypted file store
│       │   │   └── types.ts
│       │   ├── tests/
│       │   └── package.json
│       ├── scheduler/
│       │   ├── src/
│       │   │   ├── index.ts
│       │   │   ├── cron-parser.ts      # Cron expression parser (from scratch!)
│       │   │   ├── scheduler.ts        # Job scheduler
│       │   │   └── types.ts
│       │   ├── tests/
│       │   └── package.json
│       ├── watch-mode/
│       │   ├── src/
│       │   │   ├── index.ts
│       │   │   ├── watcher.ts          # fs.watch wrapper with debounce
│       │   │   ├── glob.ts             # Glob pattern matcher (from scratch!)
│       │   │   └── types.ts
│       │   ├── tests/
│       │   └── package.json
│       ├── notification/
│       │   ├── src/
│       │   │   ├── index.ts
│       │   │   ├── channels/
│       │   │   │   ├── webhook.ts      # HTTP POST
│       │   │   │   ├── smtp.ts         # SMTP client (from scratch!)
│       │   │   │   └── custom.ts       # Custom channel interface
│       │   │   ├── throttle.ts         # Rate limiting
│       │   │   └── types.ts
│       │   ├── tests/
│       │   └── package.json
│       ├── resource-limiter/
│       │   ├── src/
│       │   │   ├── index.ts
│       │   │   ├── monitor.ts          # Resource monitoring
│       │   │   ├── enforcer.ts         # Limit enforcement
│       │   │   └── types.ts
│       │   ├── tests/
│       │   └── package.json
│       ├── audit-logger/
│       │   ├── src/
│       │   │   ├── index.ts
│       │   │   ├── logger.ts           # Audit log writer
│       │   │   └── types.ts
│       │   ├── tests/
│       │   └── package.json
│       ├── startup-manager/
│       │   ├── src/
│       │   │   ├── index.ts
│       │   │   ├── generators/
│       │   │   │   ├── systemd.ts
│       │   │   │   ├── launchd.ts
│       │   │   │   ├── upstart.ts
│       │   │   │   └── openrc.ts
│       │   │   ├── detector.ts         # Init system detection
│       │   │   └── types.ts
│       │   ├── tests/
│       │   └── package.json
│       └── api-server/
│           ├── src/
│           │   ├── index.ts
│           │   ├── http-server.ts      # HTTP server (from scratch, using net/http)
│           │   ├── ws-server.ts        # WebSocket server (from scratch, RFC 6455!)
│           │   ├── router.ts           # URL router
│           │   ├── middleware.ts        # Auth, CORS, rate limiting
│           │   ├── handlers/
│           │   │   ├── processes.ts
│           │   │   ├── logs.ts
│           │   │   ├── metrics.ts
│           │   │   ├── daemon.ts
│           │   │   └── health.ts
│           │   └── types.ts
│           ├── tests/
│           └── package.json
│
├── examples/
│   ├── 01-basic/
│   │   ├── simple-start.ts
│   │   ├── cluster-mode.ts
│   │   └── ecosystem-config.ts
│   ├── 02-health-checks/
│   │   ├── http-health.ts
│   │   ├── tcp-health.ts
│   │   ├── composite-health.ts
│   │   └── custom-health.ts
│   ├── 03-deployment/
│   │   ├── rolling-deploy.ts
│   │   ├── blue-green-deploy.ts
│   │   ├── canary-deploy.ts
│   │   └── auto-rollback.ts
│   ├── 04-monitoring/
│   │   ├── prometheus-export.ts
│   │   ├── custom-metrics.ts
│   │   └── resource-alerts.ts
│   ├── 05-plugins/
│   │   ├── custom-health-checker.ts
│   │   ├── custom-metric-exporter.ts
│   │   ├── custom-notification-channel.ts
│   │   └── custom-deploy-strategy.ts
│   ├── 06-advanced/
│   │   ├── dependency-graph.ts
│   │   ├── secret-management.ts
│   │   ├── auto-scaling.ts
│   │   ├── cron-scheduling.ts
│   │   └── multi-app-orchestration.ts
│   └── 07-real-world/
│       ├── express-app/
│       ├── nextjs-app/
│       ├── fastify-microservice/
│       └── worker-queue/
│
├── docs/                              # Documentation source
│   ├── getting-started.md
│   ├── configuration.md
│   ├── cli-reference.md
│   ├── sdk-reference.md
│   ├── plugin-development.md
│   ├── deployment-strategies.md
│   ├── monitoring.md
│   ├── troubleshooting.md
│   └── migration-from-pm2.md
│
├── website/                           # Documentation website (React + Vite)
│   ├── public/
│   │   ├── CNAME                      # opendaemon.dev
│   │   └── llms.txt
│   ├── src/
│   └── ...
│
├── llms.txt                           # LLM-optimized reference (< 2000 tokens)
├── SPECIFICATION.md                   # Complete system specification
├── IMPLEMENTATION.md                  # Architecture decisions
├── TASKS.md                           # Ordered task list
├── README.md
├── CHANGELOG.md
├── LICENSE                            # MIT
├── package.json                       # Workspace root
├── pnpm-workspace.yaml               # pnpm workspace config
├── tsconfig.base.json                 # Shared TypeScript config
├── turbo.json                         # Turborepo config (build orchestration only)
└── .gitignore
```

---

## MONOREPO STRUCTURE

Use **pnpm workspaces** with **Turborepo** for build orchestration.

**Published npm Packages:**

| Package | npm Name | Description |
|---------|----------|-------------|
| `packages/core` | `opendaemon` | Core kernel + all built-in plugins |
| `packages/cli` | `opendaemon-cli` | CLI binary (depends on core) |
| `packages/sdk` | `opendaemon-sdk` | Programmatic SDK |
| `packages/runtime` | `opendaemon-runtime` | In-app runtime helpers |

**The main `opendaemon` package re-exports everything from core and includes all built-in plugins.**

**Global Install:**
```bash
npm install -g opendaemon
# This installs both the daemon and the `od` CLI binary
```

**Programmatic Install:**
```bash
npm install opendaemon-sdk
# Lightweight SDK for programmatic control
```

**In-App Runtime:**
```bash
npm install opendaemon-runtime
# Helpers for apps running under OpenDaemon
```

---

## CONFIG FILES

### Root package.json
```json
{
  "name": "opendaemon-monorepo",
  "private": true,
  "scripts": {
    "build": "turbo build",
    "test": "turbo test",
    "test:coverage": "turbo test:coverage",
    "lint": "turbo lint",
    "typecheck": "turbo typecheck",
    "format": "prettier --write ."
  },
  "devDependencies": {
    "turbo": "^2.0.0",
    "prettier": "^3.0.0"
  }
}
```

### pnpm-workspace.yaml
```yaml
packages:
  - 'packages/*'
  - 'packages/plugins/*'
```

### tsconfig.base.json
```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noEmit": true,
    "declaration": true,
    "declarationMap": true,
    "esModuleInterop": true,
    "moduleResolution": "bundler",
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022"],
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "resolveJsonModule": true
  }
}
```

---

## GITHUB ACTIONS

### `.github/workflows/ci.yml`
```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm run typecheck
      - run: pnpm run lint
      - run: pnpm run test:coverage
      - run: pnpm run build
```

### `.github/workflows/release.yml`
```yaml
name: Release

on:
  push:
    tags: ['v*']

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: 'https://registry.npmjs.org'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm run test:coverage
      - run: pnpm run build
      - run: pnpm -r publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

---

## KEY IMPLEMENTATION DETAILS

### 1. YAML Parser (from scratch)
Implement a subset of YAML 1.2 supporting:
- Scalars (strings, numbers, booleans, null)
- Sequences (arrays)
- Mappings (objects)
- Multi-line strings (|, >)
- Comments (#)
- Anchors and aliases (& and *)
- Nested structures
- No need: tags, directives, complex keys

### 2. Cron Parser (from scratch)
Implement standard cron expression parsing:
- 5-field (minute, hour, day, month, weekday)
- 6-field (second, minute, hour, day, month, weekday)
- Special characters: *, /, -, L, W, #
- Named months and weekdays
- Predefined: @yearly, @monthly, @weekly, @daily, @hourly
- Next execution time calculation
- Human-readable description generation

### 3. WebSocket Server (from scratch, RFC 6455)
Implement WebSocket protocol:
- HTTP upgrade handshake (Sec-WebSocket-Key → Sec-WebSocket-Accept)
- Frame parsing (opcode, masking, payload length)
- Text and binary frames
- Ping/pong for keepalive
- Close frame handling
- Per-message deflate (optional)
- Max payload size enforcement

### 4. HTTP Server Router (from scratch)
Implement a URL router using `http.createServer`:
- Path parameter extraction (`:name`)
- Query string parsing
- Request body parsing (JSON)
- Response helpers (json, text, status)
- Middleware chain (auth, cors, rate-limit)
- Error handling middleware

### 5. SMTP Client (from scratch)
Implement basic SMTP for notification emails:
- TCP socket connection
- EHLO/HELO handshake
- STARTTLS upgrade (using `tls.connect`)
- AUTH LOGIN / AUTH PLAIN
- MAIL FROM, RCPT TO, DATA commands
- Basic MIME encoding for email body
- Connection pooling

### 6. Glob Pattern Matcher (from scratch)
Implement glob matching for watch mode:
- `*` — match anything except path separator
- `**` — match anything including path separators
- `?` — match single character
- `[abc]` — character class
- `{a,b,c}` — alternation
- `!pattern` — negation

### 7. JSON-RPC 2.0 (from scratch)
Implement the JSON-RPC 2.0 specification:
- Request/Response/Notification message types
- Batch requests
- Error objects with code, message, data
- Method parameter validation
- ID matching for async responses

### 8. Table Renderer (from scratch)
Implement terminal table rendering:
- Unicode box drawing characters
- Column width calculation (respecting unicode width)
- Text alignment (left, center, right)
- Text truncation with ellipsis
- Color support (ANSI escape codes)
- Responsive (adapts to terminal width)

---

## COMPARISON TABLE

| Feature | PM2 | OpenDaemon |
|---------|-----|------------|
| Language | JavaScript | TypeScript (strict) |
| Dependencies | 30+ runtime deps | 0 runtime deps |
| Plugin System | None | Full micro-kernel |
| Health Checks | Process alive only | HTTP, TCP, gRPC, script, composite, custom |
| Deploy Strategies | None | Rolling, Blue-Green, Canary, A/B |
| Log Management | Basic + paid module | Structured, rotation, streaming, search |
| Metrics | Paid (PM2+) | Free: Prometheus, OTLP, StatsD, JSON |
| TUI Dashboard | Basic `pm2 monit` | Full htop-like dashboard |
| Process Dependencies | None | DAG-based with health-aware ordering |
| Secret Management | None | AES-256-GCM encrypted store |
| Auto-Scaling | None | CPU/Memory/Custom metric based |
| Resource Limits | None | Memory, CPU, event loop, file descriptors |
| Config Format | JS only | TS, JS, JSON, YAML with validation |
| WebSocket | None | Real-time event streaming |
| REST API | None (paid) | Full REST + WebSocket API |
| Audit Logging | None | Complete audit trail |
| Cron Scheduling | Basic | Full cron with timezone + overlap handling |
| Notification | None (paid) | Webhook, Slack, Discord, Email |
| Watch Mode | Basic | Intelligent with glob, debounce |
| License | AGPL | MIT |
| Programmatic SDK | Limited | Full typed SDK |
| Init System Support | systemd, upstart | systemd, launchd, upstart, OpenRC, rc.d |
| In-App Runtime | None | Custom metrics, health reporting |

---

## LLM-NATIVE REQUIREMENTS

### 1. llms.txt File (< 2000 tokens)
Create at project root with:
- One-line description
- Install command
- Basic 5-line usage example
- CLI command summary
- SDK quick reference
- Plugin list
- Common patterns
- Error codes table
- Links to docs and GitHub

### 2. API Naming Standards
All public APIs use predictable patterns:
- `start()`, `stop()`, `restart()`, `reload()`, `delete()`
- `list()`, `info()`, `status()`, `scale()`
- `connect()`, `disconnect()`
- `on()`, `off()`, `emit()`
- `use()`, `register()`, `unregister()`

### 3. JSDoc Requirements
Every public API must have:
- Description
- `@param` for each parameter
- `@returns` description
- `@throws` for expected errors
- `@example` with working code
- `@since` version tag

### 4. Example Richness
Minimum 25 examples organized by category (see project structure).

---

## IMPLEMENTATION CHECKLIST

### Phase 0: Planning
- [ ] Create SPECIFICATION.md
- [ ] Create IMPLEMENTATION.md
- [ ] Create TASKS.md
- [ ] All three documents complete and reviewed

### Phase 1: Core Foundation
- [ ] Micro-kernel (event bus, plugin registry, lifecycle, error boundary)
- [ ] IPC layer (UDS server/client, JSON-RPC 2.0, frame protocol)
- [ ] State machine for process states
- [ ] Configuration loader and validator
- [ ] Error system with codes
- [ ] Utility modules (parse-bytes, parse-duration, signal, pid, platform)

### Phase 2: Essential Plugins
- [ ] Process Manager plugin (fork mode, signals, restart strategies)
- [ ] Log Manager plugin (structured logging, rotation, streaming)
- [ ] Health Check plugin (process, HTTP, TCP)
- [ ] Config Manager plugin (TS, JS, JSON config loading)
- [ ] Dependency Resolver plugin (DAG, topological sort)

### Phase 3: CLI
- [ ] Argument parser
- [ ] All commands (start, stop, restart, list, logs, etc.)
- [ ] Table renderer, spinner, colors
- [ ] JSON output mode

### Phase 4: Daemon
- [ ] Daemon entry point and daemonization
- [ ] Watchdog
- [ ] Process save/resurrect
- [ ] Startup script generator

### Phase 5: Advanced Plugins
- [ ] Cluster Manager (multi-instance, load balancing, auto-scale)
- [ ] Metrics Collector (process metrics, system metrics, Prometheus export)
- [ ] Deploy Strategies (rolling, blue-green, canary)
- [ ] Secret Manager (AES-256-GCM, secret store)
- [ ] Scheduler (cron parser, job runner)
- [ ] Watch Mode (fs.watch, glob matcher, debounce)
- [ ] Notification (webhook, SMTP)
- [ ] Resource Limiter
- [ ] Audit Logger

### Phase 6: SDK & Runtime
- [ ] OpenDaemon SDK package
- [ ] Runtime package (custom metrics, health reporting)

### Phase 7: TUI Dashboard
- [ ] Terminal renderer (raw ANSI)
- [ ] Layout engine
- [ ] Process table widget
- [ ] Metrics sparkline widget
- [ ] Log viewer widget
- [ ] Keyboard input handler

### Phase 8: API Server Plugin
- [ ] HTTP server (from scratch)
- [ ] WebSocket server (from scratch, RFC 6455)
- [ ] REST API routes
- [ ] WebSocket event streaming
- [ ] Auth, CORS, rate limiting

### Phase 9: Testing & Polish
- [ ] 100% test coverage across all packages
- [ ] Integration tests (real process spawning)
- [ ] E2E tests (full daemon + CLI flow)
- [ ] Performance benchmarks
- [ ] Documentation site
- [ ] README with migration guide from PM2

### Phase 10: Examples & Documentation
- [ ] 25+ examples
- [ ] llms.txt
- [ ] Documentation site (React + Vite)
- [ ] Migration from PM2 guide
- [ ] Plugin development guide

### Final Verification
- [ ] `pnpm run build` succeeds across all packages
- [ ] `pnpm run test:coverage` shows 100% in all packages
- [ ] `pnpm run typecheck` passes
- [ ] `pnpm run lint` passes
- [ ] All examples run successfully
- [ ] Documentation site builds
- [ ] README is complete

---

## BEGIN IMPLEMENTATION

Start by creating **SPECIFICATION.md** with the complete system specification based on everything above.

Then create **IMPLEMENTATION.md** with architecture decisions, module interactions, data flow diagrams, IPC protocol specification, and state machine definitions.

Then create **TASKS.md** with ordered, numbered tasks across all phases, with dependencies and complexity estimates.

Only after all three documents are complete, begin implementing code by following TASKS.md sequentially.

**Remember:**
- This will be published as multiple npm packages under the OpenDaemon organization
- It must be production-ready and enterprise-grade
- **ZERO runtime dependencies** across ALL packages
- 100% test coverage in ALL packages
- TypeScript strict mode everywhere
- Every utility, parser, server, and protocol implemented FROM SCRATCH
- This is the PM2 killer — it must be definitively better in every dimension
- MIT licensed — truly open source with no feature gating
- Beautiful CLI output and developer experience
- Plugin-first architecture — users can extend everything
