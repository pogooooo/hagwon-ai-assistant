import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createOperationsServer } from './application.ts';
import { authenticate, initializeIdentity } from './directory.ts';
import { listedDemoLogins, setupDemoLogins } from './demo-logins.ts';

test('체험 로그인 변경은 기존 기록과 체험 학원만 유지하며 재기동 시 비밀번호를 덮어쓰지 않는다', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const previous = 'fixturepassword',
    next = 'rotated-test-only';
  initializeIdentity(db, previous);
  db.exec(`INSERT INTO accounts(id,academy_id,username,name,role,password_hash)
    SELECT 'qa-parent',academy_id,'AXR_CHECK_GUARDIAN_20261119','체험 보호자',role,password_hash FROM accounts WHERE id='TA_GUARDIAN_E_MATH';
    INSERT INTO guardian_students VALUES('qa-parent','TA_STU_001');
    INSERT INTO academies VALUES('separate','별도 학원');
    INSERT INTO accounts(id,academy_id,username,name,role,password_hash)
    SELECT 'unrelated','separate','teacher','다른 강사',role,password_hash FROM accounts WHERE id='TA_TEACHER';`);
  createOperationsServer({
    db,
    demoPassword: previous,
    showDemoAccounts: true,
    assetsRoot: null,
  });
  db.prepare('INSERT INTO op_sessions VALUES (?,?,?)').run(
    'old-session',
    'qa-parent',
    Date.now() + 60000,
  );
  const logins = ['admin', 'teacher', 'student', 'parent', 'guest'];
  const hashes = JSON.stringify(
    Object.fromEntries(
      logins.map((key) => {
        const salt = randomBytes(16).toString('hex');
        return [key, salt + ':' + scryptSync(next, salt, 64).toString('hex')];
      }),
    ),
  );
  setupDemoLogins(db, hashes);
  assert.deepEqual(
    listedDemoLogins(db).map((row) => row[1]),
    ['admin', 'teacher1', 'student', 'parent', 'guest'],
  );
  for (const [, user] of listedDemoLogins(db))
    assert.ok(authenticate(db, user, next));
  assert.equal(authenticate(db, 'parent', next)?.id, 'qa-parent');
  assert.equal(
    authenticate(db, 'AXR_CHECK_GUARDIAN_20261119', previous),
    undefined,
  );
  assert.ok(
    db
      .prepare(
        "SELECT 1 FROM guardian_students WHERE guardian_id='qa-parent' AND student_id='TA_STU_001'",
      )
      .get(),
  );
  assert.ok(
    db
      .prepare(
        "SELECT 1 FROM op_academy_memberships WHERE login_id='qa-parent' AND profile_id='ONDAP_LANGUAGE_qa-parent'",
      )
      .get(),
  );
  assert.equal(
    db.prepare("SELECT 1 FROM op_sessions WHERE digest='old-session'").get(),
    undefined,
  );
  assert.equal(authenticate(db, 'teacher', previous)?.id, 'unrelated');
  assert.equal(authenticate(db, 'teacher', next), undefined);
  db.exec(
    "UPDATE accounts SET username='renamed-guest',password_hash='!' WHERE id='TA_VISITOR'",
  );
  setupDemoLogins(db, hashes);
  assert.ok(listedDemoLogins(db).some((row) => row[1] === 'renamed-guest'));
  assert.equal(authenticate(db, 'renamed-guest', next), undefined);
});
