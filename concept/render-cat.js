// 大肥橘猫 · 形象设定图渲染器 v2（无依赖：自绘光栅 + 蒙版描边 + 自写 PNG）
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const SS = 3;
const ZOOM = process.env.DSH_CAT_ZOOM === '1';

const C = {
  fur:      [244, 166, 78],
  furDark:  [229, 143, 55],
  line:     [178, 92, 32],
  stripe:   [200, 104, 28],
  cream:    [255, 246, 232],
  creamSd:  [246, 224, 194],
  pink:     [255, 168, 182],
  nose:     [255, 132, 156],
  eye:      [58, 42, 34],
  white:    [255, 255, 255],
  bg:       [251, 247, 241],
  shadow:   [0, 0, 0],
  whisker:  [178, 128, 80],
};

class Canvas {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      this.d[o] = C.bg[0]; this.d[o + 1] = C.bg[1]; this.d[o + 2] = C.bg[2]; this.d[o + 3] = 255;
    }
    this.clip = null;
  }
  blend(x, y, col, a) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    if (this.clip && !this.clip.d[y * this.w + x]) return;
    const i = (y * this.w + x) * 4, d = this.d, ia = 1 - a;
    d[i] = col[0] * a + d[i] * ia;
    d[i + 1] = col[1] * a + d[i + 1] * ia;
    d[i + 2] = col[2] * a + d[i + 2] * ia;
  }
  ellipse(cx, cy, rx, ry, col, alpha = 1) {
    const R = Math.max(rx, ry) + 2;
    for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y++) {
      for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++) {
        const dx = (x - cx) / rx, dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.blend(x, y, col, alpha);
      }
    }
  }
  capsule(x1, y1, x2, y2, r, col, alpha = 1) {
    const minx = Math.floor(Math.min(x1, x2) - r), maxx = Math.ceil(Math.max(x1, x2) + r);
    const miny = Math.floor(Math.min(y1, y2) - r), maxy = Math.ceil(Math.max(y1, y2) + r);
    const vx = x2 - x1, vy = y2 - y1, len2 = vx * vx + vy * vy || 1;
    for (let y = miny; y <= maxy; y++) {
      for (let x = minx; x <= maxx; x++) {
        let t = ((x - x1) * vx + (y - y1) * vy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = x - (x1 + vx * t), dy = y - (y1 + vy * t);
        if (dx * dx + dy * dy <= r * r) this.blend(x, y, col, alpha);
      }
    }
  }
  poly(pts, col, alpha = 1) {
    let miny = Infinity, maxy = -Infinity;
    for (const p of pts) { if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1]; }
    for (let y = Math.floor(miny); y <= Math.ceil(maxy); y++) {
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        for (let x = Math.ceil(xs[i]); x <= Math.floor(xs[i + 1]); x++) this.blend(x, y, col, alpha);
      }
    }
  }
  curve(pts, r, col, alpha = 1) {
    for (let i = 0; i + 2 < pts.length; i += 2) {
      const [p0, p1, p2] = [pts[i], pts[i + 1], pts[i + 2]];
      let prev = p0;
      for (let s = 1; s <= 24; s++) {
        const t = s / 24, mt = 1 - t;
        const cur = [mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0], mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1]];
        this.capsule(prev[0], prev[1], cur[0], cur[1], r, col, alpha);
        prev = cur;
      }
    }
  }
}

// ---------- 蒙版：一个部件一个剪影，统一定稿描边 ----------
class Mask {
  constructor(w, h) { this.w = w; this.h = h; this.d = new Uint8Array(w * h); this.x0 = 1e9; this.y0 = 1e9; this.x1 = -1; this.y1 = -1; }
  set(x, y) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.d[y * this.w + x] = 1;
    if (x < this.x0) this.x0 = x; if (x > this.x1) this.x1 = x;
    if (y < this.y0) this.y0 = y; if (y > this.y1) this.y1 = y;
  }
  ellipse(cx, cy, rx, ry) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / rx, dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.set(x, y);
      }
    }
  }
  capsule(x1, y1, x2, y2, r) {
    const vx = x2 - x1, vy = y2 - y1, len2 = vx * vx + vy * vy || 1;
    const minx = Math.floor(Math.min(x1, x2) - r), maxx = Math.ceil(Math.max(x1, x2) + r);
    const miny = Math.floor(Math.min(y1, y2) - r), maxy = Math.ceil(Math.max(y1, y2) + r);
    for (let y = miny; y <= maxy; y++) {
      for (let x = minx; x <= maxx; x++) {
        let t = ((x - x1) * vx + (y - y1) * vy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = x - (x1 + vx * t), dy = y - (y1 + vy * t);
        if (dx * dx + dy * dy <= r * r) this.set(x, y);
      }
    }
  }
  poly(pts) {
    let miny = Infinity, maxy = -Infinity;
    for (const p of pts) { if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1]; }
    for (let y = Math.floor(miny); y <= Math.ceil(maxy); y++) {
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        for (let x = Math.ceil(xs[i]); x <= Math.floor(xs[i + 1]); x++) this.set(x, y);
      }
    }
  }
  curve(pts, r) {
    for (let i = 0; i + 2 < pts.length; i += 2) {
      const [p0, p1, p2] = [pts[i], pts[i + 1], pts[i + 2]];
      let prev = p0;
      for (let s = 1; s <= 24; s++) {
        const t = s / 24, mt = 1 - t;
        const cur = [mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0], mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1]];
        this.capsule(prev[0], prev[1], cur[0], cur[1], r);
        prev = cur;
      }
    }
  }
  has(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h && this.d[y * this.w + x] === 1; }
}

