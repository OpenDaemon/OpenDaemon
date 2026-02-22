import { describe, it, expect } from 'vitest';
import { IpcClient } from '../../packages/core/src/index.js';

describe('IpcClient', () => {
  it('should be defined', () => {
    expect(IpcClient).toBeDefined();
  });
});
