import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import {
  readAcademiesDataset,
  sourceIdOf,
  type AcademyDocument,
} from '../adapters/fixture/load-academies.ts';
import { readFixtureData } from '../adapters/fixture/load-fixture.ts';
import { compactText, normalizeText } from '../text/normalize.ts';
import { loadSuite, type Suite } from './harness.ts';

const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');

function textFingerprint(value: string): string | undefined {
  const normalized = normalizeText(value);
  return normalized ? 'text:' + hash(normalized) : undefined;
}

function fileFingerprints(path: string): string[] {
  const bytes = readFileSync(path);
  const fingerprints = ['file:' + hash(bytes)];
  if (/^\.(?:md|markdown|txt|text|csv)$/i.test(extname(path))) {
    // A non-UTF-8 file still has its byte fingerprint. Do not compare lossy text.
    const decoded = bytes.toString('utf8');
    const text = decoded.includes('\uFFFD')
      ? undefined
      : textFingerprint(decoded);
    if (text) fingerprints.push(text);
  }
  return fingerprints;
}

function documentFingerprints(document: AcademyDocument): string[] {
  if (document.source) return fileFingerprints(document.source.path);
  const content = textFingerprint(document.body);
  return content ? [content] : [];
}

function conversationFingerprint(
  query: string,
  history: readonly string[] = [],
) {
  return hash(
    JSON.stringify(
      [...history, query].map((turn) =>
        compactText(turn).replace(/[.?!]+$/, ''),
      ),
    ),
  );
}

/** Detect literal reuse of checked-in material. Similar phrasing alone may occur naturally. */
export function auditHoldoutOverlap(holdout: Suite, fixtureRoot: string) {
  const paraphrase = loadSuite('v1-paraphrase-100');
  const academyDatasets = [
    paraphrase.dataset,
    readAcademiesDataset(join(fixtureRoot, 'academies-v2')),
  ];
  const synthetic = readFixtureData(join(fixtureRoot, 'axr-synthetic-v1'));
  const academyIds = new Set([
    ...academyDatasets.flatMap(({ academies }) =>
      academies.map(({ academy_id }) => academy_id),
    ),
    ...synthetic.users.map(({ academy_id }) => academy_id),
  ]);
  const caseIds = new Set<string>();
  const conversations = new Set<string>();
  const addCase = (id: string, query: string, history?: readonly string[]) => {
    caseIds.add(id);
    conversations.add(conversationFingerprint(query, history));
  };
  for (const { id, query, history } of paraphrase.cases)
    addCase(id, query, history);
  for (const dataset of academyDatasets) {
    for (const { case_id, input } of dataset.cases)
      addCase(
        case_id,
        input.query,
        input.history?.map(({ query }) => query),
      );
  }
  for (const { case_id, input } of synthetic.cases)
    addCase(case_id, input.query);

  const documents = new Map<string, string>();
  for (const dataset of academyDatasets) {
    for (const document of dataset.documents) {
      for (const fingerprint of documentFingerprints(document))
        documents.set(fingerprint, document.file);
    }
  }
  for (const document of synthetic.documents) {
    const fingerprint = textFingerprint(document.text);
    if (fingerprint)
      documents.set(fingerprint, 'axr-synthetic-v1/' + document.document_id);
  }
  const parserFixtures = join(fixtureRoot, 'documents-v1', 'documents');
  for (const file of readdirSync(parserFixtures, { withFileTypes: true })) {
    if (
      !file.isFile() ||
      !/\.(?:pdf|docx|hwpx|txt|text|csv|md|markdown)$/i.test(file.name)
    )
      continue;
    for (const fingerprint of fileFingerprints(join(parserFixtures, file.name)))
      documents.set(fingerprint, 'documents-v1/documents/' + file.name);
  }

  const matchedAcademyIds = holdout.dataset.academies
    .map(({ academy_id }) => academy_id)
    .filter((id) => academyIds.has(id));
  const matchedCaseIds = holdout.cases
    .filter(({ id }) => caseIds.has(id))
    .map(({ id }) => id);
  const repeatedConversationCaseIds = holdout.cases
    .filter(({ query, history }) =>
      conversations.has(conversationFingerprint(query, history)),
    )
    .map(({ id }) => id);
  const matchedDocuments = holdout.dataset.documents.flatMap((document) => {
    const references = [
      ...new Set(
        documentFingerprints(document).flatMap((fingerprint) => {
          const reference = documents.get(fingerprint);
          return reference ? [reference] : [];
        }),
      ),
    ];
    return references.length
      ? [
          {
            sourceId: sourceIdOf(document.meta),
            input: document.file,
            references,
          },
        ]
      : [];
  });
  const knownOverlap =
    matchedAcademyIds.length > 0 ||
    matchedCaseIds.length > 0 ||
    matchedDocuments.length > 0;
  return {
    status: knownOverlap
      ? ('known_overlap' as const)
      : ('human_review_required' as const),
    checked: {
      academyIds: academyIds.size,
      caseIds: caseIds.size,
      conversations: conversations.size,
      documentFingerprints: documents.size,
    },
    matchedAcademyIds,
    matchedCaseIds,
    repeatedConversationCaseIds,
    matchedDocuments,
  };
}