// 画一个部件：先填色，再在剪影外侧描边
function paint(cv, m, fill, lw) {
  if (m.x1 < 0) return;
  const x0 = Math.max(0, m.x0 - lw - 1), x1 = Math.min(cv.w - 1, m.x1 + lw + 1);
  const y0 = Math.max(0, m.y0 - lw - 1), y1 = Math.min(cv.h - 1, m.y1 + lw + 1);
  const offs = [];
  const N = 16;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    offs.push([Math.cos(a) * lw, Math.sin(a) * lw]);
    offs.push([Math.cos(a) * lw * 0.55, Math.sin(a) * lw * 0.55]);
  }
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (m.d[y * m.w + x]) { cv.blend(x, y, fill, 1); continue; }
      let hit = false;
      for (let k = 0; k < offs.length; k++) {
        if (m.has((x + offs[k][0]) | 0, (y + offs[k][1]) | 0)) { hit = true; break; }
      }
      if (hit) cv.blend(x, y, C.line, 1);
    }
  }
}

// ---------- 身体：一只梨 ----------
const BODY_PROFILE = [
  [0.00, 62], [0.08, 84], [0.20, 100], [0.38, 110],
  [0.58, 116], [0.76, 117], [0.90, 110], [0.97, 96], [1.00, 84],
];
function bodyHalfWidth(t) {
  for (let i = 1; i < BODY_PROFILE.length; i++) {
    if (t <= BODY_PROFILE[i][0]) {
      const [t0, w0] = BODY_PROFILE[i - 1], [t1, w1] = BODY_PROFILE[i];
      const u = (t - t0) / (t1 - t0);
      const s = u * u * (3 - 2 * u);
      return w0 + (w1 - w0) * s;
    }
  }
  return 84;
}
function pearMask(m, cx, top, bot, scale) {
  const H = bot - top;
  for (let y = Math.floor(top); y <= Math.ceil(bot); y++) {
    const t = (y - top) / H;
    let hw = bodyHalfWidth(t) * scale;
    // 底部圆角
    const rb = 40 * scale;
    if (y > bot - rb) {
      const dy = (y - (bot - rb)) / rb;
      if (dy >= 1) continue;
      hw *= Math.sqrt(1 - dy * dy);
    }
    for (let x = Math.round(cx - hw); x <= Math.round(cx + hw); x++) m.set(x, y);
  }
}

