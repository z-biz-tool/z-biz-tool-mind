#!/usr/bin/env node
/**
 * 应用图标生成：无第三方依赖，纯 Node（zlib 够用来写 PNG），
 * 输出 src-tauri/tauri.conf.json 里声明的那五个文件 + Linux 用的 icon.png。
 *
 * 为什么要自己画：`cargo tauri icon` 需要 Rust 工具链，而图标本身只是一张
 * 程序化图形 —— 圆角方形底 + 脑图骨架。装工具链之前就该能先把打包流程跑通。
 *
 *   node scripts/gen-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src-tauri", "icons");
const SIZE = 1024;

// ---------------------------------------------------------------- 画布

/** 圆角矩形带符号距离：负数在内部，边缘用 1px 的 smoothstep 抗锯齿。 */
function dRoundRect(x, y, cx, cy, w, h, r) {
  const qx = Math.abs(x - cx) - (w / 2 - r);
  const qy = Math.abs(y - cy) - (h / 2 - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function dSegment(x, y, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = x - ax;
  const wy = y - ay;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(x - (ax + vx * t), y - (ay + vy * t));
}

function cover(d) {
  // 距离场 → 覆盖率：以 1.2 个源像素为坡宽，缩到 16px 时靠这个坡保住细线
  return Math.max(0, Math.min(1, 0.5 - d / (2 * (1.2 / SIZE))));
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const TOP = [0x3b, 0x7f, 0xf0];
const BOTTOM = [0x14, 0xa8, 0x9c];
const WHITE = [255, 255, 255];

/**  quadratic bezier 折成小直线段，避免为一条曲线再写一套距离场。 */
function curvePoints(x0, y0, cx, cy, x1, y1, steps = 14) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push([u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1]);
  }
  return pts;
}

// 归一化坐标（0..1）下的脑图骨架：中心节点靠左，三条分支向右展开
const CENTER = { cx: 0.31, cy: 0.5, w: 0.24, h: 0.15 };
const BRANCHES = [
  { cx: 0.75, cy: 0.22, w: 0.2, h: 0.1 },
  { cx: 0.79, cy: 0.5, w: 0.2, h: 0.1 },
  { cx: 0.75, cy: 0.78, w: 0.2, h: 0.1 },
];

function glyphDistance(u, v) {
  let d = Math.abs(dRoundRect(u, v, CENTER.cx, CENTER.cy, CENTER.w, CENTER.h, 0.035)) - 0.014;
  const startX = CENTER.cx + CENTER.w / 2;
  BRANCHES.forEach((b, i) => {
    const node = Math.abs(dRoundRect(u, v, b.cx, b.cy, b.w, b.h, 0.03)) - 0.011;
    const bendX = startX + 0.08;
    const pts = curvePoints(startX, CENTER.cy, bendX, CENTER.cy, b.cx - b.w / 2, b.cy, 16);
    let line = Infinity;
    for (let k = 1; k < pts.length; k++) {
      // 越靠外的分支线越细一点，视觉上更像亿图的连线层次
      line = Math.min(line, dSegment(u, v, pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1]) - (i === 1 ? 0.011 : 0.008));
    }
    d = Math.min(d, node, line);
  });
  return d;
}

