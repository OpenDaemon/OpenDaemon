import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { splitArgs, normalizeApp, isEcosystemFile, loadEcosystem } from '../../packages/cli/src/ecosystem.js';
import { parseEnvOptions, parseInstances } from '../../packages/cli/src/commands/index.js';

describe('splitArgs', () => {
  it('splits on spaces and keeps quoted parts together', () => {
    expect(splitArgs('--port 80 --name "my app" \'a b\' plain')).toEqual(['--port', '80', '--name', 'my app', 'a b', 'plain']);
    expect(splitArgs('')).toEqual([]);
    expect(splitArgs('say "a \\"b\\""')).toEqual(['say', 'a "b"']);
  });
});

describe('normalizeApp (PM2 keys)', () => {
  const base = resolve('/srv/app');
  const norm = (raw: Record<string, unknown>, profile?: string) => normalizeApp({ name: 'api', script: 'server.js', ...raw }, base, profile);

  it('maps the common PM2 settings', () => {
    const { config, warnings } = norm({
      exec_mode: 'cluster', instances: 4, autorestart: false, max_restarts: 5, restart_delay: '2s', min_uptime: '10s',
      kill_timeout: 3000, max_memory_restart: '300M', args: '--port 80', node_args: '--max-old-space-size=200',
      interpreter_args: ['--no-warnings'], cron_restart: '0 3 * * *', merge_logs: true, out_file: 'logs/out.log', error_file: 'logs/err.log',
    });
    expect(warnings).toEqual([]);
    expect(config).toMatchObject({
      name: 'api', script: join(base, 'server.js'), cwd: base, mode: 'cluster', instances: 4, autoRestart: false, maxRestarts: 5,
      restartDelay: 2000, minUptime: 10000, killTimeout: 3000, maxMemory: '300M', args: ['--port', '80'],
      interpreterArgs: ['--no-warnings', '--max-old-space-size=200'], cronRestart: '0 3 * * *', mergeLogs: true,
      logFile: join(base, 'logs/out.log'), errorLogFile: join(base, 'logs/err.log'),
    });
  });

  it('turns instances max / 0 / -1 into max, and many instances into cluster mode', () => {
    expect(norm({ instances: 'max' }).config).toMatchObject({ instances: 'max', mode: 'cluster' });
    expect(norm({ instances: -1 }).config.instances).toBe('max');
    expect(norm({ instances: 3 }).config.mode).toBe('cluster');
    expect(norm({ instances: 3, exec_mode: 'fork' }).config.mode).toBe('fork');
    expect(norm({}).config.mode).toBeUndefined();
  });

  it('maps exp_backoff_restart_delay to exponential backoff', () => {
    expect(norm({ exp_backoff_restart_delay: 100 }).config).toMatchObject({ backoffStrategy: 'exponential', restartDelay: 100 });
  });

  it('maps watch settings', () => {
    expect(norm({ watch: true }).config.watch).toBe(true);
    expect(norm({ watch: ['src'], ignore_watch: ['node_modules'], watch_delay: 500 }).config.watch)
      .toEqual({ paths: ['src'], ignore: ['node_modules'], delay: 500 });
    expect(norm({ watch: false }).config.watch).toBe(false);
    expect(norm({ watch: { paths: ['x'], delay: 5 } }).config.watch).toEqual({ paths: ['x'], delay: 5 });
  });

  it('merges env_<profile> over env, as strings, keeping secret references', () => {
    const raw = { env: { NODE_ENV: 'development', PORT: 80, DEBUG: true, TOKEN: { secret: 'T' } }, env_production: { NODE_ENV: 'production' } };
    expect(norm(raw).config.env).toEqual({ NODE_ENV: 'development', PORT: '80', DEBUG: 'true', TOKEN: { secret: 'T' } });
    expect(norm(raw, 'production').config.env).toMatchObject({ NODE_ENV: 'production', PORT: '80' });
    expect(norm(raw, 'staging').warnings).toEqual([]);
    expect(norm(raw, 'staging').config.env).toMatchObject({ NODE_ENV: 'development' });
  });

  it('resolves cwd against the config file and the script against the cwd', () => {
    const { config } = norm({ cwd: 'backend', script: './dist/main.js' });
    expect(config.cwd).toBe(join(base, 'backend'));
    expect(config.script).toBe(join(base, 'backend', 'dist', 'main.js'));
  });

  it('leaves a bare command (npm) alone', () => {
    expect(norm({ script: 'npm', args: 'start' }).config).toMatchObject({ script: 'npm', args: ['start'] });
  });

  it('warns about settings it cannot carry over, and stays quiet about PM2-only ones', () => {
    const { warnings } = norm({ post_update: ['npm i'], pmx: false, wibble: 1, source_map_support: true });
    expect(warnings).toEqual(['"wibble" is not supported and was ignored']);
  });

  it('passes OpenDaemon style keys through', () => {
    const { config } = norm({ autoRestart: 'on-failure', limits: { fds: { max: 100 } }, dependencies: ['db'] });
    expect(config).toMatchObject({ autoRestart: 'on-failure', limits: { fds: { max: 100 } }, dependencies: ['db'] });
  });
});

