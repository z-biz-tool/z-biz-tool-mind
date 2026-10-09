/**
 * 导入器：XMind / FreeMind / OPML / CSV / Markdown / 缩进文本 / HTML → 主题树。
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
 * 7) CSV 的引号、内嵌逗号、"" 转义、BOM 与 CRLF；表头认不认中文列名；
 * 8) HTML 是宽松语法：严格 XML 解析器连我们自己的导出产物都读不了；页面外壳（标题、
 *    内嵌 SVG、"大纲"小标题）不能变成主题；样式表/脚本里的字符串不能变成主题；
 * 9) 导入清单与选择框分组与嗅探必须同源 —— 收一个 sniff 不认的扩展名就是"点了只会报错"。
 */
import { done, eq, ok, rejects, throws } from "./_harness.ts";
import { encodeText, writeZip } from "../src/engine/emmx/zip.ts";
import { parseEmmx, writeEmmx } from "../src/engine/emmx/codec.ts";
import {
  IMPORT_EXTENSIONS,
  IMPORT_FORMAT_LABELS,
  docFromOutline,
  htmlOutline,
  importBytes,
  importCsv,
  importFilter,
  importFreeMind,
  importHtml,
  importOpml,
  importXmind,
  sniff,
  splitCsv,
} from "../src/engine/import/index.ts";
import { toHtml } from "../src/engine/export/markup.ts";
import { parseXml } from "../src/engine/emmx/xparse.ts";
import { outlineToText } from "../src/engine/outline.ts";
import type { DocumentModel } from "../src/types/model.ts";

const pageText = (doc: DocumentModel, ix = 0): string => outlineToText(doc.pages[ix]);
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// ---------- 嗅探 ----------
eq("嗅探认 .xmind（大小写无关）", sniff("D:\\a\\计划.XMind"), "xmind");
eq("嗅探认 .mm 是 FreeMind", sniff("map.mm"), "freemind");
eq("嗅探认 .md / .markdown", [sniff("a.md"), sniff("b.markdown")], ["markdown", "markdown"]);
eq("嗅探认 .csv 与 .txt", [sniff("t.csv"), sniff("t.txt")], ["csv", "text"]);
eq("嗅探认 .html 与 .htm（大小写无关）", [sniff("页.HTML"), sniff("a.htm")], ["html", "html"]);
eq("嗅探不认的扩展名", sniff("photo.png"), "unknown");
ok(
  "选择框收的扩展名都有解析器（含 .xmind 与 .html）",
  IMPORT_EXTENSIONS.includes(".xmind") &&
    IMPORT_EXTENSIONS.includes(".html") &&
    !IMPORT_EXTENSIONS.includes(".docx"),
  IMPORT_EXTENSIONS.join(",")
);
ok(
  "文件过滤里 XMind 单列一组",
  importFilter().some((f) => f.extensions.includes("xmind"))
);
{
  // 清单 ⇄ 嗅探 ⇄ 选择框分组三处同源：任何一处漏抄，用户点到的就是一个只会报错的选项。
  const blind = IMPORT_EXTENSIONS.filter((ext) => sniff(`文件${ext}`) === "unknown");
  eq("扩展名清单里每一项 sniff 都认得", blind, []);
  const offList = importFilter()
    .flatMap((f) => f.extensions)
    .filter((e) => e !== "*" && !IMPORT_EXTENSIONS.includes(`.${e}`));
  eq("选择框分组不超出清单（多了就是点了没解析器）", offList, []);
  ok(
    "提示清单也收 HTML（界面从这里取，不再各抄一份散文）",
    IMPORT_FORMAT_LABELS.includes("HTML"),
    IMPORT_FORMAT_LABELS.join("/")
  );
}

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
eq(
  "importBytes 走 html 分支",
  pageText(await importBytes("页.html", utf8("<ul><li>甲<ul><li>乙</li></ul></li></ul>"))),
  "甲\n\t乙"
);

