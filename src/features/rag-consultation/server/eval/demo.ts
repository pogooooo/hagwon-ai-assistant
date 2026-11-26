/**
 * DEMO.md 의 질문·답변 예시를 실제 엔진 실행 결과로 만든다(개발 자료만 사용: academies-v1, academies-v2 개발 학원).
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON src/features/rag-consultation/server/eval/demo.ts > /tmp/demo.md
 * 생성 공급자는 disabled(키 없음) — 학습 방향 생성이 필요한 질문은 담당자 연결로 끝나는 것이 정상이다.
 */
import {
  buildAcademiesStore,
  createAcademyCatalogPort,
  readAcademiesDataset,
  toAcademyAccessScope,
  type AcademiesDataset,
} from '../adapters/fixture/load-academies.ts';
import {
  FixedClock,
  InMemoryConversationStore,
  InMemoryHandoffStore,
} from '../adapters/memory/index.ts';
import { DisabledGenerationProvider } from '../generation/providers.ts';
import { createRagConsultationService } from '../service.ts';
import { InMemoryRagStore } from '../store/in-memory-store.ts';
import { parseInstant } from '../text/time.ts';
import { V2_DIR } from './harness.ts';

interface DemoItem {
  title: string;
  userId: string;
  asOf: string;
  history?: string[];
  question: string;
}

const HK: DemoItem[] = [
  {
    title: 'PDF 표(과정별 수업 구성)의 값',
    userId: 'HK_VISITOR',
    asOf: '2026-11-10T18:00:00+09:00',
    question: '초등 실험탐구반 일주일에 몇번이고 한번에 몇분 수업해요?',
  },
  {
    title: '2단 편집 소식지 PDF',
    userId: 'HK_VISITOR',
    asOf: '2026-11-10T18:00:00+09:00',
    question: '가을 과학탐구대회 상 받은 학생 몇명이에요?',
  },
  {
    title: '원문 표 머리글로 비용 이름 구분(실험 재료비)',
    userId: 'HK_VISITOR',
    asOf: '2026-11-10T18:00:00+09:00',
    question: '초6 실험반 재료비 따로 받아요? 얼마에요',
  },
  {
    title: '다른 비용(교재비 절)을 물으면 문서 근거',
    userId: 'HK_GUARDIAN_BAE',
    asOf: '2026-11-10T18:00:00+09:00',
    question: '교재비는 따로 내야 되나요? 아직 안 낸거 같아서요',
  },
  {
    title: '격자 시간표에서 묻는 요일 칸만',
    userId: 'HK_GUARDIAN_SHIN',
    asOf: '2026-11-10T18:00:00+09:00',
    question: '예나 영재원 토요일 몇시부터 몇시까지예요?',
  },
  {
    title: '휴강과 같은 공지의 보강을 날짜순으로 짝짓기',
    userId: 'HK_GUARDIAN_BAE',
    asOf: '2026-12-01T18:00:00+09:00',
    question: '준서 12월 14일 수업 없다던데 보강 언제예요?',
  },
  {
    title: '달 없이 날만 말한 날짜',
    userId: 'HK_STUDENT_DOHYUN',
    asOf: '2026-12-17T18:00:00+09:00',
    question: '기말대비 끝나면 21일부터 원래 시간으로 돌아가는거지? 몇시였더라',
  },
  {
    title: '리포트 원문: 제출 횟수',
    userId: 'HK_GUARDIAN_BAE',
    asOf: '2026-11-10T18:00:00+09:00',
    question: '작은애 9월에 활동지 몇번 냈고 총 몇 문제였어요?',
  },
  {
    title: '리포트 원문: 채점 수정 이유',
    userId: 'HK_GUARDIAN_LIM',
    asOf: '2026-11-20T18:00:00+09:00',
    question: '도현이 리포트 왜 수정된 거예요? 몇번 문제요?',
  },
  {
    title: '후속 질문(취약 영역 기간 비교)',
    userId: 'HK_STUDENT_SUA',
    asOf: '2026-11-10T18:00:00+09:00',
    history: ['나 10월 리포트 취약 영역 뭐야?'],
    question: '그거 9월이랑 같은거야?',
  },
  {
    title: '등수는 자녀라도 안내하지 않음',
    userId: 'HK_GUARDIAN_LIM',
    asOf: '2026-11-18T22:30:00+09:00',
    question: '도현이 반에서 몇등쯤 해요? 중간은 가나요',
  },
  {
    title: '자료에 없는 질문은 보류',
    userId: 'HK_VISITOR',
    asOf: '2026-11-10T18:00:00+09:00',
    question: '작년에 여기서 과학고 몇 명 붙었어요?',
  },
  {
    title: '다른 원생 자료 요청은 거부',
    userId: 'HK_GUARDIAN_BAE',
    asOf: '2026-11-10T18:00:00+09:00',
    question: '임도현 10월 정답률 알려주세요',
  },
  {
    title: '[실패 사례] 자료에 없는 개념(현금영수증)에 관련 절로 과잉 응답',
    userId: 'HK_GUARDIAN_CHA',
    asOf: '2026-12-02T18:00:00+09:00',
    question: '수강료 현금영수증 발급 되죠? 계좌이체로 내려구요',
  },
  {
    title: '[실패 사례] 초등·중등 클리닉 시각 구분 실패',
    userId: 'HK_STUDENT_YENA',
    asOf: '2026-11-10T18:00:00+09:00',
    question: '실험반 끝나고 과제 클리닉 가려면 몇시에 가면 돼?',
  },
];

