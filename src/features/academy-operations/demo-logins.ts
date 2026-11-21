import type { OperationsDatabase } from './database.ts';
import { one, transaction } from './shared.ts';

const slots = [
  ['원장', 'admin', 'TA_DIRECTOR', 'AXR_CHECK_ADMIN_20261119', 'admin'],
  ['강사', 'teacher', 'TA_TEACHER', 'AXR_CHECK_TEACHER_20261119', 'teacher'],
  [
    '학생',
    'student',
    'TA_STUDENT_001',
    'AXR_CHECK_STUDENT_20261119',
    'student',
  ],
  [
    '학부모',
    'parent',
    'TA_GUARDIAN_E_MATH',
    'AXR_CHECK_GUARDIAN_20261119',
    'guardian',
  ],
  ['방문자', 'guest', 'TA_VISITOR', '', 'visitor'],
] as const;
const academy = 'AC_TEST_A';

export function setupDemoLogins(db: OperationsDatabase, encoded?: string) {
  db.exec(`CREATE TABLE IF NOT EXISTS op_demo_logins_v1 (
    slot TEXT PRIMARY KEY, account_id TEXT UNIQUE REFERENCES accounts(id) ON DELETE SET NULL)`);
  if (!encoded || db.prepare('SELECT 1 FROM op_demo_logins_v1 LIMIT 1').get())
    return;
  if (
    !db
      .prepare('SELECT 1 FROM academies WHERE id=? AND name=?')
      .get(academy, '[가상] 테스트 교습소')
  )
    return;
  const hashes: Record<string, string> = JSON.parse(encoded);
  if (
    !slots.every(
      ([, slot]) =>
        typeof hashes?.[slot] === 'string' &&
        /^[a-f0-9]{32}:[a-f0-9]{128}$/.test(hashes[slot]),
    )
  )
    throw new Error('Invalid test account password hashes.');
  transaction(db, () => {
    if (db.prepare('SELECT 1 FROM op_demo_logins_v1 LIMIT 1').get()) return;
    for (const [, slot, base, qa, role] of slots) {
      // Select the hosted acceptance profile only when it already owns its synthetic second-school membership.
      const user = one<{ id: string }>(
        db,
        `SELECT a.id FROM accounts a WHERE a.academy_id=? AND a.role=?
        AND (a.id=? OR (a.username=? AND EXISTS(SELECT 1 FROM op_academy_memberships m
          JOIN accounts p ON p.id=m.profile_id WHERE m.login_id=a.id AND p.role=a.role
            AND p.academy_id='AC_ONDAP_LANGUAGE_DEMO' AND p.id='ONDAP_LANGUAGE_'||a.id)))
        ORDER BY (a.id=?) LIMIT 1`,
        academy,
        role,
        base,
        qa,
        base,
      );
      if (!user) continue;
      const companion = 'ONDAP_LANGUAGE_' + user.id;
      if (
        db
          .prepare(
            `SELECT 1 FROM op_academy_memberships WHERE profile_id=? OR
         (login_id=? AND profile_id<>?) LIMIT 1`,
          )
          .get(user.id, user.id, companion)
      )
        continue;
      const member = db
        .prepare(
          `SELECT 1 FROM op_academy_memberships m JOIN accounts p ON p.id=m.profile_id
        WHERE login_id=? AND profile_id=? AND p.academy_id='AC_ONDAP_LANGUAGE_DEMO' AND p.role=?`,
        )
        .get(user.id, companion, role);
      let username = slot as string;
      for (
        let suffix = 1;
        db
          .prepare('SELECT 1 FROM accounts WHERE username=? AND id<>?')
          .get(username, user.id);
        suffix++
      )
        username = slot + suffix;
      db.prepare(
        'UPDATE accounts SET username=?,password_hash=? WHERE id=? AND academy_id=?',
      ).run(username, hashes[slot], user.id, academy);
      // A password reset invalidates all sessions. Restore only the pre-existing demo enrollment.
      if (member)
        db.prepare(
          'INSERT INTO op_academy_memberships(login_id,profile_id) VALUES (?,?)',
        ).run(user.id, companion);
      db.prepare(
        'INSERT INTO op_demo_logins_v1(slot,account_id) VALUES (?,?)',
      ).run(slot, user.id);
    }
  });
}

export function listedDemoLogins(db: OperationsDatabase) {
  return slots.flatMap(([label, slot, base, , role]) => {
    const record = one<{ username: string }>(
      db,
      `SELECT username FROM accounts WHERE id=
      COALESCE((SELECT account_id FROM op_demo_logins_v1 WHERE slot=?),?) AND academy_id=? AND role=?`,
      slot,
      base,
      academy,
      role,
    );
    return record ? [[label, record.username]] : [];
  });
}
