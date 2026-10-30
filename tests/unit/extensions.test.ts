import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadExtensions } from '../../packages/cli/src/extensions.js';

describe('loadExtensions', () => {
  let dir: string;
  const write = (file: string, source: string): void => {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), source);
  };
  const free = (): boolean => false;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'od-ext-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('should load a plugin exported as an instance, a class or a factory, relative to the base directory', async () => {
    write('instance.mjs', "export default { name: 'a', version: '1', install() {} };");
    write('class.mjs', "export default class { name = 'b'; version = '1'; install() {} }");
    write('nested/factory.mjs', "export default async function () { return { name: 'c', version: '1', install() {} }; }");
    write('named.mjs', "export const plugin = { name: 'd', version: '1', install() {} };");

    const { plugins, errors } = await loadExtensions(['./instance.mjs', './class.mjs', './nested/factory.mjs', join(dir, 'named.mjs')], dir, free);
    expect(errors).toEqual([]);
    expect(plugins.map((p) => p.name)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('should resolve a package name from the base directory', async () => {
    write('node_modules/od-plugin-x/package.json', JSON.stringify({ name: 'od-plugin-x', version: '1.0.0', main: 'index.js' }));
    write('node_modules/od-plugin-x/index.js', "module.exports = { name: 'x', version: '1', install() {} };");
    const { plugins, errors } = await loadExtensions(['od-plugin-x'], dir, free);
    expect(errors).toEqual([]);
    expect(plugins.map((p) => p.name)).toEqual(['x']);
  });

  it('should report each failure and keep loading the rest', async () => {
    write('throws.mjs', 'throw new Error("boom");');
    write('empty.mjs', 'export const unrelated = 1;');
    write('shape.mjs', "export default { name: 'no-install', version: '1' };");
    write('taken.mjs', "export default { name: 'builtin', version: '1', install() {} };");
    write('dup-a.mjs', "export default { name: 'dup', version: '1', install() {} };");
    write('dup-b.mjs', "export default { name: 'dup', version: '1', install() {} };");
    write('good.mjs', "export default { name: 'good', version: '1', install() {} };");

    const { plugins, errors } = await loadExtensions(
      ['./throws.mjs', './missing.mjs', './empty.mjs', './shape.mjs', './taken.mjs', './dup-a.mjs', './dup-b.mjs', 'no-such-package', './good.mjs'],
      dir, (name) => name === 'builtin',
    );
    expect(plugins.map((p) => p.name)).toEqual(['dup', 'good']);
    expect(errors.map((e) => e.extension)).toEqual(['./throws.mjs', './missing.mjs', './empty.mjs', './shape.mjs', './taken.mjs', './dup-b.mjs', 'no-such-package']);
    expect(errors[0]?.message).toBe('boom');
    expect(errors[2]?.message).toContain('must export a plugin');
    expect(errors[4]?.message).toBe('a plugin named "builtin" is already registered');
    expect(errors[5]?.message).toBe('a plugin named "dup" is already registered');
  });
});
