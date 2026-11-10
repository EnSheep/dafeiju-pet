/**
 * 对话生成（host 半侧）：用 DSH 的 LLM 统一抽象层（ctx.llm）生成一句回复。
 *
 * 负责把历史记忆、用户输入与人设拼成一次生成请求，并解析可选的配图标记。
 * 不负责记忆读写与落盘，也不负责写气泡——那些在路由层与两端消费侧。
 * 依赖 ctx.llm、agentDefaultModel（与碎碎念同源）与调用方给的表情包池。
 * 始终成立：候选模型失败要显式回落并留痕；生成失败返回结构化原因，不伪造文案。
 * 契约见 API.md 与 openapi.yaml。
 *
 * @module dsh-pet/src/host/chat
 */

import { BlockAssembler, createAssistantMessage, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { actionInstruction, extractChatAction } from './chat-action.ts';
import type { PetImageRef } from './image-attachment.ts';
import { PET_CALL_IDENTITY, noTextReason } from './llm-call.ts';
import { supportsReasoningOff } from './llm-reasoning.ts';
import { defaultLog } from './log-file.ts';
import { extractChatImage, memeCatalog, type MemeEntry } from './memes.ts';
import { modelCandidates, modelLabel, type ModelRef } from './model-selection.ts';
import { historyStampOf } from './time-context.ts';

/** 生成失败原因（与 shared/whisper.ts 的 WhisperState 失败分支同构）。 */
export type ChatGenerateResult =
  | { ok: true; text: string; image?: string; action?: string }
  | { ok: false; reason: 'provider-missing' | 'generate-error'; message?: string };

/** 记忆中的一条消息：GET /chat 返回的窗口条目就是它。 */
export interface ChatMemoryMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
  /** 该轮用户上传的图片（附件引用，不含图片本体）；只存不送——历史回放不带图。 */
  image?: PetImageRef;
  /** 该轮 AI 配的表情包名称（不是条目对象）；回放历史时以 `[图:名称]` 回填给模型（不带图本体）。 */
  meme?: string;
  /** 该轮 AI 表演的动作名（animations.categories 内的名字）；回放历史时以 `[动作:名称]` 回填。 */
  action?: string;
}

/** 单次生成超时（ms）：对话等 LLM 回复，60s 足够。 */
const TIMEOUT_MS = 60_000;

/** 历史消息打时间前缀的阈值（ms）：30 分钟内的连续对话不加，避免每句都多几个 token。 */
const HISTORY_STAMP_GAP_MS = 30 * 60 * 1000;

/**
 * user 历史消息的正文：距现在超过阈值时，前面加 `[10月31日 22:53]`。
 *
 * 只给 user 打：同一轮 user / assistant 共享同一个 ts，标一条就够；标在 assistant 上时，
 * 模型会把这行当成自己的说话格式照抄（实际出现过回复以 `[11:54]` 开头）。
 * 阈值内的连续对话不加前缀——否则一段正常闲聊会变成每句一个时间戳。
 *
 * @param message - 历史消息（带 ts）。
 * @param nowMs - 本次生成时刻（毫秒），整批历史共用一个，避免逐条取时钟导致同批时间不一致。
 * @returns 需要前缀时返回 `[时:分] 原文`，否则原样返回 `content`。
 */
function userHistoryTextOf(message: ChatMemoryMessage, nowMs: number): string {
  if (!Number.isFinite(message.ts)) return message.content;
  // 用 > 而不是 >=：恰好 30 分钟仍算连续对话；ts 在未来（时钟回拨）时差为负，自然不加
  if (!(nowMs - message.ts > HISTORY_STAMP_GAP_MS)) return message.content;
  const stamp = historyStampOf(message.ts, new Date(nowMs));
  if (stamp === '') return message.content;
  const age = ageTextOf(message.ts, nowMs);
  return '[' + stamp + (age === '' ? '' : '，' + age) + '] ' + message.content;
}

