/**
 * 导入器：XMind / FreeMind / OPML / CSV / Markdown / 缩进文本 → 主题树。
 *
 * 缺陷形状（这里刻意覆盖的）：
 * 1) .xmind 有解析器却没人调用：engine 里 importXmind/importBytes 一直躺着，App 那边
 *    自己抄了一份 switch 并硬挡 xmind，报的"还没有对应的解析器"已经不成立；
 * 2) 一份 .xmind 有多个画布时只取第一个 —— 剩下的是静默丢，不是"简化实现"；
 * 3) 节点挂了 detached（浮动主题）时，attached 存在就把 detached 整个吃掉；
 * 4) 老版 content.xml 被当成 FreeMind 解：那边第一句要求根节点是 <map>，
 *    XMind 的根是 <xmap-content>，只能报"这不是 FreeMind 文件"；
 * 5) 空文件产出一张"只有中心主题的空白脑图"还提示导入成功；
 * 6) 多页导进来 page.id 撞车（页签 key 与 activePageId 都靠它）；
 * 7) CSV 的引号、内嵌逗号、"" 转义、BOM 与 CRLF；表头认不认中文列名。
 */
import { done, eq, ok, rejects, throws } from "./_harness.ts";
import { encodeText, writeZip } from "../src/engine/emmx/zip.ts";
import {
  IMPORT_EXTENSIONS,
  docFromOutline,
  importBytes,
  importCsv,
  importFilter,
  importFreeMind,
  importOpml,
  importXmind,
  sniff,
  splitCsv,
} from "../src/engine/import/index.ts";
import { outlineToText } from "../src/engine/outline.ts";
import type { DocumentModel } from "../src/types/model.ts";

const pageText = (doc: DocumentModel, ix = 0): string => outlineToText(doc.pages[ix]);
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// ---------- 嗅探 ----------
eq("嗅探认 .xmind（大小写无关）", sniff("D:\\a\\计划.XMind"), "xmind");
eq("嗅探认 .mm 是 FreeMind", sniff("map.mm"), "freemind");
eq("嗅探认 .md / .markdown", [sniff("a.md"), sniff("b.markdown")], ["markdown", "markdown"]);
eq("嗅探认 .csv 与 .txt", [sniff("t.csv"), sniff("t.txt")], ["csv", "text"]);
eq("嗅探不认的扩展名", sniff("photo.png"), "unknown");
ok(
  "选择框收的扩展名都有解析器（含 .xmind）",
  IMPORT_EXTENSIONS.includes(".xmind") && !IMPORT_EXTENSIONS.includes(".docx"),
  IMPORT_EXTENSIONS.join(",")
);
ok(
  "文件过滤里 XMind 单列一组",
  importFilter().some((f) => f.extensions.includes("xmind"))
);

// ---------- 缩进文本 / Markdown ----------
const outline = "项目计划\n\t阶段一\n\t\t任务A\n\t阶段二";
eq("缩进文本 → 树 → 同一份缩进文本", pageText(docFromOutline(outline, "标题")), outline);
eq(
  "Markdown 列表前缀剥掉、层级按列宽",
  pageText(docFromOutline("- 甲\n  - 乙\n    - 丙", "标题", true)),
  "甲\n\t乙\n\t\t丙"
);
eq(
  "整份都带缩进时，首行升格为中心主题（normalizeLevels 把首行压到 0 级）",
  pageText(docFromOutline("\t甲\n\t\t乙", "我的标题")),
  "甲\n\t乙"
);
throws(
  "空文件报错，不给空白脑图",
  () => docFromOutline("  \n\n\t\n", "标题"),
  "没有读到任何主题行"
);
throws(
  "只有空白也报错（Markdown 档）",
  () => docFromOutline("", "标题", true),
  "没有读到任何主题行"
);

// ---------- FreeMind ----------
const mm =
  '<map version="1.0.1"><node TEXT="根"><node TEXT="子一"><node TEXT="孙"/></node><node TEXT="  多  空格  "/></node></map>';
eq(
  "FreeMind 嵌套 + 空白折叠",
  pageText(importFreeMind(mm, "标题")),
  "根\n\t子一\n\t\t孙\n\t多 空格"
);
throws(
  "FreeMind 缺 <map> 要报错",
  () => importFreeMind('<node TEXT="x"/>', "标题"),
  "找不到 <map>"
);
throws("<map> 里没有节点也报错", () => importFreeMind("<map></map>", "标题"), "没有任何 <node>");

// ---------- OPML ----------
const opml =
  '<?xml version="1.0"?><opml version="2.0"><body><outline text="根"><outline title="子一"/><outline text="子二"><outline text="孙"/></outline></outline></body></opml>';
eq(
  "OPML 的 text/title 两种写法都认",
  pageText(importOpml(opml, "标题")),
  "根\n\t子一\n\t子二\n\t\t孙"
);
throws("OPML 空 body 报错", () => importOpml("<opml><body></body></opml>", "标题"), "body 是空的");

