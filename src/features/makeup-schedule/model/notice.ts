/**
 * 안내문과 상담 자료(RAG) 본문. 날짜·시간·반은 저장값만 쓰고 LLM 이 만들지 않는다.
 */
import { eventClass } from './timetable.ts';
import { longDate } from './time.ts';
import type {
  AcademyConfig,
  ClassDefinition,
  NoticeKind,
  ScheduleEvent,
  StudentDefinition,
} from './types.ts';

export function classOf(
  academy: AcademyConfig,
  classId: string,
): ClassDefinition {
  const found = academy.classes.find((klass) => klass.classId === classId);
  if (!found) throw new Error(`알 수 없는 반: ${classId}`);
  return found;
}

export function studentOf(
  academy: AcademyConfig,
  studentId: string,
): StudentDefinition {
  const found = academy.students.find(
    (student) => student.studentId === studentId,
  );
  if (!found) throw new Error(`알 수 없는 원생: ${studentId}`);
  return found;
}

/** 휴강·결석 대상 수업의 정규 시간(예: 18:00~19:50) */
export function originalTime(
  academy: AcademyConfig,
  event: ScheduleEvent,
): string {
  const klass = eventClass(academy, event);
  return `${klass.start}~${klass.end}`;
}

export function makeupTime(event: ScheduleEvent): string | null {
  return event.makeup ? `${event.makeup.start}~${event.makeup.end}` : null;
}

/** 보호자에게 보낼 안내문 */
export function noticeText(
  academy: AcademyConfig,
  event: ScheduleEvent,
  kind: NoticeKind,
): string {
  const klass = eventClass(academy, event);
  const original = `${longDate(event.date)} ${originalTime(academy, event)}`;
  const lines = [`[${academy.name}] ${klass.name} 안내`];
  if (event.scope === 'student') {
    const student = studentOf(academy, event.studentId ?? '');
    if (kind === '휴강 취소 안내') {
      lines.push(
        `${student.name} 학생의 ${original} 결석 보강 일정이 취소되었습니다.`,
      );
      return lines.join('\n');
    }
    lines.push(`${student.name} 학생의 ${original} 결석 수업 보강 안내입니다.`);
  } else if (kind === '휴강 취소 안내') {
    lines.push(`${original} 휴강이 취소되어 수업이 정상 진행됩니다.`);
    return lines.join('\n');
  } else {
    lines.push(`${original} 수업은 휴강입니다.`);
  }
  if (event.makeup) {
    const changed = kind === '보강 변경 안내' ? '(변경) ' : '';
    lines.push(
      `${changed}보강: ${longDate(event.makeup.date)} ${makeupTime(event)}, ${event.makeup.room}`,
    );
  } else if (kind === '보강 취소 안내') {
    lines.push(
      '안내드린 보강은 취소되었습니다. 새 일정은 정해지는 대로 다시 안내드리겠습니다.',
    );
  } else {
    lines.push('보강 일정은 정해지는 대로 다시 안내드리겠습니다.');
  }
  return lines.join('\n');
}

/** RAG 문서 하나와 그 문서에서 그대로 확인되는 휴보강 사실 */
export interface RagScheduleDocument {
  documentId: string;
  role: 'cancel' | 'makeup';
  title: string;
  text: string;
  classId: string;
  studentId: string | null;
  fact: {
    changeType: 'cancel' | 'makeup';
    date: string;
    time: string;
    /** 본문에 그대로 있는 구절(사실↔원문 대조용) */
    text: string;
  };
}

export function documentIdOf(
  academy: AcademyConfig,
  event: ScheduleEvent,
  role: 'cancel' | 'makeup',
): string {
  const key = event.eventId.replace(/[^A-Za-z0-9]/g, '');
  const suffix =
    role === 'makeup'
      ? 'MAKEUP'
      : event.scope === 'student'
        ? 'ABSENCE'
        : 'CANCEL';
  return `${academy.academyId}_${key}_${suffix}`;
}

