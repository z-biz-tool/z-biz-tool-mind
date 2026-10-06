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
import { isTopic } from "../types/model.ts";
import { DEFAULTS } from "../model/constants.ts";
import { defaultPalette, styleFor, type ThemePalette } from "./style.ts";

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
): { w: number; h: number; lines: string[] } {
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
  const marks = (extras.marks?.length ?? 0) > 0;
  const labels = (extras.labels?.length ?? 0) > 0;
  if (marks || labels) h += fontSize * 0.9;
  if (extras.image) {
    w = Math.max(w, (extras.image.width ?? 64) + DEFAULTS.topicPadX * 2);
    h += (extras.image.height ?? 64) + 6;
  }
  if (extras.table) h += extras.table.rows * fontSize * 1.6;
  if (extras.attachments?.length) h += fontSize * 0.9;
  if (extras.note) w += 6;
  return { w: Math.round(w), h: Math.round(h), lines };
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
): { w: number; h: number; lines: string[] } {
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
    ...{ w: 0, h: 0, lines: [] as string[] },
    side: 0,
  };
  const m = measureOf(page, shape, palette, fixedWidth);
  node.w = m.w;
  node.h = m.h;
  node.lines = m.lines;
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
const vGap = (p: TreeNode, c: TreeNode, s: number) => p.h / 2 + s + c.h / 2;

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
 * spacing 必须显式写成 number：DEFAULTS 是 as const 的，
 * 不标注的话参数会被推成字面量类型 30，调用方传任何别的间距都过不了类型检查。
 */
function estimateWidth(node: TreeNode, spacing: number = DEFAULTS.hSpacing): number {
  if (!node.children.length) return node.w;
  let total = 0;
  for (const c of node.children) total += estimateWidth(c, spacing) + spacing;
  return Math.max(total - spacing, node.w);
}

