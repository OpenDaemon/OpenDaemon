import { connect as netConnect, type Socket } from 'net';
import { connect as tlsConnect, type TLSSocket } from 'tls';

export interface SmtpConfig {
  host: string;
  /** Default 465 with `secure`, otherwise 587 */
  port?: number;
  /** TLS from the first byte (port 465). Otherwise STARTTLS is used when the server offers it */
  secure?: boolean;
  user?: string;
  password?: string;
  /** Accept self-signed certificates (default false) */
  allowInsecureTls?: boolean;
}

export interface Mail {
  from: string;
  to: string[];
  subject: string;
  text: string;
}

const CRLF = '\r\n';

/**
 * Reads SMTP replies (possibly multi-line) off a socket
 */
class Replies {
  private buffer = '';
  private lines: string[] = [];
  private waiter: { resolve: (reply: { code: number; text: string }) => void; reject: (err: Error) => void } | undefined;
  private failure: Error | undefined;
  private socket: Socket | TLSSocket;
  private readonly onData = (chunk: Buffer): void => {
    this.buffer += chunk.toString('utf-8');
    for (;;) {
      const end = this.buffer.indexOf('\n');
      if (end < 0) break;
      const line = this.buffer.slice(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.slice(end + 1);
      this.lines.push(line);
      // "250-more" continues, "250 done" ends the reply
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), text: this.lines.map((l) => l.slice(4)).join('\n') };
        this.lines = [];
        const waiter = this.waiter;
        this.waiter = undefined;
        waiter?.resolve(reply);
      }
    }
  };
  private readonly onError = (err: Error): void => { this.fail(err); };
  private readonly onClose = (): void => { this.fail(new Error('connection closed by the server')); };

  constructor(socket: Socket | TLSSocket) {
    this.socket = socket;
    this.attach(socket);
  }

  private attach(socket: Socket | TLSSocket): void {
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  /** After STARTTLS the same replies continue on the TLS socket */
  rebind(socket: TLSSocket): void {
    this.socket.removeListener('data', this.onData);
    this.socket.removeListener('error', this.onError);
    this.socket.removeListener('close', this.onClose);
    this.socket = socket;
    this.buffer = '';
    this.attach(socket);
  }

  private fail(err: Error): void {
    this.failure ??= err;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.reject(err);
  }

  next(): Promise<{ code: number; text: string }> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }
}

/**
 * Dot-stuff the body (a line starting with "." would end the message early) and normalise newlines
 */
export function dataBody(text: string): string {
  return text.replace(/\r?\n/g, CRLF).split(CRLF).map((line) => (line.startsWith('.') ? `.${line}` : line)).join(CRLF);
}

/**
 * RFC 2047 encoded-word for headers that contain non-ASCII text
 */
function header(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value.replace(/[\r\n]/g, ' ') : `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
}

export function buildMessage(mail: Mail, host: string): string {
  const headers = [
    `From: ${mail.from}`,
    `To: ${mail.to.join(', ')}`,
    `Subject: ${header(mail.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${host}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  const body = Buffer.from(mail.text, 'utf-8').toString('base64').replace(/(.{76})/g, `$1${CRLF}`);
  return `${headers.join(CRLF)}${CRLF}${CRLF}${body}`;
}

/**
 * Send one message. Zero dependencies: speaks ESMTP directly over node:net / node:tls with
 * implicit TLS or STARTTLS, and AUTH PLAIN / LOGIN when credentials are given.
 */
export async function sendMail(smtp: SmtpConfig, mail: Mail, timeoutMs = 15000): Promise<void> {
  const port = smtp.port ?? (smtp.secure ? 465 : 587);
  const tlsOptions = { host: smtp.host, port, servername: smtp.host, rejectUnauthorized: smtp.allowInsecureTls !== true };
  const socket: Socket = smtp.secure ? tlsConnect(tlsOptions) : netConnect({ host: smtp.host, port });
  socket.setTimeout(timeoutMs, () => { socket.destroy(new Error(`timed out after ${String(timeoutMs)}ms`)); });
  const replies = new Replies(socket);
  let active: Socket | TLSSocket = socket;

  const expect = async (...codes: number[]): Promise<string> => {
    const reply = await replies.next();
    if (!codes.includes(reply.code)) throw new Error(`SMTP ${String(reply.code)}: ${reply.text}`);
    return reply.text;
  };
  const command = async (line: string, ...codes: number[]): Promise<string> => {
    const answer = expect(...codes);
    active.write(line + CRLF);
    return answer;
  };

  try {
    await expect(220);
    const name = 'opendaemon';
    let capabilities = await command(`EHLO ${name}`, 250);

    if (!smtp.secure && /^STARTTLS$/im.test(capabilities)) {
      await command('STARTTLS', 220);
      const upgraded = tlsConnect({ ...tlsOptions, socket });
      await new Promise<void>((resolve, reject) => {
        upgraded.once('secureConnect', resolve);
        upgraded.once('error', reject);
      });
      replies.rebind(upgraded);
      active = upgraded;
      capabilities = await command(`EHLO ${name}`, 250);
    } else if (!smtp.secure && smtp.user !== undefined && !/^(127\.0\.0\.1|localhost|::1)$/.test(smtp.host)) {
      // Never send a password in the clear to a remote server
      throw new Error('the server does not offer STARTTLS; refusing to send credentials unencrypted');
    }

    if (smtp.user !== undefined) {
      const password = smtp.password ?? '';
      if (/AUTH[^\n]*\bPLAIN\b/i.test(capabilities)) {
        await command(`AUTH PLAIN ${Buffer.from(`\0${smtp.user}\0${password}`).toString('base64')}`, 235);
      } else {
        await command('AUTH LOGIN', 334);
        await command(Buffer.from(smtp.user).toString('base64'), 334);
        await command(Buffer.from(password).toString('base64'), 235);
      }
    }

    const address = (value: string): string => (/<([^<>]+)>/.exec(value)?.[1] ?? value).trim();
    await command(`MAIL FROM:<${address(mail.from)}>`, 250);
    for (const to of mail.to) await command(`RCPT TO:<${address(to)}>`, 250, 251);
    await command('DATA', 354);
    const sent = expect(250);
    active.write(`${dataBody(buildMessage(mail, smtp.host))}${CRLF}.${CRLF}`);
    await sent;
    active.write(`QUIT${CRLF}`);
  } finally {
    active.destroy();
  }
}