/**
 * 距今跨度的口语标注（“2天前” / “7小时前”）。
 *
 * 只写日期不写跨度时，小模型算不明白 11月7日 和 今天 差了多少：它会把两句一模一样的话
 * 当成“同一件事又发生了一次”，然后照抄上次的答案（实测把三天前的唱歌请求当成“刚才”）。
 * 数字跨度是它不用算就能读懂的信号。少于 6 小时不标——那是正常连续聊天，标了只会变噪音。
 */
export function ageTextOf(ts: number, nowMs: number): string {
  const diff = nowMs - ts;
  if (!Number.isFinite(diff) || diff <= 0) return '';
  const days = Math.round(diff / 86_400_000);
  if (days >= 1) return days + '天前';
  const hours = Math.round(diff / 3_600_000);
  return hours >= 6 ? hours + '小时前' : '';
}

/** 历史里 assistant 正文的相对时间词（只改旧的，见 defuseRelativeTime）。 */
const RELATIVE_WORDS = /(刚才|刚刚才|刚刚|方才)/gu;

/**
 * 把**旧**回复里的相对时间词改成“那时”，避免它把自己的旧话当成现在。
 *
 * 「刚才那首邓紫棋还没唱顺呢」这句一旦进了历史，模型下一轮读到的是“刚才”，
 * 于是继续按“刚刚发生过”往下接，还把这句话越抄越远（实测 3 轮之后仍在说“刚才”）。
 * 两个小时后“刚才”就必然不成立，把它改写成“那时”是唯一的确定性做法；
 * 两小时内的保持原样——那是真的刚才，改了反而错。
 */
function defuseRelativeTime(text: string, ts: number, nowMs: number): string {
  const age = nowMs - ts;
  if (!Number.isFinite(age) || age <= 2 * 3_600_000) return text;
  let out = text.replace(RELATIVE_WORDS, '那时');
  // 跨日再说“今天”就是在撒谎；同一天里说“今天”没问题
  if (new Date(ts).toDateString() !== new Date(nowMs).toDateString()) out = out.replace(/今天/gu, '那天');
  return out;
}

/** 复读判定阈值：与历史里自己某句话的大二元组重合度超过它，就认为在照抄。 */
const REPEAT_LIMIT = 0.42;

/** 复读时追加在 user 正文后的重说指令（只在重试那一次出现）。 */
const REPEAT_REMINDER =
  '\n\n[提醒] 你上一次的回复和你说过的某句话几乎一模一样。这很假。' +
  '换一个完全不同的说法重写这句回复：不要复用以前的句子、开头、比喻和口头禅，' +
  '也不要再提你已经提过的事，只回应我这句话本身。';

/** 去掉空白与标点：中文复读往往只改标点、原封不动搬句子，比相似度前先抹平这层皮。 */
function repeatBody(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '');
}

/**
 * 两句文本的复读程度（0..1）：大二元组 Jaccard 相似度与公共开头长度的合成。
 *
 * 开头权重单独算：小模型照抄时常常「前 12 个字一字不改、后面换几个词」，
 * 这种只改尾巴的复制在 Jaccard 上可能并不过线，人一眼却看得出是同一句。
 */
export function repeatScore(a: string, b: string): number {
  const x = repeatBody(a);
  const y = repeatBody(b);
  if (x === '' || y === '') return 0;
  const grams = (s: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2));
    return out;
  };
  const gx = grams(x);
  const gy = grams(y);
  let hit = 0;
  for (const g of gx) if (gy.has(g)) hit += 1;
  const jaccard = hit / (gx.size + gy.size - hit);
  let prefix = 0;
  while (prefix < x.length && prefix < y.length && x[prefix] === y[prefix]) prefix += 1;
  // 中文一句话的开头 6 个字全同已经不是巧合，而是同一个模板（“练志你这一声…”）。
  // 只改尾巴不改开口的复制会被中间那句新内容把 Jaccard 稀释掉，所以开口单独计分、给得狠。
  const prefixScore = prefix >= 6 ? 0.5 + Math.min(0.5, (prefix - 6) / 12) : prefix / 14;
  return Math.max(jaccard, prefixScore);
}

