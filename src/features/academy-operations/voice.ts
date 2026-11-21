import { serviceIcon } from './service-navigation.ts';
import { randomUUID } from 'node:crypto';
import type { RagAnswer } from '../rag-consultation/contract.ts';
import { ask, loadThread, currentCitationRevisions } from './consultation.ts';
import { accessibleClasses, accessibleStudents } from './directory.ts';
import {
  escapeHtml as h,
  field,
  required,
  one,
  rows,
  transaction,
  OperationError,
  type PageContext,
  type OperationModule,
} from './shared.ts';

interface VoiceSession {
  id: string;
  academy_id: string;
  owner_id: string;
  thread_id: string;
  failures: number;
  closed: number;
}
interface VoiceTurn {
  id: string;
  session_id: string;
  original: string;
  question: string;
  student_id: string;
  state: string;
  response: string | null;
  created_at: string;
}
function guardian(ctx: PageContext) {
  ctx.assertCurrentAccess?.();
  if (ctx.actor.role !== 'guardian')
    throw new OperationError(
      '로그인한 보호자만 음성 상담을 사용할 수 있습니다.',
      403,
    );
}
function session(ctx: PageContext, id: string) {
  guardian(ctx);
  const result = one<VoiceSession>(
    ctx.db,
    'SELECT * FROM op_voice_sessions WHERE id=? AND academy_id=? AND owner_id=?',
    id,
    ctx.actor.academyId,
    ctx.actor.id,
  );
  if (!result) throw new OperationError('음성 상담을 찾을 수 없습니다.', 404);
  if (
    one(
      ctx.db,
      'SELECT 1 FROM op_consultation_threads WHERE id=?',
      result.thread_id,
    )
  )
    loadThread(ctx, result.thread_id);
  return result;
}
function turn(ctx: PageContext, id: string) {
  const result = one<VoiceTurn>(
    ctx.db,
    'SELECT * FROM op_voice_turns WHERE id=?',
    id,
  );
  if (!result) throw new OperationError('음성 질문을 찾을 수 없습니다.', 404);
  const parent = session(ctx, result.session_id);
  if (
    result.student_id &&
    !accessibleStudents(ctx.db, ctx.actor).some(
      (s) => s.id === result.student_id,
    )
  )
    throw new OperationError('학생 조회 권한이 변경되었습니다.', 403);
  return { result, parent };
}
export function redactPhones(value: string) {
  return value.replace(
    /(?:\+82[\s.-]?(?:\(0\))?[\s.-]?)?(?:0?1[016789]|0?2|0?[3-6][1-5]|070)[\s.-]?\d{3,4}[\s.-]?\d{4}\b/g,
    '[전화번호 가림]',
  );
}
export function spokenAnswer(answer: RagAnswer, question: string) {
  if (
    /성적|채점|점수|정답률|오답|성취|학습|리포트|분석/.test(
      question + ' ' + answer.answer,
    ) ||
    answer.citations.some((c) => /^(learning-|workbook-)/.test(c.documentId))
  )
    return '성적과 채점 결과는 화면의 글 답변에서 확인해 주세요.';
  if (answer.status !== 'answered' || !answer.citations.length)
    return '확인할 내용이 있어 화면에 안내했습니다. 학원 담당자의 확인이 필요할 수 있습니다.';
  return redactPhones(answer.answer);
}
function readableAnswer(ctx: PageContext, record: VoiceTurn) {
  if (!record.response) return null;
  const answer = JSON.parse(record.response) as RagAnswer;
  const revisions = currentCitationRevisions(ctx);
  if (
    answer.citations.some(
      (c) =>
        c.revision === undefined ||
        !revisions.get(c.documentId)?.has(c.revision),
    )
  )
    return null;
  return answer;
}
export async function voiceAudio(ctx: PageContext, form: FormData) {
  guardian(ctx);
  const { result } = turn(ctx, required(form, 'turnId', '음성 답변', 40));
  if (result.state !== 'answered')
    throw new OperationError('답변이 준비되지 않았습니다.', 409);
  const answer = readableAnswer(ctx, result);
  if (!answer)
    throw new OperationError(
      '근거 자료가 변경됐습니다. 다시 질문해 주세요.',
      409,
    );
  const privateSource = answer.citations.some((citation) => {
    const doc = one<{ input: string }>(
      ctx.db,
      'SELECT input FROM op_document_versions WHERE academy_id=? AND document_id=? AND revision=?',
      ctx.actor.academyId,
      citation.documentId,
      citation.revision ?? 0,
    );
    if (!doc) return false;
    const source = JSON.parse(doc.input) as {
      visibility: string;
      documentType: string;
    };
    return (
      source.visibility === 'student_private' ||
      source.documentType === 'student_analysis'
    );
  });
  const speech = privateSource
    ? '개인 학습 결과는 화면의 글 답변에서 확인해 주세요.'
    : spokenAnswer(answer, result.question);
  const bytes = await ctx.services!.synthesize(speech);
  turn(ctx, result.id);
  if (!readableAnswer(ctx, result))
    throw new OperationError('자료가 변경됐습니다. 다시 질문해 주세요.', 409);
  return bytes;
}
export function recognitionKeywords(ctx: PageContext) {
  const classes = accessibleClasses(ctx.db, ctx.actor).map((c) => c.name);
  const teachers = rows<{ name: string }>(
    ctx.db,
    "SELECT name FROM accounts WHERE academy_id=? AND role IN ('admin','teacher')",
    ctx.actor.academyId,
  ).map((x) => x.name);
  const books = one(
    ctx.db,
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='books'",
  )
    ? rows<{ name: string }>(
        ctx.db,
        'SELECT name FROM books WHERE academy_id=?',
        ctx.actor.academyId,
      ).map((x) => x.name)
    : [];
  return [...new Set([...classes, ...teachers, ...books])]
    .filter((x) => x && x.length <= 100)
    .slice(0, 100);
}
async function handoff(
  ctx: PageContext,
  parent: VoiceSession,
  original: string,
) {
  // Recognition failures do not ask the RAG engine to guess the intended question.
  transaction(ctx.db, () => {
    guardian(ctx);
    const now = new Date().toISOString();
    ctx.db
      .prepare(
        `INSERT OR IGNORE INTO op_consultation_threads(id,academy_id,owner_id,title,status,student_scope,class_scope,staff_scope,updated_at) VALUES(?,?,?,'음성 질문 확인 요청','requested',?,?,0,?)`,
      )
      .run(
        parent.thread_id,
        ctx.actor.academyId,
        ctx.actor.id,
        JSON.stringify(accessibleStudents(ctx.db, ctx.actor).map((s) => s.id)),
        JSON.stringify(accessibleClasses(ctx.db, ctx.actor).map((s) => s.id)),
        now,
      );
    ctx.db
      .prepare(
        "UPDATE op_consultation_threads SET status='requested',version=version+1,updated_at=? WHERE id=? AND owner_id=? AND status='open'",
      )
      .run(now, parent.thread_id, ctx.actor.id);
    ctx.db
      .prepare(
        "INSERT INTO op_consultation_messages(thread_id,kind,text,created_at) VALUES(?,'question',?,?)",
      )
      .run(
        parent.thread_id,
        '음성 인식 확인이 두 번 실패했습니다. 원문: ' + original,
        now,
      );
    ctx.db
      .prepare('UPDATE op_voice_sessions SET closed=1 WHERE id=?')
      .run(parent.id);
    ctx.db
      .prepare(
        "UPDATE op_voice_turns SET state='handoff' WHERE session_id=? AND state='pending'",
      )
      .run(parent.id);
  });
}
export const voiceModule: OperationModule = {
  path: '/voice',
  label: '음성 상담',
  roles: ['guardian'],
  setup(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS op_voice_sessions(id TEXT PRIMARY KEY,academy_id TEXT NOT NULL,owner_id TEXT NOT NULL,thread_id TEXT NOT NULL,failures INTEGER NOT NULL DEFAULT 0,closed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS op_voice_turns(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,original TEXT NOT NULL,question TEXT NOT NULL,student_id TEXT NOT NULL,state TEXT NOT NULL,response TEXT,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS op_voice_turn_lookup ON op_voice_turns(session_id,created_at);`);
  },
  render(ctx) {
    guardian(ctx);
    const id = ctx.url.searchParams.get('id'),
      parent = id ? session(ctx, id) : undefined;
    const records = parent
      ? rows<VoiceTurn>(
          ctx.db,
          'SELECT * FROM op_voice_turns WHERE session_id=? ORDER BY created_at,id',
          parent.id,
        )
      : [];
    const hidden = parent
      ? `<input type="hidden" name="sessionId" value="${h(parent.id)}">`
      : '';
    const pending = records.find((r) => r.state === 'pending');
    const summary = records
      .filter((r) => r.state === 'answered')
      .map((r) => {
        const answer = readableAnswer(ctx, r);
        return answer
          ? `질문: ${redactPhones(r.question)}\n안내: ${redactPhones(answer.answer)}`
          : '근거 변경으로 이전 답변을 요약에서 제외했습니다.';
      })
      .join('\n\n');
    return `<script src="/voice-ui.js" defer></script><div class="workspace-heading voice-heading"><div><h1>음성 상담</h1><p>말하거나 질문을 적어 학원 안내를 확인하세요.</p></div><a class="button-link subtle-link" href="/consultation">채팅 상담 열기</a></div><div class="voice-workspace"><section class="voice-status-band"><span class="voice-mic" aria-hidden="true">${serviceIcon('/voice')}</span><div><strong>${ctx.services?.speechAvailable ? '마이크로 질문하기' : '지금은 글로 질문할 수 있어요'}</strong><p data-voice-status role="status">${ctx.services?.speechAvailable ? '한 번에 최대 60초 동안 말할 수 있습니다.' : '음성 인식 연결 전입니다.'}</p></div></section>${parent?.closed ? `<section class="panel voice-card"><h2>상담 종료</h2><a class="workspace-link" href="/consultation?id=${h(parent.thread_id)}">상담 내용 보기</a><h3>상담 요약</h3><p class="preserve">${h(summary || '인식 결과를 담당자가 확인합니다.')}</p><h3>안내 문자 초안</h3><textarea readonly rows="6">${h(summary || '학원 담당자가 문의 내용을 확인한 뒤 안내하겠습니다.')}</textarea><p class="muted">초안이며 문자를 발송하지 않습니다.</p><a class="button-link" href="/voice">새 음성 상담</a></section>` : ''}
    ${records
      .map((r) => {
        const answer = readableAnswer(ctx, r);
        return `<section class="panel voice-card"><h2>질문</h2><p class="voice-question preserve">${h(r.original)}</p>${r.state === 'pending' ? `<form method="post">${hidden}<input type="hidden" name="turnId" value="${h(r.id)}"><h2>반·날짜·시간이 맞나요?</h2><p class="preserve">${h(r.question)}</p><div class="actions"><button name="action" value="confirm">맞습니다 · 답변 받기</button><button class="secondary" name="action" value="retry">다시 입력</button></div></form>` : answer ? `<h3>학원 안내</h3><p class="preserve">${h(answer.answer)}</p>${answer.citations.length ? `<details class="source-details"><summary>확인한 자료 ${answer.citations.length}개</summary><ul class="citations">${answer.citations.map((c) => `<li>${h(c.title)} · ${h(c.location)}</li>`).join('')}</ul></details>` : ''}${ctx.services?.voiceAvailable ? `<button type="button" data-speak="${h(r.id)}">답변 듣기</button>` : ''}` : r.state === 'answered' ? '<p>근거 변경으로 이전 답변을 표시하지 않습니다.</p>' : r.state === 'failed' ? '<p>인식 실패 · 다시 입력해 주세요.</p>' : ''}</section>`;
      })
      .join('')}
    ${
      !parent?.closed && !pending
        ? `<section class="panel voice-card"><h2>${parent ? '이어서 질문하기' : '학원에 질문하기'}</h2><form method="post" class="voice-composer" enctype="multipart/form-data" data-voice-form>${hidden}<input type="hidden" name="action" value="input"><label>대상 학생<select name="studentId"><option value="">선택 사항</option>${accessibleStudents(
            ctx.db,
            ctx.actor,
          )
            .map((s) => `<option value="${h(s.id)}">${h(s.name)}</option>`)
            .join(
              '',
            )}</select></label><label>질문<textarea name="text" maxlength="500" rows="3" placeholder="예. 상담 예약은 어떻게 하나요?"></textarea></label><input type="file" name="audio" accept="audio/wav" hidden data-voice-file><div class="actions voice-buttons">${ctx.services?.speechAvailable ? '<button type="button" data-record>말로 질문</button><button type="button" data-stop hidden>녹음 끝내기</button>' : ''}<button type="submit">글로 질문</button></div></form></section>`
        : ''
    }${parent && !parent.closed ? `<form method="post">${hidden}<button class="secondary" name="action" value="end">상담 종료·요약 보기</button></form>` : ''}</div>`;
  },
  async submit(ctx, form) {
    guardian(ctx);
    const action = field(form, 'action');
    let parent = field(form, 'sessionId')
      ? session(ctx, field(form, 'sessionId'))
      : undefined;
    if (parent?.closed)
      throw new OperationError(
        '종료된 상담입니다. 새 상담을 시작해 주세요.',
        409,
      );
    if (action === 'input') {
      const studentId = field(form, 'studentId', 128);
      if (
        studentId &&
        !accessibleStudents(ctx.db, ctx.actor).some((s) => s.id === studentId)
      )
        throw new OperationError('허용된 학생을 선택해 주세요.', 403);
      if (
        parent &&
        one(
          ctx.db,
          "SELECT 1 FROM op_voice_turns WHERE session_id=? AND state IN ('pending','recognizing','answering')",
          parent.id,
        )
      )
        throw new OperationError('진행 중인 질문을 먼저 확인해 주세요.', 409);
      if (!parent) {
        const id = randomUUID();
        ctx.db
          .prepare(
            'INSERT INTO op_voice_sessions(id,academy_id,owner_id,thread_id) VALUES(?,?,?,?)',
          )
          .run(id, ctx.actor.academyId, ctx.actor.id, randomUUID());
        parent = session(ctx, id);
      }
      const turnId = randomUUID();
      ctx.db
        .prepare(
          "INSERT INTO op_voice_turns VALUES(?,?,?,?,?,'recognizing',NULL,?)",
        )
        .run(turnId, parent.id, '', '', studentId, new Date().toISOString());
      let text = field(form, 'text', 500),
        confidence: number | null = null;
      try {
        const audio = form.get('audio');
        if (audio instanceof File && audio.size)
          ({ text, confidence } = await ctx.services!.transcribe(
            audio,
            recognitionKeywords(ctx),
          ));
        if (!text) throw new OperationError('질문을 입력해 주세요.');
        guardian(ctx);
        if (session(ctx, parent.id).closed)
          throw new OperationError('종료된 상담입니다.', 409);
        ctx.db
          .prepare(
            "UPDATE op_voice_turns SET original=?,question=?,state='pending' WHERE id=?",
          )
          .run(text, text, turnId);
        if (confidence !== null && confidence < 0.5)
          throw new OperationError('인식 결과를 확인할 수 없습니다.');
      } catch (error) {
        ctx.db
          .prepare("UPDATE op_voice_turns SET state='failed' WHERE id=?")
          .run(turnId);
        if (!(error instanceof OperationError))
          throw new OperationError(
            '인식 서비스 오류입니다. 글로 입력해 주세요.',
            503,
          );
        if (error.status === 403 || error.status === 401) throw error;
        ctx.db
          .prepare(
            'UPDATE op_voice_sessions SET failures=failures+1 WHERE id=?',
          )
          .run(parent.id);
        const current = session(ctx, parent.id);
        if (!current.closed && current.failures >= 2)
          await handoff(ctx, current, text || '인식된 문장 없음');
      }
      return '/voice?id=' + parent.id;
    }
    if (!parent) throw new OperationError('상담을 선택해 주세요.', 404);
    if (action === 'end') {
      if (
        one(
          ctx.db,
          "SELECT 1 FROM op_voice_turns WHERE session_id=? AND state='answering'",
          parent.id,
        )
      )
        throw new OperationError(
          '답변을 처리 중입니다. 완료 후 종료해 주세요.',
          409,
        );
      ctx.db
        .prepare('UPDATE op_voice_sessions SET closed=1 WHERE id=?')
        .run(parent.id);
      return '/voice?id=' + parent.id;
    }
    const { result, parent: owner } = turn(ctx, field(form, 'turnId', 40));
    if (owner.id !== parent.id || result.state !== 'pending')
      throw new OperationError('확인할 질문이 변경되었습니다.', 409);
    if (action === 'retry') {
      transaction(ctx.db, () => {
        ctx.db
          .prepare("UPDATE op_voice_turns SET state='rejected' WHERE id=?")
          .run(result.id);
        ctx.db
          .prepare(
            'UPDATE op_voice_sessions SET failures=failures+1 WHERE id=?',
          )
          .run(parent!.id);
      });
      const current = session(ctx, parent.id);
      if (current.failures >= 2) await handoff(ctx, current, result.original);
      return '/voice?id=' + parent.id;
    }
    if (action !== 'confirm')
      throw new OperationError('지원하지 않는 작업입니다.');
    if (
      !ctx.db
        .prepare(
          "UPDATE op_voice_turns SET state='answering' WHERE id=? AND state='pending'",
        )
        .run(result.id).changes
    )
      throw new OperationError('질문을 처리 중입니다.', 409);
    try {
      const query = new FormData();
      query.set('question', result.question);
      query.set('studentId', result.student_id);
      query.set('conversationId', parent.thread_id);
      const existing = one(
        ctx.db,
        'SELECT 1 FROM op_consultation_threads WHERE id=?',
        parent.thread_id,
      )
        ? loadThread(ctx, parent.thread_id)
        : undefined;
      await ask(ctx, query, existing);
      if (
        existing &&
        (existing.status === 'requested' || existing.status === 'assigned')
      ) {
        transaction(ctx.db, () => {
          ctx.db
            .prepare("UPDATE op_voice_turns SET state='forwarded' WHERE id=?")
            .run(result.id);
          ctx.db
            .prepare('UPDATE op_voice_sessions SET closed=1 WHERE id=?')
            .run(parent.id);
        });
        return '/consultation?id=' + parent.thread_id;
      }
      const answer = one<{ response: string }>(
        ctx.db,
        "SELECT response FROM op_consultation_messages WHERE thread_id=? AND kind='answer' ORDER BY id DESC LIMIT 1",
        parent.thread_id,
      )!;
      ctx.db
        .prepare(
          "UPDATE op_voice_turns SET state='answered',response=? WHERE id=?",
        )
        .run(answer.response, result.id);
      ctx.db
        .prepare('UPDATE op_voice_sessions SET failures=0 WHERE id=?')
        .run(parent.id);
    } catch (error) {
      ctx.db
        .prepare(
          "UPDATE op_voice_turns SET state='pending' WHERE id=? AND state='answering'",
        )
        .run(result.id);
      throw error;
    }
    return '/voice?id=' + parent.id;
  },
};
