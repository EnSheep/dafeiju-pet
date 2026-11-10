# 用本机 ComfyUI 出 19 条桌宠动作 —— 环境分析与生产方案

> 结论先说：**能，而且你已经把最难的一段搭通了。** 瓶颈不在"能不能换角色"，而在"5 秒一段"和"猫尾没有控制信号"。
> 分析对象：`F:\ComfyUI_windows_portable` + `cat-pet/`（本工作区的处理链）。

---

## 一、环境实测（2026-11-04 现场查的，不是猜）

| 项 | 实测值 | 判定 |
| --- | --- | --- |
| ComfyUI | `F:\ComfyUI_windows_portable`，核心 **0.43.0** | ✅ 够新，核心自带 Wan2.2 Fun-Control 节点 |
| Python / torch | 3.13.14 / **torch 2.14.1+cu130** | ✅ Blackwell sm_120 有支持（`cap (12,0)`） |
| GPU | RTX 5070 Ti / **16 GB** | ⚠️ 5B 模型够，14B 不够 |
| 视频模型 | `diffusion_models/Wan2.2-Fun-5B-Control-Q4_K_M.gguf`（3.28 GB） | ✅ 正是"参考图 + 控制视频"的模型 |
| 文本编码器 | `text_encoders/umt5-xxl-enc-fp8_e4m3fn.safetensors`（6.42 GB） | ✅ Wan 专用 |
| VAE | `vae/Wan2_2_VAE_bf16.safetensors`（1.34 GB） | ✅ Wan2.2 专用 |
| 图像模型（备选） | `z_image_turbo_nvfp4` + `qwen_3_4b_fp4_mixed` + `ae.safetensors` + `Z-Image-Turbo-Fun-Controlnet-Union-2.1-8steps` | ✅ 可先出角色定妆图再喂视频 |
| 自定义节点 | `ComfyUI-GGUF`、`ComfyUI-WanVideoWrapper`、`comfyui_controlnet_aux`、`ComfyUI_Pose-Gallery_ZH`、`ComfyUI-Manager` | ✅ 加载/控制/预处理齐了 |
| 视频读写 | 核心 `SaveWEBM` / `SaveVideo` / `LoadVideo`（`comfy_extras/nodes_video.py`） | ✅ 不用装 VHS |
| 已有工作流 | `character_to_video.json`（LoadImage → DepthAnythingPreprocessor → ImageScale → RepeatImageBatch → WanVideoEncode → WanVideoAddControlEmbeds → WanVideoSampler → WanVideoDecode → SaveAnimatedWEBP）；`pose_to_character_video.json`（Z-Image 出图 → 再喂 Wan） | ✅ **这条链路你已经跑通过** |

显存账：Q4 的 5B（3.3 GB）+ umt5 fp8（6.4 GB）+ VAE（1.3 GB）≈ **11 GB 权重**，16 GB 装得下，但采样时 720p × 121 帧的注意力会顶到上限 → `WanVideoModelLoader` 的第 4 个参数保持 `offload_device`（文本编码器编完就挪走），必要时开 block swap。

---

## 二、三个硬约束（决定排期，不是能力问题）

1. **单段 5 秒**：Wan2.2 5B 原生 **121 帧 @24fps = 5.04 s**。10 秒的动画必须两段接：第 2 段把第 1 段最后一帧当 `start_image`（`WanVideoImageToVideoEncode` 有这个输入），接缝用 4–8 帧交叉淡化。
2. **控制信号里没有的东西，模型不会自己长**：`WanVideoAddControlEmbeds` 吃的是 depth/canny 这类**结构**；官方片里是"蓝发女仆 + 鲸鱼尾巴"，depth 里**没有猫尾**，所以猫尾不会被驱动 —— 需要在提示词里明确"尾巴自然下垂/随呼吸轻摆"，否则会静止或抽搐。
3. **外观全靠 ref_image + 提示词**：这既是"换角色"的抓手，也是一致性风险源 —— 19 条之间角色细节会漂，必须固定同一张参考图 + 同一段角色描述前缀 + 固定 seed 族。

---

## 三、19 条清单（名字必须和 `config.jsonc` 里一模一样，否则 404）

