// 문항의 대분류 하나를 추천한다(수학: 계산·이해·추론·문제 해결, 영어: 평가원 평가 요소 7개).
// 고3 모의고사 4개월(한 달씩 처음 보는 달로 두고 나머지 세 달을 예시 후보로 쓰는 측정)에서 대분류를 바로
// 고르게 하는 방식이 소분류 태그를 먼저 정하는 방식보다 나았고, 비슷한 실제 문항과 그 대분류를 예시로 주면
// 더 나았다. 수학 184문항: 소분류 경유 27~33% → 직접 54% → 같은 과목 예시 64%(배점·번호를 지운 교재 조건).
// 영어 104문항(PDF 글자층): 기존 소분류 분류 73% → 직접 84% → 지어낸 발문 예시 87% → 실제 문항 예시 99%.
// 학원 교재 문항 원문은 저장하지 않기로 했으므로 실제 문항 예시는 쓰지 않고, 새로 지은 예시만 쓴다
// (수학은 같은 예시로 54%, 영어는 87%였다).

const compact = (area) => String(area ?? '').replace(/\s+/g, '');
const K = 6;

// 내용 유사도: 글자 bigram 빈도의 코사인. 수학은 공백만 지우고(단원 낱말과 수식이 함께 반영된다),
// 영어는 한글만 남긴다(지문 내용은 문항마다 제각각이라 유형과 무관하게 가까워지고, 발문은 한글이다).
function bigrams(t) {
  const m = new Map();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [g, c] of a) {
    na += c * c;
    dot += c * (b.get(g) ?? 0);
  }
  for (const c of b.values()) nb += c * c;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// 수학은 측정 때와 같이 배점과 선택지를 지운다. 선택지가 남아 있으면 모델이 대분류 대신 풀이를 쓰는 경우가
// 있었다. 영어는 측정 때와 같이 원문을 그대로 쓴다.
export function areaText(text) {
  return String(text ?? '')
    .replace(/\[\s*\$?\s*\d+\s*\$?\s*점\s*\]/g, '')
    .split('\n')
    .filter((line) => !/^\s*[①②③④⑤]/.test(line))
    .join('\n')
    .trim();
}

