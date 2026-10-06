/**
 * 绘制数据（paint）：画布渲染和 SVG/PDF/PNG 导出共用同一份计算结果。
 *
 * 这条是 P-2 的落地：布局引擎算出中心点和尺寸，样式引擎算出颜色和字号，
 * 到这里只剩"把已算好的东西画出来"。屏上看到的和导出的图不一致，
 * 一定是因为有人绕过 paint 自己算了一遍 —— 所以 paint 只在这里出现一次。
 */
import type { Page } from "../../types/model.ts";
import { computeLayout, textWidth, type ConnectorPath, type LayoutResult } from "../layout.ts";
import { descendants } from "../tree.ts";
import {
  contrastText,
  defaultPalette,
  styleFor,
  type Resolved,
  type ThemePalette,
} from "../style.ts";
import { DEFAULTS } from "../../model/constants.ts";

export interface RenderOptions {
  padding?: number;
  background?: string;
  displayLevel?: number;
  palette?: ThemePalette;
  /** 只显示这些分支（下钻 / 单页导出）。 */
  only?: string[];
  /** 主题框宽：fixed 把整页对齐到同一个宽度（与画布同一个开关）。 */
  topicWidthMode?: "auto" | "fixed";
}

export interface ShapePaint {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  line: string;
  lineWidth: number;
  rounding: number;
  textColor: string;
  fontSize: number;
  fontFamily: string;
  bold: boolean;
  lines: string[];
  /** 折叠徽标（+3）。 */
  hiddenCount: number;
  /** 左下角标：有备注 / 有超链接。 */
  note: boolean;
  link: boolean;
  /** 标签条的文字，宽度已由 labelChips 按本框算好。 */
  labels: string[];
}

export interface Paint {
  layout: LayoutResult;
  boxes: ShapePaint[];
  connectors: ConnectorPath[];
  width: number;
  height: number;
  minX: number;
  minY: number;
  background: string;
}

export function paintPage(page: Page, opts: RenderOptions = {}): Paint {
  const palette = opts.palette ?? defaultPalette();
  const layout = computeLayout(page, {
    displayLevel: opts.displayLevel ?? 9,
    only: opts.only,
    palette,
    topicWidthMode: opts.topicWidthMode,
  });
  const boxes: ShapePaint[] = [];
  for (const id of layout.order) {
    const b = layout.boxes[id];
    const s = page.shapes[id];
    if (!b || !s) continue;
    const r: Resolved = styleFor(page, s, palette);
    boxes.push({
      id,
      x: b.x - b.w / 2,
      y: b.y - b.h / 2,
      w: b.w,
      h: b.h,
      fill: r.fill,
      line: r.line,
      lineWidth: r.lineWidth,
      rounding: r.rounding,
      textColor: r.font.color ?? contrastText(r.fill),
      fontSize: r.font.size ?? DEFAULTS.fontSize,
      fontFamily: r.font.family ?? palette.fontFamily,
      bold: Boolean(r.font.bold),
      // 折行只有一处：布局量盒子时用的就是这份 lines，绘制再折一次等于第二条绘制路径（P-2）。
      lines: b.lines,
      // 折叠徽标数的是整条子树，与大纲面板同一个数（P-1：一份数据一个答案）
      hiddenCount: s.extras.collapsed ? descendants(page, s.id).length : 0,
      note: Boolean(s.extras.note),
      link: Boolean(s.extras.hyperlink),
      labels: s.extras.labels ?? [],
    });
  }
  const pad = opts.padding ?? 40;
  return {
    layout,
    boxes,
    connectors: layout.connectors,
    width: layout.width + pad * 2,
    height: layout.height + pad * 2,
    minX: layout.bounds.minX - pad,
    minY: layout.bounds.minY - pad,
    background: opts.background ?? "#ffffff",
  };
}

/**
 * 字体名用单引号：整串要塞进 font-family="..." 这个双引号属性里。
 * 用双引号的话 SVG 就不是良构 XML —— 浏览器当文档渲染时看不出来（HTML 解析器宽容），
 * 一旦走 <img src="data:image/svg+xml,..."> 这条路（PNG 与位图 PDF 的必经之路）就是解码失败。
 */
export const FONT_STACK = `微软雅黑, 'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', Verdana, sans-serif`;

const XML_ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => XML_ESC[c]);
}

