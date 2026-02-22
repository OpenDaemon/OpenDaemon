# OpenDaemon Implementation Guide

## 1. Architecture Overview

### 1.1 Design Principles

1. **Zero Dependencies**: Implement everything from scratch
   - HTTP server using Node.js `http` module only
   - WebSocket using Node.js `net` module
   - YAML parser from scratch
   - CLI parser from scratch
   - Log rotation from scratch
   - Cron parser from scratch
   - No lodash, express, ws, chalk, commander, etc.

2. **Plugin-First Architecture**: 
   - Micro-kernel (~2KB) manages plugins only
   - All features implemented as plugins
   - Process manager is a plugin
   - Health check is a plugin
   - Even the CLI is technically a plugin client

3. **Strict TypeScript**:
   - `strict: true` mode
   - No `any` type anywhere
   - Use `unknown` and type narrowing
   - Maximum 50 lines per function
   - Maximum 400 lines per file

4. **Test-Driven Development**:
   - 100% code coverage required
   - Write tests before implementation
   - Vitest for testing
   - Separate unit, integration, and e2e tests

### 1.2 Project Structure

```
opendaemon/
├── packages/
│   ├── core/                    # Daemon core (micro-kernel)
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── kernel.ts        # Micro kernel (200 lines max)
│   │   │   ├── event-bus.ts     # Pub/sub system
│   │   │   ├── state-machine.ts # Process state machine
│   │   │   ├── state-store.ts   # In-memory state
│   │   │   ├── errors/          # Error classes
│   │   │   ├── config/          # Configuration
│   │   │   ├── ipc/             # IPC layer
│   │   │   └── plugins/         # Plugin system
│   │   └── package.json
│   │
│   ├── plugins/                 # Core plugins
│   │   ├── process-manager/     # Process lifecycle
│   │   ├── health-check/        # Health monitoring
│   │   ├── log-manager/         # Log handling
│   │   ├── metrics-collector/   # Metrics
│   │   ├── cluster-manager/     # Cluster mode
│   │   ├── deploy-strategy/     # Deployments
│   │   ├── config-manager/      # Config loading
│   │   ├── secret-manager/      # Secrets
│   │   ├── scheduler/           # Cron jobs
│   │   ├── watch-mode/          # File watching
│   │   ├── notification/        # Notifications
│   │   ├── dependency-resolver/ # Dependencies
│   │   ├── resource-limiter/    # Resource limits
│   │   ├── audit-logger/        # Audit logging
│   │   ├── startup-manager/     # System startup
│   │   ├── tui-dashboard/       # Terminal UI
│   │   └── api-server/          # REST API + WebSocket
│   │
│   ├── cli/                     # CLI binary
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── commands/        # CLI commands
│   │   │   ├── output/          # Terminal output
│   │   │   └── client.ts        # IPC client
│   │   └── package.json
│   │
│   └── sdk/                     # JavaScript SDK
│       ├── src/
│       │   ├── index.ts
│       │   ├── client.ts        # SDK client
│       │   └── runtime.ts       # Runtime metrics
│       └── package.json
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
│
├── docs/
│   ├── api/                     # API documentation
│   ├── guides/                  # User guides
│   └── examples/                # Code examples
│
├── scripts/
│   ├── build.ts
│   └── test.ts
│
├── .github/
│   └── workflows/
│       ├── ci.yml
│       ├── release.yml
│       └── docs.yml
│
├── package.json                 # Root package.json
├── tsconfig.json               # Root tsconfig
├── tsconfig.base.json          # Shared tsconfig
├── vitest.config.ts
├── tsup.config.ts
├── eslint.config.js
├── prettier.config.js
├── LICENSE
└── README.md
```

## 2. Core Implementation

### 2.1 Micro Kernel (packages/core/src/kernel.ts)

The kernel is deliberately minimal:

```typescript
// Maximum 200 lines
export class Kernel {
  private plugins = new Map<string, Plugin>();
  private events = new EventBus();
  private state = new StateStore();
  private logger: Logger;
  private stateMachine: DaemonStateMachine;
  private watchdog: Watchdog;
  
  async start(config: DaemonConfig): Promise<void> {
    // 1. Load core plugins
    // 2. Resolve dependencies
    // 3. Install plugins in priority order
    // 4. Start plugins
    // 5. Mark daemon as ready
  }
  
  async stop(): Promise<void> {
    // 1. Mark stopping state
    // 2. Stop plugins in reverse order
    // 3. Cleanup
  }
  
  registerPlugin(plugin: Plugin): void {
    // Register plugin with dependency checking
  }
  
  getPlugin<T extends Plugin>(name: string): T | undefined {
    return this.plugins.get(name) as T;
  }
}
```

### 2.2 Event Bus (packages/core/src/event-bus.ts)

```typescript
export class EventBus {
  private listeners = new Map<string, Set<EventHandler>>();
  private wildcards = new Set<WildcardHandler>();
  
  on(event: string, handler: EventHandler): Unsubscribe {
    // Support wildcards: "process:*", "*", "process:started"
  }
  
  once(event: string, handler: EventHandler): Unsubscribe {
    // Auto-unsubscribe after first emit
  }
  
  emit(event: string, data?: unknown): void {
    // Sync emit
  }
  
  emitAsync(event: string, data?: unknown): Promise<void> {
    // Async emit, wait for all handlers
  }
  
  off(event: string, handler?: EventHandler): void {
    // Remove listener
  }
}
```

### 2.3 State Machine (packages/core/src/state-machine.ts)

```typescript
export class StateMachine<S extends string, E extends string> {
  private currentState: S;
  private transitions: Map<S, Map<E, S>>;
  private onTransition?: (from: S, to: S, event: E) => void;
  
  constructor(initialState: S, config: StateMachineConfig<S, E>) {
    // Setup transitions
  }
  
  can(event: E): boolean {
    // Check if transition is valid
  }
  
  transition(event: E): boolean {
    // Perform transition if valid
  }
  
  getState(): S {
    return this.currentState;
  }
}
```

### 2.4 State Store (packages/core/src/state-store.ts)

```typescript
export class StateStore {
  private data = new Map<string, unknown>();
  private subscribers = new Map<string, Set<StateSubscriber>>();
  
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T;
  }
  
  set<T>(key: string, value: T): void {
    const oldValue = this.data.get(key);
    this.data.set(key, value);
    this.notify(key, value, oldValue);
  }
  
  subscribe<T>(key: string, handler: StateSubscriber<T>): Unsubscribe {
    // Subscribe to key changes
  }
  
  // Persistence helpers
  async save(path: string): Promise<void> {
    // Persist to disk
  }
  
  async load(path: string): Promise<void> {
    // Load from disk
  }
}
```

## 3. IPC Implementation

### 3.1 Protocol Design

Binary protocol over Unix Domain Socket:

