import type { MetricSnapshot } from '../../../core/src/index.js';
import type { MetricsReport } from './index.js';

type Labels = Record<string, string>;

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatValue(value: number): string {
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return Number.isNaN(value) ? 'NaN' : String(value);
}

function formatLabels(labels: Labels): string {
  const parts = Object.entries(labels).map(([key, value]) => `${key}="${escapeLabel(value)}"`);
  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
}

/**
 * Collects samples so each metric gets exactly one HELP/TYPE header and contiguous samples
 */
class Exposition {
  private readonly families = new Map<string, { help: string; type: string; lines: string[] }>();

  add(name: string, type: string, help: string, labels: Labels, value: number, suffix = ''): void {
    let family = this.families.get(name);
    if (!family) {
      family = { help, type, lines: [] };
      this.families.set(name, family);
    } else if (family.type !== type) {
      return; // two processes reported the same name with different types: keep the first
    }
    family.lines.push(`${name}${suffix}${formatLabels(labels)} ${formatValue(value)}`);
  }

  toString(): string {
    const out: string[] = [];
    for (const [name, family] of this.families) {
      out.push(`# HELP ${name} ${family.help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`);
      out.push(`# TYPE ${name} ${family.type}`);
      out.push(...family.lines);
    }
    return `${out.join('\n')}\n`;
  }
}

/**
 * App-supplied labels, minus invalid names; `process`/`instance` are reserved for the daemon and
 * an app label with that name is kept as `exported_<name>` (Prometheus' own convention)
 */
function appLabels(labels: Record<string, unknown>, own: Labels): Labels {
  const result: Labels = {};
  for (const [key, value] of Object.entries(labels)) {
    if (!LABEL_NAME.test(key) || key.startsWith('__')) continue;
    result[key in own ? `exported_${key}` : key] = String(value);
  }
  return { ...result, ...own };
}

function addCustom(exposition: Exposition, metric: MetricSnapshot, own: Labels): void {
  if (!METRIC_NAME.test(metric.name)) return;
  for (const series of metric.series) {
    const labels = appLabels(series.labels, own);
    if (metric.type === 'histogram') {
      for (const [bound, count] of series.buckets ?? []) {
        exposition.add(metric.name, 'histogram', metric.help, { ...labels, le: formatValue(bound) }, count, '_bucket');
      }
      exposition.add(metric.name, 'histogram', metric.help, labels, series.sum ?? 0, '_sum');
      exposition.add(metric.name, 'histogram', metric.help, labels, series.count ?? 0, '_count');
    } else if (typeof series.value === 'number') {
      exposition.add(metric.name, metric.type, metric.help, labels, series.value);
    }
  }
}

/**
 * Prometheus text exposition format (version 0.0.4)
 */
export function renderPrometheus(report: MetricsReport): string {
  const out = new Exposition();
  const { system } = report;

  out.add('od_system_cpu_percent', 'gauge', 'Host CPU usage across all cores', {}, system.cpu.percent);
  system.cpu.cores.forEach((percent, core) => {
    out.add('od_system_cpu_core_percent', 'gauge', 'Host CPU usage per core', { core: String(core) }, percent);
  });
  out.add('od_system_memory_total_bytes', 'gauge', 'Host memory', {}, system.memory.total);
  out.add('od_system_memory_free_bytes', 'gauge', 'Host free memory', {}, system.memory.free);
  out.add('od_system_memory_used_bytes', 'gauge', 'Host used memory', {}, system.memory.used);
  (['1m', '5m', '15m'] as const).forEach((period, i) => {
    out.add('od_system_load_average', 'gauge', 'Host load average', { period }, system.loadavg[i] ?? 0);
  });
  out.add('od_system_uptime_seconds', 'gauge', 'Host uptime', {}, system.uptime);

  for (const proc of report.processes) {
    const labels = { process: proc.name };
    out.add('od_process_up', 'gauge', '1 if the process is online', labels, proc.status === 'online' ? 1 : 0);
    out.add('od_process_cpu_percent', 'gauge', 'Process CPU usage (all instances)', labels, proc.cpu);
    out.add('od_process_memory_bytes', 'gauge', 'Process resident memory (all instances)', labels, proc.memory);
    out.add('od_process_restarts_total', 'counter', 'Automatic restarts after crashes', labels, proc.restarts);
    out.add('od_process_uptime_seconds', 'gauge', 'Time since the process (re)started', labels, proc.uptime / 1000);
    out.add('od_process_instances', 'gauge', 'Running instances', labels, proc.runningInstances);

    for (const { instanceId, metrics } of proc.custom) {
      const own = instanceId === undefined ? labels : { ...labels, instance: String(instanceId) };
      for (const metric of metrics) addCustom(out, metric, own);
    }
  }

  return out.toString();
}
