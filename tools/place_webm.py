"""place_webm.py —— 把抠好的透明 webm 摆到 2160×1215 母版画布上（替代 normalize_step03）

为什么不用官方 normalize_step03：
  它用「最上方不透明像素」量角色身高，遇到 Zzz 气泡、星星之类飘在上方的特效，
  会把特效也算进身高 → 角色被缩得很小。这里改成「按行统计不透明像素数」找主体：
  只认那些一行里有 ≥ --min-row 个不透明像素的行（气泡每行只有十几二十个像素，会被排除）。

摆放规则：
  缩放一律用 --scale（默认沿用待机动画实测的 1.664612），保证各条动画的**相对大小**一致；
  脚底对齐 FEET_Y，水平按主体包围盒中心对齐画布中心。

用法：
  python place_webm.py in.webm --out out.webm [--scale 1.664612] [--canvas 2160x1215]
                              [--feet-y 1115] [--min-row 80]
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import numpy as np

FFMPEG = Path(__file__).resolve().parents[2] / "dsh-pet" / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / "ffmpeg.exe"


def probe_size(src: Path) -> tuple[int, int, int]:
    ffprobe = FFMPEG.with_name("ffprobe.exe")
    r = subprocess.run(
        [str(ffprobe), "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate", "-of", "csv=p=0", str(src)],
        capture_output=True, text=True,
    )
    try:
        w, h, rate = r.stdout.strip().split(",")[:3]
        num, den = rate.split("/")
        return int(w), int(h), round(int(num) / int(den))
    except Exception:
        return 1280, 720, 24


def read_alpha(src: Path, w: int, h: int):
    """只读 alpha 通道（用 libvpx 解码才有 alpha）。"""
    cmd = [str(FFMPEG), "-hide_banner", "-loglevel", "error", "-c:v", "libvpx-vp9",
           "-i", str(src), "-f", "rawvideo", "-pix_fmt", "rgba", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    size = w * h * 4
    try:
        while True:
            buf = p.stdout.read(size)
            if len(buf) < size:
                break
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 4)[..., 3]
    finally:
        p.stdout.close()
        p.wait()


def measure(src: Path, w: int, h: int, min_row: int, stride: int) -> dict:
    tops, bots, centers = [], [], []
    for i, a in enumerate(read_alpha(src, w, h)):
        if i % stride:
            continue
        rows = (a > 16).sum(axis=1)
        body = np.where(rows >= min_row)[0]
        if body.size == 0:
            continue
        top, bot = int(body[0]), int(body[-1])
        band = a[top:bot + 1] > 16
        cols = np.where(band.any(axis=0))[0]
        if cols.size == 0:
            continue
        tops.append(top)
        bots.append(bot)
        centers.append((int(cols[0]) + int(cols[-1])) / 2)
    if not bots:
        raise RuntimeError(f"没找到主体像素：{src}")
    return {
        "top": float(np.median(tops)),
        "bottom": float(np.median(bots)),
        "center_x": float(np.median(centers)),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--out", required=True)
    ap.add_argument("--scale", type=float, default=1.664612)
    ap.add_argument("--canvas", default="2160x1215")
    ap.add_argument("--feet-y", type=int, default=None, help="默认画布高 - 100")
    ap.add_argument("--fps", type=int, default=None)
    ap.add_argument("--min-row", type=int, default=80, help="判定主体行所需的最少不透明像素数")
    ap.add_argument("--stride", type=int, default=6, help="每隔 N 帧测量一次")
    ap.add_argument("--crf", type=int, default=28)
    a = ap.parse_args()

    src = Path(a.src)
    sw, sh, sfps = probe_size(src)
    fps = a.fps or sfps or 24
    cw, ch = (int(x) for x in a.canvas.lower().split("x"))
    feet_y = a.feet_y if a.feet_y is not None else ch - 100

    m = measure(src, sw, sh, a.min_row, a.stride)
    scale = a.scale
    scaled_w = int(sw * scale) // 2 * 2
    scaled_h = int(sh * scale) // 2 * 2
    overlay_x = cw / 2 - m["center_x"] * scale
    overlay_y = feet_y - m["bottom"] * scale

    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    flt = (
        f"color=c=black@0:s={cw}x{ch}:r={fps}[bg];"
        f"[0:v]scale={scaled_w}:{scaled_h}[sc];"
        f"[bg][sc]overlay={overlay_x:.1f}:{overlay_y:.1f}:shortest=1,format=yuva420p[v]"
    )
    cmd = [str(FFMPEG), "-y", "-hide_banner", "-loglevel", "error", "-c:v", "libvpx-vp9",
           "-i", str(src), "-filter_complex", flt, "-map", "[v]",
           "-c:v", "libvpx-vp9", "-crf", str(a.crf), "-b:v", "0",
           "-auto-alt-ref", "0", "-deadline", "good", "-cpu-used", "4", "-an", a.out]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        print(r.stderr[-2000:])
        return r.returncode
    print(f"{a.out}\n  主体 top={m['top']:.0f} bottom={m['bottom']:.0f} center_x={m['center_x']:.0f}"
          f" | scale={scale} overlay=({overlay_x:.1f},{overlay_y:.1f}) canvas={cw}x{ch}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
