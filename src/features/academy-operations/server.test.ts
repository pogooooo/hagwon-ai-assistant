import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const demoPassword = 'axr-http-test';

async function startOperations(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'axr-operations-test-'));
  const filename = join(directory, 'academy.sqlite');
  const child = spawn(
    process.execPath,
    [
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      fileURLToPath(new URL('./server.ts', import.meta.url)),
    ],
    {
      env: {
        ...process.env,
        AXR_OPERATIONS_DB: filename,
        AXR_OPERATIONS_PORT: '0',
        AXR_OPERATIONS_DEMO_PASSWORD: demoPassword,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let startupOutput = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    startupOutput += chunk;
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'exit');
      child.kill();
      await closed;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const origin = await new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error(startupOutput)));
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
      const address = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0];
      if (address) resolve(address);
    });
  });

  async function send(
    path: string,
    cookie = '',
    fields?: Record<string, string>,
  ) {
    const response = await fetch(origin + path, {
      method: fields ? 'POST' : 'GET',
      body: fields ? new URLSearchParams(fields) : undefined,
      headers: { cookie, origin },
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    return {
      status: response.status,
      headers: response.headers,
      text: await response.text(),
    };
  }

  async function login(username: string, password = demoPassword) {
    const response = await send('/login', '', { username, password });
    assert.equal(response.status, 303);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    return cookie;
  }

  function readDatabase<T>(read: (db: DatabaseSync) => T) {
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  }

  return { origin, send, login, readDatabase, filename };
}

test(
  '요청 본문을 읽는 중 관리자 권한이 회수되면 반을 생성하지 않는다',
  { timeout: 12000 },
  async (t) => {
    const { origin, send, login, readDatabase } = await startOperations(t);
    const administrator = await login('TA_DIRECTOR');
    const account = {
      action: 'account_save',
      name: '임시 관리자',
      username: 'TEMP_ADMIN',
      role: 'admin',
    };
    assert.equal(
      (
        await send('/directory', administrator, {
          ...account,
          password: demoPassword,
        })
      ).status,
      303,
    );
    const affected = await login(account.username);
    const id = readDatabase((db) =>
      String(
        db
          .prepare('SELECT id FROM accounts WHERE username = ?')
          .get(account.username)?.id,
      ),
    );
    const className = '권한 회수 후 생성되면 안 되는 반';
    const body = new URLSearchParams({
      action: 'class_save',
      name: className,
    }).toString();
    const pending = request(origin + '/directory', {
      method: 'POST',
      headers: {
        cookie: affected,
        origin,
        expect: '100-continue',
        'content-length': Buffer.byteLength(body),
        'content-type': 'application/x-www-form-urlencoded',
      },
      signal: AbortSignal.timeout(5000),
    });
    const response = once(pending, 'response');
    // Both promises observe the socket error; this handler also covers early failure.
    void response.catch(() => {});
    const ready = once(pending, 'continue');
    pending.flushHeaders();
    try {
      await ready;
      pending.write(body.slice(0, 8));
      assert.equal(
        (
          await send('/directory', administrator, {
            ...account,
            id,
            role: 'visitor',
          })
        ).status,
        303,
      );
      pending.end(body.slice(8));
      const [denied] = await response;
      assert.equal(denied.statusCode, 401);
      denied.resume();
      assert.equal(
        readDatabase((db) =>
          db.prepare('SELECT 1 FROM classes WHERE name = ?').get(className),
        ),
        undefined,
      );
      assert.equal(
        (await send('/directory', await login(account.username))).status,
        403,
      );
    } finally {
      pending.destroy();
    }
  },
);

test(
  '비밀번호나 역할이 바뀌면 기존 세션으로 다시 쓸 수 없다',
  { timeout: 12000 },
  async (t) => {
    const { send, login } = await startOperations(t);
    const administrator = await login('TA_DIRECTOR');
    const teacher = await login('TA_TEACHER');
    const resetPassword = 'axr-new-test-password';
    const account = {
      action: 'account_save',
      id: 'TA_TEACHER',
      username: 'TA_TEACHER',
      name: '강사',
      role: 'teacher',
    };
    assert.equal(
      (
        await send('/directory', administrator, {
          ...account,
          password: resetPassword,
        })
      ).status,
      303,
    );
    assert.equal(
      (await send('/homework', teacher, { action: 'create' })).status,
      401,
    );
    assert.equal(
      (
        await send('/login', '', {
          username: account.username,
          password: demoPassword,
        })
      ).status,
      401,
    );
    const newSession = await login(account.username, resetPassword);
    assert.equal((await send('/homework', newSession)).status, 200);
    assert.equal(
      (await send('/directory', administrator, { ...account, role: 'admin' }))
        .status,
      303,
    );
    assert.equal(
      (
        await send('/directory', newSession, {
          action: 'class_save',
          name: '이전 강사 세션',
        })
      ).status,
      401,
    );
    assert.equal(
      (await send('/directory', await login(account.username, resetPassword)))
        .status,
      200,
    );
  },
);

test(
  '자료 공개 범위를 줄이면 이미 저장된 상담 답변에서도 근거를 가린다',
  { timeout: 12000 },
  async (t) => {
    const { send, login, readDatabase } = await startOperations(t);
    const administrator = await login('TA_DIRECTOR');
    const visitor = await login('TA_VISITOR');
    const doc = {
      action: 'save',
      title: '공개 범위 변경 테스트',
      documentType: 'fee',
      visibility: 'academy_public',
      text: '# 수강료\n| 반 | 월 수강료 |\n|---|---|\n| 초등 수학반 | 99만원 |',
    };
    assert.equal((await send('/documents', administrator, doc)).status, 303);
    const documentId = readDatabase((db) =>
      String(
        db
          .prepare(
            "SELECT document_id FROM op_document_versions WHERE json_extract(input, '$.title') = ?",
          )
          .get(doc.title)?.document_id,
      ),
    );
    assert.equal(
      (
        await send('/documents', administrator, {
          action: 'approve',
          documentId,
          revision: '1',
        })
      ).status,
      303,
    );
    const id = randomUUID();
    const question = {
      action: 'ask',
      conversationId: id,
      question: '초등 수학반 수강료 얼마예요?',
    };
    assert.equal((await send('/consultation', visitor, question)).status, 303);
    const thread = '/consultation?id=' + id;
    const before = await send(thread, visitor);
    assert.match(before.text, /99만원/);
    assert.match(before.text, /공개 범위 변경 테스트/);
    assert.equal(
      (
        await send('/documents', administrator, {
          ...doc,
          documentId,
          baseRevision: '1',
          visibility: 'student_private',
          studentId: 'TA_STU_001',
        })
      ).status,
      303,
    );
    assert.equal(
      (
        await send('/documents', administrator, {
          action: 'approve',
          documentId,
          revision: '2',
        })
      ).status,
      303,
    );
    const after = await send(thread, visitor);
    assert.equal(after.status, 200);
    assert.doesNotMatch(after.text, /99만원|공개 범위 변경 테스트/);
    assert.match(after.text, /열람 범위가 변경/);
    assert.equal(
      (
        await send(
          '/documents/download?id=' + documentId + '&revision=1',
          visitor,
        )
      ).status,
      404,
    );
  },
);

test(
  '다른 DB 연결의 비밀번호 변경이 커밋되면 대기 중인 이전 비밀번호 로그인도 거부한다',
  { timeout: 15000 },
  async (t) => {
    const { filename, send, login } = await startOperations(t);
    const db = new DatabaseSync(filename);
    const salt = randomBytes(16).toString('hex');
    const replacement = 'axr-rotated-test-password';
    const hash = salt + ':' + scryptSync(replacement, salt, 64).toString('hex');
    let loginDuringReset;
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(
        hash,
        'TA_DIRECTOR',
      );
      loginDuringReset = send('/login', '', {
        username: 'TA_DIRECTOR',
        password: demoPassword,
      });
      await delay(250);
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    const denied = await loginDuringReset;
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('set-cookie'), null);
    assert.equal(
      (await send('/directory', await login('TA_DIRECTOR', replacement)))
        .status,
      200,
    );
  },
);

