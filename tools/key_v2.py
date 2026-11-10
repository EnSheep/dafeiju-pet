"""key_v2.py —— 绿幕 → 透明 alpha（v2，带去溢色 despill / 纯绿重打板）

相对 v1（mp4_to_alpha_webm.py）的改动：
  1. alpha 在**全分辨率**用「与背景色的软距离」算，不再依赖 1/4 分辨率的形态学上下采样 → 边缘更细（发丝能留住）；
  2. 增加 **despill**：按 C = a·F + (1−a)·G 反解前景 F，把边缘残留的绿色抠掉（v1 边缘有一圈绿边）；
  3. 增加 `--plate` 输出：把抠好的角色重新合成到**纯绿 #00FF00** 上，得到一张干净的绿幕片（给别的抠像器 / ComfyUI / 剪辑软件用）。

用法：
  python key_v2.py <in.mp4> --webm out.webm [--plate out.mp4] [--size 1280x720] [--fps 24]
                          [--feather 8,26] [--green-key 60,200,0.08] [--blend 8] [--preview out.png]
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

FFMPEG = Path(__file__).resolve().parents[2] / "dsh-pet" / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / "ffmpeg.exe"
PURE_GREEN = np.array([0, 255, 0], np.float32)


def probe_size(src: Path) -> tuple[int, int, int]:
    """读源视频的宽高与帧率（不依赖 ffprobe 的输出格式细节，失败就按 24fps/1280x720 兜底）。"""
    ffprobe = FFMPEG.with_name("ffprobe.exe")
    r = subprocess.run([str(ffprobe), "-v", "error", "-select_streams", "v:0",
                        "-show_entries", "stream=width,height,r_frame_rate", "-of", "csv=p=0", str(src)],
                       capture_output=True, text=True)
    try:
        w, h, rate = r.stdout.strip().split(",")[:3]
        num, den = rate.split("/")
        return int(w), int(h), round(int(num) / int(den))
    except Exception:
        return 1280, 720, 24


def read_frames(src: Path, w: int, h: int, fps: int):
    cmd = [str(FFMPEG), "-hide_banner", "-loglevel", "error", "-i", str(src),
           "-vf", f"scale={w}:{h}:flags=lanczos", "-r", str(fps),
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    size = w * h * 3
    try:
        while True:
            buf = p.stdout.read(size)
            if len(buf) < size:
                break
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    finally:
        p.stdout.close()
        p.wait()


def border_bg(rgb: np.ndarray) -> np.ndarray:
    """用画面外圈若干像素的中位数估计背景色。"""
    b = np.concatenate([rgb[0:6].reshape(-1, 3), rgb[-6:].reshape(-1, 3),
                        rgb[:, 0:6].reshape(-1, 3), rgb[:, -6:].reshape(-1, 3)])
    return np.median(b, axis=0).astype(np.float32)


def rgb_to_hsv(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    x = rgb.astype(np.float32) / 255.0
    r, g, b = x[..., 0], x[..., 1], x[..., 2]
    mx = x.max(axis=2)
    mn = x.min(axis=2)
    diff = mx - mn
    h = np.zeros_like(mx)
    mask = diff > 1e-6
    rmask = mask & (mx == r)
    gmask = mask & (mx == g) & ~rmask
    bmask = mask & (mx == b) & ~rmask & ~gmask
    with np.errstate(divide="ignore", invalid="ignore"):
        h[rmask] = (60 * ((g[rmask] - b[rmask]) / diff[rmask])) % 360
        h[gmask] = 60 * ((b[gmask] - r[gmask]) / diff[gmask]) + 120
        h[bmask] = 60 * ((r[bmask] - g[bmask]) / diff[bmask]) + 240
    s = np.where(mx > 1e-6, diff / np.maximum(mx, 1e-6), 0.0)
    return h, s, mx


def make_alpha(rgb: np.ndarray, bg: np.ndarray, feather: tuple[float, float],
               green_key: tuple[float, float, float] | None) -> np.ndarray:
    """软抠像：与背景色的最大通道差 → 0..1 的 alpha 斜坡；再按色相清掉绿幕残渣。"""
    t0, t1 = feather
    d = np.abs(rgb.astype(np.float32) - bg).max(axis=2)
    a = np.clip((d - t0) / max(t1 - t0, 1e-6), 0.0, 1.0)
    if green_key is not None:
        hmin, hmax, smin = green_key
        h, s, v = rgb_to_hsv(rgb)
        residue = (h >= hmin) & (h <= hmax) & (s >= smin) & (v > 0.02)
        a = np.where(residue, 0.0, a)
    # 3x3 中值去掉孤立噪点（水印小点、压缩噪点），再做一次轻微平滑保住发丝
    a8 = (a * 255).astype(np.uint8)
    a8 = np.array(Image.fromarray(a8).filter(ImageFilter_median()))
    return a8


def ImageFilter_median():
    from PIL import ImageFilter
    return ImageFilter.MedianFilter(3)


def despill(rgb: np.ndarray, alpha: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """反解前景色：C = a·F + (1−a)·G → F = (C − (1−a)·G)/a，边缘不再带绿边。"""
    f = rgb.astype(np.float32)
    a = (alpha.astype(np.float32) / 255.0)[..., None]
    safe = np.maximum(a, 0.10)
    out = (f - (1.0 - a) * bg) / safe
    out = np.clip(out, 0, 255)
    # 只对半透明边缘生效，实心区域保持原色（避免整体色偏）
    solid = a > 0.92
    out = np.where(solid, f, out)
    # 残余溢色限制：绿通道不许明显超过红/蓝通道
    g_cap = np.maximum(out[..., 0], out[..., 2]) + 6
    out[..., 1] = np.minimum(out[..., 1], g_cap)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--webm", default=None, help="输出透明 webm（VP9-alpha）")
    ap.add_argument("--plate", default=None, help="输出纯绿幕 mp4（#00FF00 背景）")
    ap.add_argument("--size", default=None, help="默认取源视频尺寸")
    ap.add_argument("--fps", type=int, default=None)
    ap.add_argument("--feather", default="8,26", help="alpha 斜坡：完全透明/完全不透明 的颜色差阈值")
    ap.add_argument("--green-key", default="60,200,0.08", help="色相残渣清理 Hmin,Hmax,Smin；none 关闭")
    ap.add_argument("--crf", type=int, default=28)
    ap.add_argument("--blend", type=int, default=8, help="尾部 N 帧向首部混合，抹平循环接缝")
    ap.add_argument("--preview", default=None, help="导出一张 PNG（叠在深灰底上，检查边缘）")
    ap.add_argument("--mask-box", action="append", default=None,
                    help="清空某一矩形区域的 alpha，格式 x1,y1,x2,y2（可重复；用于抹掉角标水印）")
    a = ap.parse_args()

    src = Path(a.src)
    sw, sh, sfps = probe_size(src)
    w, h = (int(x) for x in a.size.lower().split("x")) if a.size else (1280, 720)
    fps = a.fps or sfps or 24
    t0, t1 = (float(x) for x in a.feather.split(","))
    green = None if a.green_key.lower() == "none" else tuple(float(x) for x in a.green_key.split(","))
    boxes = []
    for raw in a.mask_box or []:
        x1, y1, x2, y2 = (int(round(float(v))) for v in raw.replace("x", ",").split(","))
        boxes.append((max(0, x1), max(0, y1), min(w, x2), min(h, y2)))

    encoders: dict[str, subprocess.Popen] = {}
    if a.webm:
        Path(a.webm).parent.mkdir(parents=True, exist_ok=True)
        encoders["webm"] = subprocess.Popen(
            [str(FFMPEG), "-y", "-hide_banner", "-loglevel", "error",
             "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
             "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-crf", str(a.crf), "-b:v", "0",
             "-auto-alt-ref", "0", "-deadline", "good", "-cpu-used", "4", "-row-mt", "1",
             "-an", str(a.webm)], stdin=subprocess.PIPE)
    if a.plate:
        Path(a.plate).parent.mkdir(parents=True, exist_ok=True)
        encoders["plate"] = subprocess.Popen(
            [str(FFMPEG), "-y", "-hide_banner", "-loglevel", "error",
             "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
             "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p",
             "-an", str(a.plate)], stdin=subprocess.PIPE)

    bg = None
    head: list[tuple[np.ndarray, np.ndarray]] = []   # 首部 N 帧（供尾部混合）
    tail: list[tuple[np.ndarray, np.ndarray]] = []   # 尚未吐出的帧（始终最多 N 帧）
    n = 0
    for rgb in read_frames(src, w, h, fps):
        if bg is None:
            bg = border_bg(rgb)
        alpha = make_alpha(rgb, bg, (t0, t1), green)
        if boxes:
            alpha = alpha.copy()
            for x1, y1, x2, y2 in boxes:
                alpha[y1:y2, x1:x2] = 0
        fg = despill(rgb, alpha, bg)
        if a.preview and n == int(fps * 3.5):
            _save_preview(fg, alpha, Path(a.preview))
        if n < a.blend:
            head.append((fg, alpha))
        tail.append((fg, alpha))
        if len(tail) > a.blend:
            _emit(encoders, *tail.pop(0), w, h)
        n += 1

    # 尾部 K 帧向首部 K 帧混合
    for i, (fg, alpha) in enumerate(tail):
        if a.blend and i < len(head):
            t = (i + 1) / len(head)
            fg2, alpha2 = head[i]
            fg = fg * (1 - t) + fg2 * t
            alpha = (alpha.astype(np.float32) * (1 - t) + alpha2.astype(np.float32) * t)
        _emit(encoders, fg, alpha, w, h)

    rc = 0
    for name, p in encoders.items():
        p.stdin.close()
        rc |= p.wait()
        print(f"{name}: {getattr(a, name)}")
    print(f"frames={n} bg={tuple(int(x) for x in bg)}")
    return rc


def _emit(encoders, fg: np.ndarray, alpha, w: int, h: int) -> None:
    a8 = np.asarray(alpha, dtype=np.float32)
    if a8.ndim == 3:
        a8 = a8[..., 0]
    a8 = np.clip(a8, 0, 255).astype(np.uint8)
    if "webm" in encoders:
        encoders["webm"].stdin.write(np.dstack([np.clip(fg, 0, 255).astype(np.uint8), a8]).tobytes())
    if "plate" in encoders:
        a = (a8.astype(np.float32) / 255.0)[..., None]
        plate = fg * a + PURE_GREEN * (1.0 - a)
        encoders["plate"].stdin.write(np.clip(plate, 0, 255).astype(np.uint8).tobytes())


def _save_preview(fg: np.ndarray, alpha, path: Path) -> None:
    a8 = np.asarray(alpha, dtype=np.float32)
    if a8.ndim == 3:
        a8 = a8[..., 0]
    a = np.clip(a8, 0, 255).astype(np.uint8)
    rgb = np.clip(fg, 0, 255).astype(np.uint8)
    # 棋盘格（深灰/浅灰）衬底，方便看边缘
    h, w = a.shape
    yy, xx = np.mgrid[0:h, 0:w]
    checker = np.where(((yy // 16) + (xx // 16)) % 2 == 0, 58, 86).astype(np.float32)
    base = np.dstack([checker] * 3)
    af = (a.astype(np.float32) / 255.0)[..., None]
    out = rgb.astype(np.float32) * af + base * (1 - af)
    Image.fromarray(out.astype(np.uint8)).save(path)
    # 同时存 alpha 与 plate 便于肉眼比对
    Image.fromarray(a).save(path.with_name(path.stem + "-alpha.png"))
    plate = rgb.astype(np.float32) * af + PURE_GREEN * (1 - af)
    Image.fromarray(np.clip(plate, 0, 255).astype(np.uint8)).save(path.with_name(path.stem + "-plate.png"))


if __name__ == "__main__":
    sys.exit(main())
