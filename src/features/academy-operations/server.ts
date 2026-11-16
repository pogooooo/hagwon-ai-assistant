import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createOperationsServer } from './application.ts';

const port = Number(process.env.AXR_OPERATIONS_PORT ?? '8791');
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('AXR_OPERATIONS_PORT must be a valid port number.');
}
const filename = resolve(
  process.env.AXR_OPERATIONS_DB ?? '.local/academy-operations.sqlite',
);
mkdirSync(dirname(filename), { recursive: true });
const db = new DatabaseSync(filename);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
`);
const server = createOperationsServer({
  db,
  publicOrigin: process.env.AXR_OPERATIONS_PUBLIC_ORIGIN
    ? new URL(process.env.AXR_OPERATIONS_PUBLIC_ORIGIN)
    : undefined,
  demoPassword: process.env.AXR_OPERATIONS_DEMO_PASSWORD ?? 'axr-demo',
  showDefaultPassword: process.env.AXR_OPERATIONS_DEMO_PASSWORD === undefined,
});
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address === 'object') {
    console.log(`AXR 학원 운영 http://127.0.0.1:${address.port}`);
  }
});
