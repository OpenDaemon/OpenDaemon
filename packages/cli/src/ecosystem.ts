import { existsSync, readFileSync } from 'fs';
import { dirname, extname, basename, resolve, isAbsolute } from 'path';
import { pathToFileURL } from 'url';
import { parseDuration } from '../../core/src/index.js';
import type { ProcessConfig } from '../../core/src/index.js';
import { parseYaml } from '../../plugins/config-manager/src/yaml.js';

/**
 * Split a PM2-style `args` string into arguments, honouring single and double quotes
 */
export function splitArgs(value: string): string[] {
  const args: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) {
    args.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2] ?? match[3] ?? '');
  }
  return args;
}

const asList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : typeof value === 'string' ? splitArgs(value) : [];

const asMs = (value: unknown): number | undefined =>
  typeof value === 'number' || typeof value === 'string' ? parseDuration(value) : undefined;

/** OpenDaemon's own keys: a config that already uses them passes through unchanged */
const NATIVE_KEYS = new Set([
  'name', 'script', 'cwd', 'env', 'instances', 'mode', 'interpreter', 'interpreterArgs', 'args', 'maxMemory', 'maxCpu',
  'limits', 'deploy', 'autoRestart', 'restartDelay', 'maxRestarts', 'minUptime', 'killTimeout', 'backoffStrategy',
  'backoffMultiplier', 'maxBackoffDelay', 'healthCheck', 'dependencyTimeout', 'logFile', 'errorLogFile', 'logLevel',
  'mergeLogs', 'logRotation', 'uid', 'gid', 'nice', 'umask', 'detached', 'cron', 'cronTimezone', 'cronOverlap',
  'cronRetry', 'cronRestart', 'namespace', 'stopExitCodes', 'stableAfter', 'logTimestamp', 'watch', 'dependencies', 'description', 'version', 'waitReady', 'listenTimeout',
]);

/** PM2 keys that have no meaning here, or that OpenDaemon does on its own: dropped without a warning */
const SILENT_KEYS = new Set([
  'vizion', 'pmx', 'automation', 'autorestart_', 'treekill', 'source_map_support', 'instance_var',
  'increment_var', 'combine_logs', 'disable_logs', 'post_update', 'filter_env', 'windowsHide', 'shutdown_with_message',
  'trace', 'deep_monitoring', 'force', 'wait_ready_', 'append_env_to_name', 'node_args_',
]);

export interface NormalizedApp {
  config: ProcessConfig;
  /** PM2 settings that were not carried over */
  warnings: string[];
}

/**
 * Turn one app of an ecosystem file (PM2 or OpenDaemon style) into a ProcessConfig.
 * `profile` picks `env_<profile>` (PM2's `--env production`); its values override `env`.
 * Relative `cwd` and `script` are resolved against `baseDir`, the way PM2 does it.
 */