test(
  '현재 요금과 미리 승인된 다음 달 요금의 답변 및 인용이 구분된다',
  { timeout: 15000 },
  async (t) => {
    const { send, login, readDatabase } = await startOperations(t);
    const administrator = await login('TA_DIRECTOR');
    const visitor = await login('TA_VISITOR');
    const doc = {
      action: 'save',
      title: '정규 수강료 안내',
      documentType: 'fee',
      visibility: 'academy_public',
      text: '# 수강료\n| 반 | 월 수강료 |\n|---|---|\n| 초등 수학반 | 99만원 |',
    };
    assert.equal((await send('/documents', administrator, doc)).status, 303);
    const documentId = readDatabase((db) =>
      String(
        db
          .prepare(
            "SELECT document_id FROM op_document_versions WHERE json_extract(input, '$.title') = ?",
          )
          .get(doc.title)?.document_id,
      ),
    );
    const publish = (revision: string) =>
      send('/documents', administrator, {
        action: 'approve',
        documentId,
        revision,
      });
    assert.equal((await publish('1')).status, 303);
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const nextMonth = new Date(
      Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth() + 1, 1),
    );
    assert.equal(
      (
        await send('/documents', administrator, {
          ...doc,
          documentId,
          baseRevision: '1',
          text: doc.text.replace('99만원', '88만원'),
          validFrom: nextMonth.toISOString().slice(0, 10) + 'T00:00',
        })
      ).status,
      303,
    );
    assert.equal((await publish('2')).status, 303);
    const ask = async (question: string) => {
      const id = randomUUID();
      assert.equal(
        (
          await send('/consultation', visitor, {
            action: 'ask',
            conversationId: id,
            question,
          })
        ).status,
        303,
      );
      return (await send('/consultation?id=' + id, visitor)).text;
    };
    const current = await ask('현재 초등 수학반 수강료 얼마예요?');
    assert.match(current, /99만원/);
    assert.match(current, /· v1<\/li>/);
    assert.doesNotMatch(current, /88만원/);
    const future = await ask(
      `${nextMonth.getUTCFullYear()}년 ${nextMonth.getUTCMonth() + 1}월 초등 수학반 수강료 얼마예요?`,
    );
    assert.match(future, /88만원/);
    assert.match(future, /· v2<\/li>/);
    assert.doesNotMatch(future, /99만원/);
  },
);

