import { operationsGeneration } from './runtime-generation.ts';
import { validateGeneratedOutput } from '../rag-consultation/server/generation/validate-output.ts';
import {
  escapeHtml as h,
  field,
  one,
  transaction,
  OperationError,
  type OperationModule,
  type PageContext,
} from './shared.ts';

export const characters = {
  walnut: '호두',
  water: '온천 물방울',
  owl: '수리부엉이',
} as const;
export function selectedCharacter(
  ctx: Pick<PageContext, 'db' | 'actor'>,
): keyof typeof characters {
  const value = one<{ character: string }>(
    ctx.db,
    'SELECT character FROM op_preferences WHERE account_id = ?',
    ctx.actor.id,
  )?.character;
  return value && Object.hasOwn(characters, value)
    ? (value as keyof typeof characters)
    : 'walnut';
}
export const preferencesModule: OperationModule = {
  path: '/settings',
  label: '설정',
  roles: ['admin', 'teacher', 'student', 'guardian', 'visitor'],
  setup(db) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS op_preferences (account_id TEXT PRIMARY KEY REFERENCES accounts(id), character TEXT NOT NULL)',
    );
  },
  render(ctx) {
    const generation = operationsGeneration();
    const choice = selectedCharacter(ctx);
    return `<div class="page-heading"><h1>설정</h1></div><section class="panel"><h2>상담 캐릭터</h2><form method="post"><input type="hidden" name="action" value="character"><div class="character-options">${Object.entries(
      characters,
    )
      .map(
        ([id, name]) =>
          `<label><input type="radio" name="character" value="${id}"${choice === id ? ' checked' : ''}><img src="/assets/${id}.png" alt=""><strong>${name}</strong></label>`,
      )
      .join(
        '',
      )}</div><button>선택 저장</button></form></section>${ctx.actor.role === 'admin' ? `<section class="panel"><h2>상담 AI 연결</h2><p>공급자: <strong>${h(generation.providerId)}</strong> · ${h(generation.availability(Date.now()))}</p><p>확정 수치·일정 조회는 직접 답하고, 근거가 있는 학습 제안에 AI를 사용합니다. 학생 자료 외부 처리 설정: ${generation.personalDataApproved ? '허용' : '차단'}.</p><p>연결 키와 공급자는 서버 설정 파일에서 관리합니다. 키는 화면에 표시하지 않습니다.</p><form method="post"><button name="action" value="probe">가상 안내로 연결 확인</button></form>${ctx.url.searchParams.has('probe') ? `<p role="status">연결 확인: ${h(ctx.url.searchParams.get('probe'))}</p>` : ''}</section>` : ''}`;
  },
  async submit(ctx, form) {
    if (field(form, 'action') === 'probe') {
      if (ctx.actor.role !== 'admin')
        throw new OperationError('관리자만 연결을 확인할 수 있습니다.', 403);
      ctx.assertCurrentAccess?.();
      const sourceId = 'SYNTHETIC_NOTICE';
      const result = await operationsGeneration().generateGroundedAnswer(
        {
          requestId: 'operations-synthetic-probe',
          question: '가상 학원 안내 데스크의 운영 시작 시각을 알려주세요.',
          facts: [],
          sources: [
            {
              sourceId,
              title: '가상 안내',
              location: '안내 데스크',
              text: '가상 학원의 안내 데스크는 14시에 엽니다.',
            },
          ],
          containsPersonalData: false,
        },
        { timeoutMs: 15000, now: Date.now() },
      );
      ctx.assertCurrentAccess?.();
      if (!result.ok) {
        return (
          '/settings?probe=' + encodeURIComponent(`연결 실패 (${result.error})`)
        );
      }
      const validated = validateGeneratedOutput(result.rawText, {
        allowedSourceIds: [sourceId],
        allowedNumbers: new Set([14]),
        studentCodePattern: /ST_([A-Z0-9]+)/g,
        allowedStudentCodes: [],
      });
      const passed =
        validated.ok &&
        validated.output.status === 'answered' &&
        /14\s*시/.test(validated.output.answer);
      return (
        '/settings?probe=' +
        encodeURIComponent(
          passed
            ? 'API 응답 수신 완료 · 14시 · 출처: 가상 안내'
            : 'API 응답 수신 완료 · 가상 안내 근거 검증 실패',
        )
      );
    }
    const character = field(form, 'character');
    if (!Object.hasOwn(characters, character))
      throw new OperationError('캐릭터를 선택해 주세요.', 422);
    transaction(ctx.db, () => {
      ctx.assertCurrentAccess?.();
      ctx.db
        .prepare(
          'INSERT INTO op_preferences VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET character=excluded.character',
        )
        .run(ctx.actor.id, character);
    });
    return '/settings';
  },
};