// ---------- 头 ----------
function head(cv, x, y, s, mode) {
  const P = (dx, dy) => [x + dx * s, y + dy * s];
  const E = (dx, dy, rx, ry, col, a = 1) => cv.ellipse(x + dx * s, y + dy * s, rx * s, ry * s, col, a);
  const Cp = (dx1, dy1, dx2, dy2, r, col, a = 1) => cv.capsule(x + dx1 * s, y + dy1 * s, x + dx2 * s, y + dy2 * s, r * s, col, a);

  // 耳朵（蒙版描边，内部粉色）
  const mEar = new Mask(cv.w, cv.h);
  for (const sx of [-1, 1]) mEar.poly([P(sx * 76, -40), P(sx * 20, -84), P(sx * 94, -142)]);
  paint(cv, mEar, C.fur, 4.6 * s);
  for (const sx of [-1, 1]) {
    cv.poly([P(sx * 74, -50), P(sx * 34, -78), P(sx * 85, -122)], C.pink);
  }
  // 头
  const mHead = new Mask(cv.w, cv.h);
  mHead.ellipse(x, y, 96 * s, 90 * s);
  paint(cv, mHead, C.fur, 5 * s);
  // 斑纹
  Cp(-28, -76, -18, -46, 5.2, C.stripe);
  Cp(0, -82, 0, -50, 5.2, C.stripe);
  Cp(28, -76, 18, -46, 5.2, C.stripe);
  E(-70, 6, 20, 11, C.nose, 0.32);
  E(70, 6, 20, 11, C.nose, 0.32);
  E(0, 32, 47, 30, C.cream);

  if (mode === 'sleep') {
    cv.curve([P(-58, -8), P(-40, 10), P(-22, -6)], 3.6 * s, C.eye);
    cv.curve([P(22, -6), P(40, 10), P(58, -8)], 3.6 * s, C.eye);
    E(0, 47, 8, 6.5, C.nose, 0.75);
  } else {
    for (const sx of [-1, 1]) {
      E(sx * 40, -6, 19, 23, C.eye);
      E(sx * 40 + 7.5, -15, 6.5, 7.5, C.white);
      E(sx * 40 - 11, 4, 3.4, 3.4, C.white, 0.8);
    }
    // 鼻子 + 嘴
    const mNose = new Mask(cv.w, cv.h);
    mNose.poly([P(0, -14), P(-12, 2), P(12, 2)]);
    paint(cv, mNose, C.nose, 2.4 * s);
    Cp(0, 4, 0, 12, 2.4, C.eye);
    cv.curve([P(0, 12), P(-9, 21), P(-18, 13)], 2.4 * s, C.eye);
    cv.curve([P(0, 12), P(9, 21), P(18, 13)], 2.4 * s, C.eye);
  }
  for (const sx of [-1, 1]) {
    Cp(sx * 52, 28, sx * 98, 17, 2.1, C.whisker, 0.9);
    Cp(sx * 54, 34, sx * 104, 35, 2.1, C.whisker, 0.9);
    Cp(sx * 52, 40, sx * 94, 52, 2.1, C.whisker, 0.9);
  }
}

// ---------- 尾巴 ----------
function tail(cv, pts, r, s) {
  const m = new Mask(cv.w, cv.h);
  m.curve(pts, r);
  paint(cv, m, C.fur, 4.6 * s);
  // 环纹
  for (let i = 0; i < 2; i++) {
    const [p0, p1, p2] = [pts[0], pts[1], pts[2]];
    const t = 0.55 + i * 0.16;
    const mt = 1 - t;
    const p = [mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0], mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1]];
    const q = [mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0], p[1] + 1];
    cv.ellipse(p[0], p[1], r * 0.95, r * 0.42, C.stripe, 0.95);
    void q;
  }
}

function shadowBlob(cv, x, y, rx) {
  cv.ellipse(x, y, rx, 14, C.shadow, 0.10);
  cv.ellipse(x, y - 3, rx * 0.72, 10, C.shadow, 0.07);
}

// ---------- 站姿 ----------
function standing(cv, cx, gy, s) {
  const P = (dx, dy) => [cx + dx * s, gy + dy * s];
  shadowBlob(cv, cx, gy + 8, 128 * s);
  tail(cv, [P(96, -70), P(184, -48), P(196, -150), P(150, -196)], 15 * s, s);

  const body = new Mask(cv.w, cv.h);
  pearMask(body, cx, gy - 372 * s, gy - 8 * s, s);
  body.ellipse(...P(-62, -22), 46 * s, 22 * s);
  body.ellipse(...P(62, -22), 46 * s, 22 * s);
  paint(cv, body, C.fur, 5 * s);

  // 肚皮 + 斑纹（裁进剪影里）
  const old = cv.clip; cv.clip = body;
  cv.ellipse(...P(0, -150), 68 * s, 150 * s, C.cream);
  for (const sx of [-1, 1]) {
    cv.capsule(...P(sx * 112, -300), ...P(sx * 84, -286), 8 * s, C.stripe, 0.95);
    cv.capsule(...P(sx * 116, -262), ...P(sx * 88, -252), 8 * s, C.stripe, 0.95);
    cv.capsule(...P(sx * 116, -224), ...P(sx * 92, -216), 7 * s, C.stripe, 0.9);
  }
  cv.clip = old;

  // 前爪
  for (const sx of [-1, 1]) {
    const m = new Mask(cv.w, cv.h);
    m.ellipse(...P(sx * 40, -18), 32 * s, 19 * s);
    paint(cv, m, C.cream, 4 * s);
    cv.capsule(...P(sx * 40 - 10 * s, -24), ...P(sx * 40 - 10 * s, -10), 1.8 * s, C.creamSd, 0.9);
    cv.capsule(...P(sx * 40 + 10 * s, -24), ...P(sx * 40 + 10 * s, -10), 1.8 * s, C.creamSd, 0.9);
  }
  head(cv, cx, gy - 306 * s, s, 'open');
}