describe('isEcosystemFile', () => {
  it.each([
    ['ecosystem.config.js', true], ['./ecosystem.config.cjs', true], ['apps.json', true], ['a.yml', true], ['x.config.ts', true],
    ['ecosystem.js', true], ['server.js', false], ['app.py', false], ['run.sh', false], ['api', false],
  ])('%s -> %s', (name, expected) => { expect(isEcosystemFile(name)).toBe(expected); });
});

describe('loadEcosystem', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'od-eco-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const write = (name: string, body: string): string => { const path = join(dir, name); writeFileSync(path, body); return path; };

  it('reads a CommonJS module.exports file (PM2 style)', async () => {
    const file = write('ecosystem.config.cjs', `module.exports = { apps: [{ name: 'a', script: 'a.js', env_production: { MODE: 'prod' } }, { script: 'b.js' }] };`);
    const { apps } = await loadEcosystem(file, { profile: 'production' });
    expect(apps.map((a) => a.config.name)).toEqual(['a', 'b']);
    expect(apps[0]?.config.env).toEqual({ MODE: 'prod' });
  });

  it('reads JSON, YAML, and a bare list', async () => {
    const json = write('apps.json', JSON.stringify({ apps: [{ name: 'j', script: 'j.js' }] }));
    expect((await loadEcosystem(json)).apps[0]?.config.name).toBe('j');
    const list = write('list.json', JSON.stringify([{ name: 'l', script: 'l.js' }]));
    expect((await loadEcosystem(list)).apps[0]?.config.name).toBe('l');
    const yaml = write('apps.yaml', 'apps:\n  - name: y\n    script: y.js\n    max_restarts: 3\n');
    expect((await loadEcosystem(yaml)).apps[0]?.config).toMatchObject({ name: 'y', maxRestarts: 3 });
  });

  it('warns once when no app has the profile, and about a deploy section', async () => {
    const file = write('warn.json', JSON.stringify({ apps: [{ name: 'a', script: 'a.js', env_production: { X: '1' } }, { name: 'b', script: 'b.js' }], deploy: { production: {} } }));
    expect((await loadEcosystem(file, { profile: 'production' })).warnings).toEqual([expect.stringContaining('"deploy" section is not supported')]);
    expect((await loadEcosystem(file, { profile: 'staging' })).warnings[0]).toBe('no app has an env_staging section: using env');
  });

  it('keeps only the apps named in only, and rejects unknown names', async () => {
    const file = write('apps.json', JSON.stringify({ apps: [{ name: 'a', script: 'a.js' }, { name: 'b', script: 'b.js' }] }));
    expect((await loadEcosystem(file, { only: ['b'] })).apps.map((a) => a.config.name)).toEqual(['b']);
    await expect(loadEcosystem(file, { only: ['zzz'] })).rejects.toThrow(/Not in .*: zzz \(it has: a, b\)/);
  });

  it('explains what is wrong with the file', async () => {
    await expect(loadEcosystem(join(dir, 'missing.json'))).rejects.toThrow(/not found/);
    await expect(loadEcosystem(write('empty.json', '{"apps": []}'))).rejects.toThrow(/has no apps/);
    await expect(loadEcosystem(write('bad.json', '{"apps": [1]}'))).rejects.toThrow(/apps\[0\] must be an object/);
    await expect(loadEcosystem(write('noscript.json', '{"apps": [{"name": "x"}]}'))).rejects.toThrow(/App "x" has no script/);
  });
});

describe('start options', () => {
  it('splits --env into variables and a profile', () => {
    expect(parseEnvOptions(['A=1', 'URL=http://x/?a=b', 'production'])).toEqual({ env: { A: '1', URL: 'http://x/?a=b' }, profile: 'production' });
    expect(parseEnvOptions(undefined)).toEqual({ env: {}, profile: undefined });
    expect(() => parseEnvOptions(['true'])).toThrow(/Invalid --env/);
  });

  it('parses --instances', () => {
    expect(parseInstances('4')).toBe(4);
    expect(parseInstances('max')).toBe('max');
    expect(parseInstances(undefined)).toBeUndefined();
    expect(() => parseInstances('0')).toThrow(/Invalid --instances/);
    expect(() => parseInstances('x')).toThrow(/Invalid --instances/);
  });
});
