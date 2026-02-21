// Runtime metrics and monitoring

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

/**
 * Counter metric
 */
export class Counter {
  private values = new Map<string, number>();
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
  private values = new Map<string, number>();
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
}

/**
 * Histogram metric
 */
export class Histogram {
  private buckets = new Map<string, number[]>();
  private bucketBounds: number[];
  readonly name: string;
  readonly help: string;

  constructor(
    name: string,
    help: string,
    buckets: number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
  ) {
    this.name = name;
    this.help = help;
    this.bucketBounds = [...buckets, Infinity];
  }

  /**
   * Observe a value
   */
  observe(value: number, labels: Record<string, string> = {}): void {
    const key = JSON.stringify(labels);
    const values = this.buckets.get(key) ?? [];
    values.push(value);
    this.buckets.set(key, values);
  }

  /**
   * Get bucket counts
   */
  getBuckets(labels: Record<string, string> = {}): Map<number, number> {
    const key = JSON.stringify(labels);
    const values = this.buckets.get(key) ?? [];
    const counts = new Map<number, number>();

    for (const bound of this.bucketBounds) {
      counts.set(bound, values.filter(v => v <= bound).length);
    }

    return counts;
  }

  /**
   * Calculate quantile
   */
  quantile(q: number, labels: Record<string, string> = {}): number {
    const key = JSON.stringify(labels);
    const values = [...(this.buckets.get(key) ?? [])];
    
    if (values.length === 0) {
      return 0;
    }

    values.sort((a, b) => a - b);
    const index = Math.min(values.length - 1, Math.ceil(values.length * q) - 1);
    const result = values[Math.max(0, index)];
    return result ?? 0;
  }

  /**
   * Reset histogram
   */
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Metrics registry
 */
class MetricsRegistry {
  private counters = new Map<string, Counter>();
  private gauges = new Map<string, Gauge>();
  private histograms = new Map<string, Histogram>();

  /**
   * Create or get a counter
   */
  counter(name: string, help: string): Counter {
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
    let histogram = this.histograms.get(name);
    if (!histogram) {
      histogram = new Histogram(name, help, buckets);
      this.histograms.set(name, histogram);
    }
    return histogram;
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

/**
 * Global metrics registry
 */
export const metrics = new MetricsRegistry();
