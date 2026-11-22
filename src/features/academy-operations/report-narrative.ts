export interface LearningType {
  id: string;
  name: string;
  total: number;
  wrong: number;
}

interface LearningEvidence {
  total: number;
  correct: number;
  unknown: number;
  excluded?: number;
  sourceCount?: number;
  types: LearningType[];
  attendance?: { present: number; late: number; absent: number };
}

interface TypeComparison {
  current: LearningType;
  previous: LearningType;
  change: number;
}

function previousReportMonth(period: string) {
  const [year, month] = period.split('-').map(Number);
  if (month > 1) return period.slice(0, 5) + String(month - 1).padStart(2, '0');
  return year > 0 ? String(year - 1).padStart(4, '0') + '-12' : undefined;
}

function compareReportTypes(current: LearningType[], previous: LearningType[]) {
  const prior = new Map(previous.map((type) => [type.id, type]));
  return current
    .flatMap((type) => {
      const last = prior.get(type.id);
      if (
        type.total < 5 ||
        !last ||
        last.total < 5 ||
        typeName(type) !== typeName(last)
      )
        return [];
      return [
        {
          current: type,
          previous: last,
          change:
            Math.round(
              1000 * (last.wrong / last.total - type.wrong / type.total),
            ) / 10,
        },
      ];
    })
    .sort(
      (a, b) =>
        Math.abs(b.change) - Math.abs(a.change) ||
        b.current.total - a.current.total,
    )
    .slice(0, 2);
}

export function previousReportComparison(
  period: string,
  current: LearningType[],
  readTypes: (month: string) => LearningType[],
) {
  const month = previousReportMonth(period);
  if (!month || !current.some((type) => type.total >= 5)) return;
  const types = compareReportTypes(current, readTypes(month));
  if (types.length) return { period: month, types };
}

export function comparedReportFingerprint(current: string, previous: string) {
  return 'comparison-v1:' + current + ':' + previous;
}

export function reportMatchesEvidence(
  saved: string,
  current: string,
  readPrevious: () => string | undefined,
) {
  if (saved === current) return true;
  if (!saved.startsWith('comparison-v1:' + current + ':')) return false;
  const previous = readPrevious();
  return (
    previous !== undefined &&
    saved === comparedReportFingerprint(current, previous)
  );
}

const countWord = (n: number) => n + '문항';
const percent = (correct: number, total: number) =>
  Math.round((100 * correct) / total);
const correctCount = (type: LearningType) => type.total - type.wrong;
const typeName = (type: LearningType) =>
  type.name.replace(/\s+/gu, ' ').trim() || '등록 유형';
const named = (type: LearningType) => '「' + typeName(type) + '」';
const bullets = (lines: string[]) =>
  lines.map((line) => '- ' + line).join('\n');

function practiceRoutine(name: string) {
  if (/(통분|공통분모|분수.*(덧셈|뺄셈)|같은 분모|다른 분모)/u.test(name))
    return '분모가 같은지 먼저 표시하고, 다르면 공통분모로 바꾼 식을 한 줄 적은 뒤 계산합니다. 마지막에 분자와 분모를 각각 확인합니다.';
  if (/(분수|약분)/u.test(name))
    return '연산 기호와 분자·분모를 먼저 표시합니다. 중간 식을 한 줄 남기고, 답을 약분할 수 있는지 확인합니다.';
  if (/(그래프|좌표|기울기|함수)/u.test(name))
    return '주어진 값과 구할 값을 표에 적고, 식에서 구한 값이 좌표나 그래프에서도 맞는지 확인합니다.';
  if (/(방정식|부등식|문자와 식)/u.test(name))
    return '구하려는 값을 기호로 표시하고 식을 세웁니다. 구한 값을 처음 식에 대입해 양쪽이 조건을 만족하는지 확인합니다.';
  if (/(계산|연산|괄호)/u.test(name))
    return '먼저 계산할 부분에 표시하고 중간 식을 한 줄씩 씁니다. 마지막에 부호와 연산 순서를 다시 확인합니다.';
  if (/(지문|독해|근거 찾기|문장제)/u.test(name))
    return '문제가 묻는 말에 밑줄을 긋고, 답에 필요한 문장이나 수치를 골라 표시한 뒤 그 근거를 한 문장으로 설명합니다.';
  if (/(문법|과거형|시제|전치사|어순)/u.test(name))
    return '예문에서 답을 고른 단서를 표시하고 같은 규칙을 적용한 새 문장을 한 문장 직접 만들어 비교합니다.';
  if (/(어휘|단어|뜻)/u.test(name))
    return '단어의 뜻을 보지 않고 말해 본 뒤 짧은 예문을 만듭니다. 다음 날 같은 단어를 순서를 바꿔 다시 확인합니다.';
  return '대표 문제에서 문제의 요구와 풀이 근거를 각각 표시한 뒤, 조건이 조금 다른 새 문제에 같은 풀이를 적용합니다.';
}

