/**
 * 导出总入口：把 paint 结果变成各种落盘格式。
 *
 * 分工刻意的：
 * - SVG / 文本 / 矢量 PDF 全部是纯函数，node 里就能测（不依赖 WebView）；
 * - PNG / JPG 和"位图 PDF"必须经过 WebView 的 canvas，所以只在应用运行时可用，
 *   并且失败时给明确的中文原因，而不是悄悄给一张空图。
 */
import type { Page } from "../../types/model.ts";
import { plainText } from "../../types/model.ts";
import { outlineRows } from "../projections.ts";
import { buildPdf, type PdfOp, type PdfPage } from "./pdf.ts";
import { buildSvg, paintPage, type Paint, type RenderOptions } from "./svg.ts";
import { toCsv, toHtml, toMarkdown, toOpml, toSlidesMarkdown, toText, toTreeJson } from "./markup.ts";

export type ExportFormat =
  | "emmx"
  | "svg"
  | "png"
  | "jpg"
  | "pdf"
  | "pdf-vector"
  | "md"
  | "txt"
  | "csv"
  | "opml"
  | "html"
  | "json"
  | "slides-md";

export interface FormatSpec {
  id: ExportFormat;
  label: string;
  ext: string;
  mime: string;
  group: "文档" | "图片" | "PDF" | "文本";
  needsCanvas?: boolean;
}

export const FORMATS: FormatSpec[] = [
  { id: "emmx", label: "亿图脑图文件 (.emmx)", ext: "emmx", mime: "application/zip", group: "文档" },
  { id: "svg", label: "SVG 矢量图", ext: "svg", mime: "image/svg+xml", group: "图片" },
  { id: "png", label: "PNG 图片", ext: "png", mime: "image/png", group: "图片", needsCanvas: true },
  { id: "jpg", label: "JPG 图片", ext: "jpg", mime: "image/jpeg", group: "图片", needsCanvas: true },
  { id: "pdf-vector", label: "PDF（矢量，可选中文字）", ext: "pdf", mime: "application/pdf", group: "PDF" },
  { id: "pdf", label: "PDF（位图，兼容性最好）", ext: "pdf", mime: "application/pdf", group: "PDF", needsCanvas: true },
  { id: "md", label: "Markdown 大纲", ext: "md", mime: "text/markdown", group: "文本" },
  { id: "slides-md", label: "Markdown 演示稿", ext: "md", mime: "text/markdown", group: "文本" },
  { id: "txt", label: "纯文本大纲", ext: "txt", mime: "text/plain", group: "文本" },
  { id: "csv", label: "CSV 表格", ext: "csv", mime: "text/csv", group: "文本" },
  { id: "opml", label: "OPML 大纲", ext: "opml", mime: "text/x-opml", group: "文本" },
  { id: "html", label: "网页（单文件）", ext: "html", mime: "text/html", group: "文本" },
  { id: "json", label: "JSON 数据（给程序读）", ext: "json", mime: "application/json", group: "文本" },
];

/**
 * 不进导出引擎、由「另存为」那条路产出的格式。
 *
 * .emmx 是文档本身，不是派生物：免费版文件数闸门（P-4）、覆盖前自动备份、脏标记落盘全在
 * `useDoc.saveAs` 里，绕开它去 hand 一份 zip 等于把这两条规则各写一遍。
 * 但它又必须出现在 FORMATS 里（导出对话框按组渲染这张表），于是"表里有一项、switch 里没有分支"
 * 变成只有运行时才炸的洞 —— 单列一张表，配合 tests/export.test.ts 遍历 FORMATS 的门测。
 */
export const SAVE_AS_FORMATS: readonly ExportFormat[] = ["emmx"];

export interface ExportOptions extends RenderOptions {
  scale?: number;
  quality?: number;
  /** 矢量 PDF 是否附一页大纲（默认附）。 */
  withOutline?: boolean;
  paper?: { width: number; height: number };
}

export interface Artifact {
  name: string;
  bytes: Uint8Array;
  mime: string;
  format: ExportFormat;
}

const TEXT_ENCODER = /* @__PURE__ */ new TextEncoder();
export const A4_LANDSCAPE = { width: 842, height: 595 };
export const A4_PORTRAIT = { width: 595, height: 842 };

export function formatOf(id: ExportFormat): FormatSpec {
  return FORMATS.find((f) => f.id === id) ?? FORMATS[0];
}

