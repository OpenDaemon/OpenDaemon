import { createServer, type Server, type Socket } from 'net';
import { randomUUID } from 'crypto';
import { FrameType, encodeFrame, decodeFrames } from './protocol.js';
import {
  type JsonRpcResponse,
  createResponse,
  createErrorResponse,
  JsonRpcErrorCode,
  parseRequest,
  serialize,
} from './rpc.js';
import type {
  IpcServerConfig,
  IpcSocket,
  RpcMethodHandler,
  ConnectionHandler,
} from './types.js';
import { Logger } from '../utils/logger.js';
import { IpcError, ErrorCode } from '../errors/index.js';

/**
 * IPC Socket wrapper
 */
class IpcSocketImpl implements IpcSocket {
  readonly id: string;
  private socket: Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private dataHandlers: Array<(data: Buffer) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private errorHandlers: Array<(err: Error) => void> = [];

  constructor(socket: Socket) {
    this.id = randomUUID();
    this.socket = socket;
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.socket.on('data', (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      
      // Try to decode frames
      const { frames, remaining } = decodeFrames(this.buffer);
      this.buffer = remaining as unknown as Buffer;
      
      for (const frame of frames) {
        if (frame.type === FrameType.JSON_RPC_REQUEST || 
            frame.type === FrameType.JSON_RPC_RESPONSE ||
            frame.type === FrameType.JSON_RPC_NOTIFICATION) {
          for (const handler of this.dataHandlers) {
            handler(frame.payload);
          }
        }
      }
    });

    this.socket.on('close', () => {
      for (const handler of this.closeHandlers) {
        handler();
      }
    });

    this.socket.on('error', (err: Error) => {
      for (const handler of this.errorHandlers) {
        handler(err);
      }
    });
  }

  write(data: Buffer): boolean {
    return this.socket.write(data);
  }

  end(): void {
    this.socket.end();
  }

  on(event: 'data', handler: (data: Buffer) => void): void;
  on(event: 'close', handler: () => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  on(event: string, handler: unknown): void {
    switch (event) {
      case 'data':
        this.dataHandlers.push(handler as (data: Buffer) => void);
        break;
      case 'close':
        this.closeHandlers.push(handler as () => void);
        break;
      case 'error':
        this.errorHandlers.push(handler as (err: Error) => void);
        break;
    }
  }
}

/**
 * IPC Server implementation using Unix Domain Sockets
 */
export class IpcServer {
  private server?: Server;
  private sockets = new Map<string, IpcSocketImpl>();
  private methods = new Map<string, RpcMethodHandler>();
  private connectionHandlers: ConnectionHandler[] = [];
  private config: IpcServerConfig;
  private logger: Logger;

  constructor(config: IpcServerConfig) {
    this.config = {
      maxConnections: 100,
      maxMessageSize: 10 * 1024 * 1024, // 10MB
      ...config,
    };
    this.logger = new Logger('ipc-server');
  }

