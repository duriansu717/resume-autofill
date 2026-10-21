/**
 * 生成扩展图标（16 / 32 / 48 / 128 px PNG）。
 *
 * 为什么用代码画而不是放几张图：
 *   · 不需要额外依赖，Node 内置 zlib 就能编码 PNG
 *   · 想调颜色、圆角、线条粗细改几个常量就行，不用重新作图
 *   · 小尺寸和大尺寸来自同一份矢量描述，不会出现「16px 看起来像另一个图标」
 *
 * 图形：蓝色渐变圆角方块 + 白色纸张 + 三条内容线 + 绿色对勾徽章
 * 用有符号距离场（SDF）算覆盖率，边缘自带抗锯齿。
 *
 * 运行：node tools/make-icons.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ═══════════════════════ PNG 编码 ═══════════════════════

let crcTable = null;

function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 6;   // 颜色类型：RGBA
  ihdr[10] = 0;  // 压缩
  ihdr[11] = 0;  // 滤波
  ihdr[12] = 0;  // 隔行

  // 每行前面加一个 filter 字节（0 = None）
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ═══════════════════════ 有符号距离场 ═══════════════════════

/** 圆角矩形。返回值 < 0 表示在内部。 */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 线段（不带端帽）。 */
function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const denom = bax * bax + bay * bay;
  const h = denom === 0 ? 0 : Math.max(0, Math.min(1, (pax * bax + pay * bay) / denom));
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  return Math.sqrt(dx * dx + dy * dy);
}

// ═══════════════════════ 图形定义 ═══════════════════════
// 所有数值都在 100×100 的设计坐标系里，实际渲染时按尺寸缩放

const DESIGN = {
  bg:       { cx: 50, cy: 50, hw: 50, hh: 50, r: 22 },
  bgFrom:   [0x3b, 0x82, 0xf6],   // 左上
  bgTo:     [0x1d, 0x4e, 0xd8],   // 右下

  sheet:    { cx: 48, cy: 46, hw: 24, hh: 29, r: 6 },

  lines: [
    { x1: 33, x2: 63, y: 33 },
    { x1: 33, x2: 63, y: 45 },
    { x1: 33, x2: 52, y: 57 },   // 最后一行短一点，像写字写到一半
  ],
  lineColor: [0x25, 0x63, 0xeb],
  lineHalf: 3,                    // 线宽的一半

  badge:    { cx: 74, cy: 74, r: 16, color: [0x16, 0xa3, 0x4a] },
  check:    { pts: [[67, 74], [72, 79], [81, 68]], half: 2.75, color: [255, 255, 255] },
};

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** 距离 → 覆盖率。0.5 像素的过渡带，就是抗锯齿。 */
function cover(distanceInPixels) {
  return clamp01(0.5 - distanceInPixels);
}

function render(size) {
  const scale = size / 100;
  const px = new Float64Array(size * size * 4);

  // 16px 下三条细线会糊成一团灰。小尺寸改用两条更粗、间距更大的线，
  // 牺牲一点细节换取轮廓清楚——这是图标设计的常规做法。
  const small = size <= 20;
  const lines = small
    ? [{ x1: 34, x2: 62, y: 37 }, { x1: 34, x2: 62, y: 52 }]
    : DESIGN.lines;
  const lineHalf = small ? 3.6 : DESIGN.lineHalf;

  /** 把一个颜色按覆盖率混合到像素上（source-over） */
  function blend(i, r, g, b, a) {
    if (a <= 0) return;
    const da = px[i + 3];
    const oa = a + da * (1 - a);
    if (oa <= 0) return;
    px[i]     = (r * a + px[i]     * da * (1 - a)) / oa;
    px[i + 1] = (g * a + px[i + 1] * da * (1 - a)) / oa;
    px[i + 2] = (b * a + px[i + 2] * da * (1 - a)) / oa;
    px[i + 3] = oa;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // 像素中心换算到设计坐标系
      const dx = (x + 0.5) / scale;
      const dy = (y + 0.5) / scale;

      // ── 1. 背景圆角方块（对角渐变）──
      const bg = DESIGN.bg;
      const d1 = sdRoundRect(dx, dy, bg.cx, bg.cy, bg.hw, bg.hh, bg.r);
      const c1 = cover(d1 * scale);
      if (c1 > 0) {
        const t = clamp01((dx + dy) / 200);
        blend(i,
          lerp(DESIGN.bgFrom[0], DESIGN.bgTo[0], t),
          lerp(DESIGN.bgFrom[1], DESIGN.bgTo[1], t),
          lerp(DESIGN.bgFrom[2], DESIGN.bgTo[2], t),
          c1);
      }

      // ── 2. 白色纸张 ──
      const sh = DESIGN.sheet;
      const d2 = sdRoundRect(dx, dy, sh.cx, sh.cy, sh.hw, sh.hh, sh.r);
      blend(i, 255, 255, 255, cover(d2 * scale));

      // ── 3. 内容线（胶囊形）──
      for (const ln of lines) {
        const midX = (ln.x1 + ln.x2) / 2;
        const halfW = (ln.x2 - ln.x1) / 2;
        const d = sdRoundRect(dx, dy, midX, ln.y, halfW, lineHalf, lineHalf);
        blend(i, DESIGN.lineColor[0], DESIGN.lineColor[1], DESIGN.lineColor[2],
          cover(d * scale) * 0.88);
      }

      // ── 4. 对勾徽章 ──
      const bd = DESIGN.badge;
      const d4 = Math.hypot(dx - bd.cx, dy - bd.cy) - bd.r;
      const c4 = cover(d4 * scale);
      if (c4 > 0) {
        blend(i, bd.color[0], bd.color[1], bd.color[2], c4);
      }

      // ── 5. 白色对勾（完全落在徽章内，不需要裁剪）──
      const pts = DESIGN.check.pts;
      const d5 = Math.min(
        sdSegment(dx, dy, pts[0][0], pts[0][1], pts[1][0], pts[1][1]) - DESIGN.check.half,
        sdSegment(dx, dy, pts[1][0], pts[1][1], pts[2][0], pts[2][1]) - DESIGN.check.half
      );
      blend(i, 255, 255, 255, cover(d5 * scale));
    }
  }

  // float → 8bit
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a <= 0) {
      out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
      continue;
    }
    // 颜色本来就是直通（非预乘）的 0–255 浮点，取整并夹紧即可
    out[i]     = Math.round(Math.max(0, Math.min(255, px[i])));
    out[i + 1] = Math.round(Math.max(0, Math.min(255, px[i + 1])));
    out[i + 2] = Math.round(Math.max(0, Math.min(255, px[i + 2])));
    out[i + 3] = Math.round(clamp01(a) * 255);
  }
  return out;
}

// ═══════════════════════ 主流程 ═══════════════════════

const SIZES = [16, 32, 48, 128];
const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of SIZES) {
  const rgba = render(size);
  const png = encodePNG(size, size, rgba);
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`✓ ${path.relative(path.join(__dirname, '..'), file)}  ${size}×${size}  ${png.length} 字节`);
}

console.log('\n图标已生成。别忘了在 manifest.json 里引用它们。');
