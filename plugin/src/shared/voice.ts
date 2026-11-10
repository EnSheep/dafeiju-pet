/**
 * 端侧语音播报：按 `say` 叶子决定这一句要不要念，以及合成请求与播放。
 *
 * 两端各判各的：叶子里的 `voiceTo` 指向哪一端，就只有那一端出声；缺省 = 谁都不念。
 * 网页端另加一道「页面可见」——被切到后台的页面没人看，出声只是打扰。
 * 音色、总开关与音量经 `setVoiceConfig` 从成品配置注入；手动点播（对话面板的喇叭）不受这些门控。
 * 每句的开始与结束经 {@link subscribeVoiceUtterance} 广播出去：说话气泡靠它决定何时收起。
 * 不负责合成与缓存：那些在宿主侧（`/voice/speak`）。
 * @module dsh-pet/src/shared/voice
 */
import { ROUTE_PATH } from './constants.ts';
import type { VoiceTarget } from './state.ts';

/** 当前音色；空串 = 不指定，由宿主用默认音色。 */
let voiceName = '';
/** 播报总开关；只有成品配置明确为 true 才播。 */
let voiceEnabled = false;
/** 播放音量系数（0–1，1 = 最大音量）；两端共用，只作用于播放，不影响已合成好的音频。 */
let voiceVolume = 1;
/** 本端是网页端还是桌面端；`null` = 还没声明，此时不按叶子播放。 */
let surface: VoiceTarget | null = null;
/** 接口基址：网页端是同源前缀，桌面端由 `setVoiceBase` 换成 bridge 地址。 */
let voiceBase = ROUTE_PATH;
/** 配置是否已就绪；网页端由 `setVoiceConfig` 置位，桌面端首次播放时懒加载。 */
let configLoaded = false;
/** 当前播报状态；气泡据此显示图标。 */
let voiceState: VoiceState = 'idle';
/** 状态订阅者：两端的说话气泡据此渲染图标。 */
const stateListeners = new Set<(state: VoiceState) => void>();
/** 播报开始/结束的订阅者：说话气泡据此挂起与收尾。 */
const utteranceListeners = new Set<(event: VoiceUtteranceEvent) => void>();
/** 播报序号；每次决定要念一句就自增，用来让气泡丢掉迟到的「上一句播完了」。 */
let utteranceSeq = 0;

/** 语音播报对外的四种状态；只用于展示，不接受外部驱动。`failed` = 这次合成没成功。 */
export type VoiceState = 'idle' | 'loading' | 'ready' | 'failed';

/**
 * 一句播报的开始与结束事件。
 *
 * `text` 是气泡上的原文，不是送合成的截断文本——气泡要按它认句：同一页面上的多只宠物
 * 共用这份模块单例状态，不认句就会把别人那一句算到自己头上。
 */
export type VoiceUtteranceEvent =
  | { readonly kind: 'start'; readonly seq: number; readonly text: string }
  | { readonly kind: 'end'; readonly seq: number; readonly text: string };

/**
 * 自动播报最多念多少字。
 *
 * 气泡照旧显示全文，只有念的部分截断：一句 500 字能合成几分钟，那段时间气泡无事可做，
 * 用户还会被拖着听半分钟。60 字约 15 秒语音，与气泡的挂起上限配套。
 */
export const VOICE_SPEECH_MAX_CHARS = 60;

/**
 * 自动播报一次最多念多少字（整段上限）。
 *
 * 切片之后可以全部念完，但也不能无限念：本机克隆音色 RTF≈1.7，120 字约 35 秒音频、
 * 要算一分多钟，再多就只是在拖着聊天不放了。
 */
export const VOICE_SPEECH_TOTAL_MAX = 120;

/**
 * 客户端等合成结果的上限（ms）。
 *
 * 克隆音色的合成是「一句一句算」的：本机 0.6B 模型 RTF≈1.7，30 个字要 20 秒以上，
 * 30s 的老口径会把长句直接掐断，所以放到 180s，比宿主侧 `PROVIDER_TIMEOUT_MS`（120s）再宽一档。
 * 客户端这道只是兜底，避免上游挂住时气泡上的转圈永远停不下来。
 */
const SPEAK_TIMEOUT_MS = 180_000;

/** 合成请求的超时信号；自动播报与手动点播共用同一份口径。 */
function speakSignal(): AbortSignal {
  return AbortSignal.timeout(SPEAK_TIMEOUT_MS);
}

/** 切换状态并通知订阅者；同值不重复通知。 */
function setVoiceState(next: VoiceState): void {
  if (voiceState === next) return;
  voiceState = next;
  for (const listener of stateListeners) listener(next);
}

