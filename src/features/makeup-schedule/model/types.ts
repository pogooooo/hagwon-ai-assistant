/**
 * 기능 13 휴·보강 일정 관리의 도메인 타입.
 * 클라이언트(관리 화면)와 서버(RAG 반영)가 함께 쓰므로 서버 전용 모듈을 import 하지 않는다.
 */

export interface ClassPeriod {
  effectiveFrom?: string;
  effectiveUntil?: string;
  /** 수업 요일(0=일 … 6=토) */
  days: number[];
  /** HH:MM */
  start: string;
  end: string;
  teacher: string;
  room: string;
}

export interface ClassDefinition extends ClassPeriod {
  classId: string;
  name: string;
  history?: ClassPeriod[];
}

export interface StudentDefinition {
  studentId: string;
  name: string;
  classIds: string[];
}

export interface AcademyConfig {
  academyId: string;
  name: string;
  /** 동시 수용 인원(교습소는 9명 이하) */
  capacity: number;
  /** 교습 종료 시각(지역 조례마다 다르므로 설정값) */
  closeTime: string;
  rooms: string[];
  classes: ClassDefinition[];
  students: StudentDefinition[];
  /** YYYY-MM-DD → 공휴일 이름 */
  holidays: Record<string, string>;
}

/** class: 학원 사정으로 반 전체 휴강 / student: 학생 한 명의 결석 */
export type EventScope = 'class' | 'student';

/** draft: 임시 저장(상담에 쓰지 않음) / confirmed: 원장 확정 / withdrawn: 휴강 취소 */
export type EventStatus = 'draft' | 'confirmed' | 'withdrawn';

export interface MakeupSlot {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM */
  start: string;
  /** HH:MM, 정규 수업 길이로 코드가 계산한다 */
  end: string;
  room: string;
}

export type HistoryAction =
  'created' | 'confirmed' | 'makeup_changed' | 'makeup_cleared' | 'withdrawn';

export interface HistoryEntry {
  /** ISO-8601 */
  at: string;
  action: HistoryAction;
  makeup: MakeupSlot | null;
}

export interface ScheduleEvent {
  eventId: string;
  /** Original lesson details stay stable after a timetable revision. */
  classSnapshot?: ClassDefinition;
  scope: EventScope;
  classId: string;
  /** scope 가 student 일 때만 값이 있다 */
  studentId: string | null;
  /** 휴강일 또는 결석일 */
  date: string;
  reason: string;
  status: EventStatus;
  makeup: MakeupSlot | null;
  /**
   * 상담 자료(RAG) 반영 단위. 확정된 내용이 바뀔 때마다 1씩 오른다.
   * 임시 저장 상태에서는 0이다.
   */
  revision: number;
  /** 마지막으로 확정(또는 확정 내용 변경)된 시각 */
  confirmedAt: string | null;
  updatedAt: string;
  history: HistoryEntry[];
}

export type NoticeKind =
  | '휴강 안내'
  | '결석 보강 안내'
  | '보강 안내'
  | '보강 변경 안내'
  | '보강 취소 안내'
  | '휴강 취소 안내';

export interface OutboxNotice {
  noticeId: string;
  eventId: string;
  kind: NoticeKind;
  text: string;
  recipientStudentIds: string[];
  createdAt: string;
  /** 실제 발송(문자·알림톡)은 외부 계정 연동 전이라 대기 상태로만 둔다 */
  status: 'pending';
}

/** 학생이 보강에 올 수 있는 주간 시간대(학교·다른 학원 일정을 뺀 시간) */
export interface AvailabilityWindow {
  /** 0=일 … 6=토 */
  day: number;
  /** HH:MM */
  start: string;
  end: string;
}

export interface ScheduleState {
  events: ScheduleEvent[];
  outbox: OutboxNotice[];
  seq: number;
  /** 학생 ID → 보강 가능 시간. 없으면 미등록(가능 여부를 모름) */
  availability?: Record<string, AvailabilityWindow[]>;
}

export type IssueType =
  '입력' | '시간' | '정원' | '공휴일' | '강사' | '교실' | '원생' | '가능시간';

/** 보강 후보 시간에 올 수 있는 학생 */
export interface Attendance {
  available: string[];
  unavailable: string[];
  /** 가능 시간을 등록하지 않은 학생 */
  unknown: string[];
}

export interface MakeupSuggestion {
  slot: MakeupSlot;
  attendance: Attendance;
}

export interface ScheduleIssue {
  type: IssueType;
  message: string;
  /** true 면 확정할 수 없다. false 는 확인만 하면 되는 경고(예: 공휴일 보강) */
  blocking: boolean;
}

export type ScheduleResult =
  | { ok: true; state: ScheduleState; event: ScheduleEvent }
  | { ok: false; error: string; issues: ScheduleIssue[] };

export type SessionKind = 'regular' | 'canceled' | 'absent' | 'makeup';

/** 학생별 일정 조회 결과 한 줄 */
export interface StudentSession {
  date: string;
  start: string;
  end: string;
  classId: string;
  className: string;
  kind: SessionKind;
  room: string;
  eventId: string | null;
  /** 휴강·결석인데 보강이 정해지지 않았으면 true */
  makeupPending: boolean;
  /** 보강이면 어느 날짜 수업의 보강인지 */
  makeupFor: string | null;
}
