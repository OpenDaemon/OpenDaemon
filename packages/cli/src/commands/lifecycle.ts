import type { OptionValue } from '../parser.js';
import type { Command } from './index.js';
import { ensureDaemonRunning } from './index.js';
import { term } from '../output.js';
import { CliClient } from '../client.js';

/**
 * Run `body` against the daemon, with the connection closed afterwards and any failure reported
 */
async function withDaemon(what: string, body: (client: CliClient) => Promise<void>, startDaemon = false): Promise<void> {
  if (startDaemon) await ensureDaemonRunning();
  const client = new CliClient();
  try {
    await client.connect();
    await body(client);
  } catch (err) {
    term.error(`${what}: ${(err instanceof Error ? err : new Error(String(err))).message}`);
    process.exit(1);
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

const jsonOption = { name: 'json', type: 'boolean' as const, description: 'Output as JSON' };

/**
 * save - remember the process list, so the daemon brings it back after a reboot (pm2 save)
 */
export class SaveCommand implements Command {
  name = 'save';
  description = 'Save the process list; the daemon restores it when it starts';
  options = [jsonOption];

  async execute(_args: string[], options: Record<string, OptionValue | undefined>): Promise<void> {
    await withDaemon('Failed to save', async (client) => {
      const result = await client.call('save') as { file: string; saved: string[] };
      if (options['json'] === true) { console.log(JSON.stringify(result)); return; }
      term.success(`Saved ${result.saved.length} process(es) to ${result.file}`);
    });
  }
}

/**
 * resurrect - start the saved processes that are not running (pm2 resurrect)
 */
export class ResurrectCommand implements Command {
  name = 'resurrect';
  description = 'Start the processes saved with `od save`';
  options = [jsonOption];

  async execute(_args: string[], options: Record<string, OptionValue | undefined>): Promise<void> {
    await withDaemon('Failed to resurrect', async (client) => {
      const result = await client.call('resurrect') as { started: string[]; skipped: string[]; failed: string[] };
      if (options['json'] === true) { console.log(JSON.stringify(result)); return; }
      term.success(`Started ${result.started.length}, left as they were ${result.skipped.length}`);
      if (result.failed.length > 0) {
        term.error(`Could not start: ${result.failed.join(', ')} (see \`od list\` and \`od logs\`)`);
        process.exit(1);
      }
    }, true);
  }
}
