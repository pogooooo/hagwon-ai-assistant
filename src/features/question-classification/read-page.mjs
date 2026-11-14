import { z } from 'zod';
import { compareMathReadings, visionChat } from './read-image.mjs';

// 설계 문서 5단계: 한 사진에서 문항 경계를 나누고, 그림·표·그래프 정보를
// 항목별 읽은 방식(적힌 값/눈금에서 읽음/모양에서 추정)과 상태(선명/불명)로 기록한다.
const nonempty = z.string().trim().min(1);
export const figureSchema = z.object({
  dependence: z.enum(['필수', '보조', '없음']),
  reads: z.array(
    z.object({
      content: nonempty,
      method: z.enum(['적힌 값', '눈금에서 읽음', '모양에서 추정']),
      state: z.enum(['선명', '불명']),
    }),
  ),
});
// 판독 모델에는 중첩 없는 납작한 형식을 요구하고, 받은 값을 내부 figure 구조로 바꾼다.
const rawReadingSchema = z.object({
  items: z
    .array(
      z.object({
        displayNumber: nonempty,
        text: z.string(),
        figureDependence: z.string().optional(),
        figureReads: z.array(z.string()).optional(),
      }),
    )
    .min(1),
});

// 어긋난 값은 버리지 않고 보수적으로 강등한다: 모르는 읽은 방식은 '모양에서 추정',
// 모르는 상태는 '불명'으로 두어 이후 그림 보류 규칙이 걸리게 한다.
const methods = ['적힌 값', '눈금에서 읽음', '모양에서 추정'];
function toFigure(dependenceText = '', lines = []) {
  const dependence = dependenceText.includes('필수')
    ? '필수'
    : dependenceText.includes('보조')
      ? '보조'
      : '없음';
  const reads = lines
    .filter((line) => line.trim())
    .map((line) => {
      const parts = line.split('|').map((part) => part.trim());
      const [content, method = '', state = ''] =
        parts.length > 2
          ? [parts.slice(0, -2).join(' | '), ...parts.slice(-2)]
          : parts;
      return {
        content: content || '[불명]',
        method: methods.find((name) => name === method) ?? '모양에서 추정',
        state: state === '선명' ? '선명' : '불명',
      };
    });
  return dependence === '없음' && !reads.length
    ? undefined
    : { dependence, reads };
}
const crossCheckSchema = z.object({
  items: z.array(
    z.object({
      displayNumber: nonempty,
      verdict: z.enum(['일치', '차이']),
      note: z.string().optional(),
    }),
  ),
});

const stripFence = (content) =>
  content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');

// 판독 모델이 JSON 문자열 안에 그대로 넣은 개행과 잘못된 이스케이프(예: LaTeX의 \f)를
// 유효한 JSON으로 복구한다. 따옴표 안팎만 추적하는 결정적 변환이라 내용은 바꾸지 않는다.
export function repairJsonText(json) {
  let out = '';
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
    } else if (ch === '\\') {
      const next = json[i + 1] ?? '';
      if ('"\\/bfnrtu'.includes(next)) {
        out += ch + next;
        i++;
      } else out += '\\\\';
    } else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch !== '\r') out += ch;
  }
  return out;
}

const parseWith =
  (schema, convert = (item) => item) =>
  (content) => {
    try {
      const json = JSON.parse(repairJsonText(stripFence(content)));
      // 최상위를 배열로 출력하는 응답도 받아들인다.
      const wrapped = Array.isArray(json) ? { items: json } : json;
      return schema.parse(wrapped).items.map(convert);
    } catch (cause) {
      const error = Error('판독 JSON 해석 실패: ' + cause.message);
      error.raw = content;
      throw error;
    }
  };
export const parsePageReading = parseWith(
  rawReadingSchema,
  ({ displayNumber, text, figureDependence, figureReads }) => {
    const figure = toFigure(figureDependence, figureReads);
    return { displayNumber, text, ...(figure ? { figure } : {}) };
  },
);
export const parseCrossCheck = parseWith(crossCheckSchema);

