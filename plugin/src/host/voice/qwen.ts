/**
 * 本机 Qwen3-TTS 服务：把「克隆音色」注册成第三方语音实现。
 *
 * 分工：模型跑在一个独立 Python 进程里（加载 2.5s、建克隆 prompt 15s，
 * 每次合成重来一遍没法用），这里只负责
 *   1) 应用启动时把它拉起来、退出时收掉；
 *   2) 合成时把文本 POST 过去，拿回 mp3 字节。
 *
 * 关掉的办法：环境变量 `DSH_PET_TTS=off`。
 * 换地址：`DSH_PET_TTS_URL`（默认 http://127.0.0.1:8765）。
 * 换解释器 / 脚本：`DSH_PET_TTS_PYTHON`、`DSH_PET_TTS_SCRIPT`。
 * @module dsh-pet/src/host/voice/qwen
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerVoiceProvider, type VoiceProvider } from './registry.ts';

/** 参与缓存键的实现 id；换实现不会命中旧音频。 */
export const QWEN_VOICE_ID = 'qwen3-tts';

const DEFAULT_URL = 'http://127.0.0.1:8765';

/** 等模型加载完的上限：冷启动约 18 秒，给足余量。 */
const READY_TIMEOUT_MS = 120_000;

interface ProviderOptions {
  /** 服务地址，末尾斜杠无所谓。 */
  readonly url: string;
  /** 首次合成前等 /health 就绪的时长。 */
  readonly readyTimeoutMs?: number;
}

/**
 * 造一个「把文本丢给本机 Qwen3-TTS 服务」的语音实现。
 *
 * 首次合成会先等 `/health`（模型加载期间返回 200 + ok:false 以外的错误都算没就绪），
 * 就绪后不再探活——服务在本进程生命周期内不该自己消失，真挂了就让它抛错、走日志。
 */
export function createQwenVoiceProvider(options: ProviderOptions): VoiceProvider {
  const base = options.url.replace(/\/+$/, '');
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  let ready: Promise<void> | null = null;

  async function waitReady(): Promise<void> {
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      try {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          const body = (await res.json()) as { ok?: boolean };
          if (body.ok) return;
        }
      } catch {
        // 还没起来：继续等
      }
      if (Date.now() > deadline) throw new Error(`qwen-tts 未就绪（${readyTimeoutMs}ms 内 /health 没通）`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return {
    id: QWEN_VOICE_ID,
    name: 'Qwen3-TTS 克隆音色',
    async synthesize({ text }) {
      if (!ready) ready = waitReady();
      await ready;
      const res = await fetch(`${base}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        // 失败必须抛：宿主会归一成 generate-error 并记日志
        throw new Error(`qwen-tts ${res.status} ${detail.slice(0, 200)}`);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length === 0) throw new Error('qwen-tts 返回空音频');
      return bytes;
    },
  };
}

/** 从打包后的位置反推插件根目录（lib/app.js -> 上一级）。 */
function pluginRoot(): string {
  try {
    return resolve(dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    return process.cwd();
  }
}

/** 默认解释器：工作区里那套装了 torch + qwen-tts 的 venv（插件根 ≡ <工作区>/cat-pet/plugin）。 */
function defaultPython(root: string): string {
  const candidates = [
    join(root, '..', '..', '.qwen-tts', 'venv', 'Scripts', 'python.exe'),
    join(root, '..', '.qwen-tts', 'venv', 'Scripts', 'python.exe'),
    join(root, '.qwen-tts', 'venv', 'Scripts', 'python.exe'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

/**
 * 拉起本机 TTS 服务（幂等：已经在跑就直接用）。
 *
 * 返回的 disposer 会杀掉自己拉起的那个子进程；不阻塞——模型加载期间
 * 合成调用会自己等 `/health`。
 */
export function startQwenTtsService(options: { url?: string } = {}): () => void {
  const url = options.url ?? process.env.DSH_PET_TTS_URL ?? DEFAULT_URL;
  const port = Number(new URL(url).port || 8765);
  const root = pluginRoot();
  const python = process.env.DSH_PET_TTS_PYTHON ?? defaultPython(root);
  const script = process.env.DSH_PET_TTS_SCRIPT ?? resolve(root, '..', 'tts_server.py');

  let child: ChildProcess | null = null;
  const env = { ...process.env, DSH_PET_TTS_PORT: String(port), HF_HUB_OFFLINE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;

  if (existsSync(python) && existsSync(script)) {
    try {
      child = spawn(python, [script], { cwd: dirname(script), env, stdio: 'ignore', windowsHide: true });
      child.on('error', () => {
        child = null;
      });
    } catch {
      child = null;
    }
  }

  return () => {
    try {
      child?.kill();
    } catch {
      // 已经退出了
    }
    child = null;
  };
}

/**
 * 注册克隆音色；`DSH_PET_TTS=off` 时什么都不做。
 *
 * @returns disposer：注销 provider 并收掉子进程。
 */
export function registerQwenVoice(log?: {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}): () => void {
  if ((process.env.DSH_PET_TTS ?? '').toLowerCase() === 'off') {
    log?.info?.('[dsh-pet] 克隆音色：已按 DSH_PET_TTS=off 关闭，走内置 edge');
    return () => {};
  }

  const url = process.env.DSH_PET_TTS_URL ?? DEFAULT_URL;
  const stopService = startQwenTtsService({ url });
  const dispose = registerVoiceProvider(createQwenVoiceProvider({ url }));
  log?.info?.(`[dsh-pet] 克隆音色：已注册 ${QWEN_VOICE_ID} -> ${url}`);

  return () => {
    dispose();
    stopService();
  };
}
