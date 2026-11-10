/**
 * 本地记忆库（SQLite）的读写与召回。
 *
 * 存在的理由：`chat-memory` 只把最近 N 轮原文塞进提示词，更早的对话虽然留在
 * `memory.json` 里却永远进不了上下文——表现就是「聊过几轮就忘了」。这一层把每一轮
 * 原文镜像进 SQLite，再按关键词 + 时间衰减把相关的旧话捞回提示词。
 *
 * 三条硬约束（来自设计文档）：
 * 1. 只影响「怎么提」，不改 scope、不改权限；
 * 2. 进提示词的条数有上限，且每条要短；
 * 3. 写库失败绝不影响回复——本模块所有写入都是尽力而为，从不抛给调用方。
 *
 * 中文全文检索的坑（实测，2026-11-05）：
 * - FTS5 的 `unicode61` 把整句中文当一个 token，搜「乳腺癌」0 命中；
 * - `trigram` 只支持 3 字以上，「房东」「复查」0 命中。
 * 所以这里先用 `LIKE` 直扫：几千条记忆扫一遍是毫秒级，等真到十万条再换分词器。
 * @module dsh-pet/src/host/memory/store
 */
import { createRequire } from 'node:module';

import { cosine, decodeVec, encodeVec, type Embedder } from './embed.ts';

/** 一条召回到的历史消息（或一条事实层记忆）。 */
export interface RecallHit {
  readonly ts: number;
  readonly role: string;
  readonly content: string;
  readonly score: number;
  /** true 表示来自事实层（`memories` 表），而不是原文层。 */
  readonly fact?: boolean;
}

/** 记忆库统计（只用于日志与体检，不含正文）。 */
export interface MemoryStats {
  readonly enabled: boolean;
  readonly messages: number;
  readonly memories: number;
}

/** 打开参数。 */
export interface MemoryStoreInput {
  /** 库文件绝对路径（`<userRoot>/memory.db`）。 */
  readonly file: string;
  /** 日志出口：只记条数与失败原因，不记正文。 */
  readonly log: { info(message: string): void; error(message: string): void };
  /**
   * 向量实现。不给就只有关键词召回（库照样能开、能写）。
   * 给了也不会在写入时同步算——向量走 `backfillVectors()` 补，避免拖慢回复。
   */
  readonly embed?: Embedder;
}

/** 写入一轮对话。 */
export interface AppendTurnInput {
  readonly petId: string;
  readonly ts: number;
  readonly userText: string;
  readonly assistantText: string;
  readonly userImage?: string;
}

/** 召回参数。 */
export interface RecallInput {
  /** 只看这只宠物的记忆。 */
  readonly petId: string;
  /** 当前这句话：用它抽关键词。 */
  readonly query: string;
  /** 最多返回几条。 */
  readonly limit: number;
  /** 只召回比这个时间更早的消息（避免和提示词里已有的最近几轮重复）。 */
  readonly before?: number;
  /**
   * 当前这句话的向量。给了才走语义召回路；没给（或没有 embedder）就只走关键词。
   * 由调用方先 await `embedQuery()` 再传进来——`recall` 保持同步，测试与降级路径都不必改。
   */
  readonly queryVec?: Float32Array | null;
}

// —— node:sqlite 的最小类型面。用 createRequire 取，避免 @types/node 版本不一导致的解析失败 ——

interface SqliteResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

