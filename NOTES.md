# 大肥橘猫桌宠 · 进度与操作手册

> 目标（用户 m00001 / m00253）：把 https://github.com/PC2005-cloud/dsh-pet 换成自己的形象，
> 先跑通「1 条待机动画 → webm → 安装插件 → 桌面上看到猫」。

## 现在做到哪了

| 环节 | 状态 |
| --- | --- |
| 仓库克隆 | ✅ 工作区 `dsh-pet/`（depth 1，main） |
| 插件源码副本 | ✅ `cat-pet/plugin/`（893 文件，已 `pnpm install`） |
| 插件构建 | ✅ `cat-pet/plugin/lib/{index,client}.js`（tsdown 只跑了 client + host 两份，见下"已知坑"） |
| 装进 profile | ✅ `C:\Users\lianzhi\.dsh\profiles\desktop\package.json` 用 `link:` 指向 `cat-pet/plugin`，bundles 末尾加了 `dsh-pet`；`pnpm install` 成功 |
| 待机动画（v2 精修） | ✅ `C:\Users\lianzhi\.dsh\dsh-pet\main-animation\webm\待机呼吸休闲.webm`（406,520 B，640×360 VP9-alpha，24fps，10.04s 循环，尾部 8 帧向首部混合） |
| 打盹动画 | ✅ `...\main-animation\webm\原地小憩沉眠.webm`（720,444 B，640×360，10.04s；源为 Kling 片 `kling_20261105_VIDEO__绝对空间与边界约束_2360_0.mp4`，1280×720/24fps，右下角水印用 `--mask-box 1040,650,1280,720` 遮掉） |
| 其余 107 条动作 | 🚫 已隐藏：`main-config.jsonc` 把所有池子改成只引用上面两条，`animationWeights {idle:90,turn:0,move:0}` + 单分类 weight 10 |
| 纯绿幕母版 | ✅ `cat-pet\out\deliver\Q版大肥橘猫-纯绿幕-1080p.mp4`（1920×1080 H.264，纯 #00FF00 背景，无水印/无阴影） |
| **在桌面上看到猫** | ⏳ 每次改素材或配置都要**重开 DSH**（`INSTALL.md:7`：插件只在启动时扫描） |
| 换新动作 | ✅ 一条命令：`py -3 cat-pet\tools\add_action.py <视频> --name <动作名> [--mask x1,y1,x2,y2]`，详见 `cat-pet/替换动作指南.md` |
| ComfyUI 换角色实验 | ❌ 结论：5B Q4 Fun-Control 在 16GB 上角色会「融化」、头部两侧长出异物、末段背景变色；放弃，改回云视频出片（细节见 `cat-pet/analysis/comfyui-19-clip-plan.md` 与本文件末尾） |

## 重开 DSH 之后怎么确认

1. 宠物默认在**界面右上角**（`assets/config.jsonc:264` `display: "both"`）。
2. 宿主侧健康检查：浏览器或命令行访问 `http://127.0.0.1:<端口>/dsh-pet-7340/state`，返回 JSON 即插件已加载。
3. 插件自己的日志：`C:\Users\lianzhi\.dsh\dsh-pet\logs.txt`。
4. 素材是否生效：`http://127.0.0.1:<端口>/dsh-pet-7340/thumb/main/待机呼吸休闲.webm` 应返回 video/webm。

## 素材是怎么做出来的（可复现）

源：`C:\Users\lianzhi\Downloads\Q版大肥橘猫桌面宠物设计.mp4`（3840×2160 / 24fps / 10s，绿豆沙绿幕 #8AB060，右下角有水印）

