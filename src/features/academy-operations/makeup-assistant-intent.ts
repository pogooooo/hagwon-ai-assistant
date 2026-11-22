import { addDays, dayOfWeek, isDate } from '../makeup-schedule/model/time.ts';
import { OperationError } from './shared.ts';

function requestedDate(text: string, today: string) {
  const dates = new Set<string>();
  const add = (year: string, month: string, day: string) =>
    dates.add(year + '-' + month.padStart(2, '0') + '-' + day.padStart(2, '0'));
  for (const m of text.matchAll(
    /(?<!\d)(\d{4})[-/.]\s*(\d{1,2})[-/.]\s*(\d{1,2})(?!\d)/gu,
  ))
    add(m[1], m[2], m[3]);
  for (const m of text.matchAll(
    /(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일/gu,
  ))
    add(m[1] ?? today.slice(0, 4), m[2], m[3]);
  for (const m of text.matchAll(
    /(?<![\p{L}\p{N}])(오늘|내일|모레)(?![가-힣](?!은|에|로))/gu,
  ))
    dates.add(addDays(today, ['오늘', '내일', '모레'].indexOf(m[1])));
  for (const m of text.matchAll(
    /(이번|다음)\s*(?:주\s*)?([일월화수목금토])요일/gu,
  )) {
    const monday = (dayOfWeek(today) + 6) % 7;
    const day = '월화수목금토일'.indexOf(m[2]);
    dates.add(addDays(today, day - monday + (m[1] === '다음' ? 7 : 0)));
  }
  const [date] = dates;
  if (dates.size !== 1 || !isDate(date ?? ''))
    throw new OperationError(
      '휴강할 날짜를 하나만 적어 주세요. 예: 11월 25일 또는 다음 주 수요일.',
      422,
    );
  if (date < today)
    throw new OperationError('오늘 이후의 휴강일을 적어 주세요.', 422);
  return date;
}

function classFromMessage(
  text: string,
  classes: { id: string; name: string }[],
) {
  const compact = text.toLowerCase().replace(/\s+/gu, '');
  const hits = classes.flatMap(({ id, name }) => {
    const normalized = name
      .normalize('NFKC')
      .toLowerCase()
      .replace(/\s+/gu, '');
    const alias = /([a-z]+\d*반)$/u.exec(normalized)?.[1];
    return [...new Set([normalized, alias])].flatMap((cue) => {
      if (!cue) return [];
      const found: { id: string; start: number; end: number }[] = [];
      for (
        let start = compact.indexOf(cue);
        start !== -1;
        start = compact.indexOf(cue, start + cue.length)
      ) {
        if (/^[a-z\d]/u.test(cue) && /[a-z\d]/u.test(compact[start - 1] ?? ''))
          continue;
        found.push({ id, start, end: start + cue.length });
      }
      return found;
    });
  });
  const classesMentioned = new Set(
    hits
      .filter(
        (hit) =>
          !hits.some(
            (other) =>
              other.start <= hit.start &&
              other.end >= hit.end &&
              other.end - other.start > hit.end - hit.start,
          ),
      )
      .map(({ id }) => id),
  );
  if (classesMentioned.size !== 1)
    throw new OperationError(
      '휴강할 담당 반 이름을 하나만 정확히 적어 주세요.',
      422,
    );
  return [...classesMentioned][0];
}

export function parseMakeupRequest(
  question: string,
  classes: { id: string; name: string }[],
  today: string,
) {
  const message = question.normalize('NFKC');
  if (
    !/휴강|수업\s*(?:을\s*)?쉬/u.test(message) ||
    /휴강(?:은|을|이)?\s*(?:취소|아니|없|안\s*(?:해|하)|하지\s*않|인가요|하나요|여부)/u.test(
      message,
    )
  )
    throw new OperationError(
      '휴강할 반과 날짜를 적어 주시면 보강 가능한 시간부터 찾아드릴게요.',
      422,
    );
  return {
    classId: classFromMessage(message, classes),
    date: requestedDate(message, today),
  };
}
