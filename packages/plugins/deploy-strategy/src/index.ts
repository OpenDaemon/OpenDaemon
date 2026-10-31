import { randomBytes } from 'crypto';
import { judge, takeSample, format, type InstanceMetrics } from './canary-metrics.js';
import type { Plugin, PluginContext, ProcessConfig, DeployConfig, DeployStrategy, Release } from '../../../core/src/index.js';

type Step = { ok: boolean; error?: string; pid?: number };

/** What the deploy plugin needs from the process manager */
interface ProcessManagerApi {
  getProcessConfig(name: string): ProcessConfig | undefined;
  getWorkerIndices(name: string): number[];
  deployPrepare(name: string, id: string, index: number, release: Release, readyTimeout?: number): Promise<Step>;
  deployCommit(name: string, id: string, drain?: number): Promise<Step>;
  deployAbort(name: string, id: string): Promise<Step>;
  applyRelease(name: string, release: Release, replace?: boolean): void;
  restartProcessFromPlugin(name: string): Promise<unknown>;
  getCustomMetrics(name: string): InstanceMetrics;
}

export interface DeployState {
  name: string;
  state: 'running' | 'succeeded' | 'failed' | 'rolled-back';
  strategy: DeployStrategy;
  version?: string;
  startedAt: string;
  finishedAt?: string;
  /** What happened, oldest first */
  steps: string[];
  error?: string;
}

export interface DeployRequest {
  name: string;
  strategy?: DeployStrategy;
  /** The new code/environment; omitted: replace the workers with the current configuration */
  release?: Release;
}

/** The part of a config a release can change: what `od rollback` puts back */
type Snapshot = Required<Pick<Release, 'script'>> & Pick<Release, 'args' | 'env' | 'version'>;

const STRATEGIES: DeployStrategy[] = ['rolling', 'blue-green', 'canary', 'recreate'];
const MAX_STEPS = 200;

class DeployError extends Error {}

const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/**
 * Deploy Strategy Plugin
 * Replaces the code a running app executes without downtime. Cluster mode replaces workers one
 * batch at a time (`rolling`), all at once after a full new set is ready (`blue-green`), or in
 * growing steps while watching for crashes (`canary`); a new worker always starts and becomes
 * ready before its predecessor stops. `recreate` restarts the app (any mode). Traffic is shared
 * by the cluster's round-robin, so a canary's share is its share of workers: no request routing,
 * hence no A/B.
 */
export class DeployStrategyPlugin implements Plugin {
  name = 'deploy-strategy';
  version = '1.0.0';
  description = 'Rolling, blue-green, canary and recreate deploys';
  priority = 12;

  private context!: PluginContext;
  private readonly states = new Map<string, DeployState>();
  /** per app: the release before the last successful deploy */
  private readonly previous = new Map<string, Snapshot>();
  /** per app: the label of the release it runs, if it was deployed with one */
  private readonly labels = new Map<string, string>();
  private readonly running = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();

  install(context: PluginContext): void {
    this.context = context;
    // These return at once: a deploy outlasts an RPC timeout. Follow it with deploy.status.
    context.registerMethod('deploy.execute', (params: unknown) => Promise.resolve(this.execute(params as DeployRequest)));
    context.registerMethod('deploy.rollback', (params: unknown) => Promise.resolve(this.rollback((params as { name?: string } | undefined)?.name ?? '')));
    context.registerMethod('deploy.status', (params: unknown) => {
      const name = (params as { name?: string } | undefined)?.name;
      if (name) {
        const state = this.states.get(name);
        return Promise.resolve(state ?? null);
      }
      return Promise.resolve([...this.states.values()]);
    });
  }

