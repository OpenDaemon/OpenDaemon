/**
 * ANSI color codes
 */
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

/**
 * Color names
 */
type ColorName = keyof typeof colors;

/**
 * Terminal output helper with color support.
 * No external dependencies like chalk.
 */
export class TerminalOutput {
  private isTTY: boolean;
  private noColor: boolean;

  constructor() {
    this.isTTY = process.stdout.isTTY ?? false;
    this.noColor = process.env['NO_COLOR'] !== undefined;
  }

  /**
   * Apply color to text
   *
   * @param color - Color name
   * @param text - Text to color
   * @returns Colored text
   */
  color(color: ColorName, text: string): string {
    if (!this.isTTY || this.noColor) {
      return text;
    }
    return `${colors[color]}${text}${colors.reset}`;
  }

  /**
   * Make text bold
   *
   * @param text - Text to format
   * @returns Bold text
   */
  bold(text: string): string {
    if (!this.isTTY || this.noColor) {
      return text;
    }
    return `${colors.bright}${text}${colors.reset}`;
  }

  /**
   * Make text dim
   *
   * @param text - Text to format
   * @returns Dim text
   */
  dim(text: string): string {
    if (!this.isTTY || this.noColor) {
      return text;
    }
    return `${colors.dim}${text}${colors.reset}`;
  }

  /**
   * Create a table string
   *
   * @param headers - Column headers
   * @param rows - Table rows
   * @returns Formatted table
   */
  table(headers: string[], rows: string[][]): string {
    if (rows.length === 0) {
      return '';
    }

    // Calculate column widths
    const widths = headers.map((header, i) => {
      const columnValues = [header, ...rows.map(row => row[i] ?? '')];
      return Math.max(...columnValues.map(v => v.length));
    });

    // Build table
    const lines: string[] = [];

    // Header row
    const headerRow =
      '| ' +
      headers.map((h, i) => h.padEnd(widths[i] ?? 0)).join(' | ') +
      ' |';
    lines.push(this.bold(headerRow));

    // Separator
    const separator =
      '|' + widths.map(w => '-'.repeat((w ?? 0) + 2)).join('|') + '|';
    lines.push(separator);

    // Data rows
    for (const row of rows) {
      const dataRow =
        '| ' + row.map((cell, i) => (cell ?? '').padEnd(widths[i] ?? 0)).join(' | ') + ' |';
      lines.push(dataRow);
    }

    return lines.join('\n');
  }

  /**
   * Format a list
   *
   * @param items - Items to list
   * @returns Formatted list
   */
  list(items: string[]): string {
    return items.map(item => `  • ${item}`).join('\n');
  }

  /**
   * Format a key-value pair
   *
   * @param key - Key
   * @param value - Value
   * @returns Formatted pair
   */
  keyValue(key: string, value: string): string {
    return `${this.dim(key + ':')} ${value}`;
  }

  /**
   * Create a spinner instance
   *
   * @param text - Spinner text
   * @returns Spinner controller
   */
  spinner(text: string): Spinner {
    return new Spinner(text, this);
  }

  /**
   * Print success message
   *
   * @param message - Message to print
   */
  success(message: string): void {
    console.log(`${this.color('green', '✓')} ${message}`);
  }

  /**
   * Print error message
   *
   * @param message - Message to print
   */
  error(message: string): void {
    console.error(`${this.color('red', '✗')} ${message}`);
  }

  /**
   * Print warning message
   *
   * @param message - Message to print
   */
  warn(message: string): void {
    console.warn(`${this.color('yellow', '⚠')} ${message}`);
  }

  /**
   * Print info message
   *
   * @param message - Message to print
   */
  info(message: string): void {
    console.log(`${this.color('blue', 'ℹ')} ${message}`);
  }
}

/**
 * Spinner animation
 */
class Spinner {
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private frame = 0;
  private interval: NodeJS.Timeout | undefined;
  private text: string;
  private output: TerminalOutput;

  constructor(text: string, output: TerminalOutput) {
    this.text = text;
    this.output = output;
  }

  /**
   * Start the spinner
   */
  start(): void {
    if (this.interval) {
      return;
    }

    // Hide cursor
    process.stdout.write('\x1b[?25l');

    this.interval = setInterval(() => {
      const frame = this.frames[this.frame] ?? '⠋';
      const spinner = this.output!.color('cyan', frame);
      process.stdout.write(`\r${spinner} ${this.text}`);
      this.frame = (this.frame + 1) % this.frames.length;
    }, 80);
  }

  /**
   * Stop the spinner
   *
   * @param success - Whether operation succeeded
   * @param message - Optional final message
   */
  stop(success = true, message?: string): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }

    // Show cursor
    process.stdout.write('\x1b[?25h');

    // Clear line
    process.stdout.write('\r\x1b[K');

    // Print final message
    const finalMessage = message ?? this.text;
    if (success) {
      this.output.success(finalMessage);
    } else {
      this.output.error(finalMessage);
    }
  }

  /**
   * Update spinner text
   *
   * @param text - New text
   */
  update(text: string): void {
    this.text = text;
  }
}

/**
 * Global terminal output instance
 */
export const term = new TerminalOutput();
