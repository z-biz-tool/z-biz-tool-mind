/**
 * 最小 PDF 1.4 writer：矢量矩形 / 路径 / 文字 / JPEG 图片，纯字节拼装。
 *
 * 为什么自己写而不是"截图拼 PDF"：亿图的"导出 PDF（矢量）"是会员功能，
 * 位图版放大就糊，复刻要能对得起"矢量"两个字。
 *
 * 中文怎么办：不嵌字体就得用标准 CID 字体。这里用 Type0 + `STSong-Light`
 * + `/UniGB-UCS2-H`（PDF 规范附录里 Adobe-GB1 的标准映射），正文写 UTF-16BE
 * 十六进制。Acrobat / macOS 预览 / Edge 都自带这套替换；个别只看西文的阅读器
 * 会退成方框，所以导出面板同时提供"PDF（位图）"。
 */
import { charWidth } from "../layout.ts";

export type PdfOp =
  | {
      k: "rect";
      x: number;
      y: number;
      w: number;
      h: number;
      r?: number;
      fill?: string;
      stroke?: string;
      lineWidth?: number;
    }
  | { k: "path"; d: string; stroke?: string; lineWidth?: number; fill?: string }
  | {
      k: "text";
      x: number;
      y: number;
      size: number;
      color?: string;
      text: string;
      anchor?: "start" | "middle" | "end";
    }
  | { k: "image"; x: number; y: number; w: number; h: number; jpeg: Uint8Array };

export interface PdfPage {
  width: number;
  height: number;
  ops: PdfOp[];
}

const ASCII = /* @__PURE__ */ new TextEncoder();

class Buf {
  private parts: Uint8Array[] = [];
  length = 0;

  s(str: string): void {
    this.bytes(ASCII.encode(str));
  }

  bytes(x: Uint8Array): void {
    this.parts.push(x);
    this.length += x.length;
  }

  take(): Uint8Array {
    const out = new Uint8Array(this.length);
    let off = 0;
    for (const p of this.parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
}

export function hexToRgbTriplet(c?: string): string | undefined {
  if (!c) return undefined;
  let h = c.replace("#", "");
  if (h.length === 8) h = h.slice(2);
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return undefined;
  const n = Number.parseInt(h, 16);
  return `${f3((n >> 16) & 0xff)} ${f3((n >> 8) & 0xff)} ${f3(n & 0xff)}`;
}

function f3(v: number): string {
  return String(Math.round((v / 255) * 1000) / 1000);
}

function num(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

function utf16Hex(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c > 0xffff) {
      const v = c - 0x10000;
      out += (0xd800 + (v >> 10)).toString(16).padStart(4, "0");
      out += (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, "0");
    } else {
      out += c.toString(16).padStart(4, "0");
    }
  }
  return out;
}

export function textAdvance(text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch, size);
  return w;
}

/**
 * SVG path 的 `d` → PDF 路径算子。
 * 支持 M/L/H/V/C/S/Q/Z 及它们的小写（相对）形式；Q 二次贝塞尔按标准做法升三次。
 */
export function pathToOps(d: string): string {
  const tokens = d.match(/[MmLlHhVvCcSsQqZz]|[-+]?(?:\d*\.\d+|\d+(?:\.\d*)?)(?:[eE][-+]?\d+)?/g) ?? [];
  let i = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let implicit = "M";
  const out: string[] = [];
  const next = (): number => {
    const v = Number(tokens[i++]);
    return Number.isFinite(v) ? v : 0;
  };

  while (i < tokens.length) {
    let cmd = tokens[i];
    if (typeof cmd === "string" && /^[A-Za-z]$/.test(cmd)) i += 1;
    else cmd = implicit;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === "Z") {
      out.push("h");
      cx = sx;
      cy = sy;
      implicit = "M";
      continue;
    }
    const dx = rel ? cx : 0;
    const dy = rel ? cy : 0;
    if (C === "H") {
      cx = next() + dx;
      out.push(`${num(cx)} ${num(cy)} l`);
      implicit = C;
      continue;
    }
    if (C === "V") {
      cy = next() + dy;
      out.push(`${num(cx)} ${num(cy)} l`);
      implicit = C;
      continue;
    }
    if (C === "M") {
      cx = next() + dx;
      cy = next() + dy;
      out.push(`${num(cx)} ${num(cy)} m`);
      sx = cx;
      sy = cy;
      implicit = "L"; // SVG 里 M 后面多余的坐标对视作 L
      continue;
    }
    if (C === "L") {
      cx = next() + dx;
      cy = next() + dy;
      out.push(`${num(cx)} ${num(cy)} l`);
      implicit = C;
      continue;
    }
    if (C === "C") {
      const x1 = next() + dx;
      const y1 = next() + dy;
      const x2 = next() + dx;
      const y2 = next() + dy;
      const x = next() + dx;
      const y = next() + dy;
      out.push(`${num(x1)} ${num(y1)} ${num(x2)} ${num(y2)} ${num(x)} ${num(y)} c`);
      cx = x;
      cy = y;
      implicit = C;
      continue;
    }
    if (C === "S") {
      const x2 = next() + dx;
      const y2 = next() + dy;
      const x = next() + dx;
      const y = next() + dy;
      out.push(`${num(cx)} ${num(cy)} ${num(x2)} ${num(y2)} ${num(x)} ${num(y)} c`);
      cx = x;
      cy = y;
      implicit = C;
      continue;
    }
    // Q：二次升三次
    const qx = next() + dx;
    const qy = next() + dy;
    const x = next() + dx;
    const y = next() + dy;
    const c1x = cx + (2 / 3) * (qx - cx);
    const c1y = cy + (2 / 3) * (qy - cy);
    const c2x = x + (2 / 3) * (qx - x);
    const c2y = y + (2 / 3) * (qy - y);
    out.push(`${num(c1x)} ${num(c1y)} ${num(c2x)} ${num(c2y)} ${num(x)} ${num(y)} c`);
    cx = x;
    cy = y;
    implicit = C;
  }
  return out.join(" ");
}

