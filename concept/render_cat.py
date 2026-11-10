# -*- coding: utf-8 -*-
"""大肥橘猫 · 形象设定图（Pillow 绘制，扁平贴纸风，3 倍超采样）"""
import math
import os

from PIL import Image, ImageDraw, ImageFilter, ImageChops

SS = 3            # 超采样倍数
W, H = 900, 900   # 单只猫画布（输出像素）


def rgba(hexstr, a=255):
    hexstr = hexstr.lstrip("#")
    return (int(hexstr[0:2], 16), int(hexstr[2:4], 16), int(hexstr[4:6], 16), a)


FUR      = rgba("F3A64B")
FUR_DK   = rgba("E59033")
LINE     = rgba("A85820")
STRIPE   = rgba("C4661A")
CREAM    = rgba("FFF6E9")
CREAM_SD = rgba("F2DDC0")
PINK     = rgba("FFA9BC")
NOSE     = rgba("FF7E9D")
EYE      = rgba("3B2A21")
WHISKER  = rgba("B58455")
WHITE    = (255, 255, 255, 255)
BG       = rgba("FBF7F1")
SHADOW   = (0, 0, 0, 255)

LW = 10           # 描边宽度（输出像素）


def new_mask():
    return Image.new("L", (W * SS, H * SS), 0)


def dilate(mask, radius_px):
    r = max(1, int(round(radius_px * SS)))
    return mask.filter(ImageFilter.MaxFilter(2 * r + 1))


def part(canvas, mask, fill, lw=LW, line=LINE):
    canvas.paste(line, (0, 0), dilate(mask, lw))
    canvas.paste(fill, (0, 0), mask)


def smooth_profile(ctrl, t):
    if t <= ctrl[0][0]:
        return ctrl[0][1]
    if t >= ctrl[-1][0]:
        return ctrl[-1][1]
    for i in range(1, len(ctrl)):
        if t <= ctrl[i][0]:
            t0, w0 = ctrl[i - 1]
            t1, w1 = ctrl[i]
            u = (t - t0) / (t1 - t0)
            u = u * u * (3 - 2 * u)
            return w0 + (w1 - w0) * u
    return ctrl[-1][1]


def body_mask(cx, top, bot, profile, extra=None, scale=1.0):
    m = new_mask()
    d = ImageDraw.Draw(m)
    pts_l, pts_r = [], []
    steps = 120
    for i in range(steps + 1):
        t = i / steps
        y = top + (bot - top) * t
        hw = smooth_profile(profile, t) * scale * SS
        pts_l.append((cx - hw, y))
        pts_r.append((cx + hw, y))
    d.polygon(pts_l + pts_r[::-1], fill=255)
    if extra:
        extra(d)
    return m


def round_corner(pts, idx, r):
    """把 pts[idx] 这个尖角换成圆角折线"""
    n = len(pts)
    a, v, b = pts[(idx - 1) % n], pts[idx], pts[(idx + 1) % n]
    va, vb = (a[0] - v[0], a[1] - v[1]), (b[0] - v[0], b[1] - v[1])
    la, lb = math.hypot(*va) or 1, math.hypot(*vb) or 1
    r = min(r, la * 0.48, lb * 0.48)
    p1 = (v[0] + va[0] / la * r, v[1] + va[1] / la * r)
    p2 = (v[0] + vb[0] / lb * r, v[1] + vb[1] / lb * r)
    out = []
    for i in range(len(pts)):
        if i == idx:
            out.extend([p1, p2])
        else:
            out.append(pts[i])
    return out


def thick_line(mask, pts, width):
    d = ImageDraw.Draw(mask)
    w = int(width * SS)
    d.line([(x, y) for x, y in pts], fill=255, width=w, joint="curve")
    r = w / 2
    for (x, y) in (pts[0], pts[-1]):
        d.ellipse([x - r, y - r, x + r, y + r], fill=255)


def taper_curve(mask, pts, w0, w1, ease=1.0):
    """沿曲线画由粗到细的尾巴"""
    d = ImageDraw.Draw(mask)
    n = len(pts)
    for i, (x, y) in enumerate(pts):
        t = (i / (n - 1)) ** ease
        r = (w0 + (w1 - w0) * t) / 2 * SS
        d.ellipse([x - r, y - r, x + r, y + r], fill=255)


