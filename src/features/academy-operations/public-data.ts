import { academyRegistration, neisText, type NeisResult } from './neis.ts';
import { createKnowledgeDraft, requireAdmin } from './knowledge.ts';
import {
  escapeHtml as h,
  field,
  required,
  one,
  OperationError,
  type OperationModule,
} from './shared.ts';
import { randomUUID } from 'node:crypto';

const cell = (s: string) => s.replace(/\|/g, '／').replace(/[\r\n]+/g, ' ');
export const publicDataModule: OperationModule = {
  path: '/public-data',
  label: '교육청 정보',
  roles: ['admin'],
  setup(db) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS op_public_search(id TEXT PRIMARY KEY,academy_id TEXT NOT NULL,actor_id TEXT NOT NULL,result TEXT NOT NULL,expires_at INTEGER NOT NULL)',
    );
  },
  render(ctx) {
    requireAdmin(ctx);
    const saved = one<{ result: string }>(
      ctx.db,
      'SELECT result FROM op_public_search WHERE id=? AND academy_id=? AND actor_id=? AND expires_at>?',
      ctx.url.searchParams.get('search') ?? '',
      ctx.actor.academyId,
      ctx.actor.id,
      Date.now(),
    );
    const result: NeisResult | undefined = saved
      ? JSON.parse(saved.result)
      : undefined;
    return `<div class="page-heading"><h1>교육청 등록 정보 불러오기</h1><p>학원을 선택하면 확인 대기로 저장합니다. 원장 승인 후 상담에 사용됩니다.</p></div><section class="panel"><form method="post"><input type="hidden" name="action" value="search"><div class="fields"><label>교육청 코드<input name="office" value="N10" maxlength="3" required></label><label>시·군·구<input name="district" value="아산시" maxlength="40"></label><label>학원 이름<input name="name" maxlength="100" required></label></div><button>학원 검색</button></form></section>${
      result
        ? `<p role="status">${result.rows.length}건 표시 / 전체 ${result.total}건${result.complete ? '' : ' · 일부 결과입니다. 인증키를 설정하거나 검색어를 좁혀 주세요.'}</p>${result.rows
            .map((row, i) => {
              const a = academyRegistration(row);
              return `<section class="panel"><h2>${h(a.name)}</h2><p>${h(a.address)} · ${h(a.status)}</p><p>${h(a.subject)} ${h(a.course)}</p><p>등록 교습비: ${h(a.fee || (a.feePublic ? '등록된 금액 없음' : '비공개'))}</p><p class="muted">교육청 등록 정보 · 가져온 날짜 ${h(result.fetchedAt.slice(0, 10))}</p><form method="post"><input type="hidden" name="search" value="${h(ctx.url.searchParams.get('search'))}"><input type="hidden" name="index" value="${i}"><button name="action" value="import">이 학원 정보 검토하기</button></form></section>`;
            })
            .join('')}`
        : ''
    }`;
  },
  async submit(ctx, form) {
    requireAdmin(ctx);
    if (field(form, 'action') === 'search') {
      const office = required(form, 'office', '교육청 코드', 3);
      if (!/^[A-Z]\d{2}$/.test(office))
        throw new OperationError('교육청 코드를 확인해 주세요.');
      const result = await ctx.services!.neis.query('acaInsTiInfo', {
        ATPT_OFCDC_SC_CODE: office,
        ACA_NM: required(form, 'name', '학원 이름', 100),
        ...(field(form, 'district', 40)
          ? { ADMST_ZONE_NM: field(form, 'district', 40) }
          : {}),
      });
      requireAdmin(ctx);
      const id = randomUUID();
      ctx.db
        .prepare('DELETE FROM op_public_search WHERE expires_at<=?')
        .run(Date.now());
      ctx.db
        .prepare('INSERT INTO op_public_search VALUES(?,?,?,?,?)')
        .run(
          id,
          ctx.actor.academyId,
          ctx.actor.id,
          JSON.stringify(result),
          Date.now() + 900000,
        );
      return '/public-data?search=' + id;
    }
    if (field(form, 'action') !== 'import')
      throw new OperationError('지원하지 않는 작업입니다.');
    const saved = one<{ result: string }>(
      ctx.db,
      'SELECT result FROM op_public_search WHERE id=? AND academy_id=? AND actor_id=? AND expires_at>?',
      field(form, 'search'),
      ctx.actor.academyId,
      ctx.actor.id,
      Date.now(),
    );
    const result: NeisResult | undefined = saved
      ? JSON.parse(saved.result)
      : undefined;
    const index = Number(field(form, 'index'));
    if (!Number.isInteger(index) || !result?.rows[index])
      throw new OperationError(
        '검색 결과가 만료되었습니다. 다시 검색해 주세요.',
        409,
      );
    const raw = result.rows[index],
      a = academyRegistration(raw);
    const values = [
      ['주소', a.address],
      ['과목', a.subject],
      ['과정', a.course],
      ...(a.fee ? [['등록 교습비', a.fee]] : []),
    ].filter(([, v]) => v);
    createKnowledgeDraft(ctx, {
      kind: 'registration',
      title: a.name + ' 교육청 등록 정보',
      question: a.name + ' 등록 정보',
      topic:
        'registration:' +
        neisText(raw, 'ATPT_OFCDC_SC_CODE') +
        ':' +
        a.registration,
      body: values.map(([k, v]) => `## ${k}\n${k}: ${cell(v)}`).join('\n\n'),
      provenance: `교육청 등록 정보 · 가져온 날짜 ${result.fetchedAt.slice(0, 10)} · ${result.source}`,
    });
    return '/knowledge';
  },
};
