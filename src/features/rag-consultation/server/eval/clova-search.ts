import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ClovaApi } from '../generation/clova-api.ts';
import {
  Bm25Ranker,
  DenseRanker,
  HybridRanker,
  type ChunkRanker,
} from '../retrieval/rankers.ts';

const vector = z.array(z.number().finite()).length(1024);
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function normalize(values: number[]) {
  const norm = Math.hypot(...values);
  if (!Number.isFinite(norm) || !norm)
    throw new Error('Invalid CLOVA embedding');
  return Float32Array.from(values, (value) => value / norm);
}

export function createClovaSearch(
  api: ClovaApi,
  cacheDir: string,
  mode: 'hybrid' | 'rerank' | 'gate',
  minIntervalMs = 1100,
): ChunkRanker {
  let nextCall = 0;
  async function request(path: string, body: object) {
    const start = Math.max(Date.now(), nextCall);
    nextCall = start + minIntervalMs;
    if (start > Date.now()) await delay(start - Date.now());
    return api.post(path, body);
  }
  async function embed(text: string) {
    const hash = createHash('sha256')
      .update('clova-embedding-v2\0')
      .update(text)
      .digest('hex');
    const file = join(cacheDir, hash + '.json');
    try {
      return normalize(vector.parse(JSON.parse(await readFile(file, 'utf8'))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const { embedding } = z
      .object({ embedding: vector })
      .parse(await request('/v1/api-tools/embedding/v2', { text }));
    const result = normalize(embedding);
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(embedding), { mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
    return result;
  }
  const base = new HybridRanker(
    new Bm25Ranker(),
    new DenseRanker({
      id: 'clova-embedding-v2',
      embedQuery: embed,
      async embedPassages(texts) {
        const values: Float32Array[] = [];
        for (const text of texts) values.push(await embed(text));
        return values;
      },
    }),
  );
  if (mode === 'hybrid') return base;
  return {
    id: 'clova-' + mode,
    async rank(candidates, query, context) {
      const ranked = await base.rank(candidates, query, context);
      if (!context?.question || !ranked.length || context.rerank === 'never')
        return ranked;
      const head = ranked.slice(0, 12);
      const { citedDocuments } = z
        .object({
          citedDocuments: z.array(z.object({ id: z.string() })),
        })
        .parse(
          await request('/v1/api-tools/reranker', {
            query: context.question,
            documents: head.map(({ chunk }, index) => ({
              id: String(index),
              doc: chunk.contextualText,
            })),
          }),
        );
      // The API returns selected IDs, without a relevance score. Model prose is discarded.
      const positions = new Map(
        head.map((entry, index) => [String(index), entry]),
      );
      const selected = [...new Set(citedDocuments.map(({ id }) => id))].map(
        (id) => {
          const entry = positions.get(id);
          if (!entry)
            throw new Error('CLOVA reranker returned an unknown document');
          return entry;
        },
      );
      if (mode === 'gate' && !selected.length) return [];
      const chosen = new Set(selected);
      return [...selected, ...ranked.filter((entry) => !chosen.has(entry))];
    },
  };
}
