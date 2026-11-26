/** 개발용: 평가 문항 하나를 돌려 답변·trace 를 출력한다. node debug-query.ts MS-072 [질문 덮어쓰기] */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ACADEMIES_DIR,
  buildAcademiesStore,
  createAcademyCatalogPort,
  readAcademiesDataset,
  toAcademyAccessScope,
} from '../adapters/fixture/load-academies.ts';
import {
  FixedClock,
  InMemoryConversationStore,
  InMemoryHandoffStore,
} from '../adapters/memory/index.ts';
import { MockGenerationProvider } from '../generation/providers.ts';
import { parseQuery } from '../query/parse-query.ts';
import { createRagConsultationService } from '../service.ts';
import { DEFAULT_RAG_CONFIG } from '../config.ts';
import { parseInstant } from '../text/time.ts';

const [id, override] = process.argv.slice(2);
const item = readFileSync(
  join(ACADEMIES_DIR, 'eval', 'middle-school-paraphrase.jsonl'),
  'utf-8',
)
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .find((o) => o.id === id);
const dataset = readAcademiesDataset();
const store = await buildAcademiesStore(dataset);
const catalog = createAcademyCatalogPort(dataset);
const user = dataset.users.find((u) => u.user_id === item.user_id)!;
const access = toAcademyAccessScope(user, dataset.students);
const asOf = parseInstant(item.as_of);
const question = override ?? item.query;
const cat = (await catalog.getAcademyCatalog(access.academyId))!;
const frame = parseQuery(question, {
  access,
  catalog: cat,
  config: DEFAULT_RAG_CONFIG,
});
console.log('Q', question);
console.log(
  'topics',
  frame.topics.map((t) => t.id),
  'classes',
  frame.classIds,
  'flags',
  Object.entries(frame.flags)
    .filter(([, v]) => v)
    .map(([k]) => k),
  'unauth',
  frame.unauthorizedStudentRefs,
  'analysis',
  frame.hasAnalysisTerms,
);
const service = createRagConsultationService({
  facts: store,
  documents: store,
  catalog,
  generation: new MockGenerationProvider('ok'),
  handoff: new InMemoryHandoffStore(),
  conversations: new InMemoryConversationStore(),
  clock: new FixedClock(asOf),
});
const { answer, trace } = await service.query({
  access,
  question,
  conversationId: 'dbg',
});
console.log(answer.status, trace.domain, trace.intent, trace.internalErrors);
console.log(answer.answer);
console.log(
  'cited',
  answer.citations.map((c) => c.sourceId),
);
