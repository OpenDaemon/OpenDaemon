import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import { WebSocketConnection, encodeFrame, acceptKey } from '../../packages/plugins/api-server/src/websocket.js';

/** A client frame: masked, as RFC 6455 requires */
function clientFrame(opcode: number, payload: Buffer | string, options: { fin?: boolean; masked?: boolean; rsv?: number; lengthBytes?: 'auto' | 16 | 64 } = {}): Buffer {
  const body = Buffer.from(payload);
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = options.masked !== false;
  const lengthBytes = options.lengthBytes ?? 'auto';
  const first = (options.fin === false ? 0 : 0x80) | (options.rsv ?? 0) | opcode;
  const flag = masked ? 0x80 : 0;
  let head: Buffer;
  if (lengthBytes === 64) {
    head = Buffer.alloc(10);
    head[1] = flag | 127;
    head.writeBigUInt64BE(BigInt(body.length), 2);
  } else if (lengthBytes === 16 || body.length >= 126) {
    head = Buffer.alloc(4);
    head[1] = flag | 126;
    head.writeUInt16BE(body.length, 2);
  } else {
    head = Buffer.from([0, flag | body.length]);
  }
  head[0] = first;
  const data = masked ? Buffer.from(body.map((b, i) => b ^ (mask[i % 4] as number))) : body;
  return Buffer.concat(masked ? [head, mask, data] : [head, data]);
}

function open(maxPayload?: number) {
  const socket = new PassThrough();
  const sent: Buffer[] = [];
  const duplex = Object.assign(socket, {
    write: (chunk: Buffer) => { sent.push(Buffer.from(chunk)); return true; },
  });
  const ws = maxPayload === undefined ? new WebSocketConnection(duplex) : new WebSocketConnection(duplex, maxPayload);
  const messages: string[] = [];
  let closed = 0;
  ws.on('message', (text) => messages.push(text));
  ws.on('close', () => { closed++; });
  const feed = (...chunks: Buffer[]): void => { for (const chunk of chunks) socket.emit('data', chunk); };
  /** Close code of the last close frame the server sent */
  const closeCode = (): number | undefined => {
    const frame = sent.find((b) => ((b[0] as number) & 0x0f) === 0x8);
    return frame?.readUInt16BE(2);
  };
  return { ws, socket, sent, messages, feed, closeCode, closedCount: () => closed };
}

describe('encodeFrame', () => {
  it('should use the short, 16-bit and 64-bit length forms', () => {
    expect([...encodeFrame(1, Buffer.from('hi'))]).toEqual([0x81, 2, 104, 105]);
    const medium = encodeFrame(1, Buffer.alloc(300));
    expect([medium[1], medium.readUInt16BE(2), medium.length]).toEqual([126, 300, 304]);
    const large = encodeFrame(2, Buffer.alloc(70000));
    expect([large[0], large[1], Number(large.readBigUInt64BE(2)), large.length]).toEqual([0x82, 127, 70000, 70010]);
  });

  it('should compute the RFC 6455 accept key', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
});

describe('WebSocketConnection', () => {
  it('should deliver text messages, including 16-bit and 64-bit lengths, and several frames in one chunk', () => {
    const { feed, messages } = open();
    feed(clientFrame(1, 'one'), clientFrame(1, 'two'));
    feed(clientFrame(1, 'x'.repeat(200)));
    feed(clientFrame(1, 'wide', { lengthBytes: 64 }));
    expect(messages).toEqual(['one', 'two', 'x'.repeat(200), 'wide']);
  });

  it('should wait for the rest of a frame split across chunks', () => {
    const { feed, messages } = open();
    const frame = clientFrame(1, 'hello world');
    feed(frame.subarray(0, 1));
    feed(frame.subarray(1, 5));
    expect(messages).toEqual([]);
    feed(frame.subarray(5));
    expect(messages).toEqual(['hello world']);
  });

  it('should reassemble fragmented messages, with a ping in between answered by a pong', () => {
    const { feed, messages, sent } = open();
    feed(clientFrame(1, 'Hel', { fin: false }), clientFrame(9, 'p'), clientFrame(0, 'lo'));
    expect(messages).toEqual(['Hello']);
    expect(sent.map((b) => [b[0], b.subarray(2).toString()])).toEqual([[0x8a, 'p']]);
  });

  it('should send text and report the backlog, and stop sending once closed', () => {
    const { ws, sent, closedCount } = open();
    expect(ws.isOpen).toBe(true);
    ws.send('hi');
    expect(sent[0]?.subarray(2).toString()).toBe('hi');
    expect(typeof ws.backlog).toBe('number');
    ws.close();
    expect(ws.isOpen).toBe(false);
    const count = sent.length;
    ws.send('late');
    ws.close();
    expect(sent).toHaveLength(count);
    expect(closedCount()).toBe(1);
  });

  it('should answer a close frame by closing with 1000', () => {
    const { feed, closeCode, closedCount, ws } = open();
    feed(clientFrame(8, Buffer.from([0x03, 0xe8])));
    expect(closeCode()).toBe(1000);
    expect(closedCount()).toBe(1);
    expect(ws.isOpen).toBe(false);
  });

  it.each([
    ['an unmasked frame', () => clientFrame(1, 'x', { masked: false }), 1002],
    ['reserved bits set', () => clientFrame(1, 'x', { rsv: 0x40 }), 1002],
    ['a fragmented control frame', () => clientFrame(9, 'x', { fin: false }), 1002],
    ['a control frame over 125 bytes', () => clientFrame(9, 'x'.repeat(126)), 1002],
    ['an unknown opcode', () => clientFrame(3, 'x'), 1002],
    ['a continuation with nothing to continue', () => clientFrame(0, 'x'), 1002],
    ['a new text frame inside a fragmented message', () => Buffer.concat([clientFrame(1, 'a', { fin: false }), clientFrame(1, 'b')]), 1002],
    ['a binary frame', () => clientFrame(2, 'x'), 1003],
  ])('should close on %s', (_label, frame, code) => {
    const { feed, closeCode, closedCount, messages } = open();
    feed(frame());
    expect(closeCode()).toBe(code);
    expect(closedCount()).toBe(1);
    expect(messages).toEqual([]);
  });

  it('should close with 1009 for a message over the limit, declared or accumulated', () => {
    const declared = open(100);
    declared.feed(clientFrame(1, 'x'.repeat(101)));
    expect(declared.closeCode()).toBe(1009);

    const huge = open(100);
    const head = Buffer.alloc(10);
    head[0] = 0x81;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(10n ** 12n, 2);
    huge.feed(head); // refused from the header alone, without waiting for the payload
    expect(huge.closeCode()).toBe(1009);

    const pieces = open(100);
    pieces.feed(clientFrame(1, 'x'.repeat(60), { fin: false }), clientFrame(0, 'x'.repeat(60)));
    expect(pieces.closeCode()).toBe(1009);
    expect(pieces.messages).toEqual([]);
  });

  it('should report close when the socket closes or errors, once', () => {
    const closing = open();
    closing.socket.emit('close');
    closing.socket.emit('error', new Error('reset'));
    expect(closing.closedCount()).toBe(1);

    const failing = open();
    failing.socket.emit('error', new Error('reset'));
    expect(failing.ws.isOpen).toBe(false);
  });
});
