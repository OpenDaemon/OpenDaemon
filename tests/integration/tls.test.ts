import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server, type Socket, type AddressInfo } from 'net';
import { TLSSocket, createServer as createTlsServer } from 'tls';
import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';
import { randomBytes } from 'crypto';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sendMail } from '../../packages/plugins/notification/src/smtp.js';
import { acceptKey } from '../../packages/plugins/api-server/src/websocket.js';
import { ApiServerPlugin } from '../../packages/plugins/api-server/src/index.js';
import { EventBus, StateStore, Logger } from '../../packages/core/src/index.js';
import type { PluginContext } from '../../packages/core/src/index.js';

// A self-signed certificate for localhost / 127.0.0.1 (valid for 100 years), made only for tests
const CERT = join(__dirname, '..', 'fixtures', 'test-cert.pem');
const KEY = join(__dirname, '..', 'fixtures', 'test-key.pem');
const credentials = { cert: readFileSync(CERT), key: readFileSync(KEY) };

const mail = { from: 'od@example.com', to: ['ops@example.com'], subject: 'hello', text: 'body' };

/**
 * An SMTP server that offers STARTTLS (or speaks TLS from the first byte) and records whether
 * each command arrived encrypted
 */
function tlsSmtp(mode: 'starttls' | 'implicit' | 'plain') {
  const seen: Array<{ line: string; encrypted: boolean }> = [];
  const converse = (socket: Socket | TLSSocket, upgrade: (() => TLSSocket) | undefined): void => {
    let current: Socket | TLSSocket = socket;
    let buffer = '';
    let inData = false;
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          buffer = buffer.slice(end + 5);
          inData = false;
          current.write('250 queued\r\n');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol < 0) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        seen.push({ line, encrypted: current instanceof TLSSocket });
        if (line.startsWith('EHLO')) {
          const offerTls = mode === 'starttls' && !(current instanceof TLSSocket);
          current.write(`250-fake\r\n${offerTls ? '250-STARTTLS\r\n' : ''}250 AUTH PLAIN\r\n`);
        } else if (line === 'STARTTLS' && upgrade) {
          current.write('220 ready\r\n');
          current.removeListener('data', onData);
          current = upgrade();
          current.on('data', onData);
          current.on('error', () => {});
        } else if (line.startsWith('AUTH PLAIN')) current.write('235 ok\r\n');
        else if (line === 'DATA') { inData = true; current.write('354 go\r\n'); }
        else if (line === 'QUIT') current.end('221 bye\r\n');
        else current.write('250 ok\r\n');
      }
    };
    socket.on('data', onData);
    socket.on('error', () => {});
    socket.write('220 fake ESMTP\r\n');
  };

  const server: Server = mode === 'implicit'
    ? createTlsServer(credentials, (socket) => { converse(socket, undefined); })
    : createServer((socket) => {
      converse(socket, () => new TLSSocket(socket, { isServer: true, ...credentials }));
    });
  return {
    seen,
    start: async () => {
      await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
      return (server.address() as AddressInfo).port;
    },
    stop: () => new Promise<void>((resolve) => { server.close(() => { resolve(); }); }),
  };
}

