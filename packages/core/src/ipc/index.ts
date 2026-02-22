// IPC protocol exports
export { encodeFrame, decodeFrames, FrameType, type Frame } from './protocol.js';

// JSON-RPC exports
export {
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcError,
  JsonRpcErrorCode,
  parseRequest,
  parseResponse,
  createRequest,
  createResponse,
  createErrorResponse,
  serialize,
} from './rpc.js';

// IPC Server/Client
export { IpcServer } from './server.js';
export { IpcClient } from './client.js';
export type {
  IpcServerConfig,
  IpcClientConfig,
  IpcSocket,
  RpcMethodHandler,
  ConnectionHandler,
  IIpcServer,
  IIpcClient,
} from './types.js';
