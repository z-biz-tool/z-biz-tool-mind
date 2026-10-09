/**
 * 文本类导出：Markdown / 纯文本大纲 / CSV / OPML / HTML / JSON。
 *
 * 亿图的"另存为"里这几项都存在，共同点是**丢掉图形、只保留层级和文字**。
 * 复刻里它们除 JSON 之外全部由大纲行（outlineRows）生成，一条树六个投影（P-1）——
 * 也就是说这些导出永远不会和画布上的结构对不上。
 * JSON 是唯一走整棵树的：见 toTreeJson 的说明。
 */
import type { Page, Shape } from "../../types/model.ts";
import { isTopic, plainText } from "../../types/model.ts";
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

/**
 * 大纲行 → 嵌套 `<ul>`。
 *
 * 早先是拍平的 `<li style="margin-left:Npx">`：人看着一样，机器读不出来 ——
 * 嵌套列表才是 HTML 表达层级的原生写法，浏览器自己缩进，
 * 而 HTML 导入（import/index.ts 的 htmlOutline）认的就是这一层 `<ul>` 嵌套。
 * 最外层那块带 `data-mindmap`：导入时以它为界，页面自己的标题、内嵌 SVG 都不会被当成主题。
 */
function nestedList(rows: readonly { level: number; text: string }[], topAttrs = ""): string {
  const parts: string[] = [];
  let prev = -1;
  for (const r of rows) {
    const level = Math.max(0, r.level);
    if (prev < 0) parts.push(`<ul${topAttrs}>`);
    else if (level > prev) parts.push("<ul>".repeat(level - prev));
    else if (level < prev) parts.push("</li></ul>".repeat(prev - level));
    else parts.push("</li>");
    parts.push(`<li>${esc(r.text)}`);
    prev = level;
  }
  if (prev >= 0) parts.push("</li>", "</ul>".repeat(prev + 1));
  return parts.join("");
}

/** 单文件 HTML：内嵌 SVG，双击就能看，不需要任何运行时。 */
export function toHtml(page: Page, title: string): string {
  const svg = buildSvg(page, {});
  const outline = nestedList(outlineRows(page), ' data-mindmap="1"');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;margin:0;background:#f7f8fa;color:#333}
h1{font-size:18px;margin:16px}section{background:#fff;margin:16px;padding:12px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.08);overflow:auto}
svg{display:block}ul{list-style:none;padding:0 16px}li{line-height:1.8}</style></head>
<body><h1>${esc(title)}</h1><section>${svg}</section><section><h1 style="font-size:15px">大纲</h1>${outline}</section>
</body></html>`;
}

/**
 * JSON 数据导出（蓝本 §3.12 导出 15 类里的「Json」）。
 *
 * 两处和其余文本导出不一样，都是刻意的：
 * - **走整棵树，不经过大纲投影**：折叠掉的子树在画布上不出现，但那是内容不是视图；
 *   一份拿去给外部程序读的 JSON 少几枝，等于静默丢数据。大纲系五份文本跟随画布折叠，
 *   因为它们给人看；JSON 给机器读，判据得反过来。
 * - **带主题 id 与关系线**：id 是把 `relationships` 的两端对上号的唯一把手。
 *
 * 不带的是视图状态（折叠、缩放、滚动、显示层级）与图形（图片/附件的 relId 指向
 * .emmx 容器内的条目，出了容器就是死链）。蓝本把 Json 只列在导出侧，导入侧没有它，
 * 所以这里不做 JSON 导入 —— 那是自造协议，不是复刻。
 */
interface JsonTopic {
  id: string;
  text: string;
  note?: string;
  labels?: string[];
  link?: string;
  task?: {
    assignees: string[];
    progress: number;
    status: string;
    priority: string;
    start?: string;
    finish?: string;
  };
  children: JsonTopic[];
}

export function toTreeJson(page: Page): string {
  const topic = (s: Shape): JsonTopic => {
    const o: JsonTopic = {
      id: s.id,
      text: plainText(s.text),
      children: children(page, s.id)
        .filter((c) => isTopic(c.type))
        .map(topic),
    };
    if (s.extras.note) o.note = s.extras.note;
    if (s.extras.labels?.length) o.labels = s.extras.labels;
    if (s.extras.hyperlink) o.link = s.extras.hyperlink.target;
    const t = s.extras.task;
    if (t) {
      o.task = {
        assignees: t.assignees,
        progress: t.progress,
        status: t.status,
        priority: t.priority,
        start: dateOf(t.start) || undefined,
        finish: dateOf(t.finish) || undefined,
      };
    }
    return o;
  };
  const roots: JsonTopic[] = [];
  const center = page.shapes[page.rootId];
  if (center) roots.push(topic(center));
  // 浮动主题自成一根（与 outlineEntries 同一判据），硬挂进中心主题会凭空多一层。
  for (const s of Object.values(page.shapes)) {
    if (s.floating && !s.parentId && isTopic(s.type) && s.id !== page.rootId) roots.push(topic(s));
  }
  return (
    JSON.stringify(
      {
        kind: "z-mind.mindmap",
        version: 1,
        name: page.name,
        layout: page.layout.code,
        theme: { id: page.theme.id, name: page.theme.name },
        roots,
        relationships: page.relationships.map((r) => ({
          from: r.beginId,
          to: r.endId,
          text: plainText(r.text),
        })),
      },
      null,
      2
    ) + "\n"
  );
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
