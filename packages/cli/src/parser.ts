/**
 * CLI option definition
 */
export interface CliOption {
  name: string;
  alias?: string;
  type: 'string' | 'number' | 'boolean' | 'array';
  description?: string;
  default?: unknown;
  required?: boolean;
}

/**
 * Parsed option value
 */
export type OptionValue = string | number | boolean | string[];

/**
 * Parsed command result
 */
export interface ParsedCommand {
  command: string;
  subcommand: string;
  args: string[];
  options: Record<string, OptionValue | undefined>;
}

/**
 * CLI command parser from scratch.
 * No external dependencies like commander.
 *
 * @example
 * ```typescript
 * const parser = new CommandParser();
 *
 * parser.addOption({
 *   name: 'verbose',
 *   alias: 'v',
 *   type: 'boolean',
 *   description: 'Enable verbose output'
 * });
 *
 * const result = parser.parse(['start', 'app.js', '--verbose']);
 * // result.command = 'start'
 * // result.args = ['app.js']
 * // result.options.verbose = true
 * ```
 */
export class CommandParser {
  private options = new Map<string, CliOption>();
  private aliases = new Map<string, string>();

  /**
   * Add a global option
   *
   * @param option - Option definition
   */
  addOption(option: CliOption): void {
    this.options.set(option.name, option);

    if (option.alias) {
      this.aliases.set(option.alias, option.name);
    }
  }

  /**
   * Parse command line arguments
   *
   * @param args - Arguments array (typically process.argv.slice(2))
   * @returns Parsed command
   */
  parse(args: string[]): ParsedCommand {
    const result: ParsedCommand = {
      command: '',
      subcommand: '',
      args: [],
      options: {},
    };

    // Set default values
    for (const [name, option] of this.options) {
      if (option.default !== undefined) {
        result.options[name] = option.default as OptionValue;
      }
    }

    let i = 0;

    // Parse global options before command
    while (i < args.length) {
      const arg = args[i];
      if (!arg || !arg.startsWith('-')) break;
      const consumed = this.parseOption(args, i, result.options);
      if (consumed === 0) {
        break;
      }
      i += consumed;
    }

    // Parse command
    if (i < args.length) {
      const arg = args[i];
      if (arg && !arg.startsWith('-')) {
        result.command = arg;
        i++;
      }
    }

    // Parse subcommand
    if (i < args.length) {
      const arg = args[i];
      if (arg && !arg.startsWith('-') && this.isSubcommand(arg)) {
        result.subcommand = arg;
        i++;
      }
    }

    // Parse command options and arguments
    while (i < args.length) {
      const arg = args[i];
      if (!arg) break;

      if (arg.startsWith('-')) {
        const consumed = this.parseOption(args, i, result.options);
        if (consumed === 0) {
          // Unknown option, treat as argument
          result.args.push(arg);
          i++;
        } else {
          i += consumed;
        }
      } else {
        result.args.push(arg);
        i++;
      }
    }

    return result;
  }

  /**
   * Parse a single option
   *
   * @param args - Arguments array
   * @param index - Current index
   * @param options - Options object to populate
   * @returns Number of arguments consumed
   */
  private parseOption(
    args: string[],
    index: number,
    options: Record<string, OptionValue | undefined>
  ): number {
    const arg = args[index];
    if (!arg) return 0;

    // Long option: --name or --name=value
    if (arg.startsWith('--')) {
      const equalIndex = arg.indexOf('=');
      let name: string;
      let value: string | undefined;

      if (equalIndex > -1) {
        name = arg.slice(2, equalIndex);
        value = arg.slice(equalIndex + 1);
      } else {
        name = arg.slice(2);
      }

      const option = this.options.get(name);
      if (!option) {
        return 0;
      }

      if (option.type === 'boolean') {
        options[name] = true;
        return 1;
      }

      if (value !== undefined) {
        options[name] = this.parseValue(value, option.type);
        return 1;
      }

      const nextArg = index + 1 < args.length ? args[index + 1] : undefined;
      if (nextArg && !nextArg.startsWith('-')) {
        const value = nextArg;
        if (option.type === 'array') {
          const current = (options[name] as string[]) ?? [];
          current.push(value);
          options[name] = current;
        } else {
          options[name] = this.parseValue(value, option.type);
        }
        return 2;
      }

      // Flag-style option with non-boolean type
      if (option.type === 'array') {
        const current = (options[name] as string[]) ?? [];
        current.push('true');
        options[name] = current;
      } else {
        options[name] = true;
      }
      return 1;
    }

    // Short option: -a or -abc (combined flags)
    if (arg.startsWith('-') && arg.length > 1) {
      const flags = arg.slice(1);

      // Single flag: -v
      if (flags.length === 1) {
        const fullName = this.aliases.get(flags);
        if (!fullName) {
          return 0;
        }

        const option = this.options.get(fullName);
        if (!option) return 0;

        if (option.type === 'boolean') {
          options[fullName] = true;
          return 1;
        }

        const nextArg = index + 1 < args.length ? args[index + 1] : undefined;
        if (nextArg && !nextArg.startsWith('-')) {
          options[fullName] = this.parseValue(nextArg, option.type);
          return 2;
        }

        return 0;
      }

      // Combined flags: -abc (all booleans)
      for (const flag of flags) {
        const fullName = this.aliases.get(flag);
        if (!fullName) {
          return 0;
        }

        const option = this.options.get(fullName);
        if (!option || option.type !== 'boolean') {
          return 0;
        }

        options[fullName] = true;
      }

      return 1;
    }

    return 0;
  }

  /**
   * Parse option value based on type
   */
  private parseValue(value: string, type: CliOption['type']): OptionValue {
    switch (type) {
      case 'number':
        return Number(value);
      case 'boolean':
        return value === 'true' || value === '1' || value === '';
      case 'array':
        return [value];
      default:
        return value;
    }
  }

  /**
   * Check if argument is a subcommand
   */
  private isSubcommand(arg: string): boolean {
    // Common subcommands
    const subcommands = [
      'start',
      'stop',
      'restart',
      'reload',
      'list',
      'logs',
      'info',
      'delete',
      'scale',
      'status',
      'daemon',
      'plugin',
      'secret',
      'deploy',
    ];

    return subcommands.includes(arg);
  }

  /**
   * Get all registered options
   */
  getOptions(): CliOption[] {
    return Array.from(this.options.values());
  }
}