```
Frame Structure:
┌──────────┬──────────┬─────────────────────────────┐
│ Type (1) │ Size (4) │ Payload (Variable)          │
│  byte    │  bytes   │  JSON/Binary                │
└──────────┴──────────┴─────────────────────────────┘

Frame Types:
0x01 - JSON-RPC Request
0x02 - JSON-RPC Response
0x03 - JSON-RPC Notification
0x04 - Binary Data (logs)
0x05 - Heartbeat
0x06 - Auth Challenge
0x07 - Auth Response
```

### 3.2 IPC Server (packages/core/src/ipc/server.ts)

```typescript
export class IpcServer {
  private server: net.Server;
  private connections = new Set<net.Socket>();
  private methods = new Map<string, RpcHandler>();
  private authenticator?: Authenticator;
  
  async start(socketPath: string): Promise<void> {
    // Create Unix Domain Socket
    // Set permissions to 0o660
    // Accept connections
    // Handle frames
  }
  
  registerMethod(name: string, handler: RpcHandler): void {
    // Register RPC method
  }
  
  broadcast(frame: Frame): void {
    // Send to all connected clients
  }
  
  private handleFrame(socket: net.Socket, frame: Frame): void {
    // Parse frame, route to handler
  }
}
```

### 3.3 IPC Client (packages/cli/src/client.ts)

```typescript
export class IpcClient {
  private socket: net.Socket;
  private pendingRequests = new Map<number, RequestResolver>();
  private requestId = 0;
  
  async connect(socketPath: string): Promise<void> {
    // Connect to daemon socket
  }
  
  async call(method: string, params?: unknown): Promise<unknown> {
    // Send JSON-RPC request
    // Wait for response
  }
  
  subscribe(event: string, handler: EventHandler): Unsubscribe {
    // Subscribe to notifications
  }
  
  private handleFrame(frame: Frame): void {
    // Route frames to handlers
  }
}
```

### 3.4 JSON-RPC Implementation (packages/core/src/ipc/rpc.ts)

```typescript
// JSON-RPC 2.0 implementation from scratch
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class JsonRpc {
  static parseRequest(buffer: Buffer): JsonRpcRequest {
    // Parse and validate
  }
  
  static createResponse(id: number | string, result: unknown): JsonRpcResponse {
    // Create success response
  }
  
  static createError(id: number | string, error: JsonRpcError): JsonRpcResponse {
    // Create error response
  }
}
```

## 4. Plugin System Implementation

### 4.1 Plugin Registry (packages/core/src/plugins/registry.ts)

```typescript
export class PluginRegistry {
  private plugins = new Map<string, RegisteredPlugin>();
  private graph = new DependencyGraph();
  
  register(plugin: Plugin): void {
    // Check for conflicts
    // Add to dependency graph
  }
  
  resolveLoadOrder(): string[] {
    // Topological sort
    // Handle circular dependencies
    // Sort by priority
  }
  
  async installAll(context: PluginContext): Promise<void> {
    // Install in load order
  }
  
  async startAll(): Promise<void> {
    // Start in load order
  }
  
  async stopAll(): Promise<void> {
    // Stop in reverse order
  }
}
```

### 4.2 Plugin Context (packages/core/src/plugins/context.ts)

```typescript
export function createPluginContext(
  plugin: Plugin,
  kernel: Kernel
): PluginContext {
  return {
    get config() { return kernel.config; },
    get pluginConfig() { return kernel.config.plugins?.[plugin.name]; },
    get events() { return kernel.events; },
    get logger() { return createLogger(plugin.name); },
    get store() { return kernel.state; },
    
    registerMethod(name, handler) {
      kernel.ipc.registerMethod(`${plugin.name}.${name}`, handler);
    },
    
    registerHook(hookName, handler) {
      kernel.hooks.register(`${plugin.name}:${hookName}`, handler);
    },
    
    getPlugin(name) {
      return kernel.getPlugin(name);
    },
    
    registerMetric(metric) {
      kernel.metrics.register(plugin.name, metric);
    },
  };
}
```

## 5. Core Plugins Implementation

### 5.1 Process Manager (packages/plugins/process-manager/src/)

**Architecture:**
```typescript
// index.ts
export class ProcessManagerPlugin implements Plugin {
  name = 'process-manager';
  version = '1.0.0';
  description = 'Manages process lifecycle';
  priority = 10;
  
  private processes = new Map<string, ManagedProcess>();
  private context!: PluginContext;
  
  install(context: PluginContext): void {
    this.context = context;
    this.registerRpcMethods();
    this.registerEventHandlers();
  }
  
  private registerRpcMethods(): void {
    this.context.registerMethod('start', this.handleStart.bind(this));
    this.context.registerMethod('stop', this.handleStop.bind(this));
    this.context.registerMethod('restart', this.handleRestart.bind(this));
    this.context.registerMethod('list', this.handleList.bind(this));
    this.context.registerMethod('info', this.handleInfo.bind(this));
  }
  
  private registerEventHandlers(): void {
    this.context.events.on('config:loaded', this.loadFromConfig.bind(this));
  }
  
  async handleStart(config: ProcessConfig): Promise<ProcessInfo> {
    // Create ManagedProcess
    // Start process
    // Return process info
  }
  
  async handleStop(name: string): Promise<void> {
    // Stop process gracefully
  }
}
```

**Process Lifecycle:**
```typescript
// managed-process.ts
export class ManagedProcess {
  private stateMachine: StateMachine<ProcessState, ProcessEvent>;
  private childProcess?: ChildProcess;
  private restartAttempts = 0;
  private lastRestart = 0;
  
  constructor(private config: ProcessConfig, private context: PluginContext) {
    this.setupStateMachine();
  }
  
  private setupStateMachine(): void {
    this.stateMachine = new StateMachine({
      initial: 'created',
      transitions: {
        'created': {
          'start': 'starting',
          'remove': 'stopped'
        },
        'starting': {
          'ready': 'online',
          'error': 'errored',
          'timeout': 'errored'
        },
        'online': {
          'stop': 'stopping',
          'crash': 'errored',
          'reload': 'reloading'
        },
        'reloading': {
          'ready': 'online',
          'error': 'errored'
        },
        'stopping': {
          'stopped': 'stopped',
          'timeout': 'killing'
        },
        'killing': {
          'stopped': 'stopped'
        },
        'errored': {
          'restart': 'starting',
          'stop': 'stopped'
        },
        'stopped': {
          'start': 'starting'
        }
      }
    });
  }
  
  async start(): Promise<void> {
    // Validate config
    // Check dependencies
    // Fork/spawn process
    // Wait for ready signal or timeout
    // Transition state
  }
  
  async stop(signal?: string, timeout?: number): Promise<void> {
    // Send signal (default: SIGTERM)
    // Wait for graceful shutdown
    // Force kill if timeout exceeded
  }
  
  private onCrash(exitCode: number, signal: string): void {
    // Handle crash based on restart policy
    // Apply backoff strategy
    // Emit events
  }
}
```

