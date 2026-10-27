import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManagerPlugin } from '../../packages/plugins/config-manager/src/index.js';
import { ConfigError } from '../../packages/core/src/index.js';

describe('ConfigManagerPlugin.load', () => {
  const originalCwd = process.cwd();
  let dir: string;

  const write = (name: string, content: string) => { writeFileSync(join(dir, name), content); };
  const load = () => new ConfigManagerPlugin().load();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'od-config-'));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('should return defaults when no config file exists', async () => {
    const config = await load();
    expect(config.defaults?.killTimeout).toBe(5000);
    expect(config.apps).toBeUndefined();
  });

  it('should load JSON and apply defaults to apps', async () => {
    write('opendaemon.config.json', JSON.stringify({
      defaults: { killTimeout: 2000 },
      apps: [{ name: 'api', script: './api.js', killTimeout: 1000 }, { name: 'worker', script: './w.js' }],
      plugins: { webui: { port: 7781 } },
    }));

    const config = await load();
    expect(config.apps?.map((a) => [a.name, a.killTimeout])).toEqual([['api', 1000], ['worker', 2000]]);
    expect(config.plugins?.['webui']).toEqual({ port: 7781 });
  });

  it('should load an ES module config through a file URL', async () => {
    write('opendaemon.config.mjs', "export default { apps: [{ name: 'from-js', script: './a.js' }] };");
    const config = await load();
    expect(config.apps?.[0]?.name).toBe('from-js');
  });

  it('should load nested YAML apps and plugin settings', async () => {
    write('opendaemon.config.yaml', [
      'apps:',
      '  - name: from-yaml',
      '    script: ./app.js',
      '    env:',
      '      PORT: "3000"',
      'plugins:',
      '  webui:',
      '    port: 7783',
    ].join('\n'));

    const config = await load();
    expect(config.apps?.[0]).toMatchObject({ name: 'from-yaml', script: './app.js', env: { PORT: '3000' } });
    expect(config.plugins?.['webui']).toEqual({ port: 7783 });
  });

  it('should read the opendaemon field of package.json', async () => {
    write('package.json', JSON.stringify({ name: 'x', opendaemon: { apps: [{ name: 'pkg', script: './p.js' }] } }));
    const config = await load();
    expect(config.apps?.[0]?.name).toBe('pkg');
  });

  it.runIf(Boolean((process.features as { typescript?: unknown }).typescript))(
    'should load a TypeScript config when Node supports type stripping',
    async () => {
      write('opendaemon.config.ts', "const config: { apps: { name: string; script: string }[] } = { apps: [{ name: 'from-ts', script: './t.js' }] };\nexport default config;");
      const config = await load();
      expect(config.apps?.[0]?.name).toBe('from-ts');
    }
  );

  it('should prefer .js over .json when both exist', async () => {
    write('opendaemon.config.js', "export default { apps: [{ name: 'js-wins', script: './a.js' }] };");
    write('package.json', JSON.stringify({ type: 'module' }));
    write('opendaemon.config.json', JSON.stringify({ apps: [{ name: 'json', script: './a.js' }] }));
    const config = await load();
    expect(config.apps?.[0]?.name).toBe('js-wins');
  });

  it.each([
    ['an app without a script', JSON.stringify({ apps: [{ name: 'x' }] }), /must have a script/],
    ['a non-object app entry', JSON.stringify({ apps: [null] }), /must be an object/],
    ['apps that is not an array', JSON.stringify({ apps: {} }), /apps must be an array/],
    ['malformed JSON', '{ nope', /Failed to parse JSON config/],
    ['circular dependencies', JSON.stringify({ apps: [
      { name: 'a', script: './a.js', dependencies: ['b'] }, { name: 'b', script: './b.js', dependencies: ['a'] },
    ] }), /Circular dependency: a -> b -> a/],
    ['an unknown dependency', JSON.stringify({ apps: [{ name: 'a', script: './a.js', dependencies: ['db'] }] }),
      /depends on unknown app "db"/],
  ])('should reject %s with a ConfigError', async (_name, content, message) => {
    write('opendaemon.config.json', content);
    await expect(load()).rejects.toBeInstanceOf(ConfigError);
    await expect(load()).rejects.toThrow(message);
  });

  it('should report YAML syntax errors with the line number', async () => {
    write('opendaemon.config.yaml', 'apps:\n\t- name: x');
    await expect(load()).rejects.toThrow(/Failed to parse YAML config: Tabs are not allowed.*line 2/);
  });
});