export function buildLearningNarrative(
  evidence: LearningEvidence,
  comparison?: { period: string; types: TypeComparison[] },
) {
  const { total, correct, unknown, attendance } = evidence;
  const types = evidence.types.filter((type) => type.total > 0);
  const chart = types
    .slice()
    .sort((a, b) => b.total - a.total)
    .slice(0, 12);
  const strengths = types
    .filter(
      (type) => type.total >= 3 && correctCount(type) * 4 >= type.total * 3,
    )
    .sort((a, b) => a.wrong / a.total - b.wrong / b.total || b.total - a.total)
    .slice(0, 2);
  const focus = types
    .filter((type) => type.wrong > 0)
    .sort((a, b) => b.wrong - a.wrong || b.wrong / b.total - a.wrong / a.total)
    .slice(0, 3);
  const score = total
    ? `교사 확정 ${total}문항 중 ${correct}문항 정답 (${percent(correct, total)}%).`
    : '이 기간에 교사가 확정한 채점 기록이 없습니다.';

  const summary = [
    evidence.sourceCount
      ? `확정된 학습 결과 ${evidence.sourceCount}건을 검토했습니다.`
      : '',
    total
      ? correct === total
        ? '채점 가능한 문항은 모두 정답이었습니다.'
        : `채점 가능한 문항 중 ${total - correct}문항은 완전 정답으로 확인되지 않았습니다.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  const table = chart.length
    ? [
        '| 학습 유형 | 정답 | 전체 |',
        '| --- | ---: | ---: |',
        ...chart.map(
          (type) =>
            `| ${typeName(type).replaceAll('|', '｜')} | ${correctCount(type)} | ${type.total} |`,
        ),
      ].join('\n')
    : '';
  const solid = strengths.length
    ? bullets(
        strengths.map(
          (type) =>
            `${named(type)}에서 ${type.total}문항 중 ${correctCount(type)}문항을 맞혔습니다. 다음에는 조건이 달라져도 같은 풀이를 적용하는지 확인해 보세요.`,
        ),
      )
    : '';
  const review = focus.length
    ? bullets(
        focus.map(
          (type) =>
            `${named(type)} ${type.total}문항 중 ${correctCount(type)}문항은 정답, ${type.wrong}문항은 완전 정답에 도달하지 않았습니다. ${type.wrong >= 2 ? '같은 유형에서 두 문항 이상 확인되어 우선 복습할 부분입니다.' : '비슷한 문제를 한 번 더 풀어 같은 부분에서 어려움이 있는지 살펴보세요.'}`,
        ),
      )
    : '';
  const practice = focus.slice(0, 2).map((type) => {
    const attempts = Math.min(5, Math.max(3, type.wrong + 1));
    return `${named(type)} 새 문제 ${countWord(attempts)}를 풀어 봅니다. ${practiceRoutine(typeName(type))} 다음 확인 때 처음 본 문제 한 개를 스스로 풀고 풀이 순서를 설명해 보세요.`;
  });
  const next = focus.length
    ? '먼저 연습할 유형은 ' +
      focus.slice(0, 2).map(named).join(', ') +
      '입니다.'
    : total && correct === total
      ? '비슷한 새 문제를 한 번 더 풀고, 답을 고른 이유를 말해 봅니다.'
      : total
        ? '다음 수업에서 확인한 답안 중 한 문제를 골라 풀이를 함께 점검합니다.'
        : '교사가 채점을 확정하면 확인된 유형에 맞춰 연습을 제안할 수 있습니다.';
  const prior = comparison?.types.map(
    ({ current, previous, change }) =>
      `${named(current)} ${comparison.period.replace('-', '년 ')}월 ${correctCount(previous)}/${previous.total}문항 정답 → 이번 기간 ${correctCount(current)}/${current.total}문항 정답. ${change === 0 ? '기록상 정답률은 같았습니다.' : `기록상 정답률이 ${Math.abs(change)}%p ${change > 0 ? '높았습니다' : '낮았습니다'}.`}`,
  );
  const attendanceDetails =
    attendance && attendance.present + attendance.late + attendance.absent > 0
      ? [
          `출석 ${attendance.present}회 · 지각 ${attendance.late}회 · 결석 ${attendance.absent}회`,
          ...(attendance.absent || attendance.late
            ? [
                '놓친 수업 내용이나 진행 중 안내를 확인하고, 필요한 부분은 다음 수업 전에 정리해 주세요.',
              ]
            : []),
        ]
      : ['이 기간에 기록된 출결이 없습니다.'];
  const coverage = [];
  if (unknown)
    coverage.push(
      `아직 확인되지 않은 ${countWord(unknown)}은 정답률 계산에서 제외했습니다.`,
    );
  if (evidence.excluded)
    coverage.push(
      `확정 기록 중 평가 제외·채점 불가 ${countWord(evidence.excluded)}은 정답률 계산에서 제외했습니다.`,
    );
  if (total && total < 5)
    coverage.push(
      '확인된 문항이 적어 이번 기록은 다음 수업에서 살펴볼 항목을 고르는 데 활용해 주세요.',
    );
  if (types.length > chart.length)
    coverage.push(
      `유형별 그래프에는 기록이 많은 ${chart.length}개 유형을 표시했습니다.`,
    );

  const body = [
    '## 성취도',
    score,
    table,
    summary ? '## 이번 기간 학습 요약' : '',
    summary,
    solid ? '## 잘한 부분' : '',
    solid,
    review ? '## 더 살펴볼 부분' : '',
    review,
    prior?.length ? '## 지난달과 비교' : '',
    prior?.length ? bullets(prior) : '',
    '## 다음 학습',
    next,
    practice.length ? '### 구체적인 연습 방법' : '',
    practice.length ? bullets(practice) : '',
    ...(attendance ? ['## 출결', ...attendanceDetails] : []),
    coverage.length ? '## 집계 범위' : '',
    coverage.length ? bullets(coverage) : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const teacher = [
    '# 교사용 상담 자료 초안',
    '## 확인된 학습 결과',
    score,
    summary,
    '## 상담에서 물어볼 질문',
    focus.length
      ? bullets(
          focus
            .slice(0, 2)
            .map(
              (type) =>
                `${named(type)} 문제를 풀 때 무엇부터 확인했나요? 대표 문항 한 개로 풀이 순서를 함께 확인해 보세요.`,
            ),
        )
      : correct
        ? '이번에 맞힌 문제 중 하나를 골라 어떤 근거로 답을 구했는지 물어봅니다.'
        : total
          ? '정답에 도달하지 못한 대표 문항을 골라 어디까지 풀이했는지 함께 살펴봅니다.'
          : '어떤 과제를 먼저 확인할지 정하고, 미확정 채점 기록을 검토합니다.',
    '## 다음 수업에서 확인할 것',
    focus.length
      ? bullets(
          focus
            .slice(0, 2)
            .map(
              (type) =>
                `${named(type)}에서 조건을 바꾼 문제 한 개를 제시합니다. 힌트 없이 시작하는지, 풀이 순서와 검산을 설명할 수 있는지 각각 확인합니다.`,
            ),
        )
      : next,
    coverage.length ? '## 기록 확인' : '',
    coverage.length ? bullets(coverage) : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return { body, teacher };
}
