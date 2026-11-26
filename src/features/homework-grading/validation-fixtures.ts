import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import type { Item, Outcome, Subject } from './contracts.ts';

export interface ValidationCase {
  id: string;
  subject: Subject;
  page: number;
  question: string;
  answer: string;
  key: string;
  type: Item['answer_type'];
  outcome: Outcome;
  score: string | null;
  form?: string;
  formPoints?: string;
  units?: string;
  convert?: boolean;
  rubric?: string;
  reviewAnswer?: string;
  reviewUnit?: string;
}

// Fixed, self-authored synthetic cases. These are neither real student samples nor an independent benchmark.
export const validationCases: ValidationCase[] = [
  {
    id: 'kor-antonym',
    subject: 'KOR',
    page: 1,
    question: '크다의 반대말을 쓰세요.',
    answer: '작다',
    key: '작다',
    type: 'text_exact',
    outcome: 'correct',
    score: '2',
  },
  {
    id: 'kor-spacing',
    subject: 'KOR',
    page: 1,
    question: '띄어쓰기를 지켜 문장을 쓰세요.',
    answer: '할수있다',
    key: '할 수 있다',
    type: 'text_exact',
    outcome: 'incorrect',
    score: '0',
  },
  {
    id: 'kor-negation',
    subject: 'KOR',
    page: 1,
    question: '주인공이 약속을 지켰나요? 문장으로 쓰세요.',
    answer: '주인공은 약속을 지키지 않았다.',
    key: '약속을 지키지 않았다.',
    type: 'text_semantic',
    rubric:
      '약속을 지키지 않았다는 부정을 명확하게 표현하면 2점, 약속을 지켰다고 표현하거나 부정이 없으면 0점.',
    outcome: 'correct',
    score: '2',
  },
  {
    id: 'kor-blank',
    subject: 'KOR',
    page: 1,
    question: '봄 다음에 오는 계절은?',
    answer: '',
    key: '여름',
    type: 'text_exact',
    outcome: 'blank',
    score: '0',
  },
  {
    id: 'eng-past',
    subject: 'ENG',
    page: 2,
    question: 'Write the past tense of go.',
    answer: 'went',
    key: 'went',
    type: 'text_exact',
    outcome: 'correct',
    score: '2',
  },
  {
    id: 'eng-misspelling',
    subject: 'ENG',
    page: 2,
    question: 'Write the past tense of catch.',
    answer: 'catched',
    key: 'caught',
    type: 'text_exact',
    outcome: 'incorrect',
    score: '0',
  },
  {
    id: 'eng-semantic',
    subject: 'ENG',
    page: 2,
    question: 'Say that he disagreed, in one sentence.',
    answer: 'He did not agree.',
    key: 'He disagreed.',
    type: 'text_semantic',
    rubric:
      '그가 동의하지 않았다는 의미를 보존하면 2점, 동의했다는 뜻으로 바뀌거나 근거가 없으면 0점.',
    outcome: 'correct',
    score: '2',
  },
  {
    id: 'eng-case',
    subject: 'ENG',
    page: 2,
    question: 'Copy: I can swim. Keep capital letters.',
    answer: 'i can swim.',
    key: 'I can swim.',
    type: 'text_exact',
    outcome: 'incorrect',
    score: '0',
  },
  {
    id: 'math-addition',
    subject: 'MATH',
    page: 3,
    question: '2 + 2 = ?',
    answer: '4',
    key: '4',
    type: 'numeric',
    outcome: 'correct',
    score: '2',
  },
  {
    id: 'math-equivalent-fraction',
    subject: 'MATH',
    page: 3,
    question: '1 / 4 + 1 / 4 = ?',
    answer: '2/4',
    key: '1/2',
    type: 'numeric',
    outcome: 'correct',
    score: '2',
  },
  {
    id: 'math-reduced-fraction',
    subject: 'MATH',
    page: 3,
    question: '1 / 4 + 1 / 4 = ? (기약분수)',
    answer: '2/4',
    key: '1/2',
    type: 'numeric',
    form: 'reduced_fraction',
    formPoints: '0.5',
    outcome: 'partial',
    score: '1.5',
  },
  {
    id: 'math-unit',
    subject: 'MATH',
    page: 3,
    question: '5 cm + 5 cm = ? (단위 환산 허용)',
    answer: '100 mm',
    reviewAnswer: '100',
    reviewUnit: 'mm',
    key: '10',
    units: 'cm',
    convert: true,
    type: 'numeric',
    outcome: 'correct',
    score: '2',
  },
  {
    id: 'math-choice',
    subject: 'MATH',
    page: 3,
    question: '정답이라고 고른 보기 번호를 쓰세요.',
    answer: '3',
    key: '3',
    type: 'choice_single',
    outcome: 'correct',
    score: '2',
  },
  {
    id: 'math-wrong',
    subject: 'MATH',
    page: 3,
    question: '3 + 4 = ?',
    answer: '8',
    key: '7',
    type: 'numeric',
    outcome: 'incorrect',
    score: '0',
  },
  {
    id: 'math-unreadable',
    subject: 'MATH',
    page: 3,
    question: '8 - 1 = ? (답을 알아볼 수 없음)',
    answer: '[scribble]',
    key: '7',
    type: 'numeric',
    outcome: 'ungradable',
    score: null,
  },
];

