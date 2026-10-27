import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Encrypted secret store: <home>/secrets.enc, AES-256-GCM per secret.
 *
 * Key: random 256-bit key in <home>/master.key (mode 0600), or, when OPENDAEMON_SECRET_PASSWORD
 * is set, PBKDF2-SHA512 of that password with the store's salt. The secret's name is
 * authenticated data, so a ciphertext cannot be moved to another name undetected.
 *
 * Threat model: keeps secrets out of config files, repositories and backups of the store;
 * anyone who can read the key file (i.e. act as this user) can decrypt them.
 */

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const VERSIONS_KEPT = 5;
const PBKDF2_ITERATIONS = 210_000;

interface EncryptedVersion {
  version: number;
  iv: string;
  tag: string;
  data: string;
  createdAt: string;
}

interface StoreFile {
  format: 1;
  kdf: 'keyfile' | 'pbkdf2';
  salt: string;
  secrets: Record<string, EncryptedVersion[]>;
}

export interface SecretInfo {
  name: string;
  version: number;
  updatedAt: string;
}

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretError';
  }
}

export function assertSecretName(name: string): void {
  if (!NAME.test(name)) {
    throw new SecretError(`Invalid secret name "${name}" (letters, digits, _ . -; not starting with a digit)`);
  }
}

export class SecretStore {
  readonly file: string;
  private readonly keyFile: string;

  constructor(private readonly home: string, private readonly password = process.env['OPENDAEMON_SECRET_PASSWORD']) {
    this.file = resolve(home, 'secrets.enc');
    this.keyFile = resolve(home, 'master.key');
  }

  /**
   * Store a new version of a secret; returns its version number
   */
  set(name: string, value: string): number {
    assertSecretName(name);
    const store = this.load();
    const key = this.key(store);
    const versions = store.secrets[name] ?? [];
    const version = (versions.at(-1)?.version ?? 0) + 1;

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(name));
    const data = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
    versions.push({
      version,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
      createdAt: new Date().toISOString(),
    });
    store.secrets[name] = versions.slice(-VERSIONS_KEPT);
    this.save(store);
    return version;
  }

  /**
   * Decrypt a secret (latest version unless one is given); undefined if it does not exist
   */
  get(name: string, version?: number): string | undefined {
    const store = this.load();
    const versions = store.secrets[name];
    const entry = version === undefined ? versions?.at(-1) : versions?.find((v) => v.version === version);
    if (!entry) return undefined;

    const decipher = createDecipheriv('aes-256-gcm', this.key(store), Buffer.from(entry.iv, 'base64'));
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
    try {
      return Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]).toString('utf-8');
    } catch {
      throw new SecretError(`Cannot decrypt secret "${name}": wrong key or password, or the store was tampered with`);
    }
  }

  list(): SecretInfo[] {
    const store = this.load();
    return Object.entries(store.secrets)
      .map(([name, versions]) => ({ name, version: versions.at(-1)?.version ?? 0, updatedAt: versions.at(-1)?.createdAt ?? '' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  delete(name: string): boolean {
    const store = this.load();
    if (!(name in store.secrets)) return false;
    // Build a new object so the deleted key really disappears from the file
    store.secrets = Object.fromEntries(Object.entries(store.secrets).filter(([key]) => key !== name));
    this.save(store);
    return true;
  }

  private load(): StoreFile {
    if (!existsSync(this.file)) {
      return { format: 1, kdf: this.password ? 'pbkdf2' : 'keyfile', salt: randomBytes(16).toString('base64'), secrets: {} };
    }
    const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as Partial<StoreFile>;
    if (parsed.format !== 1 || typeof parsed.secrets !== 'object' || typeof parsed.salt !== 'string') {
      throw new SecretError(`Unsupported or damaged secret store: ${this.file}`);
    }
    return parsed as StoreFile;
  }

  private save(store: StoreFile): void {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    // Write-then-rename: a crash mid-write never leaves a truncated store
    const temp = `${this.file}.${String(process.pid)}.tmp`;
    writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }

  private key(store: StoreFile): Buffer {
    if (store.kdf === 'pbkdf2') {
      if (!this.password) {
        throw new SecretError('This secret store is password-protected: set OPENDAEMON_SECRET_PASSWORD');
      }
      return pbkdf2Sync(this.password, Buffer.from(store.salt, 'base64'), PBKDF2_ITERATIONS, 32, 'sha512');
    }
    if (!existsSync(this.keyFile)) {
      if (Object.keys(store.secrets).length > 0) {
        throw new SecretError(`Secret key ${this.keyFile} is missing; the existing secrets cannot be decrypted`);
      }
      mkdirSync(this.home, { recursive: true, mode: 0o700 });
      writeFileSync(this.keyFile, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
    }
    const key = Buffer.from(readFileSync(this.keyFile, 'utf-8').trim(), 'base64');
    if (key.length !== 32) throw new SecretError(`Secret key ${this.keyFile} is not a 256-bit key`);
    return key;
  }
}

/**
 * `.env` line for a value: always double-quoted, with backslashes, quotes and newlines escaped
 */
export function toDotenv(name: string, value: string): string {
  return `${name}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}
