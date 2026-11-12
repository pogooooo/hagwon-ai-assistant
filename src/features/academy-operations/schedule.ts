import { randomUUID } from 'node:crypto';
import {
  checkNoticeAgainstTeam,
  assertTeacherFree,
} from './schedule-conflicts.ts';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ApprovedFactInput,
  SourceDocumentInput,
} from '../rag-consultation/server/index.ts';
import { formatKstDate } from '../rag-consultation/server/text/time.ts';
import {
  accessibleClasses,
  accessibleStudents,
  canReadStudent,
} from './directory.ts';
import {
  escapeHtml as esc,
  field,
  one,
  OperationError,
  required,
  rows,
  transaction,
  type Actor,
  type OperationModule,
  type PageContext,
} from './shared.ts';

type Makeup = 'pending' | 'scheduled' | 'none';

interface Notice {
  id: string;
  class_id: string | null;
  class_name: string | null;
  title: string;
  closure_start: number;
  closure_end: number;
  makeup_kind: Makeup;
  makeup_start: number | null;
  makeup_end: number | null;
  revision: number;
  approved_at: number;
}

interface Slot {
  id: string;
  staff_id: string;
  staff_name: string;
  starts_at: number;
  ends_at: number;
  reserved: number;
}

interface Booking {
  id: string;
  staff_id: string;
  staff_name: string;
  student_id: string;
  student_name: string;
  starts_at: number;
  ends_at: number;
  cancelled_at: number | null;
}

const kstOffset = 9 * 60 * 60 * 1000;

function localDateTime(value: number | null | undefined): string {
  return value == null
    ? ''
    : new Date(value + kstOffset).toISOString().slice(0, 16);
}

function parseDateTime(form: FormData, key: string, label: string): number {
  const value = required(form, key, label, 16);
  const parsed = Date.parse(value + ':00+09:00');
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ||
    !Number.isFinite(parsed) ||
    localDateTime(parsed) !== value
  ) {
    throw new OperationError(label + '을 올바른 일시로 입력해 주세요.');
  }
  return parsed;
}

function dateTimeRange(
  form: FormData,
  prefix: string,
  label: string,
): [number, number] {
  const start = parseDateTime(form, prefix + '_start', label + ' 시작');
  const end = parseDateTime(form, prefix + '_end', label + ' 종료');
  if (end <= start)
    throw new OperationError(label + ' 종료는 시작보다 늦어야 합니다.');
  return [start, end];
}

function timeRange(start: number, end: number): string {
  const from = localDateTime(start);
  const to = localDateTime(end);
  const [date, time] = from.split('T');
  const endLabel =
    date === to.slice(0, 10)
      ? to.slice(11)
      : formatKstDate(end) + ' ' + to.slice(11);
  return formatKstDate(start) + ' ' + time + '~' + endLabel;
}

function makeupLabel(notice: Notice): string {
  if (notice.makeup_kind === 'none') return '보강 없음';
  if (notice.makeup_start === null || notice.makeup_end === null)
    return '보강 일정 미정';
  return timeRange(notice.makeup_start, notice.makeup_end) + ' 보강';
}

function isStaff(actor: Actor): boolean {
  return actor.role === 'admin' || actor.role === 'teacher';
}

function requireStaff(actor: Actor): void {
  if (!isStaff(actor)) throw new OperationError('직원 권한이 필요합니다.', 403);
}

function requireClassScope(ctx: PageContext, classId: string | null): void {
  requireStaff(ctx.actor);
  if (classId === null && ctx.actor.role === 'admin') return;
  if (
    classId !== null &&
    accessibleClasses(ctx.db, ctx.actor).some(({ id }) => id === classId)
  )
    return;
  throw new OperationError('관리 권한이 없는 공지 대상입니다.', 403);
}

function noticesForAcademy(db: DatabaseSync, academyId: string): Notice[] {
  return rows<Notice>(
    db,
    'SELECT * FROM ops_schedule_notices WHERE academy_id = ? AND revoked_at IS NULL ' +
      'ORDER BY closure_start, id',
    academyId,
  );
}

function getNotice(ctx: PageContext, id: string): Notice {
  const notice = noticesForAcademy(ctx.db, ctx.actor.academyId).find(
    (item) => item.id === id,
  );
  if (!notice) throw new OperationError('공지 일정을 찾을 수 없습니다.', 404);
  requireClassScope(ctx, notice.class_id);
  return notice;
}

