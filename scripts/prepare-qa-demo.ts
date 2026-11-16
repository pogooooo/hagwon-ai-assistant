import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createOperationsServer } from '../src/features/academy-operations/application.ts';
import { prepareQADemo } from '../src/features/academy-operations/qa-demo.ts';

const filename = process.argv[2];
if (!filename || !existsSync(filename))
  throw new Error(
    '사용법: node scripts/prepare-qa-demo.ts <기존 가상 데모 DB 경로>',
  );
const db = new DatabaseSync(resolve(filename));
try {
  const academy = db
    .prepare('SELECT name FROM academies WHERE id=?')
    .get('AC_TEST_A');
  if (academy?.name !== '[가상] 테스트 교습소')
    throw new Error('가상 QA DB가 아닙니다.');
  // Initializes the same existing operational modules, without opening a port.
  createOperationsServer({
    db,
    demoPassword: process.env.AXR_OPERATIONS_DEMO_PASSWORD ?? 'axr-demo',
  });
  console.log(JSON.stringify(await prepareQADemo(db)));
} finally {
  db.close();
}
