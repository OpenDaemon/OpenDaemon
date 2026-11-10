import { readFileSync } from 'fs';

/** The user and group an app runs as, as numbers (what spawn wants) */
export interface Identity { uid?: number; gid?: number }

/** Look a name up in an /etc/passwd or /etc/group style file: [name, x, id, ...] */
function lookup(file: string, key: string | number, byId: boolean): string[] | undefined {
  let text: string;
  try { text = readFileSync(file, 'utf-8'); } catch { return undefined; }
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const fields = line.split(':');
    if (byId ? Number(fields[2]) === key : fields[0] === key) return fields;
  }
  return undefined;
}

/**
 * PM2's uid / gid: a name or a number. A name is looked up in /etc/passwd and /etc/group; a user
 * given without a group runs in its own primary group (not in the daemon's, usually root's).
 * Returns an error message when the request cannot be met, so a start fails with a reason rather
 * than with a bare EPERM from spawn.
 */
export function resolveIdentity(uid: number | string | undefined, gid: number | string | undefined): Identity | { error: string } {
  if (uid === undefined && gid === undefined) return {};
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return { error: 'uid and gid are not supported on this platform' };
  const out: Identity = {};
  if (uid !== undefined) {
    if (typeof uid === 'number' || /^\d+$/.test(uid)) {
      out.uid = Number(uid);
      const entry = lookup('/etc/passwd', out.uid, true);
      if (gid === undefined && entry?.[3] !== undefined) out.gid = Number(entry[3]);
    } else {
      const entry = lookup('/etc/passwd', uid, false);
      if (!entry) return { error: `uid: no user named "${uid}"` };
      out.uid = Number(entry[2]);
      if (gid === undefined) out.gid = Number(entry[3]);
    }
  }
  if (gid !== undefined) {
    if (typeof gid === 'number' || /^\d+$/.test(gid)) out.gid = Number(gid);
    else {
      const entry = lookup('/etc/group', gid, false);
      if (!entry) return { error: `gid: no group named "${gid}"` };
      out.gid = Number(entry[2]);
    }
  }
  const me = process.getuid();
  if (me !== 0 && ((out.uid !== undefined && out.uid !== me) || (out.gid !== undefined && out.gid !== process.getgid?.()))) {
    return { error: 'uid/gid: only a daemon running as root can start an app as another user or group' };
  }
  return out;
}
