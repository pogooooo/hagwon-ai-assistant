import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import {
  getActor,
  initializeIdentity,
} from '../academy-operations/directory.ts';
import type { PageContext } from '../academy-operations/shared.ts';
import {
  itemSchema,
  parse,
  type Item,
  type Reading,
  type Subject,
} from './contracts.ts';
import { GradingService, newId } from './service.ts';
import type { GradeProvider } from './provider.ts';
import { configureGrading } from './module.ts';
import { MemoryRawStore, type RawStore } from './raw-store.ts';

export function item(
  subject: Subject = 'MATH',
  extra: Partial<Item> = {},
): Item {
  return parse(itemSchema, {
    item_ref: newId('item'),
    item_no: '1',
    subject_id: subject,
    answer_type: subject === 'MATH' ? 'numeric' : 'text_exact',
    primary_skill_id: 'skill_' + subject,
    skill_label:
      subject === 'MATH'
        ? '분수 계산'
        : subject === 'ENG'
          ? '과거형'
          : '문법 형태',
    taxonomy_version: 'academy-1',
    max_score: '2',
    expected_page_no: 1,
    rubric_id: newId('rubric'),
    rubric_version: '1',
    approval_status: 'approved',
    aggregation_rule: 'sum_criteria',
    criteria: [
      {
        criterion_id: newId('criterion'),
        label: '내용',
        max_score: '2',
        allowed_scores: ['0', '1', '2'],
        criterion_type: subject === 'MATH' ? 'numeric' : 'exact_text',
        teacher_instruction: '등록 정답을 그대로 비교합니다.',
      },
    ],
    key: {
      key_id: newId('key'),
      key_version: '1',
      source: 'teacher_registered',
      approval_status: 'approved',
      rights_ref: 'rights_synthetic',
      accepted_texts:
        subject === 'KOR' ? ['안 한다'] : subject === 'ENG' ? ['went'] : [],
      numeric_target: subject === 'MATH' ? '1/2' : null,
    },
    ...extra,
  });
}
export function reading(
  def: Item,
  answer = def.subject_id === 'MATH'
    ? '1/2'
    : def.subject_id === 'ENG'
      ? 'went'
      : '안 한다',
  extra: Partial<Reading> = {},
): Reading {
  return {
    item_ref: def.item_ref,
    answer_observed: answer,
    unit_observed: '',
    answer_status: 'readable',
    association_status: 'matched',
    regions: [{ page_no: def.expected_page_no, bbox: [0, 0, 1, 1] }],
    ambiguity_codes: [],
    ...extra,
  };
}
export function photo() {
  const canvas = createCanvas(300, 180),
    c = canvas.getContext('2d');
  c.fillStyle = '#fff';
  c.fillRect(0, 0, 300, 180);
  c.fillStyle = '#111';
  c.font = '28px sans-serif';
  c.fillText('1. synthetic answer', 15, 70);
  return {
    bytes: new Uint8Array(canvas.toBuffer('image/png')),
    mime: 'image/png',
  };
}
export function fixture(
  t: TestContext,
  options: {
    provider?: GradeProvider;
    practiceProvider?: GradeProvider;
    raw?: RawStore;
    ttl?: number;
    detail?: 'none' | 'criteria' | 'criteria_and_codes';
  } = {},
) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  initializeIdentity(db, 'grading-fixture-password');
  t.after(() => db.close());
  let now = Date.parse('2026-11-19T03:00:00Z');
  const answers = new Map<string, Partial<Reading>>();
  const provider: GradeProvider = options.provider ?? {
    modelId: 'offline-fixture',
    inputAllowed: true,
    async read(_pages, assignment) {
      return assignment.items.map((i) =>
        reading(i, undefined, answers.get(i.item_ref)),
      );
    },
  };
  const raw = options.raw ?? new MemoryRawStore();
  const service = new GradingService(db, {
    provider,
    practiceProvider: options.practiceProvider,
    rawStore: raw,
    now: () => now,
    rawTtlMs: options.ttl,
    detailPolicy: options.detail,
  });
  configureGrading(db, service);
  const ctx = (user = 'TA_DIRECTOR'): PageContext => {
    const actor = getActor(db, user);
    if (!actor) throw new Error('Unknown fixture actor ' + user);
    return { db, actor, url: new URL('http://localhost/grading') };
  };
  const register = (items = [item()]) =>
    service.register(
      ctx(),
      {
        title: '합성 검증 과제',
        class_id: 'TA_E_MATH',
        rights_ref: 'rights_synthetic',
        items,
      },
      newId('request'),
    );
  const upload = async (a: ReturnType<typeof register>, date?: string) => {
    const input = service.create(
      ctx(),
      {
        ...a,
        student_ref: 'TA_STU_001',
        expected_page_count: 1,
        assessment_date: date,
      },
      newId('request'),
    );
    await service.upload(ctx(), input.submission_id, [photo()]);
    await service.process(ctx(), input.submission_id);
    return input.submission_id;
  };
  const review = async (id: string) => {
    const draft = await service.draft(ctx(), id);
    await service.patch(
      ctx(),
      id,
      draft.draft_revision,
      draft.items.map((i) => ({ ...i, reviewed: true })),
    );
    return service.draft(ctx(), id);
  };
  const confirm = async (id: string, purge = true) => {
    const draft = await review(id);
    const result = await service.confirm(
      ctx(),
      id,
      draft.draft_revision,
      newId('request'),
    );
    if (purge) await service.purge(id);
    return result;
  };
  return {
    db,
    raw,
    service,
    ctx,
    register,
    upload,
    review,
    confirm,
    answers,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
