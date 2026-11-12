'use client';

import { useMemo, useState } from 'react';

import { ragDocumentsOf, studentOf } from '../model/notice.ts';
import { studentSchedule } from '../model/schedule.ts';
import { addDays, isDate, shortDate } from '../model/time.ts';
import type {
  AcademyConfig,
  ScheduleState,
  SessionKind,
} from '../model/types.ts';
import {
  Badge,
  Card,
  Field,
  Item,
  Muted,
  Pre,
  Row,
  Stack,
  Table,
  TableWrap,
} from './styles.ts';

const KIND: Record<
  SessionKind,
  { label: string; tone: 'muted' | 'danger' | 'warn' | 'info' }
> = {
  regular: { label: '정규', tone: 'muted' },
  canceled: { label: '휴강', tone: 'danger' },
  absent: { label: '결석', tone: 'warn' },
  makeup: { label: '보강', tone: 'info' },
};

export function StudentSchedulePanel({
  academy,
  schedule,
  defaultFrom,
}: {
  academy: AcademyConfig;
  schedule: ScheduleState;
  defaultFrom: string;
}) {
  const [studentId, setStudentId] = useState(
    academy.students[0]?.studentId ?? '',
  );
  const [from, setFrom] = useState(defaultFrom);
  const to = isDate(from) ? addDays(from, 20) : from;
  const sessions = useMemo(
    () =>
      studentId && isDate(from)
        ? studentSchedule(academy, schedule, studentId, from, to)
        : [],
    [academy, schedule, studentId, from, to],
  );

  return (
    <Card aria-labelledby="student-title">
      <h2 id="student-title">학생별 일정 조회</h2>
      <Row>
        <Field>
          학생
          <select
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
          >
            {academy.students.map((student) => (
              <option key={student.studentId} value={student.studentId}>
                {student.name} ({student.classIds.length}개 반)
              </option>
            ))}
          </select>
        </Field>
        <Field>
          시작일(3주)
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
      </Row>
      <Muted>
        확정된 일정만 보입니다. 보호자 상담 답변도 같은 일정을 씁니다.
      </Muted>
      <TableWrap>
        <Table>
          <thead>
            <tr>
              <th>날짜</th>
              <th>시간</th>
              <th>반</th>
              <th>구분</th>
              <th>비고</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s, index) => (
              <tr key={`${s.date}${s.start}${s.classId}${index}`}>
                <td>{shortDate(s.date)}</td>
                <td>
                  {s.start}~{s.end}
                </td>
                <td>{s.className}</td>
                <td>
                  <Badge $tone={KIND[s.kind].tone}>{KIND[s.kind].label}</Badge>
                </td>
                <td>
                  {s.makeupFor
                    ? `${shortDate(s.makeupFor)} 보강 · ${s.room}`
                    : s.makeupPending
                      ? '보강 미정'
                      : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
      {sessions.length === 0 && <Muted>기간 안에 수업이 없습니다.</Muted>}
    </Card>
  );
}

export function OutboxPanel({
  academy,
  schedule,
}: {
  academy: AcademyConfig;
  schedule: ScheduleState;
}) {
  return (
    <Card aria-labelledby="outbox-title">
      <h2 id="outbox-title">안내문 발송 대기</h2>
      <Muted>
        문자·알림톡 발송은 외부 계정 연동 전이라 대기 목록까지만 만듭니다.
      </Muted>
      {schedule.outbox.length === 0 && (
        <Muted>대기 중인 안내문이 없습니다.</Muted>
      )}
      <Stack>
        {schedule.outbox.slice(0, 8).map((notice) => (
          <Item key={notice.noticeId}>
            <div className="title">
              <Badge $tone="info">{notice.kind}</Badge>
              <span className="meta">
                {notice.eventId} · 대상 {notice.recipientStudentIds.length}명(
                {notice.recipientStudentIds
                  .slice(0, 3)
                  .map((id) => studentOf(academy, id).name)
                  .join(', ')}
                {notice.recipientStudentIds.length > 3 ? ' 외' : ''})
              </span>
            </div>
            <Pre>{notice.text}</Pre>
          </Item>
        ))}
      </Stack>
    </Card>
  );
}

export function RagPreviewPanel({
  academy,
  schedule,
}: {
  academy: AcademyConfig;
  schedule: ScheduleState;
}) {
  const docs = schedule.events.flatMap((event) =>
    ragDocumentsOf(academy, event).map((doc) => ({ doc, event })),
  );
  return (
    <Card aria-labelledby="rag-title">
      <h2 id="rag-title">상담 자료(RAG) 반영 내용</h2>
      <Muted>
        확정된 일정만 들어갑니다. 바뀌면 같은 문서의 revision 이 올라 이전
        일정은 답변에 쓰이지 않습니다.
      </Muted>
      {docs.length === 0 && <Muted>반영된 문서가 없습니다.</Muted>}
      <Stack>
        {docs.map(({ doc, event }) => (
          <Item key={doc.documentId}>
            <div className="title">
              <span>{doc.documentId}</span>
              <Badge>r{event.revision}</Badge>
              <Badge $tone={doc.studentId ? 'warn' : 'info'}>
                {doc.studentId ? '해당 학생만' : '반 원생만'}
              </Badge>
            </div>
            <Pre>{doc.text}</Pre>
          </Item>
        ))}
      </Stack>
    </Card>
  );
}