const formatRule =
  '사진에 인쇄된 문항을 빠짐없이 찾아 JSON 하나로만 출력하세요. 최상위는 {"items":[...]} 하나입니다. 각 문항은 다음 네 칸을 가집니다: ' +
  '{"displayNumber":"인쇄된 문항 번호 그대로","text":"문항 원문 전사","figureDependence":"필수|보조|없음","figureReads":["내용 | 읽은 방식 | 상태"]}. 다른 칸이나 중첩 객체는 쓰지 마세요. 모든 문자열의 따옴표를 닫으세요.';
const figureRule =
  '그림 규칙: 문항에 그림·표·그래프가 없으면 figureDependence는 "없음", figureReads는 []입니다. 있으면 풀이에 필요한 정보를 figureReads에 한 항목씩 "내용 | 읽은 방식 | 상태" 문자열로 적습니다. 읽은 방식은 숫자가 적혀 있으면 "적힌 값", 축·눈금에서 읽으면 "눈금에서 읽음", 모양만 보고 추정하면 "모양에서 추정"입니다. 상태는 또렷하면 "선명", 작거나 번지면 "불명"입니다. 예: "점 (1, 2)를 지남 | 적힌 값 | 선명", "직선의 기울기 양수 | 모양에서 추정 | 선명". 그림 없이 글만으로 풀 수 있으면 figureDependence는 "보조", 그림을 봐야만 풀 수 있으면 "필수"입니다.';
const prompts = {
  'M:read':
    formatRule +
    '\n전사 규칙: 띄어쓰기, 괄호, 부호, 지수를 보존하고 위첨자는 ^{지수}로 쓰세요. 읽을 수 없는 글자는 [불명]으로 표시하세요. 풀이, 설명, 마크다운은 넣지 마세요. 여러 문항이 한 지문·조건을 함께 쓰면 그 지문을 각 문항의 text에 포함하세요.\n' +
    figureRule,
  'M:check':
    formatRule +
    '\n수학 교재의 작은 글자 검수입니다. 문항마다 번호, 조건, 질문을 순서대로 전부 전사하세요. 각 밑 바로 오른쪽 위의 획을 관찰하고 위첨자는 ^{지수}로 적으세요. 작거나 번져서 숫자 모양을 확실히 구별할 수 없는 곳은 반드시 [불명]으로 남기세요. 수식 패턴이나 추정한 답으로 빈 곳을 채우지 마세요.\n' +
    figureRule,
  'E:read':
    formatRule +
    '\n전사 규칙: 발문, 지문, 선택지를 문항마다 연결해 전사하세요. 밑줄 범위, 빈칸 위치, 삽입 위치 번호, 문단 기호를 보존하세요. 읽을 수 없는 글자는 [불명]으로 표시하세요. 풀이, 설명, 마크다운은 넣지 마세요. 여러 문항이 한 지문을 함께 쓰면 그 지문을 각 문항의 text에 포함하세요.\n' +
    figureRule,
};

export async function readPage(filename, { subject, pass = 'read' } = {}) {
  const prompt = prompts[subject + ':' + pass];
  if (!prompt) throw Error('지원하지 않는 판독 과목·단계: ' + subject + pass);
  const reply = await visionChat(filename, prompt, { maxTokens: 2000 });
  return { ...reply, items: parsePageReading(reply.text) };
}

// 두 번 판독해도 같은 오독이면 통과하는 약점을 줄이기 위해, 채택할 전사를
// 사진과 직접 대조하는 세 번째 검수를 요청한다. '차이'가 나온 문항은 보류한다.
export async function crossCheckPage(filename, items) {
  const reply = await visionChat(
    filename,
    '사진과 아래 전사 목록을 대조하는 검수입니다. 전사를 베끼지 말고 사진에서 직접 읽으면서 숫자, 지수, 부호, 부등호, 글자가 전사와 다른 곳을 찾으세요. JSON 하나로만 출력하세요. 형식: {"items":[{"displayNumber":"문항 번호","verdict":"일치|차이","note":"다른 곳을 사진: X / 전사: Y 형태로"}]}. 전사 목록: ' +
      JSON.stringify(
        items.map(({ displayNumber, text }) => ({ displayNumber, text })),
      ),
    { maxTokens: 1200 },
  );
  return { ...reply, verdicts: parseCrossCheck(reply.text) };
}