def bezier(p0, p1, p2, p3, n=120):
    out = []
    for i in range(n + 1):
        t = i / n
        mt = 1 - t
        x = mt ** 3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t ** 3 * p3[0]
        y = mt ** 3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t ** 3 * p3[1]
        out.append((x, y))
    return out


# ---------------- 站姿 ----------------
def standing():
    cv = Image.new("RGBA", (W * SS, H * SS), BG)
    s = SS
    cx = W / 2 * s
    gy = 826 * s

    # 地面投影
    sh = new_mask()
    ImageDraw.Draw(sh).ellipse([cx - 246 * s, gy + 4 * s, cx + 246 * s, gy + 42 * s], fill=72)
    cv.paste(SHADOW, (0, 0), sh.filter(ImageFilter.GaussianBlur(12 * s)))

    # 尾巴（身后，从臀部向右上卷）
    tail_pts = bezier((cx + 148 * s, gy - 100 * s), (cx + 292 * s, gy - 116 * s),
                      (cx + 302 * s, gy - 300 * s), (cx + 206 * s, gy - 352 * s))
    T0, T1 = 54.0, 34.0
    tm = new_mask()
    taper_curve(tm, tail_pts, T0, T1, 0.8)
    part(cv, tm, FUR)
    # 尾巴环纹（横切尾巴的短带）
    rings = new_mask()
    rd = ImageDraw.Draw(rings)
    N = len(tail_pts) - 1
    for f in (0.50, 0.68, 0.84):
        idx = int(f * N)
        x, y = tail_pts[idx]
        px, py = tail_pts[max(0, idx - 2)]
        nx, ny = tail_pts[min(N, idx + 2)]
        tx, ty = nx - px, ny - py
        ln = math.hypot(tx, ty) or 1
        ux, uy = -ty / ln, tx / ln
        hw = (T0 + (T1 - T0) * (f ** 0.8)) / 2 * 0.88 * s
        rd.line([(x - ux * hw, y - uy * hw), (x + ux * hw, y + uy * hw)],
                fill=255, width=int(15 * s))
    cv.paste(STRIPE, (0, 0), ImageChops.multiply(rings, tm))

    # 身体：肥梨形
    prof = [(0.00, 108), (0.05, 136), (0.14, 164), (0.30, 188),
            (0.50, 202), (0.70, 206), (0.86, 200), (1.00, 182)]
    def extra(d):
        # 底部圆润收口
        d.ellipse([cx - 186 * s, gy - 96 * s, cx + 186 * s, gy + 4 * s], fill=255)
    body = body_mask(cx, gy - 402 * s, gy - 8 * s, prof, extra=extra)
    part(cv, body, FUR)

    # 肚皮
    belly = new_mask()
    ImageDraw.Draw(belly).ellipse([cx - 136 * s, gy - 330 * s, cx + 136 * s, gy - 34 * s], fill=255)
    cv.paste(CREAM, (0, 0), ImageChops.multiply(belly, body))

    # 身体虎斑（裁在剪影内）
    st = new_mask()
    for sx in (-1, 1):
        thick_line(st, [(cx + sx * 198 * s, gy - 380 * s), (cx + sx * 152 * s, gy - 350 * s)], 22)
        thick_line(st, [(cx + sx * 206 * s, gy - 316 * s), (cx + sx * 160 * s, gy - 296 * s)], 22)
        thick_line(st, [(cx + sx * 208 * s, gy - 252 * s), (cx + sx * 166 * s, gy - 240 * s)], 20)
    cv.paste(STRIPE, (0, 0), ImageChops.multiply(st, body))

    # 前爪（贴地的两只小圆脚）
    for sx in (-1, 1):
        pm = new_mask()
        ImageDraw.Draw(pm).ellipse([cx + sx * 84 * s - 62 * s, gy - 60 * s,
                                    cx + sx * 84 * s + 62 * s, gy - 2 * s], fill=255)
        part(cv, pm, CREAM, 8)
        dd = ImageDraw.Draw(cv)
        for k in (-1, 1):
            x0 = cx + sx * 84 * s + k * 16 * s
            dd.line([(x0, gy - 38 * s), (x0, gy - 14 * s)], fill=CREAM_SD, width=int(6 * s))

    # 头
    hx = cx
    hr = 172 * s
    hy = gy - 402 * s - 116 * s

    # 耳朵（贴在头圆上的圆角三角）
    ears = new_mask()
    pink_m = new_mask()
    for sx in (-1, 1):
        def onc(a_deg, k):
            a = math.radians(a_deg)
            return (hx + sx * math.sin(a) * hr * k, hy - math.cos(a) * hr * k)
        tri = [onc(60, 0.99), onc(18, 0.99), onc(38, 1.42)]
        tri = round_corner(tri, 1, 24 * s)
        tri = round_corner(tri, 2, 24 * s)
        tri = round_corner(tri, 3, 26 * s)
        ImageDraw.Draw(ears).polygon(tri, fill=255)
        # 内耳粉色（缩到三角中心）
        gx = sum(p[0] for p in tri) / len(tri)
        gy2 = sum(p[1] for p in tri) / len(tri)
        inner = [(gx + (p[0] - gx) * 0.56, gy2 + (p[1] - gy2) * 0.62) for p in tri]
        ImageDraw.Draw(pink_m).polygon(inner, fill=255)
    part(cv, ears, FUR)
    cv.paste(PINK, (0, 0), ImageChops.multiply(pink_m, ears))

    hm = new_mask()
    ImageDraw.Draw(hm).ellipse([hx - hr, hy - hr * 0.97, hx + hr, hy + hr * 0.97], fill=255)
    part(cv, hm, FUR)

    d = ImageDraw.Draw(cv)
    # 额头虎斑
    for dx, w in [(-54, 13), (0, 14), (54, 13)]:
        d.line([(hx + dx * s, hy - 134 * s), (hx + dx * 0.5 * s, hy - 84 * s)], fill=STRIPE, width=int(w * s))
    # 腮红
    for sx in (-1, 1):
        d.ellipse([hx + sx * 132 * s - 36 * s, hy + 4 * s, hx + sx * 132 * s + 36 * s, hy + 38 * s],
                  fill=(255, 138, 158, 72))
    # 口鼻
    d.ellipse([hx - 86 * s, hy + 30 * s, hx + 86 * s, hy + 116 * s], fill=CREAM)
    # 眼睛
    for sx in (-1, 1):
        ex, ey = hx + sx * 74 * s, hy - 4 * s
        d.ellipse([ex - 37 * s, ey - 45 * s, ex + 37 * s, ey + 45 * s], fill=EYE)
        d.ellipse([ex + 5 * s, ey - 35 * s, ex + 25 * s, ey - 11 * s], fill=WHITE)
        d.ellipse([ex - 21 * s, ey + 9 * s, ex - 7 * s, ey + 23 * s], fill=(255, 255, 255, 205))
    # 鼻子 + 嘴
    d.polygon([(hx, hy + 26 * s), (hx - 19 * s, hy + 50 * s), (hx + 19 * s, hy + 50 * s)], fill=NOSE)
    d.arc([hx - 34 * s, hy + 42 * s, hx + 2 * s, hy + 84 * s], start=15, end=150, fill=EYE, width=int(6 * s))
    d.arc([hx - 2 * s, hy + 42 * s, hx + 34 * s, hy + 84 * s], start=30, end=165, fill=EYE, width=int(6 * s))
    # 胡须（不超出脸太多）
    for sx in (-1, 1):
        for dy0, dy1 in [(-4, -18), (12, 14), (28, 42)]:
            d.line([(hx + sx * 88 * s, hy + (58 + dy0) * s), (hx + sx * 160 * s, hy + (58 + dy1) * s)],
                   fill=WHISKER, width=int(5 * s))
    return cv


def finish(cv, out_w, out_h):
    return cv.resize((out_w, out_h), Image.LANCZOS)


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    img = finish(standing(), W, H)
    img.save(os.path.join(here, "cat-standing.png"))
    print("ok", img.size)
