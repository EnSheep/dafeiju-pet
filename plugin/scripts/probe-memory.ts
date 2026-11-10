/**
 * 记忆库验收脚本（不参与构建、不影响 npm test）。
 * 用 `node --experimental-strip-types scripts/probe-memory.ts` 直接跑源码，
 * 覆盖：抽事实的边界（问句不能当事实）、情绪词表、关键词、跨天召回、事实置顶、提示词拼装、删库重建。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { affectOf, createMemoryStore, extractFacts, formatRecall, keywordsOf } from '../src/host/memory/store.ts';

const log = { info: (m: string) => console.log('  [log]', m), error: (m: string) => console.log('  [err]', m) };
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}`, extra ?? '');
  }
}

// —— 1. 抽取：问句不能当事实 ——
check('问句「我对什么过敏？」不抽事实', extractFacts('我对什么过敏？').length === 0, extractFacts('我对什么过敏？'));
check('问句「我叫什么名字吗？」不抽事实', extractFacts('我叫什么名字吗？').length === 0, extractFacts('我叫什么名字吗？'));
const allergy = extractFacts('我对花生过敏，你别给我点带花生的东西。');
check('陈述句抽到过敏事实', allergy.length === 1 && allergy[0]?.content === '她对花生过敏', allergy);
check('事实存成第三人称（不能留「我」）', allergy[0]?.content.startsWith('她') === true, allergy);
const dislike = extractFacts('我不吃香菜了');
check('陈述句抽到不喜欢', dislike.some((d) => d.content === '她不喜欢香菜了'), dislike);
const named = extractFacts('我叫练志');
check('自报姓名抽成她叫X', named.some((d) => d.content === '她叫练志'), named);

// —— 2. 情绪权重 ——
check('「难受」识别为负向高唤醒', (() => {
  const a = affectOf('我今天特别难受，疼得睡不着');
  return a !== null && a.valence < -0.5 && a.arousal > 0.5;
})());
check('中性句不带情绪', affectOf('今天星期三') === null);

// —— 3. 关键词 ——
check('关键词含「花生」', keywordsOf('我能吃花生吗？').includes('花生'), keywordsOf('我能吃花生吗？'));

// —— 4. 落库 + 召回归位 ——
const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-'));
const file = join(dir, 'memory.db');
const store = createMemoryStore({ file, log });
check('记忆库可用', store.enabled);

const t0 = Date.now() - 12 * 86_400_000; // 12 天前
store.appendTurn({ petId: 'main', ts: t0, userText: '我对花生过敏，你别给我点带花生的东西。', assistantText: '记住啦，不碰花生。' });
// 再塞 6 轮无关对话，把它挤出「最近 5 轮」窗口
for (let i = 0; i < 6; i++) {
  store.appendTurn({ petId: 'main', ts: t0 + (i + 1) * 60_000, userText: `闲聊第 ${i} 句，今天天气不错。`, assistantText: `嗯嗯，第 ${i} 句收到。` });
}
const hits = store.recall({ petId: 'main', query: '我能吃花生吗？', limit: 6 });
check('12 天前的事实被召回', hits.some((h) => h.fact === true && h.content.includes('花生')), hits.map((h) => [h.fact, h.content]));
check('事实排在最前（按相关度，不按时间）', hits[0]?.fact === true && hits[0]?.content.includes('花生'), hits.map((h) => [h.fact, h.content]));
const text = formatRecall(hits);
check('提示词含事实段标题', text.includes('【关于她，你确定知道的事】'), text);
check('提示词含花生事实', text.includes('她对花生过敏'), text);
check('提示词里没有第一人称主语的事实', !text.includes('- 我对花生过敏'), text);
check('提示词里有「以这里为准」的强约束', text.includes('以这里为准'), text);

// —— 5. 删库可重建（memory.json 仍是真相） ——
const legacy = [
  { role: 'user', content: '我叫练志，以后请记住我', ts: t0 },
  { role: 'assistant', content: '好呀，练志。', ts: t0 + 1 },
];
store.syncTurns('main', legacy);
const after = store.stats();
check('syncTurns 把旧历史补进库', after.messages >= legacy.length, after);
check('syncTurns 顺带补出事实', after.memories >= 1, after);

store.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