**Fork Mode:**
```typescript
async function spawnFork(config: ProcessConfig): Promise<ChildProcess> {
  const child = spawn(config.interpreter || process.execPath, [
    ...config.interpreterArgs || [],
    config.script,
    ...config.args || []
  ], {
    cwd: config.cwd,
    env: { ...process.env, ...config.env },
    detached: config.detached || false,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc']
  });
  
  // Handle UID/GID
  if (config.uid !== undefined) {
    child.process?.setuid?.(config.uid);
  }
  if (config.gid !== undefined) {
    child.process?.setgid?.(config.gid);
  }
  
  return child;
}
```

**Cluster Mode:**
```typescript
export class ClusterManager {
  private workers = new Map<number, Worker>();
  private loadBalancer: LoadBalancer;
  
  async startCluster(config: ProcessConfig): Promise<void> {
    const numWorkers = config.instances === 'max' 
      ? os.cpus().length 
      : config.instances || 1;
    
    for (let i = 0; i < numWorkers; i++) {
      await this.spawnWorker(config, i);
    }
  }
  
  async reload(): Promise<void> {
    // Rolling reload: restart workers one by one
    for (const [id, worker] of this.workers) {
      await this.reloadWorker(worker);
    }
  }
  
  private async spawnWorker(config: ProcessConfig, id: number): Promise<Worker> {
    const worker = cluster.fork({
      OD_WORKER_ID: String(id),
      ...config.env
    });
    
    this.workers.set(worker.id, worker);
    return worker;
  }
}
```

### 5.2 Health Check Plugin (packages/plugins/health-check/src/)

```typescript
export class HealthCheckPlugin implements Plugin {
  name = 'health-check';
  version = '1.0.0';
  priority = 20;
  dependencies = ['process-manager'];
  
  private checks = new Map<string, HealthCheck[]>();
  private intervals = new Map<string, NodeJS.Timeout>();
  
  install(context: PluginContext): void {
    // Listen to process events
    context.events.on('process:started', this.addChecks.bind(this));
    context.events.on('process:stopped', this.removeChecks.bind(this));
  }
  
  private addChecks(processName: string, config: ProcessConfig): void {
    if (!config.healthCheck) return;
    
    const checks = this.createChecks(config.healthCheck);
    this.checks.set(processName, checks);
    
    // Start health check interval
    const interval = setInterval(
      () => this.runChecks(processName),
      config.healthCheck.interval || 30000
    );
    this.intervals.set(processName, interval);
  }
  
  private createChecks(config: HealthCheckConfig): HealthCheck[] {
    const check = this.buildCheck(config);
    return [check];
  }
  
  private buildCheck(config: HealthCheckConfig): HealthCheck {
    switch (config.type) {
      case 'http':
        return new HttpHealthCheck(config);
      case 'tcp':
        return new TcpHealthCheck(config);
      case 'script':
        return new ScriptHealthCheck(config);
      // ... other types
      default:
        return new ProcessHealthCheck(config);
    }
  }
  
  private async runChecks(processName: string): Promise<void> {
    const checks = this.checks.get(processName);
    if (!checks) return;
    
    for (const check of checks) {
      const result = await check.check();
      this.handleResult(processName, check, result);
    }
  }
}

// Health check implementations
class HttpHealthCheck implements HealthCheck {
  async check(): Promise<HealthResult> {
    return new Promise((resolve) => {
      const req = http.request({
        method: this.config.method || 'GET',
        hostname: this.parseHost().hostname,
        port: this.parseHost().port,
        path: this.parseHost().path,
        timeout: this.config.timeout || 5000,
        headers: this.config.headers
      }, (res) => {
        const healthy = this.isHealthyStatus(res.statusCode);
        resolve({ healthy, statusCode: res.statusCode });
      });
      
      req.on('error', () => resolve({ healthy: false }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ healthy: false, reason: 'timeout' });
      });
      
      req.end();
    });
  }
}
```

### 5.3 Log Manager Plugin (packages/plugins/log-manager/src/)

```typescript
export class LogManagerPlugin implements Plugin {
  name = 'log-manager';
  version = '1.0.0';
  priority = 15;
  dependencies = ['process-manager'];
  
  private streams = new Map<string, LogStream>();
  private writers = new Map<string, LogWriter>();
  
  install(context: PluginContext): void {
    context.events.on('process:started', this.attachLogHandlers.bind(this));
  }
  
  private attachLogHandlers(name: string, process: ManagedProcess): void {
    const config = process.config;
    const writer = new LogWriter({
      logFile: config.logFile || `./logs/${name}.log`,
      errorLogFile: config.errorLogFile,
      rotation: config.logRotation,
      format: config.logFormat || 'json'
    });
    
    this.writers.set(name, writer);
    
    // Attach to stdout/stderr
    process.onStdout((data) => {
      writer.write({
        timestamp: new Date().toISOString(),
        level: 'info',
        source: 'stdout',
        message: data.toString(),
        processName: name,
        pid: process.pid
      });
    });
    
    process.onStderr((data) => {
      writer.write({
        timestamp: new Date().toISOString(),
        level: 'error',
        source: 'stderr',
        message: data.toString(),
        processName: name,
        pid: process.pid
      });
    });
  }
}

// Log writer with rotation
class LogWriter {
  private currentStream?: WriteStream;
  private currentSize = 0;
  private rotationTimer?: NodeJS.Timeout;
  
  constructor(private config: LogWriterConfig) {
    this.initialize();
  }
  
  private initialize(): void {
    this.openStream();
    this.setupRotation();
  }
  
  private openStream(): void {
    this.currentStream = createWriteStream(this.config.logFile, { flags: 'a' });
    this.currentSize = statSync(this.config.logFile).size || 0;
  }
  
  write(entry: LogEntry): void {
    const line = this.format(entry);
    const buffer = Buffer.from(line + '\n');
    
    this.currentStream?.write(buffer);
    this.currentSize += buffer.length;
    
    // Check size-based rotation
    if (this.shouldRotateBySize()) {
      this.rotate();
    }
  }
  
  private shouldRotateBySize(): boolean {
    const maxSize = this.parseSize(this.config.rotation?.maxSize);
    return maxSize > 0 && this.currentSize >= maxSize;
  }
  
  private rotate(): void {
    // Close current stream
    this.currentStream?.end();
    
    // Rotate files: app.log -> app.log.1 -> app.log.2.gz
    this.rotateFiles();
    
    // Open new stream
    this.openStream();
    this.currentSize = 0;
  }
  
  private format(entry: LogEntry): string {
    if (this.config.format === 'json') {
      return JSON.stringify(entry);
    }
    // Simple format: timestamp [level] message
    return `${entry.timestamp} [${entry.level.toUpperCase()}] ${entry.message}`;
  }
}
```