test(
  '확정 점수를 정정해도 이전 점수와 정정 사유가 보존된다',
  { timeout: 15000 },
  async (t) => {
    const { send, login, readDatabase } = await startOperations(t);
    const teacher = await login('TA_TEACHER');
    const student = await login('TA_STUDENT_001');
    const guardian = await login('TA_GUARDIAN_E_MATH');
    const assignment = {
      action: 'create',
      classId: 'TA_E_MATH',
      title: '점수 정정 확인',
      dueDate: '2099-12-31',
      questions: '2 + 2? | 4 | 5 | 덧셈',
    };
    assert.equal((await send('/homework', teacher, assignment)).status, 303);
    const { assignmentId, questionId } = readDatabase(
      (db) =>
        db
          .prepare(
            `SELECT a.id AS assignmentId, q.id AS questionId
      FROM homework_assignments a JOIN homework_questions q ON q.assignment_id = a.id
      WHERE a.title = ?`,
          )
          .get(assignment.title) as {
          assignmentId: string;
          questionId: string;
        },
    );
    assert.equal(
      (
        await send('/homework', student, {
          action: 'submit',
          assignmentId,
          ['answer-' + questionId]: '4',
        })
      ).status,
      303,
    );
    const submissionId = readDatabase((db) =>
      String(
        db
          .prepare(
            'SELECT id FROM homework_submissions WHERE assignment_id = ?',
          )
          .get(assignmentId)?.id,
      ),
    );
    const submission = '/homework?submission=' + submissionId;
    const review = {
      action: 'review',
      submissionId,
      ['score-' + questionId]: '5',
    };
    assert.equal(
      (
        await send('/homework', teacher, {
          ...review,
          decision: 'confirm',
          reviewVersion: '0',
        })
      ).status,
      303,
    );
    assert.match((await send(submission, guardian)).text, /5\/5점/);

    const correction = {
      ...review,
      decision: 'correct',
      ['score-' + questionId]: '3',
      reason: '부분 점수 기준 확인',
      reviewVersion: '1',
    };
    assert.equal((await send('/homework', guardian, correction)).status, 403);
    assert.equal(
      (await send('/homework', teacher, { ...correction, reason: '' })).status,
      400,
    );
    assert.equal((await send('/homework', teacher, correction)).status, 303);
    assert.equal((await send('/homework', teacher, correction)).status, 409);
    assert.match((await send(submission, guardian)).text, /3\/5점/);
    assert.match((await send(submission, teacher)).text, /부분 점수 기준 확인/);
    const grades = readDatabase((db) =>
      db
        .prepare(
          'SELECT version, reason, scores FROM homework_grade_revisions WHERE submission_id = ? ORDER BY version',
        )
        .all(submissionId),
    );
    assert.deepEqual(
      grades.map(({ version, reason, scores }) => ({
        version,
        reason,
        points: JSON.parse(String(scores))[0].points,
      })),
      [
        { version: 1, reason: null, points: 5 },
        { version: 2, reason: correction.reason, points: 3 },
      ],
    );
  },
);

