/**
 * 文本类导出：Markdown / 纯文本大纲 / CSV / OPML / HTML。
 *
 * 亿图的"另存为"里这几项都存在，共同点是**丢掉图形、只保留层级和文字**。
 * 复刻里它们全部由大纲行（outlineRows）生成，一条树六个投影（P-1）——
 * 也就是说这些导出永远不会和画布上的结构对不上。
 */
import type { Page } from "../../types/model.ts";
import { plainText } from "../../types/model.ts";
import { outlineRows, slideDeck } from "../projections.ts";
import { children } from "../tree.ts";
import { buildSvg, esc } from "./svg.ts";

const DAY = 86_400_000;

function dateOf(ms?: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function toMarkdown(page: Page): string {
  const rows = outlineRows(page);
  const out: string[] = [];
  for (const r of rows) {
    if (r.level === 0) {
      out.push(`# ${r.text}`);
      continue;
    }
    out.push(`${"  ".repeat(r.level - 1)}- ${r.text}${r.collapsed && r.hiddenCount ? ` <!-- 折叠 ${r.hiddenCount} 项 -->` : ""}`);
    const s = page.shapes[r.id];
    // 续行同缩进：整块引用属于这一项，只缩首行的话在嵌套列表里会断成两段。
    const pad = "  ".repeat(r.level);
    if (s?.extras.note) out.push(`${pad}> ${s.extras.note.replace(/\n/g, `\n${pad}> `)}`);
    if (s?.extras.hyperlink) out.push(`${pad}[${s.extras.hyperlink.target}]`);
  }
  return out.join("\n") + "\n";
}

export function toText(page: Page, indent = "    "): string {
  return (
    outlineRows(page)
      .map((r) => indent.repeat(r.level) + r.text)
      .join("\n") + "\n"
  );
}

export function toCsv(page: Page): string {
  const head = ["层级", "父级", "主题", "备注", "链接", "标签", "负责人", "进度%", "状态", "开始", "结束"];
  const rows = [head];
  for (const r of outlineRows(page)) {
    const s = page.shapes[r.id];
    // 父级取不到就留空：拿自己的文字顶上去，等于在表里凭空多一行"自己是自己的爹"。
    const parent = s?.parentId ? page.shapes[s.parentId] : undefined;
    rows.push([
      String(r.level + 1),
      parent ? plainText(parent.text) : "",
      r.text,
      s?.extras.note ?? "",
      s?.extras.hyperlink?.target ?? "",
      (s?.extras.labels ?? []).join(" "),
      (s?.extras.task?.assignees ?? []).join(" "),
      String(s?.extras.task?.progress ?? 0),
      s?.extras.task?.status ?? "",
      dateOf(s?.extras.task?.start),
      dateOf(s?.extras.task?.finish),
    ]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function csvCell(v: string): string {
  const s = v ?? "";
  // 前导 = / + / - / @ 会被 Excel 当公式执行（CSV 注入），一律加单引号挡掉。
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * OPML 2.0。行序取自大纲投影（P-1）：折叠掉的子树在 Markdown / CSV / 纯文本里没有，
 * 在 OPML 里也不能有 —— 同一份文档导出的四份文本必须数出同一批主题。
 */
export function toOpml(page: Page): string {
  interface OpmlNode {
    text: string;
    note?: string;
    children: OpmlNode[];
  }
  const roots: OpmlNode[] = [];
  const stack: OpmlNode[] = [];
  for (const r of outlineRows(page)) {
    const note = page.shapes[r.id]?.extras.note;
    const node: OpmlNode = { text: r.text, note: note ? note : undefined, children: [] };
    while (stack.length > r.level) stack.pop();
    if (r.level === 0 || stack.length === 0) roots.push(node);
    else stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  const emit = (n: OpmlNode, depth: number): string => {
    const pad = "    ".repeat(depth);
    if (n.children.length === 0 && !n.note) return `${pad}<outline text="${esc(n.text)}"/>\n`;
    const inner = (n.note ? `${pad}    <note>${esc(n.note)}</note>\n` : "") + n.children.map((c) => emit(c, depth + 1)).join("");
    return `${pad}<outline text="${esc(n.text)}">\n${inner}${pad}</outline>\n`;
  };
  const body = roots.map((r) => emit(r, 2)).join("").trimEnd();
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<opml version="2.0">`,
    `  <head><title>${esc(page.name)}</title></head>`,
    `  <body>`,
    body,
    `  </body>`,
    `</opml>`,
    "",
  ].join("\n");
}

/** 「导出为演示文稿（Markdown）」：一页一张幻灯片，--- 分隔。 */
export function toSlidesMarkdown(page: Page): string {
  return slideDeck(page)
    .map((s) => {
      const lines = [`## ${s.title || "未命名"}`];
      for (const b of s.bullets) lines.push(`${"  ".repeat(b.level)}- ${b.text}`);
      if (s.notes) lines.push("", `> ${s.notes}`);
      return lines.join("\n");
    })
    .join("\n\n---\n\n")
    + "\n";
}

/** 单文件 HTML：内嵌 SVG，双击就能看，不需要任何运行时。 */
export function toHtml(page: Page, title: string): string {
  const svg = buildSvg(page, {});
  const outline = outlineRows(page)
    .map((r) => `<li style="margin-left:${r.level * 16}px">${esc(r.text)}</li>`)
    .join("");
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;margin:0;background:#f7f8fa;color:#333}
h1{font-size:18px;margin:16px}section{background:#fff;margin:16px;padding:12px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.08);overflow:auto}
svg{display:block}ul{list-style:none;padding:0 16px}li{line-height:1.8}</style></head>
<body><h1>${esc(title)}</h1><section>${svg}</section><section><h1 style="font-size:15px">大纲</h1><ul>${outline}</ul></section>
</body></html>`;
}

/** 甘特/任务导出用的扁平表（与 CSV 不同：只给有任务字段的分支）。 */
export function toTaskTable(page: Page): { columns: string[]; rows: string[][] } {
  const columns = ["主题", "负责人", "优先级", "状态", "进度%", "开始", "结束", "工期(天)"];
  const rows: string[][] = [];
  const walk = (id: string) => {
    for (const c of children(page, id)) {
      const t = c.extras.task;
      if (t) {
        const days = t.duration ?? (t.start && t.finish ? Math.max(1, Math.round((t.finish - t.start) / DAY)) : 1);
        rows.push([
          plainText(c.text),
          t.assignees.join(" "),
          t.priority,
          t.status,
          String(t.progress),
          dateOf(t.start),
          dateOf(t.finish),
          String(days),
        ]);
      }
      walk(c.id);
    }
  };
  walk(page.rootId);
  return { columns, rows };
}