/** 这句话与历史里自己说过的哪句最像（只看 assistant，没有历史时返回 0）。 */
function worstRepeat(text: string, history: readonly ChatMemoryMessage[]): number {
  let worst = 0;
  for (const m of history) {
    if (m.role !== 'assistant') continue;
    const score = repeatScore(text, m.content);
    if (score > worst) worst = score;
  }
  return worst;
}

/**
 * 历史里回填的配图 / 动作标记（`[动作:名称]` 与 `[图:名称]`，各占一行，顺序固定）。
 *
 * 记忆里只存名字、正文里的标记在落盘前已被剥掉；不回填的话模型看不到自己前几轮配过哪张图、
 * 演过什么动作，用户说“换一个”时它连换的是什么都不知道，只会重复挑同一张或答非所问。
 * 只回填 assistant：user 的附件引用依旧不带（旧图不重发给模型）。
 * 名称可能为空串（手改过记忆文件）——空值不回填，纯文本历史逐字不变。
 *
 * @param message - 历史消息。
 * @returns 需要回填时返回 `\n[动作:…]\n[图:…]`，否则空串。
 */
function historyMarkersOf(message: ChatMemoryMessage): string {
  if (message.role !== 'assistant') return '';
  const lines: string[] = [];
  if (typeof message.action === 'string' && message.action !== '') lines.push('[动作:' + message.action + ']');
  if (typeof message.meme === 'string' && message.meme !== '') lines.push('[图:' + message.meme + ']');
  return lines.length === 0 ? '' : '\n' + lines.join('\n');
}

/** 配图指令：附在 user 正文之后（紧邻回答位置，模型更容易遵守）。
 *  交给模型选而不是随机抽：对话有真实上下文（用户输入 + 历史），按语境挑才贴合。 */
function imageInstruction(pool: MemeEntry[]): string {
  return (
    '\n\n[配图] 回复结尾可选附一张表情包给用户看，从下列清单里挑最贴合当前语境的：\n' +
    memeCatalog(pool) +
    '\n挑中就在回复最后另起一行写 [图:名称]（名称原样照抄）；没有合适的就完全不要写这个标记。'
  );
}

/** 动作指令与动作标记的解析都在 ./chat-action：它们只服务对话这条路径，与 /anim 的决策层分开。 */

/** 一次对话生成的输入。 */
export interface ChatGenerateInput {
  /** 宿主上下文（注入 agentDefaultModel / llm）。 */
  readonly ctx: { agentDefaultModel: { currentSelection(): { provider: string; model: string } }; llm?: unknown };
  /** 人设提示词（whisperPrompt，与碎碎念共用同一人设）。 */
  readonly system: string;
  /** 最近记忆（按时间正序，user / assistant 交替）。 */
  readonly history: readonly ChatMemoryMessage[];
  /** 用户刚输入的话；图片不带任何文字描述，语境全靠它。 */
  readonly userText: string;
  /** 表情包候选池；空 / 缺省 = 纯文本（指令与解析都不介入）。 */
  readonly pool?: readonly MemeEntry[];
  /** 可表演的动作名单（对话联动开关开启时传，来自 animations.categories）；空 / 缺省 = 不注入也不解析。 */
  readonly actions?: readonly string[];
  /** 条目单独指定的模型（chatModel）；缺省 / 留空 = 只用当前对话的模型。 */
  readonly preferred?: ModelRef;
  /** 本轮附带的图片；缺省 = 纯文本请求，数据路径与加入图片前一致。 */
  readonly image?: PetImageRef;
}

/**
 * 生成一句对话回复。
 *
 * @param input - 上下文、人设、历史、用户输入，以及可选的配图池 / 指定模型 / 图片。
 * @returns 回复文本（+ 命中池内的配图名），或结构化失败（provider 缺失 / 生成错误）。
 */