  /**
   * Start the IPC server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (err: Error) => {
        this.logger.error('Server error', undefined, err);
        reject(new IpcError(ErrorCode.IPC_ERROR, 'Server error', undefined, err));
      });

      // Support both Unix sockets and TCP
      if (this.config.socketPath) {
        this.server.listen(this.config.socketPath, () => {
          this.logger.info(`IPC server listening on ${this.config.socketPath}`);
          resolve();
        });
      } else if (this.config.host && this.config.port) {
        this.server.listen(this.config.port, this.config.host, () => {
          this.logger.info(`IPC server listening on ${this.config.host}:${this.config.port}`);
          resolve();
        });
      } else {
        reject(new IpcError(ErrorCode.IPC_ERROR, 'Invalid server config: must provide socketPath or host+port'));
      }
    });
  }

  /**
   * Stop the IPC server
   */
  async stop(): Promise<void> {
    // Close all client connections
    for (const socket of this.sockets.values()) {
      socket.end();
    }
    this.sockets.clear();

    // Close server
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          this.logger.info('IPC server stopped');
          resolve();
        });
      });
    }
  }

  /**
   * Register an RPC method
   */
  registerMethod(name: string, handler: RpcMethodHandler): void {
    this.methods.set(name, handler);
    this.logger.debug(`Registered method: ${name}`);
  }

  /**
   * Unregister an RPC method
   */
  unregisterMethod(name: string): void {
    this.methods.delete(name);
    this.logger.debug(`Unregistered method: ${name}`);
  }

  /**
   * Broadcast a notification to all connected clients
   */
  broadcast(method: string, params: unknown): void {
    const notification = {
      jsonrpc: '2.0' as const,
      method,
      params,
    };

    const payload = serialize(notification);
    const frame = encodeFrame(FrameType.JSON_RPC_NOTIFICATION, payload);

    for (const socket of this.sockets.values()) {
      socket.write(frame);
    }

    this.logger.debug(`Broadcast: ${method}`, { clientCount: this.sockets.size });
  }

  /**
   * Register connection handler
   */
  onConnection(handler: ConnectionHandler): void {
    this.connectionHandlers.push(handler);
  }

  /**
   * Get number of connected clients
   */
  getConnectionCount(): number {
    return this.sockets.size;
  }

  /**
   * Handle new connection
   */
  private handleConnection(socket: Socket): void {
    if (this.sockets.size >= (this.config.maxConnections ?? 100)) {
      this.logger.warn('Max connections reached, rejecting new connection');
      socket.end();
      return;
    }

    const ipcSocket = new IpcSocketImpl(socket);
    this.sockets.set(ipcSocket.id, ipcSocket);

    this.logger.debug(`Client connected: ${ipcSocket.id}`, {
      connectionCount: this.sockets.size,
    });

    // Notify handlers
    for (const handler of this.connectionHandlers) {
      handler(ipcSocket);
    }

    // Handle data
    ipcSocket.on('data', async (data: Buffer) => {
      await this.handleRequest(data, ipcSocket);
    });

    // Handle disconnect
    ipcSocket.on('close', () => {
      this.sockets.delete(ipcSocket.id);
      this.logger.debug(`Client disconnected: ${ipcSocket.id}`, {
        connectionCount: this.sockets.size,
      });
    });

    // Handle errors
    ipcSocket.on('error', (err: Error) => {
      this.logger.error(`Socket error for ${ipcSocket.id}`, undefined, err);
      this.sockets.delete(ipcSocket.id);
    });
  }

  /**
   * Handle RPC request
   */
  private async handleRequest(data: Buffer, socket: IpcSocketImpl): Promise<void> {
    const request = parseRequest(data);

    if (!request) {
      this.sendError(socket, null, JsonRpcErrorCode.PARSE_ERROR, 'Parse error');
      return;
    }

    // Check message size
    if (data.length > (this.config.maxMessageSize ?? 10 * 1024 * 1024)) {
      this.sendError(socket, request.id, JsonRpcErrorCode.INVALID_REQUEST, 'Message too large');
      return;
    }

    // Check auth token if required
    if (this.config.authToken) {
      const authHeader = (request.params as Record<string, unknown> | undefined)?.['__authToken'];
      if (authHeader !== this.config.authToken) {
        this.sendError(socket, request.id, JsonRpcErrorCode.INVALID_REQUEST, 'Invalid auth token');
        return;
      }
    }

    // Find handler
    const handler = this.methods.get(request.method);
    if (!handler) {
      this.sendError(
        socket,
        request.id,
        JsonRpcErrorCode.METHOD_NOT_FOUND,
        `Method not found: ${request.method}`
      );
      return;
    }

    // Execute handler
    try {
      const result = await handler(request.params, socket);
      
      // Only send response if it's a request (has id)
      if (request.id !== null) {
        const response = createResponse(request.id, result);
        this.sendResponse(socket, response);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error(`Error executing method ${request.method}`, undefined, error);
      
      if (request.id !== null) {
        this.sendError(
          socket,
          request.id,
          JsonRpcErrorCode.INTERNAL_ERROR,
          error.message
        );
      }
    }
  }

  /**
   * Send RPC response
   */
  private sendResponse(socket: IpcSocketImpl, response: JsonRpcResponse): void {
    const payload = serialize(response);
    const frame = encodeFrame(FrameType.JSON_RPC_RESPONSE, payload);
    socket.write(frame);
  }

  /**
   * Send RPC error
   */
  private sendError(
    socket: IpcSocketImpl,
    id: string | number | null,
    code: number,
    message: string
  ): void {
    const response = createErrorResponse(id, code, message);
    const payload = serialize(response);
    const frame = encodeFrame(FrameType.JSON_RPC_RESPONSE, payload);
    socket.write(frame);
  }
}
