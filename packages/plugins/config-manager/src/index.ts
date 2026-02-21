import type { Plugin, PluginContext } from '../../../core/src/index.js';
import { Logger } from '../../../core/src/index.js';
import { ConfigError, ErrorCode } from '../../../core/src/index.js';
import type { DaemonConfig, ProcessConfig } from '../../../core/src/index.js';
import { readFileSync, existsSync } from 'fs';
import { resolve, extname } from 'path';

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
  private logger: Logger;
  private configPath?: string;
  private loadedConfig: DaemonConfig = {};

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
  async onStart(context: PluginContext): Promise<void> {
    this.logger.info('Config manager starting');
    
    const configPath = this.findConfigFile();
    if (configPath) {
      this.configPath = configPath;
      this.loadedConfig = await this.loadConfig(configPath);
      this.logger.info(`Configuration loaded from: ${configPath}`);
    } else {
      this.logger.info('No configuration file found, using defaults');
      this.loadedConfig = this.getDefaultConfig();
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
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
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
    // For now, try to use dynamic import
    // In production, this would need ts-node or similar
    try {
      const module = await import(path);
      const config = module.default ?? module;
      return this.validateConfig(config);
    } catch (err) {
      throw new ConfigError(
        ErrorCode.CONFIG_PARSE_ERROR,
        `Failed to load TypeScript config: ${(err as Error).message}`,
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
      const module = await import(path);
      const config = module.default ?? module;
      return this.validateConfig(config);
    } catch (err) {
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
        const pkg = JSON.parse(content);
        return this.validateConfig(pkg.opendaemon ?? {});
      }
      
      const config = JSON.parse(content);
      return this.validateConfig(config);
    } catch (err) {
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
      const config = this.parseYaml(content);
      return this.validateConfig(config);
    } catch (err) {
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
   * Simple YAML parser
   */
  private parseYaml(content: string): unknown {
    const lines = content.split('\n');
    const result: Record<string, unknown> = {};
    let currentKey = '';
    let currentArray: unknown[] = [];
    let inArray = false;

    for (const line of lines) {
      const trimmed = line.trim();
      
      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      // Check for array items
      if (trimmed.startsWith('- ')) {
        if (!inArray) {
          inArray = true;
          currentArray = [];
        }
        const value = trimmed.slice(2).trim();
        currentArray.push(this.parseYamlValue(value));
        continue;
      }

      // If we were in an array, save it
      if (inArray && currentKey) {
        result[currentKey] = currentArray;
        inArray = false;
        currentArray = [];
      }

      // Parse key-value pair
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex > -1) {
        const key = trimmed.slice(0, colonIndex).trim();
        const value = trimmed.slice(colonIndex + 1).trim();
        
        currentKey = key;
        
        if (value) {
          result[key] = this.parseYamlValue(value);
        }
      }
    }

    // Handle last array if any
    if (inArray && currentKey) {
      result[currentKey] = currentArray;
    }

    return result;
  }

  /**
   * Parse YAML value
   */
  private parseYamlValue(value: string): unknown {
    // Remove quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Try to parse as number
    if (/^-?\d+$/.test(value)) {
      return parseInt(value, 10);
    }
    if (/^-?\d+\.\d+$/.test(value)) {
      return parseFloat(value);
    }

    // Try to parse as boolean
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null') return null;

    return value;
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

      for (const app of cfg.apps) {
        this.validateProcessConfig(app);
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
      daemon: {
        pidFile: './opendaemon.pid',
        logDir: './logs',
        socketPath: './opendaemon.sock',
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