export async function generateChat(input: ChatGenerateInput): Promise<ChatGenerateResult> {
  const { ctx, system, history, userText, preferred, image } = input;
  // 表情包侧的读池 / 校验函数按可变数组签名；这里复制一份，避免把调用方数组的引用往下传
  const pool: MemeEntry[] = [...(input.pool ?? [])];
  // 动作名单同样是「空 = 关闭」：开关关掉或 categories 没配任何动作时，指令与解析都不介入。
  const actions: string[] = [...(input.actions ?? [])];
  // 候选链：配置的模型优先 → 当前对话的模型兜底（chatModel 留空时链上只有后者）
  const candidates = modelCandidates(ctx, preferred);
  if (candidates.length === 0) {
    return { ok: false, reason: 'provider-missing', message: '当前对话未配置模型' };
  }
  const llm = (ctx as { llm?: { stream(o: unknown): AsyncIterable<unknown> } }).llm;
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, reason: 'generate-error', message: 'LLM 服务不可用' };
  }
  // 依次尝试：配置的模型失败（凭据被删 / 模型下架 / 该服务商没配 key）时回落到当前对话的模型
  // 重试一次——那才是用户当前真正在用的模型，报错更有意义。
  // 兜底文案与失败分支同源，避免两处字面量漂移
  let last: ChatGenerateResult = { ok: false, reason: 'generate-error', message: noTextReason(undefined) };
  for (const [i, sel] of candidates.entries()) {
    const result = await generateWith(ctx, { llm, sel, system, history, userText, pool, actions, image });
    if (result.ok) return result;
    last = result;
    // 回落要留痕：配的模型没生效时能在日志里看到原因（否则「我明明配了 A，怎么还是用 B」没法查）
    if (i + 1 < candidates.length) {
      defaultLog(
        'warn',
        `dsh-pet: 对话用 ${modelLabel(sel)} 生成失败（${result.message ?? result.reason}），回落到 ${modelLabel(candidates[i + 1])}`,
      );
    }
  }
  return last;
}

/** 单个候选模型的一次生成请求（候选链的一环）。 */
interface GenerateOnce {
  readonly ctx: { llm?: unknown };
  readonly llm: { stream(o: unknown): AsyncIterable<unknown> };
  readonly sel: ModelRef;
  readonly system: string;
  readonly history: readonly ChatMemoryMessage[];
  readonly userText: string;
  readonly pool: MemeEntry[];
  readonly actions: string[];
  readonly image?: PetImageRef;
  /** 复读重试时追加在 user 正文后的提醒；首轮不传。 */
  readonly reminder?: string;
}

/**
 * 生成一次对话回复：先正常生成，判到「在照抄自己以前的答案」时带着提醒重说一遍。
 *
 * 复读不是模型抽风，是上下文决定的：同一句话在历史里出现过、后面还跟着自己当时的回答，
 * 模型最省力的续写就是把那次回答再抄一遍（小模型尤其明显）。所以不能只靠调温度——
 * 让它看见历史就等于给了它答案。这里在生成后比对一次，像就重说，两次都像就取更像人话的那条
 * （重试失败时仍返回首轮结果，不能因为纠偏把正常对话弄失败）。
 */
async function generateWith(ctx: { llm?: unknown }, once: Omit<GenerateOnce, 'ctx'>): Promise<ChatGenerateResult> {
  const first = await attemptOnce({ ctx, ...once });
  if (!first.ok) return first;
  const score = worstRepeat(first.text, once.history);
  if (score < REPEAT_LIMIT) return first;
  defaultLog('info', `dsh-pet: 回复疑似复读（相似度 ${score.toFixed(2)}），换一种说法重试`);
  const retry = await attemptOnce({ ctx, ...once, reminder: REPEAT_REMINDER });
  if (!retry.ok) return first;
  return worstRepeat(retry.text, once.history) <= score ? retry : first;
}

