import { createConnection, type Socket } from 'net';
import { FrameType, encodeFrame, decodeFrames } from './protocol.js';
import {
  createRequest,
  parseResponse,
  serialize,
} from './rpc.js';
import type { IpcClientConfig, IIpcClient } from './types.js';
import { Logger } from '../utils/logger.js';
import { IpcError, ErrorCode } from '../errors/index.js';

/**
 * Pending request
 */
interface PendingRequest {
  id: string | number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * IPC Client implementation
 */
export class IpcClient implements IIpcClient {
  private socket: Socket | undefined;
  private buffer: Buffer = Buffer.alloc(0);
  private pendingRequests = new Map<string | number, PendingRequest>();
  private notificationHandlers: Array<(method: string, params: unknown) => void> = [];
  private config: Required<IpcClientConfig>;
  private logger: Logger;
  private connected = false;
  private requestId = 0;

  constructor(config: IpcClientConfig) {
    this.config = {
      socketPath: config.socketPath ?? '',
      host: config.host ?? '127.0.0.1',
      port: config.port ?? 9999,
      timeout: config.timeout ?? 30000,
      authToken: config.authToken ?? '',
    };
    this.logger = new Logger('ipc-client');
  }

  /**
   * Connect to IPC server
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Support both Unix sockets and TCP
      const hasSocketPath = this.config.socketPath && this.config.socketPath.length > 0;
      
      if (hasSocketPath) {
        // Unix socket connection
        this.socket = createConnection(this.config.socketPath, () => {
          this.connected = true;
          this.logger.info(`Connected to IPC server at ${this.config.socketPath}`);
          resolve();
        });
      } else {
        // TCP connection
        this.socket = createConnection({
          host: this.config.host,
          port: this.config.port,
        }, () => {
          this.connected = true;
          this.logger.info(`Connected to IPC server at ${this.config.host}:${this.config.port}`);
          resolve();
        });
      }

      this.socket.on('data', (data: Buffer) => {
        this.handleData(data);
      });

      this.socket.on('close', () => {
        this.connected = false;
        this.logger.info('Disconnected from IPC server');
        
        // Reject all pending requests
        for (const request of this.pendingRequests.values()) {
          clearTimeout(request.timeout);
          request.reject(new IpcError(ErrorCode.IPC_ERROR, 'Connection closed'));
        }
        this.pendingRequests.clear();
      });

      this.socket.on('error', (err: Error) => {
        this.logger.error('Socket error', undefined, err);
        
        if (!this.connected) {
          reject(new IpcError(ErrorCode.IPC_CONNECTION_REFUSED, err.message, undefined, err));
        }
      });
    });
  }

  /**
   * Disconnect from IPC server
   */
  async disconnect(): Promise<void> {
    if (this.socket) {
      this.socket.end();
      this.socket = undefined as unknown as Socket;
      this.connected = false;
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Call an RPC method
   */
  async call(method: string, params?: unknown): Promise<unknown> {
    if (!this.connected || !this.socket) {
      throw new IpcError(ErrorCode.IPC_ERROR, 'Not connected to server');
    }

    const id = ++this.requestId;
    const request = createRequest(id, method, this.addAuthToken(params));

    return new Promise((resolve, reject) => {
      // Set timeout
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new IpcError(ErrorCode.IPC_TIMEOUT, `Request timeout: ${method}`));
      }, this.config.timeout);

      // Store pending request
      this.pendingRequests.set(id, {
        id,
        resolve,
        reject,
        timeout,
      });

      // Send request
      const payload = serialize(request);
      const frame = encodeFrame(FrameType.JSON_RPC_REQUEST, payload);
      
      const success = this.socket!.write(frame);
      if (!success) {
        this.socket!.once('drain', () => {
          this.logger.debug(`Request ${id} drained`);
        });
      }
    });
  }

  /**
   * Send notification (no response expected)
   */
  notify(method: string, params?: unknown): void {
    if (!this.connected || !this.socket) {
      throw new IpcError(ErrorCode.IPC_ERROR, 'Not connected to server');
    }

    const notification = {
      jsonrpc: '2.0' as const,
      method,
      params: this.addAuthToken(params),
    };

    const payload = serialize(notification);
    const frame = encodeFrame(FrameType.JSON_RPC_NOTIFICATION, payload);
    this.socket.write(frame);
  }

  /**
   * Register notification handler
   */
  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandlers.push(handler);
  }

  /**
   * Handle incoming data
   */
  private handleData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);

    const { frames, remaining } = decodeFrames(this.buffer);
    this.buffer = remaining as unknown as Buffer;

    for (const frame of frames) {
      switch (frame.type) {
        case FrameType.JSON_RPC_RESPONSE:
          this.handleResponse(frame.payload);
          break;
        case FrameType.JSON_RPC_NOTIFICATION:
          this.handleNotification(frame.payload);
          break;
        case FrameType.HEARTBEAT:
          // Send heartbeat response
          if (this.socket) {
            this.socket.write(encodeFrame(FrameType.HEARTBEAT, Buffer.alloc(0)));
          }
          break;
      }
    }
  }

  /**
   * Handle RPC response
   */
  private handleResponse(data: Buffer): void {
    const response = parseResponse(data);

    if (!response) {
      this.logger.error('Failed to parse response');
      return;
    }

    const pending = response.id !== null ? this.pendingRequests.get(response.id) : undefined;
    if (!pending) {
      this.logger.warn(`Received response for unknown request: ${String(response.id)}`);
      return;
    }

    // Clear timeout
    clearTimeout(pending.timeout);
    if (response.id !== null) { this.pendingRequests.delete(response.id); }

    // Resolve or reject
    if (response.error) {
      pending.reject(new IpcError(ErrorCode.IPC_ERROR, response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  /**
   * Handle notification
   */
  private handleNotification(data: Buffer): void {
    try {
      const notification = JSON.parse(data.toString('utf-8')) as {
        method: string;
        params?: unknown;
      };

      for (const handler of this.notificationHandlers) {
        try {
          handler(notification.method, notification.params);
        } catch (err) {
          this.logger.error('Error in notification handler', undefined, err as Error);
        }
      }
    } catch (err) {
      this.logger.error('Failed to parse notification', undefined, err as Error);
    }
  }

  /**
   * Add auth token to params
   */
  private addAuthToken(params: unknown): unknown {
    if (!this.config.authToken) {
      return params;
    }

    if (typeof params === 'object' && params !== null) {
      return {
        ...params,
        __authToken: this.config.authToken,
      };
    }

    return {
      data: params,
      __authToken: this.config.authToken,
    };
  }
}
