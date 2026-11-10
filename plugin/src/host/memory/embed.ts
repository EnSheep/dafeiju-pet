/**
 * 文本向量：给记忆的语义召回用。
 *
 * 为什么不自己跑模型：本机已经在跑 Ollama，`bge-m3` 一次调用 20–60ms，
 * 直接复用比自己维护一个 embedding 进程省事，也不额外吃显存峰值（Ollama 会自己换页）。
 *
 * 三条约定：
 * 1. 失败一律抛错，由调用方决定降级（记忆少一层召回，不能让对话失败）；
 * 2. 只认 L2 归一化之前的原始向量，归一化在 {@link cosine} 里做，避免两处标准不一；
 * 3. 落库是 Float32 小端裸字节，没有版本号——换模型必须清 `vec` 列重算。
 * @module dsh-pet/src/host/memory/embed
 */

/** 把文本变成向量的东西；`id` 参与日志与缓存判断，换模型必须换 id。 */
export interface Embedder {
  /** 实现标识（`ollama:bge-m3`）。 */
  readonly id: string;
  /** 维度；落库前用来校验，防止换了模型却读到旧向量。 */
  readonly dim: number;
  /** 批量取向量；返回顺序与入参一致，长度不等视为失败。 */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

/** 造 Ollama 向量的参数。 */
export interface OllamaEmbedderOptions {
  /** 服务地址，默认 `http://127.0.0.1:11434`。 */
  readonly url?: string;
  /** 模型名，默认 `bge-m3`。 */
  readonly model?: string;
  /** 单次请求超时，默认 20s（首次加载模型会把 Ollama 的冷启动算进去）。 */
  readonly timeoutMs?: number;
  /** 单批条数，默认 16：一次几十条会把请求体堆大，收益也不明显。 */
  readonly batch?: number;
}

const DEFAULT_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'bge-m3';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_BATCH = 16;

/** bge-m3 的输出维度；别的模型要改这里（或者让 store 从第一次返回值里学）。 */
const DEFAULT_DIM = 1024;

/**
 * 造一个走 Ollama `/api/embed` 的向量实现。
 *
 * 不开 `keep_alive` 的话，模型会在几分钟空闲后被换出，下一次调用又要重新加载；
 * 这里显式给 30 分钟，和对话模型抢显存的风险由 Ollama 自己调度。
 */
export function createOllamaEmbedder(options: OllamaEmbedderOptions = {}): Embedder {
  const base = (options.url ?? DEFAULT_URL).replace(/\/+$/, '');
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const batch = Math.max(1, options.batch ?? DEFAULT_BATCH);
  let dim = DEFAULT_DIM;

  return {
    id: `ollama:${model}`,
    get dim() {
      return dim;
    },
    async embed(texts) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batch) {
        const slice = texts.slice(i, i + batch);
        const res = await fetch(`${base}/api/embed`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, input: slice, keep_alive: '30m' }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(`embed ${res.status} ${detail.slice(0, 160)}`);
        }
        const body = (await res.json()) as { embeddings?: unknown };
        const rows = Array.isArray(body.embeddings) ? (body.embeddings as number[][]) : [];
        if (rows.length !== slice.length) {
          throw new Error(`embed 返回条数不符：要 ${slice.length} 条，给 ${rows.length} 条`);
        }
        for (const row of rows) {
          const vec = Float32Array.from(row);
          dim = vec.length;
          out.push(vec);
        }
      }
      return out;
    },
  };
}

/**
 * 把向量压成 float32 小端裸字节（SQLite BLOB）。
 * 用 DataView 显式按小端写：不能依赖宿主字节序，库文件要能跨机器读。
 */
export function encodeVec(vec: Float32Array): Uint8Array {
  const buf = new ArrayBuffer(vec.length * 4);
  const view = new DataView(buf);
  for (let i = 0; i < vec.length; i++) view.setFloat32(i * 4, vec[i] ?? 0, true);
  return new Uint8Array(buf);
}

/**
 * 把库里的 BLOB 解回向量；不是 4 字节整数倍就当作坏数据返回 null。
 * @param raw - `node:sqlite` 返回的 BLOB（Uint8Array / Buffer 都吃）。
 */
export function decodeVec(raw: unknown): Float32Array | null {
  if (!(raw instanceof Uint8Array) || raw.byteLength === 0 || raw.byteLength % 4 !== 0) return null;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out = new Float32Array(raw.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/**
 * 余弦相似度；维度不等或任一为零向量时返回 0（当作不相关，而不是抛错）。
 *
 * 两边的模都现算：记忆条目几百条、每条 1024 维，一次召回十万次乘加量级，
 * 缓存模长要维护失效，不划算。
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}