interface SqliteStatement {
  run(...params: unknown[]): SqliteResult;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/** 建表语句：原文层（messages）先落地，事实层（memories）留给后续步骤。 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pet_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  ts INTEGER NOT NULL,
  image_name TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_ts_role ON messages(pet_id, ts, role);
CREATE INDEX IF NOT EXISTS ix_messages_pet_ts ON messages(pet_id, ts);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pet_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.8,
  valence REAL,
  arousal REAL,
  dominance REAL,
  emotion TEXT,
  source_ts INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  access_count INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_memories_pet ON memories(pet_id, archived, created_at);
`;

/** 出现在任何一句话里都不带信息的词：参与打分只会把无关的旧话顶上来。 */
const STOPWORDS = new Set([
  '我们',
  '你们',
  '他们',
  '她们',
  '什么',
  '怎么',
  '这个',
  '那个',
  '就是',
  '可以',
  '不是',
  '一个',
  '现在',
  '今天',
  '明天',
  '昨天',
  '真的',
  '觉得',
  '知道',
  '没有',
  '还是',
  '因为',
  '所以',
  '但是',
  '然后',
  '感觉',
  '有点',
  '一下',
  '时候',
  '自己',
  '东西',
  '这样',
  '那样',
  '如果',
  '应该',
  '可能',
  '已经',
]);

/**
 * 从一句话里抽检索用的关键词。
 *
 * 中文没有空格，直接按整句 LIKE 会一条都匹配不上，所以取 2–4 字的片段：
 * 短句整句留用，长句切成相邻两字（滑窗）。英文/数字按整词取。
 * @param query - 用户当前这句话。
 * @returns 去重后的关键词，最多 12 个。
 */
export function keywordsOf(query: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (word: string): void => {
    const w = word.trim();
    if (w.length < 2 || seen.has(w) || STOPWORDS.has(w)) return;
    seen.add(w);
    out.push(w);
  };
  for (const run of query.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length <= 4) {
      push(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i++) push(run.slice(i, i + 2));
  }
  for (const word of query.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []) push(word);
  // 长词更具体，先留长的：截断时丢掉的最可能是泛词
  out.sort((a, b) => b.length - a.length);
  return out.slice(0, 12);
}

/** 一小张情绪词表：够用就行，不追求覆盖。 */
const EMOTION_LEXICON: ReadonlyArray<{
  readonly words: readonly string[];
  readonly emotion: string;
  readonly valence: number;
  readonly arousal: number;
  readonly dominance: number;
}> = [
  { words: ['开心', '高兴', '太好了', '好开心', '美滋滋'], emotion: '喜悦', valence: 0.8, arousal: 0.6, dominance: 0.6 },
  { words: ['累', '疲惫', '熬', '没力'], emotion: '疲惫', valence: -0.4, arousal: 0.2, dominance: 0.3 },
  { words: ['难受', '不舒服', '疼', '痛'], emotion: '痛苦', valence: -0.7, arousal: 0.6, dominance: 0.2 },
  { words: ['怕', '害怕', '慌', '紧张'], emotion: '恐惧', valence: -0.6, arousal: 0.8, dominance: 0.2 },
  { words: ['生气', '烦', '讨厌', '气死'], emotion: '愤怒', valence: -0.7, arousal: 0.8, dominance: 0.7 },
  { words: ['委屈', '想哭', '难过', '伤心'], emotion: '悲伤', valence: -0.8, arousal: 0.5, dominance: 0.2 },
  { words: ['焦虑', '担心', '发愁'], emotion: '焦虑', valence: -0.6, arousal: 0.7, dominance: 0.3 },
  { words: ['释然', '想通了', '放下了'], emotion: '释然', valence: 0.5, arousal: 0.2, dominance: 0.7 },
];

/** 一句话里带的情绪。 */
export interface AffectHit {
  readonly emotion: string;
  readonly valence: number;
  readonly arousal: number;
  readonly dominance: number;
}

/**
 * 规则层情绪识别：命中词表就返回，没命中返回 null。
 *
 * 故意不调模型：这条路上每轮都会跑，模型调用会把延迟和成本拉起来，
 * 而「这句是不是带情绪」用词表判断已经够准。
 * @param text - 任意一段文字。
 * @returns 情绪四元组，或 null。
 */
export function affectOf(text: string): AffectHit | null {
  for (const entry of EMOTION_LEXICON) {
    for (const word of entry.words) {
      if (text.includes(word)) {
        return {
          emotion: entry.emotion,
          valence: entry.valence,
          arousal: entry.arousal,
          dominance: entry.dominance,
        };
      }
    }
  }
  return null;
}

/** 抽出来的一条事实。 */
export interface FactDraft {
  readonly kind: 'name' | 'like' | 'dislike' | 'fact';
  readonly content: string;
  readonly importance: number;
}

/** 「我叫X」「我不吃X」这类句子的抽取规则：宁缺毋滥，抽错比抽不到更伤。 */
const FACT_PATTERNS: ReadonlyArray<{ readonly re: RegExp; readonly kind: FactDraft['kind']; readonly importance: number }> = [
  // 问句不能当事实：「我叫什么名字」不是自报姓名
  { re: /(?:我叫|我的名字是|叫我)(?!什么|啥|谁|哪)([\u4e00-\u9fffA-Za-z0-9]{1,10})/, kind: 'name', importance: 0.95 },
  { re: /我对([\u4e00-\u9fff]{1,8})过敏/, kind: 'fact', importance: 0.95 },
  { re: /我(?:不喜欢|不吃|不喝|讨厌|受不了|怕)([\u4e00-\u9fffA-Za-z0-9]{1,12})/, kind: 'dislike', importance: 0.8 },
  { re: /我(?:喜欢|爱吃|爱喝|最近迷上|想学)([\u4e00-\u9fffA-Za-z0-9]{1,12})/, kind: 'like', importance: 0.7 },
  { re: /我(?:住在|搬到|在)([\u4e00-\u9fff]{2,10})(?:住|上班|工作)/, kind: 'fact', importance: 0.8 },
  { re: /我的?(?:生日|家里|工作)是?([\u4e00-\u9fff0-9]{2,16})/, kind: 'fact', importance: 0.75 },
];

/** 疑问词：出现在抽出来的尾巴里，说明这句话是在问，而不是在陈述。 */
function looksInterrogative(tail: string): boolean {
  return /什么|啥|哪|几|谁|多少|怎么|如何|\?|？/.test(tail);
}

/**
 * 从用户这句话里抽「值得单独记一条」的事实。
 *
 * 与原文镜像的区别：原文是流水账，这里是提炼过的一句，召回时同样的话命中一次
 * 就够，不必把整轮对话都翻出来。
 *
 * 只收陈述句：「我对什么过敏？」问的是知识，不是事实；把它当成事实记下来，
 * 下次真问过敏源时就会和自己的提问撞车（实测踩过）。
 * @param text - 用户当前这句话。
 * @returns 抽到的条目（可能为空）。
 */
export function extractFacts(text: string): FactDraft[] {
  const out: FactDraft[] = [];
  const seen = new Set<string>();
  for (const rule of FACT_PATTERNS) {
    const m = rule.re.exec(text);
    if (m === null) continue;
    const tail = (m[1] ?? '').trim();
    if (tail.length < 1 || looksInterrogative(tail)) continue;
    const content =
      rule.kind === 'name'
        ? `她叫${tail}`
        : rule.kind === 'like'
          ? `她喜欢${tail}`
          : rule.kind === 'dislike'
            ? `她不喜欢${tail}`
            : // 事实统一转第三人称：「我对花生过敏」→「她对花生过敏」。
              // 留着「我」会让模型把主语认成自己——实测猫会以为过敏的是它。
              m[0].trim().replace(/^我/, '她');
    if (looksInterrogative(content)) continue;
    if (seen.has(content)) continue;
    seen.add(content);
    out.push({ kind: rule.kind, content, importance: rule.importance });
  }
  return out;
}

/** 把毫秒时间戳写成 `YYYY-MM-DD`（提示词里给人看的那种）。 */
function dayOf(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 给老库补一列。`CREATE TABLE IF NOT EXISTS` 不会给已存在的表加列，
 * 所以向量列只能靠 `ALTER TABLE` 迁移；缺失是正常状态，失败也只是先没有向量。
 */
function ensureColumn(db: SqliteDb, table: string, column: string, decl: string): void {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
    if (cols.some((c) => String(c.name) === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  } catch {
    // 并发打开时可能已经被别人加过：忽略
  }
}

/**
 * 打开（或新建）记忆库。
 *
 * 打不开就返回一个「永远空」的实例：调用方不必判断可用性，缺了库只是少一层回忆，
 * 不该让对话本身失败。
 * @param input - 库文件路径与日志出口。
 * @returns 可用的记忆库（`enabled=false` 表示降级为空实现）。
 */
export function createMemoryStore(input: MemoryStoreInput): {
  readonly enabled: boolean;
  appendTurn(turn: AppendTurnInput): void;
  syncTurns(petId: string, messages: readonly Record<string, unknown>[]): void;
  recall(input: RecallInput): RecallHit[];
  /** 把这句话变成向量；没有 embedder 或服务挂了返回 null（调用方当作没有语义召回）。 */
  embedQuery(text: string): Promise<Float32Array | null>;
  /** 把还没有向量的旧行补上；返回本次补了几条。失败只记日志，返回 0。 */
  backfillVectors(limit?: number): Promise<number>;
  stats(): MemoryStats;
  close(): void;
} {
  const { file, log, embed } = input;
  let db: SqliteDb | null = null;
  try {
    // 运行时取而不是顶层 import：node:sqlite 在不同 Node 版本里可能缺席，
    // 顶层 import 会让整个插件在旧运行时上直接加载失败。
    const require = createRequire(import.meta.url) as (id: string) => unknown;
    const sqlite = require('node:sqlite') as { DatabaseSync: new (path: string) => SqliteDb };
    db = new sqlite.DatabaseSync(file);
    db.exec(SCHEMA);
    // 向量列是后加的：老库走 ALTER，新库也走一遍（便宜且幂等）
    ensureColumn(db, 'messages', 'vec', 'BLOB');
    ensureColumn(db, 'memories', 'vec', 'BLOB');
  } catch (e) {
    log.error(`[dsh-pet] 记忆库不可用（退回只带最近几轮）：${file}（${e instanceof Error ? e.message : String(e)}）`);
    db = null;
  }

  /** 空实现：库不可用时的所有入口。 */
  const disabled = {
    enabled: false,
    appendTurn: (): void => undefined,
    syncTurns: (): void => undefined,
    recall: (): RecallHit[] => [],
    embedQuery: async (): Promise<Float32Array | null> => null,
    backfillVectors: async (): Promise<number> => 0,
    stats: (): MemoryStats => ({ enabled: false, messages: 0, memories: 0 }),
    close: (): void => undefined,
  };
  if (db === null) return disabled;
  const handle = db;

  const insertMessage = (petId: string, role: string, content: string, ts: number, image?: string): void => {
    // OR IGNORE：同一个 (pet_id, ts, role) 只存在一次，重复镜像不报错
    handle
      .prepare('INSERT OR IGNORE INTO messages(pet_id, role, content, ts, image_name) VALUES (?, ?, ?, ?, ?)')
      .run(petId, role, content, ts, image ?? null);
  };

  /**
   * 把这一轮里抽到的事实写进事实层。
   *
   * 同一条事实只留一行：后说的覆盖 Importance 与时间，不新增重复行——
   * 否则「她不喜欢香菜」说十次就有十行，召回时会挤掉别的记忆。
   */
  const absorbFacts = (petId: string, text: string, ts: number): void => {
    const drafts = extractFacts(text);
    if (drafts.length === 0) return;
    const affect = affectOf(text);
    const find = handle.prepare('SELECT id FROM memories WHERE pet_id = ? AND content = ? LIMIT 1');
    const insert = handle.prepare(
      `INSERT INTO memories(pet_id, kind, content, importance, confidence, valence, arousal, dominance, emotion, source_ts, created_at)
       VALUES (?, ?, ?, ?, 0.9, ?, ?, ?, ?, ?, ?)`,
    );
    const touch = handle.prepare(
      'UPDATE memories SET importance = MAX(importance, ?), source_ts = ?, valence = COALESCE(?, valence), arousal = COALESCE(?, arousal), emotion = COALESCE(?, emotion) WHERE id = ?',
    );
    for (const draft of drafts) {
      const found = find.get(petId, draft.content) as { id?: unknown } | undefined;
      if (found?.id !== undefined) {
        touch.run(draft.importance, ts, affect?.valence ?? null, affect?.arousal ?? null, affect?.emotion ?? null, found.id);
        continue;
      }
      insert.run(
        petId,
        draft.kind,
        draft.content,
        draft.importance,
        affect?.valence ?? null,
        affect?.arousal ?? null,
        affect?.dominance ?? null,
        affect?.emotion ?? null,
        ts,
        Date.now(),
      );
    }
    log.info(`[dsh-pet] 事实层 +${drafts.length} pet=${petId}`);
  };

  /** 补向量的批大小：一次 32 条，Ollama 打包算比逐条快一个数量级。 */
  const VEC_BATCH = 32;
  /** 语义召回的相似度门槛：低于它的即使关键词全不中也不该进提示词。 */
  const VEC_MIN_SIM = Number(process.env.DSH_PET_VEC_MIN ?? '0.52');
  /** 语义分权重：让 cos≈0.85 的强相关和 3 字关键词命中大致同分。 */
  const VEC_WEIGHT = 3.2;

  /** 同一时刻只允许一轮补录：两轮并发会重复算同一批，还抢 Ollama 的队列。 */
  let backfilling: Promise<number> | null = null;

  /** 把一句话变成向量；没有 embedder、服务挂了、文本为空都返回 null。 */
  const embedQuery = async (text: string): Promise<Float32Array | null> => {
    if (embed === undefined) return null;
    const trimmed = text.trim().slice(0, 500);
    if (trimmed === '') return null;
    try {
      const [vec] = await embed.embed([trimmed]);
      return vec ?? null;
    } catch (e) {
      log.error(`[dsh-pet] 向量化失败（本轮只走关键词）：${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  /**
   * 给还没有向量的旧行补向量（原文层 + 事实层）。
   *
   * 为什么不在写入时同步算：一次 embed 要 20–60ms，而写库是在回复链路上；
   * 这里改成「先照常写、随后补」，用户感知不到，语义召回只会晚一点可用。
   */
  const backfillVectors = async (limit = 400): Promise<number> => {
    if (embed === undefined) return 0;
    if (backfilling !== null) return backfilling;
    backfilling = (async () => {
      let done = 0;
      try {
        for (const table of ['messages', 'memories'] as const) {
          for (;;) {
            const room = limit - done;
            if (room <= 0) return done;
            const rows = handle
              .prepare(`SELECT id, content FROM ${table} WHERE vec IS NULL AND length(content) >= 4 ORDER BY id DESC LIMIT ?`)
              .all(Math.min(VEC_BATCH, room)) as Array<{ id?: unknown; content?: unknown }>;
            if (rows.length === 0) break;
            const texts = rows.map((row) => String(row.content ?? '').slice(0, 500));
            const vecs = await embed.embed(texts);
            const update = handle.prepare(`UPDATE ${table} SET vec = ? WHERE id = ?`);
            for (let i = 0; i < rows.length; i++) {
              const vec = vecs[i];
              if (vec === undefined) continue;
              update.run(encodeVec(vec), rows[i]?.id ?? 0);
              done++;
            }
            if (rows.length < VEC_BATCH) break;
          }
        }
      } catch (e) {
        log.error(`[dsh-pet] 向量补录中断（已补 ${done} 条）：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        backfilling = null;
      }
      return done;
    })();
    return backfilling;
  };

  return {
    enabled: true,

    /** 镜像一轮对话。同步写：单条 insert 是微秒级，不值得为它排一条异步队列。 */
    appendTurn: (turn) => {
      try {
        insertMessage(turn.petId, 'user', turn.userText, turn.ts, turn.userImage);
        insertMessage(turn.petId, 'assistant', turn.assistantText, turn.ts);
        absorbFacts(turn.petId, turn.userText, turn.ts);
      } catch (e) {
        log.error(`[dsh-pet] 记忆库写入失败（不影响回复）pet=${turn.petId}：${e instanceof Error ? e.message : String(e)}`);
      }
    },

    /**
     * 把 `memory.json` 里已有的历史补进库。
     *
     * 只在每只宠物第一次对话时真的插入：唯一索引把重复项挡掉，所以这里不必自己判重。
     * 目的不是搬家——`memory.json` 仍是唯一真相，库只是可检索的镜像，删库能重建。
     */
    syncTurns: (petId, messages) => {
      try {
        for (const item of messages) {
          const role = String(item.role ?? '');
          const content = String(item.content ?? '');
          const ts = Number(item.ts);
          if (role === '' || content === '' || !Number.isFinite(ts)) continue;
          insertMessage(petId, role, content, ts, typeof item.image === 'string' ? item.image : undefined);
          if (role === 'user') absorbFacts(petId, content, ts);
        }
      } catch (e) {
        log.error(`[dsh-pet] 记忆库补录失败 pet=${petId}：${e instanceof Error ? e.message : String(e)}`);
      }
    },

    /**
     * 捞出和当前这句话相关的旧消息。
     *
     * 打分 = 命中关键词的长度和（长词更有指向性）× 时间衰减 + 用户亲口说的加成。
     * 召回结果按时间正序返回，拼进提示词时读起来像回忆而不是倒放。
     */
    recall: ({ petId, query, limit, before, queryVec }) => {
      const keywords = keywordsOf(query);
      if (keywords.length === 0 || limit <= 0) return [];
      const conditions = keywords.map(() => 'content LIKE ?').join(' OR ');
      const params: unknown[] = [petId, ...keywords.map((k) => `%${k}%`)];
      const cutoff = before !== undefined && Number.isFinite(before) ? before : Number.MAX_SAFE_INTEGER;
      const now = Date.now();
      const scored: RecallHit[] = [];
      const seenContent = new Set<string>();

      // 时间衰减：情绪越强、唤醒度越高，这条记忆褪色越慢（情绪权重）。
      const decayOf = (ts: number, affect: AffectHit | null): number => {
        const ageDays = Math.max(0, (now - ts) / 86_400_000);
        const strength = affect === null ? 0 : Math.abs(affect.valence) * affect.arousal;
        const halfLifeDays = 30 * (1 + 0.9 * strength);
        return 0.5 ** (ageDays / halfLifeDays);
      };

      // ① 事实层：密度最高，优先占位
      try {
        const rows = handle
          .prepare(
            `SELECT content, source_ts FROM memories
             WHERE pet_id = ? AND archived = 0 AND (${conditions}) ORDER BY importance DESC LIMIT 40`,
          )
          .all(...params);
        for (const raw of rows) {
          const row = raw as { content?: unknown; source_ts?: unknown };
          const content = String(row.content ?? '');
          if (content === '' || seenContent.has(content)) continue;
          let hit = 0;
          for (const k of keywords) if (content.includes(k)) hit += k.length;
          if (hit === 0) continue;
          const ts = Number(row.source_ts ?? now);
          seenContent.add(content);
          // 事实是「她亲口说过的一句结论」，比同分的原文更该进提示词
          scored.push({ ts, role: 'user', content, score: hit * 1.6 + 0.5, fact: true });
        }
      } catch (e) {
        log.error(`[dsh-pet] 事实层召回失败 pet=${petId}：${e instanceof Error ? e.message : String(e)}`);
      }

      // ② 原文层
      let rows: unknown[];
      try {
        rows = handle
          .prepare(
            `SELECT role, content, ts FROM messages WHERE pet_id = ? AND (${conditions}) AND ts < ? ORDER BY ts DESC LIMIT 400`,
          )
          .all(...params, cutoff);
      } catch (e) {
        log.error(`[dsh-pet] 记忆库召回失败 pet=${petId}：${e instanceof Error ? e.message : String(e)}`);
        rows = [];
      }
      for (const raw of rows) {
        const row = raw as { role?: unknown; content?: unknown; ts?: unknown };
        const content = String(row.content ?? '');
        const ts = Number(row.ts ?? 0);
        if (content === '' || !Number.isFinite(ts) || seenContent.has(content)) continue;
        let hit = 0;
        for (const k of keywords) if (content.includes(k)) hit += k.length;
        if (hit === 0) continue;
        const decay = decayOf(ts, affectOf(content));
        const roleBonus = String(row.role) === 'user' ? 0.3 : 0;
        scored.push({ ts, role: String(row.role), content, score: hit * (0.4 + decay) + roleBonus });
      }
      // ③ 语义层：换一种说法也能找回（「肚子疼得厉害」↔「胰脏不舒服」关键词一个都不重叠）
      // 与关键词是补充关系不是替代：同一句两边都命中就取更高的分，只占一个名额。
      if (queryVec !== undefined && queryVec !== null && embed !== undefined) {
        const at = new Map<string, number>();
        scored.forEach((hit, i) => at.set(hit.content, i));

        const take = (rows: unknown[], isFact: boolean): void => {
          for (const raw of rows) {
            const row = raw as { role?: unknown; content?: unknown; ts?: unknown; vec?: unknown };
            const content = String(row.content ?? '');
            if (content === '') continue;
            const vec = decodeVec(row.vec);
            if (vec === null) continue;
            const sim = cosine(queryVec, vec);
            if (sim < VEC_MIN_SIM) continue;
            const ts = Number(row.ts ?? now);
            // 事实层不衰减：它本来就是「她亲口说过的结论」，不该随时间淡掉
            const decay = isFact ? 1 : decayOf(ts, affectOf(content));
            const bonus = isFact ? 1.6 : String(row.role) === 'user' ? 0.3 : 0;
            const score = VEC_WEIGHT * sim * (0.4 + decay) + bonus;
            const prevAt = at.get(content);
            if (prevAt !== undefined) {
              const prev = scored[prevAt];
              if (prev !== undefined && prev.score < score) scored[prevAt] = { ...prev, score };
              continue;
            }
            at.set(content, scored.length);
            scored.push({
              ts,
              role: isFact ? 'user' : String(row.role),
              content,
              score,
              ...(isFact ? { fact: true } : {}),
            });
          }
        };

        try {
          take(
            handle
              .prepare(
                'SELECT role, content, ts, vec FROM messages WHERE pet_id = ? AND vec IS NOT NULL AND ts < ? ORDER BY ts DESC LIMIT 1500',
              )
              .all(petId, cutoff),
            false,
          );
          take(
            handle
              .prepare('SELECT content, source_ts AS ts, vec FROM memories WHERE pet_id = ? AND archived = 0 AND vec IS NOT NULL LIMIT 500')
              .all(petId),
            true,
          );
        } catch (e) {
          log.error(`[dsh-pet] 语义召回失败 pet=${petId}：${e instanceof Error ? e.message : String(e)}`);
        }
      }

      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, Math.max(1, limit));
      // 事实按相关度排（最贴题的在最前，模型读第一条就够了），原文按时间正序（读起来像回忆）。
      // 早先这里统一按 ts 重排过，结果最相关的事实被排到中间，模型抓不到重点。
      const facts = top.filter((hit) => hit.fact === true);
      const past = top.filter((hit) => hit.fact !== true).sort((a, b) => a.ts - b.ts);
      return [...facts, ...past];
    },

    embedQuery,
    backfillVectors,

    stats: () => {
      try {
        const m = handle.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n?: unknown } | undefined;
        const f = handle.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n?: unknown } | undefined;
        return { enabled: true, messages: Number(m?.n ?? 0), memories: Number(f?.n ?? 0) };
      } catch {
        return { enabled: true, messages: 0, memories: 0 };
      }
    },

