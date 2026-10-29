/**
 * Health check action types
 */
export type HealthCheckAction = 'restart' | 'stop' | 'notify' | 'none';

/**
 * Health check type enumeration
 */
export type HealthCheckType =
  | 'process'
  | 'http'
  | 'https'
  | 'tcp'
  | 'script'
  | 'grpc'
  | 'command'
  | 'composite'
  | 'memory'
  | 'cpu';

/**
 * HTTP/HTTPS health check configuration
 */
export interface HttpHealthCheckConfig {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  expectedStatus?: number | number[];
  expectedBody?: string | RegExp;
}

/**
 * TCP health check configuration
 */
export interface TcpHealthCheckConfig {
  host?: string;
  port: number;
}

/**
 * Script/Command health check configuration
 */
export interface ScriptHealthCheckConfig {
  command: string;
  args?: string[];
}

/**
 * Composite health check configuration
 */
export interface CompositeHealthCheckConfig {
  checks: HealthCheckConfig[];
  operator?: 'and' | 'or';
}

/**
 * Health check configuration
 */
export interface HealthCheckConfig {
  type: HealthCheckType;
  interval?: number;
  timeout?: number;
  failureThreshold?: number;
  successThreshold?: number;
  initialDelay?: number;
  action?: HealthCheckAction;

  // Type-specific configs
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  expectedStatus?: number | number[];
  expectedBody?: string | RegExp;
  host?: string;
  port?: number;
  command?: string;
  args?: string[];
  checks?: HealthCheckConfig[];
  operator?: 'and' | 'or';
  /** memory: bytes or a size string such as '512M'; cpu: percent */
  threshold?: number | string;
  /** https: set to false to accept self-signed certificates (default: true) */
  rejectUnauthorized?: boolean;
}

/**
 * Secret reference in configuration
 */
export interface SecretReference {
  secret: string;
  version?: number;
}

/**
 * Environment variable value
 */
export type EnvValue = string | SecretReference;

/**
 * What to do when a limit is exceeded
 */
export type LimitAction = 'warn' | 'restart' | 'stop';

export interface ResourceLimits {
  memory?: {
    /** Resident memory of all instances together: bytes or a size such as '512M' */
    max: string | number;
    /** Default: restart */
    action?: LimitAction;
    /** The limit must stay exceeded this long (ms) before the action runs (default 0) */
    grace?: number;
  };
  cpu?: {
    /** Percent of one core, all instances together */
    max: number;
    /** The limit must stay exceeded this long (ms) before the action runs (default 60000) */
    duration?: number;
    /** Default: warn */
    action?: LimitAction;
  };
}

/**
 * Process restart strategy
 */
export type RestartStrategy = 'always' | 'on-failure' | 'unless-stopped' | 'never';

/**
 * Backoff strategy for restarts
 */
export type BackoffStrategy = 'fixed' | 'linear' | 'exponential';

/**
 * Process execution mode
 */
export type ProcessMode = 'fork' | 'cluster';

export type DeployStrategy = 'rolling' | 'blue-green' | 'canary' | 'recreate';

/**
 * What a deploy changes: the code (script, args) and environment workers run with
 */
export interface Release {
  script?: string;
  args?: string[];
  /** Merged over the app's env */
  env?: Record<string, EnvValue>;
  /** Label shown in `od deploy status`; workers see it as OD_RELEASE */
  version?: string;
}

/**
 * How a new release replaces the running one (cluster mode, except `recreate`)
 */
export interface DeployConfig {
  strategy?: DeployStrategy;
  /** rolling: workers replaced at the same time (default 1). A new worker always starts before its predecessor stops */
  maxSurge?: number;
  /** canary: share of workers on the new release first, in percent (default 10) */
  canaryPercent?: number;
  /** canary: the ramp, ending in 100 (default [canaryPercent, 100]) */
  canarySteps?: number[];
  /** canary: how long each step is watched for crashes and failing health checks, in ms (default 10000) */
  canaryAnalysis?: { duration?: number };
  /** blue-green: how long the old workers may keep finishing requests after the switch, in ms (default killTimeout) */
  switchTimeout?: number;
  /** Per new worker: how long it may take to become ready (listening, `ready` message or stable), in ms (default 30000) */
  readyTimeout?: number;
  /** Put the previous release back when a deploy fails (default true) */
  rollbackOnFailure?: boolean;
  /** Longest a whole deploy may take, in ms (default 300000) */
  timeout?: number;
}

/**
 * Process configuration
 */
export interface ProcessConfig {
  name: string;
  script: string;
  cwd?: string;
  env?: Record<string, EnvValue>;
  instances?: number | 'max';
  mode?: ProcessMode;

  // Execution
  interpreter?: string;
  interpreterArgs?: string[];
  args?: string[];

  // Resource limits
  /** Shorthand for limits.memory { max, action: 'restart' } */
  maxMemory?: string | number;
  /** Shorthand for limits.cpu { max, action: 'warn', duration: 60000 } */
  maxCpu?: number;
  limits?: ResourceLimits;
  deploy?: DeployConfig;

  // Lifecycle
  autoRestart?: boolean | RestartStrategy;
  restartDelay?: number;
  maxRestarts?: number;
  minUptime?: number;
  killTimeout?: number;
  backoffStrategy?: BackoffStrategy;
  backoffMultiplier?: number;
  maxBackoffDelay?: number;

  // Health check
  healthCheck?: HealthCheckConfig;

