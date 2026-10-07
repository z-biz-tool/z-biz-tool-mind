/**
 * 打印（doc/复刻方案/00 §3.11）。
 *
 * 这一层只回答一个问题：**这张图要怎么摊到纸上**。几何一律问 paintPage 要（P-2），
 * 分页只改 <svg> 的视口 —— 纸张、页边距、缩放模式、份数都不会让哪个主题换个位置、
 * 换种颜色。所以"屏幕上看到的"和"纸上打出来的"必然一致，除非本来就在裁内容。
 *
 * 三件刻意不做的事：
 * 1) 不读打印机、不设驱动里的份数：份数是在这份文档里把页面重复 N 遍，
 *    真打印机首选项由系统的打印框自己管；
 * 2) 打印边界只活在本次打印，不写进 .emmx —— 它的线格式还没在任何真文件里取到证，
 *    凭猜写进去就是把别人的文件改坏（见 memory 里那条硬规则）；
 * 3) "居中打印"不缩放、也不分页：纸张装不下的部分就是不打印，
 *    但这个数会被数出来交给界面提示（plan.outside），不做"悄悄少打了一半"。
 */
import type { Page } from "../../types/model.ts";
import { plainText } from "../../types/model.ts";
import { descendants } from "../tree.ts";
import { svgToJpeg } from "./index.ts";
import { buildPdf, type PdfOp, type PdfPage } from "./pdf.ts";
import { paintPage, renderSvg, type Paint, type RenderOptions } from "./svg.ts";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PaperSpec {
  id: string;
  label: string;
  /** 纵向尺寸（mm）。横向就是把两个数换过来，见 paperSizeOf。 */
  wMm: number;
  hMm: number;
  /** 信封：横向默认没意义，界面上给个分组。 */
  envelope?: boolean;
}

/**
 * 24 种纸型，取自 §3.11 那张清单（A3…DL 信封 + 自动尺寸）。
 * 毫米数按各标准的公称值；ANSI C/D/E 是工程图那三张，亿图把它们列在 "C/D/E"。
 */
export const PAPERS: PaperSpec[] = [
  { id: "auto", label: "自动尺寸", wMm: 0, hMm: 0 },
  { id: "a2", label: "A2", wMm: 420, hMm: 594 },
  { id: "a3", label: "A3", wMm: 297, hMm: 420 },
  { id: "a4", label: "A4", wMm: 210, hMm: 297 },
  { id: "a5", label: "A5", wMm: 148, hMm: 210 },
  { id: "a6", label: "A6", wMm: 105, hMm: 148 },
  { id: "b4", label: "B4", wMm: 250, hMm: 353 },
  { id: "b5", label: "B5", wMm: 176, hMm: 250 },
  { id: "c", label: "C（ANSI 17×22in）", wMm: 432, hMm: 559 },
  { id: "d", label: "D（ANSI 22×28in）", wMm: 559, hMm: 711 },
  { id: "e", label: "E（ANSI 28×40in）", wMm: 711, hMm: 914 },
  { id: "quarto", label: "Quarto", wMm: 210, hMm: 280 },
  { id: "folio", label: "Folio", wMm: 210, hMm: 330 },
  { id: "legal", label: "Legal", wMm: 216, hMm: 356 },
  { id: "letter", label: "Letter", wMm: 216, hMm: 279 },
  { id: "tabloid", label: "Tabloid", wMm: 279, hMm: 432 },
  { id: "executive", label: "Executive", wMm: 190, hMm: 254 },
  { id: "statement", label: "Statement", wMm: 140, hMm: 216 },
  { id: "monarch", label: "Monarch", wMm: 95, hMm: 197 },
  { id: "env10", label: "#10 信封", wMm: 105, hMm: 241, envelope: true },
  { id: "c5", label: "C5 信封", wMm: 162, hMm: 229, envelope: true },
  { id: "c6", label: "C6 信封", wMm: 114, hMm: 162, envelope: true },
  { id: "dl", label: "DL 信封", wMm: 110, hMm: 220, envelope: true },
  { id: "b5env", label: "B5 信封", wMm: 176, hMm: 250, envelope: true },
];

/** CSS 像素与毫米的换算：打印媒体上 1px = 1/96in，这是浏览器唯一认的口径。 */
export const MM_TO_PX = 96 / 25.4;

/** 毫米与 PDF 点（1/72in）的换算：打印到文件那条路用它。 */
export const MM_TO_PT = 72 / 25.4;

/** 适应类模式最多放大到 4 倍：只有一句话的图也不该被拉成一张海报。 */
export const MAX_PRINT_SCALE = 4;

export const DEFAULT_MARGIN_MM = 10;