/**
 * 读当前播报状态；桌面端在重绘气泡时直接取（它没有 react 的订阅机制）。
 * @returns `idle` / `loading` / `ready`。
 */
export function getVoiceState(): VoiceState {
  return voiceState;
}

/**
 * 订阅播报状态；订阅时会立刻收到当前值。
 * @param listener - 状态变化回调。
 * @returns 取消订阅；组件卸载/气泡关闭时必须调用。
 */
export function subscribeVoiceState(listener: (state: VoiceState) => void): () => void {
  stateListeners.add(listener);
  listener(voiceState);
  return () => {
    stateListeners.delete(listener);
  };
}

/**
 * 订阅每句播报的开始与结束；不补发历史状态，只报后续事件。
 *
 * @param listener - 事件回调：`start` 表示已经决定要念这一句（合成开始），
 *   `end` 表示播完、合成失败或超时——三种结局都会报一次，气泡不必自己判超时。
 * @returns 取消订阅；卡片卸载或气泡关闭时必须调用。
 */
export function subscribeVoiceUtterance(listener: (event: VoiceUtteranceEvent) => void): () => void {
  utteranceListeners.add(listener);
  return () => {
    utteranceListeners.delete(listener);
  };
}

/** 广播一次播报事件；单个订阅者抛错不能挡住其余订阅者。 */
function emitUtterance(event: VoiceUtteranceEvent): void {
  for (const listener of utteranceListeners) listener(event);
}

/**
 * 把一句回复切成若干可独立合成的片段：**按句子切，不截断**。
 *
 * 老做法是 `speechSlice` 只念前 60 字，长回复听到一半就没了（用户实测就是这样）。
 * 现在改成整段都念，逐片合成、逐片播放：第一片合完就先出声，后面的边播边合成。
 *
 * 切法：先按句末标点（。！？；换行）切句，超长的句子再按逗号切，仍超长才硬切；
 * 过短的碎片并回前一片，避免出现「嗯」「好的」这种半个词单独成段。
 *
 * @param text - 气泡上的原文。
 * @returns 片段数组，每片不超过 {@link VOICE_SPEECH_MAX_CHARS}；总量不超过 {@link VOICE_SPEECH_TOTAL_MAX}。
 */
export function speechPieces(text: string): string[] {
  const body = text.slice(0, VOICE_SPEECH_TOTAL_MAX);
  if (!body.trim()) return [];
  if (body.length <= VOICE_SPEECH_MAX_CHARS) return [body];
  const sentences = body.split(/(?<=[。！？；!?;\n])/u);
  const pieces: string[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf.trim()) pieces.push(buf.trim());
    buf = '';
  };
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;
    if (s.length > VOICE_SPEECH_MAX_CHARS) {
      flush();
      // 长句按逗号再切一刀；还超长就硬切
      for (const clause of s.split(/(?<=[，、,])/u)) {
        const c = clause.trim();
        if (!c) continue;
        if (c.length > VOICE_SPEECH_MAX_CHARS) {
          for (let i = 0; i < c.length; i += VOICE_SPEECH_MAX_CHARS) {
            pieces.push(c.slice(i, i + VOICE_SPEECH_MAX_CHARS));
          }
        } else {
          pieces.push(c);
        }
      }
      continue;
    }
    // 太短（<8 字）就并到上一片，别把「好的。」单独合成一次
    if (buf.length + s.length > VOICE_SPEECH_MAX_CHARS) flush();
    buf += s;
    if (buf.length >= 8) flush();
  }
  flush();
  return pieces.length > 0 ? pieces : [body];
}

/**
 * 取真正送合成的那一段：超长时在句读处截断，不把一句话切在半截。
 *
 * @param text - 气泡上的原文。
 * @returns 不超过 {@link VOICE_SPEECH_MAX_CHARS} 的正文；原文够短时原样返回。
 * @deprecated 只念前 60 字会让长回复「说到一半就没了」，改用 {@link speechPieces}。
 */
export function speechSlice(text: string): string {
  if (text.length <= VOICE_SPEECH_MAX_CHARS) return text;
  const head = text.slice(0, VOICE_SPEECH_MAX_CHARS);
  const cut = Math.max(
    ...['。', '！', '？', '；', '，', '.', '!', '?', ';', ','].map((mark) => head.lastIndexOf(mark)),
  );
  // 句读太靠前就不值得截在那里：宁可硬切，也别只念出半句话。
  return cut >= VOICE_SPEECH_MAX_CHARS / 2 ? head.slice(0, cut + 1) : head;
}

/**
 * 换掉接口基址；桌面端在模块加载时调一次（`file://` 页面不能用相对路径）。
 * @param base - 已含前缀的地址，如 `dsh-pet-bridge://dsh-pet/dsh-pet-7340`。
 */