export function applyCrossCheck(items, verdicts) {
  const byNumber = new Map(verdicts.map((v) => [v.displayNumber, v]));
  return items.map((item) => {
    if (item.holdReason || !item.text.trim()) return item;
    const verdict = byNumber.get(item.displayNumber);
    if (!verdict)
      return { ...item, text: '', holdReason: '교차 검수 응답에 누락된 문항' };
    if (verdict.verdict === '차이')
      return {
        ...item,
        text: '',
        holdReason:
          '교차 검수에서 사진과 전사의 차이 발견' +
          (verdict.note?.trim() ? ': ' + verdict.note.trim() : ''),
      };
    return item;
  });
}

const emptyFigure = { dependence: '없음', reads: [] };
const strictness = { 없음: 0, 보조: 1, 필수: 2 };
const caution = { '적힌 값': 0, '눈금에서 읽음': 1, '모양에서 추정': 2 };

// 설계 문서: 그림을 두 번 따로 읽어 비교하고, 결과가 다른 항목은 '불명'으로 처리한다.
function mergeFigure(first = emptyFigure, second = emptyFigure) {
  const dependence =
    strictness[first.dependence] >= strictness[second.dependence]
      ? first.dependence
      : second.dependence;
  const count = Math.max(first.reads.length, second.reads.length);
  const reads = Array.from({ length: count }, (_, i) => {
    const a = first.reads[i];
    const b = second.reads[i];
    const base = a ?? b;
    const unclear =
      !a ||
      !b ||
      a.state === '불명' ||
      b.state === '불명' ||
      compareMathReadings(a.content, b.content) !== null;
    return {
      ...base,
      method:
        a && b && caution[b.method] > caution[a.method]
          ? b.method
          : base.method,
      state: unclear ? '불명' : '선명',
    };
  });
  return dependence === '없음' && !reads.length
    ? undefined
    : { dependence, reads };
}

// 두 판독을 문항 번호로 맞춰 본문은 기존 비교 규칙대로, 그림 정보는 항목별로 합친다.
export function mergeMathPage(first, second) {
  const byNumber = (items) => new Map(items.map((i) => [i.displayNumber, i]));
  const a = byNumber(first);
  const b = byNumber(second);
  const numbers = [...new Set([...a.keys(), ...b.keys()])];
  return numbers.map((displayNumber) => {
    const x = a.get(displayNumber);
    const y = b.get(displayNumber);
    if (!x || !y)
      return {
        displayNumber,
        text: '',
        holdReason: '두 판독의 문항 구분이 일치하지 않음',
      };
    const reason = compareMathReadings(x.text, y.text);
    const figure = mergeFigure(x.figure, y.figure);
    return {
      displayNumber,
      text: reason ? '' : x.text,
      ...(figure ? { figure } : {}),
      ...(reason ? { holdReason: reason } : {}),
    };
  });
}

// 한 사진에서 나눈 문항에 숙제 안에서 겹치지 않는 ID를 붙인다.
// 같은 번호가 여러 번 감지되면 어느 쪽이 맞는지 알 수 없으므로 하나로 합쳐 보류한다.
export function itemsFromPhoto(assignmentId, page, merged) {
  const slug = (value) =>
    value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
  const counts = new Map();
  for (const { displayNumber } of merged)
    counts.set(displayNumber, (counts.get(displayNumber) ?? 0) + 1);
  const used = new Set();
  const items = [];
  for (const item of merged) {
    if (used.has(item.displayNumber)) continue;
    used.add(item.displayNumber);
    let itemId = assignmentId + '-p' + page + '-' + slug(item.displayNumber);
    for (let n = 2; items.some((i) => i.itemId === itemId); n++)
      itemId =
        assignmentId + '-p' + page + '-' + slug(item.displayNumber) + '-' + n;
    items.push(
      counts.get(item.displayNumber) > 1
        ? {
            itemId,
            page,
            displayNumber: item.displayNumber,
            text: '',
            holdReason: '같은 문항 번호가 사진에서 여러 번 감지됨',
          }
        : { itemId, page, ...item },
    );
  }
  return items;
}
