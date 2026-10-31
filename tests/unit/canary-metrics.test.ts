import { describe, it, expect } from 'vitest';
import { judge, takeSample, format, type InstanceMetrics } from '../../packages/plugins/deploy-strategy/src/canary-metrics.js';
import type { CanaryMetricCheck, MetricSnapshot } from '../../packages/core/src/index.js';

const counter = (name: string, value: number, labels: Record<string, string> = {}): MetricSnapshot =>
  ({ name, type: 'counter', help: '', series: [{ labels, value }] });
const gauge = (name: string, value: number): MetricSnapshot => ({ name, type: 'gauge', help: '', series: [{ labels: {}, value }] });
const histogram = (name: string, sum: number, count: number): MetricSnapshot =>
  ({ name, type: 'histogram', help: '', series: [{ labels: {}, sum, count, buckets: [[Infinity, count]] }] });
const workers = (...metrics: MetricSnapshot[][]): InstanceMetrics => metrics.map((m, instanceId) => ({ instanceId, metrics: m }));

const canary = new Set([0]);
const rest = new Set([1, 2]);
const run = (checks: CanaryMetricCheck[], before: InstanceMetrics, after: InstanceMetrics, seconds = 10) =>
  judge(checks, takeSample(before, checks), takeSample(after, checks), canary, rest, seconds);

describe('judge', () => {
  it('should compute an error rate from the change of two counters, canary against the rest', () => {
    const check: CanaryMetricCheck = { metric: 'errors', per: 'requests', max: 0.1, maxRatio: 2 };
    const before = workers([counter('errors', 0), counter('requests', 0)], [counter('errors', 5), counter('requests', 500)], [counter('errors', 5), counter('requests', 500)]);
    const after = workers([counter('errors', 4), counter('requests', 100)], [counter('errors', 6), counter('requests', 600)], [counter('errors', 6), counter('requests', 600)]);
    const ok = run([check], before, after);
    expect(ok[0]).toMatchObject({ canary: 0.04, baseline: 0.01 });
    // 4% is 4x the baseline's 1%, over maxRatio 2 but under the absolute 10%
    expect(ok[0]?.failure).toContain('more than 2x');

    const fine = run([{ ...check, maxRatio: 10 }], before, after);
    expect(fine[0]?.failure).toBeUndefined();
  });

  it('should fail above the absolute limit even when the baseline has no data', () => {
    const [v] = run([{ metric: 'errors', per: 'requests', max: 0.05, minSamples: 10 }], workers([]), workers([counter('errors', 30), counter('requests', 100)]));
    expect(v).toMatchObject({ canary: 0.3, baseline: undefined });
    expect(v?.failure).toBe('canary errors/requests is 0.3, above the limit 0.05');
  });

  it('should wait for minSamples before judging', () => {
    const check: CanaryMetricCheck = { metric: 'errors', per: 'requests', max: 0.05 };
    const [few] = run([check], workers([]), workers([counter('errors', 5), counter('requests', 9)]));
    expect(few).toMatchObject({ canary: undefined });
    expect(few?.failure).toBeUndefined();
    const [enough] = run([{ ...check, minSamples: 5 }], workers([]), workers([counter('errors', 5), counter('requests', 9)]));
    expect(enough?.failure).toContain('above the limit');
  });

  it('should count a counter on its own as events per second, and a restarted worker from zero', () => {
    const [v] = run([{ metric: 'jobs', max: 5 }], workers([counter('jobs', 100)]), workers([counter('jobs', 80)]), 10);
    // 100 -> 80 means the worker restarted: 80 events in 10s
    expect(v?.canary).toBe(8);
    expect(v?.failure).toContain('above the limit 5');
  });

  it('should use the mean observation of a histogram and the mean of a gauge across workers', () => {
    const latency: CanaryMetricCheck = { metric: 'latency', maxRatio: 1.5 };
    const [h] = run([latency], workers([histogram('latency', 0, 0)], [histogram('latency', 10, 100)]), workers([histogram('latency', 4, 20)], [histogram('latency', 20, 200)]));
    expect(h).toMatchObject({ canary: 0.2, baseline: 0.1 });
    expect(h?.failure).toContain('more than 1.5x');

    const [g] = run([{ metric: 'queue', max: 50 }], workers([]), workers([gauge('queue', 40)]));
    expect(g).toMatchObject({ canary: 40 });
    expect(g?.failure).toBeUndefined();
  });

  it('should apply the labels to the numerator only, not to what it is divided by', () => {
    const requests = [{ ...counter('requests', 0), series: [{ labels: { status: '200' }, value: 90 }, { labels: { status: '500' }, value: 10 }] }];
    const [v] = run([{ metric: 'requests', labels: { status: '500' }, per: 'requests', max: 1 }], workers([]), workers(requests));
    expect(v?.canary).toBe(10 / 100);
  });

  it('should only count the series with the given labels, summed', () => {
    const metrics = [{ ...counter('errors', 10, { status: '500' }), series: [{ labels: { status: '500' }, value: 10 }, { labels: { status: '404' }, value: 90 }, { labels: { status: '500', route: '/x' }, value: 5 }] }];
    const [v] = run([{ metric: 'errors', labels: { status: '500' }, max: 100 }], workers([]), workers(metrics), 1);
    expect(v?.canary).toBe(15);
  });

  it('should ignore workers without an instance id and metrics that are missing', () => {
    const checks: CanaryMetricCheck[] = [{ metric: 'absent', max: 1 }];
    expect(takeSample([{ metrics: [counter('absent', 1)] }], checks).size).toBe(0);
    expect(run(checks, workers([]), workers([counter('other', 1)]))[0]).toMatchObject({ canary: undefined, baseline: undefined });
  });
});

describe('format', () => {
  it('should keep three significant digits and drop decimals for large values', () => {
    expect([format(0.30000001), format(12.3456), format(1234.5), format(0)]).toEqual(['0.3', '12.3', '1235', '0']);
  });
});
