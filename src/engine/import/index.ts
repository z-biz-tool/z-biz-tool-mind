/**
 * 导入：emmx / XMind / FreeMind / OPML / Markdown / TXT / CSV。
 *
 * 除 .emmx 之外，其余格式一律先压平成"缩进大纲"，再走 P-3 的同一套插树协议
 * （insertOutline）。这样新增一个导入格式只需要写一个"读出文本行"的函数，
 * 不用碰树操作，也不会出现"导入进来的节点删不掉"这种第二套数据结构的问题。
 */
import type { DocumentModel } from "../../types/model.ts";
import { activePage, createDocument, withActivePage } from "../../model/factory.ts";
import { insertOutline, normalizeLevels, parseOutline } from "../outline.ts";
import { updateText } from "../tree.ts";
import { attr, findAll, parseXml } from "../emmx/xparse.ts";
import { decodeBytes, readZip } from "../emmx/zip.ts";
import { parseEmmx, EmmxError } from "../emmx/codec.ts";

export type ImportKind = "emmx" | "xmind" | "freemind" | "opml" | "markdown" | "text" | "csv" | "unknown";

export function sniff(name: string): ImportKind {
  const n = name.toLowerCase();
  if (n.endsWith(".emmx")) return "emmx";
  if (n.endsWith(".xmind")) return "xmind";
  if (n.endsWith(".mm")) return "freemind";
  if (n.endsWith(".opml")) return "opml";
  if (n.endsWith(".md") || n.endsWith(".markdown")) return "markdown";
  if (n.endsWith(".csv")) return "csv";
  if (n.endsWith(".txt")) return "text";
  return "unknown";
}

/** 大纲文本 → 文档：第一行（层级 0）当中心主题，其余按缩进挂上去。 */
export function docFromOutline(text: string, title: string, markdown = false): DocumentModel {
  const lines = normalizeLevels(parseOutline(text, markdown));
  const doc = createDocument(title);
  let page = activePage(doc);
  if (!lines.length) return doc;
  const root = lines[0].level === 0 ? lines[0] : null;
  page = updateText(page, page.rootId, root ? root.text : title);
  const body = root ? lines.slice(1) : lines;
  if (body.length) {
    const flat = body.map((l) => "\t".repeat(Math.max(0, l.level - (root ? 0 : 1))) + l.text).join("\n");
    page = insertOutline(page, page.rootId, flat, "appendChildren", false).page;
  }
  return withActivePage(doc, page);
}

export async function importBytes(name: string, bytes: Uint8Array): Promise<DocumentModel> {
  const kind = sniff(name);
  if (kind === "emmx") {
    const { doc, warnings } = await parseEmmx(bytes);
    if (warnings.length) throw new EmmxError(warnings.join("；"));
    return doc;
  }
  if (kind === "xmind") return importXmind(bytes, name);
  const text = new TextDecoder("utf-8").decode(bytes);
  if (kind === "freemind") return importFreeMind(text, titleOf(name));
  if (kind === "opml") return importOpml(text, titleOf(name));
  if (kind === "csv") return importCsv(text, titleOf(name));
  return docFromOutline(text, titleOf(name), kind === "markdown");
}

