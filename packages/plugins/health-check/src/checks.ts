import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { connect } from 'net';
import { spawn } from 'child_process';
import { parseBytes } from '../../../core/src/index.js';
import type { HealthCheckConfig, HealthCheckType } from '../../../core/src/index.js';

export { parseBytes };

/**
 * What a check can observe about the managed process
 */
export interface CheckTarget {
  name: string;
  pids: number[];
  cpu: number;
  memory: number;
}

export interface CheckResult {
  ok: boolean;
  message: string;
}

const SUPPORTED: ReadonlySet<HealthCheckType> = new Set<HealthCheckType>([
  'process', 'http', 'https', 'tcp', 'script', 'command', 'composite', 'memory', 'cpu',
]);

/**
 * Validate a health check config; returns human-readable problems (empty when valid)
 */
export function validateHealthCheck(config: HealthCheckConfig, path = 'healthCheck'): string[] {
  if (!SUPPORTED.has(config.type)) {
    return [`${path}.type "${config.type}" is not supported (use ${[...SUPPORTED].join(', ')})`];
  }

  const problems: string[] = [];
  switch (config.type) {
    case 'http':
    case 'https':
      if (!config.url) problems.push(`${path}.url is required for ${config.type} checks`);
      else if (!/^https?:\/\//.test(config.url)) problems.push(`${path}.url must start with http:// or https://`);
      break;
    case 'tcp':
      if (typeof config.port !== 'number') problems.push(`${path}.port is required for tcp checks`);
      break;
    case 'script':
    case 'command':
      if (!config.command) problems.push(`${path}.command is required for ${config.type} checks`);
      break;
    case 'composite':
      if (!config.checks || config.checks.length === 0) {
        problems.push(`${path}.checks must list at least one check`);
      } else {
        config.checks.forEach((check, i) => problems.push(...validateHealthCheck(check, `${path}.checks[${i}]`)));
      }
      break;
    case 'memory':
      if (config.threshold === undefined || parseBytes(config.threshold) === undefined) {
        problems.push(`${path}.threshold must be bytes or a size such as '512M'`);
      }
      break;
    case 'cpu':
      if (typeof config.threshold !== 'number') problems.push(`${path}.threshold must be a CPU percentage`);
      break;
    case 'process':
      break;
  }
  return problems;
}

/**
 * Run one health check against a target
 */
export async function runCheck(config: HealthCheckConfig, target: CheckTarget, timeoutMs: number): Promise<CheckResult> {
  switch (config.type) {
    case 'process':
      return checkProcess(target);
    case 'http':
    case 'https':
      return checkHttp(config, timeoutMs);
    case 'tcp':
      return checkTcp(config, timeoutMs);
    case 'script':
    case 'command':
      return checkCommand(config, target, timeoutMs);
    case 'composite':
      return checkComposite(config, target, timeoutMs);
    case 'memory': {
      const limit = parseBytes(config.threshold ?? 0) ?? 0;
      return target.memory < limit
        ? { ok: true, message: `memory ${String(target.memory)}B below ${String(limit)}B` }
        : { ok: false, message: `memory ${String(target.memory)}B reached limit ${String(limit)}B` };
    }
    case 'cpu': {
      const limit = Number(config.threshold);
      return target.cpu < limit
        ? { ok: true, message: `cpu ${target.cpu.toFixed(1)}% below ${String(limit)}%` }
        : { ok: false, message: `cpu ${target.cpu.toFixed(1)}% reached limit ${String(limit)}%` };
    }
    default:
      return { ok: false, message: `unsupported check type "${config.type}"` };
  }
}

function checkProcess(target: CheckTarget): CheckResult {
  if (target.pids.length === 0) {
    return { ok: false, message: 'no running pid' };
  }
  const dead = target.pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (err) {
      // EPERM means the pid exists but belongs to someone else, i.e. it is alive
      return (err as NodeJS.ErrnoException).code !== 'EPERM';
    }
  });
  return dead.length === 0
    ? { ok: true, message: `${String(target.pids.length)} pid(s) alive` }
    : { ok: false, message: `pid(s) not running: ${dead.join(', ')}` };
}