/** 圆角矩形 → 路径。PDF 的 `re` 不能圆角，所以一律走 path。 */
export function roundRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (rr === 0) {
    return `M ${num(x)} ${num(y)} L ${num(x + w)} ${num(y)} L ${num(x + w)} ${num(y + h)} L ${num(x)} ${num(y + h)} Z`;
  }
  const k = rr * 0.5523;
  return [
    `M ${num(x + rr)} ${num(y)}`,
    `L ${num(x + w - rr)} ${num(y)}`,
    `C ${num(x + w - rr + k)} ${num(y)} ${num(x + w)} ${num(y + rr - k)} ${num(x + w)} ${num(y + rr)}`,
    `L ${num(x + w)} ${num(y + h - rr)}`,
    `C ${num(x + w)} ${num(y + h - rr + k)} ${num(x + w - rr + k)} ${num(y + h)} ${num(x + w - rr)} ${num(y + h)}`,
    `L ${num(x + rr)} ${num(y + h)}`,
    `C ${num(x + rr - k)} ${num(y + h)} ${num(x)} ${num(y + h - rr + k)} ${num(x)} ${num(y + h - rr)}`,
    `L ${num(x)} ${num(y + rr)}`,
    `C ${num(x)} ${num(y + rr - k)} ${num(x + rr - k)} ${num(y)} ${num(x + rr)} ${num(y)}`,
    "Z",
  ].join(" ");
}

/** JPEG 的 SOF0/SOF2 段里读原始宽高。 */
export function jpegSize(jpeg: Uint8Array): { w: number; h: number } | undefined {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = jpeg[i + 1];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const len = (jpeg[i + 2] << 8) | jpeg[i + 3];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { h: (jpeg[i + 5] << 8) | jpeg[i + 6], w: (jpeg[i + 7] << 8) | jpeg[i + 8] };
    i += 2 + len;
  }
  return undefined;
}

type ObjParts = (string | Uint8Array)[];

interface Ctx {
  objects: ObjParts[];
}

function addObject(ctx: Ctx, parts: ObjParts): number {
  ctx.objects.push(parts);
  return ctx.objects.length;
}

/** 画布坐标（y 向下）→ PDF 坐标（y 向上）。 */
function flipY(page: PdfPage, y: number): number {
  return page.height - y;
}

function opsToStream(page: PdfPage, imageIds: Map<string, number>): string {
  const lines: string[] = [];
  for (const op of page.ops) {
    if (op.k === "rect") {
      const d = roundRectPath(op.x, flipY(page, op.y + op.h), op.w, op.h, op.r ?? 0);
      lines.push(pathToOps(d), paint(op.fill, op.stroke, op.lineWidth ?? 1));
    } else if (op.k === "path") {
      lines.push(pathToOps(op.d), paint(op.fill, op.stroke, op.lineWidth ?? 1));
    } else if (op.k === "text") {
      const w = textAdvance(op.text, op.size);
      const x = op.anchor === "middle" ? op.x - w / 2 : op.anchor === "end" ? op.x - w : op.x;
      const color = hexToRgbTriplet(op.color ?? "#000000");
      lines.push(
        "BT",
        `${color ?? "0 0 0"} rg`,
        `/F1 ${num(op.size)} Tf`,
        `1 0 0 -1 ${num(x)} ${num(flipY(page, op.y))} Tm`,
        `<${utf16Hex(op.text)}> Tj`,
        "ET"
      );
    } else {
      const key = imageKey(op.jpeg);
      const id = imageIds.get(key);
      if (!id) continue;
      lines.push(
        "q",
        `${num(op.w)} 0 0 ${num(op.h)} ${num(op.x)} ${num(flipY(page, op.y + op.h))} cm`,
        `/Im${id} Do`,
        "Q"
      );
    }
  }
  return lines.filter((l) => l !== "").join("\n");
}