function requireCurrentNotice(form: FormData, notice: Notice): void {
  if (field(form, 'revision', 12) !== String(notice.revision))
    throw new OperationError('변경된 공지를 새로고침해 주세요.', 409);
}

function saveNotice(ctx: PageContext, form: FormData): void {
  const id = field(form, 'notice_id', 80);
  const notice = id ? getNotice(ctx, id) : undefined;
  if (notice) requireCurrentNotice(form, notice);
  const classId = field(form, 'class_id', 80) || null;
  requireClassScope(ctx, classId);

  const title = required(form, 'title', '공지 제목', 120);
  const [closureStart, closureEnd] = dateTimeRange(form, 'closure', '휴강');
  const makeup = required(form, 'makeup_kind', '보강 상태', 16);
  if (makeup !== 'pending' && makeup !== 'scheduled' && makeup !== 'none')
    throw new OperationError('보강 상태를 선택해 주세요.');
  const [makeupStart, makeupEnd] =
    makeup === 'scheduled'
      ? dateTimeRange(form, 'makeup', '보강')
      : [null, null];
  if (makeupStart !== null && makeupStart < closureEnd)
    throw new OperationError('보강은 휴강 시간 이후로 등록해 주세요.');

  const ranges = [[closureStart, closureEnd]];
  if (makeupStart !== null && makeupEnd !== null)
    ranges.push([makeupStart, makeupEnd]);
  const conflicts = noticesForAcademy(ctx.db, ctx.actor.academyId).some(
    (other) =>
      other.id !== notice?.id &&
      other.class_id === classId &&
      ranges.some(
        ([start, end]) =>
          (start < other.closure_end && other.closure_start < end) ||
          (other.makeup_start !== null &&
            other.makeup_end !== null &&
            start < other.makeup_end &&
            other.makeup_start < end),
      ),
  );
  if (conflicts)
    throw new OperationError(
      '같은 대상의 휴강 또는 보강 일정과 겹칩니다.',
      409,
    );

  checkNoticeAgainstTeam(ctx.db, ctx.actor.academyId, {
    id: notice?.id ?? '',
    class_id: classId,
    closure_start: closureStart,
    closure_end: closureEnd,
    makeup_start: makeupStart,
    makeup_end: makeupEnd,
  });
  const approvedAt = Date.now();
  const className = classId
    ? (one<{ name: string }>(
        ctx.db,
        'SELECT name FROM classes WHERE id = ? AND academy_id = ?',
        classId,
        ctx.actor.academyId,
      )?.name ?? null)
    : null;
  const values = [
    classId,
    className,
    title,
    closureStart,
    closureEnd,
    makeup,
    makeupStart,
    makeupEnd,
    approvedAt,
  ] as const;
  if (notice) {
    ctx.db
      .prepare(
        'UPDATE ops_schedule_notices SET class_id = ?, class_name = ?, title = ?, ' +
          'closure_start = ?, closure_end = ?, makeup_kind = ?, makeup_start = ?, ' +
          'makeup_end = ?, approved_at = ?, revision = revision + 1 WHERE id = ?',
      )
      .run(...values, notice.id);
    return;
  }
  ctx.db
    .prepare(
      'INSERT INTO ops_schedule_notices ' +
        '(class_id, class_name, title, closure_start, closure_end, makeup_kind, makeup_start, ' +
        'makeup_end, approved_at, id, academy_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(...values, randomUUID(), ctx.actor.academyId);
}

const slotSelect =
  'SELECT s.id, s.staff_id, a.name AS staff_name, s.starts_at, s.ends_at, ' +
  'EXISTS (SELECT 1 FROM ops_consultation_bookings b ' +
  'WHERE b.slot_id = s.id AND b.cancelled_at IS NULL) AS reserved ' +
  'FROM ops_consultation_slots s JOIN accounts a ' +
  'ON a.id = s.staff_id AND a.academy_id = s.academy_id ' +
  "WHERE s.academy_id = ? AND s.revoked_at IS NULL AND a.role IN ('admin', 'teacher')";

function getSlot(ctx: PageContext, id: string): Slot {
  const slot = one<Slot>(
    ctx.db,
    slotSelect + ' AND s.id = ?',
    ctx.actor.academyId,
    id,
  );
  if (!slot) throw new OperationError('상담 시간을 찾을 수 없습니다.', 404);
  return slot;
}

function manageSlot(ctx: PageContext, id: string): Slot {
  requireStaff(ctx.actor);
  const slot = getSlot(ctx, id);
  if (ctx.actor.role !== 'admin' && slot.staff_id !== ctx.actor.id)
    throw new OperationError('이 상담 시간을 관리할 권한이 없습니다.', 403);
  if (slot.reserved)
    throw new OperationError('예약을 먼저 취소해 주세요.', 409);
  return slot;
}

function saveSlot(ctx: PageContext, form: FormData): void {
  requireStaff(ctx.actor);
  const id = field(form, 'slot_id', 80);
  if (id) manageSlot(ctx, id);
  const staffId =
    ctx.actor.role === 'admin'
      ? required(form, 'staff_id', '상담 담당자', 80)
      : ctx.actor.id;
  const owner = one<{ id: string }>(
    ctx.db,
    "SELECT id FROM accounts WHERE id = ? AND academy_id = ? AND role IN ('admin', 'teacher')",
    staffId,
    ctx.actor.academyId,
  );
  if (!owner) throw new OperationError('상담 담당자를 찾을 수 없습니다.', 404);

  const [start, end] = dateTimeRange(form, 'slot', '상담');
  assertTeacherFree(ctx.db, ctx.actor.academyId, staffId, start, end);
  if (start <= Date.now())
    throw new OperationError('상담은 현재 이후의 시간으로 등록해 주세요.');
  const overlaps = one<{ id: string }>(
    ctx.db,
    'SELECT id FROM ops_consultation_slots WHERE academy_id = ? AND staff_id = ? ' +
      'AND revoked_at IS NULL AND id <> ? AND starts_at < ? AND ends_at > ?',
    ctx.actor.academyId,
    staffId,
    id,
    end,
    start,
  );
  if (overlaps)
    throw new OperationError('같은 담당자의 상담 시간과 겹칩니다.', 409);
  if (id) {
    ctx.db
      .prepare(
        'UPDATE ops_consultation_slots SET staff_id = ?, starts_at = ?, ends_at = ? WHERE id = ?',
      )
      .run(staffId, start, end, id);
    return;
  }
  ctx.db
    .prepare(
      'INSERT INTO ops_consultation_slots (id, academy_id, staff_id, starts_at, ends_at) ' +
        'VALUES (?, ?, ?, ?, ?)',
    )
    .run(randomUUID(), ctx.actor.academyId, staffId, start, end);
}

const bookingSelect =
  'SELECT b.id, b.student_id, u.name AS student_name, b.staff_id, a.name AS staff_name, ' +
  'b.starts_at, b.ends_at, b.cancelled_at ' +
  'FROM ops_consultation_bookings b ' +
  'JOIN accounts a ON a.id = b.staff_id AND a.academy_id = b.academy_id ' +
  'JOIN students u ON u.id = b.student_id AND u.academy_id = b.academy_id ' +
  'WHERE b.academy_id = ?';

function canReadBooking(ctx: PageContext, booking: Booking): boolean {
  return (
    ctx.actor.role === 'admin' ||
    (ctx.actor.role === 'teacher'
      ? booking.staff_id === ctx.actor.id
      : canReadStudent(ctx.db, ctx.actor, booking.student_id))
  );
}

function getActiveBooking(ctx: PageContext, id: string): Booking {
  const booking = one<Booking>(
    ctx.db,
    bookingSelect + ' AND b.id = ? AND b.cancelled_at IS NULL',
    ctx.actor.academyId,
    id,
  );
  if (!booking || !canReadBooking(ctx, booking))
    throw new OperationError('상담 예약을 찾을 수 없습니다.', 404);
  if (booking.starts_at <= Date.now())
    throw new OperationError(
      '시작 시간이 지난 예약은 변경할 수 없습니다.',
      409,
    );
  return booking;
}

function saveBooking(ctx: PageContext, form: FormData): void {
  if (ctx.actor.role !== 'guardian' && ctx.actor.role !== 'student')
    throw new OperationError('학생 또는 보호자 계정으로 예약해 주세요.', 403);
  const id = field(form, 'booking_id', 80);
  const booking = id ? getActiveBooking(ctx, id) : undefined;
  const studentId =
    booking?.student_id ?? required(form, 'student_id', '학생', 80);
  if (!canReadStudent(ctx.db, ctx.actor, studentId))
    throw new OperationError('예약 권한이 없는 학생입니다.', 403);

  const slot = getSlot(ctx, required(form, 'slot_id', '상담 시간', 80));
  if (slot.starts_at <= Date.now() || slot.reserved)
    throw new OperationError('이미 지났거나 예약된 상담 시간입니다.', 409);
  const overlaps = one<{ id: string }>(
    ctx.db,
    'SELECT id FROM ops_consultation_bookings ' +
      'WHERE academy_id = ? AND student_id = ? AND id <> ? AND cancelled_at IS NULL ' +
      'AND starts_at < ? AND ends_at > ?',
    ctx.actor.academyId,
    studentId,
    id,
    slot.ends_at,
    slot.starts_at,
  );
  if (overlaps)
    throw new OperationError('학생의 다른 상담 예약과 시간이 겹칩니다.', 409);
  if (booking) {
    ctx.db
      .prepare(
        'UPDATE ops_consultation_bookings SET slot_id = ?, staff_id = ?, starts_at = ?, ends_at = ? WHERE id = ?',
      )
      .run(slot.id, slot.staff_id, slot.starts_at, slot.ends_at, booking.id);
    return;
  }
  ctx.db
    .prepare(
      'INSERT INTO ops_consultation_bookings ' +
        '(id, academy_id, slot_id, student_id, staff_id, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      randomUUID(),
      ctx.actor.academyId,
      slot.id,
      studentId,
      slot.staff_id,
      slot.starts_at,
      slot.ends_at,
    );
}

function option(id: string, label: string, selected?: string | null): string {
  return (
    '<option value="' +
    esc(id) +
    '"' +
    (id === selected ? ' selected' : '') +
    '>' +
    esc(label) +
    '</option>'
  );
}

function hidden(name: string, value: string): string {
  return (
    '<input type="hidden" name="' + esc(name) + '" value="' + esc(value) + '">'
  );
}

function actionForm(
  action: string,
  fieldName: string,
  id: string,
  label: string,
  extra = '',
): string {
  return (
    '<form method="post" action="/schedule">' +
    hidden('action', action) +
    hidden(fieldName, id) +
    extra +
    '<button type="submit">' +
    esc(label) +
    '</button></form>'
  );
}

function renderNoticeForm(
  ctx: PageContext,
  editing: Notice | undefined,
): string {
  const choices = [
    ...(ctx.actor.role === 'admin'
      ? [option('', '학원 전체', editing?.class_id ?? '')]
      : []),
    ...accessibleClasses(ctx.db, ctx.actor).map(({ id, name }) =>
      option(id, name, editing?.class_id),
    ),
  ].join('');
  if (!choices) return '';
  return String.raw`
    <form method="post" action="/schedule">
      ${hidden('action', 'save_notice')}
      ${editing ? hidden('notice_id', editing.id) + hidden('revision', String(editing.revision)) : ''}
      <div class="fields">
        <label>공지 제목<input name="title" required maxlength="120" value="${esc(editing?.title)}"></label>
        <label>대상<select name="class_id">${choices}</select></label>
        <label>휴강 시작<input type="datetime-local" name="closure_start" required value="${localDateTime(editing?.closure_start)}"></label>
        <label>휴강 종료<input type="datetime-local" name="closure_end" required value="${localDateTime(editing?.closure_end)}"></label>
        <label>보강 상태<select name="makeup_kind">
          ${option('pending', '일정 미정', editing?.makeup_kind ?? 'pending')}
          ${option('scheduled', '일정 확정', editing?.makeup_kind)}
          ${option('none', '보강 없음', editing?.makeup_kind)}
        </select></label>
        <label>보강 시작<input type="datetime-local" name="makeup_start" value="${localDateTime(editing?.makeup_start)}"></label>
        <label>보강 종료<input type="datetime-local" name="makeup_end" value="${localDateTime(editing?.makeup_end)}"></label>
      </div>
      <div class="actions"><button type="submit">${editing ? '변경 확정' : '공지 확정'}</button>
      ${editing ? '<a href="/schedule">편집 취소</a>' : ''}</div>
    </form>`;
}

function renderNotices(ctx: PageContext): string {
  const allowedClasses = new Set(
    accessibleClasses(ctx.db, ctx.actor).map(({ id }) => id),
  );
  const notices = noticesForAcademy(ctx.db, ctx.actor.academyId).filter(
    ({ class_id: id }) =>
      id === null || ctx.actor.role === 'admin' || allowedClasses.has(id),
  );
  const manage = (notice: Notice) =>
    ctx.actor.role === 'admin' ||
    (ctx.actor.role === 'teacher' && notice.class_id !== null);
  const editing = notices.find(
    (notice) =>
      notice.id === ctx.url.searchParams.get('edit_notice') && manage(notice),
  );
  const body = notices
    .map(
      (notice) => String.raw`
    <tr><td>${esc(notice.title)}</td><td>${esc(notice.class_name ?? '학원 전체')}</td>
    <td>${esc(timeRange(notice.closure_start, notice.closure_end))}</td>
    <td>${esc(makeupLabel(notice))}</td>
    ${
      isStaff(ctx.actor)
        ? String.raw`<td><div class="actions">${
            manage(notice)
              ? String.raw`
      <a href="/schedule?edit_notice=${encodeURIComponent(notice.id)}">편집</a>
      ${actionForm('revoke_notice', 'notice_id', notice.id, '공지 철회', hidden('revision', String(notice.revision)))}
    `
              : ''
          }</div></td>`
        : ''
    }</tr>`,
    )
    .join('');
  return String.raw`
    <section class="panel"><h2>휴강·보강 공지</h2>
    ${isStaff(ctx.actor) ? renderNoticeForm(ctx, editing) : ''}
    ${
      notices.length
        ? String.raw`<div class="table-wrap"><table>
      <thead><tr><th>공지</th><th>대상</th><th>휴강</th><th>보강</th>${isStaff(ctx.actor) ? '<th>관리</th>' : ''}</tr></thead>
      <tbody>${body}</tbody></table></div>`
        : '<p>확정된 휴강·보강 공지가 없습니다.</p>'
    }
    </section>`;
}

function renderSlotForm(ctx: PageContext, editing: Slot | undefined): string {
  const staff =
    ctx.actor.role === 'admin'
      ? rows<{ id: string; name: string }>(
          ctx.db,
          "SELECT id, name FROM accounts WHERE academy_id = ? AND role IN ('admin', 'teacher') ORDER BY name, id",
          ctx.actor.academyId,
        )
          .map(({ id, name }) =>
            option(id, name, editing?.staff_id ?? ctx.actor.id),
          )
          .join('')
      : '';
  return String.raw`
    <form method="post" action="/schedule">
      ${hidden('action', 'save_slot')}${editing ? hidden('slot_id', editing.id) : ''}
      <div class="fields">
        ${staff ? '<label>상담 담당자<select name="staff_id" required>' + staff + '</select></label>' : ''}
        <label>상담 시작<input type="datetime-local" name="slot_start" required value="${localDateTime(editing?.starts_at)}"></label>
        <label>상담 종료<input type="datetime-local" name="slot_end" required value="${localDateTime(editing?.ends_at)}"></label>
      </div>
      <div class="actions"><button type="submit">${editing ? '상담 시간 저장' : '예약 가능 시간 추가'}</button>
      ${editing ? '<a href="/schedule">편집 취소</a>' : ''}</div>
    </form>`;
}

function renderStaffSlots(ctx: PageContext, slots: Slot[]): string {
  const owned = slots.filter(
    ({ staff_id }) => ctx.actor.role === 'admin' || staff_id === ctx.actor.id,
  );
  const editing = owned.find(
    (slot) =>
      !slot.reserved && slot.id === ctx.url.searchParams.get('edit_slot'),
  );
  const body = owned
    .map(
      (slot) => String.raw`
    <tr><td>${esc(slot.staff_name)}</td><td>${esc(timeRange(slot.starts_at, slot.ends_at))}</td>
    <td>${slot.reserved ? '예약됨' : '예약 가능'}</td><td><div class="actions">
    ${
      slot.reserved
        ? ''
        : '<a href="/schedule?edit_slot=' +
          encodeURIComponent(slot.id) +
          '">편집</a>' +
          actionForm('revoke_slot', 'slot_id', slot.id, '닫기')
    }
    </div></td></tr>`,
    )
    .join('');
  return (
    renderSlotForm(ctx, editing) +
    (owned.length
      ? String.raw`<div class="table-wrap"><table>
      <thead><tr><th>담당자</th><th>일시</th><th>상태</th><th>관리</th></tr></thead>
      <tbody>${body}</tbody></table></div>`
      : '<p>등록된 예약 가능 시간이 없습니다.</p>')
  );
}

function renderBookingForm(
  ctx: PageContext,
  slots: Slot[],
  editing: Booking | undefined,
): string {
  if (isStaff(ctx.actor)) return '';
  const students = accessibleStudents(ctx.db, ctx.actor);
  if (!students.length) return '<p>이 계정에 연결된 학생이 없습니다.</p>';
  const options = slots
    .filter(({ reserved }) => !reserved)
    .map((slot) =>
      option(
        slot.id,
        timeRange(slot.starts_at, slot.ends_at) + ' · ' + slot.staff_name,
      ),
    )
    .join('');
  if (!options) return '<p>예약 가능한 상담 시간이 없습니다.</p>';
  return String.raw`
    <form method="post" action="/schedule">
      ${hidden('action', 'save_booking')}${editing ? hidden('booking_id', editing.id) : ''}
      <div class="fields">
        ${
          editing
            ? '<p>' + esc(editing.student_name) + ' 학생의 예약 변경</p>'
            : '<label>학생<select name="student_id" required>' +
              students.map(({ id, name }) => option(id, name)).join('') +
              '</select></label>'
        }
        <label>상담 시간<select name="slot_id" required>
          <option value="">시간 선택</option>${options}
        </select></label>
      </div>
      <div class="actions"><button type="submit">${editing ? '예약 변경' : '상담 예약'}</button>
      ${editing ? '<a href="/schedule">편집 취소</a>' : ''}</div>
    </form>`;
}

function renderBookings(ctx: PageContext): string {
  const now = Date.now();
  const slots = rows<Slot>(
    ctx.db,
    slotSelect + ' AND s.starts_at > ? ORDER BY s.starts_at, a.name',
    ctx.actor.academyId,
    now,
  );
  const bookings = rows<Booking>(
    ctx.db,
    bookingSelect + ' ORDER BY b.starts_at DESC, b.id',
    ctx.actor.academyId,
  ).filter((booking) => canReadBooking(ctx, booking));
  const editable = (booking: Booking) =>
    booking.cancelled_at === null && booking.starts_at > now;
  const editing = bookings.find(
    (booking) =>
      editable(booking) &&
      booking.id === ctx.url.searchParams.get('edit_booking'),
  );
  const body = bookings
    .map(
      (booking) => String.raw`
    <tr><td>${esc(booking.student_name)}</td><td>${esc(booking.staff_name)}</td>
    <td>${esc(timeRange(booking.starts_at, booking.ends_at))}</td>
    <td>${booking.cancelled_at !== null ? '취소됨' : booking.starts_at <= now ? '지난 예약' : '예약됨'}</td>
    <td><div class="actions">${
      editable(booking)
        ? (isStaff(ctx.actor)
            ? ''
            : '<a href="/schedule?edit_booking=' +
              encodeURIComponent(booking.id) +
              '">변경</a>') +
          actionForm('cancel_booking', 'booking_id', booking.id, '예약 취소')
        : ''
    }</div></td></tr>`,
    )
    .join('');
  return String.raw`
    <section class="panel"><h2>상담 예약</h2>
    ${isStaff(ctx.actor) ? renderStaffSlots(ctx, slots) : renderBookingForm(ctx, slots, editing)}
    <h3>예약 내역</h3>
    ${
      bookings.length
        ? String.raw`<div class="table-wrap"><table>
      <thead><tr><th>학생</th><th>담당자</th><th>일시</th><th>상태</th><th>관리</th></tr></thead>
      <tbody>${body}</tbody></table></div>`
        : '<p>표시할 상담 예약이 없습니다.</p>'
    }
    </section>`;
}

function setup(db: DatabaseSync): void {
  db.exec(String.raw`
    CREATE TABLE IF NOT EXISTS ops_schedule_notices (
      id TEXT PRIMARY KEY,
      academy_id TEXT NOT NULL,
      class_id TEXT REFERENCES classes(id),
      class_name TEXT,
      title TEXT NOT NULL,
      closure_start INTEGER NOT NULL,
      closure_end INTEGER NOT NULL CHECK (closure_end > closure_start),
      makeup_kind TEXT NOT NULL CHECK (makeup_kind IN ('pending', 'scheduled', 'none')),
      makeup_start INTEGER,
      makeup_end INTEGER,
      revision INTEGER NOT NULL DEFAULT 1,
      approved_at INTEGER NOT NULL,
      revoked_at INTEGER,
      CHECK ((makeup_kind = 'scheduled' AND makeup_start IS NOT NULL AND makeup_end > makeup_start) OR
             (makeup_kind <> 'scheduled' AND makeup_start IS NULL AND makeup_end IS NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS ops_schedule_notices_academy
      ON ops_schedule_notices(academy_id, closure_start);

    CREATE TABLE IF NOT EXISTS ops_consultation_slots (
      id TEXT PRIMARY KEY,
      academy_id TEXT NOT NULL,
      staff_id TEXT NOT NULL REFERENCES accounts(id),
      starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL CHECK (ends_at > starts_at),
      revoked_at INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS ops_consultation_slots_owner
      ON ops_consultation_slots(academy_id, staff_id, starts_at);
    CREATE TABLE IF NOT EXISTS ops_consultation_bookings (
      id TEXT PRIMARY KEY,
      academy_id TEXT NOT NULL,
      slot_id TEXT NOT NULL REFERENCES ops_consultation_slots(id),
      student_id TEXT NOT NULL REFERENCES students(id),
      staff_id TEXT NOT NULL REFERENCES accounts(id),
      starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL CHECK (ends_at > starts_at),
      cancelled_at INTEGER
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS ops_consultation_slot_active_booking
      ON ops_consultation_bookings(slot_id) WHERE cancelled_at IS NULL;
    CREATE INDEX IF NOT EXISTS ops_consultation_bookings_academy_student
      ON ops_consultation_bookings(academy_id, student_id);
  `);
}

function submit(ctx: PageContext, form: FormData): void {
  transaction(ctx.db, () => {
    ctx.assertCurrentAccess?.();
    switch (required(form, 'action', '작업', 30)) {
      case 'save_notice':
        saveNotice(ctx, form);
        break;
      case 'revoke_notice': {
        const notice = getNotice(ctx, required(form, 'notice_id', '공지', 80));
        requireCurrentNotice(form, notice);
        ctx.db
          .prepare(
            'UPDATE ops_schedule_notices SET revoked_at = ? WHERE id = ?',
          )
          .run(Date.now(), notice.id);
        break;
      }
      case 'save_slot':
        saveSlot(ctx, form);
        break;
      case 'revoke_slot': {
        const slot = manageSlot(
          ctx,
          required(form, 'slot_id', '상담 시간', 80),
        );
        ctx.db
          .prepare(
            'UPDATE ops_consultation_slots SET revoked_at = ? WHERE id = ?',
          )
          .run(Date.now(), slot.id);
        break;
      }
      case 'save_booking':
        saveBooking(ctx, form);
        break;
      case 'cancel_booking': {
        const booking = getActiveBooking(
          ctx,
          required(form, 'booking_id', '상담 예약', 80),
        );
        ctx.db
          .prepare(
            'UPDATE ops_consultation_bookings SET cancelled_at = ? WHERE id = ?',
          )
          .run(Date.now(), booking.id);
        break;
      }
      default:
        throw new OperationError('지원하지 않는 일정 작업입니다.');
    }
  });
}

function markdownCell(value: string): string {
  return value.replace(/[|\r\n]+/g, ' ').trim();
}

function noticeDocumentId(notice: Notice): string {
  return 'ops-schedule-' + notice.id;
}

function closureLabel(notice: Notice): string {
  return timeRange(notice.closure_start, notice.closure_end) + ' 휴강';
}

export function scheduleDocuments(
  db: DatabaseSync,
  academyId: string,
): SourceDocumentInput[] {
  return noticesForAcademy(db, academyId).flatMap((notice) => {
    if (notice.class_id && !notice.class_name) return [];
    const approvedAt = new Date(notice.approved_at).toISOString();
    return [
      {
        academyId,
        documentId: noticeDocumentId(notice),
        revision: notice.revision,
        documentType: 'announcement',
        title: notice.title,
        text: [
          '# 휴강·보강 공지',
          '',
          '| 대상 반 | 휴강 일시 | 보강 일정 |',
          '|---|---|---|',
          '| ' +
            markdownCell(notice.class_name ?? '전체 반') +
            ' | ' +
            closureLabel(notice) +
            ' | ' +
            makeupLabel(notice) +
            ' |',
        ].join('\n'),
        visibility: notice.class_id ? 'class_members' : 'academy_public',
        classId: notice.class_id,
        validFrom: approvedAt,
        approvedAt,
      },
    ];
  });
}

export function scheduleFacts(
  db: DatabaseSync,
  academyId: string,
): ApprovedFactInput[] {
  return noticesForAcademy(db, academyId).flatMap((notice) => {
    if (notice.class_id && !notice.class_name) return [];
    const documentId = noticeDocumentId(notice);
    const sourceId = documentId + ':r' + notice.revision + ':body';
    const fact = (
      changeType: 'cancel' | 'makeup',
      start: number,
      end: number,
      text: string,
    ): ApprovedFactInput => {
      const from = localDateTime(start);
      const to = localDateTime(end);
      const date = from.slice(0, 10);
      const sameDay = date === to.slice(0, 10);
      return {
        factId: sourceId + ':' + changeType,
        sourceId,
        documentId,
        revision: notice.revision,
        academyId,
        subjectType: notice.class_id ? 'class' : 'academy',
        subjectId: notice.class_id ?? academyId,
        factType: 'schedule_change',
        value: {
          kind: 'schedule_change',
          changeType,
          date,
          time: sameDay ? from.slice(11) + '~' + to.slice(11) : null,
          text: sameDay ? (changeType === 'cancel' ? '휴강' : '보강') : text,
          event: {
            id: documentId,
            startsAt: start,
            endsAt: end,
            makeupStatus:
              changeType === 'cancel' ? notice.makeup_kind : undefined,
          },
        },
        period: null,
        validFrom: new Date(notice.approved_at).toISOString(),
        approvalStatus: 'approved',
      };
    };
    const facts = [
      fact(
        'cancel',
        notice.closure_start,
        notice.closure_end,
        closureLabel(notice),
      ),
    ];
    if (notice.makeup_start !== null && notice.makeup_end !== null)
      facts.push(
        fact(
          'makeup',
          notice.makeup_start,
          notice.makeup_end,
          makeupLabel(notice),
        ),
      );
    return facts;
  });
}

export const scheduleModule: OperationModule = {
  path: '/schedule',
  label: '상담 예약·학원 공지',
  roles: ['admin', 'teacher', 'student', 'guardian'],
  setup,
  render: (ctx) =>
    '<div class="split">' + renderNotices(ctx) + renderBookings(ctx) + '</div>',
  submit,
};

export function calendarNotices(ctx: PageContext, from: string, to: string) {
  const allowed = new Set(
    accessibleClasses(ctx.db, ctx.actor).map((c) => c.id),
  );
  const result: { date: string; title: string; kind: string }[] = [];
  const add = (start: number, end: number, title: string, kind: string) => {
    const a = localDateTime(start).slice(0, 10),
      b = localDateTime(end - 1).slice(0, 10);
    const first = a > from ? a : from,
      last = b < to ? b : to;
    for (
      let d = first;
      d <= last;
      d = new Date(Date.parse(d + 'T00:00:00Z') + 86400000)
        .toISOString()
        .slice(0, 10)
    )
      result.push({ date: d, title, kind });
  };
  for (const n of noticesForAcademy(ctx.db, ctx.actor.academyId))
    if (!n.class_id || ctx.actor.role === 'admin' || allowed.has(n.class_id)) {
      add(n.closure_start, n.closure_end, n.title + ' · 휴강', 'canceled');
      if (n.makeup_start !== null && n.makeup_end !== null)
        add(n.makeup_start, n.makeup_end, n.title + ' · 보강', 'makeup');
    }
  for (const b of rows<Booking>(
    ctx.db,
    bookingSelect + ' AND b.cancelled_at IS NULL',
    ctx.actor.academyId,
  ))
    if (canReadBooking(ctx, b))
      add(
        b.starts_at,
        b.ends_at,
        localDateTime(b.starts_at).slice(11) +
          ' ' +
          b.student_name +
          ' 상담 예약',
        'booking',
      );
  return result;
}