function titleOf(name: string): string {
  const base = name.replace(/[\\/:*?"<>|]/g, "_").split("/").pop() ?? "导入";
  return base.replace(/\.[^.]+$/, "") || "导入";
}

/** XMind（2020+）的 content.json：rootTopic.children.attached 递归。 */
export async function importXmind(bytes: Uint8Array, name: string): Promise<DocumentModel> {
  const entries = await readZip(bytes);
  const json = entries.find((e) => /content\.json$/i.test(e.name));
  if (json) return docFromOutline(xmindLines(JSON.parse(decodeBytes(json.data))), titleOf(name));
  const xml = entries.find((e) => /content\.xml$/i.test(e.name));
  if (xml) return importFreeMind(decodeBytes(xml.data), titleOf(name)); // 老版 XMind 就是 topic/children 结构，同构处理
  throw new Error("这个 .xmind 里没有 content.json 或 content.xml，无法导入");
}

function xmindLines(content: unknown): string {
  const lines: string[] = [];
  const walk = (topic: any, level: number): void => {
    if (!topic || typeof topic !== "object") return;
    const title = String(topic.title ?? topic?.plain?.content ?? "").replace(/\s+/g, " ").trim();
    lines.push("\t".repeat(level) + (title || "未命名"));
    const kids: any[] = topic.children?.attached ?? topic.children?.detached ?? [];
    for (const k of kids) walk(k, level + 1);
  };
  const sheets = Array.isArray(content) ? content : [];
  const rootTopic = sheets[0]?.rootTopic;
  if (!rootTopic) throw new Error("content.json 里没有 rootTopic");
  walk(rootTopic, 0);
  return lines.join("\n");
}

/** FreeMind / 老版 XMind 的 `<node TEXT="…">` 嵌套；备注取 `<richfont>` 的纯文本。 */
export function importFreeMind(xml: string, title: string): DocumentModel {
  const root = parseXml(xml);
  const map = root.tag === "map" ? root : findAll(root, "map")[0];
  if (!map) throw new Error("这不是 FreeMind 文件：找不到 <map>");
  const lines: string[] = [];
  const walk = (n: any, level: number): void => {
    const text = (attr(n, "TEXT") || n.children?.[0]?.text || "").replace(/\s+/g, " ").trim();
    lines.push("\t".repeat(level) + (text || "未命名"));
    for (const c of findAll(n, "node")) walk(c, level + 1);
  };
  const top = findAll(map, "node")[0];
  if (!top) throw new Error("<map> 里没有任何 <node>");
  walk(top, 0);
  return docFromOutline(lines.join("\n"), title);
}

export function importOpml(xml: string, title: string): DocumentModel {
  const root = parseXml(xml);
  const body = findAll(root, "body")[0] ?? root;
  const lines: string[] = [];
  const walk = (n: any, level: number): void => {
    lines.push("\t".repeat(level) + (attr(n, "text") || attr(n, "title") || "未命名"));
    for (const c of findAll(n, "outline")) walk(c, level + 1);
  };
  for (const c of findAll(body, "outline")) walk(c, 0);
  if (!lines.length) throw new Error("OPML 的 body 是空的");
  return docFromOutline(lines.join("\n"), title);
}

/** CSV：第一列层级（1 起），第二列主题；找不到表头就整体按"一列一行"导入。 */
export function importCsv(text: string, title: string): DocumentModel {
  const rows = splitCsv(text);
  if (!rows.length) throw new Error("CSV 是空的");
  const header = rows[0].map((c) => c.trim());
  const headIx = header.findIndex((h) => /^(层级|level|缩进|indent)$/i.test(h));
  const textIx = header.findIndex((h) => /^(主题|标题|内容|topic|title|text)$/i.test(h));
  const lines: string[] = [];
  if (headIx >= 0 && textIx >= 0) {
    for (const r of rows.slice(1)) {
      const lv = Math.max(1, Number(r[headIx]) || 1);
      lines.push("\t".repeat(lv - 1) + (r[textIx] ?? "").trim());
    }
  } else {
    rows.forEach((r, ix) => lines.push(ix === 0 ? r[0] || title : `\t${r[0] || ""}`));
  }
  return docFromOutline(lines.filter((l) => l.trim()).join("\n"), title);
}

/** 带引号状态的 CSV 拆分（只处理 "" 转义，够用且不引入依赖）。 */
export function splitCsv(text: string): string[][] {
  const src = text.replace(/^\ufeff/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** 拖进来的图片/附件不算导入，走 media 通道；这里只收文本类扩展名。 */
export const IMPORT_EXTENSIONS = [".emmx", ".xmind", ".mm", ".opml", ".md", ".markdown", ".txt", ".csv"];

export function importFilter(): { name: string; extensions: string[] }[] {
  return [
    { name: "脑图文件", extensions: ["emmx", "xmind", "mm", "opml"] },
    { name: "文本文件", extensions: ["md", "markdown", "txt", "csv"] },
    { name: "所有文件", extensions: ["*"] },
  ];
}