export function setVoiceBase(base: unknown): void {
  if (typeof base === 'string' && base) voiceBase = base;
}

/**
 * 声明本端是网页端还是桌面端；两端各自在启动时调一次。
 * 没声明时不按 `say` 叶子播放——宁可没声音，也不替另一端出声。
 * @param next - `web` / `desktop`；其余值忽略。
 */
export function setSurface(next: unknown): void {
  if (next === 'web' || next === 'desktop') surface = next;
}

/**
 * 记录成品配置里的音色、总开关与音量；网页端在读到 `/config` 时调一次。
 * 调用即视为配置已就绪，后续播放不再自己去拉。
 * @param name - 音色 id（非字符串按未指定处理）。
 * @param enabled - 播报总开关（严格 `=== true` 才算开启）。
 * @param volume - 音量系数（0–1）；缺省或非数值按最大音量播放。
 */
export function setVoiceConfig(name: unknown, enabled: unknown, volume?: unknown): void {
  voiceName = typeof name === 'string' ? name : '';
  voiceEnabled = enabled === true;
  voiceVolume = clampVolume(volume);
  configLoaded = true;
}

/** 把音量收敛到 0–1；非数值按最大音量（1）处理——脏配置不该把声音悄悄变成 0。 */
function clampVolume(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}

/** 懒加载成品配置；失败按「不播」处理，且只试一次（避免每句都发请求）。 */
async function loadConfigOnce(): Promise<void> {
  if (configLoaded) return;
  try {
    const response = await fetch(voiceBase + '/config', { cache: 'no-store' });
    const body = (await response.json()) as { main?: Record<string, unknown> } | null;
    const main = body?.main;
    voiceName = typeof main?.voiceName === 'string' ? main.voiceName : '';
    voiceEnabled = main?.voiceEnabled === true;
    voiceVolume = clampVolume(main?.voiceVolume);
    // 只有成功才置位：拉不到（bridge 还没就绪 / 瞬时故障）留给下一句重试——
    // 否则一次失败就把这一端永久静音了。
    configLoaded = true;
  } catch {
    /* 拉不到就保持关闭：宁可没声音，也不乱播 */
  }
}

/**
 * 按 `say` 叶子播放：叶子指定了本端、且总开关开着才念。
 *
 * 三个门依次是：叶子有没有点名本端 → 网页端页面是否可见 → 成品配置的总开关。
 * 任何一道没过都只把状态归回 `idle`，气泡照常显示，不打断渲染。
 *
 * @param say - 要念的那一句：`text` 正文，`voiceTo` 该由哪一端念。
 */
export function playSayVoice(
  say: { readonly text: string; readonly voiceTo?: VoiceTarget },
  onHeard?: () => void,
): void {
  const isMine = say.voiceTo !== undefined && say.voiceTo === surface;
  if (!say.text || !isMine) {
    setVoiceState('idle');
    onHeard?.();
    return;
  }
  if (surface === 'web' && typeof document !== 'undefined' && document.hidden) {
    setVoiceState('idle');
    onHeard?.();
    return;
  }
  void speakIfEnabled(say.text, onHeard); // 不 await：播放是旁路，不能挡住气泡与动画
}

/** 确认配置后再播；桌面端首次调用会顺手拉一次 `/config`。 */
async function speakIfEnabled(text: string, onHeard?: () => void): Promise<void> {
  await loadConfigOnce();
  if (!voiceEnabled) {
    setVoiceState('idle');
    onHeard?.();
    return;
  }
  const seq = ++utteranceSeq;
  // 先报开始再置 loading：气泡要靠这条事件挂起收起计时，晚一步它就可能已经收了。
  emitUtterance({ kind: 'start', seq, text });
  setVoiceState('loading');
  try {
    // 一片一片念：第一片合完就出声，后面的**边播边合成**——不能等上一片播完才去合下一片，
    // 否则第一句说完要干等十几秒才接上第二句，比整段截断还难受。
    const pieces = speechPieces(text);
    let pending = requestSpeech(pieces[0] as string);
    for (let i = 0; i < pieces.length; i += 1) {
      const blob = await pending;
      if (!blob) {
        if (i === 0) onHeard?.(); // 第一片都没合成出来：文字照常亮，喇叭变静音
        break;
      }
      // 先把下一片的合成请求发出去，再去播这一片，合成与播放并行
      const next = pieces[i + 1];
      if (next !== undefined) pending = requestSpeech(next);
      const played = await playSpeech(blob, i === 0 ? onHeard : undefined);
      if (!played) break;
    }
  } finally {
    // 成功、失败、超时都走这里：气泡在等这个收尾，漏一次就永远挂着。
    emitUtterance({ kind: 'end', seq, text });
  }
}