test(
  'HTTP 분류 파일 업로드·학생 제출·검수·학습 화면·상담 출처·재분류 철회',
  { timeout: 20000 },
  async (t) => {
    const { origin, send, login, readDatabase } = await startOperations(t);
    const admin = await login('TA_DIRECTOR');
    const student = await login('TA_STUDENT_001');
    const guardian = await login('TA_GUARDIAN_E_MATH');
    const other = await login('TA_GUARDIAN_M2');
    const document = {
      formatVersion: '1.0',
      assignmentId: 'http-classified',
      subject: 'M',
      rubricVersion: '1.0',
      classifiedAt: '2026-11-10T10:00:00+09:00',
      items: [
        {
          itemId: 'a',
          page: 42,
          displayNumber: '1',
          itemStatus: 'classified',
          tags: [
            {
              tagId: 'math-01',
              status: 'adopted',
              evidenceKind: 'text',
              agreement: { same: 3, runs: 3 },
            },
          ],
        },
        {
          itemId: 'b',
          page: 43,
          displayNumber: '1',
          itemStatus: 'classified',
          tags: [
            {
              tagId: 'math-09',
              status: 'adopted',
              evidenceKind: 'text',
              agreement: { same: 3, runs: 3 },
            },
          ],
        },
      ],
    };
    const upload = async (revision: string) => {
      const form = new FormData();
      for (const [k, v] of Object.entries({
        action: 'import',
        classId: 'TA_E_MATH',
        title: 'HTTP 검증 숙제',
        period: '2026-11',
        revision,
      }))
        form.set(k, v);
      form.set(
        'classificationFile',
        new File([JSON.stringify(document)], 'classification.json', {
          type: 'application/json',
        }),
      );
      return fetch(origin + '/learning', {
        method: 'POST',
        body: form,
        headers: { cookie: admin, origin },
        redirect: 'manual',
      });
    };
    assert.equal((await upload('0')).status, 303);
    const common = {
      assignmentId: 'http-classified',
      studentId: 'TA_STU_001',
      classificationRevision: '1',
      reason: 'HTTP 검수',
    };
    assert.equal(
      (
        await send('/learning', student, {
          ...common,
          action: 'results',
          revision: '0',
          wrongItems: '43 | 1',
          complete: 'yes',
        })
      ).status,
      303,
    );
    assert.equal(
      (
        await send('/learning', guardian, {
          ...common,
          action: 'confirm',
          revision: '1',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await send('/learning', admin, {
          ...common,
          action: 'confirm',
          revision: '1',
        })
      ).status,
      303,
    );
    assert.equal(
      readDatabase(
        (db) =>
          db
            .prepare(
              "SELECT COUNT(*) n FROM op_learning_results WHERE state='confirmed'",
            )
            .get()!.n,
      ),
      1,
    );
    const page = await send(
      '/learning?assignment=http-classified&student=TA_STU_001',
      guardian,
    );
    assert.equal(page.status, 200);
    assert.match(page.text, /50\.0%/);
    assert.match(page.text, /참고용/);
    assert.equal(
      (
        await send(
          '/learning?assignment=http-classified&student=TA_STU_001',
          other,
        )
      ).status,
      404,
    );
    const cid = randomUUID();
    assert.equal(
      (
        await send('/consultation', guardian, {
          action: 'ask',
          conversationId: cid,
          question: '11월 전체 정답률 알려줘',
          studentId: 'TA_STU_001',
        })
      ).status,
      303,
    );
    const answer = await send('/consultation?id=' + cid, guardian);
    assert.match(answer.text, /2문항 중 1문항/);
    const source = /href="(\/learning\?publication=[^"]+)"/.exec(
      answer.text,
    )?.[1];
    assert.ok(source);
    assert.equal((await send(source, guardian)).status, 200);
    assert.equal((await send(source, other)).status, 404);
    document.classifiedAt = '2026-11-11T10:00:00+09:00';
    document.items[0].tags[0].tagId = 'math-09';
    assert.equal((await upload('1')).status, 303);
    const stale = await send('/consultation?id=' + cid, guardian);
    assert.match(stale.text, /답변을 표시할 수 없습니다/);
    assert.doesNotMatch(stale.text, /2문항 중 1문항/);
    assert.equal((await send(source, guardian)).status, 404);
  },
);

