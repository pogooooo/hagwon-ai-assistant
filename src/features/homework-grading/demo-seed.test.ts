import assert from 'node:assert/strict';
import { test } from 'node:test';
import { homeworkModule } from '../academy-operations/homework.ts';
import { seedDemoHomework } from '../academy-operations/academy-switcher-demo.ts';
import { fixture } from './test-fixtures.ts';
import { listAssignments } from './service.ts';

test('demo worksheets are seeded once as workbook assignments with registered answers', (t) => {
  const f = fixture(t);
  homeworkModule.setup(f.db);
  seedDemoHomework(f.db);
  // 서버를 다시 켜도 같은 과제를 또 만들거나 실패하지 않는다.
  seedDemoHomework(f.db);
  const teacher = f.ctx('TA_TEACHER');
  const demo = listAssignments(teacher).filter(
    (a) => a.title === '분수 계산 복습 활동지' && a.items.length,
  );
  assert.equal(demo.length, 1);
  const [a] = demo;
  assert.equal(a.scope, undefined);
  assert.deepEqual(
    a.items.map((i) => [i.book_page, i.item_no, i.answer_type, i.key?.source]),
    [
      [1, '1', 'numeric', 'teacher_registered'],
      [1, '2', 'numeric', 'teacher_registered'],
      [1, '3', 'numeric', 'teacher_registered'],
      [1, '4', 'numeric', 'teacher_registered'],
      [1, '5', 'numeric', 'teacher_registered'],
    ],
  );
  assert.deepEqual(a.items[4].key?.accepted_units, ['L']);
  assert.equal(a.items[0].skill_label, '계산 · 공식·절차 수행');
  assert.deepEqual(
    f.db
      .prepare(
        `SELECT q.number,q.answer FROM book_questions q JOIN books b ON b.id=q.book_id
          WHERE b.name='온답 수학 활동지' ORDER BY q.number`,
      )
      .all()
      .map((r) => [r.number, r.answer]),
    [
      ['1', '3/4'],
      ['2', '1/2'],
      ['3', '5/6'],
      ['4', '7/12'],
      ['5', '5/6 L'],
    ],
  );
});