### 5.4 Config Manager Plugin (packages/plugins/config-manager/src/)

```typescript
export class ConfigManagerPlugin implements Plugin {
  name = 'config-manager';
  version = '1.0.0';
  priority = 5; // Load early
  
  private config: DaemonConfig;
  private loadedPath?: string;
  
  async onStart(context: PluginContext): Promise<void> {
    // Discover and load config
    this.config = await this.loadConfig();
    context.events.emit('config:loaded', this.config);
    
    // Apply defaults to process configs
    for (const app of this.config.apps || []) {
      this.applyDefaults(app);
    }
  }
  
  private async loadConfig(): Promise<DaemonConfig> {
    // Try config files in priority order
    const candidates = [
      'opendaemon.config.ts',
      'opendaemon.config.js',
      'opendaemon.config.cjs',
      'opendaemon.config.json',
      'opendaemon.config.yaml',
      '.opendaemonrc',
    ];
    
    for (const candidate of candidates) {
      const config = await this.tryLoad(candidate);
      if (config) {
        this.loadedPath = candidate;
        return this.validate(config);
      }
    }
    
    // Try package.json
    const pkgConfig = await this.tryLoadPackageJson();
    if (pkgConfig) {
      return this.validate(pkgConfig);
    }
    
    // Return default config
    return this.getDefaultConfig();
  }
  
  private async tryLoad(path: string): Promise<DaemonConfig | null> {
    if (!existsSync(path)) return null;
    
    if (path.endsWith('.ts')) {
      // Use ts-node or similar for TypeScript
      const module = await import(path);
      return module.default || module;
    }
    
    if (path.endsWith('.js') || path.endsWith('.cjs')) {
      const module = await import(path);
      return module.default || module;
    }
    
    if (path.endsWith('.json') || path.endsWith('.rc')) {
      const content = await readFile(path, 'utf-8');
      return JSON.parse(content);
    }
    
    if (path.endsWith('.yaml') || path.endsWith('.yml')) {
      const content = await readFile(path, 'utf-8');
      return this.parseYaml(content);
    }
    
    return null;
  }
  
  private parseYaml(content: string): unknown {
    // YAML parser from scratch (no external lib)
    const parser = new YamlParser();
    return parser.parse(content);
  }
  
  private validate(config: unknown): DaemonConfig {
    // JSON Schema validation (from scratch)
    const validator = new JsonSchemaValidator(CONFIG_SCHEMA);
    const result = validator.validate(config);
    
    if (!result.valid) {
      throw new ConfigValidationError(result.errors);
    }
    
    return config as DaemonConfig;
  }
}

// YAML Parser (from scratch)
class YamlParser {
  parse(content: string): unknown {
    // Implement YAML parsing
    // Handle: scalars, sequences, mappings
    // Handle: comments, multiline strings
    // Return parsed object
  }
}
```

## 6. CLI Implementation

### 6.1 Command Parser (packages/cli/src/parser.ts)

```typescript
// CLI parser from scratch (no commander)
export class CommandParser {
  private commands = new Map<string, Command>();
  private globalOptions = new Map<string, Option>();
  
  register(name: string, command: Command): void {
    this.commands.set(name, command);
  }
  
  parse(args: string[]): ParsedCommand {
    const result: ParsedCommand = {
      command: '',
      subcommand: '',
      args: [],
      options: {}
    };
    
    let i = 0;
    
    // Parse global options
    while (i < args.length && args[i].startsWith('-')) {
      const option = this.parseOption(args, i);
      result.options[option.name] = option.value;
      i = option.nextIndex;
    }
    
    // Parse command
    if (i < args.length) {
      result.command = args[i++];
    }
    
    // Parse subcommand
    if (i < args.length && !args[i].startsWith('-')) {
      result.subcommand = args[i++];
    }
    
    // Parse command options and args
    while (i < args.length) {
      if (args[i].startsWith('-')) {
        const option = this.parseOption(args, i);
        result.options[option.name] = option.value;
        i = option.nextIndex;
      } else {
        result.args.push(args[i++]);
      }
    }
    
    return result;
  }
}
```

### 6.2 Terminal Output (packages/cli/src/output.ts)

```typescript
// Terminal formatting from scratch (no chalk, no colors package)
export class TerminalOutput {
  private isTTY = process.stdout.isTTY;
  private noColor = process.env.NO_COLOR !== undefined;
  
  private codes = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
  };
  
  color(code: keyof typeof this.codes, text: string): string {
    if (!this.isTTY || this.noColor) return text;
    return `${this.codes[code]}${text}${this.codes.reset}`;
  }
  
  table(headers: string[], rows: string[][]): string {
    // Calculate column widths
    const widths = headers.map((h, i) => {
      const maxRow = Math.max(...rows.map(r => (r[i] || '').length));
      return Math.max(h.length, maxRow);
    });
    
    // Build table
    let output = '';
    
    // Header row
    output += '| ' + headers.map((h, i) => h.padEnd(widths[i])).join(' | ') + ' |\n';
    output += '|' + widths.map(w => '-'.repeat(w + 2)).join('|') + '|\n';
    
    // Data rows
    for (const row of rows) {
      output += '| ' + row.map((cell, i) => (cell || '').padEnd(widths[i])).join(' | ') + ' |\n';
    }
    
    return output;
  }
  
  spinner(text: string): Spinner {
    return new Spinner(text, this);
  }
  
  progress(total: number): ProgressBar {
    return new ProgressBar(total, this);
  }
}

class Spinner {
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private frame = 0;
  private interval?: NodeJS.Timeout;
  
  start(): void {
    this.interval = setInterval(() => {
      process.stdout.write(`\r${this.frames[this.frame]} ${this.text}`);
      this.frame = (this.frame + 1) % this.frames.length;
    }, 80);
  }
  
  stop(success = true): void {
    clearInterval(this.interval);
    const symbol = success ? '✓' : '✗';
    process.stdout.write(`\r${symbol} ${this.text}\n`);
  }
}
```

### 6.3 Commands Implementation

