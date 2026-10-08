/**
 * 布局引擎：位置是算出来的，不是存的（doc/复刻方案/00 §0.3 P-2、§3.4）。
 *
 * .emmx 里每个 Shape 都带 Transform（中心点 + 宽高），那是"上一次布局的结果缓存"。
 * 我们的做法：打开文档时按 page.layout 重新计算，只在导出时把结果写回 Transform，
 * 这样改了间距 / 折叠了分支 / 换了布局，不需要用户手工重排。
 *
 * 文字测量为什么不用 canvas.measureText：
 * 一是那样这个模块就只能在浏览器里跑，测试全部要 mock；二是导出的 PNG/SVG/PDF
 * 必须和屏幕上的换行完全一致，用同一套纯函数测量是唯一能保证这点的方式。
 * 代价是字宽是近似值（CJK 按 1 em、拉丁按 0.55 em），实测足够稳定。
 */

import type { LayoutCode, Page, Shape } from "../types/model.ts";
import { isTopic, plainText } from "../types/model.ts";
import { DEFAULTS } from "../model/constants.ts";
import { descendants } from "./tree.ts";
import {
  contrastText,
  defaultPalette,
  resolveColor,
  styleFor,
  type ThemePalette,
} from "./style.ts";

export interface NodeBox {
  id: string;
  /** 中心点 —— 和 .emmx 的 CX/CY 同语义，四边由 w/h 推出来。 */
  x: number;
  y: number;
  w: number;
  h: number;
  level: number;
  parentId: string | null;
  /** 该节点在主分支序列里的序号（Rainbow 取色、编号用）。 */
  branchIx: number;
  /** 相对父节点在哪一侧，连线和鱼骨方向都要用它。 */
  side: -1 | 0 | 1;
  lines: string[];
  /** 标签条在框底占掉的高度；正文要在剩下那部分里居中，否则会压到标签上。 */
  stripH: number;
}

export interface ConnectorPath {
  id: string;
  fromId: string;
  toId: string;
  /** SVG path 的 d 属性，与 .emmx 的 Geometries(MoveTo/CurveTo) 一一对应。 */
  d: string;
  side: -1 | 0 | 1;
}

export interface LayoutResult {
  boxes: Record<string, NodeBox>;
  order: string[];
  connectors: ConnectorPath[];
  /** 时间轴/鱼骨的主轴；其余版式为 null。画布与导出共用这一份。 */
  axis: AxisPath | null;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  width: number;
  height: number;
}

export interface MeasureOptions {
  fontSize?: number;
  fontFamily?: string;
  maxWidth?: number;
  lineHeight?: number;
  /** "固定框宽"：所有主题同一个宽度，长文字换行而不是把框撑宽。 */
  fixedWidth?: number;
}

const WIDE =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

export function charWidth(ch: string, fontSize: number): number {
  if (WIDE.test(ch)) return fontSize;
  if (ch === " ") return fontSize * 0.3;
  if (/[iIl.,;:'`!"\]/|()\[\]{}]/.test(ch)) return fontSize * 0.32;
  if (/[A-Z0-9]/.test(ch)) return fontSize * 0.66;
  return fontSize * 0.55;
}

export function textWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch, fontSize);
  return w;
}

/** 贪心折行：先按显式换行拆，再按 maxWidth 折。返回渲染行。 */
export function wrapText(text: string, fontSize: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const hard of text.split("\n")) {
    if (hard === "") {
      out.push("");
      continue;
    }
    let cur = "";
    let curW = 0;
    for (const ch of hard) {
      const w = charWidth(ch, fontSize);
      if (cur && curW + w > maxWidth) {
        out.push(cur);
        cur = ch;
        curW = w;
      } else {
        cur += ch;
        curW += w;
      }
    }
    if (cur) out.push(cur);
  }
  return out.length ? out : [""];
}

function shapeText(s: Shape): string {
  return s.text.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n");
}

/**
 * 单个主题的盒子尺寸：文字 + 内边距 + 附件占位（图标行、图片、备注角标）。
 * 附件宽度不计入文字宽，但会抬高高度 —— 与实测的 MainIdea（111×50，文字 72×20）一致。
 */
export function measureShape(
  s: Shape,
  opts: MeasureOptions = {}
): { w: number; h: number; lines: string[]; stripH: number } {
  const fontSize = s.style.font?.size ?? opts.fontSize ?? DEFAULTS.fontSize;
  const fixed = opts.fixedWidth;
  const maxWidth = fixed
    ? fixed
    : s.style.font?.size
      ? DEFAULTS.topicMaxTextW
      : (opts.maxWidth ?? DEFAULTS.topicMaxTextW);
  const text = shapeText(s) || " ";
  const lines = wrapText(text, fontSize, maxWidth - DEFAULTS.topicPadX * 2);
  const widest = Math.max(...lines.map((l) => textWidth(l, fontSize)));
  const lineH = fontSize * (s.style.font?.lineSpacing ? s.style.font.lineSpacing / 100 : 1.35);
  let w = fixed
    ? Math.max(DEFAULTS.topicMinW, fixed)
    : Math.min(maxWidth, Math.max(DEFAULTS.topicMinW, widest + DEFAULTS.topicPadX * 2));
  let h = Math.max(DEFAULTS.topicMinH, lines.length * lineH + DEFAULTS.topicPadY * 2);

  const extras = s.extras;
  if (s.floating) {
    // 浮动主题保留原尺寸（用户拖出来的），但仍要有下限
    w = Math.max(w, s.transform.w || 0);
    h = Math.max(h, s.transform.h || 0);
  }
  let stripH = 0;
  const marks = (extras.marks?.length ?? 0) > 0;
  const labels = extras.labels ?? [];
  if (labels.length) {
    const insets = labelInsets({
      note: Boolean(extras.note),
      link: Boolean(extras.hyperlink),
      hideRight: Boolean(extras.collapsed && s.childIds.length),
    });
    const widest = Math.max(...labels.map((t) => chipWidth(t, fontSize)));
    // 单条标签比框还宽时把框撑到能装下它，否则那条标签永远画不出来 —— 上限沿用主题的文本宽度上限。
    if (!fixed)
      w = Math.max(w, Math.min(DEFAULTS.topicMaxTextW, insets.left + widest + insets.right));
    stripH = labelStripHeight(labelRows(labels, fontSize, w, insets).length, fontSize);
    h += stripH;
  } else if (marks) {
    h += fontSize * 0.9;
  }
  if (extras.image) {
    w = Math.max(w, (extras.image.width ?? 64) + DEFAULTS.topicPadX * 2);
    h += (extras.image.height ?? 64) + 6;
  }
  if (extras.table) h += extras.table.rows * fontSize * 1.6;
  if (extras.attachments?.length) h += fontSize * 0.9;
  if (extras.note) w += 6;
  return { w: Math.round(w), h: Math.round(h), lines, stripH };
}

/** 标签条：一条 chip 的字号比例、内边距与行距。布局预留的高和绘制用的坐标都从这里出（P-2）。 */
const CHIP_PAD_X = 4;
const CHIP_GAP_X = 4;
const CHIP_GAP_Y = 2;
const CHIP_BOTTOM = 0.18;
const CHIP_H_RATIO = 0.62;
const CHIP_TEXT_RATIO = 0.68;

/** 一枚角标在底边带上占掉的宽度：图形本身宽 8 / 7，各留一点呼吸。 */
export const BADGE_STEP = { note: 11, link: 8 };

export function badgeExtent(b: { note?: boolean; link?: boolean }): number {
  return 6 + (b.note ? BADGE_STEP.note : 0) + (b.link ? BADGE_STEP.link : 0);
}

/** 标签条左让给角标、右让给折叠计数；布局与绘制必须用同一个算法。 */
export function labelInsets(b: { note?: boolean; link?: boolean; hideRight?: boolean }): {
  left: number;
  right: number;
} {
  return { left: badgeExtent(b) + 2, right: b.hideRight ? 15 : 5 };
}

export function chipHeight(fontSize: number): number {
  return Math.max(9, Math.round(fontSize * CHIP_H_RATIO));
}

export function chipWidth(text: string, fontSize: number): number {
  return Math.round(textWidth(text, fontSize * CHIP_TEXT_RATIO) + CHIP_PAD_X * 2);
}

/** 一行能放几条就放几条，剩下的换行。返回渲染行。 */
export function labelRows(
  labels: string[],
  fontSize: number,
  boxW: number,
  insets: { left: number; right: number }
): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let used = insets.left;
  const limit = Math.max(insets.left, boxW - insets.right);
  for (const t of labels) {
    const w = chipWidth(t, fontSize);
    if (cur.length && used + CHIP_GAP_X + w > limit) {
      rows.push(cur);
      cur = [];
      used = 6;
    }
    cur.push(t);
    used += (cur.length > 1 ? CHIP_GAP_X : 0) + w;
  }
  if (cur.length) rows.push(cur);
  return rows;
}