const MATH = {
  // 지시문에는 측정 때와 같이 '문제해결'로 쓰고, 돌려주는 값은 소분류 목록(tags.json)의
  // 표기('문제 해결')를 쓴다. 띄어쓰기만 다르므로 공백을 지워 맞춘다.
  areas: ['계산', '이해', '추론', '문제 해결'],
  promptName: compact,
  definitions: [
    '수학 문항의 대분류를 하나 고른다. 대분류는 평가원 출제의도 방식으로 정한다.',
    '- 계산: 주어진 식에 정해진 연산이나 공식 하나를 적용해 값을 계산한다(지수 계산, 미분계수, 부정적분 값, 극한값, 순열·조합의 수, 확률 계산).',
    '- 이해: 특정 개념(수열, 연속, 로그·삼각함수의 성질, 정적분과 넓이, 극값, 사인·코사인법칙, 순열·조합 등)의 정의나 성질을 이해하여 값을 구한다. 뒤따르는 계산이 있어도 개념 적용이 핵심이면 이해다.',
    '- 추론: 여러 조건을 모두 만족시키는 함수·수열·경우를 이끌어 내거나 그 개수·성질을 추론한다.',
    '- 문제해결: 그래프·도형·여러 개념과 조건을 엮어 넓이·거리·상수 등을 여러 단계로 구하는 문제를 해결한다.',
    '원문의 수식이 일부 깨져 있어도 가장 가까운 대분류를 반드시 하나 고른다.',
    'JSON 하나로만 답한다: {"area":"계산|이해|추론|문제해결"}',
  ].join('\n'),
  // 예시. 평가원 출제의도(예: '지수법칙 계산하기'→계산,
  // '수열의 귀납적 정의를 이용하여 추론하기'→추론)에 맞춰 새로 지은 문항이다.
  starters: [
    ['$4^{\\frac{3}{2}}\\times 2^{-1}$의 값은?', '계산'],
    ["함수 $f(x)=2x^{3}-x$에 대하여 $f'(1)$의 값은?", '계산'],
    ['$\\lim_{n\\to\\infty}\\frac{3n^{2}+1}{n^{2}-2n}$의 값은?', '계산'],
    [
      '등차수열 $\\{a_{n}\\}$에 대하여 $a_{2}=5$, $a_{5}=14$일 때, $a_{10}$의 값은?',
      '이해',
    ],
    [
      '함수 $f(x)=\\begin{cases}x^{2}+a & (x<1)\\\\ 3x-1 & (x\\geq1)\\end{cases}$가 $x=1$에서 연속일 때, 상수 $a$의 값은?',
      '이해',
    ],
    [
      '$0<\\theta<\\frac{\\pi}{2}$이고 $\\sin\\theta=\\frac{3}{5}$일 때, $\\tan\\theta$의 값은?',
      '이해',
    ],
    ['곡선 $y=x^{2}-2x$와 $x$축으로 둘러싸인 부분의 넓이는?', '이해'],
    [
      "다음 조건을 만족시키는 삼차함수 $f(x)$에 대하여 $f(3)$의 값을 구하시오. (가) $f(0)=0$ (나) 모든 실수 $x$에 대하여 $f'(x)\\geq f'(1)$",
      '추론',
    ],
    [
      '수열 $\\{a_{n}\\}$이 $a_{n+1}=\\begin{cases}a_{n}-3 & (a_{n}\\geq0)\\\\ a_{n}+5 & (a_{n}<0)\\end{cases}$을 만족시키고 $a_{4}=0$일 때, 가능한 모든 $a_{1}$의 값의 합은?',
      '추론',
    ],
    [
      '곡선 $y=2^{x}$ 위의 점 A와 곡선 $y=\\log_{2}x$ 위의 점 B가 직선 $y=-x+k$ 위에 있다. $\\overline{AB}=2\\sqrt{2}$일 때, 삼각형 OAB의 넓이는?',
      '문제해결',
    ],
    [
      '그림과 같이 원에 내접하는 삼각형 ABC에서 $\\overline{AB}=4$, $\\angle ACB=\\frac{\\pi}{3}$일 때, 삼각형 ABC의 넓이의 최댓값을 구하시오.',
      '문제해결',
    ],
  ],
  // 예시 11개를 모두 붙인다(측정 조건과 같다).
  allStarters: true,
  grams: (text) => bigrams(text.replace(/\s+/g, '').toLowerCase()),
  prepare: areaText,
  show: (text) => (text.length > 350 ? text.slice(0, 350) + '…' : text),
};

