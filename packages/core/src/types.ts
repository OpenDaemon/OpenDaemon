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
  threshold?: number;
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
  maxMemory?: string | number;
  maxCpu?: number;

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
  cron?: string;
  watch?: boolean | WatchConfig;
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
  maxAge?: string | number;
  compress?: boolean;
  directory?: string;
  datePattern?: string;
}

/**
 * Watch mode configuration
 */
export interface WatchConfig {
  paths: string[];
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
  | 'reloading';

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
  cwd?: string;
  createdAt: string;
  startedAt?: string;
  errorMessage?: string;
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