const V1: DemoItem[] = [
  {
    title: '형제 지칭 + 정답률·취약 영역',
    userId: 'GA_GUARDIAN_KIM',
    asOf: '2026-11-06T20:00:00+09:00',
    question: '둘째 10월 성적이랑 약한 단원 알려주세요',
  },
  {
    title: '셔틀 시간표 표의 칸',
    userId: 'SS_VISITOR',
    asOf: '2026-11-06T20:00:00+09:00',
    question: 'B노선 셔틀은 가람중학교 정문에서 중등 등원 차가 몇 시에 와요?',
  },
  {
    title: '원인 추정 요청은 보류',
    userId: 'GA_GUARDIAN_KIM',
    asOf: '2026-11-06T20:00:00+09:00',
    question: '첫째가 10월에 성적 떨어진 게 집중력 때문인가요?',
  },
  {
    title: '다른 학원 언급은 거부',
    userId: 'GA_GUARDIAN_KIM',
    asOf: '2026-11-06T20:00:00+09:00',
    question: '새솔영어학원 수강료도 알려주세요',
  },
  {
    title: '자녀가 둘인데 대상이 모호하면 확인',
    userId: 'GA_GUARDIAN_KIM',
    asOf: '2026-11-06T20:00:00+09:00',
    question: '우리 애 수강료 얼마예요?',
  },
];

async function run(
  dataset: AcademiesDataset,
  items: DemoItem[],
  label: string,
) {
  const store = await buildAcademiesStore(dataset, new InMemoryRagStore(), {
    ocr: null,
  });
  const catalog = createAcademyCatalogPort(dataset);
  const lines: string[] = [];
  for (const item of items) {
    const user = dataset.users.find((u) => u.user_id === item.userId);
    if (!user) throw new Error(item.userId);
    const access = toAcademyAccessScope(user, dataset.students);
    const service = createRagConsultationService({
      facts: store,
      documents: store,
      catalog,
      generation: new DisabledGenerationProvider(),
      handoff: new InMemoryHandoffStore(),
      conversations: new InMemoryConversationStore(),
      clock: new FixedClock(parseInstant(item.asOf)),
    });
    for (const turn of item.history ?? [])
      await service.query({ access, question: turn, conversationId: 'demo' });
    const { answer } = await service.query({
      access,
      question: item.question,
      conversationId: 'demo',
    });
    lines.push(
      `### ${item.title}`,
      '',
      `- 자료: ${label} · 계정: \`${item.userId}\`(${user.role}) · 기준 시각: ${item.asOf}`,
      ...(item.history?.length
        ? [`- 직전 질문: ${item.history.map((h) => `“${h}”`).join(', ')}`]
        : []),
      `- 질문: **${item.question}**`,
      `- 상태: \`${answer.status}\`${answer.missingFields?.length ? ` · 빠진 항목: ${answer.missingFields.join(', ')}` : ''}`,
      '',
      '```text',
      answer.answer,
      '```',
      '',
      answer.citations.length
        ? `인용: ${answer.citations.map((c) => `\`${c.sourceId}\`${c.location ? ` (${c.location})` : ''}`).join(', ')}`
        : '인용: 없음',
      '',
    );
  }
  return lines.join('\n');
}

const v2 = readAcademiesDataset(V2_DIR, { folders: ['AC_HANGYEOL'] });
const v1 = readAcademiesDataset();
console.log(
  await run(v2, HK, 'academies-v2 개발 학원(한결과학, PDF·스캔 원본)'),
);
console.log(await run(v1, V1, 'academies-v1(가온수학·새솔영어)'));
