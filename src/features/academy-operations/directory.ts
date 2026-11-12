import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import {
  escapeHtml,
  field,
  one,
  OperationError,
  required,
  roleLabels,
  rows,
  transaction,
  type Actor,
  type OperationModule,
  type PageContext,
  type Role,
} from './shared.ts';

const ACTOR_COLUMNS =
  'id, academy_id AS academyId, username, name, role, student_id AS studentId';
const FIXTURES = '../makeup-schedule/academies/AC_TEST_A/';
const DEMO_ACADEMY_ID = 'AC_TEST_A';

interface DirectoryStudent {
  id: string;
  name: string;
  classId: string | null;
  classIds: string[];
}

interface DirectoryClass {
  id: string;
  name: string;
  grade: string;
  subject: string;
}

function setup(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS academies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS classes (
      id TEXT PRIMARY KEY,
      academy_id TEXT NOT NULL REFERENCES academies(id),
      name TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      grade TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      academy_id TEXT NOT NULL REFERENCES academies(id),
      class_id TEXT REFERENCES classes(id),
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS student_class_memberships (
      student_id TEXT NOT NULL REFERENCES students(id), class_id TEXT NOT NULL REFERENCES classes(id),
      academy_id TEXT NOT NULL REFERENCES academies(id), is_primary INTEGER NOT NULL DEFAULT 0,
      enrolled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, ended_at TEXT,
      PRIMARY KEY(student_id,class_id));
    CREATE TABLE IF NOT EXISTS student_membership_history (
      id INTEGER PRIMARY KEY, student_id TEXT NOT NULL, class_id TEXT NOT NULL, academy_id TEXT NOT NULL,
      action TEXT NOT NULL, changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT OR IGNORE INTO student_class_memberships(student_id,class_id,academy_id,is_primary)
      SELECT id,class_id,academy_id,1 FROM students WHERE class_id IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS op_primary_enrollment_insert AFTER INSERT ON students WHEN NEW.class_id IS NOT NULL BEGIN
      INSERT INTO student_class_memberships(student_id,class_id,academy_id,is_primary) VALUES(NEW.id,NEW.class_id,NEW.academy_id,1)
        ON CONFLICT(student_id,class_id) DO UPDATE SET is_primary=1,ended_at=NULL;
    END;
    CREATE TRIGGER IF NOT EXISTS op_primary_enrollment_change AFTER UPDATE OF class_id ON students WHEN NEW.class_id IS NOT OLD.class_id BEGIN
      UPDATE student_class_memberships SET ended_at=CURRENT_TIMESTAMP,is_primary=0 WHERE student_id=NEW.id AND is_primary=1;
      INSERT INTO student_class_memberships(student_id,class_id,academy_id,is_primary)
        SELECT NEW.id,NEW.class_id,NEW.academy_id,1 WHERE NEW.class_id IS NOT NULL
        ON CONFLICT(student_id,class_id) DO UPDATE SET is_primary=1,ended_at=NULL;
    END;
    CREATE TRIGGER IF NOT EXISTS op_membership_created AFTER INSERT ON student_class_memberships BEGIN
      INSERT INTO student_membership_history(student_id,class_id,academy_id,action) VALUES(NEW.student_id,NEW.class_id,NEW.academy_id,'enrolled');
    END;
    CREATE TRIGGER IF NOT EXISTS op_membership_changed AFTER UPDATE OF ended_at ON student_class_memberships WHEN NEW.ended_at IS NOT OLD.ended_at BEGIN
      INSERT INTO student_membership_history(student_id,class_id,academy_id,action) VALUES(NEW.student_id,NEW.class_id,NEW.academy_id,CASE WHEN NEW.ended_at IS NULL THEN 'enrolled' ELSE 'ended' END);
    END;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      academy_id TEXT NOT NULL REFERENCES academies(id),
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'teacher', 'student', 'guardian', 'visitor')),
      student_id TEXT REFERENCES students(id),
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS guardian_students (
      guardian_id TEXT NOT NULL REFERENCES accounts(id),
      student_id TEXT NOT NULL REFERENCES students(id),
      PRIMARY KEY (guardian_id, student_id)
    );
    CREATE TABLE IF NOT EXISTS teacher_classes (
      teacher_id TEXT NOT NULL REFERENCES accounts(id),
      class_id TEXT NOT NULL REFERENCES classes(id),
      PRIMARY KEY (teacher_id, class_id)
    );
    CREATE TABLE IF NOT EXISTS op_sessions (
      digest TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS op_sessions_account ON op_sessions (account_id);
    CREATE TRIGGER IF NOT EXISTS op_revoke_sessions_on_account_change
    AFTER UPDATE OF password_hash, role, student_id, academy_id ON accounts
    WHEN NEW.password_hash IS NOT OLD.password_hash
      OR NEW.role IS NOT OLD.role
      OR NEW.student_id IS NOT OLD.student_id
      OR NEW.academy_id IS NOT OLD.academy_id
    BEGIN
      DELETE FROM op_sessions WHERE account_id = OLD.id;
    END;
    CREATE INDEX IF NOT EXISTS classes_academy_idx ON classes (academy_id);
    CREATE INDEX IF NOT EXISTS students_academy_class_idx ON students (academy_id, class_id);
    CREATE INDEX IF NOT EXISTS accounts_academy_idx ON accounts (academy_id);
  `);
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password: string, hash: string): boolean {
  if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(hash)) return false;
  const [salt, key] = hash.split(':');
  return timingSafeEqual(
    scryptSync(password, salt, 64),
    Buffer.from(key, 'hex'),
  );
}

export function getActor(db: DatabaseSync, id: string): Actor | undefined {
  return one<Actor>(
    db,
    'SELECT ' + ACTOR_COLUMNS + ' FROM accounts WHERE id = ?',
    id,
  );
}

export function getSessionActor(
  db: DatabaseSync,
  digest: string,
  now: number,
): Actor | undefined {
  return one<Actor>(
    db,
    `SELECT ${ACTOR_COLUMNS} FROM accounts
     WHERE id = (SELECT account_id FROM op_sessions WHERE digest = ? AND expires_at > ?)`,
    digest,
    now,
  );
}

export function authenticate(
  db: DatabaseSync,
  username: string,
  password: string,
): Actor | undefined {
  if (
    !username.trim() ||
    username.length > 64 ||
    !password ||
    password.length > 128
  )
    return undefined;
  const record = one<{ id: string; passwordHash: string }>(
    db,
    'SELECT id, password_hash AS passwordHash FROM accounts WHERE username = ?',
    username.trim(),
  );
  return record && verifyPassword(password, record.passwordHash)
    ? getActor(db, record.id)
    : undefined;
}

function readFixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(FIXTURES + name + '.json', import.meta.url), 'utf8'),
  ) as T;
}

export function initializeIdentity(
  db: DatabaseSync,
  demoPassword: string,
): void {
  setup(db);
  if (db.prepare('SELECT 1 FROM academies WHERE id = ?').get(DEMO_ACADEMY_ID))
    return;
  const academy = readFixture<{
    academy_id: string;
    display_name: string;
    classes: {
      class_id: string;
      name: string;
      subject: string;
      grade: string;
    }[];
  }>('academy');
  const students =
    readFixture<{ student_id: string; name: string; class_ids: string[] }[]>(
      'students',
    );
  const accounts =
    readFixture<
      { user_id: string; role: Role; allowed_student_ids: string[] }[]
    >('users');
  transaction(db, () => {
    if (db.prepare('SELECT 1 FROM academies WHERE id = ?').get(DEMO_ACADEMY_ID))
      return;
    const createAcademy = db.prepare(
      'INSERT INTO academies (id, name) VALUES (?, ?)',
    );
    const createClass = db.prepare(
      'INSERT INTO classes (id, academy_id, name, subject, grade) VALUES (?, ?, ?, ?, ?)',
    );
    const createStudent = db.prepare(
      'INSERT INTO students (id, academy_id, class_id, name) VALUES (?, ?, ?, ?)',
    );
    const createAccount = db.prepare(
      'INSERT INTO accounts (id, academy_id, username, name, role, student_id, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const addGuardian = db.prepare(
      'INSERT INTO guardian_students (guardian_id, student_id) VALUES (?, ?)',
    );
    const addTeacher = db.prepare(
      'INSERT INTO teacher_classes (teacher_id, class_id) VALUES (?, ?)',
    );
    createAcademy.run(academy.academy_id, academy.display_name);
    for (const group of academy.classes) {
      createClass.run(
        group.class_id,
        academy.academy_id,
        group.name,
        group.subject,
        group.grade,
      );
    }
    for (const student of students) {
      createStudent.run(
        student.student_id,
        academy.academy_id,
        student.class_ids[0] ?? null,
        student.name,
      );
    }
    for (const account of accounts) {
      const name =
        account.role === 'guardian'
          ? students.find(
              ({ student_id }) => student_id === account.allowed_student_ids[0],
            )?.name + ' 보호자'
          : roleLabels[account.role];
      createAccount.run(
        account.user_id,
        academy.academy_id,
        account.user_id,
        name,
        account.role,
        null,
        hashPassword(demoPassword),
      );
      if (account.role === 'guardian') {
        for (const id of account.allowed_student_ids)
          addGuardian.run(account.user_id, id);
      }
    }
    createAccount.run(
      'TA_TEACHER',
      academy.academy_id,
      'TA_TEACHER',
      '가상강사',
      'teacher',
      null,
      hashPassword(demoPassword),
    );
    addTeacher.run('TA_TEACHER', students[0].class_ids[0]);
    createAccount.run(
      'TA_STUDENT_001',
      academy.academy_id,
      'TA_STUDENT_001',
      students[0].name,
      'student',
      students[0].student_id,
      hashPassword(demoPassword),
    );
  });
}

export function accessibleStudents(
  db: DatabaseSync,
  actor: Actor,
): DirectoryStudent[] {
  const selection =
    'SELECT s.id, s.name, s.class_id AS classId FROM students s WHERE s.academy_id = ?';
  const queries: Partial<Record<Role, [string, string]>> = {
    admin: ['', actor.academyId],
    teacher: [
      'AND EXISTS (SELECT 1 FROM teacher_classes t JOIN student_class_memberships m ON m.class_id=t.class_id AND m.student_id=s.id AND m.ended_at IS NULL WHERE t.teacher_id = ?)',
      actor.id,
    ],
    guardian: [
      'AND EXISTS (SELECT 1 FROM guardian_students g WHERE g.guardian_id = ? AND g.student_id = s.id)',
      actor.id,
    ],
    student: ['AND s.id = ?', actor.studentId ?? ''],
  };
  const query = queries[actor.role];
  if (!query) return [];
  const [condition, id] = query;
  const params = condition ? [actor.academyId, id] : [actor.academyId];
  return rows<DirectoryStudent>(
    db,
    selection + ' ' + condition + ' ORDER BY s.name, s.id',
    ...params,
  ).map((student) => ({
    ...student,
    classIds: rows<{ class_id: string }>(
      db,
      'SELECT m.class_id FROM student_class_memberships m WHERE m.student_id=? AND m.academy_id=? AND m.ended_at IS NULL' +
        (actor.role === 'teacher'
          ? ' AND EXISTS (SELECT 1 FROM teacher_classes t WHERE t.class_id=m.class_id AND t.teacher_id=?)'
          : ''),
      student.id,
      actor.academyId,
      ...(actor.role === 'teacher' ? [actor.id] : []),
    ).map((m) => m.class_id),
  }));
}

export function accessibleClasses(
  db: DatabaseSync,
  actor: Actor,
): DirectoryClass[] {
  const selection =
    'SELECT c.id, c.name, c.subject, c.grade FROM classes c WHERE c.academy_id = ?';
  if (actor.role === 'admin')
    return rows<DirectoryClass>(
      db,
      selection + ' ORDER BY c.name, c.id',
      actor.academyId,
    );
  if (actor.role === 'teacher')
    return rows<DirectoryClass>(
      db,
      selection +
        ' AND EXISTS (SELECT 1 FROM teacher_classes t WHERE t.teacher_id = ? AND t.class_id = c.id) ORDER BY c.name, c.id',
      actor.academyId,
      actor.id,
    );
  const ids = new Set(
    accessibleStudents(db, actor).flatMap((student) => student.classIds),
  );
  if (ids.size === 0) return [];
  return rows<DirectoryClass>(
    db,
    selection + ' ORDER BY c.name, c.id',
    actor.academyId,
  ).filter((group) => ids.has(group.id));
}

export function canReadStudent(
  db: DatabaseSync,
  actor: Actor,
  studentId: string,
): boolean {
  return accessibleStudents(db, actor).some(({ id }) => id === studentId);
}

function assertAdmin(actor: Actor): void {
  if (actor.role !== 'admin')
    throw new OperationError('관리자만 계정과 반을 수정할 수 있습니다.', 403);
}

function validateClass(db: DatabaseSync, academyId: string, id: string): void {
  if (
    !db
      .prepare('SELECT 1 FROM classes WHERE id = ? AND academy_id = ?')
      .get(id, academyId)
  )
    throw new OperationError('이 학원에서 반을 찾을 수 없습니다.');
}

function validateStudent(
  db: DatabaseSync,
  academyId: string,
  id: string,
): void {
  if (
    !db
      .prepare('SELECT 1 FROM students WHERE id = ? AND academy_id = ?')
      .get(id, academyId)
  )
    throw new OperationError('이 학원에서 원생을 찾을 수 없습니다.');
}

function saveAccount(ctx: PageContext, form: FormData): void {
  const { db, actor } = ctx;
  const id = field(form, 'id');
  const name = required(form, 'name', '이름', 80);
  const username = required(form, 'username', '사용자 아이디', 64);
  if (!/^[A-Za-z0-9_.-]+$/.test(username))
    throw new OperationError(
      '아이디에는 영문, 숫자, 마침표, 밑줄, 하이픈을 사용할 수 있습니다.',
    );
  const role = field(form, 'role') as Role;
  if (!Object.hasOwn(roleLabels, role))
    throw new OperationError('유효한 계정 역할을 선택하세요.');
  const studentId =
    role === 'student' ? required(form, 'studentId', '연결 원생') : null;
  if (studentId) validateStudent(db, actor.academyId, studentId);

  const existing = id ? getActor(db, id) : undefined;
  if (id && existing?.academyId !== actor.academyId)
    throw new OperationError('이 학원에서 계정을 찾을 수 없습니다.');
  if (id === actor.id && role !== 'admin')
    throw new OperationError(
      '로그인 중인 관리자 계정의 역할은 변경할 수 없습니다.',
    );
  if (
    db
      .prepare('SELECT 1 FROM accounts WHERE username = ? AND id <> ?')
      .get(username, id)
  )
    throw new OperationError('이미 등록된 아이디입니다.');
  const password = form.get('password');
  const changePassword = typeof password === 'string' && password !== '';
  if (
    (!existing || changePassword) &&
    (typeof password !== 'string' ||
      password.length < 8 ||
      password.length > 128)
  )
    throw new OperationError('비밀번호를 8자 이상 128자 이하로 입력하세요.');

  if (!existing && typeof password === 'string') {
    db.prepare(
      'INSERT INTO accounts (id, academy_id, username, name, role, student_id, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      randomUUID(),
      actor.academyId,
      username,
      name,
      role,
      studentId,
      hashPassword(password),
    );
    return;
  }
  db.prepare(
    'UPDATE accounts SET username = ?, name = ?, role = ?, student_id = ? WHERE id = ? AND academy_id = ?',
  ).run(username, name, role, studentId, id, actor.academyId);
  if (changePassword)
    db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(
      hashPassword(password),
      id,
    );
  if (existing?.role === 'guardian' && role !== 'guardian')
    db.prepare('DELETE FROM guardian_students WHERE guardian_id = ?').run(id);
  if (existing?.role === 'teacher' && role !== 'teacher')
    db.prepare('DELETE FROM teacher_classes WHERE teacher_id = ?').run(id);
}

function updateLink(ctx: PageContext, form: FormData, action: string): void {
  const { db, actor } = ctx;
  const account = getActor(db, required(form, 'accountId', '계정'));
  const guardian = action.startsWith('guardian_');
  if (
    account?.academyId !== actor.academyId ||
    account.role !== (guardian ? 'guardian' : 'teacher')
  )
    throw new OperationError('이 학원의 대상 계정을 선택하세요.');
  if (guardian) {
    const studentId = required(form, 'targetId', '원생');
    validateStudent(db, actor.academyId, studentId);
    const statement =
      action === 'guardian_add'
        ? 'INSERT OR IGNORE INTO guardian_students (guardian_id, student_id) VALUES (?, ?)'
        : 'DELETE FROM guardian_students WHERE guardian_id = ? AND student_id = ?';
    db.prepare(statement).run(account.id, studentId);
  } else {
    const classId = required(form, 'targetId', '반');
    validateClass(db, actor.academyId, classId);
    const statement =
      action === 'teacher_add'
        ? 'INSERT OR IGNORE INTO teacher_classes (teacher_id, class_id) VALUES (?, ?)'
        : 'DELETE FROM teacher_classes WHERE teacher_id = ? AND class_id = ?';
    db.prepare(statement).run(account.id, classId);
  }
}

function submit(ctx: PageContext, form: FormData): void {
  const { db, actor } = ctx;
  assertAdmin(actor);
  const action = field(form, 'action');
  switch (action) {
    case 'class_save': {
      const id = field(form, 'id');
      const name = required(form, 'name', '반 이름', 80);
      const subject = field(form, 'subject', 80);
      const grade = field(form, 'grade', 80);
      if (id) {
        validateClass(db, actor.academyId, id);
        const previous = one<{ subject: string }>(
          db,
          'SELECT subject FROM classes WHERE id = ?',
          id,
        );
        if (
          previous?.subject !== subject &&
          one(
            db,
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'op_learning_assignments'",
          ) &&
          one(
            db,
            'SELECT 1 FROM op_learning_assignments WHERE academy_id = ? AND class_id = ? LIMIT 1',
            actor.academyId,
            id,
          )
        )
          throw new OperationError(
            '분류 학습 기록이 있는 반의 과목은 변경할 수 없습니다. 다른 과목은 새 반으로 등록해 주세요.',
            409,
          );
        db.prepare(
          'UPDATE classes SET name = ?, subject = ?, grade = ? WHERE id = ? AND academy_id = ?',
        ).run(name, subject, grade, id, actor.academyId);
      } else {
        db.prepare(
          'INSERT INTO classes (id, academy_id, name, subject, grade) VALUES (?, ?, ?, ?, ?)',
        ).run(randomUUID(), actor.academyId, name, subject, grade);
      }
      break;
    }
    case 'student_save': {
      let id = field(form, 'id');
      const name = required(form, 'name', '원생 이름', 80);
      const classId = field(form, 'classId') || null;
      if (classId) validateClass(db, actor.academyId, classId);
      const extra = form.getAll('extraClasses').map(String);
      if (extra.length > 100)
        throw new OperationError('수강 반을 확인해 주세요.', 422);
      for (const classId of extra) validateClass(db, actor.academyId, classId);
      ctx.assertCurrentAccess?.();
      if (id) {
        validateStudent(db, actor.academyId, id);
        db.prepare(
          'UPDATE students SET name = ?, class_id = ? WHERE id = ? AND academy_id = ?',
        ).run(name, classId, id, actor.academyId);
      } else {
        db.prepare(
          'INSERT INTO students (id, academy_id, class_id, name) VALUES (?, ?, ?, ?)',
        ).run((id = randomUUID()), actor.academyId, classId, name);
      }
      if (field(form, 'membershipsPresent') === 'yes') {
        db.prepare(
          'UPDATE student_class_memberships SET ended_at=CURRENT_TIMESTAMP WHERE student_id=? AND is_primary=0 AND ended_at IS NULL',
        ).run(id);
        for (const extraId of new Set(extra.filter((x) => x !== classId)))
          db.prepare(
            'INSERT INTO student_class_memberships(student_id,class_id,academy_id,is_primary) VALUES(?,?,?,0) ON CONFLICT(student_id,class_id) DO UPDATE SET ended_at=NULL,is_primary=0',
          ).run(id, extraId, actor.academyId);
      }
      break;
    }
    case 'account_save':
      saveAccount(ctx, form);
      break;
    case 'guardian_add':
    case 'guardian_remove':
    case 'teacher_add':
    case 'teacher_remove':
      updateLink(ctx, form, action);
      break;
    default:
      throw new OperationError('지원하지 않는 관리 요청입니다.');
  }
}

function options(
  values: readonly { id: string; name: string }[],
  selected = '',
): string {
  return values
    .map(
      ({ id, name }) =>
        '<option value="' +
        escapeHtml(id) +
        '"' +
        (id === selected ? ' selected' : '') +
        '>' +
        escapeHtml(name) +
        '</option>',
    )
    .join('');
}

function form(action: string, id: string, fields: string): string {
  return `<form method="post"><input type="hidden" name="action" value="${action}"><input type="hidden" name="id" value="${escapeHtml(id)}"><div class="fields">${fields}</div><div class="actions"><button type="submit">${id ? '변경 저장' : '추가'}</button></div></form>`;
}

function classForm(group?: DirectoryClass): string {
  return form(
    'class_save',
    group?.id ?? '',
    `<label>반 이름<input name="name" value="${escapeHtml(group?.name ?? '')}" maxlength="80" required></label>
     <label>과목<input name="subject" value="${escapeHtml(group?.subject ?? '')}" maxlength="80"></label>
     <label>학년<input name="grade" value="${escapeHtml(group?.grade ?? '')}" maxlength="80"></label>`,
  );
}

function studentForm(
  classes: DirectoryClass[],
  student?: DirectoryStudent,
): string {
  return form(
    'student_save',
    student?.id ?? '',
    `<label>원생 이름<input name="name" value="${escapeHtml(student?.name ?? '')}" maxlength="80" required></label>
     <label>주 소속 반<select name="classId"><option value="">미배정</option>${options(classes, student?.classId ?? '')}</select></label><input type="hidden" name="membershipsPresent" value="yes"><fieldset><legend>추가 수강 반</legend>${classes.map((c) => `<label class="check-label"><input type="checkbox" name="extraClasses" value="${escapeHtml(c.id)}"${student?.classIds.includes(c.id) && student?.classId !== c.id ? ' checked' : ''}>${escapeHtml(c.name)}</label>`).join('')}</fieldset>`,
  );
}

function accountForm(students: DirectoryStudent[], account?: Actor): string {
  const roles = Object.entries(roleLabels).map(([id, name]) => ({ id, name }));
  return form(
    'account_save',
    account?.id ?? '',
    `<label>표시 이름<input name="name" value="${escapeHtml(account?.name ?? '')}" maxlength="80" required></label>
     <label>아이디<input name="username" value="${escapeHtml(account?.username ?? '')}" maxlength="64" required autocomplete="off"></label>
     <label>역할<select name="role">${options(roles, account?.role ?? 'visitor')}</select></label>
     <label>원생 계정 연결<select name="studentId"><option value="">연결 없음</option>${options(students, account?.studentId ?? '')}</select></label>
     <label>${account ? '새 비밀번호 (변경 시 입력)' : '비밀번호'}<input type="password" name="password" minlength="8" maxlength="128" autocomplete="new-password"${account ? '' : ' required'}></label>`,
  );
}

interface Link {
  accountId: string;
  accountName: string;
  targetId: string;
  targetName: string;
}

function linkPanel(
  type: 'guardian' | 'teacher',
  accounts: Actor[],
  targets: readonly { id: string; name: string }[],
  links: Link[],
): string {
  const guardian = type === 'guardian';
  const title = guardian ? '보호자와 원생 연결' : '강사 담당 반 연결';
  const accountLabel = guardian ? '보호자' : '강사';
  const targetLabel = guardian ? '원생' : '반';
  return `<section class="panel"><h2>${title}</h2>
    ${
      accounts.length && targets.length
        ? `<form method="post"><input type="hidden" name="action" value="${type}_add">
    <div class="fields"><label>${accountLabel}<select name="accountId" required>${options(accounts)}</select></label>
    <label>${targetLabel}<select name="targetId" required>${options(targets)}</select></label></div>
    <div class="actions"><button type="submit">연결 추가</button></div></form>`
        : '<p>연결할 계정과 대상이 필요합니다.</p>'
    }
    ${
      links.length
        ? `<div class="table-wrap"><table><thead><tr><th>${accountLabel}</th><th>${targetLabel}</th><th>관리</th></tr></thead><tbody>
    ${links
      .map(
        (
          link,
        ) => `<tr><td>${escapeHtml(link.accountName)}</td><td>${escapeHtml(link.targetName)}</td><td>
      <form method="post"><input type="hidden" name="action" value="${type}_remove"><input type="hidden" name="accountId" value="${escapeHtml(link.accountId)}"><input type="hidden" name="targetId" value="${escapeHtml(link.targetId)}"><button type="submit">연결 해제</button></form>
    </td></tr>`,
      )
      .join('')}</tbody></table></div>`
        : '<p>등록된 연결이 없습니다.</p>'
    }</section>`;
}

function render({ db, actor }: PageContext): string {
  assertAdmin(actor);
  const classes = accessibleClasses(db, actor);
  const students = accessibleStudents(db, actor);
  const accounts = db
    .prepare(
      'SELECT ' +
        ACTOR_COLUMNS +
        ' FROM accounts WHERE academy_id = ? ORDER BY name, id',
    )
    .all(actor.academyId) as unknown as Actor[];
  const guardians = db
    .prepare(
      `
    SELECT a.id AS accountId, a.name AS accountName, s.id AS targetId, s.name AS targetName
    FROM guardian_students g JOIN accounts a ON a.id = g.guardian_id
    JOIN students s ON s.id = g.student_id AND s.academy_id = a.academy_id
    WHERE a.academy_id = ? AND a.role = 'guardian' ORDER BY a.name, s.name
  `,
    )
    .all(actor.academyId) as unknown as Link[];
  const teachers = db
    .prepare(
      `
    SELECT a.id AS accountId, a.name AS accountName, c.id AS targetId, c.name AS targetName
    FROM teacher_classes t JOIN accounts a ON a.id = t.teacher_id
    JOIN classes c ON c.id = t.class_id AND c.academy_id = a.academy_id
    WHERE a.academy_id = ? AND a.role = 'teacher' ORDER BY a.name, c.name
  `,
    )
    .all(actor.academyId) as unknown as Link[];

  return `<div class="split"><section class="panel"><h2>반 관리</h2>
    ${classForm()}${classes.map((group) => `<details><summary>${escapeHtml(group.name)}</summary>${classForm(group)}</details>`).join('')}</section>
    <section class="panel"><h2>원생 관리</h2>
    ${studentForm(classes)}${students.map((student) => `<details><summary>${escapeHtml(student.name)}</summary>${studentForm(classes, student)}</details>`).join('')}</section></div>
    <section class="panel"><h2>계정 관리</h2>
    ${accountForm(students)}${accounts.map((account) => `<details><summary>${escapeHtml(account.name)} · ${escapeHtml(account.username)} · ${roleLabels[account.role]}</summary>${accountForm(students, account)}</details>`).join('')}</section>
    <div class="split">${linkPanel(
      'guardian',
      accounts.filter(({ role }) => role === 'guardian'),
      students,
      guardians,
    )}
    ${linkPanel(
      'teacher',
      accounts.filter(({ role }) => role === 'teacher'),
      classes,
      teachers,
    )}</div>`;
}

export const directoryModule: OperationModule = {
  path: '/directory',
  label: '원생·반·계정',
  roles: ['admin'],
  setup,
  render,
  submit(ctx, form) {
    transaction(ctx.db, () => {
      ctx.assertCurrentAccess?.();
      submit(ctx, form);
    });
  },
};
