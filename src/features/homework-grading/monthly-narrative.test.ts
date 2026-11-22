import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  approvedPhotoReports,
  studentReportsModule,
} from '../academy-operations/student-reports.ts';
import { fixture, item } from './test-fixtures.ts';

test('monthly narrative uses confirmed revisions and comparison approval becomes stale when the prior period changes', async (t) => {
  const f = fixture(t);
  studentReportsModule.setup(f.db);
  const classId = 'TA_E_MATH';
  const studentId = 'TA_STU_001';
  const monthly = '2026-11';
  const staff = f.ctx('TA_TEACHER');
  const guardian = f.ctx('TA_GUARDIAN_E_MATH');
  const submit = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return studentReportsModule.submit(staff, data);
  };
  const evaluated = async (date: string, wrong: number, count = 5) => {
    const items = Array.from({ length: count }, (_, i) => {
      const def = item('MATH', {
        item_no: String(i + 1),
        primary_skill_id: 'fraction-addition',
        skill_label: '분수의 덧셈',
      });
      if (i < wrong) f.answers.set(def.item_ref, { answer_observed: '3/4' });
      return def;
    });
    const id = await f.upload(f.register(items), date);
    await f.confirm(id);
  };
  await evaluated('2026-10-10', 3);
  await evaluated('2026-11-10', 1);
  const location = await submit({
    action: 'analyze',
    student: studentId,
    class: classId,
    period: monthly,
  });
  assert.equal(typeof location, 'string');
  const url = new URL(String(location), 'http://localhost');
  const id = url.searchParams.get('id')!;
  const initial = await studentReportsModule.render({ ...staff, url });
  assert.match(initial, /40%p/);
  assert.match(initial, /2026년 10월 2\/5문항 정답 → 이번 기간 4\/5문항 정답/);
  assert.match(initial, /공통분모로 바꾼 식을 한 줄/);
  assert.throws(
    () => studentReportsModule.render({ ...guardian, url }),
    /승인/,
  );
  await submit({ action: 'approve', id, version: '1', reviewed: 'yes' });
  assert.match(
    await studentReportsModule.render({ ...guardian, url }),
    /지난달과 비교/,
  );
  assert.equal(
    approvedPhotoReports(f.db, 'AC_TEST_A', studentId, monthly, classId).length,
    1,
  );
  await evaluated('2026-10-19', 0);
  assert.throws(
    () => studentReportsModule.render({ ...guardian, url }),
    /승인/,
  );
  assert.equal(
    approvedPhotoReports(f.db, 'AC_TEST_A', studentId, monthly, classId).length,
    0,
  );
});
