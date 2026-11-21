import { escapeHtml as h, type PageContext } from './shared.ts';

interface Example {
  title: string;
  confirmed: string;
  progress: string;
  practice: string;
  attendance: string;
}
const examples: Readonly<Record<string, readonly Example[]>> = {
  AC_TEST_A: [
    {
      title: '초등 수학 · 분수 계산',
      confirmed: '20문항 중 16문항 정답',
      progress:
        '분모가 같은 분수는 안정적으로 계산했습니다. 분모가 다른 분수의 통분에서 오답이 3번 있었습니다.',
      practice:
        '분모 2·3·4가 섞인 덧셈 4문항에서 식을 통분하는 과정까지 적어 보세요.',
      attendance: '출석 8회',
    },
    {
      title: '중등 수학 · 일차함수',
      confirmed: '24문항 중 18문항 정답',
      progress:
        '그래프에서 절편을 읽는 문항은 모두 맞혔습니다. 두 점으로 기울기를 구하는 유형에서 4문항을 틀렸습니다.',
      practice:
        '두 점의 좌표를 표에 적고, 세로 변화량을 가로 변화량으로 나누는 과정을 연습합니다.',
      attendance: '출석 7회 · 지각 1회',
    },
    {
      title: '고등 수학 · 이차함수',
      confirmed: '20문항 중 17문항 정답',
      progress:
        '꼭짓점과 대칭축은 정확하게 계산했습니다. 정의역이 제한된 최댓값·최솟값 유형에서 3문항을 틀렸습니다.',
      practice: '정의역의 양 끝과 꼭짓점에서 함숫값을 구하고 서로 비교합니다.',
      attendance: '출석 7회 · 결석 1회',
    },
  ],
  AC_ONDAP_LANGUAGE_DEMO: [
    {
      title: '영어 회화 · 일상과 시간',
      confirmed: '16문항 중 13문항 정답',
      progress:
        '일과를 말할 때 동사를 적절하게 골랐습니다. 시각을 표현하는 전치사를 3문항에서 혼동했습니다.',
      practice:
        '같은 하루 일과를 시각·요일·월 단위로 바꿔 말하며 at, on, in을 비교합니다.',
      attendance: '출석 6회',
    },
    {
      title: '영어 회화 · 지난 주말',
      confirmed: '18문항 중 14문항 정답',
      progress:
        '규칙 동사의 과거형은 잘 사용했습니다. 자주 쓰는 불규칙 과거형에서 오답이 3번 있었습니다.',
      practice:
        'go, see, have의 과거형을 써서 지난 주말에 한 일을 세 문장으로 설명합니다.',
      attendance: '출석 5회 · 지각 1회',
    },
    {
      title: '영어 회화 · 길 묻고 설명하기',
      confirmed: '15문항 중 12문항 정답',
      progress:
        '목적지를 묻는 표현은 정확했습니다. 지도에서 두 장소의 위치 관계를 설명하는 유형에서 3문항을 틀렸습니다.',
      practice:
        '간단한 지도를 보며 next to, across from, between을 각각 한 문장에 사용합니다.',
      attendance: '출결 기록 없음',
    },
  ],
};

export function renderReportExamples(ctx: PageContext) {
  if (!ctx.showReportExamples || !Object.hasOwn(examples, ctx.actor.academyId))
    return '';
  const available = examples[ctx.actor.academyId];
  const selected = Number(ctx.url.searchParams.get('example')) - 1;
  const sample = available[selected];
  return `<section class="panel" aria-labelledby="report-examples-title"><h2 id="report-examples-title">리포트 예시</h2>
    <p>월간 리포트에 표시되는 내용입니다. 아래 예시는 가상의 학습 기록입니다.</p>
    <nav class="report-example-list" aria-label="리포트 예시 선택">${available
      .map(
        ({ title }, i) =>
          `<a class="workspace-link" href="/student-reports?example=${i + 1}#report-example"${selected === i ? ' aria-current="true"' : ''}>${h(title)}</a>`,
      )
      .join('')}</nav>
    ${
      sample
        ? `<article class="report-example-section" id="report-example"><h3>${h(sample.title)}</h3>
      <dl><dt>학습 결과</dt><dd>${h(sample.confirmed)}</dd><dt>관찰 내용</dt><dd>${h(sample.progress)}</dd><dt>다음 연습</dt><dd>${h(sample.practice)}</dd><dt>출결</dt><dd>${h(sample.attendance)}</dd></dl></article>`
        : ''
    }
  </section>`;
}
