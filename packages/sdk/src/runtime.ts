// Runtime metrics and monitoring
import type { MetricSnapshot } from '../../core/src/types.js';

export type { MetricSnapshot };

/**
 * Metric types
 */
export type MetricType = 'counter' | 'gauge' | 'histogram';

/**
 * Metric value
 */
export interface MetricValue {
  value: number;
  labels: Record<string, string>;
  timestamp: number;
}

function snapshotOf(name: string, type: 'counter' | 'gauge', help: string, values: Map<string, number>): MetricSnapshot {
  return {
    name,
    type,
    help,
    series: [...values].map(([key, value]) => ({ labels: JSON.parse(key) as Record<string, string>, value })),
  };
}

/**
 * Counter metric
 */
export class Counter {
  private readonly values = new Map<string, number>();
  readonly name: string;
  readonly help: string;

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  /**
   * Increment counter
   */
  inc(labels: Record<string, string> = {}, value = 1): void {
    const key = JSON.stringify(labels);
    const current = this.values.get(key) ?? 0;
    this.values.set(key, current + value);
  }

  /**
   * Get current value
   */
  get(labels: Record<string, string> = {}): number {
    return this.values.get(JSON.stringify(labels)) ?? 0;
  }

  /**
   * Snapshot for reporting
   */
  snapshot(): MetricSnapshot {
    return snapshotOf(this.name, 'counter', this.help, this.values);
  }

  /**
   * Reset counter
   */
  reset(): void {
    this.values.clear();
  }
}

/**
 * Gauge metric
 */
export class Gauge {
  private readonly values = new Map<string, number>();
  readonly name: string;
  readonly help: string;

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  /**
   * Set gauge value
   */
  set(value: number, labels: Record<string, string> = {}): void {
    this.values.set(JSON.stringify(labels), value);
  }

  /**
   * Increment gauge
   */
  inc(labels: Record<string, string> = {}, value = 1): void {
    const key = JSON.stringify(labels);
    const current = this.values.get(key) ?? 0;
    this.values.set(key, current + value);
  }

  /**
   * Decrement gauge
   */
  dec(labels: Record<string, string> = {}, value = 1): void {
    this.inc(labels, -value);
  }

  /**
   * Get current value
   */
  get(labels: Record<string, string> = {}): number {
    return this.values.get(JSON.stringify(labels)) ?? 0;
  }

  /**
   * Snapshot for reporting
   */
  snapshot(): MetricSnapshot {
    return snapshotOf(this.name, 'gauge', this.help, this.values);
  }
}

/**
 * Histogram metric. Keeps cumulative bucket counts, sum and count (what Prometheus needs) plus
 * the most recent observations for quantiles, so memory stays bounded however long it runs.
 */
export class Histogram {
  private static readonly RECENT = 1024;
  private readonly series = new Map<string, { counts: number[]; sum: number; count: number; recent: number[] }>();
  private readonly bucketBounds: number[];
  readonly name: string;
  readonly help: string;

  constructor(
    name: string,
    help: string,
    buckets: number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
  ) {
    this.name = name;
    this.help = help;
    this.bucketBounds = [...buckets].sort((x, y) => x - y).concat(Infinity);
  }

  /**
   * Observe a value
   */
  observe(value: number, labels: Record<string, string> = {}): void {
    const key = JSON.stringify(labels);
    let entry = this.series.get(key);
    if (!entry) {
      entry = { counts: this.bucketBounds.map(() => 0), sum: 0, count: 0, recent: [] };
      this.series.set(key, entry);
    }
    this.bucketBounds.forEach((bound, i) => {
      if (value <= bound) entry.counts[i] = (entry.counts[i] ?? 0) + 1;
    });
    entry.sum += value;
    entry.count++;
    entry.recent.push(value);
    if (entry.recent.length > Histogram.RECENT) entry.recent.shift();
  }

  /**
   * Get cumulative bucket counts (observations <= bound)
   */
  getBuckets(labels: Record<string, string> = {}): Map<number, number> {
    const entry = this.series.get(JSON.stringify(labels));
    return new Map(this.bucketBounds.map((bound, i) => [bound, entry?.counts[i] ?? 0]));
  }