```typescript
// packages/cli/src/commands/start.ts
export class StartCommand implements Command {
  name = 'start';
  description = 'Start a process or processes from config';
  
  options = [
    { name: 'name', alias: 'n', type: 'string' },
    { name: 'instances', alias: 'i', type: 'number' },
    { name: 'max-memory', type: 'string' },
    { name: 'env', type: 'array' },
    { name: 'json', type: 'boolean' },
    { name: 'attach', alias: 'a', type: 'boolean' },
  ];
  
  async execute(args: string[], options: Record<string, unknown>): Promise<void> {
    const client = await this.connect();
    
    if (args.length === 0) {
      throw new Error('Script or config file required');
    }
    
    const target = args[0];
    
    // Check if it's a config file
    if (target.endsWith('.ts') || target.endsWith('.js') || 
        target.endsWith('.json') || target.endsWith('.yaml')) {
      await this.startFromConfig(target, options);
    } else {
      // Single script
      const config = this.buildConfig(target, options);
      const result = await client.call('process.start', config);
      this.output(result, options.json as boolean);
    }
  }
  
  private buildConfig(script: string, options: Record<string, unknown>): ProcessConfig {
    return {
      name: (options.name as string) || basename(script, extname(script)),
      script,
      instances: options.instances as number || 1,
      maxMemory: options['max-memory'] as string,
      env: this.parseEnv(options.env as string[]),
    };
  }
}

// packages/cli/src/commands/list.ts
export class ListCommand implements Command {
  name = 'list';
  aliases = ['ls'];
  description = 'List all processes';
  
  options = [
    { name: 'json', type: 'boolean' },
    { name: 'quiet', alias: 'q', type: 'boolean' },
  ];
  
  async execute(_args: string[], options: Record<string, unknown>): Promise<void> {
    const client = await this.connect();
    const processes = await client.call('process.list') as ProcessInfo[];
    
    if (options.json) {
      console.log(JSON.stringify(processes, null, 2));
      return;
    }
    
    if (options.quiet) {
      for (const proc of processes) {
        console.log(proc.name);
      }
      return;
    }
    
    // Table output
    const term = new TerminalOutput();
    const headers = ['ID', 'Name', 'Mode', '↺', 'Status', 'CPU', 'Memory', 'Uptime'];
    const rows = processes.map(p => [
      String(p.id),
      p.name,
      p.mode === 'cluster' ? `cluster/${p.instances}` : 'fork',
      String(p.restartCount),
      term.color(this.getStatusColor(p.status), p.status),
      `${p.cpu.toFixed(1)}%`,
      this.formatBytes(p.memory),
      this.formatDuration(p.uptime),
    ]);
    
    console.log(term.table(headers, rows));
  }
  
  private getStatusColor(status: ProcessStatus): keyof TerminalOutput['codes'] {
    switch (status) {
      case 'online': return 'green';
      case 'stopping': return 'yellow';
      case 'errored': return 'red';
      default: return 'gray';
    }
  }
}
```

## 7. TUI Dashboard Implementation

### 7.1 Terminal UI (packages/plugins/tui-dashboard/src/)

