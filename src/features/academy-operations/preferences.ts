import { operationsGeneration } from './runtime-generation.ts';
import { validateGeneratedOutput } from '../rag-consultation/server/generation/validate-output.ts';
import {
  escapeHtml as h,
  field,
  OperationError,
  type OperationModule,
} from './shared.ts';

export const preferencesModule: OperationModule = {
  path: '/settings',
  label: '설정',
  roles: ['admin'],
  setup() {},
  render(ctx) {
    const generation = operationsGeneration();
    return `<div class="page-heading"><h1>설정</h1></div><section class="panel"><h2>상담 AI 연결</h2><p>공급자: <strong>${h(generation.providerId)}</strong> · ${h(generation.availability(Date.now()))}</p><p>확정 수치·일정 조회는 직접 답하고, 근거가 있는 학습 제안에 AI를 사용합니다. 학생 자료 외부 처리 설정: ${generation.personalDataApproved ? '허용' : '차단'}.</p><p>연결 키와 공급자는 서버 설정 파일에서 관리합니다. 키는 화면에 표시하지 않습니다.</p><form method="post"><button name="action" value="probe">가상 안내로 연결 확인</button></form>${ctx.url.searchParams.has('probe') ? `<p role="status">연결 확인: ${h(ctx.url.searchParams.get('probe'))}</p>` : ''}</section>`;
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
    throw new OperationError('지원하지 않는 설정 요청입니다.', 400);
  },
};
