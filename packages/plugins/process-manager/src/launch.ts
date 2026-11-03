import { existsSync, statSync, accessSync, constants } from 'fs';
import { delimiter, extname, resolve, join } from 'path';
import type { ProcessConfig } from '../../../core/src/index.js';

/**
 * What to execute for an app
 */
export interface Launch {
  command: string;
  args: string[];
  /** Windows .cmd/.bat files (npm, npx, yarn) only run through a shell */
  shell?: boolean;
  /** true when the command is node itself: only then can the SDK and cluster mode be used */
  node: boolean;
}

/** Interpreter by script extension (Node.js scripts, and the usual scripting languages) */
const BY_EXTENSION: Record<string, string> = {
  '.py': process.platform === 'win32' ? 'python' : 'python3',
  '.sh': 'bash',
  '.bash': 'bash',
  '.rb': 'ruby',
  '.php': 'php',
  '.pl': 'perl',
};

/**
 * The file `command` (a bare name, not a path) runs from, searching PATH (and PATHEXT on Windows)
 */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (command === '' || /[\\/]/.test(command)) return undefined;
  const extensions = process.platform === 'win32' ? ['', ...(env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const ext of extensions) {
      const candidate = join(dir, command + ext);
      try {
        if (statSync(candidate).isFile()) {
          accessSync(candidate, constants.X_OK);
          return candidate;
        }
      } catch { /* not here */ }
    }
  }
  return undefined;
}

/**
 * Whether `command` (a bare name, not a path) is an executable on PATH
 */
export function isOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return findOnPath(command, env) !== undefined;
}

/**
 * Quote one word for cmd.exe, which `shell: true` uses on Windows: words with spaces or shell
 * characters go in double quotes (a quote inside is doubled)
 */
export function quoteForCmd(word: string): string {
  return /[\s"&|<>^()%!]/.test(word) ? `"${word.replace(/"/g, '""')}"` : word;
}

const isBatchFile = (path: string): boolean => /\.(cmd|bat)$/i.test(path);

/**
 * Run `file` directly. A Windows batch file (npm.cmd) cannot be spawned without a shell, so it
 * goes through one, with the words quoted for cmd.exe.
 */
function direct(file: string, args: string[], windows = process.platform === 'win32'): Launch {
  if (windows && isBatchFile(file)) {
    return { command: quoteForCmd(file), args: args.map(quoteForCmd), node: false, shell: true };
  }
  return { command: file, args, node: false };
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide how to run `config`:
 *  - `interpreter: 'none'`: the script is the program itself (a binary, or a command like `npm`)
 *  - `interpreter: '<program>'`: that program runs the script (`python3`, `bash`, `deno run` ...)
 *  - otherwise by the file: .py, .sh, .rb, .php and .pl get their interpreter, an extensionless
 *    executable runs as it is, anything else runs on node; a bare command that is not a file but is
 *    on PATH (`npm`, `docker`) runs as it is.
 * Returns an error message when there is nothing to run.
 */
export function resolveLaunch(config: ProcessConfig, env: NodeJS.ProcessEnv = process.env): Launch | { error: string } {
  const args = config.args ?? [];
  const interpreterArgs = config.interpreterArgs ?? [];
  const scriptPath = resolve(config.script);
  const isFile = existsSync(scriptPath) && !statSync(scriptPath).isDirectory();
  const interpreter = config.interpreter === undefined || config.interpreter === '' ? 'node' : config.interpreter;

  const onPath = (): Launch | undefined => {
    const found = findOnPath(config.script, env);
    // Bare name where spawn can find it; the full path only when a batch file needs the shell
    return found === undefined ? undefined : isBatchFile(found) ? direct(found, args) : { command: config.script, args, node: false };
  };

  if (interpreter === 'none') {
    if (isFile) return direct(scriptPath, args);
    return onPath() ?? { error: `Command not found: ${config.script}` };
  }

  if (interpreter !== 'node') {
    if (!isFile && !isOnPath(config.script, env) && !existsSync(scriptPath)) return { error: `Script not found: ${config.script}` };
    return { command: interpreter, args: [...interpreterArgs, isFile ? scriptPath : config.script, ...args], node: false };
  }

  if (!isFile) {
    return onPath() ?? { error: `Script not found: ${config.script}` };
  }
  const ext = extname(scriptPath).toLowerCase();
  if (isBatchFile(scriptPath) && process.platform === 'win32') return direct(scriptPath, args);
  const mapped = BY_EXTENSION[ext];
  if (mapped !== undefined) return { command: mapped, args: [...interpreterArgs, scriptPath, ...args], node: false };
  if (ext === '' && process.platform !== 'win32' && isExecutableFile(scriptPath)) return { command: scriptPath, args, node: false };
  return { command: process.execPath, args: [...interpreterArgs, scriptPath, ...args], node: true };
}