/** 单页适应 / 多页网格适应 / 宽度适应 / 原位不缩放居中 / 真实尺寸分页。 */
export type PrintScaleMode = "fitOne" | "fitMulti" | "fitWidth" | "center" | "exact";

export const SCALE_MODES: { id: PrintScaleMode; label: string; note: string }[] = [
  { id: "fitOne", label: "单页适应视图", note: "整图缩到刚好装进一张纸，居中。" },
  {
    id: "fitMulti",
    label: "多页适应视图",
    note: "摊成给定行列的网格，取这个网格下最大的缩放，整组居中。",
  },
  { id: "fitWidth", label: "页面适应视图宽度", note: "宽度撑满纸张，超出的高度往下一张纸续。" },
  {
    id: "center",
    label: "居中打印",
    note: "按给定比例不缩放、只出一张并居中；纸张装不下的部分不打印（会数出来）。",
  },
  {
    id: "exact",
    label: "精准打印",
    note: "按给定比例真实尺寸出图，横竖都超出就分页。",
  },
];

/** 当前页 / 选中主题及其分支（重排）/ 选中分支（原位）/ 仅选中主题（原位）。 */
export type PrintRange = "page" | "subtree" | "branch" | "topic";

export const RANGES: { id: PrintRange; label: string; note: string }[] = [
  { id: "page", label: "当前页", note: "这一页上画得出来的都打。" },
  {
    id: "subtree",
    label: "选中主题及其分支",
    note: "只把选中的那些分支重新布局成一张图，位置按新布局走。",
  },
  {
    id: "branch",
    label: "选中分支",
    note: "保持整页位置不动，只打选中主题连同它们的子孙。",
  },
  { id: "topic", label: "仅选中主题", note: "连子孙都不打，只剩选中的那几个框。" },
];

export interface PrintOptions extends RenderOptions {
  paperId?: string;
  landscape?: boolean;
  marginMm?: number;
  mode?: PrintScaleMode;
  /** 只对 center / exact 有意义，100 = 真实尺寸。 */
  scalePct?: number;
  gridCols?: number;
  gridRows?: number;
  copies?: number;
  range?: PrintRange;
  /** range 不是 page 时要打的那些主题 id（界面上就是当前选区）。 */
  keepIds?: string[];
  bounds?: Rect | null;
}

export interface PrintView extends Rect {
  scale: number;
}

export interface PrintPlan {
  /** 落纸尺寸（mm，已按横纵向交换）。 */
  paperMm: { w: number; h: number };
  marginMm: number;
  /** 可打印区（CSS px）：纸张减掉页边距。 */
  boxPx: { w: number; h: number };
  scale: number;
  grid: { cols: number; rows: number };
  /** 每张纸一个视口，按"先横后竖"的阅读序排。 */
  views: PrintView[];
  /** views × 份数，也就是真正会走纸的张数。 */
  sheets: number;
  copies: number;
  /** 中心落在所有页面之外的主题数（center 模式会用到）。 */
  outside: number;
}

export interface PrintJob {
  html: string;
  plan: PrintPlan;
  title: string;
  /** 这一份要打的主题数（范围与边界都算进去了）。 */
  topics: number;
}

export function paperOf(id: string): PaperSpec {
  return PAPERS.find((p) => p.id === id) ?? PAPERS.find((p) => p.id === "a4")!;
}

/** 自动尺寸没有横纵之分：它跟着内容走。 */
export function paperSizeOf(id: string, landscape: boolean): { w: number; h: number } {
  const p = paperOf(id);
  if (p.id === "auto") return { w: 0, h: 0 };
  return landscape ? { w: p.hMm, h: p.wMm } : { w: p.wMm, h: p.hMm };
}

function frameOf(p: Paint, bounds?: Rect | null): Rect {
  if (bounds) return bounds;
  return { x: p.minX, y: p.minY, w: p.width, h: p.height };
}

/** 命中判断用中心而不是左上角：框一半压在线上时不该整框消失。 */
function inside(rect: Rect, b: Rect): boolean {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
}

/**
 * 按 id 集合裁一份 Paint。
 *
 * 只筛不算是这条的关键：连线要两头都在（留一根断头线就是画错），关系线同理。
 * 覆盖层分两种活法：外框与大括号只有包围盒，整块落在幸存区域内才留 ——
 * 跨在切口上的那半个框印出来就是错图；标注泡跟它的框绑在一起，
 * 框被裁掉了引导线也得跟着没，不然就剩一条指向空处的线。
 */