```typescript
export class TuiDashboardPlugin implements Plugin {
  name = 'tui-dashboard';
  version = '1.0.0';
  priority = 100; // Load last
  
  private dashboard?: Dashboard;
  
  install(context: PluginContext): void {
    context.registerMethod('dashboard.start', () => {
      this.dashboard = new Dashboard(context);
      this.dashboard.start();
    });
  }
}

class Dashboard {
  private screen: Screen;
  private processList: ProcessList;
  private metricsPanel: MetricsPanel;
  private logPanel: LogPanel;
  private selectedIndex = 0;
  
  constructor(private context: PluginContext) {
    this.screen = new Screen();
    this.processList = new ProcessList(context);
    this.metricsPanel = new MetricsPanel(context);
    this.logPanel = new LogPanel(context);
  }
  
  start(): void {
    // Hide cursor, enable raw mode
    this.screen.enterRawMode();
    
    // Initial render
    this.render();
    
    // Event handlers
    this.context.events.on('process:updated', () => this.render());
    this.context.events.on('metric:updated', () => this.render());
    
    // Keyboard input
    process.stdin.on('data', (data) => {
      this.handleInput(data);
    });
  }
  
  private handleInput(data: Buffer): void {
    const key = data.toString();
    
    switch (key) {
      case '\x03': // Ctrl+C
      case 'q':
        this.quit();
        break;
      case '\x1b[A': // Up arrow
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        this.render();
        break;
      case '\x1b[B': // Down arrow
        this.selectedIndex++;
        this.render();
        break;
      case 'r':
        this.restartSelected();
        break;
      case 's':
        this.stopSelected();
        break;
      case 'l':
        this.showLogs();
        break;
    }
  }
  
  private render(): void {
    const processes = this.context.store.get<ProcessInfo[]>('processes') || [];
    const selected = processes[this.selectedIndex];
    
    // Clear screen
    this.screen.clear();
    
    // Header
    this.renderHeader();
    
    // Process list
    this.processList.render(0, 2, processes, this.selectedIndex);
    
    // Metrics panel (selected process)
    if (selected) {
      this.metricsPanel.render(0, 10, selected);
    }
    
    // Recent logs
    this.logPanel.render(0, 20);
    
    // Footer
    this.renderFooter();
  }
  
  private renderHeader(): void {
    const version = this.context.store.get<string>('version');
    const cpu = this.context.store.get<number>('system.cpu') || 0;
    const memory = this.context.store.get<number>('system.memory') || 0;
    const uptime = this.context.store.get<number>('daemon.uptime') || 0;
    
    this.screen.writeLine(0, 0, 
      `OpenDaemon v${version} — cpu: ${cpu.toFixed(0)}% — mem: ${this.formatBytes(memory)} — uptime: ${this.formatDuration(uptime)}`
    );
  }
  
  private renderFooter(): void {
    this.screen.writeLine(0, process.stdout.rows - 1,
      '[↑↓] Navigate  [Enter] Details  [r] Restart  [s] Stop  [l] Logs  [q] Quit'
    );
  }
}

// Screen abstraction for ANSI escape sequences
class Screen {
  enterRawMode(): void {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
  }
  
  clear(): void {
    process.stdout.write('\x1b[2J\x1b[H'); // Clear + home
  }
  
  writeLine(x: number, y: number, text: string): void {
    process.stdout.write(`\x1b[${y + 1};${x + 1}H${text}`);
  }
  
  drawBox(x: number, y: number, width: number, height: number): void {
    // Draw box using box-drawing characters
    const top = '┌' + '─'.repeat(width - 2) + '┐';
    const middle = '│' + ' '.repeat(width - 2) + '│';
    const bottom = '└' + '─'.repeat(width - 2) + '┘';
    
    this.writeLine(x, y, top);
    for (let i = 1; i < height - 1; i++) {
      this.writeLine(x, y + i, middle);
    }
    this.writeLine(x, y + height - 1, bottom);
  }
}

// Sparkline graph (ASCII art)
class Sparkline {
  private values: number[] = [];
  private maxPoints: number;
  
  constructor(maxPoints = 20) {
    this.maxPoints = maxPoints;
  }
  
  push(value: number): void {
    this.values.push(value);
    if (this.values.length > this.maxPoints) {
      this.values.shift();
    }
  }
  
  render(width: number): string {
    const chars = '▁▂▃▄▅▆▇█';
    const max = Math.max(...this.values, 1);
    const min = Math.min(...this.values);
    const range = max - min || 1;
    
    return this.values
      .slice(-width)
      .map(v => {
        const normalized = (v - min) / range;
        const index = Math.floor(normalized * (chars.length - 1));
        return chars[index];
      })
      .join('');
  }
}
```

## 8. HTTP Server Implementation (from scratch)

### 8.1 REST API Server (packages/plugins/api-server/src/)

```typescript
export class ApiServerPlugin implements Plugin {
  name = 'api-server';
  version = '1.0.0';
  priority = 50;
  
  private server?: http.Server;
  private router = new Router();
  
  install(context: PluginContext): void {
    this.setupRoutes(context);
  }
  
  async onStart(context: PluginContext): Promise<void> {
    const port = context.pluginConfig?.port || 9615;
    
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });
    
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, (err?: Error) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    context.logger.info(`API server listening on port ${port}`);
  }
  
  private setupRoutes(context: PluginContext): void {
    // GET /api/v1/processes
    this.router.get('/api/v1/processes', async (req, res) => {
      const processes = await context.getPlugin('process-manager')?.list();
      res.json(processes);
    });
    
    // GET /api/v1/processes/:name
    this.router.get('/api/v1/processes/:name', async (req, res) => {
      const info = await context.getPlugin('process-manager')?.info(req.params.name);
      if (!info) {
        res.status(404).json({ error: 'Process not found' });
        return;
      }
      res.json(info);
    });
    
    // POST /api/v1/processes
    this.router.post('/api/v1/processes', async (req, res) => {
      const config = await req.json();
      const result = await context.getPlugin('process-manager')?.start(config);
      res.status(201).json(result);
    });
    
    // PUT /api/v1/processes/:name/stop
    this.router.put('/api/v1/processes/:name/stop', async (req, res) => {
      await context.getPlugin('process-manager')?.stop(req.params.name);
      res.status(204).end();
    });
    
    // GET /api/v1/metrics
    this.router.get('/api/v1/metrics', async (_req, res) => {
      const metrics = await context.getPlugin('metrics-collector')?.getPrometheusMetrics();
      res.setHeader('Content-Type', 'text/plain');
      res.end(metrics);
    });
    
    // WebSocket upgrade
    this.server?.on('upgrade', (request, socket, head) => {
      this.handleWebSocket(request, socket, head);
    });
  }
  
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Parse URL and route
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const route = this.router.match(req.method || 'GET', url.pathname);
    
    if (!route) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    
    // Parse body for POST/PUT
    let body: unknown;
    if (req.method === 'POST' || req.method === 'PUT') {
      body = await this.parseBody(req);
    }
    
    // Call handler
    const requestContext = {
      params: route.params,
      query: Object.fromEntries(url.searchParams),
      body,
      headers: req.headers,
    };
    
    await route.handler(requestContext, res);
  }
  
  private parseBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
      req.on('error', reject);
    });
  }
}

// Simple router (no express)
class Router {
  private routes: Route[] = [];
  
  get(path: string, handler: RouteHandler): void {
    this.routes.push({ method: 'GET', path, handler, pattern: this.compilePattern(path) });
  }
  
  post(path: string, handler: RouteHandler): void {
    this.routes.push({ method: 'POST', path, handler, pattern: this.compilePattern(path) });
  }
  
  put(path: string, handler: RouteHandler): void {
    this.routes.push({ method: 'PUT', path, handler, pattern: this.compilePattern(path) });
  }
  
  delete(path: string, handler: RouteHandler): void {
    this.routes.push({ method: 'DELETE', path, handler, pattern: this.compilePattern(path) });
  }
  
  private compilePattern(path: string): RegExp {
    // Convert /api/v1/processes/:name to regex
    const pattern = path
      .replace(/:([^/]+)/g, '(?<$1>[^/]+)')
      .replace(/\*/g, '.*');
    return new RegExp(`^${pattern}$`);
  }
  
  match(method: string, path: string): MatchedRoute | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      
      const match = route.pattern.exec(path);
      if (match) {
        return {
          handler: route.handler,
          params: match.groups || {}
        };
      }
    }
    return null;
  }
}
```

### 8.2 WebSocket Server (from scratch)

```typescript
class WebSocketServer {
  private clients = new Set<net.Socket>();
  
  handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    // WebSocket handshake
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    
    // Calculate accept key
    const acceptKey = this.generateAcceptKey(key);
    
    // Send handshake response
    const response = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '',
      ''
    ].join('\r\n');
    
    socket.write(response);
    
    // Handle WebSocket frames
    this.clients.add(socket);
    socket.on('data', (data) => this.handleFrame(socket, data));
    socket.on('close', () => this.clients.delete(socket));
  }
  
  private handleFrame(socket: net.Socket, data: Buffer): void {
    // Parse WebSocket frame
    const opcode = data[0] & 0x0f;
    const masked = (data[1] & 0x80) !== 0;
    let length = data[1] & 0x7f;
    let offset = 2;
    
    if (length === 126) {
      length = data.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      length = data.readUInt32BE(2) * 0x100000000 + data.readUInt32BE(6);
      offset = 10;
    }
    
    let mask: Buffer | undefined;
    if (masked) {
      mask = data.slice(offset, offset + 4);
      offset += 4;
    }
    
    let payload = data.slice(offset, offset + length);
    if (mask) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i % 4];
      }
    }
    
    // Handle opcode
    switch (opcode) {
      case 0x01: // Text frame
        this.handleMessage(socket, payload.toString());
        break;
      case 0x08: // Close
        socket.end();
        break;
      case 0x09: // Ping
        this.sendPong(socket);
        break;
    }
  }
  
  private handleMessage(socket: net.Socket, message: string): void {
    try {
      const data = JSON.parse(message);
      if (data.subscribe) {
        // Subscribe to events
        this.subscribe(socket, data.subscribe);
      }
    } catch {
      // Invalid JSON, ignore
    }
  }
  
  broadcast(event: string, data: unknown): void {
    const message = JSON.stringify({ event, data });
    const frame = this.encodeFrame(message);
    
    for (const client of this.clients) {
      client.write(frame);
    }
  }
  
  private encodeFrame(message: string): Buffer {
    const payload = Buffer.from(message);
    let frame: Buffer;
    
    if (payload.length < 126) {
      frame = Buffer.alloc(2);
      frame[0] = 0x81; // FIN + text opcode
      frame[1] = payload.length;
      frame = Buffer.concat([frame, payload]);
    } else if (payload.length < 65536) {
      frame = Buffer.alloc(4);
      frame[0] = 0x81;
      frame[1] = 126;
      frame.writeUInt16BE(payload.length, 2);
      frame = Buffer.concat([frame, payload]);
    } else {
      frame = Buffer.alloc(10);
      frame[0] = 0x81;
      frame[1] = 127;
      frame.writeUInt32BE(0, 2);
      frame.writeUInt32BE(payload.length, 6);
      frame = Buffer.concat([frame, payload]);
    }
    
    return frame;
  }
  
  private generateAcceptKey(key: string): string {
    const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
    return createHash('sha1')
      .update(key + GUID)
      .digest('base64');
  }
}
```

## 9. Testing Strategy

### 9.1 Unit Testing (Vitest)

```typescript
// tests/unit/kernel.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Kernel } from '../../packages/core/src/kernel';

describe('Kernel', () => {
  let kernel: Kernel;
  
  beforeEach(() => {
    kernel = new Kernel();
  });
  
  it('should start with no plugins', async () => {
    await kernel.start({});
    expect(kernel.getState()).toBe('ready');
  });
  
  it('should register and load plugins', async () => {
    const plugin = createMockPlugin('test-plugin');
    kernel.registerPlugin(plugin);
    
    await kernel.start({});
    expect(kernel.getPlugin('test-plugin')).toBe(plugin);
  });
  
  it('should resolve plugin dependencies', async () => {
    const pluginA = createMockPlugin('plugin-a', { priority: 10 });
    const pluginB = createMockPlugin('plugin-b', { 
      priority: 20, 
      dependencies: ['plugin-a'] 
    });
    
    kernel.registerPlugin(pluginB);
    kernel.registerPlugin(pluginA);
    
    const order: string[] = [];
    pluginA.install = () => order.push('a');
    pluginB.install = () => order.push('b');
    
    await kernel.start({});
    expect(order).toEqual(['a', 'b']);
  });
  
  it('should detect circular dependencies', async () => {
    const pluginA = createMockPlugin('plugin-a', { dependencies: ['plugin-b'] });
    const pluginB = createMockPlugin('plugin-b', { dependencies: ['plugin-a'] });
    
    kernel.registerPlugin(pluginA);
    kernel.registerPlugin(pluginB);
    
    await expect(kernel.start({})).rejects.toThrow('Circular dependency');
  });
});

// tests/unit/event-bus.test.ts
describe('EventBus', () => {
  let bus: EventBus;
  
  beforeEach(() => {
    bus = new EventBus();
  });
  
  it('should emit and receive events', () => {
    const handler = vi.fn();
    bus.on('test', handler);
    bus.emit('test', { data: 123 });
    expect(handler).toHaveBeenCalledWith({ data: 123 });
  });
  
  it('should support wildcards', () => {
    const handler = vi.fn();
    bus.on('process:*', handler);
    bus.emit('process:started', { name: 'test' });
    bus.emit('process:stopped', { name: 'test' });
    expect(handler).toHaveBeenCalledTimes(2);
  });
  
  it('should unsubscribe correctly', () => {
    const handler = vi.fn();
    const unsubscribe = bus.on('test', handler);
    unsubscribe();
    bus.emit('test');
    expect(handler).not.toHaveBeenCalled();
  });
  
  it('should handle async emit', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    bus.on('test', handler);
    await bus.emitAsync('test', { data: 123 });
    expect(handler).toHaveBeenCalled();
  });
});
```

### 9.2 Integration Testing

```typescript
// tests/integration/process-lifecycle.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Kernel } from '../../packages/core/src/kernel';
import { ProcessManagerPlugin } from '../../packages/plugins/process-manager/src';

describe('Process Lifecycle', () => {
  let kernel: Kernel;
  let processManager: ProcessManagerPlugin;
  
  beforeAll(async () => {
    kernel = new Kernel();
    processManager = new ProcessManagerPlugin();
    kernel.registerPlugin(processManager);
    await kernel.start({});
  });
  
  afterAll(async () => {
    await kernel.stop();
  });
  
  it('should start and stop a simple process', async () => {
    const script = createTestScript('console.log("Hello"); setTimeout(() => {}, 1000)');
    
    const process = await processManager.start({
      name: 'test-process',
      script,
    });
    
    expect(process.status).toBe('online');
    
    await processManager.stop('test-process');
    const info = await processManager.info('test-process');
    expect(info?.status).toBe('stopped');
  });
  
  it('should handle process crashes', async () => {
    const script = createTestScript('throw new Error("Crash")');
    
    const process = await processManager.start({
      name: 'crash-test',
      script,
      autoRestart: false,
    });
    
    // Wait for crash
    await waitFor(() => process.status === 'errored', 5000);
    expect(process.status).toBe('errored');
  });
  
  it('should auto-restart crashed processes', async () => {
    const script = createTestScript('if (!process.env.RESTARTED) { process.env.RESTARTED = "1"; throw new Error("Crash"); }');
    
    const process = await processManager.start({
      name: 'restart-test',
      script,
      autoRestart: true,
      maxRestarts: 3,
    });
    
    // Wait for restart
    await waitFor(() => process.restartCount > 0, 5000);
    expect(process.restartCount).toBeGreaterThan(0);
  });
});
```

### 9.3 E2E Testing

```typescript
// tests/e2e/cli.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { resolve } from 'path';

describe('CLI E2E', () => {
  const cliPath = resolve(__dirname, '../../packages/cli/dist/index.js');
  
  it('should show version', async () => {
    const result = await runCommand(['--version']);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });
  
  it('should start daemon', async () => {
    const result = await runCommand(['daemon', 'start']);
    expect(result.exitCode).toBe(0);
    
    // Verify daemon is running
    const status = await runCommand(['daemon', 'status']);
    expect(status.stdout).toContain('running');
  });
  
  it('should list processes', async () => {
    const result = await runCommand(['list']);
    expect(result.exitCode).toBe(0);
  });
  
  async function runCommand(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      const proc = spawn('node', [cliPath, ...args], { encoding: 'utf8' });
      let stdout = '';
      let stderr = '';
      
      proc.stdout?.on('data', (data) => stdout += data);
      proc.stderr?.on('data', (data) => stderr += data);
      proc.on('close', (exitCode) => {
        resolve({ stdout, stderr, exitCode: exitCode || 0 });
      });
    });
  }
});
```

## 10. Build & Packaging

### 10.1 Build Configuration (tsup.config.ts)

```typescript
import { defineConfig } from 'tsup';

export default defineConfig([
  // Core package
  {
    entry: ['packages/core/src/index.ts'],
    outDir: 'packages/core/dist',
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    bundle: true,
    target: 'node20',
  },
  // CLI package
  {
    entry: ['packages/cli/src/index.ts'],
    outDir: 'packages/cli/dist',
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: true,
    bundle: true,
    target: 'node20',
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  // SDK package
  {
    entry: ['packages/sdk/src/index.ts'],
    outDir: 'packages/sdk/dist',
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    bundle: true,
    target: 'node20',
  },
  // Plugins (build each individually)
  ...getPluginConfigs(),
]);

function getPluginConfigs() {
  const plugins = [
    'process-manager',
    'health-check',
    'log-manager',
    'metrics-collector',
    'cluster-manager',
    'deploy-strategy',
    'config-manager',
    'secret-manager',
    'scheduler',
    'watch-mode',
    'notification',
    'dependency-resolver',
    'resource-limiter',
    'audit-logger',
    'startup-manager',
    'tui-dashboard',
    'api-server',
  ];
  
  return plugins.map(name => ({
    entry: [`packages/plugins/${name}/src/index.ts`],
    outDir: `packages/plugins/${name}/dist`,
    format: ['esm', 'cjs'] as const,
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    bundle: true,
    target: 'node20' as const,
    external: ['@opendaemon/core'],
  }));
}
```

### 10.2 Package.json

```json
{
  "name": "opendaemon",
  "version": "1.0.0",
  "description": "Next-generation process manager for Node.js",
  "type": "module",
  "main": "./packages/core/dist/index.cjs",
  "module": "./packages/core/dist/index.js",
  "types": "./packages/core/dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./packages/core/dist/index.js",
      "require": "./packages/core/dist/index.cjs",
      "types": "./packages/core/dist/index.d.ts"
    },
    "./sdk": {
      "import": "./packages/sdk/dist/index.js",
      "require": "./packages/sdk/dist/index.cjs",
      "types": "./packages/sdk/dist/index.d.ts"
    },
    "./runtime": {
      "import": "./packages/sdk/dist/runtime.js",
      "require": "./packages/sdk/dist/runtime.cjs",
      "types": "./packages/sdk/dist/runtime.d.ts"
    }
  },
  "bin": {
    "od": "./packages/cli/dist/index.js",
    "opendaemon": "./packages/cli/dist/index.js"
  },
  "files": [
    "packages/*/dist/**"
  ],
  "engines": {
    "node": ">=20.0.0"
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest",
    "test:coverage": "vitest --coverage",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "format": "prettier --write .",
    "prepublishOnly": "npm run build && npm run test"
  },
  "dependencies": {},
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsup": "^8.0.0",
    "vitest": "^3.0.0",
    "@vitest/coverage-v8": "^3.0.0",
    "@types/node": "^22.0.0",
    "eslint": "^9.0.0",
    "prettier": "^3.0.0"
  },
  "keywords": [
    "process-manager",
    "daemon",
    "pm2",
    "cluster",
    "deployment",
    "monitoring",
    "typescript"
  ],
  "author": "Ersin Koç <ersin@opendaemon.dev>",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/opendaemon/opendaemon.git"
  },
  "bugs": {
    "url": "https://github.com/opendaemon/opendaemon/issues"
  },
  "homepage": "https://opendaemon.dev"
}
```

## 11. Development Workflow

### 11.1 Local Development

```bash
# Clone repository
git clone https://github.com/opendaemon/opendaemon.git
cd opendaemon

# Install dev dependencies
npm install

# Run in development mode (watch)
npm run dev

# Run tests in watch mode
npm run test -- --watch

# Type checking
npm run typecheck

# Linting
npm run lint

# Format code
npm run format
```

### 11.2 Release Process

```bash
# Version bump
npm version [major|minor|patch]

# Build and test
npm run build
npm run test:coverage

# Publish to npm
npm publish

# Create GitHub release
gh release create v1.0.0 --notes "Release notes"
```

### 11.3 CI/CD Pipeline (.github/workflows/ci.yml)

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
        node-version: [20.x, 22.x]
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
      
      - name: Install dependencies
        run: npm ci
      
      - name: Type check
        run: npm run typecheck
      
      - name: Lint
        run: npm run lint
      
      - name: Test
        run: npm run test:coverage
      
      - name: Upload coverage
        uses: codecov/codecov-action@v3
  
  build:
    runs-on: ubuntu-latest
    needs: test
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20.x
      
      - name: Install dependencies
        run: npm ci
      
      - name: Build
        run: npm run build
      
      - name: Test build
        run: node ./packages/cli/dist/index.js --version
```

## 12. Migration from PM2

### 12.1 Ecosystem File Migration

```typescript
// migrate-pm2.ts
import { readFileSync } from 'fs';

function migratePm2Config(pm2Path: string): string {
  const pm2Config = JSON.parse(readFileSync(pm2Path, 'utf-8'));
  
  const odConfig = {
    apps: pm2Config.apps.map((app: any) => ({
      name: app.name,
      script: app.script,
      cwd: app.cwd,
      args: app.args,
      instances: app.instances,
      exec_mode: app.exec_mode === 'cluster' ? 'cluster' : 'fork',
      env: app.env,
      env_production: app.env_production,
      max_memory_restart: app.max_memory_restart,
      min_uptime: app.min_uptime,
      max_restarts: app.max_restarts,
      autorestart: app.autorestart,
      cron_restart: app.cron_restart,
      watch: app.watch,
      ignore_watch: app.ignore_watch,
      merge_logs: app.merge_logs,
      log_file: app.log_file,
      out_file: app.out_file,
      error_file: app.error_file,
      pid_file: app.pid_file,
      kill_timeout: app.kill_timeout,
      listen_timeout: app.listen_timeout,
      wait_ready: app.wait_ready,
      // ... map other fields
    })),
  };
  
  return `export default ${JSON.stringify(odConfig, null, 2)}`;
}

// CLI command: od migrate-ecosystem ecosystem.config.js
```

## 13. Performance Optimizations

### 13.1 Memory Management
- Use object pools for frequently allocated objects
- Avoid closures that capture large scopes
- Clear intervals/timeouts properly
- Use WeakMap for plugin-private data
- Stream large data (logs, metrics) instead of buffering

### 13.2 Event Loop
- Keep synchronous operations under 10ms
- Use setImmediate for yielding
- Avoid sync fs operations
- Batch rapid events (log writes)

### 13.3 IPC Optimization
- Binary protocol for logs (not JSON)
- Connection pooling for multiple clients
- Compression for large payloads
- Zero-copy where possible

## 14. Security Considerations

### 14.1 Input Validation
- Validate all RPC parameters
- Sanitize file paths (prevent directory traversal)
- Limit message sizes
- Rate limit RPC calls

### 14.2 Secret Management
- Never log secrets
- Use constant-time comparison for tokens
- Clear secrets from memory after use
- Encrypt at rest with strong algorithm

### 14.3 Process Isolation
- Drop privileges after binding to low ports
- Use chroot where possible
- Limit file system access
- Restrict network access (future: cgroup/netns)

## 15. Future Enhancements

### 15.1 Planned Features (v2.x)
- Multi-host orchestration
- Service mesh integration
- Container support (Docker/Podman)
- Kubernetes operator
- Web-based dashboard
- Plugin marketplace

### 15.2 Experimental Features
- WebAssembly plugins
- eBPF integration
- Distributed tracing
- ML-based auto-scaling

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2025-02-21 | OpenDaemon Team | Initial implementation guide |