export function labelStripHeight(rows: number, fontSize: number): number {
  if (!rows) return 0;
  const h = chipHeight(fontSize);
  return Math.round(rows * h + (rows - 1) * CHIP_GAP_Y + fontSize * CHIP_BOTTOM);
}

/**
 * 关系线：两端锚在主题框边上，中间弯一道弧。画布与 SVG/PNG/PDF 共用这一份几何（P-2），
 * 否则导出图上的弧和屏幕上不是同一条线。
 */
export interface RelationshipPaint {
  id: string;
  fromId: string;
  toId: string;
  d: string;
  dash?: string;
  /** 弧中点：关系线自带的文字画在这里。 */
  lx: number;
  ly: number;
  text: string;
  line: string;
  lineWidth: number;
  fontSize: number;
}

/** 弧高：固定上限 + 按弦长比例，免得两个远处主题之间的关系线弯得离谱。 */
const REL_BOW_MAX = 60;
const REL_BOW_RATIO = 0.22;

/**
 * 页面级覆盖层：外框、概要大括号、概要主题、标注框。
 *
 * 亿图把这四类都写成独立的 Shape，但它们的 `<LevelData/>` 是空的（标注框另用 `<Data V>`
 * 指回主题，主题用 `<Callout V="182;183"/>` 指过来），所以永远不在主题树里 ——
 * computeLayout 的 boxes 自然没有它们。结果是"存得回、看不见"：
 * 真实用户图 doc2/3/4/5 里共 29 个标注框，画布与导出一个都没露过脸。
 *
 * 几何一律从已经算好的 boxes 推出来，不读文件里的 Transform 缓存，也不新开第二条绘制路径（P-2）：
 * 主题移动、分支折叠之后，覆盖层跟着布局走，这和亿图自己重算外框的行为一致。
 */

/** 外框留白 / 大括号与主题的间距 / 括号尖伸出 / 概要主题与括号尖的间距 / 标注框间距。 */
const OVERLAY_PAD = 12;
const BRACE_GAP = 6;
const BRACE_TIP = 9;
const SUMMARY_GAP = 6;
const CALLOUT_GAP = 6;