  /** Resolves when every started deploy has finished (tests, shutdown) */
  async idle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks]);
  }

  async onStop(): Promise<void> {
    await this.idle();
  }

  private get pm(): ProcessManagerApi {
    const pm = this.context.getPlugin('process-manager') as unknown as ProcessManagerApi | undefined;
    if (!pm) throw new DeployError('The process manager is not available');
    return pm;
  }

  /**
   * Validate and start a deploy; the returned state is updated as it runs
   */
  execute(request: DeployRequest): DeployState {
    const { name } = request;
    const config = this.pm.getProcessConfig(name);
    if (!config) throw new DeployError(`Process "${name}" not found`);
    if (this.running.has(name)) throw new DeployError(`A deploy of "${name}" is already running`);

    const cluster = config.mode === 'cluster';
    const strategy = request.strategy ?? config.deploy?.strategy ?? (cluster ? 'rolling' : 'recreate');
    if (!STRATEGIES.includes(strategy)) {
      throw new DeployError(`Unknown strategy "${strategy as string}" (${STRATEGIES.join(', ')}; a-b needs request routing, which OpenDaemon does not do)`);
    }
    if (!cluster && strategy !== 'recreate') {
      throw new DeployError(`"${name}" runs in fork mode: ${strategy} needs mode: cluster (use --strategy recreate)`);
    }
    const release = request.release ?? {};
    if (release.script !== undefined && typeof release.script !== 'string') throw new DeployError('release.script must be a string');

    const state: DeployState = {
      name, state: 'running', strategy, startedAt: new Date().toISOString(), steps: [],
      ...(release.version === undefined ? {} : { version: release.version }),
    };
    this.states.set(name, state);
    this.running.add(name);
    this.context.events.emit('deploy:started', { name, strategy, version: release.version });

    const task = this.run(config, state, release).finally(() => {
      this.running.delete(name);
      this.tasks.delete(task);
    });
    this.tasks.add(task);
    return state;
  }

  /**
   * Put the release from before the last successful deploy back, rolling
   */
  rollback(name: string): DeployState {
    const config = this.pm.getProcessConfig(name);
    if (!config) throw new DeployError(`Process "${name}" not found`);
    const previous = this.previous.get(name);
    if (!previous) throw new DeployError(`Nothing to roll back for "${name}": no deploy has succeeded since the daemon started`);
    if (this.running.has(name)) throw new DeployError(`A deploy of "${name}" is already running`);

    const strategy: DeployStrategy = config.mode === 'cluster' ? 'rolling' : 'recreate';
    const state: DeployState = { name, state: 'running', strategy, startedAt: new Date().toISOString(), steps: ['rolling back to the previous release'] };
    this.states.set(name, state);
    this.running.add(name);
    this.context.events.emit('deploy:started', { name, strategy, rollback: true });

    const task = this.run(config, state, previous, true).finally(() => {
      this.running.delete(name);
      this.tasks.delete(task);
    });
    this.tasks.add(task);
    return state;
  }

  // --- the deploy itself ---

  private log(state: DeployState, step: string): void {
    state.steps.push(step);
    if (state.steps.length > MAX_STEPS) state.steps.splice(0, state.steps.length - MAX_STEPS);
    this.context.events.emit('deploy:progress', { name: state.name, step });
  }

  private async run(config: ProcessConfig, state: DeployState, release: Release, replace = false): Promise<void> {
    const { name } = state;
    const settings: DeployConfig = config.deploy ?? {};
    const deadline = Date.now() + (settings.timeout ?? 300000);
    const before: Snapshot = {
      script: config.script,
      ...(this.labels.has(name) ? { version: this.labels.get(name) as string } : {}),
      ...(config.args === undefined ? {} : { args: config.args }),
      ...(config.env === undefined ? {} : { env: config.env }),
    };
    const changed = replace || release.script !== undefined || release.args !== undefined || release.env !== undefined;
    const committed = new Set<number>();
    // A deploy without a label keeps the one the app already has
    const effective: Release = replace || release.version !== undefined || !this.labels.has(name) ? release : { ...release, version: this.labels.get(name) as string };
    const ctx: RunContext = { name, state, settings, deadline, committed, release: replace ? (release.version === undefined ? {} : { version: release.version }) : effective };

    try {
      if (state.strategy === 'recreate') {
        this.log(state, 'applying the release and restarting');
        this.pm.applyRelease(name, effective, replace);
        await this.pm.restartProcessFromPlugin(name);
      } else {
        if (replace) {
          // A rollback is a deploy of the previous release: set it as the configuration first,
          // so the replacement workers are built from it
          this.pm.applyRelease(name, effective, true);
        }
        const indices = this.pm.getWorkerIndices(name);
        if (indices.length === 0) throw new DeployError('no online workers to replace');
        if (state.strategy === 'rolling') await this.rolling(ctx, indices);
        else if (state.strategy === 'blue-green') await this.blueGreen(ctx, indices);
        else await this.canary(ctx, indices);
        // Everything runs the new release: make it the default for crash restarts and restarts
        if (!replace) this.pm.applyRelease(name, effective);
      }
    } catch (err) {
      await this.fail(ctx, before, replace, err as Error);
      return;
    }

    if (changed) this.previous.set(name, before);
    if (effective.version === undefined) this.labels.delete(name);
    else this.labels.set(name, effective.version);
    state.state = 'succeeded';
    state.finishedAt = new Date().toISOString();
    this.log(state, 'done');
    this.context.events.emit('deploy:succeeded', { name, strategy: state.strategy, version: state.version });
  }

  private async fail(ctx: RunContext, before: Snapshot, replace: boolean, err: Error): Promise<void> {
    const { name, state, settings, committed } = ctx;
    state.error = err.message;
    this.log(state, `failed: ${err.message}`);
    let rolledBack = false;
    if (settings.rollbackOnFailure !== false) {
      // A deploy that ran out of time must still be able to undo itself
      ctx.deadline = Date.now() + Math.max(settings.timeout ?? 300000, 60000);
      try {
        this.log(state, 'rolling back');
        if (state.strategy === 'recreate') {
          this.pm.applyRelease(name, before, true);
          await this.pm.restartProcessFromPlugin(name);
        } else {
          // Workers are built from the configuration: put the release from before this deploy
          // back (a forward deploy only changes it on success, a rollback changed it up front),
          // then replace the workers already switched
          if (replace) this.pm.applyRelease(name, before, true);
          if (committed.size > 0) await this.replace(ctx, [...committed], this.labels.has(name) ? { version: this.labels.get(name) as string } : {}, settings.maxSurge ?? Math.max(1, committed.size), undefined, 'revert');
        }
        rolledBack = true;
        this.log(state, 'rolled back');
      } catch (rollbackError) {
        state.error = `${err.message}; the rollback failed too: ${(rollbackError as Error).message}`;
        this.log(state, `rollback failed: ${(rollbackError as Error).message}`);
      }
    }
    state.state = rolledBack ? 'rolled-back' : 'failed';
    state.finishedAt = new Date().toISOString();
    this.context.events.emit('deploy:failed', { name, strategy: state.strategy, error: state.error, rolledBack, version: state.version });
  }

  private ensureTime(ctx: RunContext): void {
    if (Date.now() > ctx.deadline) throw new DeployError(`the deploy exceeded its timeout`);
  }

  private newId(): string {
    return randomBytes(6).toString('hex');
  }

  /**
   * Replace `indices` with workers running `release`, `surge` at a time: each new worker is
   * ready before its predecessor drains. Stops at the first failure, leaving the live workers of
   * that batch untouched.
   */
  private async replace(ctx: RunContext, indices: number[], release: Release, surge: number, drain?: number, mode: 'switch' | 'revert' = 'switch'): Promise<void> {
    const { name, settings } = ctx;
    for (const batch of chunks(indices, Math.max(1, surge))) {
      this.ensureTime(ctx);
      this.log(ctx.state, `starting new worker${batch.length > 1 ? 's' : ''} ${batch.map((i) => `#${String(i)}`).join(', ')}`);
      const ids = batch.map(() => this.newId());
      const results = await Promise.all(batch.map((index, i) => this.pm.deployPrepare(name, ids[i] as string, index, release, settings.readyTimeout)));
      const failure = results.find((r) => !r.ok);
      if (failure) {
        await Promise.all(ids.map((id) => this.pm.deployAbort(name, id).catch(() => undefined)));
        throw new DeployError(failure.error ?? 'a new worker did not become ready');
      }
      for (const [i, index] of batch.entries()) {
        const done = await this.pm.deployCommit(name, ids[i] as string, drain);
        if (!done.ok) throw new DeployError(done.error ?? 'could not switch to the new worker');
        if (mode === 'switch') ctx.committed.add(index);
        else ctx.committed.delete(index);
      }
      this.log(ctx.state, `worker${batch.length > 1 ? 's' : ''} ${batch.map((i) => `#${String(i)}`).join(', ')} switched`);
    }
  }

  private async rolling(ctx: RunContext, indices: number[]): Promise<void> {
    await this.replace(ctx, indices, ctx.release, ctx.settings.maxSurge ?? 1);
  }

  /**
   * Start the whole new set next to the old one, and switch only when every new worker is ready
   */
  private async blueGreen(ctx: RunContext, indices: number[]): Promise<void> {
    const { name, settings } = ctx;
    this.log(ctx.state, `starting a new set of ${String(indices.length)} workers`);
    const ids = indices.map(() => this.newId());
    const results = await Promise.all(indices.map((index, i) => this.pm.deployPrepare(name, ids[i] as string, index, ctx.release, settings.readyTimeout)));
    const failure = results.find((r) => !r.ok);
    if (failure) {
      await Promise.all(ids.map((id) => this.pm.deployAbort(name, id).catch(() => undefined)));
      throw new DeployError(`${failure.error ?? 'a new worker did not become ready'}; the old set is untouched`);
    }
    this.log(ctx.state, 'the new set is ready: switching');
    for (const [i, index] of indices.entries()) {
      const done = await this.pm.deployCommit(name, ids[i] as string, settings.switchTimeout);
      if (!done.ok) throw new DeployError(done.error ?? 'could not switch to the new set');
      ctx.committed.add(index);
    }
    this.log(ctx.state, `old workers finish their requests for up to ${settings.switchTimeout === undefined ? 'killTimeout' : `${String(settings.switchTimeout)}ms`}`);
  }

  /**
   * Grow the share of workers on the new release step by step; each step is watched for
   * crashes and failing health checks before the next
   */
  private async canary(ctx: RunContext, indices: number[]): Promise<void> {
    const { settings } = ctx;
    const steps = settings.canarySteps ?? [settings.canaryPercent ?? 10, 100];
    const watch = settings.canaryAnalysis?.duration ?? 10000;
    for (const [n, percent] of steps.entries()) {
      const target = Math.min(indices.length, Math.max(1, Math.ceil((percent / 100) * indices.length)));
      const next = indices.slice(0, target).filter((i) => !ctx.committed.has(i));
      this.log(ctx.state, `canary step ${String(n + 1)}/${String(steps.length)}: ${String(percent)}% (${String(target)} of ${String(indices.length)} workers)`);
      await this.replace(ctx, next, ctx.release, settings.maxSurge ?? 1);
      if (percent < 100 && target < indices.length) {
        this.log(ctx.state, `watching the canary for ${String(watch)}ms`);
        await this.observe(ctx, new Set(indices.slice(0, target)), new Set(indices.slice(target)), watch);
      }
    }
    // A last step below 100% still has to finish the job
    const rest = indices.filter((i) => !ctx.committed.has(i));
    if (rest.length > 0) await this.replace(ctx, rest, ctx.release, settings.maxSurge ?? 1);
  }

  /**
   * Fail when a canary worker dies, the app turns unhealthy, or a metric check finds the canary
   * worse than the rest, within `ms`
   */
  private observe(ctx: RunContext, canary: Set<number>, rest: Set<number>, ms: number): Promise<void> {
    const { name } = ctx;
    const checks = ctx.settings.canaryAnalysis?.metrics ?? [];
    const every = ctx.settings.canaryAnalysis?.interval ?? 1000;
    return new Promise((resolve, reject) => {
      const offs: Array<() => void> = [];
      const startedAt = Date.now();
      const from = takeSample(this.pm.getCustomMetrics(name), checks);
      const evaluate = (): ReturnType<typeof judge> =>
        judge(checks, from, takeSample(this.pm.getCustomMetrics(name), checks), canary, rest, (Date.now() - startedAt) / 1000);
      const done = (err?: Error): void => {
        clearTimeout(timer);
        clearInterval(ticker);
        for (const off of offs) off();
        if (err) reject(err); else resolve();
      };
      // The last look is also the report: what the canary measured, for the deploy's steps
      const finish = (): void => {
        const verdicts = evaluate();
        const failed = verdicts.find((v) => v.failure !== undefined);
        for (const v of verdicts) {
          const label = v.check.per === undefined ? v.check.metric : `${v.check.metric}/${v.check.per}`;
          this.log(ctx.state, v.canary === undefined
            ? `canary metric ${label}: not enough data to judge`
            : `canary metric ${label}: ${format(v.canary)}${v.baseline === undefined ? '' : ` (current release ${format(v.baseline)})`}`);
        }
        done(failed?.failure === undefined ? undefined : new DeployError(failed.failure));
      };
      const ticker = setInterval(() => {
        if (checks.length === 0) return;
        const failed = evaluate().find((v) => v.failure !== undefined);
        if (failed?.failure !== undefined) finish();
      }, every);
      const timer = setTimeout(finish, ms);
      offs.push(this.context.events.on('process:worker-exit', (data: unknown) => {
        const d = data as { name?: string; index?: number; code?: number | null; signal?: string | null };
        if (d.name === name && typeof d.index === 'number' && canary.has(d.index)) {
          done(new DeployError(`canary worker #${String(d.index)} exited (${d.signal ?? `code ${String(d.code)}`})`));
        }
      }));
      offs.push(this.context.events.on('health:status:unhealthy', (data: unknown) => {
        if ((data as { name?: string } | undefined)?.name === name) done(new DeployError('the app turned unhealthy while the canary ran'));
      }));
      offs.push(this.context.events.on('process:crash', (data: unknown) => {
        if ((data as { name?: string } | undefined)?.name === name) done(new DeployError('the app crashed while the canary ran'));
      }));
    });
  }
}

interface RunContext {
  name: string;
  state: DeployState;
  settings: DeployConfig;
  deadline: number;
  /** worker indices already switched to the release being deployed */
  committed: Set<number>;
  release: Release;
}
