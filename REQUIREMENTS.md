# 硬件与软件需求

> 本文所有数字都来自一台 **RTX 5070 Ti 16 GB / Windows 11 / Node 24.21 / Python 3.14** 的实机实测，
> 不是估算。如果你的机器不一样，按第 2 节的档位表对照即可。

---

## 0. 一句话版本

**Windows 10/11 x64 + 一张 16 GB 显存的 NVIDIA 显卡 + 约 15 GB 可用磁盘 + 首次安装时需要联网。**
跑起来之后可以完全离线。

最低能跑的门槛是 **8 GB 显存 + 9B 模型**，但会明显卡（模型换入换出）。
不用本地模型、改接云端 API 的话，显存需求降到 3 GB 左右，见第 7 节。

---

## 1. 硬件需求

### 1.1 显卡（决定性因素）

显存决定了你能同时驻留多大的模型。本项目要同时占用显存的有两样：**聊天模型** 和 **TTS 模型**。

| 档位 | 显存 | 能跑什么 | 实际体验 |
|---|---|---|---|
| **A 最低** | 8 GB | 7B–9B Q4 聊天 + 0.6B TTS | 能聊，但两个模型会争抢显存，来回换入换出，偶发 3–10 秒卡顿 |
| **B 够用** | 12 GB | 9B Q4 + TTS | 顺畅 |
| **C 本项目实测** | **16 GB** | **14B Q4 + TTS** | 可用，峰值只剩 1.4 GB 余量 |
| **D 舒适** | 24 GB | 32B Q4 + TTS | 回复质量明显更好 |
| E 只有核显 | — | 3B 级 CPU 推理 | 能跑但不建议，首字延迟 10 秒以上 |

**实测显存账本（档位 C）**：

| 项 | 占用 |
|---|---|
| `qwen3:14b`（14.8B，Q4_K_M） | 8.99 GB |
| Qwen3-TTS 0.6B + 参考音色 | 2.59 GB（峰值） |
| `bge-m3`（向量模型，可随时卸载） | 1.08 GB（按需加载，`keep_alive: 30m`） |
| 桌面 + Electron 渲染 | 约 1 GB |
| **合计** | **约 12.5 / 16.3 GB** |

> 4 bit 量化下，显存 ≈ 参数量 × 0.55 GB/十亿参数。
> 14.8B → 约 8.1 GB（实测 8.64 GB，多出来的是 embedding 层和量化系数）。

### 1.2 为什么是 16 GB 这个分水岭

聊天模型和 TTS 模型要**同时**驻留，否则每次说话都要重新加载（20 秒起）。
所以可用显存 ≈ 显卡显存 − 1 GB（桌面） − 想跑的模型大小。

- 9B（6.5 GB）+ TTS（2.6 GB）+ 桌面（1 GB）≈ **10.1 GB → 12 GB 卡够**
- 14B（9 GB）+ TTS（2.6 GB）+ 桌面（1 GB）≈ **12.6 GB → 需要 16 GB 卡**

### 1.3 其它硬件

| 部件 | 要求 | 说明 |
|---|---|---|
| CPU | 4 核以上，推荐 8 核 | 推理在 GPU，但 Electron 渲染、MP3 编码、模型加载都要 CPU |
| 内存 | 16 GB 起，推荐 32 GB | 模型加载瞬间有 CPU 侧峰值；WAL 模式的 SQLite 也吃页缓存 |
| 磁盘 | **SSD，20 GB 可用** | 模型 12 GB + 依赖 3 GB + 仓库 1 GB + 缓存 |
| 音频 | 任意扬声器/耳机 | 输出即可（录音功能已移除，不需要麦克风） |
| 网络 | **仅安装时需要** | 运行时可完全离线 |

**磁盘明细**：

```
.qwen-tts/            12.0 GB   模型（TTS 2.34 + 下载缓存/临时）
D:\Ollama\models       9.7 GB   聊天模型 + 向量模型
node_modules           256 MB   依赖
仓库本体               约 65 MB  代码 + 动画素材
```

---

## 2. 软件需求

### 2.1 运行环境

| 软件 | 最低版本 | 实测版本 | 用途 | 说明 |
|---|---|---|---|---|
| Windows | 10 21H2 / 11 x64 | Windows 11 | 运行平台 | 依赖透明窗、托盘、DPI 感知 |
| **Node.js** | **≥ 22.12** | 24.21.0 | 应用运行时 | `package.json` 里 `engines` 写死了；低于 22.12 的 ESM 加载会有问题 |
| **Electron** | 43.3.0 | 43.3.0 | 桌面壳（137.7 MB） | 内置 Chromium 与 Node 24，**不需要另外装 Node 给渲染进程** |
| **Ollama** | ≥ 0.5 | 最新 | 本地模型推理服务 | 必须监听 `127.0.0.1:11434` |
| **Python** | 3.11–3.14 | 3.14.0 | 跑 TTS 服务 | 需要能装 `torch` 的 cu128 轮子 |
| NVIDIA 驱动 | 支持 CUDA 12.x | 最新 | GPU 加速 | **不需要单独装 CUDA Toolkit**（见 2.5） |