  /** How long to wait for `dependencies` before giving up, in ms (default 60000) */
  dependencyTimeout?: number;

  // Logging
  logFile?: string;
  errorLogFile?: string;
  logLevel?: string;
  mergeLogs?: boolean;
  logRotation?: LogRotationConfig;

  // Advanced
  uid?: number | string;
  gid?: number | string;
  nice?: number;
  umask?: string | number;
  detached?: boolean;
  /**
   * Run as a scheduled job: not started with the daemon, started at each match of this cron
   * expression instead (the scheduler plugin owns its lifecycle; autoRestart is ignored)
   */
  cron?: string;
  /** IANA time zone for `cron` (default: the host's) */
  cronTimezone?: string;
  /** If the previous run is still going at the next tick: false skips it (default), true restarts it */
  cronOverlap?: boolean;
  /** Re-run a failed (non-zero exit) run up to this many times (default 0) */
  cronRetry?: number;
  watch?: boolean | WatchConfig;
  /** Apps that must be online (and healthy, if they have a health check) before this one starts */
  dependencies?: string[];

  // Metadata
  description?: string;
  version?: string;
}

/**
 * Log rotation configuration
 */
export interface LogRotationConfig {
  enabled?: boolean;
  maxSize?: string | number;
  maxFiles?: number;
  /** Rotate when the hour or day changes, in addition to maxSize */
  interval?: 'hourly' | 'daily';
  /** Delete rotated files older than this: milliseconds or '12h', '7d' */
  maxAge?: string | number;
  compress?: boolean;
  directory?: string;
  datePattern?: string;
}

/**
 * One line of process output, as written by the log-manager plugin (one JSON object per line)
 */
export interface ProcessLogEntry {
  /** ISO8601 timestamp */
  timestamp: string;
  /** stdout lines are `info`, stderr lines are `error` */
  level: 'info' | 'error';
  pid: number;
  processName: string;
  /** Worker index in cluster mode */
  instanceId?: number;
  message: string;
  source: 'stdout' | 'stderr';
}

/**
 * Point-in-time state of one application metric, as reported by the SDK runtime
 * (`opendaemon/runtime`) to the daemon over the process's IPC channel
 */
export interface MetricSnapshot {
  name: string;
  type: 'counter' | 'gauge' | 'histogram';
  help: string;
  series: Array<{
    labels: Record<string, string>;
    /** counter and gauge */
    value?: number;
    /** histogram: [upper bound, cumulative count]; the last bound is Infinity */
    buckets?: Array<[number, number]>;
    sum?: number;
    count?: number;
  }>;
}

/**
 * Watch mode configuration
 */
export interface WatchConfig {
  /** Default: the app's cwd, or its script's directory */
  paths?: string[];
  ignore?: string[];
  delay?: number;
  clearConsole?: boolean;
}

/**
 * Daemon configuration
 */
export interface DaemonConfig {
  daemon?: {
    pidFile?: string;
    logDir?: string;
    socketPath?: string;
    shutdownTimeout?: number;
    maxLogs?: number;
  };

  defaults?: Partial<ProcessConfig>;
  apps?: ProcessConfig[];
  plugins?: Record<string, unknown>;
}

/**
 * Process status enumeration
 */
export type ProcessStatus =
  | 'created'
  | 'starting'
  | 'online'
  | 'stopping'
  | 'stopped'
  | 'errored'
  | 'reloading'
  /** Not started yet: waiting for its dependencies to be ready */
  | 'waiting';

/**
 * Process information
 */
export interface ProcessInfo {
  id: number;
  name: string;
  status: ProcessStatus;
  mode: ProcessMode;
  instances: number;
  runningInstances: number;
  pid?: number | undefined;
  pids: number[];
  restartCount: number;
  uptime: number;
  cpu: number;
  memory: number;
  script: string;
  cwd?: string | undefined;
  createdAt: string;
  startedAt?: string | undefined;
  errorMessage?: string | undefined;
  env: Record<string, string>;
}

/**
 * Metric types
 */
export type MetricType = 'counter' | 'gauge' | 'histogram' | 'summary';

/**
 * Metric definition
 */
export interface MetricDefinition {
  name: string;
  type: MetricType;
  help: string;
  labels?: string[];
}

/**
 * Metric value
 */
export interface MetricValue {
  value: number;
  labels?: Record<string, string>;
  timestamp?: number;
}

/**
 * Process metrics
 */
export interface ProcessMetrics {
  cpu: {
    percent: number;
    user: number;
    system: number;
  };
  memory: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
  eventLoop: {
    latency: {
      p50: number;
      p95: number;
      p99: number;
      max: number;
    };
    utilization: number;
  };
  handles: number;
  requests: number;
}

/**
 * System metrics
 */
export interface SystemMetrics {
  cpu: {
    percent: number;
    user: number;
    system: number;
    idle: number;
    cores: Array<{
      percent: number;
      user: number;
      system: number;
      idle: number;
    }>;
  };
  memory: {
    total: number;
    free: number;
    used: number;
    swapTotal: number;
    swapFree: number;
    swapUsed: number;
  };
  load: [number, number, number];
  disk: Array<{
    filesystem: string;
    size: number;
    used: number;
    available: number;
    mount: string;
  }>;
  network: Array<{
    interface: string;
    bytesIn: number;
    bytesOut: number;
    packetsIn: number;
    packetsOut: number;
  }>;
}
