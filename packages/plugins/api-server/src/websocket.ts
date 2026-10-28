import { createHash } from 'crypto';
import type { Duplex } from 'stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/**
 * One frame of data to send. Server frames are never masked.
 */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let head: Buffer;
  if (length < 126) {
    head = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([head, payload]);
}

export interface WebSocketEvents {
  message: (text: string) => void;
  close: () => void;
}

/**
 * Server side of a WebSocket connection (RFC 6455): text messages, fragmentation, ping/pong,
 * close. Binary frames are rejected. Messages over `maxPayload` close the connection (1009).
 */
export class WebSocketConnection {
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private closed = false;
  private readonly handlers: Partial<WebSocketEvents> = {};

  constructor(private readonly socket: Duplex, private readonly maxPayload = 1024 * 1024) {
    socket.on('data', (chunk: Buffer) => { this.receive(chunk); });
    socket.on('close', () => { this.finish(); });
    socket.on('error', () => { this.finish(); });
  }

  on<K extends keyof WebSocketEvents>(event: K, handler: WebSocketEvents[K]): void {
    this.handlers[event] = handler;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  /** Bytes queued in the socket: a slow reader must not make the daemon buffer without limit */
  get backlog(): number {
    return this.socket.writableLength;
  }

  send(text: string): void {
    if (!this.closed) this.socket.write(encodeFrame(0x1, Buffer.from(text, 'utf-8')));
  }

  close(code = 1000): void {
    if (this.closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    this.socket.write(encodeFrame(0x8, payload));
    this.socket.end();
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.handlers.close?.();
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (!this.closed) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0] as number;
      const second = this.buffer[1] as number;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) { this.close(1009); return; }
        length = Number(big);
        offset = 10;
      }
      // RFC 6455: every client frame is masked; reserved bits must be zero
      if (!masked || (first & 0x70) !== 0) { this.close(1002); return; }
      if (length > this.maxPayload) { this.close(1009); return; }
      if (this.buffer.length < offset + 4 + length) return;

      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] as number) ^ (mask[i % 4] as number);
      this.buffer = this.buffer.subarray(offset + 4 + length);

      if (opcode >= 0x8) {
        // Control frames: not fragmented, at most 125 bytes
        if (!fin || length > 125) { this.close(1002); return; }
        if (opcode === 0x8) { this.close(1000); return; }
        if (opcode === 0x9) this.socket.write(encodeFrame(0xa, payload));
        continue;
      }
      if (opcode === 0x2) { this.close(1003); return; }
      if (opcode !== 0x0 && opcode !== 0x1) { this.close(1002); return; }
      if (opcode === 0x1 && this.fragments.length > 0) { this.close(1002); return; }
      if (opcode === 0x0 && this.fragments.length === 0) { this.close(1002); return; }

      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > this.maxPayload) { this.close(1009); return; }
      this.fragments.push(payload);
      if (fin) {
        const text = Buffer.concat(this.fragments).toString('utf-8');
        this.fragments = [];
        this.fragmentBytes = 0;
        this.handlers.message?.(text);
      }
    }
  }
}
