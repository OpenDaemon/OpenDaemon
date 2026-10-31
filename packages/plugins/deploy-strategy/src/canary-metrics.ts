import type { CanaryMetricCheck, MetricSnapshot } from '../../../core/src/index.js';

/** The metrics each worker reported, as the process manager keeps them */
export type InstanceMetrics = Array<{ instanceId?: number; metrics: MetricSnapshot[] }>;

interface Reading {
  /** counter or gauge value, histogram sum */
  total: number;
  /** counter value, histogram observation count; gauges have none */
  events: number;
  kind: MetricSnapshot['type'];
}

/** Per worker and per metric name, the readings of the series that match the check's labels */
export type Sample = Map<number, Map<string, Reading>>;

export interface Verdict {
  check: CanaryMetricCheck;
  /** Undefined while there is not enough data to judge */
  canary: number | undefined;
  baseline: number | undefined;
  /** Set when the canary is worse than allowed */
  failure?: string;
}

const matches = (labels: Record<string, string>, wanted: Record<string, string> | undefined): boolean =>
  wanted === undefined || Object.entries(wanted).every(([key, value]) => labels[key] === value);

/**
 * Read every metric the checks mention, per worker
 */
export function takeSample(instances: InstanceMetrics, checks: readonly CanaryMetricCheck[]): Sample {
  const sample: Sample = new Map();
  for (const { instanceId, metrics } of instances) {
    if (instanceId === undefined) continue;
    const readings = new Map<string, Reading>();
    for (const check of checks) {
      // The labels select the numerator; `per` counts everything, e.g. all requests, not just failed ones
      const wanted: Array<[string, Record<string, string> | undefined]> = [[check.metric, check.labels], ...(check.per === undefined ? [] : [[check.per, undefined] as [string, undefined]])];
      for (const [name, labels] of wanted) {
        const metric = metrics.find((m) => m.name === name);
        if (!metric) continue;
        const key = keyOf(name, labels);
        const reading: Reading = readings.get(key) ?? { total: 0, events: 0, kind: metric.type };
        for (const series of metric.series) {
          if (!matches(series.labels, labels)) continue;
          if (metric.type === 'histogram') {
            reading.total += series.sum ?? 0;
            reading.events += series.count ?? 0;
          } else {
            reading.total += series.value ?? 0;
            if (metric.type === 'counter') reading.events += series.value ?? 0;
          }
        }
        readings.set(key, reading);
      }
    }
    sample.set(instanceId, readings);
  }
  return sample;
}

const keyOf = (name: string, labels: Record<string, string> | undefined): string => `${name}|${JSON.stringify(labels ?? {})}`;

/** Growth of a counter-like value since `from`; a drop means the worker restarted, so it counts from zero */
const growth = (now: number, from: number | undefined): number => (from === undefined || now < from ? now : now - from);

/**
 * The value of a check over the window between two samples, for the workers in `group`:
 * - with `per`: change of the metric divided by the change of `per`
 * - counter: events per second; histogram: mean observation; gauge: mean across workers
 * and how many events it rests on
 */
function measure(check: CanaryMetricCheck, from: Sample, now: Sample, group: ReadonlySet<number>, seconds: number): { value: number | undefined; events: number } {
  let total = 0;
  let events = 0;
  let workers = 0;
  let perEvents = 0;
  let kind: MetricSnapshot['type'] = 'counter';
  for (const index of group) {
    const reading = now.get(index)?.get(keyOf(check.metric, check.labels));
    if (!reading) continue;
    const before = from.get(index)?.get(keyOf(check.metric, check.labels));
    workers++;
    kind = reading.kind;
    total += kind === 'gauge' ? reading.total : growth(reading.total, before?.total);
    events += kind === 'gauge' ? 0 : growth(reading.events, before?.events);
    if (check.per !== undefined) {
      const per = now.get(index)?.get(keyOf(check.per, undefined));
      perEvents += per ? growth(per.events, from.get(index)?.get(keyOf(check.per, undefined))?.events) : 0;
    }
  }
  if (workers === 0) return { value: undefined, events: 0 };
  if (check.per !== undefined) return { value: perEvents > 0 ? total / perEvents : undefined, events: perEvents };
  if (kind === 'gauge') return { value: total / workers, events: workers };
  // Counter: per second. Histogram (total is the sum): mean per observation.
  return { value: events > 0 ? (kind === 'histogram' ? total / events : total / seconds) : undefined, events };
}

/**
 * Compare the canary workers with the rest, over the window since `from`
 */
export function judge(checks: readonly CanaryMetricCheck[], from: Sample, now: Sample, canary: ReadonlySet<number>, baseline: ReadonlySet<number>, seconds: number): Verdict[] {
  return checks.map((check) => {
    const mine = measure(check, from, now, canary, seconds);
    const theirs = measure(check, from, now, baseline, seconds);
    const verdict: Verdict = { check, canary: undefined, baseline: theirs.value };
    // Too little traffic to say anything: neither a pass nor a failure yet
    if (mine.value === undefined || mine.events < (check.minSamples ?? (check.per === undefined ? 1 : 10))) return verdict;
    verdict.canary = mine.value;
    const label = check.per === undefined ? check.metric : `${check.metric}/${check.per}`;
    if (check.max !== undefined && mine.value > check.max) {
      verdict.failure = `canary ${label} is ${format(mine.value)}, above the limit ${format(check.max)}`;
    } else if (check.maxRatio !== undefined && theirs.value !== undefined && theirs.value > 0 && mine.value > theirs.value * check.maxRatio) {
      verdict.failure = `canary ${label} is ${format(mine.value)}, more than ${format(check.maxRatio)}x the current release's ${format(theirs.value)}`;
    }
    return verdict;
  });
}

export const format = (value: number): string => (Math.abs(value) >= 100 ? value.toFixed(0) : Number(value.toPrecision(3)).toString());
