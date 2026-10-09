/**
 * 导入：emmx / XMind / FreeMind / OPML / Markdown / TXT / CSV / HTML。
 *
 * 除 .emmx 之外，其余格式一律先压平成"缩进大纲"，再走 P-3 的同一套插树协议
 * （insertOutline）。这样新增一个导入格式只需要写一个"读出文本行"的函数，
 * 不用碰树操作，也不会出现"导入进来的节点删不掉"这种第二套数据结构的问题。
 */
import type { DocumentModel, Page } from "../../types/model.ts";
import { activePage, createDocument, createPage, withActivePage } from "../../model/factory.ts";
import { insertOutline, normalizeLevels, parseOutline } from "../outline.ts";
import type { OutlineLine } from "../outline.ts";
import { updateText } from "../tree.ts";
import { attr, decodeEntities, find, findAll, parseXml } from "../emmx/xparse.ts";
import type { XmlNode } from "../emmx/xparse.ts";
import { decodeBytes, readZip } from "../emmx/zip.ts";
import { parseEmmx, EmmxError } from "../emmx/codec.ts";

export type ImportKind =
  "emmx" | "xmind" | "freemind" | "opml" | "markdown" | "text" | "csv" | "html" | "unknown";

export function sniff(name: string): ImportKind {
  const n = name.toLowerCase();
  if (n.endsWith(".emmx")) return "emmx";
  if (n.endsWith(".xmind")) return "xmind";
  if (n.endsWith(".mm")) return "freemind";
  if (n.endsWith(".opml")) return "opml";
  if (n.endsWith(".md") || n.endsWith(".markdown")) return "markdown";
  if (n.endsWith(".csv")) return "csv";
  if (n.endsWith(".html") || n.endsWith(".htm")) return "html";
  if (n.endsWith(".txt")) return "text";
  return "unknown";
}

/** 大纲文本 → 文档：第一行（层级 0）当中心主题，其余按缩进挂上去。 */
export function docFromOutline(text: string, title: string, markdown = false): DocumentModel {
  const lines = outlineOf(text, markdown);
  // 空文件给的是"报错"而不是"一张只有中心主题的空白图"：后者看着像导入成功，
  // 用户要过一会儿才发现什么都没进来（CSV / OPML / FreeMind 那三个也是这么定的）。
  if (!lines.length) throw new Error("这份文件里没有读到任何主题行（空文件？）");
  const doc = createDocument(title);
  return withActivePage(doc, pageFromOutline(lines, activePage(doc)));
}

function outlineOf(text: string, markdown = false): OutlineLine[] {
  return normalizeLevels(parseOutline(text, markdown));
}

/**
 * 把一份大纲灌进已经存在的页。normalizeLevels 保证首行是层级 0（outline.ts:99），
 * 所以第一行就是中心主题，整份都是缩进文本时也一样 —— 不会出现"没有父可寻"的那种首行。
 */
function pageFromOutline(lines: readonly OutlineLine[], page: Page): Page {
  let p = updateText(page, page.rootId, lines[0].text);
  const flat = lines
    .slice(1)
    .map((l) => "\t".repeat(l.level) + l.text)
    .join("\n");
  p = insertOutline(p, p.rootId, flat, "appendChildren", false).page;
  return p;
}

export async function importBytes(name: string, bytes: Uint8Array): Promise<DocumentModel> {
  const kind = sniff(name);
  if (kind === "emmx") {
    const { doc, warnings } = await parseEmmx(bytes);
    if (warnings.length) throw new EmmxError(warnings.join("；"));
    return doc;
  }
  if (kind === "xmind") return importXmind(bytes, name);
  if (kind === "html") return importHtml(decodeHtml(bytes), titleOf(name));
  const text = new TextDecoder("utf-8").decode(bytes);
  if (kind === "freemind") return importFreeMind(text, titleOf(name));
  if (kind === "opml") return importOpml(text, titleOf(name));
  if (kind === "csv") return importCsv(text, titleOf(name));
  return docFromOutline(text, titleOf(name), kind === "markdown");
}

