/**
 * JSON-RPC 2.0 request
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown;
}

/**
 * JSON-RPC 2.0 response
 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

/**
 * JSON-RPC 2.0 error
 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * JSON-RPC 2.0 error codes
 */
export const JsonRpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_ERROR: -32000,
} as const;

/**
 * Parse a JSON-RPC request from buffer
 *
 * @param buffer - Buffer to parse
 * @returns Parsed request or null if invalid
 */
export function parseRequest(buffer: Buffer): JsonRpcRequest | null {
  try {
    const text = buffer.toString('utf-8');
    const data = JSON.parse(text) as unknown;

    if (!isValidRequest(data)) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

/**
 * Parse a JSON-RPC response from buffer
 *
 * @param buffer - Buffer to parse
 * @returns Parsed response or null if invalid
 */
export function parseResponse(buffer: Buffer): JsonRpcResponse | null {
  try {
    const text = buffer.toString('utf-8');
    const data = JSON.parse(text) as unknown;

    if (!isValidResponse(data)) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

/**
 * Create a JSON-RPC request
 *
 * @param id - Request ID
 * @param method - Method name
 * @param params - Method parameters
 * @returns JSON-RPC request
 */
export function createRequest(
  id: number | string | null,
  method: string,
  params?: unknown
): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params,
  };
}

/**
 * Create a JSON-RPC success response
 *
 * @param id - Request ID
 * @param result - Result data
 * @returns JSON-RPC response
 */
export function createResponse(
  id: number | string | null,
  result: unknown
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

/**
 * Create a JSON-RPC error response
 *
 * @param id - Request ID
 * @param code - Error code
 * @param message - Error message
 * @param data - Additional error data
 * @returns JSON-RPC response
 */
export function createErrorResponse(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      data,
    },
  };
}

/**
 * Serialize JSON-RPC message to buffer
 *
 * @param message - Message to serialize
 * @returns Serialized buffer
 */
export function serialize(message: JsonRpcRequest | JsonRpcResponse): Buffer {
  return Buffer.from(JSON.stringify(message), 'utf-8');
}

/**
 * Type guard for JsonRpcRequest
 */
function isValidRequest(data: unknown): data is JsonRpcRequest {
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  const req = data as Record<string, unknown>;

  return (
    req['jsonrpc'] === '2.0' &&
    (typeof req['id'] === 'number' ||
      typeof req['id'] === 'string' ||
      req['id'] === null) &&
    typeof req['method'] === 'string'
  );
}

/**
 * Type guard for JsonRpcResponse
 */
function isValidResponse(data: unknown): data is JsonRpcResponse {
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  const res = data as Record<string, unknown>;

  return (
    res['jsonrpc'] === '2.0' &&
    (typeof res['id'] === 'number' ||
      typeof res['id'] === 'string' ||
      res['id'] === null) &&
    (res['result'] !== undefined || res['error'] !== undefined)
  );
}
