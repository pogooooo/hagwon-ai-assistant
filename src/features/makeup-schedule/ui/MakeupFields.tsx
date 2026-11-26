'use client';

import { useMemo } from 'react';

import { checkMakeup, suggestMakeups } from '../model/schedule.ts';
import { shortDate } from '../model/time.ts';
import type {
  AcademyConfig,
  EventScope,
  ScheduleIssue,
  ScheduleState,
} from '../model/types.ts';
import { Button, Field, IssueList, Muted, Row } from './styles.ts';

export interface MakeupDraft {
  date: string;
  start: string;
  room: string;
}

interface Props {
  academy: AcademyConfig;
  schedule: ScheduleState;
  scope: EventScope;
  classId: string;
  studentId: string | null;
  /** 휴강·결석일(추천 시작 기준) */
  after: string;
  eventId?: string | null;
  value: MakeupDraft;
  onChange: (value: MakeupDraft) => void;
}

/** 보강 날짜·시각·교실 입력과 즉시 충돌 검사·추천 */
export function MakeupFields({
  academy,
  schedule,
  scope,
  classId,
  studentId,
  after,
  eventId = null,
  value,
  onChange,
}: Props) {
  const ready = !!classId && (scope === 'class' || !!studentId);
  const check = useMemo(
    () =>
      ready && value.date && value.start
        ? checkMakeup(academy, schedule, {
            scope,
            classId,
            studentId,
            ...value,
            eventId,
          })
        : null,
    [academy, schedule, scope, classId, studentId, value, eventId, ready],
  );
  const suggestions = useMemo(
    () =>
      ready && after
        ? suggestMakeups(academy, schedule, {
            scope,
            classId,
            studentId,
            room: value.room,
            after,
            eventId,
          })
        : [],
    [
      academy,
      schedule,
      scope,
      classId,
      studentId,
      value.room,
      after,
      eventId,
      ready,
    ],
  );

  return (
    <>
      <Row>
        <Field>
          보강 날짜
          <input
            type="date"
            value={value.date}
            onChange={(e) => onChange({ ...value, date: e.target.value })}
          />
        </Field>
        <Field>
          시작
          <input
            type="time"
            step={600}
            value={value.start}
            onChange={(e) => onChange({ ...value, start: e.target.value })}
          />
        </Field>
        <Field>
          교실
          <select
            value={value.room}
            onChange={(e) => onChange({ ...value, room: e.target.value })}
          >
            {academy.rooms.map((room) => (
              <option key={room}>{room}</option>
            ))}
          </select>
        </Field>
      </Row>
      {suggestions.length > 0 && (
        <Row>
          <Muted style={{ margin: 0 }}>추천(많이 올 수 있는 순):</Muted>
          {suggestions.map(({ slot, attendance }) => (
            <Button
              key={`${slot.date}${slot.start}`}
              title={`가능 ${attendance.available.length} · 불가 ${attendance.unavailable.length} · 미등록 ${attendance.unknown.length}`}
              type="button"
              onClick={() =>
                onChange({
                  date: slot.date,
                  start: slot.start,
                  room: slot.room,
                })
              }
            >
              {shortDate(slot.date)} {slot.start}
            </Button>
          ))}
        </Row>
      )}
      {check && <IssueView issues={check.issues} end={check.slot?.end} />}
    </>
  );
}

export function IssueView({
  issues,
  end,
}: {
  issues: ScheduleIssue[];
  end?: string;
}) {
  return (
    <IssueList aria-live="polite">
      {issues.length === 0 ? (
        <li data-ok="true">충돌 없음{end ? ` · 종료 ${end}` : ''}</li>
      ) : (
        issues.map((issue, index) => (
          <li key={index} data-blocking={String(issue.blocking)}>
            [{issue.type}] {issue.message}
          </li>
        ))
      )}
    </IssueList>
  );
}

export function hasBlocking(
  academy: AcademyConfig,
  schedule: ScheduleState,
  request: Parameters<typeof checkMakeup>[2],
): boolean {
  return checkMakeup(academy, schedule, request).issues.some((i) => i.blocking);
}