/** 放射图：按子树"占用角度 = 该层弧长需求"分配角度，半径按层递增。 */
function layoutRadial(root: TreeNode, spacing: number): void {
  root.x = 0;
  root.y = 0;
  const radiusOf = (level: number) => {
    if (level === 0) return 0;
    let r = DEFAULTS.levelLength;
    for (let i = 1; i < level; i += 1) r += spacing * 2 + 60;
    return r;
  };
  const fill = (node: TreeNode, a0: number, a1: number) => {
    if (!node.children.length) return;
    // 权重 = 子树叶子数，保证密集分支拿到更大的扇区，节点不会挤在一起。
    const leaves = (n: TreeNode): number =>
      n.children.length ? n.children.reduce((s, c) => s + leaves(c), 0) : 1;
    const weights = node.children.map(leaves);
    const sum = weights.reduce((s, w) => s + w, 0) || 1;
    let a = a0;
    node.children.forEach((c, i) => {
      const span = ((a1 - a0) * weights[i]) / sum;
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
  kids.forEach((c) => {
    c.side = opts.alternate ? ((kids.indexOf(c) % 2 === 0 ? 1 : -1) as -1 | 1) : opts.dir;
  });
  let cursor = 0;
  kids.forEach((k, i) => {
    const step =
      opts.axis === "h"
        ? estimateWidth(k, spacing) + spacing
        : estimateHeight(k, spacing) + spacing;
    const center = cursor + step / 2;
    cursor += step;
    if (opts.axis === "h") {
      k.x = opts.dir === 1 ? center : -center;
      k.y = 0;
    } else {
      k.y = opts.dir === 1 ? center : -center;
      k.x = 0;
    }
    if (opts.oblique) {
      // 鱼骨：主分支从轴上的锚点斜向出去 45°，子分支再沿骨平行排。
      const arm = i % 2 === 0 ? -1 : 1;
      k.y = arm * (Math.abs(k.x) * 0.42 + 40);
      k.side = arm as -1 | 1;
    } else if (opts.alternate) {
      const arm = i % 2 === 0 ? -1 : 1;
      k.y = arm * (k.h / 2 + spacing * 2);
      k.side = arm as -1 | 1;
    }
    // 子树贴到主轴的外侧
    if (opts.axis === "h") {
      layoutHorizontalTreeSubtree(k, k.side, spacing);
    } else {
      layoutVerticalTreeSubtree(k, k.side, spacing);
    }
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
  const setX = (n: TreeNode, parent: TreeNode | null) => {
    if (!parent) return;
    n.x = parent.x + side * hGap(parent, n, spacing);
    for (const c of n.children) setX(c, n);
  };
  for (const c of node.children) {
    c.x = node.x + side * hGap(node, c, spacing);
    setX(c, c);
  }
}

/** 同 layoutHorizontalTreeSubtree：side 只做竖直方向的符号。 */
function layoutVerticalTreeSubtree(node: TreeNode, side: -1 | 0 | 1, spacing: number): void {
  const place = (n: TreeNode, cursorX: number): number => {
    if (!n.children.length) {
      n.x = cursorX + n.w / 2;
      return n.w;
    }
    let x = cursorX;
    let total = 0;
    for (const c of n.children) {
      const ext = place(c, x);
      x += ext + spacing;
      total += ext + spacing;
    }
    total -= spacing;
    n.x = (n.children[0].x + n.children[n.children.length - 1].x) / 2;
    return Math.max(total, n.w);
  };
  const left = node.x - estimateWidth(node, spacing) / 2;
  place(node, left);
  const setY = (n: TreeNode, depth: number) => {
    for (const c of n.children) {
      c.y = n.y + side * vGap(n, c, spacing);
      setY(c, depth + 1);
    }
  };
  setY(node, 0);
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
      case "orgDown": {
        layoutTreeFamily(root, vs, 1);
        break;
      }
      case "treeLeft":
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
      case "radial":
      case "circlePacking": {
        layoutCircle(root, vs);
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
      case "timelineVertical": {
        layoutSpine(root, vs, { axis: "v", alternate: true, oblique: false, dir: 1 });
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
    bounds: { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad },
    width: Math.max(1, maxX - minX + pad * 2),
    height: Math.max(1, maxY - minY + pad * 2),
  };
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

/** 双向平衡的主分支分侧：右先、左右交替，右侧拿奇偶中的前半 —— 与 MindMaster 默认观感一致。 */
function splitSides(root: TreeNode, code: LayoutCode): { right: TreeNode[]; left: TreeNode[] } {
  const kids = root.children;
  if (code !== "balanced") return { right: kids, left: [] };
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
      assignSubtreeY(n, center, dir, spacing);
    });
  };
  row(down, 1);
  row(up, -1);
}

function assignSubtreeY(node: TreeNode, centerX: number, dir: 1 | -1, spacing: number): void {
  const shift = centerX - node.x;
  const move = (n: TreeNode) => {
    n.x += shift;
    for (const c of n.children) move(c);
  };
  move(node);
  const setY = (n: TreeNode, depth: number) => {
    const rowH = Math.max(n.h, ...n.children.map((c) => c.h));
    n.y = dir * (depth * (rowH + spacing) + (depth === 0 ? n.h / 2 : n.h / 2));
    for (const c of n.children) setY(c, depth + 1);
  };
  setY(node, 0);
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
export function buildConnectors(
  _page: Page,
  boxes: Record<string, NodeBox>,
  code: LayoutCode
): ConnectorPath[] {
  const out: ConnectorPath[] = [];
  const elbow = code.startsWith("tree") || code.startsWith("org") || code === "matrix";
  for (const b of Object.values(boxes)) {
    if (!b.parentId) continue;
    const p = boxes[b.parentId];
    if (!p) continue;
    const vertical = code.startsWith("timeline") && code !== "timelineHorizontal";
    out.push({
      id: `c-${b.parentId}-${b.id}`,
      fromId: p.id,
      toId: b.id,
      side: b.side,
      d: vertical || elbow ? elbowPath(p, b, vertical) : curvePath(p, b),
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
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

function elbowPath(p: NodeBox, c: NodeBox, vertical: boolean): string {
  if (vertical) {
    const y1 = p.y + p.h / 2;
    const y2 = c.y - c.h / 2;
    const my = (y1 + y2) / 2;
    return `M ${round(p.x)} ${round(y1)} L ${round(p.x)} ${round(my)} L ${round(c.x)} ${round(my)} L ${round(c.x)} ${round(y2)}`;
  }
  const dir = Math.sign(c.y - p.y) || 1;
  const x1 = p.x + ((Math.sign(c.x - p.x) || 1) * p.w) / 2;
  const y1 = p.y;
  const x2 = c.x;
  const y2 = c.y - (dir * c.h) / 2;
  const my = (y1 + y2) / 2;
  return `M ${round(x1)} ${round(y1)} L ${round(x2)} ${round(my)} L ${round(x2)} ${round(y2)}`.replace(
    `L ${round(x2)} ${round(my)}`,
    `L ${round((x1 + x2) / 2)} ${round(y1)} L ${round(x2)} ${round(my)}`
  );
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 影响布局的几项参数，变了才需要重算。 */
export function layoutSignature(page: Page): string {
  const l = page.layout;
  return [l.code, l.hSpacing, l.vSpacing, l.rainbow ? 1 : 0].join("|");
}
