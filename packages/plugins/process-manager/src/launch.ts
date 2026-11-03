import { existsSync, statSync, accessSync, constants } from 'fs';
import { delimiter, extname, resolve, join } from 'path';
import type { ProcessConfig } from '../../../core/src/index.js';

/**
 * What to execute for an app
 */
export interface Launch {
  command: string;
  args: string[];
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
 * Whether `command` (a bare name, not a path) is an executable on PATH
 */
export function isOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (command === '' || /[\\/]/.test(command)) return false;
  const extensions = process.platform === 'win32' ? ['', ...(env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const ext of extensions) {
      const candidate = join(dir, command + ext);
      try {
        if (statSync(candidate).isFile()) {
          accessSync(candidate, constants.X_OK);
          return true;
        }
      } catch { /* not here */ }
    }
  }
  return false;
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

  if (interpreter === 'none') {
    if (isFile) return { command: scriptPath, args, node: false };
    if (isOnPath(config.script, env)) return { command: config.script, args, node: false };
    return { error: `Command not found: ${config.script}` };
  }

  if (interpreter !== 'node') {
    if (!isFile && !isOnPath(config.script, env) && !existsSync(scriptPath)) return { error: `Script not found: ${config.script}` };
    return { command: interpreter, args: [...interpreterArgs, isFile ? scriptPath : config.script, ...args], node: false };
  }

  if (!isFile) {
    if (isOnPath(config.script, env)) return { command: config.script, args, node: false };
    return { error: `Script not found: ${config.script}` };
  }
  const ext = extname(scriptPath).toLowerCase();
  const mapped = BY_EXTENSION[ext];
  if (mapped !== undefined) return { command: mapped, args: [...interpreterArgs, scriptPath, ...args], node: false };
  if (ext === '' && process.platform !== 'win32' && isExecutableFile(scriptPath)) return { command: scriptPath, args, node: false };
  return { command: process.execPath, args: [...interpreterArgs, scriptPath, ...args], node: true };
}
