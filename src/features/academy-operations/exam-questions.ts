import { OperationError } from './shared.ts';
export type BankQuestion = { prompt: string; answer: string };
export type BankSource = {
  id: string;
  title: string;
  subject: string;
  grade: string;
  topic: string;
  level: string;
  questions: BankQuestion[];
};
export type ExamItem = BankQuestion & {
  source: string;
  sourceTitle: string;
  number: number;
};
const fold = (s: string) =>
  s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const formatQ = (n: number, p: BankQuestion) =>
  n + 1 + '. ' + p.prompt + (p.answer ? '\n정답: ' + p.answer : '');
export const editableQuestions = (q: BankQuestion[]) =>
  q.map((p, i) => formatQ(i, p)).join('\n\n');

// Numbered question stems start a block. Choice lines and follow-up lines stay with the stem.
export function parseQuestions(text: string): BankQuestion[] {
  const clean = text
    .replace(/\r\n?/g, '\n')
    .replace(/<!--\s*page \d+\s*-->/g, '');
  const entries: BankQuestion[] = [];
  let active: BankQuestion | undefined;
  let answerPart = false;
  let answerSheet = false;
  const numbers = new Map<number, BankQuestion>();
  for (const line of clean.split('\n')) {
    const s = line.trim().replace(/^#{1,6}\s+/, '');
    if (
      /^(?:정답(?:표|지|\s*및\s*(?:풀이|해설)|과\s*해설)\s*[:：]?|정답)$/.test(
        s,
      )
    ) {
      answerSheet = true;
      continue;
    }
    if (answerSheet) {
      if (!s) continue;
      const key = /^(\d{1,3})\s*(?:[.):：]|번\s*[:：]?)\s*(.+)$/.exec(s);
      const target = key && numbers.get(Number(key[1]));
      if (!target || !key || /\s\d{1,3}[.)]\s/.test(key[2]))
        throw new OperationError(
          '정답표는 한 줄에 하나씩 ‘1. 정답’ 형식으로 작성해 주세요.',
          422,
        );
      target.answer = key[2];
      continue;
    }
    const question =
      /^(?:문제\s*|문항\s*|Q\s*)?(\d{1,3})\s*(?:[.)]\s+|번(?:[.)]\s*|\s+))(.+)$/i.exec(
        s,
      );
    if (question) {
      const inline = /^(.*\S)\s+(?:정답|답|answer)\s*[:：]\s*(.*)$/i.exec(
        question[2],
      );
      active = {
        prompt: inline ? inline[1] : question[2],
        answer: inline?.[2] ?? '',
      };
      if (numbers.has(Number(question[1])))
        throw new OperationError(
          '중복된 문항 번호가 있습니다. 보기는 ① 또는 (1)로, 문제는 서로 다른 번호로 정리해 주세요.',
          422,
        );
      numbers.set(Number(question[1]), active);
      entries.push(active);
      answerPart = !!inline;
      continue;
    }
    if (!active) {
      if (
        /^(?:\[?(?:공통\s*)?(?:지문|그림|자료)|다음\s*(?:글|시|지문|그림|표))/.test(
          s,
        )
      )
        throw new OperationError(
          '공통 지문이나 자료는 참조하는 각 문항에 포함해 주세요.',
          422,
        );
      continue;
    }
    const answer = /^(?:정답|답|answer)\s*[:：]\s*(.*)$/i.exec(s);
    if (answer) {
      active.answer = answer[1];
      answerPart = true;
      continue;
    }
    if (/^(?:풀이|해설)\s*[:：]/.test(s)) answerPart = true;
    const key = answerPart ? 'answer' : 'prompt';
    active[key] += '\n' + s;
  }
  if (entries.length > 150)
    throw new OperationError('한 자료에는 최대 150문항을 등록할 수 있습니다.');
  if (entries.some((p) => /(?:정답|해설|풀이|answer)\s*[:：]/i.test(p.prompt)))
    throw new OperationError(
      '학생용 본문에 정답 또는 해설이 있습니다. 정답 줄로 옮겨 주세요.',
      422,
    );
  return entries.map((p) => ({
    prompt: p.prompt.trim(),
    answer: p.answer.trim(),
  }));
}
export const looksLikeExamRequest = (s: string) =>
  /(시험지|문제지|퀴즈|테스트지)/.test(s) &&
  /(만들|만드|생성|출제|구성|뽑|짜\s*줘)/.test(s);
export const wantsVariants = (s: string) =>
  /변형|유사\s*문[제항]|새(?:로운)?\s*문[제항]/.test(s);
