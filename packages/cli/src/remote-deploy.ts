import { spawn, spawnSync } from 'child_process';

/**
 * One `deploy.<env>` block of an ecosystem file, as PM2 reads it
 */
export interface DeployTarget {
  user?: string;
  /** One host or several; deployed one after the other */
  host: string | string[];
  /** Branch or tag to deploy, e.g. origin/main */
  ref: string;
  repo: string;
  /** Directory on the host: source/ holds the checkout, current points at it */
  path: string;
  key?: string;
  port?: number;
  ssh_options?: string | string[];
  env?: Record<string, string>;
  'pre-setup'?: string;
  'post-setup'?: string;
  'pre-deploy-local'?: string;
  'pre-deploy'?: string;
  'post-deploy'?: string;
}

/** Runs a shell script on `host`; resolves with its exit code. Output goes to stdout/stderr. */
export type Runner = (host: string, script: string) => Promise<number>;

export type DeployCommandName = 'setup' | 'update' | 'deploy' | 'revert' | 'curr' | 'current' | 'prev' | 'previous' | 'exec' | 'list';

/** Single-quote a word for a POSIX shell */
export const sh = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

function hostsOf(target: DeployTarget): string[] {
  return (Array.isArray(target.host) ? target.host : [target.host]).filter((h) => h !== '');
}

/**
 * Check a deploy block and say what is missing, before anything is run
 */
export function validateTarget(name: string, target: unknown): DeployTarget {
  if (typeof target !== 'object' || target === null) throw new Error(`deploy.${name} must be an object`);
  const t = target as Partial<DeployTarget>;
  for (const key of ['ref', 'repo', 'path'] as const) {
    if (typeof t[key] !== 'string' || t[key] === '') throw new Error(`deploy.${name}.${key} is required`);
  }
  if (t.host === undefined || hostsOf(t as DeployTarget).length === 0) throw new Error(`deploy.${name}.host is required`);
  if (!(t.path as string).startsWith('/') && !(t.path as string).startsWith('~')) {
    throw new Error(`deploy.${name}.path must be an absolute path on the host (it is "${t.path as string}")`);
  }
  return t as DeployTarget;
}

/**
 * The script a host runs for `command`. Everything runs with `set -e`, the target's `env`
 * exported, and the hooks (`pre-setup`, `post-deploy` ...) in the order PM2 runs them.
 */
export function remoteScript(target: DeployTarget, command: DeployCommandName, argument?: string): string {
  const path = target.path.startsWith('~') ? `"$HOME"${sh(target.path.slice(1))}` : sh(target.path);
  const env = Object.entries(target.env ?? {}).map(([k, v]) => `export ${k.replace(/[^A-Za-z0-9_]/g, '_')}=${sh(v)}`);
  const hook = (name: keyof DeployTarget): string[] => (typeof target[name] === 'string' && target[name] !== '' ? [target[name]] : []);
  const link = `ln -sfn ${path}/source ${path}/current`;
  const lines: string[] = ['set -e', ...env];

  switch (command) {
    case 'setup':
      lines.push(
        ...hook('pre-setup'),
        `mkdir -p ${path}/shared`,
        `if [ ! -d ${path}/source/.git ]; then git clone ${sh(target.repo)} ${path}/source; fi`,
        link,
        `cd ${path}/source`,
        ...hook('post-setup'),
      );
      break;
    case 'update':
    case 'deploy':
      lines.push(
        `cd ${path}/source`,
        'git fetch --all --prune',
        `git reset --hard ${sh(target.ref)}`,
        ...hook('pre-deploy'),
        link,
        `cd ${path}/current`,
        ...hook('post-deploy'),
      );
      break;
    case 'revert': {
      const steps = Number(argument ?? 1);
      if (!Number.isInteger(steps) || steps < 1) throw new Error(`revert takes a number of commits, not "${String(argument)}"`);
      lines.push(
        `cd ${path}/source`,
        `git reset --hard HEAD~${String(steps)}`,
        link,
        `cd ${path}/current`,
        ...hook('post-deploy'),
      );
      break;
    }
    case 'curr':
    case 'current':
      lines.push(`cd ${path}/source`, 'git log -1 --pretty=format:"%h %s (%cr)"', 'echo');
      break;
    case 'prev':
    case 'previous':
      lines.push(`cd ${path}/source`, 'git log -2 --skip=1 --pretty=format:"%h %s (%cr)"', 'echo');
      break;
    case 'exec':
      if (argument === undefined || argument === '') throw new Error('exec needs a command: od deploy <file> <env> exec "<command>"');
      lines.push(`cd ${path}/current`, argument);
      break;
    case 'list':
      throw new Error('list is not run on a host');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Runner that sends the script to `bash -s` over ssh. `key`, `port` and `ssh_options` are passed
 * to ssh; the host key policy is ssh's own.
 */
export function sshRunner(target: DeployTarget): Runner {
  const options = (Array.isArray(target.ssh_options) ? target.ssh_options : target.ssh_options === undefined ? [] : [target.ssh_options])
    .flatMap((o) => ['-o', o]);
  return (host, script) => new Promise((resolve, reject) => {
    const args = [
      ...(target.key === undefined ? [] : ['-i', target.key]),
      ...(target.port === undefined ? [] : ['-p', String(target.port)]),
      ...options,
      target.user === undefined ? host : `${target.user}@${host}`,
      'bash -s',
    ];
    const child = spawn('ssh', args, { stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('exit', (code) => { resolve(code ?? 1); });
    child.stdin.end(script);
  });
}

/** Run a command on this machine (the `pre-deploy-local` hook) */
function runLocal(script: string): number {
  return spawnSync('bash', ['-c', `set -e\n${script}`], { stdio: 'inherit' }).status ?? 1;
}

export interface DeployResult {
  host: string;
  code: number;
}

/**
 * Run `command` for every host of the target. `pre-deploy-local` runs once, here, before an update;
 * a host that fails stops the run (so a broken release does not reach the next host).
 */
export async function runDeploy(
  target: DeployTarget,
  command: DeployCommandName,
  runner: Runner,
  argument?: string,
  log: (message: string) => void = (m) => { console.log(m); }
): Promise<DeployResult[]> {
  if ((command === 'update' || command === 'deploy') && typeof target['pre-deploy-local'] === 'string' && target['pre-deploy-local'] !== '') {
    log('--> pre-deploy-local');
    const code = runLocal(target['pre-deploy-local']);
    if (code !== 0) throw new Error(`pre-deploy-local failed (exit ${String(code)})`);
  }
  const script = remoteScript(target, command, argument);
  const results: DeployResult[] = [];
  for (const host of hostsOf(target)) {
    log(`--> ${command} on ${host}`);
    const code = await runner(host, script);
    results.push({ host, code });
    if (code !== 0) throw new Error(`${command} failed on ${host} (exit ${String(code)})`);
  }
  return results;
}