| # | 动画名（配置原名） | 用途档 | 控制来源（官方片） | 提示词要点 | 循环？ |
| --- | --- | --- | --- | --- | --- |
| 1 | `待机呼吸休闲` | idle | **已完成**（豆包直出 + key_v2） | — | 是 |
| 2 | `东张西望` | turn | `东张西望.mp4` | 头左右转，身体不动，猫尾轻摆 | 否 |
| 3 | `被鼠标拖拽悬空反馈` | drag | `被鼠标拖拽悬空反馈.mp4` | 被无形手拎起，四肢下垂晃动 | 是 |
| 4 | `点击回应-开心跃动` | clicks | 同名 mp4 | 原地小跳 + 双手举起 | 否 |
| 5 | `点击回应-害羞惊讶` | clicks | 同名 mp4 | 捂脸、眼神躲闪 | 否 |
| 6 | `点击回应-傲娇生气` | clicks | 同名 mp4 | 抱臂扭头、鼓腮 | 否 |
| 7 | `点击回应-挠痒咯咯笑` | clicks | 同名 mp4 | 缩肩笑、手挡 | 否 |
| 8 | `点击回应-元气挥手` | clicks | 同名 mp4 | 抬手挥动 | 否 |
| 9 | `螃蟹走路` | moves | 同名 mp4 | 侧身横移，猫尾跟随 | 是 |
| 10 | `原地漂浮踏步` | moves | 同名 mp4 | 原地小碎步 | 是 |
| 11 | `原地左转奔跑` | moves | 同名 mp4 | 原地跑，转身 | 是 |
| 12 | `睡觉-开始` | sleep.start | 同名 mp4 | 闭眼、坐下、身体下沉 | 否 |
| 13 | `睡觉-循环` | sleep.loop | 同名 mp4 | 蜷缩起伏、Zzz | 是（首尾同帧） |
| 14 | `睡觉-起来` | sleep.end | 同名 mp4 | 睁眼、伸懒腰、站起 | 否 |
| 15 | `悠闲哼歌` | 随机 | 同名 mp4 | 摇头晃脑哼歌 | 是 |
| 16 | `超大伸懒腰` | 随机 | 同名 mp4 | 双臂上伸、身体弓起 | 否 |
| 17 | `哈欠连天` | 随机 | 同名 mp4 | 张嘴打哈欠、揉眼 | 否 |
| 18 | `偷吃零食被抓住` | 随机 | 同名 mp4 | 拿零食、惊吓、藏起来 | 否 |
| 19 | `撸猫` | 随机 | 同名 mp4 | 蹲下轻抚（若道具不好处理可换 `照镜子`） | 否 |

`待机呼吸休闲` 已经有了；**其余 18 条要生成**。

---

## 四、一条动画的生产流水线

```
官方 mp4（F:\assets-videos\video\*.mp4，10s）
   │ ① 切两段 0–5s / 5–10s（ffmpeg -ss/-t），1024×576 够做控制信号
   ▼
ComfyUI：LoadVideo → DepthAnythingPreprocessor → ImageScale → WanVideoAddControlEmbeds
         LoadImage(橘猫设计图) → ref_image
         WanVideoSampler(121 帧) → WanVideoDecode → SaveVideo(mp4)
   │ ② 第 2 段用第 1 段最后一帧当 start_image
   ▼
ffmpeg concat（+ 交叉淡化 4 帧）
   ▼
cat-pet/tools/key_v2.py  ← 前提：提示词里要求「纯绿 #00FF00 背景」
   │ ③ 软抠 + despill（顺带能出纯绿母版）
   ▼
run_script_serial.py normalize_step03.py  → 2160×1215、站高 900、脚底距底 100
run_script_serial.py encode_thumbs.py     → 640×360 VP9-alpha ≈ 400–500 KB
   ▼
拷到 C:\Users\lianzhi\.dsh\dsh-pet\main-animation\webm\  → 重开 DSH 生效
```

---

## 五、时间估算（5B Q4 / 640×1136 / 20 步 / offload_device）

