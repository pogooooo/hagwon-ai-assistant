/**
 * 권한 필터를 이미 통과한 후보 집합 안에서만 계산하는 BM25.
 * IDF 도 허용된 후보로만 계산해 다른 학생/학원 문서의 통계가 점수에 섞이지 않게 한다.
 */
export interface Bm25Document {
  id: string;
  tokens: readonly string[];
}

export interface Bm25Options {
  k1?: number;
  b?: number;
}

export function bm25Rank<T extends Bm25Document>(
  documents: readonly T[],
  queryTokens: readonly string[],
  options: Bm25Options = {},
): Array<{ document: T; score: number }> {
  const k1 = options.k1 ?? 1.2;
  const b = options.b ?? 0.75;
  if (documents.length === 0 || queryTokens.length === 0) return [];

  const uniqueQuery = [...new Set(queryTokens)];
  const docFrequency = new Map<string, number>();
  const termFrequencies = documents.map((doc) => {
    const frequencies = new Map<string, number>();
    for (const token of doc.tokens) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    for (const token of frequencies.keys()) {
      docFrequency.set(token, (docFrequency.get(token) ?? 0) + 1);
    }
    return frequencies;
  });
  const averageLength =
    documents.reduce((sum, doc) => sum + doc.tokens.length, 0) /
      documents.length || 1;

  const results = documents.map((document, index) => {
    const frequencies = termFrequencies[index];
    let score = 0;
    for (const token of uniqueQuery) {
      const tf = frequencies.get(token);
      if (!tf) continue;
      const df = docFrequency.get(token) ?? 0;
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      const norm =
        tf + k1 * (1 - b + (b * document.tokens.length) / averageLength);
      score += idf * ((tf * (k1 + 1)) / norm);
    }
    return { document, score };
  });

  return results
    .filter((result) => result.score > 0)
    .sort(
      (a, b2) =>
        b2.score - a.score || a.document.id.localeCompare(b2.document.id),
    );
}
