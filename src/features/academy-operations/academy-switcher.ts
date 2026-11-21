import type { OperationsDatabase } from './database.ts';
import { authenticate } from './directory.ts';
import {
  escapeHtml as h,
  field,
  OperationError,
  roleLabels,
  rows,
  type Actor,
  type Role,
} from './shared.ts';

export function setupAcademySelection(db: OperationsDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS op_academy_memberships (
      login_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      PRIMARY KEY(login_id,profile_id), CHECK(login_id <> profile_id)
    );
    CREATE TABLE IF NOT EXISTS op_verified_academies (
      digest TEXT NOT NULL REFERENCES op_sessions(digest) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      PRIMARY KEY(digest,profile_id)
    );
    CREATE TABLE IF NOT EXISTS op_active_academy (
      digest TEXT PRIMARY KEY REFERENCES op_sessions(digest) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE
    );
    CREATE TRIGGER IF NOT EXISTS op_end_academy_access
    AFTER UPDATE OF password_hash, role, student_id, academy_id ON accounts
    WHEN NEW.password_hash IS NOT OLD.password_hash OR NEW.role IS NOT OLD.role
      OR NEW.student_id IS NOT OLD.student_id OR NEW.academy_id IS NOT OLD.academy_id
    BEGIN
      DELETE FROM op_sessions WHERE digest IN
        (SELECT digest FROM op_active_academy WHERE profile_id=OLD.id);
      DELETE FROM op_verified_academies WHERE profile_id=OLD.id;
      DELETE FROM op_academy_memberships WHERE login_id=OLD.id OR profile_id=OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS op_end_removed_academy_membership
    AFTER DELETE ON op_academy_memberships BEGIN
      DELETE FROM op_sessions WHERE account_id=OLD.login_id AND digest IN
        (SELECT digest FROM op_active_academy WHERE profile_id=OLD.profile_id);
    END;
  `);
}

// Memberships belong to the original login. Switching never inherits another profile's memberships.
const sessionAccess = `WITH login AS (
  SELECT account_id, digest FROM op_sessions WHERE digest=? AND expires_at>?
), permitted(id) AS (
  SELECT account_id FROM login
  UNION SELECT profile_id FROM op_academy_memberships JOIN login ON login_id=account_id
  UNION SELECT profile_id FROM op_verified_academies v JOIN login ON v.digest=login.digest
)`;

export function sessionProfile(
  db: OperationsDatabase,
  digest: string,
  now: number,
) {
  return db
    .prepare(
      sessionAccess +
        `
    SELECT id FROM permitted WHERE id=(SELECT COALESCE(a.profile_id, l.account_id)
    FROM login l LEFT JOIN op_active_academy a ON a.digest=l.digest)`,
    )
    .get(digest, now)?.id as string | undefined;
}

interface Choice {
  id: string;
  academy: string;
  role: Role;
}
export function academyChoices(db: OperationsDatabase, digest: string) {
  return rows<Choice>(
    db,
    sessionAccess +
      `
    SELECT a.id, s.name AS academy, a.role FROM permitted p
    JOIN accounts a ON a.id=p.id JOIN academies s ON s.id=a.academy_id
    ORDER BY s.name, a.role, a.id`,
    digest,
    Date.now(),
  );
}

export function renderAcademies(
  db: OperationsDatabase,
  digest: string,
  actor: Actor,
) {
  const choices = academyChoices(db, digest);
  return `<div class="workspace-heading"><h1>내 학원</h1></div><section class="panel academy-picker" aria-label="소속 학원">
    ${choices
      .map(
        (c) => `<form method="post" action="/academies" class="academy-choice">
      <input type="hidden" name="profile" value="${h(c.id)}"><div><strong>${h(c.academy)}</strong><small>${h(roleLabels[c.role])}</small></div>
      <button name="action" value="switch" class="${c.id === actor.id ? 'secondary' : ''}">${c.id === actor.id ? '현재 학원으로 이동' : '선택'}</button></form>`,
      )
      .join('')}</section>
    <details class="panel academy-picker"><summary>다른 학원 계정으로 연결</summary>
      <form method="post" action="/academies"><p>해당 학원에서 발급받은 계정으로 확인하세요. 연결은 로그아웃하면 해제됩니다.</p>
      <label>학원 계정 <input name="username" maxlength="64" autocomplete="off" required></label>
      <label>비밀번호 <input type="password" name="password" maxlength="128" autocomplete="current-password" required></label>
      <button name="action" value="connect">확인하고 학원 열기</button></form></details>`;
}

// The caller runs this together with its session recheck in a transaction.
export function selectAcademy(
  db: OperationsDatabase,
  digest: string,
  actor: Actor,
  form: FormData,
) {
  const action = field(form, 'action');
  let profile: string;
  if (action === 'connect') {
    const password = form.get('password');
    const target =
      typeof password === 'string' &&
      authenticate(db, field(form, 'username', 64), password);
    if (!target)
      throw new OperationError('학원 계정과 비밀번호를 확인해 주세요.', 401);
    if (target.academyId === actor.academyId)
      throw new OperationError('현재 이용 중인 학원입니다.');
    profile = target.id;
    db.prepare(
      'INSERT OR IGNORE INTO op_verified_academies(digest,profile_id) VALUES (?,?)',
    ).run(digest, profile);
  } else if (action === 'switch') {
    profile = field(form, 'profile');
    if (!academyChoices(db, digest).some((c) => c.id === profile))
      throw new OperationError('선택할 수 없는 학원입니다.', 403);
  } else throw new OperationError('학원을 선택해 주세요.');
  db.prepare(
    `INSERT INTO op_active_academy(digest,profile_id) VALUES (?,?)
    ON CONFLICT(digest) DO UPDATE SET profile_id=excluded.profile_id`,
  ).run(digest, profile);
}
