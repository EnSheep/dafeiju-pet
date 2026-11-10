"""mp4（纯色/白底）→ VP9-alpha webm（1280x720@24），替代仓库的 step01+step02。

为什么不用 chroma_step02.py：它的判定是「绿色色相 70°-170°」，白底不会被判为背景，
而且角色的白围裙/白蕾丝会被白键控误伤。这里改用「从边框连通的背景泛洪」：
只有和画面四边连通的近背景色像素才算背景，被深色裙子围住的白色围裙不会被吃掉。

用法：
  python mp4_to_alpha_webm.py <in.mp4> <out.webm> [--tol 14] [--fps 24] [--size 1280x720]
                              [--blend 8] [--matte-preview out.png]
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

FFMPEG = Path(r"C:\Users\lianzhi\Documents\deepseek-harness\default-workspace\dsh-pet\.tools\ffmpeg-9.0.1-essentials_build\bin\ffmpeg.exe")


def read_frames(src: Path, w: int, h: int, fps: int):
    cmd = [str(FFMPEG), "-hide_banner", "-loglevel", "error", "-i", str(src),
           "-vf", f"scale={w}:{h}:flags=lanczos", "-r", str(fps),
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    size = w * h * 3
    while True:
        buf = p.stdout.read(size)
        if len(buf) < size:
            break
        yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    p.stdout.close()
    p.wait()


def _dilate(mask: Image.Image, n: int = 1) -> Image.Image:
    for _ in range(n):
        mask = mask.filter(ImageFilter.MaxFilter(3))
    return mask


def bg_connected_mask(rgb: np.ndarray, tol: float) -> np.ndarray:
    """从四边泛洪，返回「与边框连通的背景」布尔掩码。"""
    h, w, _ = rgb.shape
    border = np.concatenate([rgb[0:2].reshape(-1, 3), rgb[-2:].reshape(-1, 3),
                             rgb[:, 0:2].reshape(-1, 3), rgb[:, -2:].reshape(-1, 3)])
    bg = np.median(border, axis=0)
    dist = np.abs(rgb.astype(np.int16) - bg).max(axis=2)
    cand = dist <= tol

    # 1/4 分辨率上做连通泛洪（PIL 形态学，比纯 Python BFS 快得多）
    sw, sh = w // 4, h // 4
    small = Image.fromarray((cand * 255).astype(np.uint8)).resize((sw, sh), Image.NEAREST)
    arr = np.array(small) > 127
    seed = np.zeros_like(arr)
    seed[0, :] = arr[0, :]
    seed[-1, :] = arr[-1, :]
    seed[:, 0] = arr[:, 0]
    seed[:, -1] = arr[:, -1]
    cur = Image.fromarray((seed * 255).astype(np.uint8))
    cand_img = Image.fromarray((arr * 255).astype(np.uint8))
    for _ in range(200):
        nxt = Image.fromarray((np.array(_dilate(cur, 1)) + np.zeros((sh, sw), np.uint8)).astype(np.uint8))
        merged = Image.fromarray((np.minimum(np.array(nxt), np.array(cand_img))).astype(np.uint8))
        if np.array_equal(np.array(merged), np.array(cur)):
            cur = merged
            break
        cur = merged
    filled = np.array(cur) > 127
    big = Image.fromarray((filled * 255).astype(np.uint8)).resize((w, h), Image.BILINEAR)
    return np.array(big) > 100


def rgb_to_hsv(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """向量化 RGB→HSV（H 单位度，S/V 0-1），避免逐像素调 colorsys。"""
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
    h[rmask] = (60 * ((g[rmask] - b[rmask]) / diff[rmask])) % 360
    h[gmask] = 60 * ((b[gmask] - r[gmask]) / diff[gmask]) + 120
    h[bmask] = 60 * ((r[bmask] - g[bmask]) / diff[bmask]) + 240
    s = np.where(mx > 1e-6, diff / np.maximum(mx, 1e-6), 0.0)
    return h, s, mx


def build_alpha(rgb: np.ndarray, tol: float, green: tuple[float, float, float] | None = None) -> np.ndarray:
    bgm = bg_connected_mask(rgb, tol)
    alpha = np.where(bgm, 0.0, 1.0)

    # 绿幕残渣清理：原片的背景是「绿豆沙绿」(≈#8AB060)，地面阴影和水印是同一色相的
    # 更暗/更淡版本，颜色距离法会把它们留在 alpha 里（桌面上一块绿斑）。
    # 角色身上没有任何绿/青色像素，所以按色相整片清掉是安全的。
    if green is not None:
        hmin, hmax, smin = green
        h, s, v = rgb_to_hsv(rgb)
        in_hue = (h >= hmin) & (h <= hmax)
        key = in_hue & (s >= smin) & (v > 0.04)
        alpha = np.where(key, 0.0, alpha)

    a_img = Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8))
    return np.array(a_img)


def write_webm(frames, out: Path, w: int, h: int, fps: int, crf: int, tol: float, blend: int,
               matte_preview: Path | None, green: tuple[float, float, float] | None = None):
    cmd = [str(FFMPEG), "-y", "-hide_banner", "-loglevel", "error",
           "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
           "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-crf", str(crf), "-b:v", "0",
           "-auto-alt-ref", "0", "-deadline", "good", "-cpu-used", "4", "-row-mt", "1",
           "-an", str(out)]
    enc = subprocess.Popen(cmd, stdin=subprocess.PIPE)

    cache: list[np.ndarray] = []
    head: list[np.ndarray] = []
    n = 0
    first_frames: list[np.ndarray] = []
    for rgb in frames:
        a = build_alpha(rgb, tol, green)
        rgba = np.dstack([rgb, a]).astype(np.uint8)
        cache.append(rgba)
        if n < blend:
            head.append(rgba.astype(np.float32))
        n += 1
        if len(cache) > blend:
            enc.stdin.write(cache.pop(0).tobytes())
            cache_idx = n - len(cache) - 1
            if matte_preview and cache_idx == 0:
                Image.fromarray(a).save(matte_preview)
        if len(first_frames) < 2:
            first_frames.append(rgba)

    # 尾部 K 帧向首部 K 帧线性混合，抹平循环接缝
    for i, tail in enumerate(cache):
        if blend and i < len(head):
            t = (i + 1) / len(head)
            mixed = tail.astype(np.float32) * (1 - t) + head[i] * t
            enc.stdin.write(mixed.astype(np.uint8).tobytes())
        else:
            enc.stdin.write(tail.tobytes())

    enc.stdin.close()
    rc = enc.wait()
    if rc != 0:
        raise SystemExit(f"encoder failed rc={rc}")
    return n


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--tol", type=float, default=14.0)
    ap.add_argument("--fps", type=int, default=24)
    ap.add_argument("--size", default="1280x720")
    ap.add_argument("--crf", type=int, default=30)
    ap.add_argument("--blend", type=int, default=8, help="尾部与首部混合的帧数，0=不做")
    ap.add_argument("--matte-preview", default=None)
    ap.add_argument("--green-key", default="60,200,0.08",
                    help="绿幕色相清理：Hmin,Hmax,Smin（默认清掉绿豆沙色相的阴影/水印残渣；none 关闭）")
    a = ap.parse_args()
    w, h = (int(x) for x in a.size.lower().split("x"))
    dst = Path(a.dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    green = None
    if a.green_key.lower() != "none":
        hmin, hmax, smin = (float(x) for x in a.green_key.split(","))
        green = (hmin, hmax, smin)
    n = write_webm(read_frames(Path(a.src), w, h, a.fps), dst, w, h, a.fps, a.crf, a.tol,
                   a.blend, Path(a.matte_preview) if a.matte_preview else None, green)
    print(f"OK {dst} frames={n} size={dst.stat().st_size/1e6:.2f}MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
