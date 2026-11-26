'use client';

import { useState } from 'react';

import { createEvent } from '../model/schedule.ts';
import { nowKstIso } from '../model/time.ts';
import type {
  AcademyConfig,
  EventScope,
  ScheduleResult,
  ScheduleState,
} from '../model/types.ts';
import { MakeupFields, type MakeupDraft } from './MakeupFields.tsx';
import { Button, Card, Field, Message, Row, Segmented } from './styles.ts';

interface Props {
  academy: AcademyConfig;
  schedule: ScheduleState;
  apply: (result: ScheduleResult) => ScheduleResult;
}

export function EventForm({ academy, schedule, apply }: Props) {
  const [scope, setScope] = useState<EventScope>('class');
  const [classId, setClassId] = useState(academy.classes[0]?.classId ?? '');
  const [studentId, setStudentId] = useState('');
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [withMakeup, setWithMakeup] = useState(true);
  const [makeup, setMakeup] = useState<MakeupDraft>({
    date: '',
    start: '',
    room: academy.rooms[0] ?? '',
  });
  const [message, setMessage] = useState<{
    tone: 'ok' | 'danger';
    text: string;
  } | null>(null);

  const members = academy.students.filter((s) => s.classIds.includes(classId));
  const selectedStudent = scope === 'student' ? studentId || null : null;

  function submit(confirm: boolean) {
    const result = apply(
      createEvent(
        academy,
        schedule,
        {
          scope,
          classId,
          studentId: selectedStudent,
          date,
          reason,
          makeup: withMakeup && makeup.date && makeup.start ? makeup : null,
          confirm,
        },
        nowKstIso(),
      ),
    );
    if (!result.ok) {
      setMessage({ tone: 'danger', text: result.error });
      return;
    }
    setMessage({
      tone: 'ok',
      text: confirm
        ? `${result.event.eventId} 확정: 안내문 대기 목록과 상담 자료에 반영했습니다.`
        : `${result.event.eventId} 임시 저장: 확정 전에는 안내·상담에 쓰지 않습니다.`,
    });
    setDate('');
    setReason('');
    setMakeup({ date: '', start: '', room: makeup.room });
  }

  return (
    <Card aria-labelledby="form-title">
      <h2 id="form-title">휴강·결석 등록</h2>
      <Segmented role="group" aria-label="등록 유형">
        <button
          type="button"
          aria-pressed={scope === 'class'}
          onClick={() => setScope('class')}
        >
          반 휴강
        </button>
        <button
          type="button"
          aria-pressed={scope === 'student'}
          onClick={() => setScope('student')}
        >
          학생 결석
        </button>
      </Segmented>
      <Row>
        <Field>
          반
          <select
            value={classId}
            onChange={(e) => {
              setClassId(e.target.value);
              setStudentId('');
            }}
          >
            {academy.classes.map((klass) => (
              <option key={klass.classId} value={klass.classId}>
                {klass.name}
              </option>
            ))}
          </select>
        </Field>
        {scope === 'student' && (
          <Field>
            학생
            <select
              value={studentId}
              onChange={(e) => setStudentId(e.target.value)}
            >
              <option value="">선택</option>
              {members.map((student) => (
                <option key={student.studentId} value={student.studentId}>
                  {student.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field>
          {scope === 'class' ? '휴강일' : '결석일'}
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
      </Row>
      <Row>
        <Field>
          사유(내부 기록)
          <input
            value={reason}
            maxLength={60}
            placeholder="예: 원장 연수"
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      </Row>
      <Row>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={withMakeup}
            onChange={(e) => setWithMakeup(e.target.checked)}
          />
          보강 일정도 지금 정하기
        </label>
      </Row>
      {withMakeup && (
        <MakeupFields
          academy={academy}
          schedule={schedule}
          scope={scope}
          classId={classId}
          studentId={selectedStudent}
          after={date}
          value={makeup}
          onChange={setMakeup}
        />
      )}
      {message && <Message $tone={message.tone}>{message.text}</Message>}
      <Row>
        <Button type="button" $variant="primary" onClick={() => submit(true)}>
          확정
        </Button>
        <Button type="button" onClick={() => submit(false)}>
          임시 저장
        </Button>
      </Row>
    </Card>
  );
}
