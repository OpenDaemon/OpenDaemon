/**
 * Frame types for IPC protocol
 */
export enum FrameType {
  JSON_RPC_REQUEST = 0x01,
  JSON_RPC_RESPONSE = 0x02,
  JSON_RPC_NOTIFICATION = 0x03,
  BINARY = 0x04,
  HEARTBEAT = 0x05,
  AUTH_CHALLENGE = 0x06,
  AUTH_RESPONSE = 0x07,
}

/**
 * IPC Frame structure
 */
export interface Frame {
  type: FrameType;
  payload: Buffer;
}

/**
 * Encode a frame to buffer
 *
 * @param type - Frame type
 * @param payload - Payload data
 * @returns Encoded frame buffer
 */
export function encodeFrame(type: FrameType, payload: Buffer): Buffer {
  // Frame structure: [type: 1 byte][size: 4 bytes][payload: variable]
  const size = payload.length;
  const frame = Buffer.alloc(5 + size);

  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(size, 1);
  payload.copy(frame, 5);

  return frame;
}

/**
 * Decode frames from buffer
 *
 * @param buffer - Buffer to decode
 * @returns Array of decoded frames and remaining buffer
 */
export function decodeFrames(
  buffer: Buffer
): { frames: Frame[]; remaining: Buffer } {
  const frames: Frame[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    // Need at least 5 bytes for header
    if (buffer.length - offset < 5) {
      break;
    }

    const type = buffer.readUInt8(offset) as FrameType;
    const size = buffer.readUInt32BE(offset + 1);

    // Check if we have complete frame
    if (buffer.length - offset < 5 + size) {
      break;
    }

    const payload = buffer.subarray(offset + 5, offset + 5 + size);
    frames.push({ type, payload });

    offset += 5 + size;
  }

  const remaining = buffer.subarray(offset);

  return { frames, remaining };
}
