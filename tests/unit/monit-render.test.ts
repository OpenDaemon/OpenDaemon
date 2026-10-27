import { describe, it, expect } from 'vitest';
import {
  fit, visibleLength, sparkline, formatBytes, formatUptime, handleKey, recordHistory, render,
  type MonitState, type MonitProcess,
} from '../../packages/cli/src/tui/render.js';

const proc = (overrides: Partial<MonitProcess> = {}): MonitProcess => ({
  id: 0, name: 'api', mode: 'fork', instances: 1, runningInstances: 1, restarts: 0,
  cpu: 12.5, memory: 64 * 1024 * 1024, uptime: 3_700_000, status: 'online', ...overrides,
});

const state = (overrides: Partial<MonitState> = {}): MonitState => ({
  version: '1.0.0',
  system: { cpu: 23, memoryUsed: 2 * 1024 ** 3, memoryTotal: 8 * 1024 ** 3, uptime: 14 * 86400 + 3 * 3600 },
  processes: [proc(), proc({ id: 1, name: 'worker', mode: 'cluster', instances: 4, runningInstances: 3, status: 'errored', restarts: 2 })],
  selected: 0,
  history: new Map([['api', { cpu: [0, 50, 100], memory: [1, 2, 3] }]]),
  logs: [{ timestamp: '2026-01-01T14:23:01.000Z', processName: 'api', source: 'stdout', message: 'Request processed in 12ms' }],
  color: false,
  ...overrides,
});

describe('fit and visibleLength', () => {
  it('should pad and cut to an exact visible width, ignoring ANSI codes', () => {
    expect(fit('abc', 5)).toBe('abc  ');
    expect(fit('abcdef', 3)).toBe('abc');
    const colored = fit('\x1b[32mgreen\x1b[0m text', 7);
    expect(visibleLength(colored)).toBe(7);
    expect(colored.startsWith('\x1b[32mgreen')).toBe(true);
    expect(colored.endsWith('\x1b[0m')).toBe(true);
    expect(visibleLength(fit('●▁█ok', 4))).toBe(4);
  });
});

describe('formatting helpers', () => {
  it('should draw sparklines scaled to a maximum', () => {
    expect(sparkline([0, 50, 100], 10, 100)).toBe('▁▅█');
    expect(sparkline([1, 2, 3, 4], 2)).toBe('▆█');
    expect(sparkline([], 5)).toBe('');
  });

  it.each([[512, '512B'], [2048, '2.0K'], [64 * 1024 * 1024, '64.0M'], [300 * 1024 ** 3, '300G']])('formatBytes(%d) = %s', (n, s) => {
    expect(formatBytes(n)).toBe(s);
  });

  it.each([[5_000, '5s'], [125_000, '2m'], [3_700_000, '1h 1m'], [90_061_000, '1d 1h']])('formatUptime(%d) = %s', (ms, s) => {
    expect(formatUptime(ms)).toBe(s);
  });
});

describe('handleKey', () => {
  it('should move the selection within bounds', () => {
    const s = state();
    expect(handleKey(s, '\x1b[B')).toBeUndefined();
    expect(s.selected).toBe(1);
    handleKey(s, 'j');
    expect(s.selected).toBe(1);
    handleKey(s, 'k');
    handleKey(s, '\x1b[A');
    expect(s.selected).toBe(0);
    handleKey(s, 'G');
    expect(s.selected).toBe(1);
    handleKey(s, 'g');
    expect(s.selected).toBe(0);
  });

  it('should map r/s to actions on the selected process, and q/Ctrl+C to quit', () => {
    const s = state({ selected: 1 });
    expect(handleKey(s, 'r')).toEqual({ type: 'restart', name: 'worker' });
    expect(handleKey(s, 's')).toEqual({ type: 'stop', name: 'worker' });
    expect(handleKey(s, 'q')).toEqual({ type: 'quit' });
    expect(handleKey(s, '\x03')).toEqual({ type: 'quit' });
    expect(handleKey(state({ processes: [] }), 'r')).toBeUndefined();
  });
});

describe('recordHistory', () => {
  it('should keep 60 samples, drop gone processes and clamp the selection', () => {
    const s = state({ selected: 1, history: new Map([['gone', { cpu: [1], memory: [1] }]]) });
    for (let i = 0; i < 70; i++) recordHistory(s);
    expect(s.history.get('api')?.cpu).toHaveLength(60);
    expect(s.history.has('gone')).toBe(false);

    s.processes = [proc()];
    recordHistory(s);
    expect(s.selected).toBe(0);
  });
});

describe('render', () => {
  it.each([[100, 30], [80, 24], [40, 12], [20, 5]])('should produce exactly %d x %d', (width, height) => {
    const lines = render(state({ color: true }), width, height);
    expect(lines).toHaveLength(height);
    for (const line of lines) expect(visibleLength(line)).toBe(width);
  });

  it('should show the header, table, selected panel, logs and key help', () => {
    const text = render(state(), 100, 30).join('\n');
    expect(text).toContain('OpenDaemon v1.0.0   cpu 23%   mem 2.0G/8.0G   up 14d 3h');
    expect(text).toContain('Processes: 2 (1 online, 0 stopped, 1 errored)');
    expect(text).toMatch(/>.*api.*fork.*12\.5%.*64\.0M.*1h 1m.*● online/);
    expect(text).toMatch(/worker.*cluster 3\/4.*2.*✗ errored/);
    expect(text).toContain('CPU    ▁▅█  12.5%  peak 100.0%');
    expect(text).toContain('Health: no health check');
    expect(text).toContain('14:23:01 api Request processed in 12ms');
    expect(text.split('\n').at(-1)).toContain('[r] restart  [s] stop  [q] quit');
  });

  it('should show health, notices and an empty state', () => {
    const text = render(state({ health: { status: 'unhealthy', message: 'HTTP 500' }, notice: 'Restarting api…' }), 100, 30).join('\n');
    expect(text).toContain('Health ✗ unhealthy  HTTP 500');
    expect(text).toContain('Restarting api…');
    expect(render(state({ processes: [] }), 100, 20).join('\n')).toContain('No processes. Start one with `od start <script>`.');
  });
});