### 2.2 模型清单（必须下载，共约 12 GB）

| 模型 | 体积 | 用途 | 获取方式 |
|---|---|---|---|
| `qwen3:14b` | 8.64 GB | 聊天（14.8B Q4_K_M） | `ollama pull qwen3:14b` |
| `bge-m3` | 1.08 GB | 向量检索（1024 维） | `ollama pull bge-m3` |
| `Qwen3-TTS-12Hz-0.6B-Base` | 2.34 GB | 克隆语音合成 | 从 HuggingFace 下载 12 个文件到 `.qwen-tts/models/` |

**换更小的聊天模型**：`qwen3:8b`（5.2 GB）或任意 7B–9B 的 Q4 模型都能跑，
改 `standalone-ai.json` 里的 `model` 字段即可，代码不用动。

### 2.3 Python 依赖

```
torch==2.11.0+cu128        # 从 download.pytorch.org 装，不要从 PyPI 装默认版
torchaudio==2.11.0+cu128
qwen-tts==0.1.1            # 会带进 transformers==4.57.3
onnxruntime==1.31.1        # qwen-tts 的 25Hz tokenizer 需要，即便用 12Hz 模型
numpy / scipy / soundfile / librosa
lameenc==1.9.0             # WAV → MP3 编码（替代 ffmpeg）
accelerate / einops
```

**一个必须知道的坑**：`qwen-tts` 依赖 `sox==1.5.0`，而这个包**只有源码分发（sdist）**。
在 Windows 上 uv 的隔离构建会失败：

```
PermissionError: [Errno 13] Permission denied: ...\tmp-xxxx\sox-1.5.0-py3-none-any.whl
（尾部是 shutil 里 tempfile._resetperms 的 WinError 5）
```

绕法：手工构建成 wheel 再装。

```powershell
# 1) 下 sdist 并解压
# 2) 在解压目录里构建
python setup.py bdist_wheel --dist-dir <轮子输出目录>
# 3) 装本地 wheel
uv pip install <轮子输出目录>\sox-1.5.0-py3-none-any.whl
```

> `sox` 的 Python 包只是给 25Hz tokenizer 做音频归一化用的；
> 12Hz 模型的路径**不调用它**，所以装不上 sox.exe 二进制也不影响使用
> （import 时会打印 `SoX could not be found!` 警告，忽略即可）。

### 2.4 实测通过的版本组合

| 组件 | 版本 |
|---|---|
| Node.js | 24.21.0 |
| Electron | 43.3.0 |
| Windows | 11 x64 |
| Python | 3.14.0 |
| torch | 2.11.0+cu128 |
| qwen-tts | 0.1.1 |
| Ollama | 0.5+ |
| 显卡 | RTX 5070 Ti 16 GB（Blackwell, sm_120） |

### 2.5 不需要的东西（常见误解）

| 不需要 | 原因 |
|---|---|
| **CUDA Toolkit** | `torch` 的 wheel 里自带 `cublas64_12.dll` 等运行库，运行时只需把它的目录加进 PATH |
| **ffmpeg** | 用 `lameenc` 直接做 WAV→MP3，纯 Python |
| **向量数据库**（FAISS / Milvus / pgvector） | 2000 条记录暴力余弦只要 1–3 ms |
| **编译器**（Visual Studio Build Tools） | 除 `sox` 那个特例，其余都有预编译轮子 |
| **麦克风** | 语音输入功能已移除 |
| **联网** | 运行时可完全离线，只有安装时要下载 |

---

## 3. 从零安装（7 步）

```powershell
# 0) 前置：装好 Node ≥22.12、Python 3.11+、Ollama，并启动 Ollama
ollama serve

# 1) 拉聊天模型和向量模型
ollama pull qwen3:14b
ollama pull bge-m3

# 2) 装 Electron（137 MB）
cd cat-pet\plugin
npm run ensure:electron
#    或手动解压到 %USERPROFILE%\.dsh\electron\

# 3) 装 Node 依赖
npm install          # 若用 pnpm，建议 --node-linker=hoisted（见 README 的踩坑说明）

# 4) 建 Python 虚拟环境并装依赖（放在仓库根，别放 C 盘）
uv venv .qwen-tts\venv --python 3.11
uv pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
uv pip install qwen-tts onnxruntime lameenc     # sox 见 2.3 的手工构建

# 5) 下 TTS 模型（12 个文件，2.34 GB）到 .qwen-tts\models\Qwen3-TTS-12Hz-0.6B-Base\
#    可用 huggingface-cli、hf-mirror 或脚本逐文件下载

# 6) 准备参考音色：放一段 3–15 秒干净人声 + 它的逐字稿
#    修改 tts_server.py 顶部的 REF_WAV / REF_TEXT

# 7) 启动
双击 启动桌宠.vbs      # 无控制台窗口
#    或 cat-pet\启动桌宠.cmd（有日志窗口）
```

