import { nextRun, parseCron, type CronSchedule } from '../../../core/src/index.js';
import type { Plugin, PluginContext, ProcessConfig, ProcessInfo } from '../../../core/src/index.js';

/**
 * The part of the process-manager plugin this plugin relies on
 */
interface ProcessManagerApi {
  getProcesses(): ProcessInfo[];
  startProcessFromPlugin(config: ProcessConfig): Promise<unknown>;
  restartProcessFromPlugin(name: string): Promise<unknown>;
}

export interface CronRun {
  startedAt: string;
  finishedAt?: string;
  attempt: number;
  result: 'running' | 'succeeded' | 'failed' | 'skipped' | 'stopped';
  exitCode?: number | null;
  error?: string;
}

export interface CronJobReport {
  name: string;
  cron: string;
  timezone?: string;
  nextRun?: string;
  history: CronRun[];
}

interface Job {
  config: ProcessConfig;
  schedule: CronSchedule;
  timer?: NodeJS.Timeout;
  nextRun?: Date | undefined;
  current?: CronRun | undefined;
  /** An overlap restart is replacing the process: its stop is ours, not the user's */
  restarting?: boolean;
  history: CronRun[];
}

const HISTORY = 20;
// setTimeout cannot wait longer than ~24.8 days; longer waits are re-armed in chunks
const MAX_TIMEOUT = 2 ** 31 - 1;

/**
 * Scheduler Plugin
 * Runs apps that have a `cron` expression as scheduled jobs: started at each match, never
 * restarted automatically, optionally retried on failure, skipped or restarted on overlap.
 */
export class SchedulerPlugin implements Plugin {
  name = 'scheduler';
  version = '1.0.0';
  description = 'Cron-scheduled jobs';
  priority = 17;
  dependencies = ['process-manager'];

  // Set in install(), which the kernel always calls before any other hook
  private context!: PluginContext;
  private readonly jobs = new Map<string, Job>();

  install(context: PluginContext): void {
    this.context = context;
    context.events.on('process:exit', (data: unknown) => {
      const { name, code } = data as { name: string; code: number | null };
      this.finish(name, code);
    });
    context.events.on('process:stopped', (data: unknown) => {
      // Stopped by the user (od stop) while running: that run did not complete
      const job = this.jobs.get((data as { name: string }).name);
      if (job?.current && !job.restarting) this.close(job, 'stopped');
    });
    context.registerMethod('cron', () => Promise.resolve(this.report()));
  }

  onStart(context: PluginContext): void {
    for (const app of context.config.apps ?? []) {
      if (app.cron === undefined) continue;
      try {
        const job: Job = { config: app, schedule: parseCron(app.cron), history: [] };
        this.jobs.set(app.name, job);
        this.arm(job);
        this.context.logger.info(`Scheduled "${app.name}" (${app.cron}); next run ${job.nextRun?.toISOString() ?? 'never'}`);
      } catch (err) {
        this.context.logger.error(`Not scheduling "${app.name}": ${(err as Error).message}`);
      }
    }
  }

  onStop(): void {
    for (const job of this.jobs.values()) clearTimeout(job.timer);
    this.jobs.clear();
  }

  report(): CronJobReport[] {
    return [...this.jobs.values()].map((job) => ({
      name: job.config.name,
      cron: job.schedule.expression,
      ...(job.config.cronTimezone === undefined ? {} : { timezone: job.config.cronTimezone }),
      ...(job.nextRun === undefined ? {} : { nextRun: job.nextRun.toISOString() }),
      history: [...job.history],
    }));
  }

  private processManager(): ProcessManagerApi | undefined {
    return this.context.getPlugin('process-manager') as unknown as ProcessManagerApi | undefined;
  }

  private arm(job: Job): void {
    clearTimeout(job.timer);
    job.nextRun = nextRun(job.schedule, new Date(), job.config.cronTimezone);
    if (job.nextRun === undefined) return;
    this.wait(job, job.nextRun);
  }

  private wait(job: Job, at: Date): void {
    const delay = at.getTime() - Date.now();
    job.timer = setTimeout(() => {
      if (Date.now() < at.getTime()) {
        this.wait(job, at);
        return;
      }
      this.tick(job);
      this.arm(job);
    }, Math.min(Math.max(delay, 0), MAX_TIMEOUT));
    job.timer.unref();
  }

  private tick(job: Job): void {
    const name = job.config.name;
    const pm = this.processManager();
    if (!pm) return;
    const status = pm.getProcesses().find((p) => p.name === name)?.status;
    const busy = status === 'online' || status === 'starting' || status === 'stopping';

    if (busy && !job.config.cronOverlap) {
      this.record(job, { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), attempt: 1, result: 'skipped' });
      this.context.logger.warn(`Skipping scheduled run of "${name}": previous run still active`);
      return;
    }
    if (busy) {
      // cronOverlap: replace the running instance with a fresh run
      if (job.current) this.close(job, 'stopped');
      this.begin(job, 1);
      job.restarting = true;
      pm.restartProcessFromPlugin(name)
        .catch((err: unknown) => { this.fail(job, err); })
        .finally(() => { job.restarting = false; });
      return;
    }
    this.run(job, 1);
  }

  private run(job: Job, attempt: number): void {
    this.begin(job, attempt);
    // The scheduler decides when it runs again, so the process manager must not restart it
    this.processManager()?.startProcessFromPlugin({ ...job.config, autoRestart: 'never' })
      .catch((err: unknown) => { this.fail(job, err); });
  }

  private begin(job: Job, attempt: number): void {
    job.current = { startedAt: new Date().toISOString(), attempt, result: 'running' };
    this.record(job, job.current);
    this.context.events.emit('cron:run', { name: job.config.name, attempt });
  }

  private finish(name: string, code: number | null): void {
    const job = this.jobs.get(name);
    const run = job?.current;
    if (!job || !run) return;
    const succeeded = code === 0;
    this.close(job, succeeded ? 'succeeded' : 'failed', code);

    const retries = job.config.cronRetry ?? 0;
    if (!succeeded && run.attempt <= retries) {
      this.context.logger.warn(`Scheduled run of "${name}" failed (exit ${String(code)}); retry ${String(run.attempt)}/${String(retries)}`);
      setTimeout(() => { this.run(job, run.attempt + 1); }, job.config.restartDelay ?? 1000).unref();
    }
  }

  private fail(job: Job, err: unknown): void {
    this.context.logger.error(`Scheduled run of "${job.config.name}" could not start`, undefined, err as Error);
    if (job.current) {
      job.current.error = (err as Error).message;
      this.close(job, 'failed');
    }
  }

  private close(job: Job, result: CronRun['result'], exitCode?: number | null): void {
    const run = job.current;
    if (!run) return;
    run.result = result;
    run.finishedAt = new Date().toISOString();
    if (exitCode !== undefined) run.exitCode = exitCode;
    job.current = undefined;
    this.context.events.emit('cron:finish', { name: job.config.name, result, exitCode, attempt: run.attempt });
  }

  private record(job: Job, run: CronRun): void {
    job.history.push(run);
    if (job.history.length > HISTORY) job.history.shift();
  }
}
