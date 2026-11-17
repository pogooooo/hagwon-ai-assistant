import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseQuery } from '../rag-consultation/server/query/parse-query.ts';
import { DEFAULT_RAG_CONFIG } from '../rag-consultation/server/config.ts';
import {
  requestsOperationalSchedule,
  scheduleAuthority,
} from './schedule-authority.ts';

const frame = (question: string) =>
  parseQuery(question, {
    access: {
      actorId: 'visitor',
      academyId: 'A',
      role: 'visitor',
      allowedStudentIds: [],
      allowedClassIds: [],
      studentRefs: [],
      canViewPublicHistory: false,
    },
    catalog: {
      academyId: 'A',
      displayName: '검증 학원',
      aliases: [],
      classes: [],
      units: [],
    },
    config: DEFAULT_RAG_CONFIG,
  });

test('public timing questions retain the full approved document search port', async () => {
  const select = await scheduleAuthority([], []);
  for (const q of [
    '출입증 재발급은 어디서 하고 언제 받아요?',
    '귀가 동행은 언제까지 어디에서 신청하고 어디로 가면 돼요?',
    '교재 택배 토요일에도 찾아갈 수 있나요?',
    '주말 상담 예약은 언제까지 받나요?',
    '책은 몇 권 빌리고 언제 어디로 반납해요?',
    '결석 신청 기한과 방법은?',
    '휴게 공간은 몇 시에 닫나요?',
    '방문 접수는 어떤 요일에 하나요?',
  ]) {
    assert.equal(requestsOperationalSchedule(frame(q)), false, q);
    assert.equal(select(frame(q)), undefined, q);
  }
});

test('lesson times still use authoritative operations evidence and policy remains searchable', async () => {
  const select = await scheduleAuthority([], []);
  for (const q of [
    '수업 언제 해요?',
    '시간표 알려줘',
    '토요일 수업 있나요?',
    '보강은 언제 하나요?',
    '내일 휴강인가요?',
  ]) {
    assert.equal(requestsOperationalSchedule(frame(q)), true, q);
    assert.ok(select(frame(q)), q);
  }
  assert.equal(select(frame('보강 신청 방법과 규정은?')), undefined);
});