/** 生成 SIZE×SIZE 的 RGBA（直通 alpha）像素。 */
function render() {
  const px = new Float64Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    const v = (y + 0.5) / SIZE;
    for (let x = 0; x < SIZE; x++) {
      const u = (x + 0.5) / SIZE;
      const i = (y * SIZE + x) * 4;
      // 底：圆角方形，四周留 6% 空隙（macOS 图标规范也是"图形内缩"）
      const alpha = cover(dRoundRect(u, v, 0.5, 0.5, 0.88, 0.88, 0.2));
      let c = mix(TOP, BOTTOM, v);
      // 左上打一点光，避免纯色块显得扁平
      c = mix(c, [c[0] + 26, c[1] + 22, c[2] + 18], Math.max(0, 0.5 - Math.hypot(u - 0.28, v - 0.2)) * 0.8);
      c = mix(c, WHITE, cover(glyphDistance(u, v)) * 0.94);
      px[i] = Math.max(0, Math.min(255, Math.round(c[0])));
      px[i + 1] = Math.max(0, Math.min(255, Math.round(c[1])));
      px[i + 2] = Math.max(0, Math.min(255, Math.round(c[2])));
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

/** 面积平均缩放（整数倍时正好是盒式滤波，缩到 16px 不糊边）。 */
function downscale(src, from, to) {
  const out = new Float64Array(to * to * 4);
  const k = from / to;
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const x0 = Math.floor(x * k);
      const y0 = Math.floor(y * k);
      const w = Math.max(1, Math.floor(k));
      for (let dy = 0; dy < w; dy++) {
        for (let dx = 0; dx < w; dx++) {
          const sx = Math.min(from - 1, x0 + dx);
          const sy = Math.min(from - 1, y0 + dy);
          const i = (sy * from + sx) * 4;
          // RGBA 各自加权：alpha 为 0 的像素不该把颜色"平均"进边缘
          const al = src[i + 3];
          r += src[i] * al;
          g += src[i + 1] * al;
          b += src[i + 2] * al;
          a += al;
        }
      }
      const o = (y * to + x) * 4;
      const n = w * w;
      out[o] = a > 0 ? Math.round(r / a) : 0;
      out[o + 1] = a > 0 ? Math.round(g / a) : 0;
      out[o + 2] = a > 0 ? Math.round(b / a) : 0;
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size * 4; x++) raw[y * (size * 4 + 1) + 1 + x] = pixels[y * size * 4 + x];
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- ICO / ICNS

/** ICO：目录项里的宽高，256 记 0（Vista+ 起可以直接放 PNG 负载）。 */
function encodeIco(entries) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(entries.length, 4);
  // ICO 的目录必须连着放，图像数据统一排在目录之后 —— 交错排放 Windows 不认
  let offset = dir.length + entries.length * 16;
  const heads = entries.map(({ size, png }) => {
    const head = Buffer.alloc(16);
    head[0] = size >= 256 ? 0 : size; // 0 = 256
    head[1] = size >= 256 ? 0 : size;
    head[2] = 0; // 调色板数量：真彩
    head[3] = 0; // reserved
    head.writeUInt16LE(1, 4); // planes
    head.writeUInt16LE(32, 6); // bitCount
    head.writeUInt32LE(png.length, 8); // bytesInRes
    head.writeUInt32LE(offset, 12); // imageOffset
    offset += png.length;
    return head;
  });
  return Buffer.concat([dir, ...heads, ...entries.map((e) => e.png)]);
}

/** ICNS：'icns' + 总长 + 若干 (类型, 长度, PNG 负载)。 */
function encodeIcns(entries) {
  const bodies = entries.map(([type, png]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, "latin1");
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const total = 8 + bodies.reduce((n, b) => n + b.length, 0);
  const file = Buffer.alloc(8);
  file.write("icns", 0, "latin1");
  file.writeUInt32BE(total, 4);
  return Buffer.concat([file, ...bodies]);
}

// ---------------------------------------------------------------- 落地

const rgba = render();

const cache = new Map();
function pngAt(size) {
  if (!cache.has(size)) {
    const pixels = size === SIZE ? rgba : downscale(rgba, SIZE, size);
    cache.set(size, encodePng(pixels, size));
  }
  return cache.get(size);
}

mkdirSync(OUT, { recursive: true });
const writes = [
  ["32x32.png", pngAt(32)],
  ["64x64.png", pngAt(64)],
  ["128x128.png", pngAt(128)],
  ["128x128@2x.png", pngAt(256)],
  ["256x256.png", pngAt(256)],
  ["512x512.png", pngAt(512)],
  ["icon.png", pngAt(512)],
  [
    "icon.ico",
    encodeIco([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: pngAt(size) }))),
  ],
  [
    "icon.icns",
    encodeIcns([
      ["icp4", pngAt(16)],
      ["icp5", pngAt(32)],
      ["ic07", pngAt(128)],
      ["ic08", pngAt(256)],
      ["ic09", pngAt(512)],
      ["ic10", pngAt(1024)],
      ["ic11", pngAt(256)],
      ["ic12", pngAt(512)],
      ["ic13", pngAt(32)],
      ["ic14", pngAt(512)],
      ["ic15", pngAt(128)],
      ["ic16", pngAt(256)],
    ]),
  ],
];
for (const [name, data] of writes) {
  writeFileSync(join(OUT, name), data);
  console.log(`  ${name.padEnd(18)} ${(data.length / 1024).toFixed(1)} KB`);
}
console.log(`\n图标已生成到 src-tauri/icons（源图 ${SIZE}×${SIZE}，改造型只需换上面的坐标）`);