function statusMatches(status: number, expected: number | number[] | undefined): boolean {
  if (expected === undefined) return status >= 200 && status < 300;
  return Array.isArray(expected) ? expected.includes(status) : status === expected;
}

function bodyMatches(body: string, expected: string | RegExp | undefined): boolean {
  if (expected === undefined) return true;
  return typeof expected === 'string' ? body.includes(expected) : expected.test(body);
}

function checkHttp(config: HealthCheckConfig, timeoutMs: number): Promise<CheckResult> {
  const url = new URL(config.url ?? '');
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const maxBody = 64 * 1024;

  return new Promise((resolve) => {
    const req = request(url, {
      method: config.method ?? 'GET',
      headers: config.headers,
      timeout: timeoutMs,
      ...(url.protocol === 'https:' ? { rejectUnauthorized: config.rejectUnauthorized ?? true } : {}),
    }, (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => {
        // Only the start of the body is needed to match expectedBody
        if (body.length < maxBody) body += chunk;
      });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (!statusMatches(status, config.expectedStatus)) {
          resolve({ ok: false, message: `HTTP ${String(status)}` });
        } else if (!bodyMatches(body, config.expectedBody)) {
          resolve({ ok: false, message: `HTTP ${String(status)}, body did not match` });
        } else {
          resolve({ ok: true, message: `HTTP ${String(status)}` });
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`timed out after ${String(timeoutMs)}ms`)); });
    req.on('error', (err) => { resolve({ ok: false, message: err.message }); });
    req.end();
  });
}

function checkTcp(config: HealthCheckConfig, timeoutMs: number): Promise<CheckResult> {
  const host = config.host ?? '127.0.0.1';
  const port = config.port ?? 0;

  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (result: CheckResult) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => { finish({ ok: false, message: `timed out after ${String(timeoutMs)}ms` }); });
    socket.once('connect', () => { finish({ ok: true, message: `connected to ${host}:${String(port)}` }); });
    socket.once('error', (err) => { finish({ ok: false, message: err.message }); });
  });
}

/**
 * `script` runs an executable directly; `command` runs through the shell (pipes, &&, env vars).
 * Exit code 0 passes. The process name and pid are exposed as OD_PROCESS_NAME / OD_PROCESS_PID.
 */
function checkCommand(config: HealthCheckConfig, target: CheckTarget, timeoutMs: number): Promise<CheckResult> {
  const shell = config.type === 'command';
  const command = config.command ?? '';
  const args = shell ? [] : (config.args ?? []);
  const line = shell && config.args?.length ? `${command} ${config.args.join(' ')}` : command;

  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    const settle = (result: CheckResult) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
    };

    const child = spawn(line, args, {
      shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OD_PROCESS_NAME: target.name, OD_PROCESS_PID: String(target.pids[0] ?? '') },
    });
    const collect = (chunk: Buffer) => { if (output.length < 1000) output += chunk.toString(); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({ ok: false, message: `timed out after ${String(timeoutMs)}ms` });
    }, timeoutMs);

    child.on('error', (err) => { settle({ ok: false, message: err.message }); });
    child.on('close', (code, signal) => {
      const detail = output.trim().split('\n').pop() ?? '';
      settle(code === 0
        ? { ok: true, message: 'exit 0' }
        : { ok: false, message: `exit ${String(code ?? signal)}${detail ? `: ${detail}` : ''}` });
    });
  });
}

async function checkComposite(config: HealthCheckConfig, target: CheckTarget, timeoutMs: number): Promise<CheckResult> {
  const checks = config.checks ?? [];
  const results = await Promise.all(checks.map((check) => runCheck(check, target, check.timeout ?? timeoutMs)));
  const operator = config.operator ?? 'and';
  const ok = operator === 'and' ? results.every((r) => r.ok) : results.some((r) => r.ok);
  const summary = results.map((r, i) => `${checks[i]?.type ?? '?'}: ${r.ok ? 'pass' : `fail (${r.message})`}`).join('; ');
  return { ok, message: `${operator}(${summary})` };
}