export function filterPaint(p: Paint, keep: (id: string) => boolean): Paint {
  const boxes = p.boxes.filter((b) => keep(b.id));
  const ids = new Set(boxes.map((b) => b.id));
  let minX = p.minX;
  let minY = p.minY;
  let maxX = p.minX + p.width;
  let maxY = p.minY + p.height;
  if (boxes.length) {
    minX = Infinity;
    minY = Infinity;
    maxX = -Infinity;
    maxY = -Infinity;
    for (const b of boxes) {
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
  }
  const frame: Rect = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  return {
    ...p,
    boxes,
    connectors: p.connectors.filter((c) => ids.has(c.fromId) && ids.has(c.toId)),
    rels: p.rels.filter((r) => ids.has(r.fromId) && ids.has(r.toId)),
    overlays: p.overlays.filter((o) =>
      o.kind === "boundary" || o.kind === "brace" ? inside(frame, o) : ids.has(o.id)
    ),
    width: frame.w,
    height: frame.h,
    minX,
    minY,
  };
}

/** 范围 → 保留判据。page 什么都留，所以返回 undefined（省掉一次全表遍历）。 */
function keepFor(
  page: Page,
  range: PrintRange,
  ids: string[]
): ((id: string) => boolean) | undefined {
  if (range === "page") return undefined;
  const set = new Set<string>();
  for (const id of ids) {
    if (!page.shapes[id]) continue;
    if (range === "topic") {
      set.add(id);
      continue;
    }
    for (const d of descendants(page, id)) set.add(d);
    set.add(id);
  }
  return (id: string) => set.has(id);
}

/**
 * 摊页面。
 *
 * 网格原点让整组内容居中：最后一张常常是半空的，从左上角铺的话那半张纸全偏到一边，
 * 用户会以为缩放算错了。（fitOne 也就是 cols=rows=1 的这一个特例，所以没有第二条分支。）
 */
export function printPlanOf(p: Paint, o: PrintOptions = {}): PrintPlan {
  const paperId = o.paperId ?? "a4";
  const landscape = o.landscape !== false;
  const auto = paperId === "auto";
  const pct = o.scalePct ?? 100;
  const marginMm = auto ? 0 : (o.marginMm ?? DEFAULT_MARGIN_MM);
  const content = frameOf(p, o.bounds);
  const mode = o.mode ?? "fitOne";

  const box = auto
    ? { w: content.w * (pct / 100), h: content.h * (pct / 100) }
    : (() => {
        const mm = paperSizeOf(paperId, landscape);
        // 纸太小、边距太大也不能算出个负数：留 1px，界面上"这组合装不下"才有东西可显示
        return {
          w: Math.max(1, (mm.w - marginMm * 2) * MM_TO_PX),
          h: Math.max(1, (mm.h - marginMm * 2) * MM_TO_PX),
        };
      })();
  const mm = auto
    ? { w: box.w / MM_TO_PX + marginMm * 2, h: box.h / MM_TO_PX + marginMm * 2 }
    : paperSizeOf(paperId, landscape);

  let scale: number;
  let cols: number;
  let rows: number;
  if (auto) {
    scale = pct / 100;
    cols = 1;
    rows = 1;
  } else if (mode === "fitOne") {
    scale = Math.min(box.w / content.w, box.h / content.h, MAX_PRINT_SCALE);
    cols = 1;
    rows = 1;
  } else if (mode === "fitWidth") {
    scale = Math.min(box.w / content.w, MAX_PRINT_SCALE);
    cols = 1;
    rows = Math.max(1, Math.ceil(content.h / (box.h / scale)));
  } else if (mode === "fitMulti") {
    const gc = Math.max(1, Math.round(o.gridCols ?? 2));
    const gr = Math.max(1, Math.round(o.gridRows ?? 1));
    scale = Math.min((box.w * gc) / content.w, (box.h * gr) / content.h, MAX_PRINT_SCALE);
    cols = gc;
    rows = gr;
  } else if (mode === "exact") {
    scale = pct / 100;
    cols = Math.max(1, Math.ceil(content.w / (box.w / scale)));
    rows = Math.max(1, Math.ceil(content.h / (box.h / scale)));
  } else {
    scale = pct / 100;
    cols = 1;
    rows = 1;
  }

  const tileW = box.w / scale;
  const tileH = box.h / scale;
  const x0 = content.x + (content.w - tileW * cols) / 2;
  const y0 = content.y + (content.h - tileH * rows) / 2;

  const views: PrintView[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      views.push({ x: x0 + c * tileW, y: y0 + r * tileH, w: tileW, h: tileH, scale });
    }
  }

  const grid: Rect = { x: x0, y: y0, w: tileW * cols, h: tileH * rows };
  const copies = Math.max(1, Math.round(o.copies ?? 1));
  return {
    paperMm: { w: round2(mm.w), h: round2(mm.h) },
    marginMm,
    boxPx: { w: round2(box.w), h: round2(box.h) },
    scale,
    grid: { cols, rows },
    views,
    sheets: views.length * copies,
    copies,
    outside: p.boxes.filter((b) => !inside(grid, b)).length,
  };
}