```powershell
$py = 'C:\Users\lianzhi\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
$ff = 'dsh-pet\.tools\ffmpeg-9.0.1-essentials_build\bin\ffmpeg.exe'

# ① 缩到 720p（官方链路的输入规格）
& $ff -i '...\Q版大肥橘猫桌面宠物设计.mp4' -vf "scale=1280:720,fps=24" -c:v libx264 -crf 18 -pix_fmt yuv420p -y 'dsh-pet\video\待机呼吸休闲.mp4'

# ② 抠像（v2 精修：全分辨率软抠 + despill）→ step02；同时可导出纯绿幕母版
& $py 'cat-pet\tools\key_v2.py' '...\Q版大肥橘猫桌面宠物设计.mp4' --webm 'dsh-pet\step02\待机呼吸休闲.webm' --plate 'cat-pet\out\deliver\Q版大肥橘猫-纯绿幕-1080p.mp4' --size 1920x1080

# ③④ 官方归一化 + 缩略图（沙箱禁止命名管道，ProcessPoolExecutor 会 WinError 5，所以用串行壳）
& $py 'cat-pet\tools\run_script_serial.py' 'dsh-pet\scripts\normalize_step03.py'
& $py 'cat-pet\tools\run_script_serial.py' 'dsh-pet\scripts\encode_thumbs.py'
```

## 为什么没用官方 step01/step02

- **step01（去水印）** 依赖 `scipy.ndimage.distance_transform_edt`，本机 Python 没 scipy。
- **step02（绿幕抠像）** 判定的是「色相 70–170 + S>0.15 + V>0.15」，对这条片子本身可用，
  但会把角色的**地面阴影**（同色相、更暗）留成一块半透明绿斑，水印也留一点。
- 自己写的 `mp4_to_alpha_webm.py` 做两件事：① 从画面四边泛洪求"连通背景"（保住白围裙），
  ② 按色相 60–200 / S≥0.08 整片清掉绿色残渣（角色身上没有绿色，所以安全）。

## 已知坑（都踩过）

1. **构建**：`npm run build` 会连带构建 standalone/settings-page 那份，Windows + pnpm 虚拟存储下
   rolldown 报 `Could not load C:Users\...\react\index.js (os error 3)`（盘符后少反斜杠）。
   → 只建需要的两份：`npx tsdown --config tsdown.local.mjs`（client + host）。
   `npm run build:desktop-core` 还缺 `valibot`，只有独立模式用得上，暂时跳过。
2. **pnpm 版本**：profile 里必须用 DSH 自带的那份（`C:\Users\lianzhi\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs`，v11.28.5），
   用系统 pnpm v10 会要求清空整个 node_modules（`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`）。
   它要求的 Node ≥22.13，所以配 DSH 自带 node（`...\dependencies\node\bin\node.exe`，v24.21.0）。
3. **沙箱**：工作区外的写入（`C:\Users\lianzhi\.dsh\...`）需要升级权限；`ProcessPoolExecutor` 会因
   命名管道被拒而 `WinError 5`；Chrome headless 同理不可用。
4. **PowerShell 读写中文**：`Get-Content -Raw | Set-Content` 会把 UTF-8 中文变乱码并破坏源码 → 改文件只用 write/edit。

## 下一步（用户确认后）

- 按 `cat-pet/替换动作指南.md` 的顺序继续出片：点击回应 2 条 → 哈欠/伸懒腰 → 东张西望 → 走路，再把它们加进 `main-config.jsonc` 的池子。
- 改插件内的角色名/文案/图标，作为二次开发版本推到用户自己的 GitHub（公开须附原作者地址
  https://github.com/PC2005-cloud/dsh-pet，见 `README.md:325`）。

## 附：ComfyUI「换角色重演」实验为什么放弃

- 环境：`F:\ComfyUI_windows_portable`（ComfyUI 0.43.0 / torch 2.14.1+cu130 / RTX 5070 Ti 16GB），
  模型 `Wan2.2-Fun-5B-Control-Q4_K_M.gguf`，用 `cat-pet/tools/run_wanhui.py` 提交 API 图。
- 试了 4 组：depth 21 步、depth end=0.65、DWPose、49 帧短段。每组 2.6–6.9 分钟。
- 结果一致：身份勉强保住，但脸糊、手成团块、**头两侧长出橘褐色「翅膀」**（官方片鲸尾/耳鳍的轮廓
  被当成结构信号）、约 20 帧后角色越来越大、末段背景泛浅绿。5B 量化版撑不起这种重演。
- 想要官方示例那种质量，得上 A14B fp8 + lightning LoRA（显存/下载都不止这点），性价比不如直接用
  可灵/豆包按提示词直出绿幕片。
