import { cpus, freemem, loadavg, totalmem, uptime } from 'os';
import type { Plugin, PluginContext, ProcessInfo, MetricSnapshot } from '../../../core/src/index.js';
import { renderPrometheus } from './prometheus.js';

export { renderPrometheus } from './prometheus.js';

/**
 * The part of the process-manager plugin this plugin reads
 */
interface ProcessManagerApi {
  getProcesses(): ProcessInfo[];
  getCustomMetrics?(name: string): Array<{ instanceId?: number; metrics: MetricSnapshot[] }>;
}

export interface MetricsReport {
  timestamp: string;
  system: {
    cpu: { percent: number; cores: number[] };
    memory: { total: number; free: number; used: number };
    loadavg: number[];
    /** seconds */
    uptime: number;
  };
  processes: Array<{
    name: string;
    status: string;
    pid?: number | undefined;
    cpu: number;
    memory: number;
    restarts: number;
    /** milliseconds */
    uptime: number;
    instances: number;
    runningInstances: number;
    /** Metrics the app reported through `opendaemon/runtime` */
    custom: Array<{ instanceId?: number; metrics: MetricSnapshot[] }>;
  }>;
}

interface CpuSample {
  at: number;
  times: Array<{ idle: number; total: number }>;
}

function sampleCpus(): CpuSample {
  return {
    at: Date.now(),
    times: cpus().map(({ times }) => ({
      idle: times.idle,
      total: times.user + times.nice + times.sys + times.idle + times.irq,
    })),
  };
}

function percentBetween(previous: CpuSample, current: CpuSample): { percent: number; cores: number[] } {
  let idle = 0;
  let total = 0;
  const cores = current.times.map((now, i) => {
    const before = previous.times[i] ?? { idle: 0, total: 0 };
    const coreIdle = now.idle - before.idle;
    const coreTotal = now.total - before.total;
    idle += coreIdle;
    total += coreTotal;
    return coreTotal > 0 ? Math.round((1 - coreIdle / coreTotal) * 1000) / 10 : 0;
  });
  return { percent: total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : 0, cores };
}

/**
 * Metrics Collector Plugin
 * Host and process metrics plus app-reported metrics, as JSON or Prometheus text.
 */
export class MetricsCollectorPlugin implements Plugin {
  name = 'metrics-collector';
  version = '1.0.0';
  description = 'Host, process and application metrics with a Prometheus exporter';
  priority = 18;

  // Set in install(), which the kernel always calls before any other hook
  private context!: PluginContext;
  private previous: CpuSample = sampleCpus();
  private lastCpu: { percent: number; cores: number[] } | undefined;

  install(context: PluginContext): void {
    this.context = context;
    this.previous = sampleCpus();

    context.registerMethod('metrics', (params: unknown) => {
      const format = (params as { format?: string } | undefined)?.format;
      return Promise.resolve(format === 'prometheus' ? this.prometheus() : this.collect());
    });
  }

  /**
   * Current metrics snapshot
   */
  collect(): MetricsReport {
    const pm = this.context.getPlugin('process-manager') as unknown as ProcessManagerApi | undefined;
    const total = totalmem();
    const free = freemem();

    return {
      timestamp: new Date().toISOString(),
      system: {
        cpu: this.cpuUsage(),
        memory: { total, free, used: total - free },
        loadavg: loadavg(),
        uptime: uptime(),
      },
      processes: (pm?.getProcesses() ?? []).map((p) => ({
        name: p.name,
        status: p.status,
        pid: p.pid,
        cpu: p.cpu,
        memory: p.memory,
        restarts: p.restartCount,
        uptime: p.status === 'online' ? p.uptime : 0,
        instances: p.instances,
        runningInstances: p.runningInstances,
        custom: pm?.getCustomMetrics?.(p.name) ?? [],
      })),
    };
  }

  /**
   * Prometheus text exposition
   */
  prometheus(): string {
    return renderPrometheus(this.collect());
  }

  /**
   * CPU usage since the previous sample. Scrapes less than a second apart reuse the last value,
   * so they never measure a window of a few milliseconds.
   */
  private cpuUsage(): { percent: number; cores: number[] } {
    const now = sampleCpus();
    if (this.lastCpu && now.at - this.previous.at < 1000) {
      return this.lastCpu;
    }
    this.lastCpu = percentBetween(this.previous, now);
    this.previous = now;
    return this.lastCpu;
  }
}
