import { randomUUID } from 'node:crypto';
import { operationsGeneration } from './runtime-generation.ts';
import { OperationError } from './shared.ts';

export const DEFAULT_PARENT_TEMPLATE =
  '{{학생명}} 학부모님, 안녕하세요. {{학원명}}입니다.\n\n{{분석월}}의 확인된 학습 결과를 안내드립니다.\n\n{{학습요약}}\n\n궁금한 점은 학원 상담으로 문의해 주세요.';
const variables = ['학생명', '학원명', '분석월', '학습요약'];
export function validateParentTemplate(template: string, monthly = true) {
  if (
    !template.trim() ||
    template.length > 3000 ||
    /\{\{[^{}]*\}\}/g.test(
      template.replace(/\{\{(학생명|학원명|분석월|학습요약)\}\}/g, ''),
    )
  )
    throw new OperationError('문구와 자동 입력 항목을 확인해 주세요.', 422);
  if (
    monthly &&
    variables.some((v) => template.split('{{' + v + '}}').length !== 2)
  )
    throw new OperationError(
      '월간 문구에는 학생명·학원명·분석월·학습요약을 각각 한 번 넣어 주세요.',
      422,
    );
  if (!monthly && /\{\{(?:분석월|학습요약)\}\}/.test(template))
    throw new OperationError(
      '일반 안내에는 학생명·학원명만 자동 입력할 수 있습니다.',
      422,
    );
  return template;
}
export function fillParentTemplate(
  template: string,
  fields: Record<string, string>,
) {
  // One pass: a substituted value containing braces is never another instruction.
  return template.replace(
    /\{\{(학생명|학원명|분석월|학습요약)\}\}/g,
    (_, key: string) => fields[key] ?? '',
  );
}
export async function createParentTemplate(tone: string) {
  const provider = operationsGeneration();
  if (!['정중하게', '따뜻하게', '간결하게'].includes(tone))
    throw new OperationError('말투를 선택해 주세요.');
  if (
    !provider.providerId.startsWith('clova:') ||
    provider.availability(Date.now()) !== 'available'
  )
    throw new OperationError(
      '네이버 AI를 사용할 수 없습니다. 기본 문구를 수정해 사용할 수 있습니다.',
      503,
    );
  const result = await provider.generateGroundedAnswer(
    {
      mode: 'parent-template',
      requestId: randomUUID(),
      question: tone,
      sources: [],
      facts: [],
      containsPersonalData: false,
    },
    { now: Date.now(), timeoutMs: 20000 },
  );
  if (!result.ok)
    throw new OperationError(
      'AI 문구를 만들지 못했습니다. 기존 문구는 유지됩니다.',
      503,
    );
  try {
    const data: unknown = JSON.parse(result.rawText);
    if (
      !data ||
      typeof data !== 'object' ||
      !('intro' in data) ||
      !('closing' in data) ||
      typeof data.intro !== 'string' ||
      typeof data.closing !== 'string' ||
      [data.intro, data.closing].some(
        (s) => !s.trim() || s.length > 150 || /[0-9{}@]|https?:/.test(s),
      )
    )
      throw new Error('invalid template');
    // This task has no learner evidence: retain only neutral present-tense
    // delivery/contact language, never a model's assessment of the child.
    const assessment =
      /노력|성실|꾸준|향상|하락|발전|성장|돋보|실력|태도|성취|성과|우수|부진|부족|성적|점수|집중|참여|이번|지난|다음|오늘|어제|내일|했|였|었|됐/;
    const intro =
      !assessment.test(data.intro) &&
      /(기록|결과|리포트|자료)/.test(data.intro) &&
      /(안내|전달|확인|참고)/.test(data.intro)
        ? data.intro.trim()
        : '확인된 학습 기록을 안내해 드립니다.';
    const closing =
      !assessment.test(data.closing) && /(문의|연락|상담)/.test(data.closing)
        ? data.closing.trim()
        : '궁금한 사항은 학원으로 문의해 주세요.';
    return validateParentTemplate(
      `{{학생명}} 학부모님, {{학원명}}의 {{분석월}} 학습 기록입니다.\n\n${intro}\n\n{{학습요약}}\n\n${closing}`,
    );
  } catch {
    throw new OperationError(
      'AI 문구를 확인하지 못했습니다. 기존 문구는 유지됩니다.',
      502,
    );
  }
}