export async function exportArtifact(
  page: Page,
  format: ExportFormat,
  opts: ExportOptions = {}
): Promise<Artifact> {
  const root = page.shapes[page.rootId];
  const name = safeName((root ? plainText(root.text) : "") || page.name);
  const spec = formatOf(format);
  const made = (base: string, bytes: Uint8Array) => ({ name: `${name}.${base}`, bytes, mime: spec.mime, format });

  switch (format) {
    case "svg":
      return made("svg", textToBytes(buildSvg(page, opts)));
    case "md":
      return made("md", textToBytes(toMarkdown(page)));
    case "slides-md":
      return made("md", textToBytes(toSlidesMarkdown(page)));
    case "txt":
      return made("txt", textToBytes(toText(page)));
    case "csv":
      // 加 BOM，否则 Excel 打开中文列是乱码
      return made("csv", concat(new Uint8Array([0xef, 0xbb, 0xbf]), textToBytes(toCsv(page))));
    case "opml":
      return made("opml", textToBytes(toOpml(page)));
    case "html":
      return made("html", textToBytes(toHtml(page, name)));
    case "json":
      return made("json", textToBytes(toTreeJson(page)));
    case "pdf-vector":
      return made("pdf", buildPdf(pdfPagesOf(page, opts), { title: name }));
    case "pdf": {
      const paper = opts.paper ?? A4_LANDSCAPE;
      const jpeg = await svgToJpeg(buildSvg(page, opts), opts.scale ?? 2, opts.quality ?? 0.92);
      const size = fitTo(jpeg.w, jpeg.h, paper.width - 40, paper.height - 60);
      const pages: PdfPage[] = [
        {
          width: paper.width,
          height: paper.height,
          ops: [
            { k: "rect", x: 0, y: 0, w: paper.width, h: paper.height, fill: "#ffffff" },
            { k: "image", x: (paper.width - size.w) / 2, y: 30, w: size.w, h: size.h, jpeg: jpeg.bytes },
          ],
        },
      ];
      return made("pdf", buildPdf(pages, { title: name }));
    }
    case "png":
      return made("png", await svgToPng(buildSvg(page, opts), opts.scale ?? 2));
    case "jpg":
      return made("jpg", (await svgToJpeg(buildSvg(page, opts), opts.scale ?? 2, opts.quality ?? 0.92)).bytes);
    default:
      if (SAVE_AS_FORMATS.includes(format)) {
        throw new Error(`${format} 不在这里产出：请用「另存为」—— 文件数闸门、覆盖前备份、脏标记落盘都只在那条路上`);
      }
      throw new Error(`不支持的导出格式：${format}`);
  }
}

/** 布局结果 → PDF 页（单位：点，y 向下，由 pdf.ts 负责翻转）。 */
export function pdfPagesOf(page: Page, opts: ExportOptions = {}): PdfPage[] {
  const paper = opts.paper ?? A4_LANDSCAPE;
  const margin = 24;
  const paint = paintPage(page, opts);
  const s = Math.min((paper.width - margin * 2) / paint.width, (paper.height - margin * 2) / paint.height, 1.6);
  const fx = (v: number) => round2(margin + (v - paint.minX) * s);
  const fy = (v: number) => round2(margin + (v - paint.minY) * s);

  const ops: PdfOp[] = [{ k: "rect", x: 0, y: 0, w: paper.width, h: paper.height, fill: "#ffffff" }];
  for (const c of paint.connectors) {
    ops.push({ k: "path", d: transformPath(c.d, fx, fy), stroke: "#9aa0a6", lineWidth: 1 });
  }
  for (const b of paint.boxes) {
    ops.push({
      k: "rect",
      x: fx(b.x),
      y: fy(b.y),
      w: round2(b.w * s),
      h: round2(b.h * s),
      r: round2(b.rounding * s),
      fill: b.fill,
      stroke: b.line,
      lineWidth: b.lineWidth,
    });
    const size = Math.max(5, b.fontSize * s);
    const lh = size * 1.35;
    const startY = fy(b.y + b.h / 2 - ((b.lines.length - 1) * b.fontSize * 1.35 * s) / 2) + size * 0.35;
    b.lines.forEach((line, ix) => {
      ops.push({ k: "text", x: fx(b.x + b.w / 2), y: startY + ix * lh, size, color: b.textColor, text: line, anchor: "middle" });
    });
  }
  const pages: PdfPage[] = [{ width: paper.width, height: paper.height, ops }];
  if (opts.withOutline !== false) pages.push(outlinePdfPage(page, paper));
  return pages;
}

