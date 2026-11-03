/**
 * Explicit single-request integration check. Sends only fixed synthetic content.
 * Run manually with a configured CLOVA or Gemini server key.
 */
import type { GenerationInput } from '../ports.ts';
import { createGenerationProviderFromEnv } from './from-env.ts';
import { validateGeneratedOutput } from './validate-output.ts';

const provider = createGenerationProviderFromEnv(process.env);
const sourceId = 'SYNTHETIC_PUBLIC_NOTICE';
const input: GenerationInput = {
  requestId: 'synthetic-generation-smoke',
  question: '가상 학원의 안내 데스크가 몇 시에 열리나요?',
  facts: [],
  sources: [
    {
      sourceId,
      title: '가상 학원 이용 안내',
      location: '안내 데스크',
      text: '가상 학원의 안내 데스크는 14시에 엽니다.',
    },
  ],
  containsPersonalData: false,
};

if (!/^(clova|gemini):/.test(provider.providerId)) {
  console.error('CLOVA 또는 Gemini의 서버 환경 변수를 설정해 주세요.');
  process.exitCode = 1;
} else {
  const result = await provider.generateGroundedAnswer(input, {
    now: Date.now(),
    timeoutMs: 15_000,
  });
  if (!result.ok) {
    console.error(`${provider.providerId} 요청 실패 (${result.error})`);
    process.exitCode = 1;
  } else {
    const validated = validateGeneratedOutput(result.rawText, {
      allowedSourceIds: [sourceId],
      allowedNumbers: new Set([14]),
      studentCodePattern: /ST_([A-Z0-9]+)/g,
      allowedStudentCodes: [],
    });
    if (!validated.ok || !/14\s*시/.test(validated.output.answer)) {
      console.error(`${provider.providerId} 합성 응답 검증 실패`);
      process.exitCode = 1;
    } else {
      console.log(`${provider.providerId} 합성 요청과 근거 검증 통과`);
    }
  }
}
