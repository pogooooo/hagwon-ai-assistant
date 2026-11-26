import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { AXR_OPERATIONS_DB, AXR_BACKUP_DIR = '/var/lib/axr/backups' } =
  process.env;
if (!AXR_OPERATIONS_DB) throw new Error('AXR_OPERATIONS_DB is required');
const source = new DatabaseSync(resolve(AXR_OPERATIONS_DB), { readOnly: true });
try {
  const directory = resolve(AXR_BACKUP_DIR);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const name =
    'operations-' +
    new Date().toISOString().replace(/[:.]/g, '-') +
    '-' +
    randomUUID() +
    '.sqlite';
  const final = join(directory, name);
  const partial = final + '.part';
  try {
    source.exec('PRAGMA busy_timeout = 5000');
    source.prepare('VACUUM INTO ?').run(partial);
    const copy = new DatabaseSync(partial, { readOnly: true });
    try {
      if (
        copy.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok'
      ) {
        throw new Error('SQLite backup did not pass integrity_check');
      }
    } finally {
      copy.close();
    }
    await rename(partial, final);
    console.log('AXR SQLite backup completed: ' + name);
  } finally {
    await rm(partial, { force: true });
  }
} finally {
  source.close();
}
