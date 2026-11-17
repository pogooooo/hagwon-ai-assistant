import { OperationError } from './shared.ts';

export type NeisRow = Record<string, unknown>;
export interface NeisResult {
  rows: NeisRow[];
  total: number;
  complete: boolean;
  fetchedAt: string;
  source: string;
}
export const neisText = (row: NeisRow, key: string) =>
  typeof row[key] === 'string' ? row[key].trim() : '';

/** Official endpoints only. Keys never appear in the returned provenance. */
export function createNeisClient(key = '', fetchImpl: typeof fetch = fetch) {
  const cache = new Map<string, { until: number; result: NeisResult }>();
  const pending = new Map<string, Promise<NeisResult>>();
  async function load(endpoint: string, params: Record<string, string>) {
    const url = new URL('https://open.neis.go.kr/hub/' + endpoint);
    url.search = new URLSearchParams({
      Type: 'json',
      pSize: key ? '100' : '5',
      ...params,
    }).toString();
    const source = url.href;
    if (key) url.searchParams.set('KEY', key);
    const rows: NeisRow[] = [];
    let total = 0;
    for (let page = 1; page <= 20; page++) {
      url.searchParams.set('pIndex', String(page));
      let data: Record<string, unknown>;
      try {
        const response = await fetchImpl(url, {
          signal: AbortSignal.timeout(15000),
          redirect: 'error',
        });
        if (!response.ok) throw new Error();
        const text = await response.text();
        if (text.length > 3_000_000) throw new Error();
        data = JSON.parse(text);
      } catch {
        throw new OperationError(
          '교육청 정보 조회에 실패했습니다. 잠시 후 다시 시도해 주세요.',
          503,
        );
      }
      const result = data.RESULT as { CODE?: string } | undefined;
      if (result?.CODE === 'INFO-200') break;
      const blocks = data[endpoint];
      if (!Array.isArray(blocks))
        throw new OperationError(
          '나이스 인증키 또는 조회 조건을 확인해 주세요.',
          503,
        );
      const head = blocks.find((x) => x.head)?.head as
        { list_total_count?: number; RESULT?: { CODE: string } }[] | undefined;
      if (head?.some((x) => x.RESULT && x.RESULT.CODE !== 'INFO-000'))
        throw new OperationError('교육청 정보 응답을 확인할 수 없습니다.', 503);
      total = Number(
        head?.find((x) => x.list_total_count !== undefined)?.list_total_count ??
          0,
      );
      const batch = blocks.find((x) => x.row)?.row;
      if (
        !Number.isSafeInteger(total) ||
        total < 0 ||
        !Array.isArray(batch) ||
        batch.some((x) => !x || typeof x !== 'object')
      )
        throw new OperationError(
          '교육청 정보 응답 형식이 올바르지 않습니다.',
          503,
        );
      rows.push(...batch);
      if (!key || rows.length >= total || batch.length === 0) break;
    }
    return {
      rows,
      total,
      complete: rows.length >= total,
      source,
      fetchedAt: new Date().toISOString(),
    };
  }
  return {
    async query(
      endpoint: 'acaInsTiInfo' | 'schoolInfo' | 'SchoolSchedule',
      params: Record<string, string>,
    ): Promise<NeisResult> {
      const id = JSON.stringify([endpoint, params]);
      const cached = cache.get(id);
      if (cached && cached.until > Date.now())
        return structuredClone(cached.result);
      let request = pending.get(id);
      if (!request) {
        request = load(endpoint, params)
          .then((result) => {
            if (cache.size >= 100) cache.delete(cache.keys().next().value!);
            cache.set(id, { until: Date.now() + 300000, result });
            return result;
          })
          .finally(() => pending.delete(id));
        pending.set(id, request);
      }
      return structuredClone(await request);
    },
  };
}

export function academyRegistration(row: NeisRow) {
  if (!neisText(row, 'ACA_ASNUM') || !neisText(row, 'ACA_NM'))
    throw new OperationError('학원 등록 정보를 확인해 주세요.');
  return {
    registration: neisText(row, 'ACA_ASNUM'),
    name: neisText(row, 'ACA_NM'),
    address: [neisText(row, 'FA_RDNMA'), neisText(row, 'FA_RDNDA')]
      .filter(Boolean)
      .join(' '),
    subject: neisText(row, 'LE_CRSE_LIST_NM'),
    course: neisText(row, 'LE_CRSE_NM') || neisText(row, 'LE_ORD_NM'),
    fee:
      neisText(row, 'THCC_OTHBC_YN') === 'Y'
        ? neisText(row, 'PSNBY_THCC_CNTNT')
        : '',
    feePublic: neisText(row, 'THCC_OTHBC_YN') === 'Y',
    status: neisText(row, 'REG_STTUS_NM'),
    updated: neisText(row, 'LOAD_DTM'),
  };
}
