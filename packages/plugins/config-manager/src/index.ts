import type { Plugin, PluginContext } from '../../../core/src/index.js';
import { Logger } from '../../../core/src/index.js';
import { ConfigError, ErrorCode } from '../../../core/src/index.js';
import type { DaemonConfig, ProcessConfig } from '../../../core/src/index.js';
import { readFileSync, existsSync } from 'fs';
import { resolve, extname } from 'path';
import { pathToFileURL } from 'url';
import { parseYaml } from './yaml.js';

/**
 * Config Manager Plugin
 * Loads and manages configuration files
 */
export class ConfigManagerPlugin implements Plugin {
  name = 'config-manager';
  version = '1.0.0';
  description = 'Loads and manages configuration files';
  priority = 5;

  private context!: PluginContext;
  private readonly logger: Logger;
  private configPath?: string;
  private loadedConfig: DaemonConfig = {};
  private loaded = false;

  constructor() {
    this.logger = new Logger('config-manager');
  }

  /**
   * Install the plugin
   */
  install(context: PluginContext): void {
    this.context = context;
    this.logger.info('Config manager installed');

    // Register RPC methods
    context.registerMethod('get', this.getConfig.bind(this));
    context.registerMethod('reload', this.reloadConfig.bind(this));
  }

  /**
   * Start the plugin - load config
   */
  /**
   * Discover and load the configuration file from the working directory.
   * The daemon calls this before starting the kernel, so the result is what
   * every plugin receives as context.config.
   */
  async load(): Promise<DaemonConfig> {
    const configPath = this.findConfigFile();
    if (configPath) {
      this.configPath = configPath;
      this.loadedConfig = await this.loadConfig(configPath);
      this.logger.info(`Configuration loaded from: ${configPath}`);
    } else {
      this.logger.info('No configuration file found, using defaults');
      this.loadedConfig = this.getDefaultConfig();
    }
    this.loaded = true;
    return this.loadedConfig;
  }

  async onStart(context: PluginContext): Promise<void> {
    this.logger.info('Config manager starting');

    if (!this.loaded) {
      await this.load();
    }

    // Emit config loaded event
    context.events.emit('config:loaded', this.loadedConfig);
  }

  /**
   * Get current configuration
   */
  private getConfig(): DaemonConfig {
    return this.loadedConfig;
  }

  /**
   * Reload configuration
   */
  private async reloadConfig(): Promise<DaemonConfig> {
    if (!this.configPath) {
      throw new ConfigError(
        ErrorCode.CONFIG_NOT_FOUND,
        'No configuration file to reload'
      );
    }

    this.logger.info(`Reloading configuration from: ${this.configPath}`);
    this.loadedConfig = await this.loadConfig(this.configPath);
    
    this.context.events.emit('config:reloaded', this.loadedConfig);
    
    return this.loadedConfig;
  }

  /**
   * Find configuration file
   */
  private findConfigFile(): string | undefined {
    const candidates = [
      'opendaemon.config.ts',
      'opendaemon.config.js',
      'opendaemon.config.mjs',
      'opendaemon.config.cjs',
      'opendaemon.config.json',
      'opendaemon.config.yaml',
      'opendaemon.config.yml',
      '.opendaemonrc',
      '.opendaemonrc.json',
    ];

    for (const candidate of candidates) {
      const path = resolve(candidate);
      if (existsSync(path)) {
        return path;
      }
    }

    // Check package.json
    const pkgPath = resolve('package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { opendaemon?: unknown };
        if (pkg.opendaemon) {
          return pkgPath;
        }
      } catch {
        // Ignore
      }
    }

