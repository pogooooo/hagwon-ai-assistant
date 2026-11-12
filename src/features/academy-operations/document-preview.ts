import {
  createRagConsultationService,
  InMemoryRagStore,
  DisabledGenerationProvider,
  InMemoryHandoffStore,
  InMemoryConversationStore,
  SystemClock,
  type SourceDocumentInput,
  type ApprovedFactInput,
} from '../rag-consultation/server/index.ts';
import { accessibleClasses, accessibleStudents } from './directory.ts';
import { escapeHtml as h, OperationError, type PageContext } from './shared.ts';

/** The caller supplies one readable, approved revision; no other document can enter this index. */
export async function previewDocument(
  ctx: PageContext,
  document: SourceDocumentInput,
  facts: ApprovedFactInput[],
  question: string,
) {
  if (question.length > 500)
    throw new OperationError('질문은 500자 이내로 입력해 주세요.', 422);
  const students = accessibleStudents(ctx.db, ctx.actor);
  const classes = accessibleClasses(ctx.db, ctx.actor);
  const store = new InMemoryRagStore();
  await store.upsertIndexedRevision({ document, facts, approve: true });
  const service = createRagConsultationService({
    documents: store,
    facts: store,
    generation: new DisabledGenerationProvider(),
    handoff: new InMemoryHandoffStore(),
    conversations: new InMemoryConversationStore(),
    clock: new SystemClock(),
    engine: 'planned',
    catalog: {
      getAcademyCatalog: async () => ({
        academyId: ctx.actor.academyId,
        displayName: '학원',
        aliases: [],
        classes: classes.map((c) => ({
          classId: c.id,
          name: c.name,
          aliases: [c.name],
          subject: c.subject,
          grade: c.grade,
        })),
        units: [],
        questionTypes: [],
      }),
    },
  });
  const { answer } = await service.query({
    question,
    conversationId: 'selected-document-preview',
    studentIdHint: document.studentId ?? undefined,
    access: {
      actorId: ctx.actor.id,
      academyId: ctx.actor.academyId,
      role: ctx.actor.role,
      allowedStudentIds: students.map((s) => s.id),
      allowedClassIds: classes.map((c) => c.id),
      studentRefs: students.map((s) => ({
        studentId: s.id,
        displayLabel: s.name,
        aliases: [s.name],
        classIds: s.classIds,
      })),
      canViewPublicHistory: false,
    },
  });
  ctx.assertCurrentAccess?.();
  return `<div class="answer-preview" role="status"><p class="preserve">${h(answer.answer)}</p><p class="muted">선택한 자료 한 개만 사용 · 생성 AI 호출 없음</p>${answer.citations.length ? `<ul>${answer.citations.map((c) => `<li>${h(c.title)} · ${h(JSON.stringify(c.location))}</li>`).join('')}</ul>` : ''}</div>`;
}