const ENGLISH = {
  areas: [
    '중심 내용 파악',
    '세부 정보 파악',
    '함축적 의미 추론',
    '맥락 파악',
    '간접 말하기',
    '간접 쓰기',
    '언어형식·어휘',
  ],
  promptName: (area) => area,
  // 정의는 영어 기준서(tags.json의 소분류 14개)를 대분류별로 묶은 것이다.
  definitions: [
    '영어 문항의 대분류를 하나 고른다. 대분류는 평가원 평가 요소로 정하며 발문(무엇을 고르라고 하는지)으로 판단한다. 문제를 풀지 않는다.',
    '- 중심 내용 파악: 글의 주제·요지·제목을 고른다.',
    '- 세부 정보 파악: 글·안내문·도표에 명시된 정보와 일치하거나 일치하지 않는 것을 고른다.',
    '- 함축적 의미 추론: 밑줄 친 표현이 글에서 뜻하는 바를 고른다.',
    '- 맥락 파악: 글의 목적, 필자의 주장·의견, 등장인물의 심경·분위기, 문맥으로 빈칸에 들어갈 내용을 추론한다.',
    '- 간접 말하기: 대화에서 다음에 할 말이나 상황에 맞는 응답을 고른다.',
    '- 간접 쓰기: 주어진 문장의 위치, 글의 순서, 흐름과 관계없는 문장, 요약문 빈칸을 고른다.',
    '- 언어형식·어휘: 어법상 틀린 것, 문맥상 낱말의 쓰임이 적절하지 않은 것, 밑줄 친 대상이 가리키는 것을 고른다.',
    'JSON 하나로만 답한다: {"area":"중심 내용 파악|세부 정보 파악|함축적 의미 추론|맥락 파악|간접 말하기|간접 쓰기|언어형식·어휘"}',
  ].join('\n'),
  // 예시. 소분류마다 흔한 발문 형태와 새로 지은 짧은 영어 문장으로
  // 만들었다(시험 문항을 옮긴 것이 아니다). 이 예시만 쓸 때 4개월 104문항에서 86.5%였다.
  starters: [
    [
      '다음 글의 주제로 가장 적절한 것은? Many people believe that sleep is wasted time.',
      '중심 내용 파악',
    ],
    [
      '다음 글의 요지로 가장 적절한 것은? Small daily habits shape who we become.',
      '중심 내용 파악',
    ],
    [
      '다음 글의 제목으로 가장 적절한 것은? Cities are planting trees on rooftops.',
      '중심 내용 파악',
    ],
    [
      'City Library Book Fair에 관한 다음 안내문의 내용과 일치하지 않는 것은? The fair opens at 10 a.m. on Saturday.',
      '세부 정보 파악',
    ],
    [
      'Mary Lin에 관한 다음 글의 내용과 일치하지 않는 것은? Mary Lin was born in a small village in 1921.',
      '세부 정보 파악',
    ],
    [
      '다음 도표의 내용과 일치하지 않는 것은? The graph above shows the percentage of students who walk to school.',
      '세부 정보 파악',
    ],
    [
      '밑줄 친 open the window가 다음 글에서 의미하는 바로 가장 적절한 것은? To learn, you must open the window.',
      '함축적 의미 추론',
    ],
    [
      '다음 글의 목적으로 가장 적절한 것은? Dear residents, we are writing to let you know about the repair work.',
      '맥락 파악',
    ],
    [
      '다음 글에서 필자가 주장하는 바로 가장 적절한 것은? Schools should give students more time outdoors.',
      '맥락 파악',
    ],
    [
      '다음 글에 드러난 Tom의 심경 변화로 가장 적절한 것은? Tom waited nervously, but then he heard his name.',
      '맥락 파악',
    ],
    [
      '다음 빈칸에 들어갈 말로 가장 적절한 것을 고르시오. Good teachers know that learning begins with ________.',
      '맥락 파악',
    ],
    [
      '대화를 듣고, 남자의 마지막 말에 대한 여자의 응답으로 가장 적절한 것을 고르시오.',
      '간접 말하기',
    ],
    [
      '글의 흐름으로 보아, 주어진 문장이 들어가기에 가장 적절한 곳을 고르시오. However, the plan soon failed.',
      '간접 쓰기',
    ],
    [
      '주어진 글 다음에 이어질 글의 순서로 가장 적절한 것을 고르시오. (A) Then the rain stopped. (B) At first, nobody moved.',
      '간접 쓰기',
    ],
    [
      '다음 글에서 전체 흐름과 관계 없는 문장은? ① Bees help plants grow. ② Honey is sweet.',
      '간접 쓰기',
    ],
    [
      '다음 글의 내용을 한 문장으로 요약하고자 한다. 빈칸 (A), (B)에 들어갈 말로 가장 적절한 것은?',
      '간접 쓰기',
    ],
    [
      '다음 글의 밑줄 친 부분 중, 어법상 틀린 것은? The book ①which I read ②were interesting.',
      '언어형식·어휘',
    ],
    [
      '다음 글의 밑줄 친 부분 중, 문맥상 낱말의 쓰임이 적절하지 않은 것은? The ①rare bird was ②common everywhere.',
      '언어형식·어휘',
    ],
    [
      '밑줄 친 (a)~(e) 중에서 가리키는 대상이 나머지 넷과 다른 것은? (a) She smiled at (b) her sister.',
      '언어형식·어휘',
    ],
  ],
  // 예시 19개 중 발문이 가장 비슷한 K개를 붙인다(측정 조건과 같다).
  allStarters: false,
  grams: (text) => bigrams(text.replace(/[^가-힣]/g, '')),
  prepare: (text) => String(text ?? '').trim(),
  // 예시에는 발문이 보이도록 한글 문장과 지문 앞부분만 짧게 넣는다.
  show: (text) =>
    (
      text
        .split('\n')
        .filter((l) => /[가-힣]{2,}/.test(l))
        .join(' ') +
      ' / ' +
      text.replace(/\s+/g, ' ').slice(0, 160)
    ).slice(0, 350),
};

