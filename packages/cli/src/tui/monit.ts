import type { OptionValue } from '../parser.js';
import { term } from '../output.js';
import { CliClient } from '../client.js';
import { getVersion } from '../commands/help.js';
import { handleKey, recordHistory, render, selectedProcess, type MonitProcess, type MonitState } from './render.js';

const REFRESH_MS = 1000;

/**
 * Monit command - live terminal dashboard (`od monit`)
 */
export class MonitCommand {
  name = 'monit';
  description = 'Live terminal dashboard';
  options = [];

  async execute(_args: string[], _options: Record<string, OptionValue | undefined>): Promise<void> {
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      term.error('od monit needs an interactive terminal (use od list, od metrics or od logs -f instead)');
      process.exit(1);
      return;
    }

    const client = new CliClient();
    try {
      await client.connect();
    } catch (err) {
      term.error(`Failed to connect: ${(err instanceof Error ? err : new Error(String(err))).message}`);
      process.exit(1);
      return;
    }

    const state: MonitState = {
      version: getVersion(),
      processes: [],
      selected: 0,
      history: new Map(),
      logs: [],
      color: process.env['NO_COLOR'] === undefined,
    };
    const out = process.stdout;
    let closing = false;
    let timer: NodeJS.Timeout | undefined;

    const draw = () => {
      const lines = render(state, out.columns || 80, out.rows || 24);
      out.write(`\x1b[H${lines.join('\r\n')}`);
    };

    const refresh = async () => {
      try {
        const processes = await client.listProcesses() as Array<MonitProcess & { restartCount: number }>;
        state.processes = processes.map((p) => ({ ...p, restarts: p.restartCount }));
        recordHistory(state);
        const metrics = await client.getMetrics('json') as {
          system: { cpu: { percent: number }; memory: { used: number; total: number }; uptime: number };
        };
        state.system = {
          cpu: metrics.system.cpu.percent, memoryUsed: metrics.system.memory.used,
          memoryTotal: metrics.system.memory.total, uptime: metrics.system.uptime,
        };
        const selected = selectedProcess(state);
        if (selected) {
          const reports = await client.getHealth(selected.name) as Array<{ status: string; lastResult?: { message: string } }>;
          state.health = reports[0] ? { status: reports[0].status, message: reports[0].lastResult?.message } : undefined;
          state.logs = await client.queryLogs({ name: selected.name, lines: 50 }) as MonitState['logs'];
        } else {
          state.health = undefined;
          state.logs = [];
        }
      } catch (err) {
        state.notice = `Daemon unavailable: ${(err as Error).message}`;
      }
      if (!client.isConnected()) {
        stop('Lost connection to the daemon');
        return;
      }
      draw();
    };

    const stop = (message?: string) => {
      if (closing) return;
      closing = true;
      clearTimeout(timer);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      // Leave the alternate screen and show the cursor again
      out.write('\x1b[?25h\x1b[?1049l');
      if (message) term.info(message);
      void client.disconnect();
    };

    const loop = async () => {
      await refresh();
      if (!closing) timer = setTimeout(() => { void loop(); }, REFRESH_MS);
    };

    out.write('\x1b[?1049h\x1b[?25l\x1b[2J');
    out.on('resize', draw);
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf-8');
    process.stdin.resume();

    await new Promise<void>((resolveDone) => {
      process.stdin.on('data', (key: string) => {
        const action = handleKey(state, key);
        if (action?.type === 'quit') {
          stop();
          resolveDone();
          return;
        }
        if (action) {
          state.notice = `${action.type === 'restart' ? 'Restarting' : 'Stopping'} ${action.name}…`;
          const call = action.type === 'restart' ? client.restartProcess(action.name) : client.stopProcess(action.name);
          call
            .then(() => { state.notice = `${action.type === 'restart' ? 'Restarted' : 'Stopped'} ${action.name}`; })
            .catch((err: unknown) => { state.notice = `Failed: ${(err as Error).message}`; })
            .finally(() => { void refresh(); });
        }
        draw();
      });
      process.once('SIGTERM', () => { stop(); resolveDone(); });
      void loop().then(() => { if (closing) resolveDone(); });
    });
  }
}
