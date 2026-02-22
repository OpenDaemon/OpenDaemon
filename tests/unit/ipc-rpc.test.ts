import { describe, it, expect } from 'vitest';
import {
  createRequest,
  createResponse,
  createErrorResponse,
  parseRequest,
  parseResponse,
  serialize,
  JsonRpcErrorCode,
} from '../../packages/core/src/ipc/rpc.js';

describe('JSON-RPC', () => {
  describe('createRequest', () => {
    it('should create request with all fields', () => {
      const request = createRequest(1, 'testMethod', { key: 'value' });
      
      expect(request).toEqual({
        jsonrpc: '2.0',
        id: 1,
        method: 'testMethod',
        params: { key: 'value' },
      });
    });

    it('should create request without params', () => {
      const request = createRequest('abc', 'method');
      
      expect(request.jsonrpc).toBe('2.0');
      expect(request.id).toBe('abc');
      expect(request.method).toBe('method');
      expect(request.params).toBeUndefined();
    });

    it('should create notification request with null id', () => {
      const request = createRequest(null, 'notify', { data: 123 });
      
      expect(request.jsonrpc).toBe('2.0');
      expect(request.id).toBeNull();
      expect(request.method).toBe('notify');
      expect(request.params).toEqual({ data: 123 });
    });
  });

  describe('createResponse', () => {
    it('should create success response', () => {
      const response = createResponse(1, { result: 'success' });
      
      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: { result: 'success' },
      });
    });

    it('should create response with null id', () => {
      const response = createResponse(null, 'data');
      
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBeNull();
      expect(response.result).toBe('data');
    });

    it('should create response with string id', () => {
      const response = createResponse('req-123', [1, 2, 3]);
      
      expect(response.id).toBe('req-123');
      expect(response.result).toEqual([1, 2, 3]);
    });
  });

  describe('createErrorResponse', () => {
    it('should create error response', () => {
      const response = createErrorResponse(
        1,
        JsonRpcErrorCode.METHOD_NOT_FOUND,
        'Method not found'
      );
      
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      expect(response.error).toEqual({
        code: JsonRpcErrorCode.METHOD_NOT_FOUND,
        message: 'Method not found',
      });
    });

    it('should create error response with data', () => {
      const response = createErrorResponse(
        'abc',
        JsonRpcErrorCode.INVALID_PARAMS,
        'Invalid params',
        { field: 'name' }
      );
      
      expect(response.error).toEqual({
        code: JsonRpcErrorCode.INVALID_PARAMS,
        message: 'Invalid params',
        data: { field: 'name' },
      });
    });
  });

  describe('parseRequest', () => {
    it('should parse valid request', () => {
      const request = createRequest(1, 'method', { data: true });
      const buffer = serialize(request);
      
      const parsed = parseRequest(buffer);
      
      expect(parsed).toEqual(request);
    });

    it('should parse request with string id', () => {
      const request = createRequest('req-1', 'method');
      const buffer = serialize(request);
      
      const parsed = parseRequest(buffer);
      
      expect(parsed?.id).toBe('req-1');
    });

    it('should parse notification request', () => {
      const request = createRequest(null, 'notify');
      const buffer = serialize(request);
      
      const parsed = parseRequest(buffer);
      
      expect(parsed?.id).toBeNull();
    });

    it('should return null for invalid JSON', () => {
      const buffer = Buffer.from('not json');
      
      const parsed = parseRequest(buffer);
      
      expect(parsed).toBeNull();
    });

    it('should return null for missing jsonrpc field', () => {
      const buffer = Buffer.from('{"id":1,"method":"test"}');
      
      const parsed = parseRequest(buffer);
      
      expect(parsed).toBeNull();
    });

    it('should return null for missing method field', () => {
      const buffer = Buffer.from('{"jsonrpc":"2.0","id":1}');
      
      const parsed = parseRequest(buffer);
      
      expect(parsed).toBeNull();
    });

    it('should return null for invalid jsonrpc version', () => {
      const buffer = Buffer.from('{"jsonrpc":"1.0","id":1,"method":"test"}');
      
      const parsed = parseRequest(buffer);
      
      expect(parsed).toBeNull();
    });

    it('should return null for invalid id type', () => {
      const buffer = Buffer.from('{"jsonrpc":"2.0","id":{},"method":"test"}');
      
      const parsed = parseRequest(buffer);
      
      expect(parsed).toBeNull();
    });

    it('should accept number id', () => {
      const buffer = Buffer.from('{"jsonrpc":"2.0","id":123,"method":"test"}');
      
      const parsed = parseRequest(buffer);
      
      expect(parsed?.id).toBe(123);
    });

    it('should return null for non-object data (lines 164-165)', () => {
      const buffer = Buffer.from('"string"');
      
      const parsed = parseRequest(buffer);
      
      expect(parsed).toBeNull();
    });

    it('should return null for null data (lines 164-165)', () => {
      const buffer = Buffer.from('null');
      
      const parsed = parseRequest(buffer);
      
      expect(parsed).toBeNull();
    });
  });

  describe('parseResponse', () => {
    it('should parse success response', () => {
      const response = createResponse(1, { success: true });
      const buffer = serialize(response);
      
      const parsed = parseResponse(buffer);
      
      expect(parsed).toEqual(response);
    });

    it('should parse error response', () => {
      const response = createErrorResponse(
        1,
        JsonRpcErrorCode.INTERNAL_ERROR,
        'Internal error'
      );
      const buffer = serialize(response);
      
      const parsed = parseResponse(buffer);
      
      expect(parsed?.error?.code).toBe(JsonRpcErrorCode.INTERNAL_ERROR);
      expect(parsed?.error?.message).toBe('Internal error');
    });

    it('should return null for invalid JSON', () => {
      const buffer = Buffer.from('not json');
      
      const parsed = parseResponse(buffer);
      
      expect(parsed).toBeNull();
    });

    it('should return null for missing jsonrpc field', () => {
      const buffer = Buffer.from('{"id":1,"result":true}');
      
      const parsed = parseResponse(buffer);
      
      expect(parsed).toBeNull();
    });

    it('should return null when neither result nor error present', () => {
      const buffer = Buffer.from('{"jsonrpc":"2.0","id":1}');
      
      const parsed = parseResponse(buffer);
      
      expect(parsed).toBeNull();
    });

    it('should return null for non-object data (lines 183-184)', () => {
      const buffer = Buffer.from('"string"');
      
      const parsed = parseResponse(buffer);
      
      expect(parsed).toBeNull();
    });

    it('should return null for null data (lines 183-184)', () => {
      const buffer = Buffer.from('null');
      
      const parsed = parseResponse(buffer);
      
      expect(parsed).toBeNull();
    });

    it('should parse response with both result and error (edge case)', () => {
      const buffer = Buffer.from(
        '{"jsonrpc":"2.0","id":1,"result":true,"error":{"code":-32600}}'
      );
      
      const parsed = parseResponse(buffer);
      
      expect(parsed).toBeTruthy();
    });
  });

  describe('serialize', () => {
    it('should serialize request to buffer', () => {
      const request = createRequest(1, 'method');
      
      const buffer = serialize(request);
      
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.toString()).toContain('jsonrpc');
    });

    it('should serialize response to buffer', () => {
      const response = createResponse(1, 'result');
      
      const buffer = serialize(response);
      
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.toString()).toContain('result');
    });

    it('should serialize complex objects', () => {
      const request = createRequest(1, 'method', {
        nested: { deep: 'value' },
        array: [1, 2, 3],
      });
      
      const buffer = serialize(request);
      const parsed = parseRequest(buffer);
      
      expect(parsed?.params).toEqual({
        nested: { deep: 'value' },
        array: [1, 2, 3],
      });
    });
  });

  describe('JsonRpcErrorCode', () => {
    it('should have correct error codes', () => {
      expect(JsonRpcErrorCode.PARSE_ERROR).toBe(-32700);
      expect(JsonRpcErrorCode.INVALID_REQUEST).toBe(-32600);
      expect(JsonRpcErrorCode.METHOD_NOT_FOUND).toBe(-32601);
      expect(JsonRpcErrorCode.INVALID_PARAMS).toBe(-32602);
      expect(JsonRpcErrorCode.INTERNAL_ERROR).toBe(-32603);
      expect(JsonRpcErrorCode.SERVER_ERROR).toBe(-32000);
    });
  });
});
