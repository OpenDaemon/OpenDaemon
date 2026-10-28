import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server, type Socket, type AddressInfo } from 'net';
import { NotificationPlugin } from '../../packages/plugins/notification/src/index.js';
import { sendMail, dataBody } from '../../packages/plugins/notification/src/smtp.js';
import { EventBus, StateStore, Logger } from '../../packages/core/src/index.js';
import type { PluginContext } from '../../packages/core/src/index.js';

/** A minimal SMTP server that records the conversation */
function fakeSmtp(options: { auth?: 'PLAIN' | 'LOGIN'; rejectRcpt?: boolean } = {}) {
  const sessions: string[][] = [];
  let message = '';
  const server: Server = createServer((socket: Socket) => {
    const log: string[] = [];
    sessions.push(log);
    let inData = false;
    let buffer = '';
    socket.write('220 fake ESMTP\r\n');
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          message = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write('250 queued\r\n');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol < 0) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        log.push(line);
        if (line.startsWith('EHLO')) socket.write(`250-fake\r\n250 AUTH ${options.auth ?? 'PLAIN'}\r\n`);
        else if (line.startsWith('AUTH PLAIN')) socket.write('235 ok\r\n');
        else if (line === 'AUTH LOGIN') socket.write('334 VXNlcm5hbWU6\r\n');
        else if (options.auth === 'LOGIN' && log.at(-2) === 'AUTH LOGIN') socket.write('334 UGFzc3dvcmQ6\r\n');
        else if (options.auth === 'LOGIN' && log.at(-3) === 'AUTH LOGIN') socket.write('235 ok\r\n');
        else if (line.startsWith('RCPT') && options.rejectRcpt) socket.write('550 no such user\r\n');
        else if (line === 'DATA') { inData = true; socket.write('354 go\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  return {
    sessions,
    message: () => message,
    start: async (bind = '127.0.0.1') => {
      await new Promise<void>((resolve) => { server.listen(0, bind, resolve); });
      return (server.address() as AddressInfo).port;
    },
    stop: () => new Promise<void>((resolve) => { server.close(() => { resolve(); }); }),
  };
}

const decode = (message: string): string => {
  const body = message.split('\r\n\r\n')[1] ?? '';
  return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf-8');
};

describe('SMTP client', () => {
  let smtp: ReturnType<typeof fakeSmtp>;
  afterEach(async () => { await smtp.stop(); });

  it('should deliver a message with AUTH PLAIN, dot-stuffing and a UTF-8 subject', async () => {
    smtp = fakeSmtp();
    const port = await smtp.start();
    await sendMail({ host: '127.0.0.1', port, user: 'me', password: 'pw' }, {
      from: 'OpenDaemon <od@example.com>', to: ['a@example.com', 'b@example.com'],
      subject: 'api çöktü', text: 'line one\n.starts with a dot\nüç',
    });
    const [log] = smtp.sessions;
    expect(log).toContain(`AUTH PLAIN ${Buffer.from('\0me\0pw').toString('base64')}`);
    expect(log).toContain('MAIL FROM:<od@example.com>');
    expect(log).toContain('RCPT TO:<a@example.com>');
    expect(log).toContain('RCPT TO:<b@example.com>');
    expect(smtp.message()).toContain('Subject: =?UTF-8?B?');
    expect(smtp.message()).toContain('To: a@example.com, b@example.com');
    expect(decode(smtp.message())).toBe('line one\n.starts with a dot\nüç');
  });

  it('should fall back to AUTH LOGIN', async () => {
    smtp = fakeSmtp({ auth: 'LOGIN' });
    const port = await smtp.start();
    await sendMail({ host: '127.0.0.1', port, user: 'me', password: 'pw' }, { from: 'a@b.c', to: ['d@e.f'], subject: 's', text: 't' });
    expect(smtp.sessions[0]).toContain(Buffer.from('me').toString('base64'));
    expect(smtp.sessions[0]).toContain(Buffer.from('pw').toString('base64'));
  });

  it('should fail with the server reply when a recipient is refused', async () => {
    smtp = fakeSmtp({ rejectRcpt: true });
    const port = await smtp.start();
    await expect(sendMail({ host: '127.0.0.1', port }, { from: 'a@b.c', to: ['x@y.z'], subject: 's', text: 't' }))
      .rejects.toThrow('SMTP 550: no such user');
  });

  // 127.0.0.2 reaches a wildcard-bound server on Linux only; the guard exempts just 127.0.0.1
  it.skipIf(process.platform !== 'linux')('should refuse to send credentials unencrypted to a remote server', async () => {
    smtp = fakeSmtp();
    const port = await smtp.start('0.0.0.0');
    await expect(sendMail({ host: '127.0.0.2', port, user: 'me', password: 'pw' }, { from: 'a@b.c', to: ['d@e.f'], subject: 's', text: 't' }))
      .rejects.toThrow('refusing to send credentials unencrypted');
  });

  it('should time out against a silent server', async () => {
    const silent = createServer(() => {});
    await new Promise<void>((resolve) => { silent.listen(0, '127.0.0.1', resolve); });
    smtp = { stop: () => new Promise<void>((resolve) => { silent.close(() => { resolve(); }); }) } as ReturnType<typeof fakeSmtp>;
    await expect(sendMail({ host: '127.0.0.1', port: (silent.address() as AddressInfo).port }, { from: 'a@b.c', to: ['d@e.f'], subject: 's', text: 't' }, 200))
      .rejects.toThrow();
  });

  it('should dot-stuff lines', () => {
    expect(dataBody('a\n.b\r\n..c')).toBe('a\r\n..b\r\n...c');
  });
});

describe('email channel', () => {
  let smtp: ReturnType<typeof fakeSmtp>;
  let plugin: NotificationPlugin;
  const warnings: string[] = [];
  const events = new EventBus();

  const install = (config: Record<string, unknown>) => {
    plugin = new NotificationPlugin();
    const logger = new Logger('mail-test');
    logger.warn = (m: string) => { warnings.push(m); };
    logger.error = (m: string) => { warnings.push(m); };
    plugin.install({ config: {}, pluginConfig: config, events, logger, store: new StateStore(), registerMethod: () => {}, getPlugin: () => undefined } as unknown as PluginContext);
  };

  beforeEach(() => { warnings.length = 0; smtp = fakeSmtp(); });
  afterEach(async () => { await plugin.onStop(); await smtp.stop(); });

  it('should mail a crash notification', async () => {
    const port = await smtp.start();
    install({ throttle: 0, channels: [{ type: 'email', smtp: { host: '127.0.0.1', port }, from: 'od@example.com', to: ['ops@example.com'] }] });
    events.emit('process:crash', { name: 'api', code: 1, restartCount: 2 });
    await plugin.flush();
    expect(smtp.sessions).toHaveLength(1);
    expect(smtp.message()).toContain('Subject: [CRITICAL] Process "api" crashed');
    expect(decode(smtp.message())).toContain('exit code 1');
  });

  it('should send a batch as one message', async () => {
    const port = await smtp.start();
    install({ throttle: 0, batchWindow: 50, channels: [{ type: 'email', smtp: { host: '127.0.0.1', port }, from: 'od@example.com', to: ['ops@example.com'] }] });
    events.emit('process:crash', { name: 'a', code: 1 });
    events.emit('process:crash', { name: 'b', code: 1 });
    await plugin.flush();
    expect(smtp.sessions).toHaveLength(1);
    expect(smtp.message()).toContain('Subject: 2 OpenDaemon notifications');
  });

  it('should log a delivery failure without throwing', async () => {
    const port = await smtp.start();
    install({ throttle: 0, channels: [{ type: 'email', smtp: { host: '127.0.0.1', port }, from: 'od@example.com', to: ['ops@example.com'] }] });
    await smtp.stop();
    smtp = fakeSmtp();
    events.emit('process:crash', { name: 'api', code: 1 });
    await plugin.flush();
    expect(warnings.some((w) => w.includes('Notification to 127.0.0.1 failed'))).toBe(true);
  });

  it('should reject incomplete email channels', () => {
    install({ channels: [
      { type: 'email', from: 'a@b.c', to: ['x@y.z'] },
      { type: 'email', smtp: { host: 'h' }, to: ['x@y.z'] },
      { type: 'email', smtp: { host: 'h' }, from: 'a@b.c', to: [] },
    ] });
    expect(warnings).toEqual([
      'Ignoring notification channel: email channels need smtp.host',
      'Ignoring notification channel: email channels need from',
      'Ignoring notification channel: email channels need at least one recipient in to',
    ]);
  });
});