/** 请求合成并播放；任何一步失败都落到 `failed`（气泡上留一个静音喇叭，而不是干脆没图标）。 */
/**
 * 请求合成一片，返回可直接播放的 mp3 Blob；失败返回 null（并留下 `failed` 图标）。
 *
 * 与播放分开，是为了让「合成下一片」和「播这一片」并行。
 *
 * @param text - 这一片的正文。
 */
async function requestSpeech(text: string): Promise<Blob | null> {
  try {
    const response = await fetch(voiceBase + '/voice/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, ...(voiceName ? { voice: voiceName } : {}) }),
      signal: speakSignal(),
    });
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('audio')) {
      setVoiceState('failed');
      return null;
    }
    // 音频就绪即置 ready：喇叭表示「这句有语音」，不跟播放进度绑定
    setVoiceState('ready');
    return await response.blob();
  } catch {
    /* 含超时：失败也不能反过来打断渲染，只把图标换成静音喇叭 */
    setVoiceState('failed');
    return null;
  }
}

/**
 * 播放一片，等它**播完**才 resolve：多片是连着播的，不等播完就会几段叠在一起。
 *
 * @param blob - {@link requestSpeech} 拿到的音频。
 * @param onHeard - 真正出声的那一刻回调一次（气泡靠它决定何时亮出文字）。
 * @returns 这一片是否完整播完。
 */
async function playSpeech(blob: Blob, onHeard?: () => void): Promise<boolean> {
  let heard = false;
  const markHeard = (): void => {
    if (heard) return;
    heard = true;
    onHeard?.();
  };
  const objectUrl = URL.createObjectURL(blob);
  const audio = new Audio(objectUrl);
  audio.volume = voiceVolume;
  // 播完或出错都要释放，否则每句留一个 blob 引用
  const finished = new Promise<boolean>((resolve) => {
    audio.onended = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(true);
    };
    audio.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(false);
    };
  });
  try {
    await audio.play();
  } catch {
    URL.revokeObjectURL(objectUrl);
    setVoiceState('failed');
    markHeard();
    return false;
  }
  // 出声的这一刻才把文字亮出来：合成要十几秒，先出字再出声会像两条不同步的轨道
  markHeard();
  return await finished;
}

/** 手动点播时正在响的那个音频；新的一句先掐掉旧的，避免两句话叠在一起。 */
let manualAudio: HTMLAudioElement | null = null;

/** 手动点播对外暴露的阶段；`idle` = 没在放（含被打断），`failed` = 合成没成功。 */
export type SpeakPhase = 'idle' | 'loading' | 'playing' | 'failed';

/** 手动点播的世代号：新的点播会作废旧请求的阶段回调，避免旧回调清掉新状态。 */
let manualSeq = 0;

/**
 * 手动播报一句（对话面板的喇叭按钮用）。
 *
 * 与自动播报有两点不同：不看待播标记（用户点的就是这一句），也不受总开关限制——
 * 开关管的是「自动念不念」，用户主动点播是明确意图。音色仍取配置值。
 *
 * @param text - 要念的正文。
 * @param onPhase - 阶段回调：请求合成时 `loading`、音频就绪开始播时 `playing`、播完 `idle`、失败或超时 `failed`。
 */
export function speakText(text: string, onPhase?: (phase: SpeakPhase) => void): void {
  if (!text) return;
  void playManual(text, onPhase);
}

/** 请求合成并播放手动点播；失败静默，不打断面板交互。 */
async function playManual(text: string, onPhase?: (phase: SpeakPhase) => void): Promise<void> {
  const token = ++manualSeq;
  await loadConfigOnce();
  if (manualAudio) {
    manualAudio.pause();
    manualAudio = null;
  }
  if (token !== manualSeq) return; // 等配置期间又被点了一次：这次直接让位
  onPhase?.('loading');
  try {
    const response = await fetch(voiceBase + '/voice/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, ...(voiceName ? { voice: voiceName } : {}) }),
      signal: speakSignal(),
    });
    if (token !== manualSeq) return;
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('audio')) {
      onPhase?.('failed');
      return;
    }
    const objectUrl = URL.createObjectURL(await response.blob());
    if (token !== manualSeq) return;
    const audio = new Audio(objectUrl);
    audio.volume = voiceVolume;
    audio.onended = () => {
      URL.revokeObjectURL(objectUrl);
      if (manualAudio === audio) {
        manualAudio = null;
        onPhase?.('idle');
      }
    };
    audio.onerror = () => URL.revokeObjectURL(objectUrl);
    manualAudio = audio;
    onPhase?.('playing');
    await audio.play();
  } catch {
    /* 含超时：面板里还有文字，不弹错误打断阅读，只把按钮换成失败态 */
    if (token === manualSeq) onPhase?.('failed');
  }
}