/** 一份 paint + 一份计划 → 每页一张 SVG（视口不同，图形一字不改）。 */
export function printSvgsOf(p: Paint, plan: PrintPlan): string[] {
  return plan.views.map((v) => renderSvg(p, v));
}

/**
 * 打印到文件：把上面那叠页面烤成 PDF。
 *
 * 走的是位图那条已知路（svgToJpeg + buildPdf），而不是再发明一套矢量分页：
 * 打印预览里看到什么、这份 PDF 里就是什么，两条路共用同一份 paint（P-2）。
 * 需要光栅化，所以只有应用运行时能用；命令行请改用 pdf / pdf-vector 导出。
 */
export async function buildPrintPdfBytes(page: Page, o: PrintOptions = {}): Promise<Uint8Array> {
  const { paint, plan } = printJobOf(page, o);
  const svgs: string[] = [];
  for (let i = 0; i < plan.copies; i += 1) svgs.push(...printSvgsOf(paint, plan));
  const marginPt = plan.marginMm * MM_TO_PT;
  const paper = { width: plan.paperMm.w * MM_TO_PT, height: plan.paperMm.h * MM_TO_PT };
  const pages: PdfPage[] = [];
  for (const svg of svgs) {
    const jpeg = await svgToJpeg(svg, 2, 0.92);
    // 位图的尺寸按纸张算，不按 canvas 像素算：倍率只该改清晰度，不该改出纸尺寸。
    const w = paper.width - marginPt * 2;
    const h = paper.height - marginPt * 2;
    const ops: PdfOp[] = [
      { k: "rect", x: 0, y: 0, w: paper.width, h: paper.height, fill: "#ffffff" },
      { k: "image", x: marginPt, y: marginPt, w, h, jpeg: jpeg.bytes },
    ];
    pages.push({ width: paper.width, height: paper.height, ops });
  }
  return buildPdf(pages, { title: printTitleOf(page) });
}

/** 标题就是导出文件名那套：根主题文字，兜底页名。 */
export function printTitleOf(page: Page): string {
  const root = page.shapes[page.rootId];
  return safeName((root ? plainText(root.text) : "") || page.name);
}

/**
 * 打印用的独立文档。
 *
 * `@page` 给物理纸张与页边距，`.sheet` 给可打印区，`break-after: page` 让每张纸就是一页；
 * 份数在这里把整组页面重复 N 遍（打印机驱动那份首选项不归我们管，见文件头）。
 */
export function printDocumentHtml(title: string, paint: Paint, plan: PrintPlan): string {
  const svgs = printSvgsOf(paint, plan);
  const sheets: string[] = [];
  for (let i = 0; i < plan.copies; i += 1) sheets.push(...svgs);
  const body = sheets
    .map(
      (s) =>
        `<div class="sheet" style="width:${plan.boxPx.w}px;height:${plan.boxPx.h}px">${s}</div>`
    )
    .join("\n");

  return (
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escText(title)}</title><style>` +
    `@page{size:${plan.paperMm.w}mm ${plan.paperMm.h}mm;margin:${plan.marginMm}mm}` +
    `html,body{margin:0;padding:0;background:#fff;color:#000}` +
    `.sheet{box-sizing:border-box;overflow:hidden;break-after:page;page-break-after:always}` +
    `.sheet:last-child{break-after:auto;page-break-after:auto}` +
    `svg{display:block}` +
    `</style></head><body>${body}</body></html>`
  );
}

/** 拆出来给界面用：界面要先把主题数与页数显示出来，再决定打不打。 */
export function printJobOf(page: Page, o: PrintOptions = {}): { paint: Paint; plan: PrintPlan } {
  const range = o.range ?? "page";
  const paint = paintPage(page, {
    ...o,
    only: range === "subtree" && o.keepIds?.length ? o.keepIds : o.only,
  });
  const keep = keepFor(page, range, o.keepIds ?? []);
  let cut = keep ? filterPaint(paint, keep) : paint;
  if (o.bounds) {
    const b = o.bounds;
    cut = filterPaint(cut, (id) => {
      const box = cut.boxes.find((x) => x.id === id);
      return !box || inside(b, box);
    });
  }
  return { paint: cut, plan: printPlanOf(cut, o) };
}

/** 一步到位：界面里"打印"与"打印到文件"共用它，别让两处各算一遍。 */
export function buildPrintHtml(page: Page, o: PrintOptions = {}): PrintJob {
  const { paint, plan } = printJobOf(page, o);
  const title = printTitleOf(page);
  return {
    html: printDocumentHtml(title, paint, plan),
    plan,
    title,
    topics: paint.boxes.length,
  };
}

function safeName(s: string): string {
  const cleaned = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned || "脑图";
}

function escText(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
