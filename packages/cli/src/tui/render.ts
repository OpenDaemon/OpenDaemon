/**
 * `od monit` screen model: pure functions from state to lines, and from keys to actions, so the
 * dashboard can be tested without a terminal. Raw ANSI escapes only (zero dependencies).
 */

export interface MonitProcess {
  id: number;
  name: string;
  mode: string;
  instances: number;
  runningInstances: number;
  restarts: number;
  cpu: number;
  memory: number;
  /** ms */
  uptime: number;
  status: string;
}

export interface MonitState {
  version: string;
  system?: { cpu: number; memoryUsed: number; memoryTotal: number; uptime: number } | undefined;
  processes: MonitProcess[];
  selected: number;
  /** recent cpu (%) and memory (bytes) samples per process name, oldest first */
  history: Map<string, { cpu: number[]; memory: number[] }>;
  health?: { status: string; message?: string | undefined } | undefined;
  logs: Array<{ timestamp: string; processName: string; source: string; message: string }>;
  /** feedback line, e.g. "Restarting api…" or an error */
  notice?: string | undefined;
  color: boolean;
}

export type MonitAction = { type: 'quit' } | { type: 'restart' | 'stop'; name: string };

const HISTORY = 60;
const BARS = '▁▂▃▄▅▆▇█';

// eslint-disable-next-line no-control-regex -- measuring text means skipping ANSI escapes
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * Visible width in code points (the same unit fit() counts), ignoring ANSI escapes
 */
export function visibleLength(text: string): number {
  let count = 0;
  for (const _char of text.replace(ANSI, '')) count++;
  return count;
}

/**
 * Pad or cut a line to exactly `width` visible characters, keeping colour codes intact
 */
export function fit(text: string, width: number): string {
  let out = '';
  let visible = 0;
  let i = 0;
  while (i < text.length && visible < width) {
    if (text[i] === '\x1b') {
      // eslint-disable-next-line no-control-regex -- matching an ANSI escape at this position
      const match = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(text.slice(i));
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    const char = String.fromCodePoint(text.codePointAt(i) ?? 32);
    out += char;
    i += char.length;
    visible++;
  }
  // Close any colour left open by the cut, then pad
  return `${out}${text.includes('\x1b[') ? '\x1b[0m' : ''}${' '.repeat(Math.max(0, width - visible))}`;
}

export function sparkline(values: readonly number[], width: number, max?: number): string {
  const series = values.slice(-width);
  const top = max ?? Math.max(...series, 1);
  return series.map((v) => BARS[Math.min(BARS.length - 1, Math.max(0, Math.round((v / top) * (BARS.length - 1))))] ?? ' ').join('');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)}B`;
  const units = ['K', 'M', 'G', 'T'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)}${units[unit] ?? 'T'}`;
}

