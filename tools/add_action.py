"""一条命令把「绿幕视频」变成「桌宠可用的透明动画」并部署。

典型用法（在仓库根目录 C:\\Users\\lianzhi\\Documents\\deepseek-harness\\default-workspace 下跑）：

    py -3 cat-pet\\tools\\add_action.py "C:\\Users\\lianzhi\\Downloads\\新动作.mp4" --name 点击回应-元气挥手

做的事（和手工流程完全一致，只是串起来）：
    1) key_v2.py   —— 抠掉背景，得到透明 webm（含 despill，边缘不发绿）
    2) place_webm.py —— 统一缩放/居中/脚底对齐，得到 2160×1215 母版
    3) encode_thumbs.py —— 压成 640×360 的播放变体
    4) 拷贝到 %DSH_HOME%\\dsh-pet\\main-animation\\webm\\<名字>.webm

注意：
    * --name 必须和商店/配置里的动作名**完全一致**（中文名、不要带扩展名），否则插件找不到文件。
    * 新动作名如果不在配置里，重开 DSH 后还要把它写进 main-config.jsonc 的对应池子才会被触发。
    * 视频必须是纯色背景（绿幕最佳）。有平台水印就加 --mask x1,y1,x2,y2 框住它。
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent  # default-workspace
PY = sys.executable
FFMPEG = ROOT / "dsh-pet" / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / "ffmpeg.exe"
DSH_HOME = Path(os.environ.get("DSH_HOME", str(Path.home() / ".dsh")))
DEPLOY_DIR = DSH_HOME / "dsh-pet" / "main-animation" / "webm"


def run(cmd: list[str]) -> None:
    print("\n$", " ".join(str(c) for c in cmd), flush=True)
    proc = subprocess.run([str(c) for c in cmd], cwd=str(ROOT))
    if proc.returncode != 0:
        raise SystemExit(f"上一步失败（exit {proc.returncode}），已停止。")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("video", help="绿幕源视频（mp4/mov 都行）")
    ap.add_argument("--name", required=True, help="动作名，必须与配置里的名字完全一致")
    ap.add_argument("--mask", action="append", default=[], help="遮掉水印的矩形 x1,y1,x2,y2，可重复")
    ap.add_argument("--scale", default="1.664612", help="统一缩放系数，默认与待机动作一致")
    ap.add_argument("--blend", default="8", help="尾部 N 帧向首帧混合，抹平循环接缝；不需要就写 0")
    ap.add_argument("--min-row", default="80", help="判定主体的每行最少不透明像素数")
    ap.add_argument("--no-deploy", action="store_true", help="只生成，不复制到 DSH 目录")
    args = ap.parse_args()

    src = Path(args.video)
    if not src.exists():
        raise SystemExit(f"找不到视频：{src}")
    if not FFMPEG.exists():
        raise SystemExit(f"找不到 ffmpeg：{FFMPEG}")

    out_dir = ROOT / "cat-pet" / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    keyed = out_dir / f"{args.name}-keyed.webm"
    master = ROOT / "dsh-pet" / "step03" / f"{args.name}.webm"

    key_cmd = [PY, HERE / "key_v2.py", src, "--webm", keyed, "--blend", args.blend]
    for m in args.mask:
        key_cmd += ["--mask-box", m]
    run(key_cmd)

    run([PY, HERE / "place_webm.py", keyed, "--out", master,
         "--scale", args.scale, "--min-row", args.min_row])
    run([PY, ROOT / "cat-pet" / "tools" / "run_script_serial.py",
         ROOT / "dsh-pet" / "scripts" / "encode_thumbs.py"])

    thumb = ROOT / "dsh-pet" / "step04" / f"{args.name}.webm"
    if not thumb.exists():
        raise SystemExit(f"没有生成播放变体：{thumb}")
    if args.no_deploy:
        print(f"\n已生成（未部署）：{thumb}")
        return 0

    DEPLOY_DIR.mkdir(parents=True, exist_ok=True)
    target = DEPLOY_DIR / f"{args.name}.webm"
    shutil.copy2(thumb, target)
    print(f"\n已部署：{target}（{target.stat().st_size} 字节）")
    print("下一步：重开 DSH（或重启桌宠插件），新动作才会生效。")
    print("如果这是全新动作名：记得在 main-config.jsonc 的对应池子里加上它。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
