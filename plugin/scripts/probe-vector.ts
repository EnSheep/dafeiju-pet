/**
 * 语义召回的回归探针：同一个意思换个说法，也能把旧话捞回来。
 *
 * 跑法（插件根目录下）：
 *   node --experimental-strip-types scripts/probe-vector.ts
 *
 * 前提：本机 Ollama 在跑，且已经 `ollama pull bge-m3`。
 * 断开依赖的办法：`DSH_PET_EMBED_URL=http://127.0.0.1:1 node ...` 应当退回纯关键词。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOllamaEmbedder, cosine } from '../src/host/memory/embed.ts';
import { createMemoryStore, keywordsOf } from '../src/host/memory/store.ts';

const log = { info: (m: string) => console.log('  [log]', m), warn: (m: string) => console.log('  [warn]', m) };

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass += 1;
    console.log('PASS', name);
  } else {
    fail += 1;
    console.log('FAIL', name, detail ? `— ${detail}` : '');
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-vec-'));
const file = join(dir, 'memory.db');
const embedder = createOllamaEmbedder({});
const now = Math.floor(Date.now() / 1000);
const day = 86_400;

const store = createMemoryStore({ file, log, embed: embedder });

// 三条「很久以前说过、用词完全不同」的原文
const seeds: Array<[number, string, string]> = [
  [10, '我最近在赶一个海洋塑料污染的汇报材料，头都大了', '辛苦啦，别熬太晚喵'],
  [8, '周末去看了个展，是关于老式打字机的', '打字机！咔哒咔哒的那种吗'],
  [6, '楼下那家面馆换老板了，味道不如以前', '那以后还去吃吗'],
];
for (const [daysAgo, userText, reply] of seeds) {
  store.appendTurn({ petId: 'main', ts: now - daysAgo * day, userText, assistantText: reply });
}

const backfilled = await store.backfillVectors(50);
check('向量回填成功', backfilled > 0, `backfilled=${backfilled}`);

const cases: Array<[string, string]> = [
  ['那个环保的活儿弄得怎么样了', '海洋塑料污染的汇报材料'],
  ['你记得我去看的那个展吗', '老式打字机'],
  ['吃面的地方是不是换了个人经营', '面馆换老板'],
];

for (const [query, expect] of cases) {
  const queryVec = await store.embedQuery(query);
  check(`能算出查询向量：${query}`, queryVec !== null && queryVec.length === 1024);

  const withVec = store.recall({ petId: 'main', query, limit: 6, queryVec });
  const hitWith = withVec.some((h) => h.content.includes(expect));

  // 同一句、不传向量 = 只看关键词，作为对照
  const noVec = store.recall({ petId: 'main', query, limit: 6, queryVec: null });
  const hitWithout = noVec.some((h) => h.content.includes(expect));

  check(`语义召回捞到「${expect}」`, hitWith, `hits=${withVec.map((h) => `${h.score.toFixed(2)}:${h.content.slice(0, 12)}`).join(' | ')}`);

  // 只有「这句查询里没有一个关键词出现在原文里」时，对照组才应该捞不到
  const kws = keywordsOf(query);
  const overlap = seeds.filter(([, text]) => text.includes(expect)).some(([, text]) => kws.some((k) => text.includes(k)));
  if (overlap) {
    console.log(`SKIP 对照组（这句本来就有字面关键词「${kws.filter((k) => seeds.some(([, t]) => t.includes(k))).join('/')}」，关键词路命中属正常）`);
  } else {
    check(`对照组（纯关键词）捞不到「${expect}」`, !hitWithout, `对照组=${noVec.map((h) => h.content.slice(0, 12)).join(' | ')}`);
  }

  const top = withVec[0];
  if (top) console.log(`     top=${top.score.toFixed(3)} ${top.content.slice(0, 30)}`);
}

// 相似度本身是否高于阈值（0.52），给调参一个依据
const [q, target] = ['那个环保的活儿弄得怎么样了', '我最近在赶一个海洋塑料污染的汇报材料，头都大了'];
const vecs = await embedder.embed([q, target]);
const sim = cosine(vecs[0]!, vecs[1]!);
console.log(`     换个说法的余弦相似度 = ${sim.toFixed(3)}（阈值 0.52）`);
check('换说法的相似度高于阈值', sim > 0.52, `sim=${sim.toFixed(3)}`);

store.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