/** 页名取文件名（去扩展名）。先拆路径再洗非法字符 —— 反序会把 "D:\\d\\笔记.md" 洗成 "D__d_笔记"。 */
function titleOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  return base.replace(/[<>:"|?*]/g, "_").replace(/\.[^.]+$/, "") || "导入";
}

/**
 * .xmind 是一个 zip，里面两代格式并存：2020+ 的 content.json（数组，一项一个画布），
 * 老版的 content.xml。两条路都走多页，谁也别只留第一页。
 */
export async function importXmind(bytes: Uint8Array, name: string): Promise<DocumentModel> {
  const entries = await readZip(bytes);
  const json = entries.find((e) => /content\.json$/i.test(e.name));
  if (json) return docFromSheets(xmindSheets(JSON.parse(decodeBytes(json.data))), titleOf(name));
  const xml = entries.find((e) => /content\.xml$/i.test(e.name));
  if (xml) return docFromSheets(xmindXmlSheets(decodeBytes(xml.data)), titleOf(name));
  throw new Error("这个 .xmind 里没有 content.json 或 content.xml，无法导入");
}

interface XmindSheet {
  name: string;
  outline: string;
}

/**
 * 一份 .xmind 可以有多个画布。全部导成页，而不是只取第一个：
 * 用户在一款软件里画了四张图，导进来只剩一张是"静默丢数据"，不是"简化实现"。
 */
function xmindSheets(content: unknown): XmindSheet[] {
  const sheets = Array.isArray(content) ? content : [];
  const out: XmindSheet[] = [];
  for (const s of sheets) {
    const rootTopic = s?.rootTopic;
    if (!rootTopic || typeof rootTopic !== "object") continue; // 没有中心主题的画布导进来是空白页
    const lines: string[] = [];
    walkTopic(rootTopic, 0, lines);
    out.push({ name: String(s.title ?? "").trim(), outline: lines.join("\n") });
  }
  if (!out.length) throw new Error("这份 .xmind 的 content.json 里没有带 rootTopic 的画布");
  return out;
}

function walkTopic(topic: any, level: number, lines: string[]): void {
  const title = String(topic.title ?? topic?.plain?.content ?? "")
    .replace(/\s+/g, " ")
    .trim();
  lines.push("\t".repeat(level) + (title || "未命名"));
  // detached 在 XMind 里是"浮动主题"，我们不建模这个摆放位置，但也不能不导 ——
  // 之前写成 attached ?? detached，只要节点有子主题，它挂的浮动主题就整个没了。
  const kids: any[] = [
    ...(Array.isArray(topic.children?.attached) ? topic.children.attached : []),
    ...(Array.isArray(topic.children?.detached) ? topic.children.detached : []),
  ];
  for (const k of kids) if (k && typeof k === "object") walkTopic(k, level + 1, lines);
}

/**
 * 老版 XMind（8 及以前）的 content.xml：`<sheet><topic>` 嵌套，子主题在
 * `<children><topics type="attached">` 里。它跟 FreeMind 的 `<map><node>` 不是一回事，
 * 所以不能塞给 importFreeMind —— 那边第一句就要求根节点是 `<map>`，只会报"这不是 FreeMind 文件"。
 */
function xmindXmlSheets(xml: string): XmindSheet[] {
  const root = parseXml(xml);
  const sheets = root.tag === "sheet" ? [root] : findAll(root, "sheet");
  const out: XmindSheet[] = [];
  for (const s of sheets) {
    const topic = find(s, "topic");
    if (!topic) continue;
    const lines: string[] = [];
    walkXmlTopic(topic, 0, lines);
    out.push({
      name: (find(s, "title")?.text ?? "").replace(/\s+/g, " ").trim(),
      outline: lines.join("\n"),
    });
  }
  if (!out.length) throw new Error("这份 .xmind 的 content.xml 里没有带中心主题的 <sheet>");
  return out;
}

function walkXmlTopic(topic: XmlNode, level: number, lines: string[]): void {
  const title = (find(topic, "title")?.text ?? "").replace(/\s+/g, " ").trim();
  lines.push("\t".repeat(level) + (title || "未命名"));
  const children = find(topic, "children");
  if (!children) return;
  for (const group of findAll(children, "topics")) {
    const type = attr(group, "type");
    // summary / notes 那两类 <topics> 装的不是主题，跟着挂上去会多出凭空节点。
    if (type && type !== "attached" && type !== "detached") continue;
    for (const k of findAll(group, "topic")) walkXmlTopic(k, level + 1, lines);
  }
}

/** 第 1 页沿用文档标题当页名（没起名的话），后面的页按「画布N」补名。 */
function docFromSheets(sheets: readonly XmindSheet[], title: string): DocumentModel {
  const doc = createDocument(title);
  const first = activePage(doc);
  const base = Number(first.id) || 0;
  const pages = sheets.map((s, i) => {
    const name = s.name || (i === 0 ? title : `画布${i + 1}`);
    const page: Page = i === 0 ? { ...first, name } : { ...createPage(name), id: String(base + i) };
    return pageFromOutline(outlineOf(s.outline), page);
  });
  return { ...doc, pages, activePageId: pages[0].id };
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

/**
 * HTML 导入（蓝本 §3.12 导入清单里的 HTML）。
 *
 * 为什么不复用 xparse 的 parseXml：那是给 .emmx 写的**严格**解析器，标签不匹配就抛。
 * 现实里的 HTML 满是没写斜杠的 void 标签（`<meta charset=utf-8>`）和省略的 `</p>`，
 * 连我们自己的 toHtml 产物都过不了它 —— 严格解析器读不了 HTML 是格式决定的，不是实现问题。
 *
 * 这里只问一件事：能不能读出层级和文字。层级的载体是 `<ul>/<ol>` 的嵌套与 `<h1>–<h6>`；
 * 脚本、样式、导航、SVG 图形的内容整体丢掉（SVG 里的 `<text>` 是画布上那几个字的副本，
 * 导进来就是一堆重复主题），其余标签只当内联包装。这与其余文本导入同一条边界：丢图形、留层级和文字。
 * 一项内部的换行压成空格：主题文字的多段在 HTML 里本来就看不出边界。
 */
export function importHtml(html: string, title: string): DocumentModel {
  return docFromOutline(htmlOutline(machineBlock(html)), title);
}

/**
 * 认机器可读的那一块。
 *
 * 我们自己的 HTML 导出是"给人看的单文件"：标题、内嵌 SVG、还有一个「大纲」小标题。
 * 按通用规则整份读回来会多出两个主题（页面标题和那个小标题）—— 那是页面外壳，不是内容。
 * 所以导出时给大纲那块 `<ul>` 打了 `data-mindmap`，导入时认到这个标记就只读它罩住的子树；
 * 没有标记的普通网页仍按整份读（标题给层级、列表给枝干）。
 *
 * 标签名是从文档里匹配出来的（`[a-z][\w:-]*`，不含正则元字符），拼进第二个 RegExp 是安全的。
 */
function machineBlock(src: string): string {
  const m = /<([a-z][\w:-]*)(?=[^>]*\bdata-mindmap\b)[^>]*>/i.exec(src);
  if (!m) return src;
  const re = new RegExp(`<(/?)${m[1]}\\b`, "gi");
  re.lastIndex = m.index + m[0].length;
  let depth = 1;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(src))) {
    depth += hit[1] === "/" ? -1 : 1;
    if (depth === 0) return src.slice(m.index, src.indexOf(">", hit.index) + 1);
  }
  return src.slice(m.index); // 标记块没闭合（截断的文件）：读到末尾，别把整份丢了
}

