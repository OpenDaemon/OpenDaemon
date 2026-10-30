import { createRequire } from 'module';
import { isAbsolute, resolve } from 'path';
import { pathToFileURL } from 'url';
import type { Plugin } from '../../core/src/index.js';

/**
 * Where a plugin module is looked up: a path (./x.js, ../x.js, /abs/x.js) relative to the config
 * file, or a package name resolved from the config file's directory
 */
function moduleUrl(specifier: string, baseDirectory: string): string {
  if (isAbsolute(specifier) || specifier.startsWith('./') || specifier.startsWith('../')) {
    return pathToFileURL(resolve(baseDirectory, specifier)).href;
  }
  return pathToFileURL(createRequire(resolve(baseDirectory, 'noop.js')).resolve(specifier)).href;
}

function isPlugin(value: unknown): value is Plugin {
  const candidate = value as Partial<Plugin> | null;
  return typeof candidate === 'object' && candidate !== null
    && typeof candidate.name === 'string' && candidate.name !== ''
    && typeof candidate.version === 'string'
    && typeof candidate.install === 'function';
}

/**
 * Turn what a module exports into a plugin: an instance, a class, or a factory. The plugin's own
 * settings reach it as `context.pluginConfig`, like those of the built-in plugins.
 */
async function instantiate(exported: unknown): Promise<Plugin | undefined> {
  if (isPlugin(exported)) return exported;
  if (typeof exported !== 'function') return undefined;
  // A class needs `new`; a factory can be called plainly. Classes throw when called without it.
  const isClass = /^class[\s{]/.test(Function.prototype.toString.call(exported));
  const made = isClass ? new (exported as new () => unknown)() : await (exported as () => unknown)();
  return isPlugin(made) ? made : undefined;
}

export interface LoadedExtensions {
  plugins: Plugin[];
  errors: Array<{ extension: string; message: string }>;
}

/**
 * Load the plugins named in `extensions`. One that cannot be loaded is reported and skipped, so a
 * broken extension does not keep the daemon from starting; a name that is already taken is an error.
 */
export async function loadExtensions(
  extensions: readonly string[],
  baseDirectory: string,
  isTaken: (name: string) => boolean,
): Promise<LoadedExtensions> {
  const result: LoadedExtensions = { plugins: [], errors: [] };
  const names = new Set<string>();
  for (const extension of extensions) {
    try {
      const module = await import(moduleUrl(extension, baseDirectory)) as Record<string, unknown>;
      const plugin = await instantiate(module['default'] ?? module['plugin']);
      if (!plugin) {
        throw new Error('the module must export a plugin (name, version, install) as default or as `plugin`, or a class or factory for one');
      }
      if (names.has(plugin.name) || isTaken(plugin.name)) {
        throw new Error(`a plugin named "${plugin.name}" is already registered`);
      }
      names.add(plugin.name);
      result.plugins.push(plugin);
    } catch (err) {
      result.errors.push({ extension, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
