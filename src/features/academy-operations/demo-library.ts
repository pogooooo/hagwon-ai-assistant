import { DEFAULT_RAG_CONFIG } from '../rag-consultation/server/config.ts';
import { validateDocument } from '../rag-consultation/server/ingest/validation.ts';
import type {
  ApprovedFactInput,
  SourceDocumentInput,
} from '../rag-consultation/server/types.ts';
import type { OperationsDatabase } from './database.ts';
import { englishDemoLibrary } from './demo-library-english.ts';
import { mathDemoLibrary } from './demo-library-math.ts';
import { one, transaction } from './shared.ts';

export interface DemoLibraryDocument
  extends
    Pick<SourceDocumentInput, 'title' | 'text' | 'documentType'>,
    Partial<Pick<SourceDocumentInput, 'visibility' | 'classId' | 'studentId'>> {
  key: string;
  validFrom?: string;
  validTo?: string;
  state?: 'draft';
  facts?: readonly (Pick<
    ApprovedFactInput,
    'factType' | 'value' | 'evidence'
  > & {
    classId?: string;
  })[];
}

const libraries = [
  ['AC_TEST_A', '[가상] 테스트 교습소', 'TA_OPS_', mathDemoLibrary],
  [
    'AC_ONDAP_LANGUAGE_DEMO',
    '[가상] 온답 어학원',
    'ONDAP_EN_OPS_',
    englishDemoLibrary,
  ],
] as const;

/** Provision authored fixtures for the two trial academies. Keep staff revisions and withdrawals. */
export function seedDemoLibrary(db: OperationsDatabase) {
  const hasClass = db.prepare(
    'SELECT 1 FROM classes WHERE academy_id=? AND id=?',
  );
  const hasStudent = db.prepare(
    'SELECT 1 FROM student_class_memberships WHERE academy_id=? AND class_id=? AND student_id=? AND ended_at IS NULL',
  );
  const existing = db.prepare(
    'SELECT 1 FROM op_document_versions WHERE academy_id=? AND document_id=?',
  );
  const insert = db.prepare(
    'INSERT INTO op_document_versions (academy_id,document_id,revision,input,facts,state) VALUES (?,?,1,?,?,?)',
  );
  transaction(db, () => {
    for (const [academyId, name, prefix, library] of libraries) {
      if (
        !one(
          db,
          'SELECT 1 FROM academies WHERE id=? AND name=?',
          academyId,
          name,
        )
      )
        continue;
      for (const definition of library) {
        const documentId = prefix + definition.key;
        if (existing.get(academyId, documentId)) continue;
        if (definition.classId && !hasClass.get(academyId, definition.classId))
          continue;
        if (
          definition.studentId &&
          (!definition.classId ||
            !hasStudent.get(
              academyId,
              definition.classId,
              definition.studentId,
            ))
        )
          continue;
        const validFrom =
          (definition.validFrom ?? '2026-11-20') + 'T09:00:00+09:00';
        const validTo = definition.validTo
          ? definition.validTo + 'T00:00:00+09:00'
          : null;
        const state = definition.state ?? 'published';
        const sourceId = documentId + ':r1:body';
        const input: SourceDocumentInput = {
          academyId,
          documentId,
          sourceId,
          revision: 1,
          title: definition.title,
          text: '# ' + definition.title + '\n\n' + definition.text,
          documentType: definition.documentType,
          visibility: definition.visibility ?? 'academy_public',
          classId: definition.classId ?? null,
          studentId: definition.studentId ?? null,
          validFrom,
          validTo,
          approvedAt: state === 'draft' ? null : validFrom,
        };
        const facts: ApprovedFactInput[] = (definition.facts ?? [])
          .filter(({ classId }) => !classId || hasClass.get(academyId, classId))
          .map(({ classId, factType, value, evidence }, index) => ({
            factId: documentId + ':' + (index + 1),
            academyId,
            documentId,
            sourceId,
            revision: 1,
            subjectType: classId ? 'class' : 'academy',
            subjectId: classId ?? academyId,
            factType,
            value,
            approvalStatus: state === 'draft' ? 'pending_review' : 'approved',
            period: null,
            validFrom,
            validTo,
            evidence,
          }));
        const validation = validateDocument(input, facts, DEFAULT_RAG_CONFIG);
        if (!validation.ok)
          throw new Error(
            'Invalid demo document ' +
              documentId +
              ' (' +
              validation.problems.join(', ') +
              ')',
          );
        insert.run(
          academyId,
          documentId,
          JSON.stringify(input),
          JSON.stringify(facts),
          state,
        );
      }
    }
  });
}