function outlinePdfPage(page: Page, paper: { width: number; height: number }): PdfPage {
  const ops: PdfOp[] = [
    { k: "rect", x: 0, y: 0, w: paper.width, h: paper.height, fill: "#ffffff" },
    { k: "text", x: 40, y: 46, size: 16, color: "#333333", text: "大纲" },
  ];
  let y = 74;
  for (const r of outlineRows(page)) {
    if (y > paper.height - 40) break;
    ops.push({
      k: "text",
      x: 40 + r.level * 14,
      y,
      size: r.level === 0 ? 12 : 10,
      color: r.level === 0 ? "#1f1f1f" : "#4a4a4a",
      text: r.text,
    });
    y += 18;
  }
  return { width: paper.width, height: paper.height, ops };
}

/**
 * path 的坐标对逐个数映射（偶数是 x、奇数是 y）。
 * 只处理我们自己和布局引擎生成的绝对坐标 path —— 相对命令的数值是增量，
 * 不能直接套 fx/fy，所以遇到小写命令先转绝对（当前布局不会产出小写命令）。
 */
export function transformPath(d: string, fx: (v: number) => number, fy: (v: number) => number): string {
  const tokens = d.match(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+(?:\.\d*)?)(?:[eE][-+]?\d+)?/g) ?? [];
  const counts: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2 };
  let i = 0;
  let implicit = "M";
  const out: string[] = [];
  while (i < tokens.length) {
    let cmd = tokens[i];
    if (/^[A-Za-z]$/.test(cmd)) i += 1;
    else cmd = implicit;
    const C = cmd.toUpperCase();
    implicit = C === "M" ? "L" : C;
    if (C === "Z") {
      out.push("Z");
      continue;
    }
    const n = counts[C] ?? 2;
    const nums: number[] = [];
    for (let k = 0; k < n && i < tokens.length; k += 1) nums.push(Number(tokens[i++]) || 0);
    if (C === "H") {
      out.push("H", String(fx(nums[0])));
      continue;
    }
    if (C === "V") {
      out.push("V", String(fy(nums[0])));
      continue;
    }
    out.push(C, ...nums.map((v, ix) => String(ix % 2 ? fy(v) : fx(v))));
  }
  return out.join(" ");
}

function fitTo(w: number, h: number, maxW: number, maxH: number): { w: number; h: number } {
  const s = Math.min(maxW / w, maxH / h, 1);
  return { w: w * s, h: h * s };
}

function safeName(s: string): string {
  const cleaned = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return (cleaned || "mindmap").slice(0, 60);
}

function textToBytes(s: string): Uint8Array {
  return TEXT_ENCODER.encode(s);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------- 位图（只在运行时可用）

function requireCanvas(): CanvasRenderingContext2D & { canvas: HTMLCanvasElement } {
  if (typeof document === "undefined") {
    throw new Error("PNG / 位图 PDF 导出只能在应用窗口里进行，命令行请用 SVG 或矢量 PDF");
  }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("当前系统不支持 2D 画布，无法导出图片");
  return ctx as CanvasRenderingContext2D & { canvas: HTMLCanvasElement };
}

async function svgToCanvas(svg: string, scale: number): Promise<HTMLCanvasElement> {
  const { width, height } = svgSize(svg);
  // 先要画布再解码图片：命令行里没有 document 时，这条顺序给用户的是"只能在应用窗口里导出"，
  // 而不是 WebView 内部报出来的 "Image is not defined"。
  const ctx = requireCanvas();
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const img = await loadImage(url);
  const { canvas } = ctx;
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("SVG 光栅化失败：图形里有 WebView 不认的内容"));
    img.src = url;
  });
}

export async function svgToPng(svg: string, scale = 2): Promise<Uint8Array> {
  const canvas = await svgToCanvas(svg, scale);
  const blob = await toBlob(canvas, "image/png");
  return new Uint8Array(await blob.arrayBuffer());
}

export async function svgToJpeg(
  svg: string,
  scale = 2,
  quality = 0.92
): Promise<{ bytes: Uint8Array; w: number; h: number }> {
  const canvas = await svgToCanvas(svg, scale);
  const blob = await toBlob(canvas, "image/jpeg", quality);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("图片编码失败，请减小倍率后重试"))), type, quality);
  });
}

function svgSize(svg: string): { width: number; height: number } {
  const w = /width="([\d.]+)"/.exec(svg)?.[1];
  const h = /height="([\d.]+)"/.exec(svg)?.[1];
  if (!w || !h) throw new Error("SVG 缺少宽高，无法光栅化");
  return { width: Number(w), height: Number(h) };
}

export type { Paint, RenderOptions };
export { paintPage, buildSvg };