/** 内容整体丢掉的标签（它的子树在读到同名结束标签前一律不看）。 */
const HTML_DROP = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "head",
  "select",
  "textarea",
  "iframe",
  "nav",
  "footer",
  "header",
  "aside",
  "button",
  "form",
  "svg",
]);
/** 撑起一行的块级标签。div/section 不表达层级（它们只表达"这是一块"），层级只由列表嵌套和标题给。 */
const HTML_ITEM = new Set([
  "p",
  "div",
  "li",
  "dd",
  "dt",
  "tr",
  "blockquote",
  "pre",
  "section",
  "article",
]);
/** 没有结束标签的那批；`<br>` 是项内换行，其余连文字都不带。 */
const HTML_VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * HTML → 缩进大纲文本（一层一个制表符，归一交给 parseOutline / normalizeLevels）。
 *
 * 状态只有四个：开着哪一项（cur）、它的层级（level）、列表嵌套深度（listDepth）、
 * 最近一个标题给正文垫的层级（headBase）。
 * `<li>` 不等 `</li>` 就自起一行（漏写结束标签是最常见的 HTML 写法），
 * 表格的 `<td>/<th>` 不另起一行 —— 一行 = 一个主题，单元格之间补空格。
 */
export function htmlOutline(src: string): string {
  const lines: string[] = [];
  let cur: string | null = null;
  let level = 0;
  let listDepth = 0;
  let dropTag = "";
  let drop = 0;
  // 最近一个标题把"它下面的正文"压到第几级。一篇真网页的骨架是 h2 段 + ul 要点，
  // 只按列表嵌套算的话要点会齐平在标题那一层（装上一份真网页才看出来）。
  let headBase = 0;
  const flush = () => {
    if (cur !== null) {
      const t = cur.replace(/\s+/g, " ").trim();
      if (t) lines.push("\t".repeat(level) + t);
    }
    cur = null;
  };
  const itemLevel = () => headBase + Math.max(0, listDepth - 1);

  for (const [tok] of src
    .replace(/<!--[\s\S]*?-->/g, " ")
    .matchAll(/<(?:"[^"]*"|'[^']*'|[^"'<>])*>|[^<]+/g)) {
    const isTag = tok[0] === "<";
    const m = isTag ? /^<\s*(\/?)\s*([a-zA-Z][\w:-]*)([\s\S]*)$/.exec(tok) : null;
    const tag = m ? m[2].toLowerCase() : "";

    // 丢弃区（script/style/svg/nav/…）里连文字都不看：样式表里的 "li{甲}" 不是主题。
    if (drop > 0) {
      if (m && tag === dropTag && !m[3].endsWith("/>") && !HTML_VOID.has(tag))
        drop += m[1] === "/" ? -1 : 1;
      if (drop <= 0) dropTag = "";
      continue;
    }
    if (!isTag) {
      // 游离文本自起一行（手写大纲常见 `<body>中心主题<ul>…`）；纯空白不算行。
      if (cur === null && tok.trim()) {
        cur = "";
        level = itemLevel();
      }
      if (cur !== null) cur += decodeEntities(tok);
      continue;
    }
    if (!m) continue; // <!DOCTYPE>、<?xml?>、认不出的碎片
    const closing = m[1] === "/";
    const selfClose = m[3].endsWith("/>");

    if (!closing && !selfClose && HTML_DROP.has(tag)) {
      dropTag = tag;
      drop = 1;
      continue;
    }
    if (tag === "ul" || tag === "ol") {
      if (closing) {
        flush();
        listDepth = Math.max(0, listDepth - 1);
      } else if (!selfClose) listDepth += 1;
      continue;
    }
    if (HTML_VOID.has(tag)) {
      if (tag === "br" && cur !== null) cur += " ";
      continue;
    }
    const head = /^h([1-6])$/.exec(tag);
    if (head) {
      flush();
      if (!closing && !selfClose) {
        cur = "";
        level = Number(head[1]) - 1;
        headBase = level + 1;
      }
      continue;
    }
    if (tag === "li" && !closing) {
      flush();
      cur = "";
      level = itemLevel();
      continue;
    }
    if (closing) {
      if (HTML_ITEM.has(tag)) flush();
      else if (tag === "td" || tag === "th") cur = cur === null ? null : cur + " ";
      continue;
    }
    if (selfClose) continue;
    if (tag === "td" || tag === "th") {
      if (cur === null) {
        cur = "";
        level = itemLevel();
      }
      continue;
    }
    if (HTML_ITEM.has(tag)) {
      // 已经开着一项但还没有正文（`<li><p>x</p></li>`）：沿用这一项，别让内层标签把它换成同级。
      if (cur !== null && cur.trim() === "") continue;
      flush();
      cur = "";
      level = itemLevel();
    }
  }
  flush();
  return lines.join("\n");
}

/**
 * HTML 自带 charset 声明，中文网络上的老页面还有一大截是 GBK。按 utf-8 硬解得到一串
 * ``（导入"成功"却全是乱码），比直接失败难查得多。声明必然在 ASCII 前缀里，
 * 所以先用 utf-8 解一段去读它，认得的标签再重解整份；ICU 没有这个转换器就回落 utf-8。
 */
function decodeHtml(bytes: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  const m = /charset\s*=\s*["']?\s*([\w-]+)/i.exec(utf8.slice(0, 2048));
  const label = (m?.[1] ?? "").toLowerCase();
  if (
    !/^(gb(?:2312|k|18030)|big5|shift[-_]?jis|euc-(?:jp|kr)|iso-8859-\d|windows-125\d)$/.test(label)
  ) {
    return utf8;
  }
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return utf8;
  }
}

/**
 * 选择框里只收**真的有解析器**的扩展名 —— 一个能让用户点出"暂不支持"的选项，
 * 比没有这个选项更坏。.xmind 之前就是因为这句话被摘掉的，现在 importXmind 在
 * importBytes 里真的走得到，所以放回来。
 */
export const IMPORT_EXTENSIONS = [
  ".xmind",
  ".mm",
  ".opml",
  ".md",
  ".markdown",
  ".txt",
  ".csv",
  ".html",
  ".htm",
];

/**
 * 给用户看的格式名清单（报错提示、工具栏 title 都从这里取）。
 * 之前这些名字是界面里各抄一份散文列表：加一个格式就得记着改三处，漏抄一处就是错的提示。
 */
export const IMPORT_FORMAT_LABELS = [
  "XMind",
  "FreeMind",
  "OPML",
  "Markdown",
  "CSV",
  "HTML",
  "缩进文本",
];

export function importFilter(): { name: string; extensions: string[] }[] {
  return [
    { name: "XMind 思维导图", extensions: ["xmind"] },
    { name: "大纲/思维导图文件", extensions: ["mm", "opml"] },
    { name: "文本/网页文件", extensions: ["md", "markdown", "txt", "csv", "html", "htm"] },
    { name: "所有文件", extensions: ["*"] },
  ];
}
