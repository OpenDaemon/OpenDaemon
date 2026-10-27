import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SecretStore, toDotenv } from '../../packages/plugins/secret-manager/src/store.js';

describe('SecretStore', () => {
  let home: string;

  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'od-secrets-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('should encrypt at rest and decrypt the latest or a given version', () => {
    const store = new SecretStore(home, undefined);
    expect(store.set('DATABASE_URL', 'postgres://u:p@h/db')).toBe(1);
    expect(store.set('DATABASE_URL', 'postgres://u:new@h/db')).toBe(2);

    expect(store.get('DATABASE_URL')).toBe('postgres://u:new@h/db');
    expect(store.get('DATABASE_URL', 1)).toBe('postgres://u:p@h/db');
    expect(store.get('DATABASE_URL', 9)).toBeUndefined();
    expect(store.get('MISSING')).toBeUndefined();
    expect(readFileSync(store.file, 'utf-8')).not.toContain('postgres');
    // A fresh instance reads the same files
    expect(new SecretStore(home, undefined).get('DATABASE_URL')).toBe('postgres://u:new@h/db');
  });

  it.skipIf(process.platform === 'win32')('should keep the key and store readable only by the user', () => {
    new SecretStore(home, undefined).set('A', '1');
    expect(statSync(join(home, 'master.key')).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'secrets.enc')).mode & 0o777).toBe(0o600);
  });

  it('should list names with versions, keep the last 5 versions, and delete', () => {
    const store = new SecretStore(home, undefined);
    for (let i = 1; i <= 7; i++) store.set('TOKEN', `v${String(i)}`);
    store.set('API_KEY', 'k');

    expect(store.list().map((s) => [s.name, s.version])).toEqual([['API_KEY', 1], ['TOKEN', 7]]);
    expect(store.get('TOKEN', 2)).toBeUndefined();
    expect(store.get('TOKEN', 3)).toBe('v3');

    expect(store.delete('TOKEN')).toBe(true);
    expect(store.delete('TOKEN')).toBe(false);
    expect(store.list().map((s) => s.name)).toEqual(['API_KEY']);
  });

  it('should detect tampering, a ciphertext moved to another name, and a wrong key', () => {
    const store = new SecretStore(home, undefined);
    store.set('A', 'alpha');
    store.set('B', 'beta');
    const original = readFileSync(store.file, 'utf-8');

    const parsed = JSON.parse(original) as { secrets: Record<string, unknown[]> };
    parsed.secrets['B'] = parsed.secrets['A']!;
    writeFileSync(store.file, JSON.stringify(parsed));
    expect(() => store.get('B')).toThrow(/Cannot decrypt secret "B"/);

    writeFileSync(store.file, original);
    writeFileSync(join(home, 'master.key'), Buffer.alloc(32, 7).toString('base64'));
    expect(() => store.get('A')).toThrow(/wrong key or password/);
  });

  it('should refuse to invent a new key when secrets exist but the key file is gone', () => {
    new SecretStore(home, undefined).set('A', '1');
    unlinkSync(join(home, 'master.key'));
    expect(() => new SecretStore(home, undefined).get('A')).toThrow(/master.key is missing/);
  });

  it('should derive the key from OPENDAEMON_SECRET_PASSWORD when the store was created with one', () => {
    new SecretStore(home, 'correct horse').set('A', 'secret');
    expect(() => statSync(join(home, 'master.key'))).toThrow();

    expect(new SecretStore(home, 'correct horse').get('A')).toBe('secret');
    expect(() => new SecretStore(home, undefined).get('A')).toThrow(/set OPENDAEMON_SECRET_PASSWORD/);
    expect(() => new SecretStore(home, 'wrong').get('A')).toThrow(/wrong key or password/);
  });

  it('should reject invalid names and a damaged store', () => {
    const store = new SecretStore(home, undefined);
    expect(() => store.set('1BAD', 'x')).toThrow(/Invalid secret name/);
    expect(() => store.set('has space', 'x')).toThrow(/Invalid secret name/);
    writeFileSync(store.file, JSON.stringify({ format: 2 }));
    expect(() => store.list()).toThrow(/Unsupported or damaged secret store/);
  });
});

describe('toDotenv', () => {
  it('should quote and escape values', () => {
    expect(toDotenv('A', 'plain')).toBe('A="plain"');
    expect(toDotenv('B', 'say "hi"\\n\nnext')).toBe('B="say \\"hi\\"\\\\n\\nnext"');
  });
});
