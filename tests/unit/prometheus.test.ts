import { describe, it, expect } from 'vitest';
import { renderPrometheus } from '../../packages/plugins/metrics-collector/src/prometheus.js';
import type { MetricsReport } from '../../packages/plugins/metrics-collector/src/index.js';

const report = (processes: MetricsReport['processes'] = []): MetricsReport => ({
  timestamp: '2026-01-01T00:00:00.000Z',
  system: {
    cpu: { percent: 12.5, cores: [10, 15] },
    memory: { total: 8000, free: 3000, used: 5000 },
    loadavg: [0.5, 0.25, 0.1],
    uptime: 3600,
  },
  processes,
});

const proc = (overrides: Partial<MetricsReport['processes'][number]> = {}): MetricsReport['processes'][number] => ({
  name: 'web', status: 'online', pid: 1, cpu: 3.5, memory: 1024, restarts: 2, uptime: 90_000,
  instances: 2, runningInstances: 2, custom: [], ...overrides,
});

describe('renderPrometheus', () => {
  it('should expose host metrics with one HELP/TYPE header per family', () => {
    const text = renderPrometheus(report());
    expect(text).toContain('# TYPE od_system_cpu_percent gauge\nod_system_cpu_percent 12.5\n');
    expect(text).toContain('od_system_cpu_core_percent{core="0"} 10\nod_system_cpu_core_percent{core="1"} 15\n');
    expect(text).toContain('od_system_load_average{period="5m"} 0.25');
    expect(text).toContain('od_system_memory_used_bytes 5000');
    expect(text.match(/# TYPE od_system_cpu_core_percent/g)).toHaveLength(1);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('should expose per-process metrics labelled by process', () => {
    const text = renderPrometheus(report([proc(), proc({ name: 'worker', status: 'errored', uptime: 0 })]));
    expect(text).toContain('# TYPE od_process_restarts_total counter');
    expect(text).toContain('od_process_up{process="web"} 1\nod_process_up{process="worker"} 0\n');
    expect(text).toContain('od_process_uptime_seconds{process="web"} 90');
    expect(text).toContain('od_process_instances{process="web"} 2');
  });

  it('should merge app metrics across processes and instances with escaped labels', () => {
    const text = renderPrometheus(report([
      proc({ custom: [{ instanceId: 0, metrics: [
        { name: 'http_requests_total', type: 'counter', help: 'Requests', series: [
          { labels: { path: '/a"b\\c\nd', process: 'app-supplied' }, value: 3 },
        ] },
      ] }] }),
      proc({ name: 'api', custom: [{ metrics: [
        { name: 'http_requests_total', type: 'counter', help: 'Requests', series: [{ labels: {}, value: 7 }] },
      ] }] }),
    ]));

    expect(text.match(/# TYPE http_requests_total counter/g)).toHaveLength(1);
    expect(text).toContain('http_requests_total{path="/a\\"b\\\\c\\nd",exported_process="app-supplied",process="web",instance="0"} 3');
    expect(text).toContain('http_requests_total{process="api"} 7');
  });

  it('should render histograms as _bucket (with +Inf), _sum and _count', () => {
    const text = renderPrometheus(report([proc({ custom: [{ metrics: [
      { name: 'latency_seconds', type: 'histogram', help: 'Latency', series: [
        { labels: { route: 'x' }, buckets: [[0.1, 1], [1, 3], [Infinity, 4]], sum: 2.5, count: 4 },
      ] },
    ] }] })]));

    expect(text).toContain('# TYPE latency_seconds histogram');
    expect(text).toContain('latency_seconds_bucket{route="x",process="web",le="0.1"} 1');
    expect(text).toContain('latency_seconds_bucket{route="x",process="web",le="+Inf"} 4');
    expect(text).toContain('latency_seconds_sum{route="x",process="web"} 2.5');
    expect(text).toContain('latency_seconds_count{route="x",process="web"} 4');
  });

  it('should drop invalid metric and label names and conflicting types', () => {
    const text = renderPrometheus(report([proc({ custom: [{ metrics: [
      { name: 'bad-name', type: 'gauge', help: 'x', series: [{ labels: {}, value: 1 }] },
      { name: 'queue_depth', type: 'gauge', help: 'Depth', series: [{ labels: { 'bad-label': 'x', __reserved: 'y', ok: 'z' }, value: 5 }] },
      { name: 'queue_depth', type: 'counter', help: 'Depth', series: [{ labels: {}, value: 9 }] },
    ] }] })]));

    expect(text).not.toContain('bad-name');
    expect(text).toContain('queue_depth{ok="z",process="web"} 5');
    expect(text).not.toMatch(/queue_depth\{process="web"\} 9/);
  });
});
