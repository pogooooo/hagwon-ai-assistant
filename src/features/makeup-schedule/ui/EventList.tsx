'use client';

import { useState } from 'react';

import { classOf, studentOf } from '../model/notice.ts';
import {
  changeMakeup,
  confirmEvent,
  recipientsOf,
  withdrawEvent,
} from '../model/schedule.ts';
import { nowKstIso, shortDate } from '../model/time.ts';
import type {
  AcademyConfig,
  ScheduleEvent,
  ScheduleIssue,
  ScheduleResult,
  ScheduleState,
} from '../model/types.ts';
import { IssueView, MakeupFields, type MakeupDraft } from './MakeupFields.tsx';
import { Badge, Button, Card, Item, Message, Muted, Stack } from './styles.ts';

interface Props {
  academy: AcademyConfig;
  schedule: ScheduleState;
  apply: (result: ScheduleResult) => ScheduleResult;
}

const STATUS = {
  draft: { label: '임시 저장', tone: 'warn' },
  confirmed: { label: '확정', tone: 'ok' },
  withdrawn: { label: '취소됨', tone: 'muted' },
} as const;

export function EventList({ academy, schedule, apply }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<MakeupDraft>({
    date: '',
    start: '',
    room: '',
  });
  const [feedback, setFeedback] = useState<{
    eventId: string;
    tone: 'ok' | 'danger';
    text: string;
    issues: ScheduleIssue[];
  } | null>(null);

  const events = [...schedule.events].sort(
    (a, b) =>
      Number(a.status === 'withdrawn') - Number(b.status === 'withdrawn') ||
      a.date.localeCompare(b.date),
  );

  function run(event: ScheduleEvent, result: ScheduleResult, done: string) {
    const applied = apply(result);
    setFeedback(
      applied.ok
        ? { eventId: event.eventId, tone: 'ok', text: done, issues: [] }
        : {
            eventId: event.eventId,
            tone: 'danger',
            text: applied.error,
            issues: applied.issues,
          },
    );
    if (applied.ok) setEditing(null);
  }

  const now = nowKstIso;

  return (
    <Card aria-labelledby="list-title">
      <h2 id="list-title">휴강·결석 일정</h2>
      {events.length === 0 && <Muted>등록된 일정이 없습니다.</Muted>}
      <Stack>
        {events.map((event) => {
          const klass = classOf(academy, event.classId);
          const status = STATUS[event.status];
          const who =
            event.scope === 'student'
              ? `${studentOf(academy, event.studentId ?? '').name} 결석`
              : `${klass.name} 휴강`;
          return (
            <Item key={event.eventId}>
              <div className="title">
                <span>{event.eventId}</span>
                <span>
                  {shortDate(event.date)} {klass.start}~{klass.end} {who}
                </span>
                <Badge $tone={status.tone}>{status.label}</Badge>
                {event.scope === 'student' && (
                  <Badge $tone="info">학생별</Badge>
                )}
              </div>
              <div className="meta">
                {klass.name} · 안내 대상 {recipientsOf(academy, event).length}명
                {event.reason ? ` · ${event.reason}` : ''}
                {event.revision > 0 ? ` · 상담 자료 r${event.revision}` : ''}
              </div>
              <div className="meta">
                보강:{' '}
                {event.makeup
                  ? `${shortDate(event.makeup.date)} ${event.makeup.start}~${event.makeup.end} ${event.makeup.room}`
                  : '미정'}
              </div>
              {feedback?.eventId === event.eventId && (
                <>
                  <Message $tone={feedback.tone}>{feedback.text}</Message>
                  {feedback.issues.length > 0 && (
                    <IssueView issues={feedback.issues} />
                  )}
                </>
              )}
              {editing === event.eventId && (
                <>
                  <MakeupFields
                    academy={academy}
                    schedule={schedule}
                    scope={event.scope}
                    classId={event.classId}
                    studentId={event.studentId}
                    after={event.date}
                    eventId={event.eventId}
                    value={draft}
                    onChange={setDraft}
                  />
                  <div className="actions">
                    <Button
                      type="button"
                      $variant="primary"
                      disabled={!draft.date || !draft.start}
                      onClick={() =>
                        run(
                          event,
                          changeMakeup(
                            academy,
                            schedule,
                            event.eventId,
                            draft,
                            now(),
                          ),
                          event.status === 'confirmed'
                            ? '보강을 저장하고 안내문·상담 자료를 갱신했습니다.'
                            : '보강을 저장했습니다(임시).',
                        )
                      }
                    >
                      보강 저장
                    </Button>
                    <Button type="button" onClick={() => setEditing(null)}>
                      닫기
                    </Button>
                  </div>
                </>
              )}
              {event.status !== 'withdrawn' && editing !== event.eventId && (
                <div className="actions">
                  {event.status === 'draft' && (
                    <Button
                      type="button"
                      $variant="primary"
                      onClick={() =>
                        run(
                          event,
                          confirmEvent(academy, schedule, event.eventId, now()),
                          '확정했습니다. 안내문 대기 목록과 상담 자료에 반영했습니다.',
                        )
                      }
                    >
                      확정
                    </Button>
                  )}
                  <Button
                    type="button"
                    onClick={() => {
                      setDraft(
                        event.makeup
                          ? {
                              date: event.makeup.date,
                              start: event.makeup.start,
                              room: event.makeup.room,
                            }
                          : {
                              date: '',
                              start: '',
                              room: academy.rooms[0] ?? '',
                            },
                      );
                      setEditing(event.eventId);
                      setFeedback(null);
                    }}
                  >
                    {event.makeup ? '보강 변경' : '보강 지정'}
                  </Button>
                  {event.makeup && (
                    <Button
                      type="button"
                      onClick={() =>
                        run(
                          event,
                          changeMakeup(
                            academy,
                            schedule,
                            event.eventId,
                            null,
                            now(),
                          ),
                          '보강을 취소했습니다.',
                        )
                      }
                    >
                      보강 취소
                    </Button>
                  )}
                  <Button
                    type="button"
                    $variant="danger"
                    onClick={() => {
                      const label =
                        event.scope === 'student' ? '결석 등록' : '휴강';
                      if (
                        window.confirm(
                          `${event.eventId} ${label}을 취소할까요? 보호자 안내가 대기 목록에 추가됩니다.`,
                        )
                      )
                        run(
                          event,
                          withdrawEvent(
                            academy,
                            schedule,
                            event.eventId,
                            now(),
                          ),
                          event.status === 'draft'
                            ? '임시 저장을 지웠습니다.'
                            : '취소했습니다. 상담 자료에서도 빠집니다.',
                        );
                    }}
                  >
                    {event.scope === 'student' ? '결석 취소' : '휴강 취소'}
                  </Button>
                </div>
              )}
            </Item>
          );
        })}
      </Stack>
    </Card>
  );
}