export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${String(s)}s`;
  if (s < 3600) return `${String(Math.floor(s / 60))}m`;
  if (s < 86400) return `${String(Math.floor(s / 3600))}h ${String(Math.floor((s % 3600) / 60))}m`;
  return `${String(Math.floor(s / 86400))}d ${String(Math.floor((s % 86400) / 3600))}h`;
}

/**
 * Record a refresh in the per-process history (bounded)
 */
export function recordHistory(state: MonitState): void {
  for (const p of state.processes) {
    const entry = state.history.get(p.name) ?? { cpu: [], memory: [] };
    entry.cpu.push(p.cpu);
    entry.memory.push(p.memory);
    if (entry.cpu.length > HISTORY) entry.cpu.shift();
    if (entry.memory.length > HISTORY) entry.memory.shift();
    state.history.set(p.name, entry);
  }
  for (const name of state.history.keys()) {
    if (!state.processes.some((p) => p.name === name)) state.history.delete(name);
  }
  state.selected = Math.min(state.selected, Math.max(0, state.processes.length - 1));
}

export function selectedProcess(state: MonitState): MonitProcess | undefined {
  return state.processes[state.selected];
}

/**
 * Apply a keypress; returns the action to perform, if any
 */
export function handleKey(state: MonitState, key: string): MonitAction | undefined {
  const last = Math.max(0, state.processes.length - 1);
  switch (key) {
    case '\x1b[A': case 'k':
      state.selected = Math.max(0, state.selected - 1);
      return undefined;
    case '\x1b[B': case 'j':
      state.selected = Math.min(last, state.selected + 1);
      return undefined;
    case '\x1b[H': case 'g':
      state.selected = 0;
      return undefined;
    case '\x1b[F': case 'G':
      state.selected = last;
      return undefined;
    case 'q': case '\x03':
      return { type: 'quit' };
    case 'r': case 's': {
      const proc = selectedProcess(state);
      return proc ? { type: key === 'r' ? 'restart' : 'stop', name: proc.name } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Render the dashboard to exactly `height` lines of `width` visible characters
 */
export function render(state: MonitState, width: number, height: number): string[] {
  const paint = (code: string, text: string) => (state.color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const statusCell = (status: string) => {
    switch (status) {
      case 'online': return paint('32', '● online');
      case 'errored': return paint('31', '✗ errored');
      case 'stopped': return paint('90', '○ stopped');
      default: return paint('33', `◌ ${status}`);
    }
  };
  const lines: string[] = [];

  const sys = state.system;
  lines.push(paint('1', ` OpenDaemon v${state.version}`) + (sys
    ? `   cpu ${sys.cpu.toFixed(0)}%   mem ${formatBytes(sys.memoryUsed)}/${formatBytes(sys.memoryTotal)}   up ${formatUptime(sys.uptime * 1000)}`
    : ''));
  const count = (status: string) => state.processes.filter((p) => p.status === status).length;
  lines.push(` Processes: ${String(state.processes.length)} (${String(count('online'))} online, ${String(count('stopped'))} stopped, ${String(count('errored'))} errored)`);
  lines.push('');

  const columns = ['ID', 'Name', 'Mode', '↺', 'CPU', 'Mem', 'Uptime', 'Status'];
  const nameWidth = Math.max(8, Math.min(30, width - 62));
  const row = (cells: string[]) => {
    const widths = [4, nameWidth, 11, 4, 7, 8, 9, 12];
    return ` ${cells.map((cell, i) => fit(cell, widths[i] ?? 8)).join(' ')}`;
  };
  lines.push(paint('1', row(columns)));
  if (state.processes.length === 0) {
    lines.push(paint('90', ' No processes. Start one with `od start <script>`.'));
  }
  state.processes.forEach((p, i) => {
    const mode = p.mode === 'cluster' ? `cluster ${String(p.runningInstances)}/${String(p.instances)}` : p.mode;
    const line = row([String(p.id), p.name, mode, String(p.restarts), `${p.cpu.toFixed(1)}%`, formatBytes(p.memory), p.status === 'online' ? formatUptime(p.uptime) : '-', statusCell(p.status)]);
    lines.push(i === state.selected ? (state.color ? `\x1b[7m${fit(line, width)}\x1b[0m` : `>${line.slice(1)}`) : line);
  });
  lines.push('');

  const selected = selectedProcess(state);
  if (selected) {
    const history = state.history.get(selected.name) ?? { cpu: [], memory: [] };
    const graph = Math.max(10, Math.floor((width - 30) / 2));
    lines.push(paint('1', ` ${selected.name}`) + paint('90', ' (selected)'));
    lines.push(`  CPU    ${sparkline(history.cpu, graph, 100)}  ${selected.cpu.toFixed(1)}%  peak ${Math.max(0, ...history.cpu).toFixed(1)}%`);
    lines.push(`  Memory ${sparkline(history.memory, graph)}  ${formatBytes(selected.memory)}`);
    const health = state.health;
    lines.push(health
      ? `  Health ${health.status === 'healthy' ? paint('32', '● healthy') : health.status === 'unhealthy' ? paint('31', '✗ unhealthy') : paint('33', '◌ pending')}${health.message ? `  ${health.message}` : ''}`
      : paint('90', '  Health: no health check'));
    lines.push('');
  }

  const footer = paint('90', ' [↑↓/jk] select  [r] restart  [s] stop  [q] quit') + (state.notice ? `   ${state.notice}` : '');
  const logRows = Math.max(0, height - lines.length - 2);
  if (logRows > 0) {
    lines.push(paint('1', ' Recent logs'));
    const logs = state.logs.slice(-(logRows - 1));
    for (const entry of logs) {
      const time = entry.timestamp.slice(11, 19);
      const tag = paint(entry.source === 'stderr' ? '31' : '36', entry.processName);
      lines.push(` ${paint('90', time)} ${tag} ${entry.message}`);
    }
  }

  const body = lines.slice(0, Math.max(0, height - 1));
  while (body.length < height - 1) body.push('');
  return [...body, footer].map((line) => fit(line, width));
}
