/**
 * 기술 조사 문서의 로컬 모델 실험용 어댑터(생성 API 호출 0회, 로컬 CPU 추론).
 * - Kiwi 형태소 분석(5.1절, E03/E25): kiwi-nlp(WASM) + kiwipiepy_model 0.24.0 모델 파일
 * - multilingual-e5-small 임베딩(5.2절, E04/E32): `query: ` / `passage: ` 접두어, 512토큰 상한 잘림 집계
 * - bge-reranker-v2-m3 Cross-Encoder(6.2절, E07): 상위 후보만 재정렬
 *
 * ⚠️ 개발·평가 전용. kiwi-nlp·@huggingface/transformers 는 devDependencies 이고 서비스 기본 경로는 이 파일을 import 하지 않는다.
 * 모델 파일은 저장소에 넣지 않고 RAG_MODEL_CACHE_DIR(기본 ~/.cache/axr-rag-models)에 둔다. 받는 방법은 README 참고.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type {
  CrossEncoder,
  TextEmbedder,
  TextTokenizer,
} from '../../retrieval/rankers.ts';

export function modelCacheDir(): string {
  return (
    process.env.RAG_MODEL_CACHE_DIR ??
    join(homedir(), '.cache', 'axr-rag-models')
  );
}

export const KIWI_MODEL_VERSION = '0.24.0';

/** Kiwi 품사 중 검색어로 쓰는 것: 명사·동사/형용사 어간·어근·외국어·숫자·한자·일반 부사(조사·어미·접사·문장부호 제외). */
function keepMorph(tag: string): 'noun' | 'verb' | null {
  const base = tag.replace(/-[RI]$/, '');
  if (/^(NNG|NNP|NNB|NR|XR|SL|SN|SH|MAG)$/.test(base)) return 'noun';
  if (/^(VV|VA)$/.test(base)) return 'verb';
  return null;
}

/**
 * Kiwi 형태소 토크나이저. 사용자 사전은 카탈로그(반 이름·별칭·단원·유형)에서 띄어쓰기 단위로 만든다
 * (조사 문서 5.1절 "Kiwi 형태소 분석 및 사용자 사전 + 문서 메타데이터 별칭 매핑").
 */
export async function createKiwiTokenizer(
  options: { userWords?: readonly string[]; modelDir?: string } = {},
): Promise<TextTokenizer & { buildMs: number }> {
  const modelDir =
    options.modelDir ?? join(modelCacheDir(), 'kiwi', KIWI_MODEL_VERSION);
  if (!existsSync(join(modelDir, 'sj.morph'))) {
    throw new Error(
      `Kiwi 모델 파일이 없습니다: ${modelDir} (README 의 "로컬 모델 준비" 참고)`,
    );
  }
  const require = createRequire(import.meta.url);
  const entry = require.resolve('kiwi-nlp');
  const { KiwiBuilder } = await import('kiwi-nlp');
  const modelFiles: Record<string, Uint8Array> = {};
  for (const name of readdirSync(modelDir)) {
    if (name.endsWith('.py')) continue;
    modelFiles[name] = new Uint8Array(readFileSync(join(modelDir, name)));
  }
  const words = [...new Set(options.userWords ?? [])].filter(
    (word) => /[가-힣]/.test(word) && word.length >= 2 && !/\s/.test(word),
  );
  const started = Date.now();
  const builder = await KiwiBuilder.create(
    join(dirname(entry), 'kiwi-wasm.wasm'),
  );
  const kiwi = await builder.build({
    modelFiles,
    modelType: 'cong',
    userWords: words.map((word) => ({ word, tag: 'NNP' })),
  });
  const buildMs = Date.now() - started;
  return {
    id: `kiwi-${builder.version()}+userdict${words.length}`,
    buildMs,
    tokenize(text: string): string[] {
      const tokens: string[] = [];
      for (const token of kiwi.tokenize(text.toLowerCase())) {
        const kind = keepMorph(token.tag);
        if (!kind) continue;
        tokens.push(kind === 'verb' ? `${token.str}다` : token.str);
      }
      return tokens;
    },
  };
}

type Transformers = typeof import('@huggingface/transformers');

async function loadTransformers(): Promise<Transformers> {
  const transformers = await import('@huggingface/transformers');
  transformers.env.cacheDir = join(modelCacheDir(), 'hf');
  return transformers;
}

export const E5_MODEL = 'Xenova/multilingual-e5-small';
export const RERANKER_MODEL = 'onnx-community/bge-reranker-v2-m3-ONNX';
const MAX_TOKENS = 512;

/** multilingual-e5-small(q8). 문서는 `passage: `, 질문은 `query: ` 접두어(모델 카드 규칙, 5.2절). */
export async function createE5Embedder(): Promise<
  TextEmbedder & { stats(): { passages: number; truncated: number } }
> {
  const transformers = await loadTransformers();
  const extractor = await transformers.pipeline(
    'feature-extraction',
    E5_MODEL,
    {
      dtype: 'q8',
    },
  );
  let passages = 0;
  let truncated = 0;
  const embed = async (texts: string[]): Promise<Float32Array[]> => {
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    const [rows, dim] = output.dims as [number, number];
    const data = output.data as Float32Array;
    return Array.from({ length: rows }, (_, row) =>
      data.slice(row * dim, (row + 1) * dim),
    );
  };
  return {
    id: 'e5-small-q8',
    async embedQuery(text: string) {
      const [vector] = await embed([`query: ${text}`]);
      return vector;
    },
    async embedPassages(texts: readonly string[]) {
      const vectors: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += 16) {
        const batch = texts.slice(i, i + 16).map((text) => `passage: ${text}`);
        for (const text of batch) {
          const ids = extractor.tokenizer(text).input_ids;
          if ((ids.dims.at(-1) ?? 0) > MAX_TOKENS) truncated += 1;
        }
        passages += batch.length;
        vectors.push(...(await embed(batch)));
      }
      return vectors;
    },
    stats: () => ({ passages, truncated }),
  };
}

/** bge-reranker-v2-m3(q8) Cross-Encoder. 점수는 로짓(클수록 관련). */
export async function createBgeReranker(): Promise<CrossEncoder> {
  const transformers = await loadTransformers();
  const tokenizer =
    await transformers.AutoTokenizer.from_pretrained(RERANKER_MODEL);
  const model =
    await transformers.AutoModelForSequenceClassification.from_pretrained(
      RERANKER_MODEL,
      { dtype: 'q8' },
    );
  return {
    id: 'bge-reranker-v2-m3-q8',
    async score(query: string, passages: readonly string[]) {
      const scores: number[] = [];
      for (let i = 0; i < passages.length; i += 8) {
        const batch = passages.slice(i, i + 8);
        const inputs = tokenizer(new Array(batch.length).fill(query), {
          text_pair: [...batch],
          padding: true,
          truncation: true,
          max_length: MAX_TOKENS,
        });
        const { logits } = await model(inputs);
        scores.push(...(logits.data as Float32Array));
      }
      return scores;
    },
  };
}