  /**
   * Calculate a quantile over the most recent observations
   */
  quantile(q: number, labels: Record<string, string> = {}): number {
    const values = [...(this.series.get(JSON.stringify(labels))?.recent ?? [])];
    if (values.length === 0) {
      return 0;
    }

    values.sort((a, b) => a - b);
    const index = Math.min(values.length - 1, Math.ceil(values.length * q) - 1);
    return values[Math.max(0, index)] ?? 0;
  }

  /**
   * Snapshot for reporting
   */
  snapshot(): MetricSnapshot {
    return {
      name: this.name,
      type: 'histogram',
      help: this.help,
      series: [...this.series].map(([key, entry]) => ({
        labels: JSON.parse(key) as Record<string, string>,
        buckets: this.bucketBounds.map((bound, i): [number, number] => [bound, entry.counts[i] ?? 0]),
        sum: entry.sum,
        count: entry.count,
      })),
    };
  }

  /**
   * Reset histogram
   */
  reset(): void {
    this.series.clear();
  }
}

/**
 * Running as an OpenDaemon-managed process with its IPC channel. Other parents (test runners,
 * other supervisors) can also give a process.send, so the daemon's OD_MANAGED marker decides.
 */
function underOpenDaemon(): boolean {
  return process.env['OD_MANAGED'] === '1' && typeof process.send === 'function';
}

/**
 * Metrics registry
 */
class MetricsRegistry {
  private readonly counters = new Map<string, Counter>();
  private readonly gauges = new Map<string, Gauge>();
  private readonly histograms = new Map<string, Histogram>();

  /**
   * Create or get a counter
   */
  counter(name: string, help: string): Counter {
    this.startReporting();
    let counter = this.counters.get(name);
    if (!counter) {
      counter = new Counter(name, help);
      this.counters.set(name, counter);
    }
    return counter;
  }

  /**
   * Create or get a gauge
   */
  gauge(name: string, help: string): Gauge {
    this.startReporting();
    let gauge = this.gauges.get(name);
    if (!gauge) {
      gauge = new Gauge(name, help);
      this.gauges.set(name, gauge);
    }
    return gauge;
  }

  /**
   * Create or get a histogram
   */
  histogram(name: string, help: string, buckets?: number[]): Histogram {
    this.startReporting();
    let histogram = this.histograms.get(name);
    if (!histogram) {
      histogram = new Histogram(name, help, buckets);
      this.histograms.set(name, histogram);
    }
    return histogram;
  }

  /**
   * Current state of every metric
   */
  snapshot(): MetricSnapshot[] {
    return [
      ...[...this.counters.values()].map((m) => m.snapshot()),
      ...[...this.gauges.values()].map((m) => m.snapshot()),
      ...[...this.histograms.values()].map((m) => m.snapshot()),
    ];
  }

  /**
   * Send the current snapshot to the OpenDaemon daemon. Only works when the app runs under
   * OpenDaemon (which gives it an IPC channel); a no-op otherwise. Called automatically every
   * OD_METRICS_INTERVAL ms (default 5000) once a metric exists.
   */
  flush(): boolean {
    if (!underOpenDaemon() || !process.connected || !process.send) return false;
    process.send({ type: 'od:metrics', metrics: this.snapshot() });
    return true;
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }

  private reporter: NodeJS.Timeout | undefined;

  /**
   * Start periodic reporting on first use, only under OpenDaemon; unref'd so it never keeps
   * the app alive
   */
  protected startReporting(): void {
    if (this.reporter || !underOpenDaemon()) return;
    const interval = Number(process.env['OD_METRICS_INTERVAL'] ?? 5000);
    if (!Number.isFinite(interval) || interval <= 0) return;
    this.reporter = setInterval(() => { this.flush(); }, interval);
    this.reporter.unref();
  }
}

/**
 * Global metrics registry
 */
export const metrics = new MetricsRegistry();
