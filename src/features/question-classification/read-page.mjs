import { z } from 'zod';
import { compareMathReadings, mathStem, visionChat } from './read-image.mjs';

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
const pageNumber = z.coerce.number().int().min(1).max(100000).catch(0);
const rawReadingSchema = z.object({
  // 쪽수는 사진 한 장에 하나이므로 최상위에서 받는다. 문항별 값도 계속 받는다.
  printedPage: pageNumber.optional(),
  // 여러 문항이 함께 쓰는 지문·조건([7~10] 다음 글을 …)은 한 번만 받아 프로그램이 각 문항에 붙인다.
  passages: z
    .array(z.object({ numbers: z.coerce.string(), text: z.string() }))
    .optional()
    .catch(undefined),
  items: z
    .array(
      z.object({
        displayNumber: z.coerce.string().pipe(nonempty),
        printedPage: pageNumber.optional(),
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
// \n·\t·\f·\b·\r로 시작하는 LaTeX 명령. JSON 이스케이프로 읽으면 \neq가 줄바꿈+eq,
// \to가 탭+o가 되어 전사와 분류 인용이 깨지므로, 이 명령들은 역슬래시 글자로 남긴다.
const latexCommands =
  /^(?:neq|ne|neg|not|notin|nabla|nu|ni|to|times|theta|tan|tau|text|textrm|top|triangle|therefore|tfrac|frac|forall|flat|beta|bar|binom|because|bot|bigcup|bigcap|boxed|right|rightarrow|rho|rm|rangle|rceil|rfloor)(?![a-zA-Z])/;

// 문자열을 닫는 따옴표 뒤에 올 수 있는 것: 끝, 닫는 괄호, 콜론, 또는 쉼표 뒤의 다음 값.
const closesString = /^\s*(?:$|[}\]:]|,\s*(?:["{[\d-]|true|false|null|$))/;

export function repairJsonText(json) {
  let out = '';
  let inString = false;
  const open = [];
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (!inString) {
      if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') open.push(ch);
      else if (ch === '}' || ch === ']') open.pop();
      out += ch;
      continue;
    }
    if (ch === '"') {
      // 뒤에 구조 문자(, } ] :)가 오지 않는 큰따옴표는 판독 모델이 이스케이프하지 않은
      // 원문 속 따옴표(<box label="">, "word")로 보고 글자로 남긴다.
      if (closesString.test(json.slice(i + 1, i + 40))) {
        inString = false;
        out += ch;
      } else out += '\\"';
    } else if (ch === '\n' && /^\s*[}\]]/.test(json.slice(i + 1))) {
      // 닫는 따옴표를 빠뜨리고 줄을 바꾼 뒤 객체를 닫은 응답: 여기서 문자열을 닫는다.
      inString = false;
      out += '"' + ch;
    } else if (ch === '\\') {
      const next = json[i + 1] ?? '';
      if ('bfnrt'.includes(next) && latexCommands.test(json.slice(i + 1)))
        out += '\\\\';
      else if (
        '"\\/bfnrt'.includes(next) ||
        // \u는 16진수 네 자리가 따를 때만 이스케이프다(\underline 같은 LaTeX는 글자로 남긴다).
        (next === 'u' && /^[0-9a-fA-F]{4}$/.test(json.slice(i + 2, i + 6)))
      ) {
        out += ch + next;
        i++;
      } else out += '\\\\';
    } else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch !== '\r') out += ch;
  }
  // 판독 모델이 마지막 닫는 괄호만 빠뜨린 응답(…}]로 끝남)은 남은 괄호를 닫는다.
  // 문자열이 열린 채 끝난 응답은 내용이 잘린 것이므로 고치지 않는다.
  if (!inString) for (const ch of open.reverse()) out += ch === '{' ? '}' : ']';
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
// 인쇄 번호 뒤의 마침표·괄호·'번'을 걷어 낸다. 두 판독이 '5'와 '5.'로 갈려
// 문항 구분 불일치로 보류되는 것을 막는다. 0009 같은 앞자리 0은 인쇄 그대로 둔다.
export function cleanDisplayNumber(value) {
  const trimmed = value
    .trim()
    .replace(/^(?:No\.?|문항)\s*/i, '')
    .replace(/\s*(?:[.)．]|번)$/u, '')
    .trim();
  return trimmed || value.trim();
}
// 전사문 앞에 되풀이된 문항 번호("7. f는 …", 수식으로 감싼 "$18.$", "$19$.")를 걷어 낸다.
function stripEchoedNumber(text, displayNumber) {
  const escaped = displayNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(
    new RegExp(
      '^\\s*\\$?\\s*' +
        escaped +
        '\\s*(?:\\$\\s*)?(?:[.)．]|번)\\s*(?:\\$\\s*)?',
    ),
    '',
  );
}

// [7~10], 7-10, 7, 8 같은 범위 표기를 번호 목록으로 푼다.
export function passageNumbers(range) {
  const out = [];
  for (const part of String(range).split(/[,，、]/)) {
    const m = part.match(/(\d+)\s*(?:[~∼〜\-–—]\s*(\d+))?/);
    if (!m) continue;
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (to >= from && to - from < 50)
      for (let n = from; n <= to; n++) out.push(String(n));
  }
  return out;
}

export function parsePageReading(content) {
  let reading;
  try {
    const json = JSON.parse(repairJsonText(stripFence(content)));
    reading = rawReadingSchema.parse(
      Array.isArray(json) ? { items: json } : json,
    );
  } catch (cause) {
    const error = Error('판독 JSON 해석 실패: ' + cause.message);
    error.raw = content;
    throw error;
  }
  const passages = (reading.passages ?? []).filter((p) => p.text.trim());
  return reading.items.map(
    ({ displayNumber, printedPage, text, figureDependence, figureReads }) => {
      const number = cleanDisplayNumber(displayNumber);
      const key = String(Number(number.match(/\d+/)?.[0] ?? NaN));
      let body = stripEchoedNumber(text, number);
      // 공유 지문은 문항 본문에 아직 없을 때만 앞에 붙인다(기준서 예시와 같은 지문→발문 순서).
      for (const passage of passages)
        if (
          passageNumbers(passage.numbers).includes(key) &&
          !body.includes(passage.text.trim())
        )
          body = passage.text.trim() + '\n' + body;
      const figure = toFigure(figureDependence, figureReads);
      const page = printedPage || reading.printedPage;
      return {
        displayNumber: number,
        text: body,
        ...(page ? { printedPage: page } : {}),
        ...(figure ? { figure } : {}),
      };
    },
  );
}
export const parseCrossCheck = parseWith(crossCheckSchema);

const formatRule =
  '사진에 인쇄된 문항을 빠짐없이 찾아 JSON 하나로만 출력하세요. 형식: ' +
  '{"printedPage":쪽수,"passages":[],"items":[{"displayNumber":"인쇄된 문항 번호","text":"문항 원문 전사","figureDependence":"필수|보조|없음","figureReads":["내용 | 읽은 방식 | 상태"]}]}. ' +
  'printedPage: 면의 위나 아래 모서리에 따로 인쇄된 쪽 번호 정수입니다. 머리글의 단원·유형 번호, 연도, 문항 번호와 혼동하지 마세요. 보이지 않으면 칸을 빼세요. ' +
  'items: 번호가 붙은 문항마다 하나씩입니다. 두 단이면 왼쪽 단을 위에서 아래로 읽은 뒤 오른쪽 단을 읽으세요. [7~10] 같은 지문 머리말, 선택지 ①②, 쪽 번호는 문항이 아닙니다. displayNumber에는 번호를 인쇄된 숫자 그대로(예: 0012, 7) 쓰고 마침표는 빼세요. text에 번호를 다시 쓰지 마세요. ' +
  'passages: 사진에 "[n~m] 다음 글을 읽고 물음에 답하시오."처럼 여러 문항이 함께 쓰는 지문이 실제로 인쇄되어 있을 때만 {"numbers":사진에 적힌 번호 범위,"text":지문 원문}을 넣고, 각 문항 text에는 그 문항의 발문과 선택지만 적으세요. 그런 지문이 없으면 []입니다. 이 안내의 예시 글자를 출력에 옮기지 마세요. ' +
  '사진에 없는 번호나 문장을 만들지 마세요. 문제를 풀지 마세요. 모든 문자열의 따옴표를 닫고, 문자열 안의 큰따옴표는 \\"로 쓰세요.';
const figureRule =
  '그림 규칙: 문항에 그림·표·그래프가 없으면 figureDependence는 "없음", figureReads는 []입니다. 있으면 풀이에 필요한 정보를 figureReads에 한 항목씩 "내용 | 읽은 방식 | 상태" 문자열로 적습니다. 읽은 방식은 숫자가 적혀 있으면 "적힌 값", 축·눈금에서 읽으면 "눈금에서 읽음", 모양만 보고 추정하면 "모양에서 추정"입니다. 상태는 또렷하면 "선명", 작거나 번지면 "불명"입니다. 예: "점 (1, 2)를 지남 | 적힌 값 | 선명", "직선의 기울기 양수 | 모양에서 추정 | 선명". 그림 없이 글만으로 풀 수 있으면 figureDependence는 "보조", 그림을 봐야만 풀 수 있으면 "필수"입니다.';
const prompts = {
  'M:read':
    formatRule +
    '\n전사 규칙: 띄어쓰기, 괄호, 부호, 지수를 보존하고 위첨자는 ^{지수}로 쓰세요. 읽을 수 없는 글자는 [불명]으로 표시하세요. 풀이, 설명, 마크다운은 넣지 마세요.\n' +
    figureRule,
  'M:check':
    formatRule +
    '\n수학 교재의 작은 글자 검수입니다. 문항마다 번호, 조건, 질문을 순서대로 전부 전사하세요. 각 밑 바로 오른쪽 위의 획을 관찰하고 위첨자는 ^{지수}로 적으세요. 작거나 번져서 숫자 모양을 확실히 구별할 수 없는 곳은 반드시 [불명]으로 남기세요. 수식 패턴이나 추정한 답으로 빈 곳을 채우지 마세요.\n' +
    figureRule,
  'E:read':
    formatRule +
    '\n전사 규칙: 발문, 지문, 선택지를 문항마다 연결해 전사하세요. 영어 지문과 선택지는 영어 그대로 옮기고 번역하거나 요약하지 마세요. 밑줄 범위, 빈칸 위치, 삽입 위치 번호, 문단 기호를 보존하세요. 읽을 수 없는 글자는 [불명]으로 표시하세요. 풀이, 설명, 마크다운은 넣지 마세요.\n' +
    figureRule,
};

export async function readPage(filename, { subject, pass = 'read' } = {}) {
  const prompt = prompts[subject + ':' + pass];
  if (!prompt) throw Error('지원하지 않는 판독 과목·단계: ' + subject + pass);
  const reply = await visionChat(filename, prompt, { maxTokens: 4096 });
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
  const byNumber = new Map(
    verdicts.map((v) => [cleanDisplayNumber(v.displayNumber), v]),
  );
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
    if (
      [first, second].some(
        (pass) =>
          pass.filter((i) => i.displayNumber === displayNumber).length > 1,
      )
    )
      return {
        displayNumber,
        text: '',
        holdReason: '같은 문항 번호가 사진에서 여러 번 감지됨',
      };
    if (!x || !y)
      return {
        displayNumber,
        text: '',
        holdReason: '두 판독의 문항 구분이 일치하지 않음',
      };
    // 전체가 같으면 그대로 쓰고, 선택지만 갈리면 두 판독이 합의한 발문만 쓴다.
    // 발문이 다르거나 [불명]이 있으면 보류한다.
    const whole = compareMathReadings(x.text, y.text);
    const reason =
      whole && compareMathReadings(mathStem(x.text), mathStem(y.text));
    const figure = mergeFigure(x.figure, y.figure);
    return {
      displayNumber,
      text: reason ? '' : whole ? mathStem(x.text) : x.text,
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

// 사진에 인쇄된 쪽수를 판독 결과에서 고른다. 모든 판독이 같은 쪽수 하나만 읽었을 때만 채택한다.
export function pagesFromReadings(readingPasses) {
  const pages = new Set(
    readingPasses
      .flat()
      .map((r) => r.printedPage)
      .filter((p) => !!p),
  );
  return pages.size === 1 ? [...pages][0] : undefined;
}