// ---------- CSV ----------
eq(
  "CSV 带 层级/主题 表头",
  pageText(importCsv("层级,主题\n1,根\n2,甲\n2,乙\n3,乙一", "标题")),
  "根\n\t甲\n\t乙\n\t\t乙一"
);
eq(
  "CSV 无表头时第一行当中心主题",
  pageText(importCsv("第一行\n第二行\n第三行", "标题")),
  "第一行\n\t第二行\n\t第三行"
);
eq(
  'CSV 引号里的逗号与 "" 转义',
  pageText(importCsv('level,topic\n1,"含,逗号"\n2,"他说""好"""', "标题")),
  '含,逗号\n\t他说"好"'
);
eq("splitCsv 吃 BOM 与 CRLF", splitCsv("\ufeffa,b\r\n1,2\r\n"), [
  ["a", "b"],
  ["1", "2"],
]);
throws("空 CSV 报错", () => importCsv("", "标题"), "CSV 是空的");

// ---------- XMind：2020+ 的 content.json ----------
const sheets = [
  {
    title: "第一页",
    rootTopic: {
      title: "中心",
      children: {
        attached: [{ title: "甲", children: { detached: [{ title: "浮动" }] } }, { title: "乙" }],
      },
    },
  },
  { rootTopic: { title: "另一张", children: { attached: [{ title: "丙" }] } } },
];
const xmindJson = await writeZip([
  { name: "content.json", data: encodeText(JSON.stringify(sheets)) },
]);
const doc = await importXmind(xmindJson, "D:\\x\\demo.xmind");

eq("两个画布 → 两页", doc.pages.length, 2);
eq("第 1 页内容（浮动主题跟着导进来）", pageText(doc, 0), "中心\n\t甲\n\t\t浮动\n\t乙");
eq("第 2 页内容", pageText(doc, 1), "另一张\n\t丙");
eq("页名取 sheet.title", doc.pages[0].name, "第一页");
eq("没起名的第 2 页按「画布N」补名", doc.pages[1].name, "画布2");
ok(
  "页 id 互不相同",
  new Set(doc.pages.map((p) => p.id)).size === doc.pages.length,
  doc.pages.map((p) => p.id).join(",")
);
eq("activePageId 指向第 1 页", doc.activePageId, doc.pages[0].id);

await rejects(
  "content.json 里没有 rootTopic 时报错",
  importXmind(
    await writeZip([{ name: "content.json", data: encodeText('[{"title":"空"}]') }]),
    "a.xmind"
  ),
  "没有带 rootTopic 的画布"
);
await rejects(
  "zip 里两代 content 都没有",
  importXmind(await writeZip([{ name: "metadata.json", data: encodeText("{}") }]), "a.xmind"),
  "没有 content.json 或 content.xml"
);

// ---------- XMind：老版 content.xml ----------
const legacy =
  '<?xml version="1.0" encoding="UTF-8"?><xmap-content version="2.0">' +
  '<sheet id="s1"><title>旧版页</title><topic id="t1"><title>根</title>' +
  "<children>" +
  '<topics type="attached"><topic id="t2"><title>甲</title><children>' +
  '<topics type="detached"><topic id="t4"><title>浮</title></topic></topics>' +
  "</children></topic></topics>" +
  '<topics type="summary"><topic id="t9"><title>不该进来</title></topic></topics>' +
  "</children></topic></sheet></xmap-content>";
const docLegacy = await importXmind(
  await writeZip([{ name: "content.xml", data: encodeText(legacy) }]),
  "old.xmind"
);
eq("老版 content.xml 走自己的读法，summary 不当主题", pageText(docLegacy, 0), "根\n\t甲\n\t\t浮");
eq("老版页名取 <sheet><title>", docLegacy.pages[0].name, "旧版页");

// ---------- importBytes：单一分发入口 ----------
eq("importBytes 认 .txt", pageText(await importBytes("n.txt", utf8("根\n\t甲"))), "根\n\t甲");
eq(
  "importBytes 的页名取文件名（去扩展名）",
  (await importBytes("D:/d/笔记.md", utf8("- 甲"))).pages[0].name,
  "笔记"
);
eq(
  "反斜杠路径也一样（先拆路径再洗字符，反序会得到 D__d_笔记）",
  (await importBytes("D:\\d\\笔记.md", utf8("- 甲"))).pages[0].name,
  "笔记"
);
eq("importBytes 走 xmind 分支", (await importBytes("demo.xmind", xmindJson)).pages.length, 2);
eq(
  "importBytes 走 freemind 分支",
  pageText(await importBytes("m.mm", utf8(mm))),
  "根\n\t子一\n\t\t孙\n\t多 空格"
);
await rejects(
  "importBytes 对空 csv 报错而不是给空白图",
  importBytes("e.csv", utf8("\uFEFF")),
  "CSV 是空的"
);

done();
