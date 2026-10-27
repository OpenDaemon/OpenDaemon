import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import { createServer as createTcpServer, type Server as TcpServer, type AddressInfo } from 'net';
import { spawn } from 'child_process';
import { runCheck, validateHealthCheck, parseBytes } from '../../packages/plugins/health-check/src/checks.js';
import type { HealthCheckConfig } from '../../packages/core/src/index.js';

const target = { name: 'web', pids: [process.pid], cpu: 12.5, memory: 100 * 1024 * 1024 };
const run = (config: HealthCheckConfig, timeout = 2000) => runCheck(config, target, timeout);

function listen(server: Server | TcpServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => { resolve((server.address() as AddressInfo).port); });
  });
}

/** A port that was free a moment ago, so connecting to it is refused */
async function closedPort(): Promise<number> {
  const server = createTcpServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe('health checks', () => {
  describe('process', () => {
    it('should pass while every pid is alive', async () => {
      expect((await run({ type: 'process' })).ok).toBe(true);
    });

    it('should fail when a pid has exited or there is no pid', async () => {
      const child = spawn(process.execPath, ['-e', '']);
      const pid = child.pid!;
      await new Promise((resolve) => child.on('exit', resolve));

      const result = await runCheck({ type: 'process' }, { ...target, pids: [process.pid, pid] }, 1000);
      expect(result).toEqual({ ok: false, message: `pid(s) not running: ${String(pid)}` });
      expect((await runCheck({ type: 'process' }, { ...target, pids: [] }, 1000)).ok).toBe(false);
    });
  });

  describe('http', () => {
    let server: Server;
    let base: string;

    beforeAll(async () => {
      server = createServer((req, res) => {
        if (req.url === '/hang') return;
        const status = req.url === '/down' ? 503 : req.url === '/created' ? 201 : 200;
        res.writeHead(status, { 'X-Method': req.method ?? '' });
        res.end(req.url === '/down' ? 'unavailable' : `{"status":"ok","method":"${req.method ?? ''}"}`);
      });
      base = `http://127.0.0.1:${String(await listen(server))}`;
    });

    afterAll(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });

    it('should pass on 2xx and fail otherwise by default', async () => {
      expect(await run({ type: 'http', url: `${base}/created` })).toEqual({ ok: true, message: 'HTTP 201' });
      expect(await run({ type: 'http', url: `${base}/down` })).toEqual({ ok: false, message: 'HTTP 503' });
    });

    it('should honour expectedStatus, method and expectedBody (string or RegExp)', async () => {
      expect((await run({ type: 'http', url: `${base}/down`, expectedStatus: [500, 503] })).ok).toBe(true);
      expect((await run({ type: 'http', url: `${base}/`, expectedStatus: 204 })).ok).toBe(false);
      expect((await run({ type: 'http', url: `${base}/`, method: 'HEAD', expectedStatus: 200 })).ok).toBe(true);
      expect((await run({ type: 'http', url: `${base}/`, expectedBody: '"status":"ok"' })).ok).toBe(true);
      expect((await run({ type: 'http', url: `${base}/`, expectedBody: /"method":"POST"/, method: 'POST' })).ok).toBe(true);
      expect(await run({ type: 'http', url: `${base}/`, expectedBody: 'nope' }))
        .toEqual({ ok: false, message: 'HTTP 200, body did not match' });
    });

    it('should fail on timeout and on refused connections', async () => {
      expect(await run({ type: 'http', url: `${base}/hang` }, 150))
        .toEqual({ ok: false, message: 'timed out after 150ms' });
      const result = await run({ type: 'http', url: `http://127.0.0.1:${String(await closedPort())}/` });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/ECONNREFUSED/);
    });

    it('should report https connection failures', async () => {
      const result = await run({ type: 'https', url: `https://127.0.0.1:${String(await closedPort())}/`, rejectUnauthorized: false });
      expect(result.ok).toBe(false);
    });
  });

  describe('tcp', () => {
    it('should pass when the port accepts connections and fail when refused', async () => {
      const server = createTcpServer((socket) => socket.destroy());
      const port = await listen(server);
      expect((await run({ type: 'tcp', port })).ok).toBe(true);
      await new Promise((resolve) => server.close(resolve));

      const result = await run({ type: 'tcp', host: '127.0.0.1', port: await closedPort() });
      expect(result.ok).toBe(false);
    });
  });

  describe('script and command', () => {
    const node = process.execPath;

    it('should pass on exit 0 and report the exit code and last output line otherwise', async () => {
      expect(await run({ type: 'script', command: node, args: ['-e', 'process.exit(0)'] })).toEqual({ ok: true, message: 'exit 0' });
      expect(await run({ type: 'script', command: node, args: ['-e', "console.error('db down'); process.exit(3)"] }))
        .toEqual({ ok: false, message: 'exit 3: db down' });
    });

    it('should expose the process name and pid to the check', async () => {
      const code = "process.exit(process.env.OD_PROCESS_NAME === 'web' && process.env.OD_PROCESS_PID === String(process.ppid) ? 0 : 1)";
      // OD_PROCESS_PID is the managed process; here the target pid is this test process, the check's parent
      expect((await run({ type: 'script', command: node, args: ['-e', code] })).ok).toBe(true);
    });

    it('should run command checks through the shell', async () => {
      expect((await run({ type: 'command', command: `"${node}" -e "process.exit(0)"` })).ok).toBe(true);
      expect((await run({ type: 'command', command: `"${node}"`, args: ['-e', '"process.exit(2)"'] })).message).toBe('exit 2');
    });

    it('should kill and fail a check that exceeds the timeout', async () => {
      const started = Date.now();
      const result = await run({ type: 'script', command: node, args: ['-e', 'setTimeout(() => {}, 10000)'] }, 200);
      expect(result).toEqual({ ok: false, message: 'timed out after 200ms' });
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('should fail when the executable does not exist', async () => {
      expect((await run({ type: 'script', command: 'od-no-such-binary-for-tests' })).ok).toBe(false);
    });
  });

  describe('composite, memory and cpu', () => {
    const pass: HealthCheckConfig = { type: 'cpu', threshold: 50 };
    const fail: HealthCheckConfig = { type: 'cpu', threshold: 10 };

    it('should combine checks with and/or', async () => {
      expect((await run({ type: 'composite', checks: [pass, pass] })).ok).toBe(true);
      expect((await run({ type: 'composite', checks: [pass, fail] })).ok).toBe(false);
      const or = await run({ type: 'composite', operator: 'or', checks: [fail, pass] });
      expect(or.ok).toBe(true);
      expect(or.message).toBe('or(cpu: fail (cpu 12.5% reached limit 10%); cpu: pass)');
    });

    it('should compare memory against byte sizes and cpu against a percentage', async () => {
      expect((await run({ type: 'memory', threshold: '200M' })).ok).toBe(true);
      expect((await run({ type: 'memory', threshold: '100M' })).ok).toBe(false);
      expect((await run({ type: 'memory', threshold: 1024 })).ok).toBe(false);
      expect((await run(pass)).ok).toBe(true);
      expect((await run(fail)).ok).toBe(false);
    });

    it.each([
      [1024, 1024], ['512', 512], ['512B', 512], ['2K', 2048], ['1.5M', 1572864], ['1g', 1073741824], ['100KB', 102400],
      ['lots', undefined], ['-1M', undefined], [-5, undefined],
    ])('parseBytes(%j) = %j', (input, expected) => {
      expect(parseBytes(input)).toBe(expected);
    });
  });

  describe('validateHealthCheck', () => {
    it('should accept complete configs', () => {
      expect(validateHealthCheck({ type: 'process' })).toEqual([]);
      expect(validateHealthCheck({ type: 'http', url: 'http://localhost:3000/health' })).toEqual([]);
      expect(validateHealthCheck({ type: 'composite', checks: [{ type: 'tcp', port: 1 }, { type: 'memory', threshold: '1G' }] })).toEqual([]);
    });

    it.each([
      [{ type: 'grpc' }, /type "grpc" is not supported/],
      [{ type: 'http' }, /url is required/],
      [{ type: 'http', url: 'localhost:3000' }, /must start with http/],
      [{ type: 'tcp' }, /port is required/],
      [{ type: 'command' }, /command is required/],
      [{ type: 'composite', checks: [] }, /at least one check/],
      [{ type: 'composite', checks: [{ type: 'tcp' }] }, /healthCheck\.checks\[0\]\.port is required/],
      [{ type: 'memory', threshold: 'big' }, /threshold must be bytes/],
      [{ type: 'cpu', threshold: '50%' }, /CPU percentage/],
    ])('should reject %j', (config, message) => {
      expect(validateHealthCheck(config as HealthCheckConfig).join('\n')).toMatch(message);
    });
  });
});
