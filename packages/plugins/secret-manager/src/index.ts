import type { Plugin, PluginContext, ProcessConfig, ProcessInfo, SecretReference } from '../../../core/src/index.js';
import { SecretStore } from './store.js';

export { SecretStore, SecretError, assertSecretName, toDotenv, type SecretInfo } from './store.js';

/**
 * The part of the process-manager plugin this plugin relies on
 */
interface ProcessManagerApi {
  getProcesses(): ProcessInfo[];
  getProcessConfig(name: string): ProcessConfig | undefined;
  restartProcessFromPlugin(name: string): Promise<unknown>;
}

export function isSecretReference(value: unknown): value is SecretReference {
  return typeof value === 'object' && value !== null && typeof (value as { secret?: unknown }).secret === 'string';
}

/**
 * Names of the secrets a process config references in its env
 */
export function referencedSecrets(config: ProcessConfig): string[] {
  return Object.values(config.env ?? {}).filter(isSecretReference).map((ref) => ref.secret);
}

/**
 * Secret Manager Plugin
 * Resolves `{ secret: 'NAME' }` env references from the encrypted store when a process starts.
 * The store is read on every resolve, so `od secret set` takes effect at the next start or restart.
 */
export class SecretManagerPlugin implements Plugin {
  name = 'secret-manager';
  version = '1.0.0';
  description = 'Encrypted secrets injected into process environments';
  priority = 8;

  // Set in install(), which the kernel always calls before any other hook
  private context!: PluginContext;
  private readonly store: SecretStore;

  constructor(home: string) {
    this.store = new SecretStore(home);
  }

  install(context: PluginContext): void {
    this.context = context;
    context.registerMethod('secrets.rotated', (params: unknown) => {
      const name = (params as { name?: unknown } | undefined)?.name;
      return typeof name === 'string'
        ? this.restartUsers(name)
        : Promise.reject(new Error('secrets.rotated needs { name }'));
    });
  }

  /**
   * Value of a secret reference; throws if it does not exist, naming it (never the value)
   */
  resolve(ref: SecretReference): string {
    const value = this.store.get(ref.secret, ref.version);
    if (value === undefined) {
      const version = ref.version === undefined ? '' : ` version ${String(ref.version)}`;
      throw new Error(`Secret "${ref.secret}"${version} is not set (od secret set ${ref.secret} ...)`);
    }
    return value;
  }

  /**
   * Restart every running process whose env references the secret; returns their names
   */
  private async restartUsers(secret: string): Promise<string[]> {
    const pm = this.context.getPlugin('process-manager') as unknown as ProcessManagerApi | undefined;
    if (!pm) return [];
    const users = pm.getProcesses()
      .filter((p) => p.status === 'online' && referencedSecrets(pm.getProcessConfig(p.name) ?? { name: p.name, script: '' }).includes(secret))
      .map((p) => p.name);
    for (const name of users) {
      this.context.logger.info(`Secret "${secret}" changed; restarting "${name}"`);
      await pm.restartProcessFromPlugin(name);
    }
    return users;
  }
}