const SUBJECTS = { M: MATH, E: ENGLISH };
function config(subject) {
  const c = SUBJECTS[subject];
  if (!c) throw Error('대분류 추천은 수학(M)·영어(E)만 지원합니다.');
  return c;
}
// 목록의 대분류 이름(띄어쓰기 무시)으로 맞춘다. 목록 밖이면 null.
const catalogName = (c, area) =>
  c.areas.find((a) => compact(a) === compact(area)) ?? null;

export const STARTER_EXAMPLES = MATH.starters.map(([text, area]) => ({
  text,
  area,
}));
export const ENGLISH_STARTER_EXAMPLES = ENGLISH.starters.map(
  ([text, area]) => ({ text, area }),
);

// 예시 고르기: 수학은 예시 전부, 영어는 발문이 가장 비슷한 K개.
// 돌려주는 area는 지시문에 쓰는 표기(수학은 공백 없는 '문제해결')다.
export function chooseExamples(text, subject = 'M', k = K) {
  const c = config(subject);
  const starters = c.starters.map(([t, area]) => ({
    text: t,
    area: c.promptName(catalogName(c, area)),
  }));
  if (c.allStarters) return starters;
  const target = c.grams(text);
  return starters
    .map((p) => ({ p, s: cosine(target, c.grams(p.text)) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map(({ p }) => p);
}

export function buildAreaPrompt(text, subject = 'M') {
  const c = config(subject);
  const examples = chooseExamples(c.prepare(text), subject);
  return [
    c.definitions,
    '아래는 비슷한 문항과 그 대분류다. 같은 기준으로 판단한다.',
    ...examples.map((e) => `문항: ${c.show(e.text)}\n답: {"area":"${e.area}"}`),
  ].join('\n');
}

// 응답 전체를 JSON으로 읽지 않고 area 값만 꺼낸다(수식 역슬래시로 JSON이 깨지는 경우를 피한다).
// JSON 없이 대분류 이름만 답한 경우("계산", "답: 이해")에는 처음 나온 대분류 이름을 쓴다.
export function parseArea(content, subject = 'M') {
  const c = config(subject);
  const found = [...String(content).matchAll(/"area"\s*:\s*"([^"]*)"/g)].at(
    -1,
  )?.[1];
  if (found !== undefined) return catalogName(c, found);
  const body = compact(content);
  let first = null;
  for (const area of c.areas) {
    const at = body.indexOf(compact(area));
    if (at >= 0 && (first === null || at < first.at)) first = { area, at };
  }
  return first?.area ?? null;
}

export async function suggestArea(subject, text) {
  const c = config(subject);
  const key =
    process.env.CLOVA_STUDIO_API_KEY?.trim() ||
    process.env.RAG_CLOVA_API_KEY?.trim();
  if (!key) throw Error('.env.local에 CLOVA_STUDIO_API_KEY를 설정하세요.');
  const model = process.env.CLASSIFICATION_MODEL?.trim() || 'HCX-007';
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(
      'https://clovastudio.stream.ntruss.com/v3/chat-completions/' +
        encodeURIComponent(model),
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(60000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + key,
        },
        body: JSON.stringify({
          ...(model === 'HCX-007'
            ? { maxCompletionTokens: 200, thinking: { effort: 'none' } }
            : { maxTokens: 200 }),
          messages: [
            { role: 'system', content: buildAreaPrompt(text, subject) },
            { role: 'user', content: '문항: ' + c.prepare(text) },
          ],
        }),
      },
    );
    if (response.status === 429 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (!response.ok)
      throw Error('CLOVA Studio HTTP ' + response.status + ' (' + model + ')');
    const reply = await response.json();
    return parseArea(reply.result?.message?.content ?? '', subject);
  }
}