---

## 4. 目录与配置

| 路径 | 内容 |
|---|---|
| `%USERPROFILE%\.dsh-cat\dsh-pet\main-config.jsonc` | 宠物配置：名字、大小、位置、人设（`whisperPrompt`）、语音开关 |
| `%USERPROFILE%\.dsh-cat\dsh-pet\standalone-ai.json` | 模型配置：`baseUrl` / `model` / `apiKey` / `maxTokens` / `timeoutMs` / `reasoningEffort` |
| `%USERPROFILE%\.dsh-cat\dsh-pet\memory.json` | 对话原文（唯一真相，可删） |
| `%USERPROFILE%\.dsh-cat\dsh-pet\memory.db` | 记忆索引（SQLite + WAL，删了会自动从 json 重建） |
| `%USERPROFILE%\.dsh-cat\dsh-pet\voice-cache\` | 合成好的 mp3 缓存 |
| `%USERPROFILE%\.dsh-cat\dsh-pet\logs.txt` | 运行日志 |

**用 `DSH_HOME` 环境变量可以把整个数据目录搬到别处**，这也是同一份代码能同时跑
"宿主插件版"和"独立桌面版"两套互不干扰实例的办法。

---

## 5. 配置档位速查

| 你的显卡 | 推荐聊天模型 | 改哪里 |
|---|---|---|
| 8 GB | `qwen3:8b` | `standalone-ai.json` 的 `model` |
| 12 GB | `qwen3.5-unc:9b` | 同上 |
| **16 GB** | **`qwen3:14b`** | 默认 |
| 24 GB+ | `qwen3:32b` | 同上，并调大 `timeoutMs` |
| 无独显 | 改用云端 API（第 7 节） | 改 `baseUrl` + `apiKey` |

---

## 6. 常见故障对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动后立刻退出，无日志 | **单实例锁**被占用（`--user-data-dir` 绕不过） | 托盘右键 → 退出，或任务管理器结束旧的 electron.exe |
| `Cannot find module 'zod'` | `node_modules` 被别的 `pnpm install` prune 掉 | 在 `cat-pet/plugin` 下重装依赖 |
| `Cannot securely load standalone AI settings.` | **两种原因**：文件权限不对，或字段超范围（如 `timeoutMs > 60000`） | 先查字段范围，再查 ACL |
| 回复是空的 / 报 `generate-error` | 思考型模型把 token 烧在 reasoning 上 | 配置里加 `"reasoningEffort": "none"` |
| 桌面上有个白方块 | 透明窗没生效 | 确认 Windows 开了"透明效果"，且用 `transparent: true` |
| 宠物不发音 | 配置缺 `voiceEnabled`（缺省即静音） | 在 `main-config.jsonc` 加 `"voiceEnabled": true` |
| 声音很慢才出来 | TTS 冷启动要 17 秒（模型 2.4 + 音色 15） | 正常，启动时会自动预热 |
| 说到一半没声了 | 单次播放上限 120 字 | 设计如此，见技术文档第 6 节 |
| TTS 报 `cublas64_12.dll is not found` | 该坑属于 ASR 模块（已移除），TTS 不走 ctranslate2 | — |

---

## 7. 不想装本地模型？接云端 API

显存需求从 16 GB 降到 **3 GB**（只剩 TTS），甚至**完全不占显存**（如果 TTS 也用云服务）。

改 `%USERPROFILE%\.dsh-cat\dsh-pet\standalone-ai.json`：

```jsonc
{
  "protocol": "openai-compatible",
  "baseUrl": "https://api.deepseek.com/v1",
  "model": "deepseek-chat",
  "apiKey": "sk-...",
  "maxTokens": 1024,
  "timeoutMs": 60000,
  "reasoningEffort": ""
}
```

任何**兼容 OpenAI 协议**的服务都能用：DeepSeek、通义、月之暗面、vLLM、LM Studio、OpenRouter……

代价是**对话内容出机器**（记忆库仍在本地，只有每轮检索出的 6 条 + 最近几轮会发出去）。

---

## 8. 许可与致谢

- 上游项目：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（MIT）
- 聊天模型：Qwen3（Apache 2.0）
- 语音合成：Qwen3-TTS（Apache 2.0）
- 向量模型：bge-m3（MIT）

本项目沿用上游的 MIT 许可，详见 [LICENSE](LICENSE)。