/** SVG 导出。矢量、可编辑，也是 PNG / 位图 PDF 的中间产物。 */
export function buildSvg(page: Page, opts: RenderOptions = {}): string {
  const p = paintPage(page, opts);
  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8" standalone="no"?>`);
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(p.width)}" height="${round(p.height)}" ` +
      `viewBox="${round(p.minX)} ${round(p.minY)} ${round(p.width)} ${round(p.height)}" font-family="${FONT_STACK}">`
  );
  out.push(
    `<rect x="${round(p.minX)}" y="${round(p.minY)}" width="${round(p.width)}" height="${round(p.height)}" fill="${p.background}"/>`
  );
  out.push(`<g fill="none" stroke-linecap="round">`);
  for (const c of p.connectors) {
    out.push(`<path d="${esc(c.d)}" stroke="${strokeOf(p, c)}" stroke-width="1.6"/>`);
  }
  out.push(`</g>`);
  for (const b of p.boxes) {
    const rx = Math.min(b.rounding, b.w / 2, b.h / 2);
    out.push(
      `<rect x="${round(b.x)}" y="${round(b.y)}" width="${round(b.w)}" height="${round(b.h)}" rx="${round(rx)}" ` +
        `fill="${b.fill}" stroke="${b.line}" stroke-width="${b.lineWidth}"/>`
    );
    const lh = b.fontSize * 1.35;
    const startY = b.y + b.h / 2 - ((b.lines.length - 1) * lh) / 2 + b.fontSize * 0.35;
    b.lines.forEach((line, ix) => {
      out.push(
        `<text x="${round(b.x + b.w / 2)}" y="${round(startY + ix * lh)}" font-size="${round(b.fontSize)}" ` +
          `text-anchor="middle"${b.bold ? ' font-weight="bold"' : ""} fill="${b.textColor}">${esc(line)}</text>`
      );
    });
    if (b.hiddenCount > 0) {
      out.push(
        `<circle cx="${round(b.x + b.w - 6)}" cy="${round(b.y + b.h - 6)}" r="7" fill="#ffffff" stroke="${b.line}"/>` +
          `<text x="${round(b.x + b.w - 6)}" y="${round(b.y + b.h - 2.5)}" font-size="8" text-anchor="middle" fill="${b.line}">${b.hiddenCount}</text>`
      );
    }
    for (const d of cornerBadgePaths(b)) {
      out.push(`<path d="${d}" fill="none" stroke="${b.line}" stroke-width="1"/>`);
    }
    for (const c of labelChips(b)) {
      out.push(
        `<rect x="${round(c.x)}" y="${round(c.y)}" width="${round(c.w)}" height="${round(c.h)}" rx="2" ` +
          `fill="none" stroke="${b.line}" stroke-width="1"/>` +
          `<text x="${round(c.x + c.w / 2)}" y="${round(c.y + c.h / 2 + b.fontSize * 0.24)}" ` +
          `font-size="${round(b.fontSize * 0.68)}" text-anchor="middle" fill="${b.textColor}">${esc(c.text)}</text>`
      );
    }
  }
  out.push("</svg>");
  return out.join("\n");
}

/**
 * 主题左下角的那对角标（右下角留给折叠计数）。
 *
 * 几何只写这一处：SVG 导出与画布各自 map 同一批 path，
 * 两份坐标各算一遍就会出现"导出的图上有、屏幕上没有"这种事（P-2 只有一条绘制路径）。
 */
/** 一枚角标在底边带上占掉的宽度：图形本身宽 8 / 7，各留一点呼吸。 */
const BADGE_STEP = { note: 11, link: 8 };

/** 角标从 x+6 起排，占掉的横向总宽度；标签条接在它右边。 */
export function badgeExtent(b: Pick<ShapePaint, "note" | "link">): number {
  return 6 + (b.note ? BADGE_STEP.note : 0) + (b.link ? BADGE_STEP.link : 0);
}

export function cornerBadgePaths(
  b: Pick<ShapePaint, "x" | "y" | "w" | "h" | "note" | "link">
): string[] {
  const out: string[] = [];
  const base = b.y + b.h - 5;
  let x = b.x + 6;
  if (b.note) {
    // 一页折了角的纸 + 一道横线
    out.push(`M${x} ${base - 8} h5 l3 3 v5 h-8 z M${x + 2} ${base - 4} h3`);
    x += BADGE_STEP.note;
  }
  if (b.link) out.push(`M${x} ${base - 1} l6 -6 M${x + 2} ${base - 7} h5 v5`);
  return out;
}

export interface LabelChip {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

/**
 * 标签条：主题框底部那条预留带里的几个小方框。
 *
 * layout.measureShape 遇到 labels 就把高度加了 fontSize*0.9，但一直没人脸上的空白
 * 比没留空白更糟 —— 这里就是把那条带子画上。放不下的标签直接不画（不折行、不溢出），
 * 因为框宽是布局量出来的，硬塞会把子主题的间距也算歪。
 */
export function labelChips(
  b: Pick<
    ShapePaint,
    "x" | "y" | "w" | "h" | "fontSize" | "labels" | "note" | "link" | "hiddenCount"
  >
): LabelChip[] {
  if (!b.labels.length) return [];
  const fs = b.fontSize;
  const h = Math.max(9, Math.round(fs * 0.62));
  const y = Math.round(b.y + b.h - h - fs * 0.18);
  const textFs = fs * 0.68;
  const gap = 4;
  let x = Math.round(b.x + badgeExtent(b) + 2);
  const right = b.x + b.w - (b.hiddenCount > 0 ? 15 : 5);
  const out: LabelChip[] = [];
  for (const text of b.labels) {
    const w = Math.round(textWidth(text, textFs) + 8);
    if (x + w > right) break;
    out.push({ x, y, w, h, text });
    x += w + gap;
  }
  return out;
}

function strokeOf(p: Paint, c: ConnectorPath): string {
  const to = p.boxes.find((b) => b.id === c.toId);
  return to ? to.line : DEFAULTS.lineColor;
}

function round(v: number): string {
  return String(Math.round(v * 100) / 100);
}