// Frozen before its first paid run; a small synthetic check, not an academy-independent benchmark.
export const holdoutValidationCases: ValidationCase[] = [
  {
    id: 'new-kor-antonym',
    subject: 'KOR',
    page: 1,
    question: '빠르다의 반대말을 쓰세요.',
    answer: '느리다',
    key: '느리다',
    type: 'text_exact',
    outcome: 'correct',
    score: '2',
  },
  {
    id: 'new-kor-spelling',
    subject: 'KOR',
    page: 1,
    question: '올바른 맞춤법으로 쓰세요.',
    answer: '어의없다',
    key: '어이없다',
    type: 'text_exact',
    outcome: 'incorrect',
    score: '0',
  },
  {
    id: 'new-kor-spacing',
    subject: 'KOR',
    page: 1,
    question: '띄어쓰기를 지켜 쓰세요.',
    answer: '할 수 없다',
    key: '할 수 없다',
    type: 'text_exact',
    outcome: 'correct',
    score: '2',
  },
  {
    id: 'new-kor-reason',
    subject: 'KOR',
    page: 1,
    question: '친구들이 일을 빨리 끝낸 이유는?',
    answer: '서로 도왔기 때문이다.',
    key: '서로 도왔기 때문이다.',
    type: 'text_semantic',
    rubric:
      '친구들이 서로 도운 것이 이유임을 표현하면 2점, 인과가 뒤바뀌거나 이유가 없으면 0점.',
    outcome: 'correct',
    score: '2',
  },
  {
    id: 'new-eng-past',
    subject: 'ENG',
    page: 2,
    question: 'Write the past tense of eat.',
    answer: 'ate',
    key: 'ate',
    type: 'text_exact',
    outcome: 'correct',
    score: '2',
  },
  {
    id: 'new-eng-plural',
    subject: 'ENG',
    page: 2,
    question: 'Write the plural of child.',
    answer: 'childs',
    key: 'children',
    type: 'text_exact',
    outcome: 'incorrect',
    score: '0',
  },
  {
    id: 'new-eng-case',
    subject: 'ENG',
    page: 2,
    question: 'Copy: She is here.',
    answer: 'She is here.',
    key: 'She is here.',
    type: 'text_exact',
    outcome: 'correct',
    score: '2',
  },
  {
    id: 'new-eng-negation',
    subject: 'ENG',
    page: 2,
    question: 'Say she did not tell a lie.',
    answer: 'She never lied.',
    key: 'She did not tell a lie.',
    type: 'text_semantic',
    rubric:
      '그녀가 거짓말을 하지 않았다는 부정의 의미를 보존하면 2점, 긍정으로 바뀌거나 의미가 없으면 0점.',
    outcome: 'correct',
    score: '2',
  },
  {
    id: 'new-math-subtract',
    subject: 'MATH',
    page: 3,
    question: '12 - 5 = ?',
    answer: '7',
    key: '7',
    type: 'numeric',
    outcome: 'correct',
    score: '2',
  },
  {
    id: 'new-math-fraction',
    subject: 'MATH',
    page: 3,
    question: '1 / 3 + 1 / 3 = ?',
    answer: '2/3',
    key: '2/3',
    type: 'numeric',
    outcome: 'correct',
    score: '2',
  },
  {
    id: 'new-math-wrong',
    subject: 'MATH',
    page: 3,
    question: '3 x 4 = ?',
    answer: '11',
    key: '12',
    type: 'numeric',
    outcome: 'incorrect',
    score: '0',
  },
  {
    id: 'new-math-unit',
    subject: 'MATH',
    page: 3,
    question: '1 m + 1 m = ? (단위 환산 허용)',
    answer: '200 cm',
    reviewAnswer: '200',
    reviewUnit: 'cm',
    key: '2',
    units: 'm',
    convert: true,
    type: 'numeric',
    outcome: 'correct',
    score: '2',
  },
];

export function renderValidationPage(
  page: number,
  font?: string,
  manifest = validationCases,
) {
  if (font && !GlobalFonts.registerFromPath(font, 'AXRValidationHand'))
    throw new Error('VALIDATION_FONT_UNAVAILABLE');
  const canvas = createCanvas(1400, 1900),
    c = canvas.getContext('2d');
  c.fillStyle = '#fff';
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.fillStyle = '#222';
  c.font = '32px "Malgun Gothic", sans-serif';
  c.fillText(`AXR 비식별 검증용 직접 제작 예제 / ${page}쪽`, 55, 60);
  const cases = manifest.filter((v) => v.page === page);
  for (const [index, v] of cases.entries()) {
    const y = 120 + index * 240;
    c.fillStyle = '#222';
    c.font = '29px "Malgun Gothic", sans-serif';
    c.fillText(`${manifest.indexOf(v) + 1}. ${v.question}`, 55, y);
    c.strokeStyle = '#aaa';
    c.lineWidth = 1;
    c.strokeRect(55, y + 18, 1290, 150);
    c.font = '25px "Malgun Gothic", sans-serif';
    c.fillText('답:', 75, y + 93);
    c.save();
    c.translate(145, y + 110);
    c.rotate(-0.012);
    c.fillStyle = '#173f69';
    c.strokeStyle = '#173f69';
    c.lineWidth = 3;
    c.font = `55px "${font ? 'AXRValidationHand' : 'Segoe Print'}", "Malgun Gothic", sans-serif`;
    if (v.answer === '[scribble]') {
      // Deliberately ambiguous strokes, with no hidden intended character.
      for (let j = 0; j < 9; j++) {
        c.beginPath();
        c.moveTo(j * 16, -45);
        c.bezierCurveTo(120 - j * 6, -100, j * 13 - 20, 38, 160 - j * 7, -2);
        c.stroke();
      }
    } else c.fillText(v.answer, 0, 0);
    c.restore();
  }
  return new Uint8Array(
    page === 2 ? canvas.toBuffer('image/jpeg') : canvas.toBuffer('image/png'),
  );
}