/** 用一个确定的 provider/model 跑一次对话生成（失败原样返回结构化原因，不吞）。 */
async function attemptOnce(once: GenerateOnce): Promise<ChatGenerateResult> {
  const { ctx, llm, sel, system, history, userText, pool, actions, image, reminder } = once;
  // 历史 → dsh-llm 消息：user 经 createUserMessage（plugin 来源），assistant 经 createAssistantMessage
  // （provider/model 只是消息的角色载体，不涉及适配器回放）。
  // 时间前缀只加在 user 上（模型会照抄 assistant 自己那侧的格式）；配图/动作标记只加在 assistant 上。
  const nowMs = Date.now();
  const historyMessages = history.map((m) =>
    m.role === 'user'
      ? createUserMessage({
          content: [{ type: 'text', text: userHistoryTextOf(m, nowMs) }],
          source: { kind: 'user' },
        })
      : createAssistantMessage({
          content: [{ type: 'text', text: defuseRelativeTime(m.content, m.ts, nowMs) + historyMarkersOf(m) }],
          source: { provider: sel.provider, model: sel.model },
        }),
  );

  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  // 仅当模型声明支持 reasoning effort（含 "off"）时才传，否则省略：
  // 无 reasoning 元数据的模型显式传 off 会被 dsh-llm 判为 UNSUPPORTED_REASONING_EFFORT，
  // 折叠成空流（表现为「模型未返回文本」）。
  const supportsOff = await supportsReasoningOff(ctx, sel.provider, sel.model);
  // 配图 / 动作：各自的清单非空才把指令附进 user 正文（空 = 该功能关闭）。
  // 顺序固定「配图在前、动作在后」：配图是既有行为，新增的动作排在它后面，不改既有提示词的位置。
  const wantImage = pool.length > 0;
  const wantAction = actions.length > 0;
  const instruction = (wantImage ? imageInstruction(pool) : '') + (wantAction ? actionInstruction(actions) : '');
  const extra = instruction + (reminder ?? '');
  const content: Record<string, unknown>[] = [
    { type: 'text', text: extra === '' ? userText : userText + extra },
  ];
  // 图片块排在文本块之后：提示词先到、像素后到，模型更容易按提示去看图。
  if (image !== undefined) content.push({ type: 'image', attachment: image });
  const options = {
    provider: sel.provider,
    model: sel.model,
    // 调用身份（见 llm-call.ts）：缺它时 opencode-go 回 400
    sessionId: PET_CALL_IDENTITY,
    messages: [
      ...historyMessages,
      createUserMessage({
        // PetImageRef 与 dsh-llm 的 ImageAttachmentRef 字段一致，差异只有品牌化类型（attachmentId 是 branded string）；
        // 插件侧不引 @deepseek-ai/dsh-attachment 的类型包，这里显式断言一次。
        content: content as unknown as Parameters<typeof createUserMessage>[0]['content'],
        source: { kind: 'user' },
      }),
    ],
    system,
    // 不显式限 maxTokens：与碎碎念同因——推理模型把思考计入预算，显式小上限会截断正文；
    // 不传由 dsh-llm 按适配器 defaultMaxTokens 兜底，对话短回复输出仍短。
    temperature: 1,
    // 统一关闭深度思考：闲聊对话不需要推理（与碎碎念同一约束；仅模型声明支持时传）
    ...(supportsOff ? { reasoningEffort: ReasoningEffortId('off') } : {}),
    signal: deadline,
  };

  const assembler = new BlockAssembler();
  try {
    for await (const chunk of llm.stream(options)) {
      assembler.push(chunk as Parameters<BlockAssembler['push']>[0]);
    }
  } catch (e) {
    return {
      ok: false,
      reason: 'generate-error',
      message: e instanceof Error ? e.message : String(e),
    };
  }
  const text = assembler
    .blocks()
    .filter((b) => b.type === 'text')
    .map((b) => ('text' in b ? (b as { text: string }).text : ''))
    .join('')
    .trim();
  if (!text) return { ok: false, reason: 'generate-error', message: noTextReason(assembler.finish) };
  if (!wantImage && !wantAction) return { ok: true, text };
  // 先剥动作再剥配图：两种标记互不依赖，顺序不影响结果；动作的无效名称也会被剥（见 extractChatAction）。
  const acted: { text: string; action?: string } = wantAction ? extractChatAction(text, actions) : { text };
  const picked: { text: string; image?: string } = wantImage
    ? extractChatImage(acted.text, pool)
    : { text: acted.text };
  return {
    ok: true,
    text: picked.text,
    ...(picked.image ? { image: picked.image } : {}),
    ...(acted.action ? { action: acted.action } : {}),
  };
}