export function normalizeApp(raw: Record<string, unknown>, baseDir: string, profile?: string): NormalizedApp {
  const warnings: string[] = [];
  const name = typeof raw['name'] === 'string' ? raw['name'] : '';
  const out: Record<string, unknown> = {};
  const set = (key: string, value: unknown): void => { if (value !== undefined) out[key] = value; };

  for (const [key, value] of Object.entries(raw)) {
    if (NATIVE_KEYS.has(key)) out[key] = value;
  }

  const env: Record<string, unknown> = { ...(raw['env'] as Record<string, unknown> | undefined) };
  if (profile !== undefined) {
    // An app without that profile just uses env, as in PM2 (loadEcosystem warns if none has it)
    const overrides = raw[`env_${profile}`];
    if (overrides !== undefined) Object.assign(env, overrides as Record<string, unknown>);
  }
  if (Object.keys(env).length > 0) {
    // Secret references stay as they are; PM2 allows numbers and booleans, a process environment does not
    out['env'] = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, typeof v === 'object' && v !== null ? v : String(v)]));
  }

  if (typeof raw['args'] === 'string') out['args'] = splitArgs(raw['args']);
  const nodeArgs = [...asList(raw['interpreter_args']), ...asList(raw['node_args'])];
  if (nodeArgs.length > 0) out['interpreterArgs'] = [...asList(out['interpreterArgs']), ...nodeArgs];
  set('interpreter', raw['interpreter']);

  const instances = raw['instances'];
  if (instances === 'max' || instances === 0 || instances === -1) out['instances'] = 'max';
  const execMode = raw['exec_mode'];
  if (execMode === 'cluster' || execMode === 'cluster_mode') out['mode'] = 'cluster';
  else if (execMode === 'fork' || execMode === 'fork_mode') out['mode'] = 'fork';
  if (out['mode'] === undefined && typeof out['instances'] === 'number' && out['instances'] > 1) out['mode'] = 'cluster';
  if (out['mode'] === undefined && out['instances'] === 'max') out['mode'] = 'cluster';

  if (raw['autorestart'] === false) out['autoRestart'] = false;
  else if (raw['autorestart'] === true) out['autoRestart'] = true;
  set('maxRestarts', raw['max_restarts']);
  set('restartDelay', asMs(raw['restart_delay']));
  // PM2's min_uptime is the stability threshold, not a readiness wait
  set('stableAfter', asMs(raw['min_uptime']));
  set('killTimeout', asMs(raw['kill_timeout']));
  const backoff = asMs(raw['exp_backoff_restart_delay']);
  if (backoff !== undefined) {
    out['backoffStrategy'] = 'exponential';
    out['restartDelay'] = backoff;
  }
  set('maxMemory', raw['max_memory_restart']);
  set('cronRestart', raw['cron_restart']);
  if (raw['stop_exit_codes'] !== undefined) out['stopExitCodes'] = (Array.isArray(raw['stop_exit_codes']) ? raw['stop_exit_codes'] : [raw['stop_exit_codes']]).map(Number).filter(Number.isInteger);
  set('waitReady', raw['wait_ready']);
  set('listenTimeout', asMs(raw['listen_timeout']));

  const nativeWatch = typeof raw['watch'] === 'object' && raw['watch'] !== null && !Array.isArray(raw['watch']);
  if (raw['watch'] !== undefined && raw['watch'] !== false && !nativeWatch) {
    const paths = raw['watch'] === true ? undefined : asList(raw['watch']);
    const ignore = asList(raw['ignore_watch']);
    const delay = asMs(raw['watch_delay']);
    out['watch'] = paths === undefined && ignore.length === 0 && delay === undefined ? true : {
      ...(paths === undefined ? {} : { paths }),
      ...(ignore.length === 0 ? {} : { ignore }),
      ...(delay === undefined ? {} : { delay }),
    };
  }

  set('logFile', raw['out_file'] ?? raw['output'] ?? raw['log_file'] ?? raw['log']);
  set('errorLogFile', raw['error_file'] ?? raw['error']);
  set('mergeLogs', raw['merge_logs']);
  set('logTimestamp', raw['time']);

  for (const key of Object.keys(raw)) {
    const handled = NATIVE_KEYS.has(key) || SILENT_KEYS.has(key) || key === 'env' || key.startsWith('env_') || [
      'args', 'interpreter_args', 'node_args', 'instances', 'exec_mode', 'autorestart', 'max_restarts', 'restart_delay',
      'min_uptime', 'kill_timeout', 'stop_exit_codes', 'exp_backoff_restart_delay', 'max_memory_restart', 'cron_restart', 'wait_ready',
      'listen_timeout', 'watch', 'ignore_watch', 'watch_delay', 'out_file', 'output', 'log_file', 'log', 'error_file',
      'error', 'merge_logs', 'time',
    ].includes(key);
    if (!handled) warnings.push(`"${key}" is not supported and was ignored`);
  }

  // PM2 resolves cwd against the config file, and the script against that cwd
  const cwd = typeof out['cwd'] === 'string' ? resolve(baseDir, out['cwd']) : baseDir;
  out['cwd'] = cwd;
  if (typeof out['script'] === 'string' && (out['script'].includes('/') || out['script'].includes('\\') || /\.(c|m)?[jt]s$|\.(py|sh|bash|rb|php|pl)$/i.test(out['script']) || existsSync(resolve(cwd, out['script'])))) {
    out['script'] = isAbsolute(out['script']) ? out['script'] : resolve(cwd, out['script']);
  }
  for (const key of ['logFile', 'errorLogFile']) {
    if (typeof out[key] === 'string') out[key] = resolve(baseDir, out[key]);
  }

  return { config: { ...out, name } as unknown as ProcessConfig, warnings };
}