export interface OverlayPaint {
  id: string;
  /** 样式来源的那个模型形状。 */
  shapeId: string;
  kind: "boundary" | "brace" | "label" | "callout";
  /** 左上角 + 尺寸（brace 的这几个字段只是包围盒）。 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** brace 的括号路径、callout 的引导线。 */
  d?: string;
  fill: string;
  line: string;
  lineWidth: number;
  rounding: number;
  textColor: string;
  fontSize: number;
  fontFamily: string;
  bold: boolean;
  /** 已经按 measureShape 折好的行（P-2：折行只有一处）。 */
  lines: string[];
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 被盖住主题的并集矩形；布局里没有的 id（折叠了、删了）直接跳过。 */
function coveredRect(ids: string[], boxes: Record<string, NodeBox>): Rect | null {
  let r: Rect | null = null;
  for (const id of ids) {
    const b = boxes[id];
    if (!b) continue;
    const x0 = b.x - b.w / 2;
    const y0 = b.y - b.h / 2;
    const x1 = b.x + b.w / 2;
    const y1 = b.y + b.h / 2;
    r = r
      ? {
          x0: Math.min(r.x0, x0),
          y0: Math.min(r.y0, y0),
          x1: Math.max(r.x1, x1),
          y1: Math.max(r.y1, y1),
        }
      : { x0, y0, x1, y1 };
  }
  return r;
}

/** 覆盖层朝哪一侧长：取被盖住主题里第一个不居中的 side，没有就默认右。 */
function coveredSide(ids: string[], boxes: Record<string, NodeBox>): -1 | 1 {
  for (const id of ids) {
    const s = boxes[id]?.side;
    if (s === 1 || s === -1) return s;
  }
  return 1;
}

export function overlayShapes(
  page: Page,
  boxes: Record<string, NodeBox>,
  palette?: ThemePalette
): OverlayPaint[] {
  const pal = palette ?? defaultPalette();
  const out: OverlayPaint[] = [];
  const styleOf = (
    s: Shape
  ): Omit<OverlayPaint, "id" | "shapeId" | "kind" | "x" | "y" | "w" | "h" | "lines"> => {
    const r = styleFor(page, s, pal);
    return {
      fill: r.fill,
      line: r.line,
      lineWidth: r.lineWidth,
      rounding: r.rounding,
      textColor: r.font.color ?? contrastText(r.fill),
      fontSize: r.font.size ?? DEFAULTS.fontSize,
      fontFamily: r.font.family ?? pal.fontFamily,
      bold: Boolean(r.font.bold),
    };
  };

  for (const s of Object.values(page.shapes)) {
    if (s.type === "Boundary") {
      const r = coveredRect(s.extras.covered ?? [], boxes);
      if (!r) continue; // 盖住的主题全被折叠了：这时不画，比画一个空框对
      out.push({
        id: s.id,
        shapeId: s.id,
        kind: "boundary",
        x: round(r.x0 - OVERLAY_PAD),
        y: round(r.y0 - OVERLAY_PAD),
        w: round(r.x1 - r.x0 + OVERLAY_PAD * 2),
        h: round(r.y1 - r.y0 + OVERLAY_PAD * 2),
        lines: [],
        ...styleOf(s),
      });
      continue;
    }
    if (s.type === "Summary") {
      const ids = s.extras.covered ?? [];
      const r = coveredRect(ids, boxes);
      if (!r) continue;
      const side = coveredSide(ids, boxes);
      const spine = side > 0 ? r.x1 + BRACE_GAP : r.x0 - BRACE_GAP;
      const tip = spine + side * BRACE_TIP;
      const my = round((r.y0 + r.y1) / 2);
      const arm = side * 10;
      const ry = Math.max(4, Math.min(12, (r.y1 - r.y0) / 4));
      out.push({
        id: s.id,
        shapeId: s.id,
        kind: "brace",
        x: round(Math.min(spine, tip) - Math.abs(arm)),
        y: round(r.y0),
        w: round(Math.abs(tip - spine) + Math.abs(arm)),
        h: round(r.y1 - r.y0),
        lines: [],
        // 亿图写的是真曲线括号；这里用两段二次曲线吻出同一个形状，不做几何近似成直线。
        d: [
          `M ${round(spine + arm)} ${round(r.y0)}`,
          `Q ${round(spine)} ${round(r.y0)} ${round(spine)} ${round(r.y0 + ry)}`,
          `L ${round(spine)} ${round(my - ry)}`,
          `Q ${round(spine)} ${my} ${round(tip)} ${my}`,
          `Q ${round(spine)} ${my} ${round(spine)} ${round(my + ry)}`,
          `L ${round(spine)} ${round(r.y1 - ry)}`,
          `Q ${round(spine)} ${round(r.y1)} ${round(spine + arm)} ${round(r.y1)}`,
        ].join(" "),
        ...styleOf(s),
      });
      // 概要主题是 Summary 的孩子（SubLevel/Super），它自己也不在树里，位置由括号尖推出来。
      for (const childId of s.childIds) {
        const label = page.shapes[childId];
        if (!label || label.type !== "SummaryTopic") continue;
        const m = measureShape(label);
        const x = side > 0 ? tip + SUMMARY_GAP : tip - SUMMARY_GAP - m.w;
        out.push({
          id: label.id,
          shapeId: label.id,
          kind: "label",
          x: round(x),
          y: round((r.y0 + r.y1) / 2 - m.h / 2),
          w: m.w,
          h: m.h,
          lines: m.lines,
          ...styleOf(label),
        });
      }
      continue;
    }
  }

  // 标注框挂在主题身上：有文字就按文字量，没文字就是亿图那种序号小圆泡。
  const taken: Rect[] = Object.values(boxes).map((b) => ({
    x0: b.x - b.w / 2,
    y0: b.y - b.h / 2,
    x1: b.x + b.w / 2,
    y1: b.y + b.h / 2,
  }));
  const clash = (r: Rect) =>
    taken.find((o) => o.x0 < r.x1 && r.x0 < o.x1 && o.y0 < r.y1 && r.y0 < o.y1);
  for (const t of Object.values(page.shapes)) {
    const ids = t.extras.calloutIds;
    if (!ids?.length) continue;
    const host = boxes[t.id];
    if (!host) continue;
    const side = host.side === -1 ? -1 : 1;
    // 让开整棵子树：只让开宿主自己那一格的话，标注会盖在它孩子的框上（真机截图里就是这么难看）。
    const below = [t.id, ...descendants(page, t.id)]
      .map((id) => boxes[id])
      .reduce((n, b) => (b ? Math.max(n, b.y + b.h / 2) : n), host.y + host.h / 2);
    let cursor = 0;
    ids.forEach((cid, ix) => {
      const c = page.shapes[cid];
      if (!c) return;
      const text = plainText(c.text);
      const m = measureShape(c);
      const w = text ? m.w : Math.round((c.style.font?.size ?? DEFAULTS.fontSize) * 1.5);
      const h = text ? m.h : w;
      const x =
        side > 0
          ? host.x + host.w / 2 + CALLOUT_GAP + cursor
          : host.x - host.w / 2 - CALLOUT_GAP - w - cursor;
      // 宿主的兄弟主题就在下一行、且和这一列横向重叠，所以让开子树还不够：
      // 布局是定死的、泡是附加物，只能把泡一格一格往下推，直到谁都不压。
      let y = below + CALLOUT_GAP;
      for (let guard = 0; guard < 32; guard++) {
        const hit = clash({ x0: x, y0: y, x1: x + w, y1: y + h });
        if (!hit) break;
        y = hit.y1 + CALLOUT_GAP;
      }
      cursor += w + 4;
      taken.push({ x0: x, y0: y, x1: x + w, y1: y + h });
      out.push({
        id: cid,
        shapeId: cid,
        kind: "callout",
        x: round(x),
        y: round(y),
        w,
        h,
        // 引导线从主题的外下角走到泡的内边（亿图给每条标注都画了这根线）。
        d: `M ${round(side > 0 ? host.x + host.w / 2 : host.x - host.w / 2)} ${round(host.y + host.h / 2)} L ${round(side > 0 ? x : x + w)} ${round(y + h / 2)}`,
        lines: text ? m.lines : [String(ix + 1)],
        ...styleOf(c),
      });
    });
  }
  return out;
}

/**
 * 从盒子中心朝目标点发一条射线，取它穿出矩形边界的交点：
 * 两个系数各自算"要走多少倍才撞到这条边"，取先撞到的那个，锚点因此一定落在框上。
 */
function edgePoint(b: NodeBox, tx: number, ty: number): { x: number; y: number } {
  const dx = tx - b.x;
  const dy = ty - b.y;
  if (dx === 0 && dy === 0) return { x: b.x, y: b.y - b.h / 2 };
  const k = Math.min(
    dx === 0 ? Infinity : b.w / 2 / Math.abs(dx),
    dy === 0 ? Infinity : b.h / 2 / Math.abs(dy)
  );
  return { x: b.x + dx * k, y: b.y + dy * k };
}

export function relationshipPaths(page: Page, boxes: Record<string, NodeBox>): RelationshipPaint[] {
  const out: RelationshipPaint[] = [];
  for (const r of page.relationships) {
    // 端点在布局里不存在（折叠了、或主题被删了）就不画：半条关系线没有意义
    const a = boxes[r.beginId];
    const b = boxes[r.endId];
    if (!a || !b) continue;
    const p0 = edgePoint(a, b.x, b.y);
    const p1 = edgePoint(b, a.x, a.y);
    const vx = p1.x - p0.x;
    const vy = p1.y - p0.y;
    const len = Math.hypot(vx, vy) || 1;
    let nx = -vy / len;
    let ny = vx / len;
    // 统一朝上弯；弦竖直时没有"上"可弯，就固定朝右。两个端点谁在前都只是让法向反一下，
    // 这套挑选规则把它翻回来 —— 同一条关系线换存储顺序也不该弯到另一边去。
    if (ny > 0 || (ny === 0 && nx < 0)) {
      nx = -nx;
      ny = -ny;
    }
    // 下限 24：两个相邻主题之间的弦只有几十像素，按比例弯就只剩一条直直的线，
    // 看着像连线画歪了而不是画在框上（真机截图上就是这么露馅的）。
    const bow = Math.max(24, Math.min(REL_BOW_MAX, len * REL_BOW_RATIO));
    const cx = (p0.x + p1.x) / 2 + nx * bow;
    const cy = (p0.y + p1.y) / 2 + ny * bow;
    out.push({
      id: r.id,
      fromId: r.beginId,
      toId: r.endId,
      d: `M ${round(p0.x)} ${round(p0.y)} Q ${round(cx)} ${round(cy)} ${round(p1.x)} ${round(p1.y)}`,
      dash: r.style.line?.style === "Dashes" ? "6 4" : undefined,
      // 二次曲线 t=0.5 处：(P0 + 2C + P1) / 4
      lx: round((p0.x + 2 * cx + p1.x) / 4),
      ly: round((p0.y + 2 * cy + p1.y) / 4),
      text: plainText(r.text),
      line: resolveColor(r.style.line?.fill?.color) ?? DEFAULTS.lineColor,
      lineWidth: r.style.line?.weight && r.style.line.weight > 0 ? r.style.line.weight : 1.6,
      fontSize: r.style.font?.size ?? DEFAULTS.fontSize,
    });
  }
  return out;
}

/**
 * 盒子按"画它时用的那个字号"来量：字号由样式推导按层级给（中心 14、第四层 10…），
 * 布局自己固定用 DEFAULTS.fontSize 的话，框是按 12 px 撑的、字是按 14 px 画的，
 * 折行会多出几行溢到框外 —— 同一个主题不能有两套字号（P-2）。
 */
function measureOf(
  page: Page,
  shape: Shape,
  palette: ThemePalette,
  fixedWidth?: number
): { w: number; h: number; lines: string[]; stripH: number } {
  return measureShape(shape, {
    fontSize: styleFor(page, shape, palette).font.size,
    fixedWidth,
  });
}

/**
 * "固定框宽"取本页最宽那个主题的宽度：整页对齐到它，比它更长的文字换行。
 * 取本页而不是取常量上限，是因为常量（400）会把两个字的主题也拉成一米宽，
 * 一屏放不下三条分支；本页最宽者至少还是从内容里来的数。
 */
function uniformWidth(page: Page, palette: ThemePalette): number {
  let w: number = DEFAULTS.topicMinW;
  for (const s of Object.values(page.shapes)) {
    if (!isTopic(s.type)) continue;
    w = Math.max(w, measureOf(page, s, palette).w);
  }
  return Math.min(DEFAULTS.topicMaxTextW, w);
}

interface TreeNode {
  id: string;
  shape: Shape;
  level: number;
  branchIx: number;
  children: TreeNode[];
  w: number;
  h: number;
  lines: string[];
  stripH: number;
  x: number;
  y: number;
  side: -1 | 0 | 1;
}

/** 可见树：折叠节点的子树不参与布局；displayLevel 之外的层也不画（"显示层级数"）。 */
function buildTree(
  page: Page,
  id: string,
  level: number,
  branchIx: number,
  displayLevel: number,
  skip: Set<string>,
  palette: ThemePalette,
  fixedWidth?: number
): TreeNode | null {
  const shape = page.shapes[id];
  if (!shape || skip.has(id)) return null;
  const node: TreeNode = {
    id,
    shape,
    level,
    branchIx,
    children: [],
    ...{ x: shape.transform.x, y: shape.transform.y },
    ...{ w: 0, h: 0, lines: [] as string[], stripH: 0 },
    side: 0,
  };
  const m = measureOf(page, shape, palette, fixedWidth);
  node.w = m.w;
  node.h = m.h;
  node.lines = m.lines;
  node.stripH = m.stripH;
  const kids = level + 1 <= displayLevel && !shape.extras.collapsed ? shape.childIds : [];
  let i = 0;
  for (const c of kids) {
    const child = buildTree(
      page,
      c,
      level + 1,
      level === 0 ? i : branchIx,
      displayLevel,
      skip,
      palette,
      fixedWidth
    );
    if (child) {
      child.side = level === 0 ? child.side : node.side;
      node.children.push(child);
      i += 1;
    }
  }
  return node;
}

function walk(nodes: TreeNode[], fn: (n: TreeNode) => void): void {
  for (const n of nodes) {
    fn(n);
    walk(n.children, fn);
  }
}

const hGap = (p: TreeNode, c: TreeNode, s: number) => p.w / 2 + s + c.w / 2;

/**
 * 水平伸展的思维导图：子树占一个垂直"条带"，父节点在条带的垂直中心。
 * dir=1 向右，dir=-1 向左；两侧算法完全镜像，只是 x 变号。
 */
function layoutHorizontalTree(root: TreeNode, spacing: number, dir: 1 | -1): void {
  const place = (node: TreeNode, cursorY: number): number => {
    if (!node.children.length) {
      node.y = cursorY + node.h / 2;
      return node.h;
    }
    let y = cursorY;
    let total = 0;
    for (const c of node.children) {
      const ext = place(c, y);
      y += ext + spacing;
      total += ext + spacing;
    }
    total -= spacing;
    const first = node.children[0];
    const last = node.children[node.children.length - 1];
    node.y = (first.y + last.y) / 2;
    return Math.max(total, node.h);
  };
  const setX = (node: TreeNode, parent: TreeNode | null) => {
    if (!parent) node.x = 0;
    else node.x = parent.x + dir * hGap(parent, node, spacing);
    for (const c of node.children) setX(c, node);
  };
  place(root, -0);
  setX(root, null);
}

/** 竖直伸展的组织结构图 / 树状图：条带变成水平的，父在子节点水平中点上方。 */
function layoutVerticalTree(node: TreeNode, cursorX: number, spacing: number, dir: 1 | -1): number {
  if (!node.children.length) {
    node.x = cursorX + node.w / 2;
    return node.w;
  }
  let x = cursorX;
  let total = 0;
  for (const c of node.children) {
    const ext = layoutVerticalTree(c, x, spacing, dir);
    x += ext + spacing;
    total += ext + spacing;
  }
  total -= spacing;
  node.x = (node.children[0].x + node.children[node.children.length - 1].x) / 2;
  const depth = node.children[0].y - node.y;
  void depth;
  return Math.max(total, node.w);
}

function layoutTreeFamily(root: TreeNode, spacing: number, dir: 1 | -1): void {
  layoutVerticalTree(root, -estimateWidth(root) / 2, spacing, dir);
  const setY = (n: TreeNode, depth: number) => {
    let rowH = n.h;
    for (const c of n.children) rowH = Math.max(rowH, c.h);
    n.y = dir === 1 ? depth * (rowH + spacing) + n.h / 2 : -depth * (rowH + spacing) - n.h / 2;
    for (const c of n.children) setY(c, depth + 1);
  };
  setY(root, 0);
}

/**
 * 树状图的角向式（右下 / 左下 / 右上 / 左上）：像文件目录那样逐级缩进 ——
 * 同一深度共用一列，节点按前序一行一个推进，整枝被推向父节点所在的那个角。
 * 与"对称"式的区别正在这里：对称式把子树摊平在父节点正下方，角向式让父节点
 * 站在自己子树的角上。亿图把这两类当成六个不同的菜单项（_research/extract/qm-cn.tsv
 * Tree Map (Bottom Right) / (Top Left) / (Down) / (Up)），不能共用一套几何。
 */
function layoutTreeCorner(root: TreeNode, spacing: number, sideX: 1 | -1, dirY: 1 | -1): void {
  // 列宽取该深度最宽的那个节点，缩进才不会被下一列吃掉
  const colW: number[] = [];
  const bump = (n: TreeNode) => {
    colW[n.level] = Math.max(colW[n.level] ?? 0, n.w);
    for (const c of n.children) bump(c);
  };
  bump(root);
  const colX: number[] = [];
  let acc = 0;
  for (let d = 0; d < colW.length; d++) {
    colX[d] = acc;
    acc += (colW[d] ?? 0) + spacing;
  }
  let row = 0;
  const walk = (n: TreeNode) => {
    n.x = sideX * (colX[n.level] + n.w / 2);
    n.y = dirY * (row + n.h / 2);
    n.side = n.level === 0 ? 0 : sideX;
    row += n.h + spacing;
    for (const c of n.children) walk(c);
  };
  walk(root);
}

/**
 * 交叉树：也按层分行，但每层不按"父节点居中于自己子树"排，而是先排完所有父节点的第 1 子、
 * 再排第 2 子……父与子必然错位，连线交叉成 X —— 这一族的名字就来自这些交叉线
 * （_research/extract/qm-cn.tsv `MainWindow / Stagger = 交叉树`、`Stagger Up = 交叉树向上`，
 * 蓝本记的是"树形交叉线（非直角连线）"）。错位换来的代价是横向更省：每层宽度只取决于
 * 该层节点数，不像对称树那样被最宽的子树带撑开。
 * 盒子依然严格不压：同层按宽度贪心铺，层间按各自行高 + 间距分隔；交叉的只是线。
 */
function layoutStagger(root: TreeNode, spacing: number, dirY: 1 | -1): void {
  const rows: TreeNode[][] = [[root]];
  for (;;) {
    const last = rows[rows.length - 1];
    const next: TreeNode[] = [];
    const maxKids = Math.max(0, ...last.map((n) => n.children.length));
    for (let i = 0; i < maxKids; i++)
      for (const n of last) next.push(...n.children.slice(i, i + 1));
    if (!next.length) break;
    rows.push(next);
  }
  let acc = 0;
  for (const row of rows) {
    const rowH = Math.max(...row.map((n) => n.h));
    let x = -row.reduce((s, n) => s + n.w + spacing, 0) / 2 + spacing / 2;
    for (const n of row) {
      n.x = x + n.w / 2;
      n.y = dirY * (acc + rowH / 2);
      x += n.w + spacing;
    }
    acc += rowH + spacing;
  }
}

/**
 * spacing 必须显式写成 number：DEFAULTS 是 as const 的，
 * 不标注的话参数会被推成字面量类型 30，调用方传任何别的间距都过不了类型检查。
 */
function estimateWidth(node: TreeNode, spacing: number = DEFAULTS.hSpacing): number {
  if (!node.children.length) return node.w;
  let total = 0;
  for (const c of node.children) total += estimateWidth(c, spacing) + spacing;
  return Math.max(total - spacing, node.w);
}

/**
 * 横向展开（`layoutHorizontalTreeSubtree`）真正吃掉的主轴长度：从自身中心到子树最外缘。
 * estimateWidth 是"兄弟并排"那种展开的量法，用在沿主轴推进的时间线/鱼骨上会短一截
 * （实测 水平时间线 的 A一一 右缘 296.5 撞进 分支C 左缘 293，压框 4x30）。
 */
function forwardReach(node: TreeNode, spacing: number): number {
  let best = node.w / 2;
  for (const c of node.children)
    best = Math.max(best, hGap(node, c, spacing) + forwardReach(c, spacing));
  return best;
}

/** 放射图：按子树"占用角度 = 该层弧长需求"分配角度，半径按层递增（从各自父节点量）。 */
function layoutRadial(root: TreeNode, spacing: number): void {
  root.x = 0;
  root.y = 0;
  const radiusOf = (level: number) => {
    if (level === 0) return 0;
    let r = DEFAULTS.levelLength;
    for (let i = 1; i < level; i += 1) r += spacing * 2 + 60;
    return r;
  };
  const fill = (node: TreeNode, lo: number, hi: number) => {
    if (!node.children.length) return;
    // 权重 = 子树叶子数，保证密集分支拿到更大的扇区，节点不会挤在一起。
    const leaves = (n: TreeNode): number =>
      n.children.length ? n.children.reduce((s, c) => s + leaves(c), 0) : 1;
    const weights = node.children.map(leaves);
    const sum = weights.reduce((s, w) => s + w, 0) || 1;
    let a = lo;
    node.children.forEach((c, i) => {
      const span = ((hi - lo) * weights[i]) / sum;
      const mid = a + span / 2;
      const r = radiusOf(c.level);
      c.x = node.x + Math.cos(mid) * r;
      c.y = node.y + Math.sin(mid) * r;
      fill(c, a, a + span);
      a += span;
    });
  };
  fill(root, -Math.PI, Math.PI);
}

/**
 * 主轴类布局（水平/垂直/S 型时间线、左右鱼骨）。
 * 共同形状：一条 spine 上按序排主分支，每个主分支的子树垂直（或水平）展开在主轴一侧，
 * 差别只在主轴方向、是否交替侧、以及主分支是"贴在轴上"还是"斜着长出去"。
 */
function layoutSpine(
  root: TreeNode,
  spacing: number,
  opts: { axis: "h" | "v"; alternate: boolean; oblique: boolean; dir: 1 | -1 }
): void {
  root.x = 0;
  root.y = 0;
  const kids = root.children;
  // 推进坐标从中心主题的**外缘**起算，不是从圆心：从 0 起步时第一枝的近侧缘会落在
  // 根的对侧缘之内（装机实测 垂直时间线 根底边 17.5、首枝顶边 15），
  // 直角折线于是"从底边出来又折回根框里"。
  let cursor = opts.axis === "h" ? root.w / 2 : root.h / 2;
  kids.forEach((k, i) => {
    const step =
      opts.axis === "h"
        ? k.w / 2 + forwardReach(k, spacing) + spacing
        : estimateHeight(k, spacing) + spacing;
    const center = cursor + step / 2;
    cursor += step;
    // along 是沿主轴推进的坐标，cross 是"离轴多远"。交替与斜刺只能改 cross：
    // 早先两者都写 y，竖直主轴时就把推进坐标抹了回去，一级分支于是叠在同一行上。
    const along = opts.dir === 1 ? center : -center;
    const arm = i % 2 === 0 ? -1 : 1;
    let side = opts.alternate ? (arm as -1 | 1) : opts.dir;
    let cross = 0;
    if (opts.oblique) {
      // 鱼骨：主分支从轴上的锚点斜向出去 45°，子分支再沿骨平行排。
      cross = arm * (Math.abs(along) * 0.42 + 40);
      side = arm as -1 | 1;
    } else if (opts.alternate) {
      cross = arm * ((opts.axis === "h" ? k.h : k.w) / 2 + spacing * 2);
    }
    if (opts.axis === "h") {
      k.x = along;
      k.y = cross;
    } else {
      k.y = along;
      k.x = cross;
    }
    k.side = side;
    // 子树展开方向：竖直主轴时外侧就是左右，`side`（交替/斜刺的偏移符号）正好能用，
    // 所以竖直主轴也用横向展开的子树函数（早先按 axis 选函数，等于把一级分支的左右符号
    // 当成上下符号用，子枝会顶到中心主题上）。
    // 水平主轴反过来不行：那里的 `side` 是上下符号，拿它当左右用会把子枝甩回根框那一侧
    // （实测 水平时间线 的 A一/A二 落在 x=-30，压住根框 31x16），得沿主轴向前 `dir` 展开。
    layoutHorizontalTreeSubtree(k, opts.axis === "h" ? opts.dir : k.side, spacing);
  });
}

/**
 * side 只当左右符号用（乘在 hGap 上）。TreeNode.side 的类型含 0（中心主题），
 * 而调用点传的就是 node.side，所以签名接住 0 而不是在调用处强转成 ±1。
 */
function layoutHorizontalTreeSubtree(node: TreeNode, side: -1 | 0 | 1, spacing: number): void {
  const place = (n: TreeNode, cursorY: number): number => {
    if (!n.children.length) {
      n.y = cursorY + n.h / 2;
      return n.h;
    }
    let y = cursorY;
    let total = 0;
    for (const c of n.children) {
      const ext = place(c, y);
      y += ext + spacing;
      total += ext + spacing;
    }
    total -= spacing;
    n.y = (n.children[0].y + n.children[n.children.length - 1].y) / 2;
    return Math.max(total, n.h);
  };
  const top = node.y - node.h / 2;
  const ext = place(node, top);
  void ext;
  const setX = (n: TreeNode, parent: TreeNode) => {
    n.x = parent.x + side * hGap(parent, n, spacing);
    for (const c of n.children) setX(c, n);
  };
  // 曾经写成 setX(c, c)：函数体第一行就是 n.x = parent.x + …，自己当自己的父节点，
  // 每个子节点被平白多推了一格（自身宽 + 间距），子树因此压到下一个主分支身上。
  for (const c of node.children) setX(c, node);
}

/** 同 estimateWidth：spacing 要显式 number，否则推成 DEFAULTS 的字面量类型。 */
function estimateHeight(node: TreeNode, spacing: number = DEFAULTS.vSpacing): number {
  if (!node.children.length) return node.h;
  let total = 0;
  for (const c of node.children) total += estimateHeight(c, spacing) + spacing;
  return Math.max(total - spacing, node.h);
}

/** 矩阵图：4 个主分支落进 2×2 象限，更深一层用水平树贴着象限外沿展开。 */
function layoutMatrix(root: TreeNode, spacing: number): void {
  root.x = 0;
  root.y = 0;
  const quadrant = [
    { x: 1, y: -1 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
    { x: -1, y: -1 },
  ];
  root.children.forEach((k, i) => {
    const q = quadrant[i % 4];
    const offset = DEFAULTS.levelLength * 1.4;
    k.side = q.x as -1 | 1;
    if (i >= 4) {
      // 超过 4 个主分支：往同一象限外侧继续堆，避免直接重叠
      const ring = Math.floor(i / 4);
      k.x = q.x * (offset + ring * 360);
      k.y = q.y * (offset + ring * 220);
    } else {
      k.x = q.x * offset;
      k.y = q.y * offset;
    }
    layoutHorizontalTreeSubtree(k, k.side, spacing);
  });
}

/** 括号图：主分支纵向排成一列，各自用水平树向右（或左）展开，中间由括号连接。 */
function layoutBrace(root: TreeNode, spacing: number, dir: 1 | -1): void {
  layoutVerticalBraceColumn(root, spacing, dir);
}

function layoutVerticalBraceColumn(node: TreeNode, spacing: number, dir: 1 | -1): void {
  const place = (n: TreeNode, cursorY: number): number => {
    if (!n.children.length) {
      n.y = cursorY + n.h / 2;
      return n.h;
    }
    let y = cursorY;
    let total = 0;
    for (const c of n.children) {
      const ext = place(c, y);
      y += ext + spacing;
      total += ext + spacing;
    }
    total -= spacing;
    n.y = (n.children[0].y + n.children[n.children.length - 1].y) / 2;
    return Math.max(total, n.h);
  };
  place(node, -estimateHeight(node, spacing) / 2);
  const setX = (n: TreeNode, parent: TreeNode | null) => {
    if (parent) n.x = parent.x + dir * hGap(parent, n, spacing);
    for (const c of n.children) setX(c, n);
  };
  node.x = 0;
  for (const c of node.children) {
    c.side = dir;
    c.x = dir * (node.w / 2 + spacing * 2 + c.w / 2);
    setX(c, c);
  }
}

/** 圆形图：与放射图同构，只是半径按"该层最宽节点"堆叠，节点画成圆。 */
function layoutCircle(root: TreeNode, spacing: number): void {
  layoutRadial(root, spacing * 2);
}

/**
 * 绕圈一族（扇形放射图 / 思维导图顺逆时针）：**以中心主题为圆心的同心环** + 一段角区间。
 * 不能沿用 `layoutRadial` 的"半径从各自父节点量"：那是一串链式偏移，越深越往一个方向甩，
 * 装机目检出来是一坨斜着的串，不是扇形（扇形的定义就是同一层的主题踩在同一道弧上）——
 * 顺时针那两码第一版就是踩的同一个坑，二三级直接甩出画布外。
 * 扇区仍按子树叶子数加权分配，所以密集分支占的弧更长，同环上不会挤到一起。
 * 跨度写成正的是顺时针、负的是逆时针（从 12 点起算），半圈就是扇形。
 */
function layoutRingFan(root: TreeNode, spacing: number, a0: number, a1: number): void {
  root.x = 0;
  root.y = 0;
  const radiusOf = (level: number) => DEFAULTS.levelLength + (level - 1) * (spacing * 2 + 90);
  const leaves = (n: TreeNode): number =>
    n.children.length ? n.children.reduce((s, c) => s + leaves(c), 0) : 1;
  const put = (node: TreeNode, lo: number, hi: number) => {
    if (!node.children.length) return;
    const weights = node.children.map(leaves);
    const sum = weights.reduce((s, w) => s + w, 0) || 1;
    let a = lo;
    node.children.forEach((c, i) => {
      const span = ((hi - lo) * weights[i]) / sum;
      const mid = a + span / 2;
      const r = radiusOf(c.level);
      c.x = Math.cos(mid) * r;
      c.y = Math.sin(mid) * r;
      put(c, a, a + span);
      a += span;
    });
  };
  put(root, a0, a1);
}

export interface LayoutInput {
  /** "显示层级数"：超过这个层级的节点不布局（1..9）。 */
  displayLevel?: number;
  /** 只布局选中的主分支（下钻）。 */
  only?: string[];
  /** 字号来自主题样式，布局要和绘制用同一份色板，否则盒子量得比画出来的字小。 */
  palette?: ThemePalette;
  /** 主题框宽：fixed 把整页对齐到同一个宽度。 */
  topicWidthMode?: "auto" | "fixed";
}

export function computeLayout(page: Page, input: LayoutInput = {}): LayoutResult {
  const displayLevel = input.displayLevel ?? 9;
  const palette = input.palette ?? defaultPalette();
  const skip = new Set(input.only ? collectOutside(page, input.only) : []);
  const fixedW = input.topicWidthMode === "fixed" ? uniformWidth(page, palette) : undefined;
  const root = buildTree(page, page.rootId, 0, -1, displayLevel, skip, palette, fixedW);
  const boxes: Record<string, NodeBox> = {};
  const order: string[] = [];
  if (!root)
    return {
      boxes,
      order,
      connectors: [],
      axis: null,
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      width: 0,
      height: 0,
    };

  const s = page.layout;
  const hs = s.hSpacing || DEFAULTS.hSpacing;
  const vs = s.vSpacing || DEFAULTS.vSpacing;

  if (page.layout.code !== "free") {
    // 主分支先定侧：双向平衡按 "右左交替" 分配，其余布局由各自的 spine 决定。
    const halves = splitSides(root, s.code);
    halves.right.forEach((n) => {
      n.side = 1;
    });
    halves.left.forEach((n) => {
      n.side = -1;
    });

    switch (s.code) {
      case "balanced": {
        layoutHorizontalTreeWith(root, hs, halves);
        break;
      }
      case "balancedDown": {
        layoutBalancedDown(root, halves, vs);
        break;
      }
      case "logicRight":
      case "rightOnly":
      case "braceRight": {
        if (s.code === "braceRight") layoutBrace(root, hs, 1);
        else layoutHorizontalTree(root, hs, 1);
        break;
      }
      case "logicLeft":
      case "braceLeft": {
        if (s.code === "braceLeft") layoutBrace(root, hs, -1);
        else layoutHorizontalTree(root, hs, -1);
        break;
      }
      case "treeRight":
        layoutTreeCorner(root, vs, 1, 1);
        break;
      case "treeLeft":
        layoutTreeCorner(root, vs, -1, 1);
        break;
      case "treeUpRight":
        layoutTreeCorner(root, vs, 1, -1);
        break;
      case "treeUpLeft":
        layoutTreeCorner(root, vs, -1, -1);
        break;
      case "treeDownSym":
      case "orgDown": {
        layoutTreeFamily(root, vs, 1);
        break;
      }
      case "treeUpSym":
      case "orgUp": {
        layoutTreeFamily(root, vs, -1);
        break;
      }
      case "orgBoth": {
        const up = root.children.filter((_, i) => i % 2 === 1);
        const down = root.children.filter((_, i) => i % 2 === 0);
        layoutTreeFamilySide(root, down, up, vs);
        break;
      }
      case "stagger": {
        layoutStagger(root, vs, 1);
        break;
      }
      case "staggerUp": {
        layoutStagger(root, vs, -1);
        break;
      }
      case "radial":
      case "circlePacking": {
        layoutCircle(root, vs);
        break;
      }
      case "logicClockwise": {
        // 整圈同心环，起点 12 点、按文档序顺时针铺开
        layoutRingFan(root, vs, -Math.PI / 2, Math.PI * 1.5);
        break;
      }
      case "logicCounterclockwise": {
        // 负跨度 = 逆时针：一整圈要走到 -450°（-π/2 - 2π），写成 -3π/2 就只剩半圈，
        // 镜像也不再成立。角度分配公式不必写第二套。
        layoutRingFan(root, vs, -Math.PI / 2, -Math.PI * 2.5);
        break;
      }
      case "sunburst": {
        layoutRingFan(root, vs, -Math.PI, 0);
        break;
      }
      case "fishboneLeft": {
        layoutSpine(root, hs, { axis: "h", alternate: false, oblique: true, dir: -1 });
        break;
      }
      case "fishboneRight": {
        layoutSpine(root, hs, { axis: "h", alternate: false, oblique: true, dir: 1 });
        break;
      }
      case "timelineHorizontal": {
        layoutSpine(root, hs, { axis: "h", alternate: true, oblique: false, dir: 1 });
        break;
      }
      case "timelineLeft": {
        layoutSpine(root, hs, { axis: "h", alternate: true, oblique: false, dir: -1 });
        break;
      }
      case "timelineVertical": {
        layoutSpine(root, vs, { axis: "v", alternate: true, oblique: false, dir: 1 });
        break;
      }
      case "timelineUp": {
        layoutSpine(root, vs, { axis: "v", alternate: true, oblique: false, dir: -1 });
        break;
      }
      case "timelineWinding": {
        layoutWinding(root, hs, vs);
        break;
      }
      case "matrix": {
        layoutMatrix(root, hs);
        break;
      }
      case "free":
        break;
    }
  }

  const collect = (n: TreeNode) => {
    boxes[n.id] = {
      id: n.id,
      x: Math.round(n.x),
      y: Math.round(n.y),
      w: n.w,
      h: n.h,
      level: n.level,
      parentId: n.shape.parentId,
      branchIx: n.branchIx,
      side: n.side,
      lines: n.lines,
      stripH: n.stripH,
    };
    order.push(n.id);
  };
  walk([root], collect);
  // 浮动主题（P-2 的例外）：根位置是用户拖出来的，整枝子树往右下堆。
  // 层级判据与 buildTree 一致 —— 浮动根自己算第 0 层，displayLevel 管它下面还能看几层；
  // 必须递归到底：只铺一层子的话，孙主题在大纲/看板/甘特里数得到，画布和 SVG 里却没有盒子（P-1）。
  const floatKids = (id: string, level: number): string[] => {
    const sh = page.shapes[id];
    if (!sh || sh.extras.collapsed || level + 1 > displayLevel) return [];
    return sh.childIds.filter((c) => page.shapes[c] && !skip.has(c));
  };
  // 每一枝占用的纵向高度：自己的盒子，或子树堆叠高度，取大者。
  const slotH = new Map<string, number>();
  const extentOf = (id: string, level: number): number => {
    const kids = floatKids(id, level);
    let sum = 0;
    kids.forEach((c, i) => {
      sum += extentOf(c, level + 1) + (i > 0 ? vs : 0);
    });
    const e = Math.max(measureOf(page, page.shapes[id], palette, fixedW).h, sum);
    slotH.set(id, e);
    return e;
  };
  const placeFloat = (id: string, level: number, leftX: number, topY: number): void => {
    const sh = page.shapes[id];
    const m = measureOf(page, sh, palette, fixedW);
    const kids = floatKids(id, level);
    let group = 0;
    kids.forEach((c, i) => {
      group += (slotH.get(c) ?? 0) + (i > 0 ? vs : 0);
    });
    const slot = Math.max(m.h, group);
    boxes[id] = {
      id,
      x: leftX + m.w / 2,
      y: topY + slot / 2,
      w: m.w,
      h: m.h,
      level,
      parentId: sh.parentId,
      branchIx: -1,
      side: 1,
      lines: m.lines,
      stripH: m.stripH,
    };
    order.push(id);
    let cursor = topY + (slot - group) / 2;
    for (const c of kids) {
      placeFloat(c, level + 1, leftX + m.w + hs, cursor);
      cursor += (slotH.get(c) ?? 0) + vs;
    }
  };
  for (const sh of Object.values(page.shapes)) {
    if (!sh.floating || boxes[sh.id] || skip.has(sh.id)) continue;
    const m = measureOf(page, sh, palette, fixedW);
    const w = m.w || sh.transform.w;
    const h = m.h || sh.transform.h;
    boxes[sh.id] = {
      id: sh.id,
      x: sh.transform.x,
      y: sh.transform.y,
      w,
      h,
      level: 0,
      parentId: sh.parentId,
      branchIx: -1,
      side: 0,
      lines: m.lines,
      stripH: m.stripH,
    };
    order.push(sh.id);
    // 浮动根的组顶在自己的下沿外侧：先把每枝的占位高度算好，placeFloat 只查表。
    const kids = floatKids(sh.id, 0);
    for (const c of kids) extentOf(c, 1);
    let cursor = sh.transform.y + h / 2 + vs / 2;
    for (const c of kids) {
      placeFloat(c, 1, sh.transform.x + w / 2 + hs, cursor);
      cursor += (slotH.get(c) ?? 0) + vs;
    }
  }

  const connectors = buildConnectors(page, boxes, s.code);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of Object.values(boxes)) {
    minX = Math.min(minX, b.x - b.w / 2);
    maxX = Math.max(maxX, b.x + b.w / 2);
    minY = Math.min(minY, b.y - b.h / 2);
    maxY = Math.max(maxY, b.y + b.h / 2);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }
  const pad = 40;
  return {
    boxes,
    order,
    connectors,
    axis: buildAxis(page, boxes, s.code, palette),
    bounds: { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad },
    width: Math.max(1, maxX - minX + pad * 2),
    height: Math.max(1, maxY - minY + pad * 2),
  };
}

/**
 * 切进自由布局：把此刻算出来的位置当成用户位置写回 transform。
 * 自由布局的坐标是唯一由用户说了算的一份（P-2 的正式版，而不只是浮动根），
 * 而本地新建的主题 transform 全是 (0,0) —— 不先钉一份，一进这一版整张图就叠回原点。
 *
 * 被折叠或"显示层级"挡在布局外的主题也要一起钉：它们此刻看不见，
 * 但用户回头放开层级时，没有位置的主题会全叠在中心主题上。
 */
export function toFreeLayout(page: Page, input: LayoutInput = {}): Page {
  if (page.layout.code === "free") return page;
  const { boxes } = computeLayout(page, input);
  const pos = new Map<string, { x: number; y: number }>();
  for (const [id, b] of Object.entries(boxes)) pos.set(id, { x: b.x, y: b.y });
  if (!pos.has(page.rootId)) return { ...page, layout: { ...page.layout, code: "free" } };
  const spill = (id: string) => {
    const s = page.shapes[id];
    if (!s || s.floating) return; // 浮动子树的位置由浮动根现算，transform 用不上
    const at = pos.get(id)!;
    s.childIds.forEach((c, i) => {
      if (!pos.has(c))
        pos.set(c, {
          x: at.x + DEFAULTS.levelLength,
          y: at.y + i * (DEFAULTS.topicMinH + DEFAULTS.vSpacing),
        });
      spill(c);
    });
  };
  spill(page.rootId);
  const shapes: Record<string, Shape> = { ...page.shapes };
  for (const [id, p] of pos) {
    const s = shapes[id];
    if (s) shapes[id] = { ...s, transform: { ...s.transform, x: p.x, y: p.y } };
  }
  return { ...page, shapes, layout: { ...page.layout, code: "free" } };
}

function collectOutside(page: Page, keep: string[]): string[] {
  const allow = new Set<string>();
  for (const id of keep) {
    for (const d of [id, ...descendantsOf(page, id)]) allow.add(d);
    for (const a of ancestorsOf(page, id)) allow.add(a);
  }
  return Object.keys(page.shapes).filter((id) => !allow.has(id));
}

function descendantsOf(page: Page, id: string): string[] {
  const out: string[] = [];
  const walk2 = (cur: string) => {
    for (const c of page.shapes[cur]?.childIds ?? []) {
      out.push(c);
      walk2(c);
    }
  };
  walk2(id);
  return out;
}

function ancestorsOf(page: Page, id: string): string[] {
  const out: string[] = [];
  let cur = page.shapes[id]?.parentId ?? null;
  while (cur) {
    out.push(cur);
    cur = page.shapes[cur]?.parentId ?? null;
    if (out.length > 4096) break;
  }
  return out;
}

/** 双向平衡系的主分支分侧：右先、左右交替，右侧拿奇偶中的前半 —— 与 MindMaster 默认观感一致。 */
function splitSides(root: TreeNode, code: LayoutCode): { right: TreeNode[]; left: TreeNode[] } {
  const kids = root.children;
  if (code !== "balanced" && code !== "balancedDown") return { right: kids, left: [] };
  const rightCount = Math.ceil(kids.length / 2);
  return { right: kids.slice(0, rightCount), left: kids.slice(rightCount) };
}

function layoutHorizontalTreeWith(
  root: TreeNode,
  spacing: number,
  halves: { right: TreeNode[]; left: TreeNode[] }
): void {
  const stackHeights = (nodes: TreeNode[]): number =>
    nodes.reduce((s, n) => s + estimateHeight(n, spacing) + spacing, 0) -
    (nodes.length ? spacing : 0);

  const runSide = (nodes: TreeNode[], dir: 1 | -1, cursorY: number) => {
    let y = cursorY;
    for (const n of nodes) {
      n.side = dir;
      const ext = placeSubtree(n, y, spacing, dir);
      y += ext + spacing;
    }
  };

  const rightH = Math.max(stackHeights(halves.right), root.h);
  const leftH = Math.max(stackHeights(halves.left), root.h);
  const totalTop = -Math.max(rightH, leftH) / 2;
  runSide(halves.right, 1, totalTop);
  runSide(halves.left, -1, totalTop);
  root.x = 0;
  const first = halves.right[0] ?? halves.left[0];
  const last = halves.right[halves.right.length - 1] ?? halves.left[halves.left.length - 1];
  if (first && last) root.y = (Math.min(first.y, last.y) + Math.max(first.y, last.y)) / 2;
  else root.y = 0;
  void layoutHorizontalTree;
}

function placeSubtree(node: TreeNode, cursorY: number, spacing: number, dir: 1 | -1): number {
  const place = (n: TreeNode, y: number): number => {
    if (!n.children.length) {
      n.y = y + n.h / 2;
      return n.h;
    }
    let cur = y;
    let total = 0;
    for (const c of n.children) {
      const ext = place(c, cur);
      cur += ext + spacing;
      total += ext + spacing;
    }
    total -= spacing;
    n.y = (n.children[0].y + n.children[n.children.length - 1].y) / 2;
    return Math.max(total, n.h);
  };
  const ext = place(node, cursorY);
  const setX = (n: TreeNode, parent: TreeNode | null) => {
    if (parent) n.x = parent.x + dir * hGap(parent, n, spacing);
    for (const c of n.children) setX(c, n);
  };
  const anchorX = dir * (node.w / 2 + spacing);
  node.x = anchorX;
  for (const c of node.children) {
    c.x = node.x + dir * hGap(node, c, spacing);
    setX(c, c);
  }
  return ext;
}

/** 组织结构图（上下双向）：主分支分上下两列，各自水平树展开。 */
function layoutTreeFamilySide(
  root: TreeNode,
  down: TreeNode[],
  up: TreeNode[],
  spacing: number
): void {
  root.x = 0;
  root.y = 0;
  // 上下双向是"根在中间，两排分支一上一下"：一级分支要从中心主题的外缘起算，
  // 从根的圆心起算就把分支摞进中心主题自己的框里（实测重叠 25x18）。
  const inset = root.h / 2 + spacing;
  const row = (nodes: TreeNode[], dir: 1 | -1) => {
    let cursor = 0;
    const widths = nodes.map((n) => estimateWidth(n, spacing));
    const total = widths.reduce((s, w) => s + w + spacing, 0) - (nodes.length ? spacing : 0);
    cursor = -total / 2;
    nodes.forEach((n, i) => {
      const w = widths[i];
      layoutVerticalTree(n, cursor, spacing, dir);
      const center = cursor + w / 2;
      cursor += w + spacing;
      n.side = dir as -1 | 1;
      assignSubtreeY(n, center, dir, spacing, inset);
    });
  };
  row(down, 1);
  row(up, -1);
}

function assignSubtreeY(
  node: TreeNode,
  centerX: number,
  dir: 1 | -1,
  spacing: number,
  inset: number
): void {
  const shift = centerX - node.x;
  const move = (n: TreeNode) => {
    n.x += shift;
    for (const c of n.children) move(c);
  };
  move(node);
  const setY = (n: TreeNode, depth: number) => {
    const rowH = Math.max(n.h, ...n.children.map((c) => c.h));
    n.y = dir * (inset + depth * (rowH + spacing) + n.h / 2);
    for (const c of n.children) setY(c, depth + 1);
  };
  setY(node, 0);
}

/**
 * 双向平衡向下：主分支照"双向平衡"分左右的办法切成两半（splitSides），但两半都朝下展开，
 * 各自成一条组织结构图条带 —— 名字里的"双向"是分两侧，"向下"是生长方向。
 * 与 组织结构图（上下双向） 的分别是哪一半朝下（那是一上一下）、与 双向平衡 的分别是往哪儿长
 * （那是左右铺开）。三条都复用同一套条带几何，只是 dir/side/inset 的组合不同。
 * 左半的分支序被倒过来排：靠中心主题的那一侧才是文档序的第一条，读起来才与右半对称。
 */
function layoutBalancedDown(
  root: TreeNode,
  halves: { right: TreeNode[]; left: TreeNode[] },
  spacing: number
): void {
  root.x = 0;
  root.y = 0;
  // 一级分支的上沿要从中心主题的底边起算，从圆心起就把分支摞进根框自己（orgBoth 实测压住 25x18）
  const inset = root.h / 2 + spacing;
  const widthOf = (nodes: TreeNode[]) =>
    nodes.reduce((s, n) => s + estimateWidth(n, spacing) + spacing, 0) -
    (nodes.length ? spacing : 0);
  const band = (nodes: TreeNode[], start: number, side: 1 | -1) => {
    let cursor = start;
    for (const n of nodes) {
      const w = estimateWidth(n, spacing);
      layoutVerticalTree(n, cursor, spacing, 1);
      assignSubtreeY(n, cursor + w / 2, 1, spacing, inset);
      n.side = side;
      cursor += w + spacing;
    }
  };
  // 两半之间留出间距：条带各自贴到 x=0 会肩并肩挤成一条缝
  const gap = spacing / 2;
  band(halves.right, gap, 1);
  band([...halves.left].reverse(), -(widthOf(halves.left) + gap), -1);
}

/** S 型时间线：主轴按列折返，每列内部竖直排主分支。 */
function layoutWinding(root: TreeNode, hs: number, vs: number): void {
  const perCol = Math.max(2, Math.ceil(root.children.length / 3));
  const colW = 420;
  root.x = 0;
  root.y = 0;
  root.children.forEach((k, i) => {
    const col = Math.floor(i / perCol);
    const rowIx = i % perCol;
    const reverse = col % 2 === 1;
    const y = (reverse ? perCol - 1 - rowIx : rowIx) * (140 + vs);
    k.x = col * colW + colW / 2;
    k.y = y - ((perCol - 1) * (140 + vs)) / 2;
    k.side = 1;
    layoutHorizontalTreeSubtree(k, 1, hs);
  });
}

/**
 * 连线：分支线在思维导图里是曲线，在树/组织结构图里是直角折线。
 * page 参数用不上（父子关系已经进了 NodeBox.parentId），但它是本模块导出的签名，
 * 下划线保留形参位而不是删掉，免得外部调用方跟着改。
 */
/** 角向树的两个轴向往：横线从父列伸进子框的近侧缘，竖线贴着父列往下（上）走。 */
const CORNER_LAYOUTS: Partial<Record<LayoutCode, { sideX: 1 | -1; dirY: 1 | -1 }>> = {
  treeRight: { sideX: 1, dirY: 1 },
  treeLeft: { sideX: -1, dirY: 1 },
  treeUpRight: { sideX: 1, dirY: -1 },
  treeUpLeft: { sideX: -1, dirY: -1 },
};

function cornerPath(p: NodeBox, c: NodeBox, sideX: 1 | -1, dirY: 1 | -1): string {
  const y1 = p.y + (dirY * p.h) / 2;
  const x2 = c.x - (sideX * c.w) / 2;
  return `M ${round(p.x)} ${round(y1)} L ${round(p.x)} ${round(c.y)} L ${round(x2)} ${round(c.y)}`;
}

/**
 * 上下生长的树/组织结构图：子树整体在父框的上方或下方，连线必须竖着进出，
 * 用横向折线会把斜线带进来（实测 树状图（向下对称） 的连线中间是一段斜线）。
 * 双向平衡向下 名字属于"平衡"一族，几何却是两条向下的条带，所以归这里而不是曲线。
 */
const DOWN_UP_LAYOUTS: LayoutCode[] = [
  "treeDownSym",
  "treeUpSym",
  "orgUp",
  "orgDown",
  "orgBoth",
  "balancedDown",
];

/** 竖直主轴的时间轴：一级分支竖着进出、更深的子主题横着出去，是折线/曲线的混用族。 */
const VERTICAL_SPINE_TIMELINES: LayoutCode[] = ["timelineVertical", "timelineUp"];

/**
 * 交叉树两码：一条直线从父框穿到子框。线线交叉是这一族的目的，不是缺陷 ——
 * 层内错位排布（layoutStagger）让父与子对不上号，直角折线会把这种错位抹平成迷宫。
 */
const SLANT_LAYOUTS: LayoutCode[] = ["stagger", "staggerUp"];

export function buildConnectors(
  _page: Page,
  boxes: Record<string, NodeBox>,
  code: LayoutCode
): ConnectorPath[] {
  const out: ConnectorPath[] = [];
  const elbow = code.startsWith("tree") || code.startsWith("org") || code === "matrix";
  const slant = SLANT_LAYOUTS.includes(code);
  const corner = CORNER_LAYOUTS[code];
  for (const b of Object.values(boxes)) {
    if (!b.parentId) continue;
    const p = boxes[b.parentId];
    if (!p) continue;
    // 只有两条规则需要特判：
    // ① 垂直时间轴是折线走向的混合体 —— 一级分支从轴上"往下探"（竖折线），
    //    挂在一级分支外侧的子主题却是横着长出去的（走曲线），一套规则盖不住两种走向；
    // ② 上下生长的树/组织结构图必须竖着进出（见 DOWN_UP_LAYOUTS）。
    // 水平时间线与 S 型时间线整族走曲线：主轴本身横着推进，折线反而会把线拧回父框里。
    const vertical = VERTICAL_SPINE_TIMELINES.includes(code)
      ? b.level === 1
      : DOWN_UP_LAYOUTS.includes(code);
    out.push({
      id: `c-${b.parentId}-${b.id}`,
      fromId: p.id,
      toId: b.id,
      side: b.side,
      d: corner
        ? cornerPath(p, b, corner.sideX, corner.dirY)
        : slant
          ? slantPath(p, b)
          : vertical || elbow
            ? elbowPath(p, b, vertical)
            : curvePath(p, b),
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** 画得出主轴的版式：一条直线穿过一级分支的锚点，末端一个开口箭头。 */
const AXIS_SPINE: Partial<Record<LayoutCode, { axis: "h" | "v"; dir: 1 | -1 }>> = {
  timelineHorizontal: { axis: "h", dir: 1 },
  timelineLeft: { axis: "h", dir: -1 },
  timelineVertical: { axis: "v", dir: 1 },
  timelineUp: { axis: "v", dir: -1 },
  fishboneRight: { axis: "h", dir: 1 },
  fishboneLeft: { axis: "h", dir: -1 },
};

export interface AxisPath {
  /** 轴身。 */
  d: string;
  /** 末端箭头：两条短线，不用 marker —— 导出与打印要拿到同一份 path。 */
  head: string;
  line: string;
}

/**
 * 主轴类版式的轴：从中心主题的前缘起，伸过最后一个一级分支的远侧缘。
 * S 形时间线不在这里 —— 它的主轴本身要折返，一条直线盖不住。
 */
export function buildAxis(
  page: Page,
  boxes: Record<string, NodeBox>,
  code: LayoutCode,
  palette: ThemePalette
): AxisPath | null {
  const spine = AXIS_SPINE[code];
  if (!spine) return null;
  const list = Object.values(boxes);
  const root = list.find((b) => b.level === 0);
  const kids = list.filter((b) => b.level === 1);
  if (!root || !kids.length) return null;
  const d = spine.dir;
  const at = (b: NodeBox) => (spine.axis === "h" ? b.x : b.y);
  const span = (b: NodeBox) => (spine.axis === "h" ? b.w : b.h) / 2;
  // 先把坐标折成"沿主轴向前"的正数，四个方向就是同一条公式
  const from = at(root) * d + span(root);
  const to = Math.max(...kids.map((b) => at(b) * d + span(b))) + 16;
  const cross = spine.axis === "h" ? root.y : root.x;
  const pt = (along: number, c: number) =>
    spine.axis === "h" ? `${round(along) * d} ${round(c)}` : `${round(c)} ${round(along) * d}`;
  const shape = page.shapes[root.id];
  return {
    d: `M ${pt(from, cross)} L ${pt(to, cross)}`,
    head: `M ${pt(to - 9, cross - 5)} L ${pt(to, cross)} L ${pt(to - 9, cross + 5)}`,
    line: shape ? styleFor(page, shape, palette).line : DEFAULTS.lineColor,
  };
}

function curvePath(p: NodeBox, c: NodeBox): string {
  const dir = c.x === p.x ? 1 : Math.sign(c.x - p.x);
  const x1 = p.x + (dir * p.w) / 2;
  const y1 = p.y;
  const x2 = c.x - (dir * c.w) / 2;
  const y2 = c.y;
  if (x1 === x2 && y1 === y2) return `M ${x1} ${y1}`;
  const mx = (x1 + x2) / 2;
  return `M ${round(x1)} ${round(y1)} C ${round(mx)} ${round(y1)} ${round(mx)} ${round(y2)} ${round(x2)} ${round(y2)}`;
}

/** 交叉树的连线：父框近侧边中点直穿到子框近侧边中点，一条线段，没有拐点。 */
function slantPath(p: NodeBox, c: NodeBox): string {
  const dir = Math.sign(c.y - p.y) || 1;
  return `M ${round(p.x)} ${round(p.y + (dir * p.h) / 2)} L ${round(c.x)} ${round(c.y - (dir * c.h) / 2)}`;
}

function elbowPath(p: NodeBox, c: NodeBox, vertical: boolean): string {
  if (vertical) {
    // 进出方向跟着"子节点在父节点的哪一侧"：向上生长的组织结构图得从父框顶边出、子框底边进，
    // 写死底边出顶边进会把线穿进父框自己。
    const dir = Math.sign(c.y - p.y) || 1;
    const y1 = p.y + (dir * p.h) / 2;
    const y2 = c.y - (dir * c.h) / 2;
    const my = (y1 + y2) / 2;
    return `M ${round(p.x)} ${round(y1)} L ${round(p.x)} ${round(my)} L ${round(c.x)} ${round(my)} L ${round(c.x)} ${round(y2)}`;
  }
  const dir = Math.sign(c.x - p.x) || 1;
  const x1 = p.x + (dir * p.w) / 2;
  const y1 = p.y;
  const x2 = c.x - (dir * c.w) / 2;
  const y2 = c.y;
  const mx = (x1 + x2) / 2;
  return `M ${round(x1)} ${round(y1)} L ${round(mx)} ${round(y1)} L ${round(mx)} ${round(y2)} L ${round(x2)} ${round(y2)}`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 影响布局的几项参数，变了才需要重算。 */
export function layoutSignature(page: Page): string {
  const l = page.layout;
  return [l.code, l.hSpacing, l.vSpacing, l.rainbow ? 1 : 0].join("|");
}