// ---------- 坐姿 ----------
function sitting(cv, cx, gy, s) {
  const P = (dx, dy) => [cx + dx * s, gy + dy * s];
  shadowBlob(cv, cx, gy + 8, 132 * s);
  tail(cv, [P(100, -40), P(186, -14), P(150, 16), P(52, 12)], 14 * s, s);

  const body = new Mask(cv.w, cv.h);
  pearMask(body, cx, gy - 300 * s, gy - 8 * s, s);
  body.ellipse(...P(-74, -40), 52 * s, 40 * s);
  body.ellipse(...P(74, -40), 52 * s, 40 * s);
  paint(cv, body, C.fur, 5 * s);

  const old = cv.clip; cv.clip = body;
  cv.ellipse(...P(-74, -34), 30 * s, 26 * s, C.creamSd);
  cv.ellipse(...P(74, -34), 30 * s, 26 * s, C.creamSd);
  cv.ellipse(...P(0, -150), 62 * s, 120 * s, C.cream);
  for (const sx of [-1, 1]) {
    cv.capsule(...P(sx * 100, -256), ...P(sx * 76, -244), 7 * s, C.stripe, 0.9);
  }
  cv.clip = old;

  for (const sx of [-1, 1]) {
    const m = new Mask(cv.w, cv.h);
    m.ellipse(...P(sx * 36, -18), 30 * s, 18 * s);
    paint(cv, m, C.cream, 4 * s);
    cv.capsule(...P(sx * 36 - 9 * s, -24), ...P(sx * 36 - 9 * s, -10), 1.8 * s, C.creamSd, 0.9);
    cv.capsule(...P(sx * 36 + 9 * s, -24), ...P(sx * 36 + 9 * s, -10), 1.8 * s, C.creamSd, 0.9);
  }
  head(cv, cx, gy - 268 * s, s * 0.98, 'open');
}

// ---------- 睡姿 ----------
function sleeping(cv, cx, gy, s) {
  const P = (dx, dy) => [cx + dx * s, gy + dy * s];
  shadowBlob(cv, cx + 14 * s, gy + 8, 150 * s);

  const body = new Mask(cv.w, cv.h);
  body.ellipse(...P(30, -66), 116 * s, 58 * s);
  body.curve([P(120, -40), P(166, 0), P(60, 18), P(-30, 12)], 13 * s);
  paint(cv, body, C.fur, 5 * s);

  const old = cv.clip; cv.clip = body;
  cv.ellipse(...P(54, -48), 78 * s, 32 * s, C.cream);
  cv.capsule(...P(54, -112), ...P(74, -80), 9 * s, C.stripe, 0.92);
  cv.capsule(...P(88, -106), ...P(106, -74), 9 * s, C.stripe, 0.92);
  cv.capsule(...P(120, -94), ...P(132, -66), 9 * s, C.stripe, 0.92);
  cv.clip = old;

  const paw = new Mask(cv.w, cv.h);
  paw.ellipse(...P(-100, -16), 32 * s, 17 * s);
  paint(cv, paw, C.cream, 4 * s);

  head(cv, cx - 66 * s, gy - 92 * s, s * 0.9, 'sleep');
  const z = (zx, zy, k) => {
    cv.capsule(zx, zy, zx + 15 * k, zy, 2.4 * k, C.stripe, 0.85);
    cv.capsule(zx + 15 * k, zy, zx, zy + 15 * k, 2.4 * k, C.stripe, 0.85);
    cv.capsule(zx, zy + 15 * k, zx + 15 * k, zy + 15 * k, 2.4 * k, C.stripe, 0.85);
  };
  z(cx + 6 * s, gy - 206 * s, 1.0 * s);
  z(cx + 40 * s, gy - 246 * s, 0.76 * s);
}

// ---------- 画布 ----------
const W = ZOOM ? 900 : 1620, H = ZOOM ? 940 : 900;
const cv = new Canvas(W * SS, H * SS);
if (ZOOM) {
  standing(cv, 450 * SS, 880 * SS, 1.85 * SS);
} else {
  const gy = 800 * SS;
  standing(cv, 300 * SS, gy, SS);
  sitting(cv, 810 * SS, gy, SS);
  sleeping(cv, 1330 * SS, gy, SS);
}

const out = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * cv.w + (x * SS + sx)) * 4;
        r += cv.d[i]; g += cv.d[i + 1]; b += cv.d[i + 2];
      }
    }
    const n = SS * SS, o = (y * W + x) * 4;
    out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
  }
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  out.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
const file = path.join(__dirname, ZOOM ? 'orange-cat-standing.png' : 'orange-cat-poses.png');
fs.writeFileSync(file, png);
console.log('written', file, png.length, 'bytes');
