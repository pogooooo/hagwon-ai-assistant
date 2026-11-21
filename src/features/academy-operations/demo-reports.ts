import { accessibleStudents } from './directory.ts';
import { one, type PageContext } from './shared.ts';

const academies = {
  AC_TEST_A: {
    academy: '[가상] 테스트 교습소',
    student: 'TA_STU_001',
    classId: 'TA_E_MATH',
    className: '초등 수학반',
    lessons: [
      {
        month: '2026-11',
        unit: '분수의 덧셈과 뺄셈',
        sessions: [7, 1, 0],
        rows: [
          ['같은 분모의 덧셈', 8, 8],
          ['다른 분모의 덧셈', 5, 8],
          ['분수의 뺄셈', 7, 8],
        ],
        comment:
          '같은 분모의 덧셈은 풀이 순서가 안정적입니다. 분모가 다를 때 공통분모로 바꾸면서 분자를 그대로 두는 실수가 세 번 있었습니다.',
        next: '분모가 2·3·4인 분수의 덧셈 4문항을 풀고, 통분한 두 분수를 식의 첫 줄에 적어 봅니다.',
      },
      {
        month: '2026-10',
        unit: '약수와 배수',
        sessions: [8, 0, 0],
        rows: [
          ['약수 찾기', 7, 8],
          ['최대공약수', 6, 8],
          ['최소공배수 활용', 6, 8],
        ],
        comment:
          '약수는 작은 수부터 빠짐없이 찾는 편입니다. 두 주기가 처음 겹치는 시점을 구하는 문항에서 공약수와 공배수를 혼동했습니다.',
        next: '두 일정이 다시 겹치는 날을 표로 표시하고, 가장 작은 공통 배수와 맞는지 확인합니다.',
      },
      {
        month: '2026-09',
        unit: '자연수의 혼합 계산',
        sessions: [7, 0, 1],
        rows: [
          ['괄호가 있는 식', 6, 8],
          ['곱셈과 나눗셈', 7, 8],
          ['두 단계 문장제', 5, 8],
        ],
        comment:
          '계산 기호의 우선순위는 잘 적용합니다. 문장제에서 계산에 쓸 두 양을 구분하는 연습이 더 필요합니다.',
        next: '문장제 3문항에서 구하는 값에 밑줄을 긋고, 첫 번째 식과 두 번째 식을 따로 씁니다.',
      },
    ],
  },
  AC_ONDAP_LANGUAGE_DEMO: {
    academy: '[가상] 온답 어학원',
    student: 'ONDAP_DEMO_LEARNER',
    classId: 'ONDAP_DEMO_ENGLISH',
    className: '영어 회화반',
    lessons: [
      {
        month: '2026-11',
        unit: '일과와 약속 시간 말하기',
        sessions: [6, 1, 0],
        rows: [
          ['일과 표현', 6, 6],
          ['시간 전치사', 4, 7],
          ['약속 정하기', 4, 5],
        ],
        comment:
          '일과를 말할 때 동사를 적절하게 골랐습니다. 시각 앞의 at과 요일 앞의 on을 세 문항에서 바꾸어 썼습니다.',
        next: '같은 약속을 시각·요일·월 단위로 바꿔 말하며 at, on, in을 한 번씩 사용합니다.',
      },
      {
        month: '2026-10',
        unit: '지난 주말 이야기하기',
        sessions: [7, 0, 0],
        rows: [
          ['규칙 동사의 과거형', 6, 6],
          ['불규칙 동사의 과거형', 3, 6],
          ['후속 질문 만들기', 5, 6],
        ],
        comment:
          '규칙 동사의 과거형은 정확하게 사용합니다. 불규칙 동사에서는 현재형으로 돌아가는 실수가 있었습니다.',
        next: 'go, see, have의 과거형을 써서 지난 주말에 한 일을 세 문장으로 설명합니다.',
      },
      {
        month: '2026-09',
        unit: '길 묻고 설명하기',
        sessions: [6, 0, 1],
        rows: [
          ['목적지 묻기', 5, 5],
          ['장소의 위치 관계', 3, 6],
          ['이동 순서 설명', 4, 5],
        ],
        comment:
          '목적지를 먼저 묻는 표현이 자연스럽습니다. 지도에서 맞은편과 바로 옆을 설명하는 표현을 혼동했습니다.',
        next: '지도를 보며 next to, across from, between이 들어간 문장을 각각 한 개씩 만듭니다.',
      },
    ],
  },
} as const;

// Read-only historical demo documents. They are never used as RAG or notification evidence.
export function demoReports(ctx: PageContext) {
  const key = ctx.actor.academyId;
  if (!ctx.showDemoRecords || !Object.hasOwn(academies, key)) return [];
  const data = academies[key as keyof typeof academies];
  if (
    !one(
      ctx.db,
      'SELECT 1 FROM academies WHERE id=? AND name=?',
      key,
      data.academy,
    )
  )
    return [];
  const student = accessibleStudents(ctx.db, ctx.actor).find(
    (s) => s.id === data.student && s.classIds.includes(data.classId),
  );
  if (!student) return [];
  return data.lessons.map((lesson) => {
    const correct = lesson.rows.reduce((sum, [, value]) => sum + value, 0);
    const total = lesson.rows.reduce((sum, [, , value]) => sum + value, 0);
    const title = lesson.month.replace('-', '년 ') + '월 학습 리포트';
    const progress = [
      '| 학습 유형 | 정답 | 전체 |',
      '| --- | ---: | ---: |',
      ...lesson.rows.map(
        ([name, value, count]) =>
          '| ' + name + ' | ' + value + ' | ' + count + ' |',
      ),
    ].join('\n');
    return {
      id: 'archived-' + lesson.month,
      period: lesson.month,
      studentName: student.name,
      studentId: student.id,
      classId: data.classId,
      className: data.className,
      title,
      unit: lesson.unit,
      body: [
        '# ' + title,
        student.name + ' · ' + data.className + ' · ' + lesson.unit,
        '## 성취도',
        correct +
          ' / ' +
          total +
          '문항 정답 · ' +
          Math.round((correct * 100) / total) +
          '%',
        progress,
        '## 교사 코멘트',
        lesson.comment,
        '## 다음 학습',
        lesson.next,
        '## 출결',
        '출석 ' +
          lesson.sessions[0] +
          '회 · 지각 ' +
          lesson.sessions[1] +
          '회 · 결석 ' +
          lesson.sessions[2] +
          '회',
      ].join('\n\n'),
    };
  });
}