| 环节 | 单条 | 18 条 |
| --- | --- | --- |
| 生成（2 段 × 121 帧） | 8–16 分钟 | **2.5–5 小时** |
| 废片重跑（按 30–50%） | — | **+1–2.5 小时** |
| 拼接 + 抠像 + 编码 | ≈ 1.5 分钟 | ≈ 30 分钟 |
| 合计 | — | **半天到一天**（不含你挑片改词的时间） |

真正的不确定性是**废片率**：chibi 角色的手、道具、裙摆蕾丝最容易崩。建议先做 1 条（`点击回应-元气挥手`）验证质量，再决定要不要铺 18 条。

---

## 六、风险与对策

| 风险 | 表现 | 对策 |
| --- | --- | --- |
| 猫尾无控制 | 静止、闪烁、消失 | 提示词固定描述尾巴状态；或只做上半身动作 |
| 5 秒拼接缝 | 第 5 秒处动作跳变 | 第 2 段用第 1 段末帧做 start_image + 4–8 帧交叉淡化 |
| 角色漂移 | 19 条之间发型/围裙细节不一致 | 同一 ref_image、同一前缀、固定 seed 族、低 cfg |
| 道具崩坏 | 琴/木马/球变形 | 清单里已避开大部分道具类；`撸猫` 若崩换成 `照镜子` |
| 文字类动画 | 余额数字变乱码 | **直接不做**，那 3 条 `余额-*` 从配置里藏掉 |
| 显存顶满 | OOM / 极慢 | 分辨率降到 640×1136，开 block swap，`--lowvram` 不用（会太慢） |

---

## 七、藏掉另外 90 条的配置

写到 `C:\Users\lianzhi\.dsh\dsh-pet\main-config.jsonc`（用户层，整段替换；**没写进池子的动作就等于藏了**，右键菜单也不会出现）：

```jsonc
{
  "animations": {
    "idle": ["待机呼吸休闲"],
    "turn": ["东张西望"],
    "drag": ["被鼠标拖拽悬空反馈"],
    "clicks": [
      "点击回应-开心跃动", "点击回应-害羞惊讶", "点击回应-傲娇生气",
      "点击回应-挠痒咯咯笑", "点击回应-元气挥手"
    ],
    "moves": {
      "default": { "minDist": 60, "maxDist": 240, "margin": 20, "leadSec": 2, "tailSec": 2 },
      "actions": [
        { "name": "螃蟹走路" },
        { "name": "原地漂浮踏步", "params": { "minDist": 40, "maxDist": 120 } },
        { "name": "原地左转奔跑", "params": { "minDist": 120, "maxDist": 320, "leadSec": 1.75, "tailSec": 4.8 } }
      ]
    },
    "categories": [
      { "id": "小动作", "weight": 80, "actions": [
        "悠闲哼歌", "超大伸懒腰", "哈欠连天", "偷吃零食被抓住", "撸猫"
      ] }
    ],
    "sleep": [
      { "start": ["睡觉-开始"], "loop": ["睡觉-循环"], "end": ["睡觉-起来"] }
    ]
  },
  "animationWeights": { "idle": 10, "turn": 5, "move": 5 }
}
```

两条硬规则（源码 `src/shared/weights.ts:12`、`assets/config.jsonc` 注释）：

- `idle + turn + move` 之和 ≤ 100，余量就是「随机动作」的占比 → 10+5+5 留 80，正好等于唯一分类的 `weight: 80`；
- **池子里写了不存在的动作名 = 该动作 404 不播**（菜单照常显示）。所以这份配置必须在 18 条素材都到位之后再切，否则点一下就没反应。

---

## 八、下一步（建议顺序）

1. **先跑 1 条**：`点击回应-元气挥手`（动作简单、失败成本低），验证"控制信号 + 参考图 → 换角色"到底像不像。
2. 看片决定：像 → 按清单铺开 18 条；不像 → 改 ref_image / 提示词 / 控制类型（depth 换 canny 或 lineart），或退回"豆包按提示词重生"路线（画风与现在的待机完全一致，但你要手工过 109 条）。
3. 18 条齐了再切 `main-config.jsonc`，然后重开 DSH 验证"点击/拖拽/走路/睡觉"全是我们自己的猫。