test('통합 일정 경로와 캐릭터 설정은 로그인·동일 출처와 계정 범위를 지킨다', async (t) => {
  const s = await startOperations(t);
  const parent = await s.login('TA_GUARDIAN_E_MATH');
  for (const old of [
    '/makeup?month=2026-11',
    '/makeup-schedule?month=2026-11',
  ]) {
    const result = await s.send(old, parent);
    assert.equal(result.status, 303);
    assert.equal(result.headers.get('location'), '/schedule?month=2026-11');
  }
  const calendar = await s.send('/schedule?month=2026-11', parent);
  assert.equal(calendar.status, 200);
  assert.match(calendar.text, /calendar-grid/);
  const save = await s.send('/settings', parent, {
    action: 'character',
    character: 'water',
  });
  assert.equal(save.status, 303);
  const own = await s.send('/', parent);
  assert.ok(own.text.includes('/assets/water.png'));
  const admin = await s.login('TA_DIRECTOR');
  const other = await s.send('/', admin);
  assert.ok(other.text.includes('/assets/walnut.png'));
  const image = await fetch(s.origin + '/assets/water.png');
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  const blocked = await fetch(s.origin + '/settings', {
    method: 'POST',
    headers: { cookie: parent, origin: 'https://unrelated.invalid' },
    body: new URLSearchParams({ action: 'character', character: 'owl' }),
    redirect: 'manual',
  });
  assert.equal(blocked.status, 403);
  const probe = await s.send('/settings', parent, { action: 'probe' });
  assert.equal(probe.status, 403);
});
