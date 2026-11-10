import { describe, it, expect } from 'vitest';
import { resolveIdentity } from '../../packages/plugins/process-manager/src/identity.js';

const posix = process.platform !== 'win32' && typeof process.getuid === 'function';

describe.skipIf(!posix)('resolveIdentity (uid / gid of an app)', () => {
  const me = posix ? process.getuid!() : 0;
  const myGroup = posix ? process.getgid!() : 0;

  it('asks for nothing by default', () => {
    expect(resolveIdentity(undefined, undefined)).toEqual({});
  });

  it('accepts the current user by number or as a string, with its group', () => {
    expect(resolveIdentity(me, myGroup)).toEqual({ uid: me, gid: myGroup });
    expect(resolveIdentity(String(me), String(myGroup))).toEqual({ uid: me, gid: myGroup });
  });

  it('refuses an unknown user or group by name', () => {
    expect(resolveIdentity('no-such-user-od', undefined)).toEqual({ error: 'uid: no user named "no-such-user-od"' });
    expect(resolveIdentity(me, 'no-such-group-od')).toEqual({ error: 'gid: no group named "no-such-group-od"' });
  });

  it.skipIf(!posix || process.getuid?.() === 0)('refuses to become someone else unless the daemon is root', () => {
    const result = resolveIdentity(me + 1, undefined);
    expect('error' in result && result.error).toMatch(/only a daemon running as root/);
  });
});