/**
 * 확정된 일정 1건 → 상담 자료 문서(휴강·결석 문서 + 보강 문서).
 * 확정 전·취소된 일정은 문서를 만들지 않는다.
 */
export function ragDocumentsOf(
  academy: AcademyConfig,
  event: ScheduleEvent,
): RagScheduleDocument[] {
  if (event.status !== 'confirmed') return [];
  const klass = eventClass(academy, event);
  const original = `${longDate(event.date)} ${originalTime(academy, event)}`;
  const makeup = event.makeup;
  const makeupLine = makeup
    ? `${longDate(makeup.date)} ${makeupTime(event)}`
    : null;
  const docs: RagScheduleDocument[] = [];

  if (event.scope === 'student') {
    const student = studentOf(academy, event.studentId ?? '');
    const absence = `${original} ${klass.name} 수업에 결석했습니다`;
    docs.push({
      documentId: documentIdOf(academy, event, 'cancel'),
      role: 'cancel',
      title: `${academy.name} ${student.name} ${klass.name} ${longDate(event.date)} 결석`,
      text: [
        `${academy.name} ${student.name} 학생은 ${absence}.`,
        makeupLine
          ? `이 결석의 보강은 ${makeupLine}으로 확정되었습니다.`
          : '이 결석의 보강 일정은 아직 확정되지 않았습니다. 보강 일정 문의는 담당자에게 연결합니다.',
      ].join(' '),
      classId: klass.classId,
      studentId: student.studentId,
      fact: {
        changeType: 'cancel',
        date: event.date,
        time: originalTime(academy, event),
        text: absence,
      },
    });
    if (makeup && makeupLine) {
      const sentence = `${student.name} 학생의 ${klass.name} 결석 보강은 ${makeupLine}입니다`;
      docs.push({
        documentId: documentIdOf(academy, event, 'makeup'),
        role: 'makeup',
        title: `${academy.name} ${student.name} ${klass.name} ${longDate(makeup.date)} 보강`,
        text: `${academy.name} ${sentence}. ${longDate(event.date)} 결석에 대한 보강이며 장소는 ${makeup.room}입니다.`,
        classId: klass.classId,
        studentId: student.studentId,
        fact: {
          changeType: 'makeup',
          date: makeup.date,
          time: makeupTime(event) ?? '',
          text: sentence,
        },
      });
    }
    return docs;
  }

  docs.push({
    documentId: documentIdOf(academy, event, 'cancel'),
    role: 'cancel',
    title: `${academy.name} ${klass.name} ${longDate(event.date)} 휴강 안내`,
    text: [
      `${academy.name} ${klass.name}은 ${original} 수업이 휴강입니다.`,
      makeupLine
        ? `이 휴강의 보강은 ${makeupLine}으로 확정되었습니다.`
        : '이 휴강의 보강 일정은 아직 확정되지 않았습니다. 보강 일정 문의는 담당자에게 연결합니다.',
    ].join(' '),
    classId: klass.classId,
    studentId: null,
    fact: {
      changeType: 'cancel',
      date: event.date,
      time: originalTime(academy, event),
      text: '수업이 휴강입니다',
    },
  });
  if (makeup && makeupLine) {
    const sentence = `${klass.name} 보강은 ${makeupLine}입니다`;
    docs.push({
      documentId: documentIdOf(academy, event, 'makeup'),
      role: 'makeup',
      title: `${academy.name} ${klass.name} ${longDate(makeup.date)} 보강 안내`,
      text: `${academy.name} ${sentence}. ${longDate(event.date)} 휴강에 대한 보강이며 장소는 ${makeup.room}입니다.`,
      classId: klass.classId,
      studentId: null,
      fact: {
        changeType: 'makeup',
        date: makeup.date,
        time: makeupTime(event) ?? '',
        text: `${longDate(event.date)} 휴강에 대한 보강`,
      },
    });
  }
  return docs;
}