// ---------- HTML：宽松语法，只读层级和文字 ----------
const htmlText = (s: string): string => pageText(importHtml(s, "网页"));
eq(
  "列表嵌套给层级（一层 <ul> 一级）",
  htmlText("<ul><li>甲<ul><li>乙<ul><li>丙</li></ul></li></ul></li></ul>"),
  "甲\n\t乙\n\t\t丙"
);
eq("标题给层级", htmlText("<h1>标题</h1><h2>小节</h2><h3>要点</h3>"), "标题\n\t小节\n\t\t要点");
eq(
  "标题当根，同级的 li 挂在它下面",
  htmlText("<h1>标题</h1><ul><li>甲</li><li>乙</li></ul>"),
  "标题\n\t甲\n\t乙"
);
// 装机那份真网页骨架（h2 段 + ul 要点 + 段里再套一层）：要点必须落在自己那一节下面，
// 而不是和节标题齐平。只看上一条测不出这一截 —— 一节的时候"齐平"和"挂上"在树里长一样。
eq(
  "一节一段要点：列表跟着它上面那个标题走",
  htmlText(
    "<h1>纪要</h1><h2>收入</h2><ul><li>续约<li>新签</ul>" +
      "<h2>成本</h2><ul><li>服务器<ul><li>扩容</li></ul></li><li>人力</li></ul>"
  ),
  "纪要\n\t收入\n\t\t续约\n\t\t新签\n\t成本\n\t\t服务器\n\t\t\t扩容\n\t\t人力"
);
eq("漏写 </li> 也照样分行", htmlText("<ul><li>甲<li>乙<li>丙</ul>"), "甲\n\t乙\n\t丙");
eq(
  "项里的第二段挂到这一项下面，不是变成兄弟",
  htmlText("<ul><li>甲<p>说明<li>乙</ul>"),
  "甲\n\t说明\n\t乙"
);
eq(
  "表格一行 = 一个主题，单元格之间补空格",
  htmlText("<table><tr><td>甲</td><td>乙</td></tr><tr><td>丙</td></tr></table>"),
  "甲 乙\n\t丙"
);
eq("<br> 是项内换行，不是新主题", htmlText("<ul><li>甲<br>乙</li></ul>"), "甲 乙");
eq(
  "实体解码，&nbsp; 压成普通空格",
  htmlText("<ul><li>散记&amp;备忘</li><li>甲&nbsp;&nbsp;乙</li></ul>"),
  "散记&备忘\n\t甲 乙"
);
eq(
  "脚本 / 样式 / 导航 / SVG 里的字符串一概不进来",
  htmlText(
    '<script>var 甲="不该出现"</script><style>li{不该出现}</style><nav>首页 关于</nav>' +
      "<svg><text>图形里的字</text></svg><ul><li>真主题</li></ul>"
  ),
  "真主题"
);
eq("注释不进来", htmlText("<!--甲--><ul><li>乙</li></ul>"), "乙");
eq(
  "行就是制表符缩进的大纲文本（与其余导入同一条 P-3 路）",
  htmlOutline("<ul><li>甲<ul><li>乙</li></ul></li></ul>"),
  "甲\n\t乙"
);
// 这一条钉的是 `<li>` 自己那支，不是通用的块级那一支：走通用支时"空的父项"会把它下面
// 那层缩进一起吃掉（乙 落成 0 级）。normalizeLevels 会把跳层压平，所以这个差别在
// importHtml 的结果里看不出来 —— 只有 htmlOutline 的原始缩进能把它钉住。
eq(
  "空的包裹项（导航/目录常见）不吞掉嵌套层级",
  htmlOutline("<ul><li><ul><li>乙</li></ul></li></ul>"),
  "\t乙"
);
throws(
  "HTML 里也守『空文件要报错』：只有外壳不给一张空白图",
  () => importHtml("<ul></ul>", "空"),
  "没有读到任何主题行"
);
throws(
  "严格 XML 解析器确实读不了 HTML —— 所以才要 htmlOutline 这套宽松扫描",
  () => parseXml("<meta charset=utf-8><ul><li>甲</li></ul>"),
  "未闭合"
);

// ---------- 我们的 HTML 导出 ⇄ 导入：回环不能长出外壳主题 ----------
{
  const outline = "季度规划\n\t收入\n\t\t续约\n\t成本";
  const exported = toHtml(docFromOutline(outline, "季度规划").pages[0], "季度规划");
  eq("导出的 HTML 再导回来，大纲一字不差", htmlText(exported), outline);
  ok("导出的 HTML 里那块是标了记的", /data-mindmap="1"/.test(exported), "");
  eq(
    "没有标记的普通网页仍按整份读（标题也是主题）",
    htmlText("<h1>文章</h1><ul><li>要点</li></ul>"),
    "文章\n\t要点"
  );
}

// ---------- 按声明的 charset 解，不硬按 utf-8 ----------
{
  const gbk = new Uint8Array([
    ...utf8('<meta charset="gbk"><ul><li>'),
    0xd6,
    0xd0,
    0xce,
    0xc4,
    ...utf8("</li></ul>"),
  ]);
  eq(
    "GBK 页面导进来是中文，不是一串 \\ufffd",
    pageText(await importBytes("老页面.html", gbk)),
    "中文"
  );
  const latin = new Uint8Array([
    ...utf8('<meta charset="iso-8859-1"><ul><li>caf'),
    0xe9,
    ...utf8("</li></ul>"),
  ]);
  eq("latin-1 同理", pageText(await importBytes("a.html", latin)), "café");
  const lied = new Uint8Array([...utf8('<meta charset="x-不存在"><ul><li>甲</li></ul>')]);
  eq(
    "声明了个 ICU 没有的标签：回落 utf-8，不整份失败",
    pageText(await importBytes("b.html", lied)),
    "甲"
  );
}

// ---------- 导进来要存得回去：多页 .xmind → .emmx → 再读回来 ----------
const roundTrip = await parseEmmx(await writeEmmx(doc));
eq("存成 .emmx 没有告警", roundTrip.warnings, []);
eq("读回来还是两页", roundTrip.doc.pages.length, 2);
eq(
  "页名跟着走",
  roundTrip.doc.pages.map((p) => p.name),
  ["第一页", "画布2"]
);
eq("第 1 页内容不变", pageText(roundTrip.doc, 0), "中心\n\t甲\n\t\t浮动\n\t乙");
eq("第 2 页内容不变", pageText(roundTrip.doc, 1), "另一张\n\t丙");
eq("activePageId 仍指第 1 页", roundTrip.doc.activePageId, roundTrip.doc.pages[0].id);

done();