/**
 * Whether `start <target>` names an ecosystem/config file rather than a script: .json, .yaml
 * and .yml always are; a script file is only when it is called ecosystem.* or *.config.*
 */
export function isEcosystemFile(target: string): boolean {
  const ext = extname(target).toLowerCase();
  if (ext === '.json' || ext === '.yaml' || ext === '.yml') return true;
  if (!['.js', '.cjs', '.mjs', '.ts'].includes(ext)) return false;
  const file = basename(target).toLowerCase();
  return file.startsWith('ecosystem') || /\.config\.[cm]?[jt]s$/.test(file);
}

export interface LoadedEcosystem {
  apps: NormalizedApp[];
  file: string;
  /** Things about the file as a whole, e.g. a profile no app defines */
  warnings: string[];
  /** The top-level `deploy` section, if any (read by `od deploy <file> <env>`) */
  deploy?: Record<string, unknown>;
}

/**
 * Read an ecosystem file: `{ apps: [...] }`, or a bare list of apps, as JSON, YAML, or a JS/TS
 * module (module.exports or default export). PM2 and OpenDaemon style keys can be mixed.
 * `only` keeps just the named apps.
 */
export async function loadEcosystem(path: string, options: { profile?: string; only?: string[] } = {}): Promise<LoadedEcosystem> {
  const file = resolve(path);
  if (!existsSync(file)) throw new Error(`Config file not found: ${path}`);
  const ext = extname(file).toLowerCase();

  let data: unknown;
  if (ext === '.json') data = JSON.parse(readFileSync(file, 'utf-8'));
  else if (ext === '.yaml' || ext === '.yml') data = parseYaml(readFileSync(file, 'utf-8'));
  else {
    const module = await import(pathToFileURL(file).href) as { default?: unknown };
    data = module.default ?? module;
  }

  const list = Array.isArray(data) ? data : (data as { apps?: unknown } | null)?.apps;
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${path} has no apps (expected { apps: [...] })`);

  const warnings: string[] = [];
  if (options.profile !== undefined && !list.some((a) => typeof a === 'object' && a !== null && `env_${options.profile as string}` in a)) {
    warnings.push(`no app has an env_${options.profile} section: using env`);
  }
  const top = Array.isArray(data) ? {} : (data as Record<string, unknown>);
  const deploy = typeof top['deploy'] === 'object' && top['deploy'] !== null ? top['deploy'] as Record<string, unknown> : undefined;

  const baseDir = dirname(file);
  const apps = list.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`apps[${index}] must be an object`);
    const raw = entry as Record<string, unknown>;
    // PM2 allows `script` without `name`: the file name is the name
    if (typeof raw['name'] !== 'string' && typeof raw['script'] === 'string') {
      raw['name'] = basename(raw['script']).replace(/\.[^.]+$/, '');
    }
    const normalized = normalizeApp(raw, baseDir, options.profile);
    if (normalized.config.name === '') throw new Error(`apps[${index}] has no name`);
    if (typeof normalized.config.script !== 'string' || normalized.config.script === '') {
      throw new Error(`App "${normalized.config.name}" has no script`);
    }
    return normalized;
  });

  const only = options.only;
  if (only !== undefined) {
    const known = new Set(apps.map((a) => a.config.name));
    const unknown = only.filter((name) => !known.has(name));
    if (unknown.length > 0) throw new Error(`Not in ${path}: ${unknown.join(', ')} (it has: ${[...known].join(', ')})`);
    return { file, warnings, ...(deploy === undefined ? {} : { deploy }), apps: apps.filter((a) => only.includes(a.config.name)) };
  }
  return { file, warnings, ...(deploy === undefined ? {} : { deploy }), apps };
}