function paint(fill?: string, stroke?: string, lineWidth = 1): string {
  const f = hexToRgbTriplet(fill);
  const s = hexToRgbTriplet(stroke);
  const out: string[] = [];
  if (f) out.push(`${f} rg`);
  if (s) out.push(`${s} RG`, `${num(lineWidth)} w`);
  const op = f && s ? "B" : f ? "f" : "S";
  out.push(op);
  return out.join("\n");
}

function imageKey(jpeg: Uint8Array): string {
  return `${jpeg.length}:${jpeg[0]}:${jpeg[jpeg.length - 1]}`;
}

export function buildPdf(pages: PdfPage[], meta: { title?: string } = {}): Uint8Array {
  if (!pages.length) throw new Error("PDF 至少需要一页");
  const ctx: Ctx = { objects: [] };

  const catalog = addObject(ctx, [""]);
  const pageTree = addObject(ctx, [""]);
  const info = addObject(ctx, [""]);
  // Type0 → CIDFont → FontDescriptor 必须连着入表，字典里引用的是"下一个号"，
  // 所以号要先算出来再用；拿 addObject 的返回值自引用会踩进 const 的暂时性死区。
  const fontType0 = ctx.objects.length + 1;
  const fontCid = fontType0 + 1;
  const fontDesc = fontCid + 1;
  addObject(ctx, [
    `<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light-UCS2 /Encoding /UniGB-UCS2-H /DescendantFonts [${fontCid} 0 R] >>`,
  ]);
  addObject(ctx, [
    `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor ${fontDesc} 0 R /DW 1000 >>`,
  ]);
  addObject(ctx, [
    "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -254 /CapHeight 880 /StemV 93 >>",
  ]);
  const helv = addObject(ctx, ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"]);

  // 图片：相同字节只嵌一次。
  const imageIds = new Map<string, number>();
  for (const p of pages) {
    for (const op of p.ops) {
      if (op.k !== "image") continue;
      const key = imageKey(op.jpeg);
      if (imageIds.has(key)) continue;
      const dims = jpegSize(op.jpeg) ?? { w: Math.round(op.w), h: Math.round(op.h) };
      imageIds.set(
        key,
        addObject(ctx, [
          `<< /Type /XObject /Subtype /Image /Width ${dims.w} /Height ${dims.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${op.jpeg.length} >>`,
          "stream\n",
          op.jpeg,
          "\nendstream",
        ])
      );
    }
  }

  const pageIds: number[] = [];
  const streamIds: number[] = [];
  // 这里只按页数占两个号（页面 + 内容流），具体内容等图片对象都入表后回填。
  pages.forEach(() => {
    pageIds.push(addObject(ctx, [""]));
    streamIds.push(addObject(ctx, [""]));
  });

  // 回填占位对象（id 已确定，内容才写得全）。
  const fontRes = `<< /F1 ${fontType0} 0 R /F2 ${helv} 0 R >>`;
  const imageRes = [...imageIds.entries()]
    .map(([, id]) => `/Im${id} ${id} 0 R`)
    .join(" ");
  const resources = `<< /Font ${fontRes}${imageRes ? ` /XObject << ${imageRes} >>` : ""} >>`;
  ctx.objects[catalog - 1] = [`<< /Type /Catalog /Pages ${pageTree} 0 R >>`];
  ctx.objects[pageTree - 1] = [
    `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`,
  ];
  ctx.objects[info - 1] = [`<< /Producer (z-biz-tool-mind) /CreationDate (D:${stamp()})${meta.title ? ` /Title (${esc(meta.title)})` : ""} >>`];
  pages.forEach((p, ix) => {
    const stream = opsToStream(p, imageIds);
    const raw = ASCII.encode(stream);
    ctx.objects[streamIds[ix] - 1] = [
      `<< /Length ${raw.length} >>`,
      "stream\n",
      raw,
      "\nendstream",
    ];
    ctx.objects[pageIds[ix] - 1] = [
      `<< /Type /Page /Parent ${pageTree} 0 R /Resources ${resources} /MediaBox [0 0 ${num(p.width)} ${num(
        p.height
      )}] /Contents ${streamIds[ix]} 0 R >>`,
    ];
  });

  const buf = new Buf();
  buf.s("%PDF-1.4\n");
  buf.bytes(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // 二进制提示注释
  const offsets: number[] = [];
  ctx.objects.forEach((parts, ix) => {
    offsets[ix] = buf.length;
    buf.s(`${ix + 1} 0 obj\n`);
    for (const p of parts) {
      if (typeof p === "string") buf.s(p);
      else buf.bytes(p);
    }
    buf.s("\nendobj\n");
  });
  const xrefAt = buf.length;
  buf.s(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`);
  for (const off of offsets) buf.s(`${String(off).padStart(10, "0")} 00000 n \n`);
  buf.s(
    `trailer\n<< /Size ${offsets.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  );
  return buf.take();
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(
    d.getSeconds()
  )}`;
}

function esc(s: string): string {
  return s.replace(/([\\()])/g, "\\$1").replace(/[^\x20-\x7e]/g, "");
}
