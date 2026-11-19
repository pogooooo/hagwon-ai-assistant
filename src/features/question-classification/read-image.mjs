import { readFile } from 'node:fs/promises';
import path from 'node:path';

// 한 문항을 잘라낸 이미지를 딱 한 번 전사한다. 정답 원문은 모델에 제공하지 않는다.
const model = 'HCX-005';

// Only fold presentation differences. Preserve digits, operators and the extent of each exponent.
function comparableText(text) {
  const superscripts = '⁰¹²³⁴⁵⁶⁷⁸⁹';
  return (
    text
      .normalize('NFC')
      .replaceAll('$', '')
      .replaceAll('−', '-')
      // LaTeX 표기 변형: 간격 명령, \limits, \left·\right, \dfrac·\tfrac, 같은 기호의 다른 이름.
      .replace(/\\[,:;! ]/g, ' ')
      .replace(/\\(?:limits|left|right|displaystyle)(?![a-zA-Z])/g, '')
      .replace(/\\[dt]frac(?![a-zA-Z])/g, '\\frac')
      .replace(/\\text(?:rm)?\{([^{}]*)\}/g, '$1')
      .replace(/\^\{?\\prime\}?|′/g, "'")
      .replace(/\\(?:geq|ge)(?![a-zA-Z])/g, '≥')
      .replace(/\\(?:leq|le)(?![a-zA-Z])/g, '≤')
      .replace(/\\(?:to|rightarrow)(?![a-zA-Z])/g, '→')
      .replace(/\\times(?![a-zA-Z])/g, '×')
      .replace(/\\(?:neq|ne)(?![a-zA-Z])/g, '≠')
      .replace(/\\cdot\b/g, '·')
      .replace(
        /[⁰¹²³⁴⁵⁶⁷⁸⁹]+/gu,
        (digits) =>
          '^{' + [...digits].map((d) => superscripts.indexOf(d)).join('') + '}',
      )
      .replace(/\s*([=≠+\-·/^(){},.])\s*/gu, '$1')
      .replace(/\^(\d)(?!\d)/g, '^{$1}')
      // 공백은 숫자와 숫자 사이(1 2와 12의 구별)에서만 의미가 있다. 나머지 공백 차이
      // ("3$ 일"과 "3$일", "33 개"와 "33개")는 접는다.
      .replace(/\s+/gu, ' ')
      .replace(/(?<!\d) | (?!\d)/gu, '')
      .trim()
  );
}

// 문항의 발문: 선택지(① 이후)와 배점 표시([3점])를 뺀 부분. 실제 시험지에서 두 판독은
// 발문은 같고 선택지 분수만 달리 읽는 경우가 많다. 유형 판정에는 발문이면 충분하다.
export function mathStem(text) {
  return text
    .replace(/\r/g, '')
    .replace(/(^|\s)①[\s\S]*$/u, '$1')
    .replace(/\[\s*\$?\d+\$?\s*점\s*\]/g, '')
    .trim();
}

export function compareMathReadings(first, second) {
  if ([first, second].some((text) => !text.trim() || text.includes('[불명]')))
    return '판독 불명';
  return comparableText(first) === comparableText(second)
    ? null
    : '수학 문항의 두 판독이 일치하지 않음';
}

// 사진 한 장과 지시문을 보내 CLOVA 판독 모델의 응답 본문을 받는다.
export async function visionChat(filename, prompt, { maxTokens = 800 } = {}) {
  const fromFile = typeof filename === 'string';
  const mime = fromFile
    ? {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
      }[path.extname(filename).toLowerCase()]
    : filename.mime;
  if (!mime) throw Error('PNG 또는 JPEG 문항 이미지 경로를 입력하세요.');
  const key =
    process.env.CLOVA_STUDIO_API_KEY?.trim() ||
    process.env.RAG_CLOVA_API_KEY?.trim();
  if (!key) throw Error('.env.local에 CLOVA_STUDIO_API_KEY를 설정하세요.');
  const image = fromFile ? await readFile(filename) : filename.bytes;
  const response = await fetch(
    'https://clovastudio.stream.ntruss.com/v3/chat-completions/' + model,
    {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(120000),
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                dataUri: {
                  data: 'data:' + mime + ';base64,' + image.toString('base64'),
                },
              },
              { type: 'text', text: prompt },
            ],
          },
        ],
        maxTokens,
        temperature: 0,
      }),
    },
  );
  if (!response.ok) throw Error('CLOVA Studio HTTP ' + response.status);
  const { result } = await response.json();
  if (
    typeof result?.message?.content !== 'string' ||
    !result.message.content.trim() ||
    result.finishReason === 'length'
  )
    throw Error('완성된 전사 응답을 받지 못했습니다.');
  return { model, text: result.message.content, usage: result.usage };
}

export async function transcribeImage(filename, { checkMath = false } = {}) {
  return visionChat(
    filename,
    checkMath
      ? '수학 교재의 작은 글자 검수입니다. 사진에서 번호, 조건, 질문을 순서대로 전부 전사하세요. 각 밑 바로 오른쪽 위의 획을 관찰하고 위첨자는 ^{지수}로 적으세요. 작거나 번져서 숫자 모양을 확실히 구별할 수 없는 곳은 반드시 [불명]으로 남기세요. 수식 패턴이나 추정한 답으로 빈 곳을 채우지 마세요. 문항만 한 줄로 출력하세요.'
      : '이미지에 보이는 문항 원문만 그대로 전사하세요. 띄어쓰기, 괄호, 부호, 지수를 보존하고 유니코드 일반 텍스트로 쓰세요. 풀이, 설명, 마크다운은 넣지 마세요. 읽을 수 없는 글자는 [불명]으로 표시하세요.',
  );
}