    return undefined;
  }

  /**
   * Load configuration from file
   */
  private async loadConfig(path: string): Promise<DaemonConfig> {
    const ext = extname(path);
    
    try {
      switch (ext) {
        case '.ts':
          return await this.loadTypeScriptConfig(path);
        case '.js':
        case '.mjs':
        case '.cjs':
          return await this.loadJavaScriptConfig(path);
        case '.json':
        case '':
          return this.loadJsonConfig(path);
        case '.yaml':
        case '.yml':
          return this.loadYamlConfig(path);
        default:
          throw new ConfigError(
            ErrorCode.CONFIG_INVALID,
            `Unsupported config file extension: ${ext}`,
            path
          );
      }
    } catch (err) {
      if (err instanceof ConfigError) {
        throw err;
      }
      throw new ConfigError(
        ErrorCode.CONFIG_PARSE_ERROR,
        `Failed to load config: ${(err as Error).message}`,
        path,
        undefined,
        err as Error
      );
    }
  }

  /**
   * Load TypeScript config
   */
  private async loadTypeScriptConfig(path: string): Promise<DaemonConfig> {
    // Relies on Node's built-in type stripping (Node >= 22.18, or 22.6 with
    // --experimental-strip-types); there is no bundled TypeScript loader
    try {
      const module = await import(pathToFileURL(path).href) as { default?: unknown };
      const config = module.default ?? module;
      return this.validateConfig(config);
    } catch (err) {
      if (err instanceof ConfigError) {
        throw err;
      }
      const hint = (err as NodeJS.ErrnoException).code === 'ERR_UNKNOWN_FILE_EXTENSION'
        ? ' (this Node.js version cannot load .ts files; use Node >= 22.18 or a .js/.json/.yaml config)'
        : '';
      throw new ConfigError(
        ErrorCode.CONFIG_PARSE_ERROR,
        `Failed to load TypeScript config: ${(err as Error).message}${hint}`,
        path,
        undefined,
        err as Error
      );
    }
  }

  /**
   * Load JavaScript config
   */
  private async loadJavaScriptConfig(path: string): Promise<DaemonConfig> {
    try {
      // A file URL works on Windows too, where an absolute path is not a valid specifier
      const module = await import(pathToFileURL(path).href) as { default?: unknown };
      const config = module.default ?? module;
      return this.validateConfig(config);
    } catch (err) {
      if (err instanceof ConfigError) {
        throw err;
      }
      throw new ConfigError(
        ErrorCode.CONFIG_PARSE_ERROR,
        `Failed to load JavaScript config: ${(err as Error).message}`,
        path,
        undefined,
        err as Error
      );
    }
  }

  /**
   * Load JSON config
   */
  private loadJsonConfig(path: string): DaemonConfig {
    try {
      const content = readFileSync(path, 'utf-8');
      
      // Check if it's package.json with opendaemon field
      if (path.endsWith('package.json')) {
        const pkg = JSON.parse(content) as { opendaemon?: unknown };
        return this.validateConfig(pkg.opendaemon ?? {});
      }
      
      const config = JSON.parse(content) as unknown;
      return this.validateConfig(config);
    } catch (err) {
      if (err instanceof ConfigError) {
        throw err;
      }
      throw new ConfigError(
        ErrorCode.CONFIG_PARSE_ERROR,
        `Failed to parse JSON config: ${(err as Error).message}`,
        path,
        undefined,
        err as Error
      );
    }
  }

  /**
   * Load YAML config
   */
  private loadYamlConfig(path: string): DaemonConfig {
    // Simple YAML parser for basic cases
    try {
      const content = readFileSync(path, 'utf-8');
      const config = parseYaml(content);
      return this.validateConfig(config);
    } catch (err) {
      if (err instanceof ConfigError) {
        throw err;
      }
      throw new ConfigError(
        ErrorCode.CONFIG_PARSE_ERROR,
        `Failed to parse YAML config: ${(err as Error).message}`,
        path,
        undefined,
        err as Error
      );
    }
  }

  /**
   * Validate and normalize config
   */
  private validateConfig(config: unknown): DaemonConfig {
    if (typeof config !== 'object' || config === null) {
      throw new ConfigError(
        ErrorCode.CONFIG_VALIDATION_ERROR,
        'Config must be an object'
      );
    }

    const cfg = config as DaemonConfig;

    // Validate apps if present
    if (cfg.apps) {
      if (!Array.isArray(cfg.apps)) {
        throw new ConfigError(
          ErrorCode.CONFIG_VALIDATION_ERROR,
          'apps must be an array'
        );
      }

      for (const app of cfg.apps as unknown[]) {
        if (typeof app !== 'object' || app === null || Array.isArray(app)) {
          throw new ConfigError(
            ErrorCode.CONFIG_VALIDATION_ERROR,
            'Each entry in apps must be an object with name and script'
          );
        }
        this.validateProcessConfig(app as ProcessConfig);
      }
    }

    // Apply defaults
    return this.applyDefaults(cfg);
  }

  /**
   * Validate process config
   */
  private validateProcessConfig(config: ProcessConfig): void {
    if (!config.name) {
      throw new ConfigError(
        ErrorCode.CONFIG_VALIDATION_ERROR,
        'Process config must have a name'
      );
    }

    if (!config.script) {
      throw new ConfigError(
        ErrorCode.CONFIG_VALIDATION_ERROR,
        `Process "${config.name}" must have a script`
      );
    }
  }

  /**
   * Apply defaults to config
   */
  private applyDefaults(config: DaemonConfig): DaemonConfig {
    const defaults = config.defaults ?? {};

    if (config.apps) {
      config.apps = config.apps.map((app) => ({
        ...defaults,
        ...app,
      }));
    }

    return config;
  }

  /**
   * Get default configuration
   */
  private getDefaultConfig(): DaemonConfig {
    return {
      // Runtime file locations (PID, socket, logs) default to $OPENDAEMON_HOME, set by the daemon
      daemon: {
        shutdownTimeout: 10000,
      },
      defaults: {
        instances: 1,
        mode: 'fork',
        autoRestart: true,
        restartDelay: 1000,
        maxRestarts: 10,
        killTimeout: 5000,
      },
    };
  }
}