function normalizeGrade(s: string) {
  return s.replace(
    /(초|중|고)(?:등학교|학교|등)?\s*([1-6])(?:\s*학년)?/g,
    '$1$2',
  );
}
export function selectQuestions(
  request: string,
  sources: BankSource[],
  variants = false,
) {
  const q = normalizeGrade(request.normalize('NFKC'));
  if (
    /제외|빼고|말고/.test(q) ||
    [
      /(?:초|중|고)[1-6]/g,
      /수학|영어|국어|과학|사회|역사/g,
      /객관식|주관식|서술형|단답형/g,
      /기초|기본|심화/g,
    ].some((pattern) => new Set(q.match(pattern) ?? []).size > 1)
  )
    throw new OperationError(
      '한 시험지에는 한 학년·과목·난이도·유형을 지정해 주세요. 제외 조건은 지원하지 않습니다.',
    );
  const counts = [...q.matchAll(/(\d+)\s*(?:문항|문제|개)/g)];
  if (counts.length > 1)
    throw new OperationError(
      '한 번에 한 조건으로 요청해 주세요. 유형별 개수는 따로 지정할 수 없습니다.',
    );
  const wanted = counts.length ? Number(counts[0][1]) : 5;
  if (wanted < 1 || wanted > 30)
    throw new OperationError('문항 수는 1~30 사이로 입력해 주세요.');
  const kind = q.match(/객관식|주관식|서술형|단답형/)?.[0];
  const grade = q.match(/(?:초|중|고)[1-6]/)?.[0];
  const subject = q.match(/수학|영어|국어|과학|사회|역사/)?.[0];
  const level = q.match(/기초|기본|심화/)?.[0];
  const tokens = q
    .replace(
      /\d+\s*(?:문항|문제|개)|(?:초|중|고)[1-6]|객관식|주관식|서술형|단답형|수학|영어|국어|과학|사회|역사|기초|기본|심화/g,
      ' ',
    )
    .replace(/(?:만들어|만들|만드|생성해|구성해|출제해|뽑아|짜\s*줘).*/, ' ')
    .replace(
      /시험지|문제지|테스트지|퀴즈|기출|문항|문제|단원|변형|유사|새로운|연습용|복습용|평가용/g,
      ' ',
    )
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.replace(/(?:으로|에서|만으로|로|을|를|의|만|씩)$/, ''))
    .filter(
      (t) =>
        t.length > 0 &&
        ![
          '내',
          '제가',
          '내가',
          '만든',
          '가지고',
          '중',
          '총',
          '새',
          '개',
          '한',
          '로',
          '주세요',
          '및',
          '위주',
          '위주의',
        ].includes(t),
    );
  const pool: ExamItem[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (
      (grade && fold(normalizeGrade(source.grade)) !== fold(grade)) ||
      (subject && source.subject !== subject) ||
      (level && source.level !== level)
    )
      continue;
    for (const [i, p] of source.questions.entries()) {
      const searchable = fold([source.title, source.topic, p.prompt].join(' '));
      if (!tokens.every((t) => searchable.includes(fold(t)))) continue;
      const choice =
        /[①②③④⑤]|(?:^|\n)\s*[(（][1-5][)）]|(?:^|\n)[A-D][.)]\s/u.test(
          p.prompt,
        );
      if (
        (kind === '객관식' && !choice) ||
        (kind && kind !== '객관식' && choice)
      )
        continue;
      if (kind === '서술형' && !/서술|설명|논술|이유|과정/.test(p.prompt))
        continue;
      if (kind === '단답형' && /서술|설명|논술|이유|과정/.test(p.prompt))
        continue;
      const hash = fold(p.prompt);
      if (seen.has(hash)) continue;
      seen.add(hash);
      pool.push({
        ...p,
        source: source.id,
        sourceTitle: source.title,
        number: i + 1,
      });
    }
  }
  if (!pool.length || (!variants && pool.length < wanted))
    throw new OperationError(
      '조건에 맞는 서로 다른 문제가 ' +
        pool.length +
        '개입니다. 요청한 ' +
        wanted +
        '문항을 만들려면 자료를 더 등록하거나 조건을 줄여 주세요.',
      422,
    );
  for (let i = pool.length - 1; i > 0; i--) {
    const n = Math.floor(Math.random() * (i + 1));
    [pool[n], pool[i]] = [pool[i], pool[n]];
  }
  return variants
    ? Array.from({ length: wanted }, (_, i) => pool[i % pool.length])
    : pool.slice(0, wanted);
}
