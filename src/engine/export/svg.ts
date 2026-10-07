/**
 * 绘制数据（paint）：画布渲染和 SVG/PDF/PNG 导出共用同一份计算结果。
 *
 * 这条是 P-2 的落地：布局引擎算出中心点和尺寸，样式引擎算出颜色和字号，
 * 到这里只剩"把已算好的东西画出来"。屏上看到的和导出的图不一致，
 * 一定是因为有人绕过 paint 自己算了一遍 —— 所以 paint 只在这里出现一次。
 */
import type { Page } from "../../types/model.ts";
import {
  BADGE_STEP,
  chipHeight,
  chipWidth,
  computeLayout,
  labelInsets,
  labelRows,
  overlayShapes,
  relationshipPaths,
  type ConnectorPath,
  type LayoutResult,
  type OverlayPaint,
  type RelationshipPaint,
} from "../layout.ts";
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
  /** 标签条占掉的高度：正文按 h - stripH 居中。 */
  stripH: number;
}

export interface Paint {
  layout: LayoutResult;
  boxes: ShapePaint[];
  connectors: ConnectorPath[];
  /** 关系线：几何来自 layout.relationshipPaths，画布和导出共用同一份。 */
  rels: RelationshipPaint[];
  /** 外框 / 概要大括号 / 标注框：几何来自 layout.overlayShapes，同样只有一份。 */
  overlays: OverlayPaint[];
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
      stripH: b.stripH,
    });
  }
  const pad = opts.padding ?? 40;
  // 概要主题与标注框走 boxes 这条路：它们本来就是个"有文字的框"，
  // 进 boxes 就自动拿到同一套圆角矩形 + 折行 + 命中测试 + 就地改字，不必再有第二条画法。
  const overlays = overlayShapes(page, layout.boxes, palette);
  const isBubble = (o: OverlayPaint) => o.kind === "label" || o.kind === "callout";
  for (const o of overlays) {
    if (!isBubble(o)) continue;
    boxes.push({
      id: o.id,
      x: o.x,
      y: o.y,
      w: o.w,
      h: o.h,
      fill: o.fill,
      line: o.line,
      lineWidth: o.lineWidth,
      rounding: o.rounding,
      textColor: o.textColor,
      fontSize: o.fontSize,
      fontFamily: o.fontFamily,
      bold: o.bold,
      lines: o.lines,
      hiddenCount: 0,
      note: false,
      link: false,
      labels: [],
      stripH: 0,
    });
  }
  return {
    layout,
    boxes,
    connectors: layout.connectors,
    rels: relationshipPaths(page, layout.boxes),
    // 标注泡本身已经在 boxes 里画过了，留在 overlays 里是为了那根引导线
    overlays: overlays.filter((o) => o.kind !== "label"),
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

/**
 * 视口：viewBox 的那一块内容坐标，加上把它放大到设备像素的倍率。
 * width = w * scale，所以"一页装不装得下、字有多大"由 scale 一个数决定，
 * 形状坐标本身一个都不动 —— 打印分页只是换视口，不是第二次布局（P-2）。
 */
export interface SvgView {
  x: number;
  y: number;
  w: number;
  h: number;
  scale?: number;
}

/** 整图导出用的默认视口：paint 算出来的那张外框。 */
export function fullView(p: Paint): SvgView {
  return { x: p.minX, y: p.minY, w: p.width, h: p.height };
}

/** SVG 导出。矢量、可编辑，也是 PNG / 位图 PDF 的中间产物。 */
export function buildSvg(page: Page, opts: RenderOptions = {}): string {
  return renderSvg(paintPage(page, opts));
}

/**
 * 已经把 Paint 算出来了的那些调用者（打印分页要先过滤形状）走这一条：
 * 图形部分与 buildSvg 逐字相同，只是外面的 <svg> 换了视口。
 */
export function renderSvg(p: Paint, view: SvgView = fullView(p)): string {
  const s = view.scale ?? 1;
  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8" standalone="no"?>`);
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(view.w * s)}" height="${round(view.h * s)}" ` +
      `viewBox="${round(view.x)} ${round(view.y)} ${round(view.w)} ${round(view.h)}" font-family="${FONT_STACK}">`
  );
  out.push(
    `<rect x="${round(view.x)}" y="${round(view.y)}" width="${round(view.w)}" height="${round(view.h)}" fill="${p.background}"/>`
  );
  // 外框在连线和主题之下：它是给一组主题"围个圈"的底色，压在上面就会把内容糊掉。
  for (const o of p.overlays) {
    if (o.kind !== "boundary") continue;
    out.push(
      `<rect x="${round(o.x)}" y="${round(o.y)}" width="${round(o.w)}" height="${round(o.h)}" rx="${round(o.rounding)}" ` +
        `fill="${o.fill}" fill-opacity="0.35" stroke="${o.line}" stroke-width="${round(o.lineWidth)}"/>`
    );
  }
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
    const lh = lineGap(b.fontSize);
    const startY = textStartY(b);
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
  // 大括号压在主题之上：它是"盖在分支外面"的一层，画在框底下就等于没画。
  // 标注泡本身走 boxes 那条路（可点、可改字），这里只剩它的引导线。
  for (const o of p.overlays) {
    if (o.kind === "brace") {
      out.push(
        `<path d="${esc(o.d ?? "")}" fill="none" stroke="${o.line}" stroke-width="${round(o.lineWidth)}" stroke-linecap="round"/>`
      );
      continue;
    }
    if (o.kind !== "callout") continue;
    out.push(`<path d="${esc(o.d ?? "")}" fill="none" stroke="${o.line}" stroke-width="1"/>`);
  }
  // 关系线压在主题之上：它本来就常从别的主题身上跨过去，画在框底下等于没画
  // （第一版就是这样，DOM 里数得出那条 path，屏幕上却一个字都没露）。
  for (const r of p.rels) {
    out.push(
      `<path d="${esc(r.d)}" stroke="${r.line}" stroke-width="${round(r.lineWidth)}"${
        r.dash ? ` stroke-dasharray="${r.dash}"` : ""
      } fill="none"/>`
    );
    if (r.text) {
      out.push(
        `<text x="${round(r.lx)}" y="${round(r.ly)}" font-size="${round(r.fontSize)}" text-anchor="middle" fill="${r.line}">${esc(r.text)}</text>`
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

/** 行距：画布与导出共用一个数。 */
export function lineGap(fontSize: number): number {
  return fontSize * 1.35;
}

/**
 * 正文第一行的基线。按"去掉标签条之后的高度"居中 ——
 * 整框居中的话，标签一换行正文就被挤到标签那一行上（真机截图里两者叠在一起）。
 */
export function textStartY(
  b: Pick<ShapePaint, "y" | "h" | "stripH" | "fontSize" | "lines">
): number {
  return (
    b.y +
    (b.h - b.stripH) / 2 -
    ((b.lines.length - 1) * lineGap(b.fontSize)) / 2 +
    b.fontSize * 0.35
  );
}

export interface LabelChip {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

/**
 * 标签条：布局为 labels 预留的那几条带子，最后一行贴着框底、前面的往上叠。
 *
 * 换行规则、chip 尺寸、左右让位（第一行让给角标、行尾让给折叠计数）全问 layout 要，
 * 这里只把"行"翻译成坐标 —— 布局按一行预留、绘制排出两行的话，字就压到框外了。
 */
export function labelChips(
  b: Pick<
    ShapePaint,
    "x" | "y" | "w" | "h" | "fontSize" | "labels" | "note" | "link" | "hiddenCount"
  >
): LabelChip[] {
  if (!b.labels.length) return [];
  const insets = labelInsets({ note: b.note, link: b.link, hideRight: b.hiddenCount > 0 });
  const rows = labelRows(b.labels, b.fontSize, b.w, insets);
  const h = chipHeight(b.fontSize);
  const out: LabelChip[] = [];
  rows.forEach((row, i) => {
    const y = Math.round(
      b.y + b.h - b.fontSize * 0.18 - h * (rows.length - i) - 2 * (rows.length - i - 1)
    );
    let x = Math.round(b.x + (i === 0 ? insets.left : 6));
    for (const text of row) {
      const w = chipWidth(text, b.fontSize);
      out.push({ x, y, w, h, text });
      x += w + 4;
    }
  });
  return out;
}

function strokeOf(p: Paint, c: ConnectorPath): string {
  const to = p.boxes.find((b) => b.id === c.toId);
  return to ? to.line : DEFAULTS.lineColor;
}

function round(v: number): string {
  return String(Math.round(v * 100) / 100);
}
