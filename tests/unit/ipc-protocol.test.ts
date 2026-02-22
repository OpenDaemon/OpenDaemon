import { describe, it, expect, vi } from 'vitest';
import {
  encodeFrame,
  decodeFrames,
  FrameType,
} from '../../packages/core/src/ipc/protocol.js';

describe('IPC Protocol', () => {
  describe('encodeFrame', () => {
    it('should encode JSON-RPC request frame', () => {
      const payload = Buffer.from('{"jsonrpc":"2.0","method":"test"}');
      const frame = encodeFrame(FrameType.JSON_RPC_REQUEST, payload);
      
      expect(frame).toBeInstanceOf(Buffer);
      expect(frame.length).toBe(5 + payload.length);
      expect(frame[0]).toBe(FrameType.JSON_RPC_REQUEST);
    });

    it('should encode JSON-RPC response frame', () => {
      const payload = Buffer.from('{"jsonrpc":"2.0","result":true}');
      const frame = encodeFrame(FrameType.JSON_RPC_RESPONSE, payload);
      
      expect(frame[0]).toBe(FrameType.JSON_RPC_RESPONSE);
    });

    it('should encode notification frame', () => {
      const payload = Buffer.from('{"jsonrpc":"2.0","method":"notify"}');
      const frame = encodeFrame(FrameType.JSON_RPC_NOTIFICATION, payload);
      
      expect(frame[0]).toBe(FrameType.JSON_RPC_NOTIFICATION);
    });

    it('should encode binary frame', () => {
      const payload = Buffer.from([0x01, 0x02, 0x03]);
      const frame = encodeFrame(FrameType.BINARY, payload);
      
      expect(frame[0]).toBe(FrameType.BINARY);
    });

    it('should encode heartbeat frame', () => {
      const payload = Buffer.alloc(0);
      const frame = encodeFrame(FrameType.HEARTBEAT, payload);
      
      expect(frame[0]).toBe(FrameType.HEARTBEAT);
    });

    it('should encode auth challenge frame', () => {
      const payload = Buffer.from('challenge');
      const frame = encodeFrame(FrameType.AUTH_CHALLENGE, payload);
      
      expect(frame[0]).toBe(FrameType.AUTH_CHALLENGE);
    });

    it('should encode auth response frame', () => {
      const payload = Buffer.from('response');
      const frame = encodeFrame(FrameType.AUTH_RESPONSE, payload);
      
      expect(frame[0]).toBe(FrameType.AUTH_RESPONSE);
    });

    it('should include correct payload size', () => {
      const payload = Buffer.from('test payload');
      const frame = encodeFrame(FrameType.JSON_RPC_REQUEST, payload);
      
      const size = frame.readUInt32BE(1);
      expect(size).toBe(payload.length);
    });

    it('should handle empty payload', () => {
      const payload = Buffer.alloc(0);
      const frame = encodeFrame(FrameType.HEARTBEAT, payload);
      
      expect(frame.length).toBe(5);
      const size = frame.readUInt32BE(1);
      expect(size).toBe(0);
    });

    it('should handle large payload', () => {
      const payload = Buffer.alloc(10000, 'x');
      const frame = encodeFrame(FrameType.JSON_RPC_REQUEST, payload);
      
      const size = frame.readUInt32BE(1);
      expect(size).toBe(10000);
    });
  });

  describe('decodeFrames', () => {
    it('should decode single frame', () => {
      const payload = Buffer.from('{"jsonrpc":"2.0"}');
      const frame = encodeFrame(FrameType.JSON_RPC_REQUEST, payload);
      
      const { frames, remaining } = decodeFrames(frame);
      
      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe(FrameType.JSON_RPC_REQUEST);
      expect(frames[0].payload.toString()).toBe('{"jsonrpc":"2.0"}');
      expect(remaining.length).toBe(0);
    });

    it('should decode multiple frames', () => {
      const payload1 = Buffer.from('message1');
      const payload2 = Buffer.from('message2');
      const frame1 = encodeFrame(FrameType.JSON_RPC_REQUEST, payload1);
      const frame2 = encodeFrame(FrameType.JSON_RPC_RESPONSE, payload2);
      
      const combined = Buffer.concat([frame1, frame2]);
      const { frames, remaining } = decodeFrames(combined);
      
      expect(frames).toHaveLength(2);
      expect(frames[0].type).toBe(FrameType.JSON_RPC_REQUEST);
      expect(frames[1].type).toBe(FrameType.JSON_RPC_RESPONSE);
      expect(remaining.length).toBe(0);
    });

    it('should handle incomplete frame', () => {
      // Frame header only, no complete payload
      const incomplete = Buffer.from([FrameType.JSON_RPC_REQUEST, 0, 0, 0, 100]);
      
      const { frames, remaining } = decodeFrames(incomplete);
      
      expect(frames).toHaveLength(0);
      expect(remaining.length).toBe(5);
    });

    it('should handle partial payload', () => {
      const payload = Buffer.from('complete message');
      const frame = encodeFrame(FrameType.JSON_RPC_REQUEST, payload);
      const partial = frame.subarray(0, frame.length - 5);
      
      const { frames, remaining } = decodeFrames(partial);
      
      expect(frames).toHaveLength(0);
      expect(remaining.length).toBe(partial.length);
    });

    it('should handle empty buffer', () => {
      const { frames, remaining } = decodeFrames(Buffer.alloc(0));
      
      expect(frames).toHaveLength(0);
      expect(remaining.length).toBe(0);
    });

    it('should handle remaining data after complete frames', () => {
      const payload = Buffer.from('message');
      const frame = encodeFrame(FrameType.JSON_RPC_REQUEST, payload);
      const extra = Buffer.from([0x01, 0x02]);
      
      const combined = Buffer.concat([frame, extra]);
      const { frames, remaining } = decodeFrames(combined);
      
      expect(frames).toHaveLength(1);
      expect(remaining.length).toBe(2);
      expect(remaining[0]).toBe(0x01);
      expect(remaining[1]).toBe(0x02);
    });

    it('should handle buffer smaller than header', () => {
      const small = Buffer.from([0x01, 0x02]);
      
      const { frames, remaining } = decodeFrames(small);
      
      expect(frames).toHaveLength(0);
      expect(remaining.length).toBe(2);
    });

    it('should decode heartbeat frame', () => {
      const frame = encodeFrame(FrameType.HEARTBEAT, Buffer.alloc(0));
      
      const { frames } = decodeFrames(frame);
      
      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe(FrameType.HEARTBEAT);
      expect(frames[0].payload.length).toBe(0);
    });
  });

  describe('FrameType', () => {
    it('should have correct frame type values', () => {
      expect(FrameType.JSON_RPC_REQUEST).toBe(0x01);
      expect(FrameType.JSON_RPC_RESPONSE).toBe(0x02);
      expect(FrameType.JSON_RPC_NOTIFICATION).toBe(0x03);
      expect(FrameType.BINARY).toBe(0x04);
      expect(FrameType.HEARTBEAT).toBe(0x05);
      expect(FrameType.AUTH_CHALLENGE).toBe(0x06);
      expect(FrameType.AUTH_RESPONSE).toBe(0x07);
    });
  });
});
