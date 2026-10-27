import { existsSync, statSync, watch, type FSWatcher } from 'fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'path';
import type { Plugin, PluginContext, ProcessConfig, WatchConfig } from '../../../core/src/index.js';

/**
 * The part of the process-manager plugin this plugin relies on
 */
interface ProcessManagerApi {
  getProcessConfig(name: string): ProcessConfig | undefined;
  restartProcessFromPlugin(name: string): Promise<unknown>;
}

const DEFAULT_IGNORE = ['node_modules', '.git', '*.log', 'logs', 'coverage', 'dist'];

/**
 * Glob-like matcher: `*` and `?` stay within a path segment, `**` crosses segments.
 * A pattern without `/` matches any single segment (e.g. `node_modules`, `*.test.ts`);
 * one with `/` matches the path relative to the watched root (e.g. `src/generated/**`).
 */
export function compileIgnore(patterns: readonly string[]): (relativePath: string) => boolean {
  const segment = (part: string) => part
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  const toRegExp = (glob: string) => new RegExp(`^${glob.split('**').map(segment).join('.*')}$`);
  const segmentPatterns = patterns.filter((p) => !p.includes('/')).map(toRegExp);
  const pathPatterns = patterns.filter((p) => p.includes('/')).map((p) => toRegExp(p.replace(/^\.\//, '').replace(/\/$/, '/**')));

  return (relativePath: string) => {
    const path = relativePath.split(sep).join('/');
    const segments = path.split('/');
    return segments.some((segment) => segmentPatterns.some((re) => re.test(segment)))
      || pathPatterns.some((re) => re.test(path));
  };
}

/**
 * Windows also reports a change on a directory whenever a file inside it changes; the file's
 * own event is what matters (and is filtered by the ignore patterns), so skip directories.
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false; // deleted: a real change
  }
}

interface Watched {
  watchers: FSWatcher[];
  timer?: NodeJS.Timeout;
  changed: Set<string>;
}

/**
 * Watch Mode Plugin
 * Restarts a process (gracefully, through the process manager) when files under its watch
 * paths change. Uses fs.watch's recursive mode, so no file-watcher dependency is needed.
 */
export class WatchModePlugin implements Plugin {
  name = 'watch-mode';
  version = '1.0.0';
  description = 'Restart processes when their files change';
  priority = 16;
  dependencies = ['process-manager'];

  // Set in install(), which the kernel always calls before any other hook
  private context!: PluginContext;
  private readonly watched = new Map<string, Watched>();

  install(context: PluginContext): void {
    this.context = context;
    // A restart emits stopped then started, which re-creates the watchers with a fresh config
    context.events.on('process:started', (data: unknown) => { this.watch((data as { name: string }).name); });
    context.events.on('process:stopped', (data: unknown) => { this.unwatch((data as { name: string }).name); });
  }

  onStop(): void {
    for (const name of [...this.watched.keys()]) this.unwatch(name);
  }

  /**
   * Names of processes currently being watched
   */
  watching(): string[] {
    return [...this.watched.keys()];
  }

  private processManager(): ProcessManagerApi | undefined {
    return this.context.getPlugin('process-manager') as unknown as ProcessManagerApi | undefined;
  }

  private watch(name: string): void {
    this.unwatch(name);
    const config = this.processManager()?.getProcessConfig(name);
    if (!config?.watch) return;

    const options: WatchConfig = config.watch === true ? {} : config.watch;
    const base = config.cwd ? resolve(config.cwd) : dirname(resolve(config.script));
    const paths = (options.paths?.length ? options.paths : [base]).map((p) => resolve(base, p));
    // Our own log directory may live inside the project: writing logs must not trigger restarts
    const logDir = this.context.config.daemon?.logDir;
    const ignored = compileIgnore([...DEFAULT_IGNORE, ...(options.ignore ?? [])]);
    const isOwnLog = (file: string) => {
      if (logDir === undefined) return false;
      const rel = relative(resolve(logDir), file);
      // On Windows a path on another drive comes back absolute
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    };

    const entry: Watched = { watchers: [], changed: new Set() };
    for (const root of paths) {
      if (!existsSync(root)) {
        this.context.logger.warn(`Watch path for "${name}" does not exist: ${root}`);
        continue;
      }
      const rootIsDir = statSync(root).isDirectory();
      try {
        const watcher = watch(root, { recursive: rootIsDir }, (_event, filename) => {
          const file = filename ? resolve(rootIsDir ? root : dirname(root), filename) : root;
          const rel = rootIsDir ? relative(root, file) : filename ?? '';
          if ((rel && ignored(rel)) || isOwnLog(file) || isDirectory(file)) return;
          this.onChange(name, entry, options.delay ?? 1000, file);
        });
        watcher.on('error', (err) => {
          this.context.logger.warn(`Watcher error for "${name}" (${root}): ${err.message}`);
        });
        entry.watchers.push(watcher);
      } catch (err) {
        this.context.logger.warn(`Cannot watch ${root} for "${name}": ${(err as Error).message}`);
      }
    }

    if (entry.watchers.length > 0) {
      this.watched.set(name, entry);
      this.context.logger.info(`Watching ${paths.join(', ')} for "${name}"`);
    }
  }

  private unwatch(name: string): void {
    const entry = this.watched.get(name);
    if (!entry) return;
    clearTimeout(entry.timer);
    for (const watcher of entry.watchers) watcher.close();
    this.watched.delete(name);
  }

  /**
   * Debounce a burst of changes (an editor save, a git checkout) into one restart
   */
  private onChange(name: string, entry: Watched, delay: number, file: string): void {
    entry.changed.add(file);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (this.watched.get(name) !== entry) return;
      const files = [...entry.changed];
      entry.changed.clear();
      const shown = files.slice(0, 3).map((f) => relative(process.cwd(), f) || f).join(', ');
      this.context.logger.info(`File change in "${name}" (${shown}${files.length > 3 ? ', ...' : ''}); restarting`);
      this.context.events.emit('watch:change', { name, files });
      this.processManager()?.restartProcessFromPlugin(name).catch((err: unknown) => {
        this.context.logger.error(`Watch restart failed for "${name}"`, undefined, err as Error);
      });
    }, delay);
  }
}
