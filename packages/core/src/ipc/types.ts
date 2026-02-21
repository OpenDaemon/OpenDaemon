/**
 * IPC Server configuration
 */
export interface IpcServerConfig {
  socketPath: string;
  maxConnections?: number;
  maxMessageSize?: number;
  authToken?: string;
}

/**
 * IPC Client configuration
 */
export interface IpcClientConfig {
  socketPath: string;
  timeout?: number;
  authToken?: string;
}

/**
 * Connection handler function type
 */
export type ConnectionHandler = (socket: IpcSocket) => void;

/**
 * Message handler function type
 */
export type MessageHandler = (message: unknown, socket: IpcSocket) => void | Promise<void>;

/**
 * IPC Socket interface
 */
export interface IpcSocket {
  id: string;
  write(data: Buffer): boolean;
  end(): void;
  on(event: 'data', handler: (data: Buffer) => void): void;
  on(event: 'close', handler: () => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
}

/**
 * RPC method handler
 */
export type RpcMethodHandler = (params: unknown, socket: IpcSocket) => unknown | Promise<unknown>;

/**
 * IPC Server interface
 */
export interface IIpcServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  registerMethod(name: string, handler: RpcMethodHandler): void;
  broadcast(method: string, params: unknown): void;
  onConnection(handler: ConnectionHandler): void;
}

/**
 * IPC Client interface
 */
export interface IIpcClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  call(method: string, params?: unknown): Promise<unknown>;
  onNotification(handler: (method: string, params: unknown) => void): void;
  isConnected(): boolean;
}