describe('SMTP over TLS', () => {
  let smtp: ReturnType<typeof tlsSmtp>;
  afterEach(async () => { await smtp.stop(); });

  it('should upgrade with STARTTLS and send the credentials and the message only after it', async () => {
    smtp = tlsSmtp('starttls');
    const port = await smtp.start();
    await sendMail({ host: '127.0.0.1', port, user: 'me', password: 'pw', allowInsecureTls: true }, mail);

    const lines = smtp.seen.map((s) => s.line);
    expect(lines.filter((l) => l.startsWith('EHLO'))).toHaveLength(2); // again after the upgrade
    const upgraded = lines.indexOf('STARTTLS');
    expect(upgraded).toBeGreaterThan(0);
    for (const entry of smtp.seen.slice(upgraded + 1)) expect(entry.encrypted).toBe(true);
    expect(smtp.seen.find((s) => s.line.startsWith('AUTH PLAIN'))?.encrypted).toBe(true);
    expect(smtp.seen.some((s) => s.line === 'DATA')).toBe(true);
    expect(smtp.seen.slice(0, upgraded).every((s) => !s.encrypted)).toBe(true);
  });

  it('should speak TLS from the first byte with secure', async () => {
    smtp = tlsSmtp('implicit');
    const port = await smtp.start();
    await sendMail({ host: '127.0.0.1', port, secure: true, user: 'me', password: 'pw', allowInsecureTls: true }, mail);
    expect(smtp.seen.length).toBeGreaterThan(4);
    expect(smtp.seen.every((s) => s.encrypted)).toBe(true);
  });

  it('should refuse a certificate it cannot verify unless allowInsecureTls is set, before any credential is sent', async () => {
    smtp = tlsSmtp('starttls');
    const port = await smtp.start();
    await expect(sendMail({ host: '127.0.0.1', port, user: 'me', password: 'pw' }, mail)).rejects.toThrow(/self[- ]signed|certificate/i);
    expect(smtp.seen.some((s) => s.line.startsWith('AUTH'))).toBe(false);

    const implicit = tlsSmtp('implicit');
    const implicitPort = await implicit.start();
    await expect(sendMail({ host: '127.0.0.1', port: implicitPort, secure: true }, mail)).rejects.toThrow(/self[- ]signed|certificate/i);
    await implicit.stop();
  });
});

describe('API server over TLS', () => {
  let home: string;
  let plugin: ApiServerPlugin;
  const TOKEN = 'tls-test-token-0123456789';

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'od-api-tls-'));
    plugin = new ApiServerPlugin(home, () => Promise.resolve([{ name: 'web' }]));
    const context = {
      config: {}, pluginConfig: { port: 0, token: TOKEN, tls: { cert: CERT, key: KEY } },
      events: new EventBus(), logger: new Logger('tls-test'), store: new StateStore(),
      registerMethod: () => {}, getPlugin: () => undefined,
    } as unknown as PluginContext;
    plugin.install(context);
    await plugin.onStart(context);
  });

  afterEach(async () => {
    await plugin.onStop();
    rmSync(home, { recursive: true, force: true });
  });

  it('should serve REST over HTTPS with the certificate it was given', async () => {
    const reply = await new Promise<{ status: number; body: string; subject: string }>((resolve, reject) => {
      const req = httpsRequest({
        host: '127.0.0.1', port: plugin.port, path: '/api/v1/processes', headers: { Authorization: `Bearer ${TOKEN}` },
        rejectUnauthorized: false,
      }, (res) => {
        let body = '';
        const subject = (res.socket as TLSSocket).getPeerCertificate().subject.CN as string;
        res.on('data', (c: Buffer) => { body += c.toString(); });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body, subject });
        });
      });
      req.on('error', reject);
      req.end();
    });
    expect(reply.status).toBe(200);
    expect(reply.subject).toBe('localhost');
    expect(JSON.parse(reply.body)).toEqual([{ name: 'web' }]);
  });

  it('should reject a client that does not trust the self-signed certificate', async () => {
    await expect(new Promise((resolve, reject) => {
      const req = httpsRequest({ host: '127.0.0.1', port: plugin.port, path: '/api/v1/health' }, resolve);
      req.on('error', reject);
      req.end();
    })).rejects.toThrow(/self[- ]signed|certificate/i);
  });

  it('should not answer plain HTTP on the TLS port', async () => {
    await expect(new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: plugin.port, path: '/api/v1/health', timeout: 2000 }, resolve);
      req.on('timeout', () => { req.destroy(new Error('no plain answer')); });
      req.on('error', reject);
      req.end();
    })).rejects.toThrow();
  });

  it('should upgrade to a secure WebSocket (wss)', async () => {
    const key = randomBytes(16).toString('base64');
    const accept = await new Promise<string | undefined>((resolve, reject) => {
      const req = httpsRequest({
        host: '127.0.0.1', port: plugin.port, path: '/ws', rejectUnauthorized: false,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key, Authorization: `Bearer ${TOKEN}` },
      });
      req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.headers['sec-websocket-accept']); });
      req.on('response', () => { reject(new Error('not upgraded')); });
      req.on('error', reject);
      req.end();
    });
    expect(accept).toBe(acceptKey(key));
  });
});
