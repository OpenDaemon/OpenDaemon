import { execFileSync } from 'child_process';
import { killTree, groupAlive } from './launch.js';

const isRunning = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';

/**
 * A string that tells this process apart from a later one that reuses its pid: the start time
 * (Linux: field 22 of /proc/<pid>/stat; macOS and BSD: `ps -o lstart=,command=`). undefined when the process
 * is gone, or the platform has no way to tell (Windows).
 */
export function processIdentity(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf-8');
      // The command name (field 2) is in parentheses and may contain spaces: count from the last ")"
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    }
    if (process.platform === 'win32') return undefined;
    // lstart has a resolution of one second: the command line makes the identity much harder to match by chance
    const out = execFileSync('ps', ['-o', 'lstart=,command=', '-p', String(pid)], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out === '' ? undefined : out;
  } catch {
    return undefined;
  }
}

interface Entry { name: string; identity: string }

/**
 * The processes this daemon started and has not seen exit, kept on disk. When the daemon itself is
 * killed its children keep running unmanaged; the next daemon reads this file and stops them before
 * it starts the same apps again (otherwise they fight over ports, and the old ones are never seen again).
 */
export class ChildRegistry {
  private readonly entries = new Map<number, Entry>();

  constructor(private readonly file: string) {}

  add(pid: number, name: string): void {
    const identity = processIdentity(pid);
    if (identity === undefined) return;
    this.entries.set(pid, { name, identity });
    this.write();
  }

  remove(pid: number): void {
    if (this.entries.delete(pid)) this.write();
  }

  clear(): void {
    this.entries.clear();
    if (existsSync(this.file)) {
      try { unlinkSync(this.file); } catch { /* already gone */ }
    }
  }

  /**
   * Stop every process the previous daemon left behind (SIGTERM, then SIGKILL after `graceMs`),
   * skipping a pid that now belongs to some other process. Returns the names that were stopped.
   */
  async reap(graceMs = 3000): Promise<string[]> {
    if (!existsSync(this.file)) return [];
    let saved: Record<string, Entry> = {};
    try {
      saved = JSON.parse(readFileSync(this.file, 'utf-8')) as Record<string, Entry>;
    } catch { /* unreadable: nothing to reap */ }
    try { unlinkSync(this.file); } catch { /* already gone */ }

    const stopped: string[] = [];
    const alive: number[] = [];
    for (const [key, entry] of Object.entries(saved)) {
      const pid = Number(key);
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
      if (processIdentity(pid) !== entry.identity) continue; // gone, or a different process now
      if (killTree(pid, 'SIGTERM')) {
        alive.push(pid);
        stopped.push(entry.name);
      }
    }

    const deadline = Date.now() + graceMs;
    while (alive.length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      for (let i = alive.length - 1; i >= 0; i--) {
        const pid = alive[i] as number;
        if (!groupAlive(pid) && !isRunning(pid)) alive.splice(i, 1);
      }
    }
    for (const pid of alive) killTree(pid, 'SIGKILL');
    return stopped;
  }

  private write(): void {
    const temp = `${this.file}.${String(process.pid)}.tmp`;
    writeFileSync(temp, JSON.stringify(Object.fromEntries(this.entries)), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