    close: () => {
      try {
        handle.close();
      } catch {
        // 关不掉不影响退出
      }
    },
  };
}

/**
 * 把召回结果拼成提示词里的一段话。
 *
 * 只给「日期 + 她说过什么」，不给分数、不给 id：模型要的是内容，不是调试信息。
 * 单条截到 80 字，整段最多 6 条——上限写死在这里，避免某次召回把上下文顶爆。
 * @param hits - `recall` 的返回值。
 * @returns 可直接追加到 system 后面的文本；没有命中时返回空串。
 */
export function formatRecall(hits: readonly RecallHit[]): string {
  if (hits.length === 0) return '';
  const facts = hits
    .filter((hit) => hit.fact === true)
    .slice(0, 4)
    .map((hit) => `- ${hit.content.replace(/\s+/g, ' ').trim().slice(0, 80)}`);
  const past = hits
    .filter((hit) => hit.fact !== true)
    .slice(0, 6 - Math.min(facts.length, 4))
    .map((hit) => {
      const body = hit.content.replace(/\s+/g, ' ').trim();
      const short = body.length > 80 ? body.slice(0, 80) + '…' : body;
      const who = hit.role === 'user' ? '她' : '你';
      return `- ${dayOf(hit.ts)} ${who}：${short}`;
    });
  const out: string[] = [];
  if (facts.length > 0) {
    out.push(
      '',
      '【关于她，你确定知道的事】以下几件事是她亲口说过的。只要话题相关，一律以这里为准：直接照着回答，不要反问，不要改口，也不要说「记混了」。',
      ...facts,
    );
  }
  if (past.length > 0) {
    out.push('', '【你想起的旧事】（更早的对话，按时间排序，只在贴题时提一句）', ...past);
  }
  return out.join('\n');
}
