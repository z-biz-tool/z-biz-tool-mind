/**
 * 导出层（doc/复刻方案/00 §3.11 分发）：十三种格式全部由同一份 Page 现算。
 * 覆盖的缺陷形状：
 * 1) 文本类导出必须数出与大纲投影同一批主题（P-1），折叠与浮动主题四份文本要一致；
 * 2) CSV 的 Excel 公式注入与引号转义；
 * 3) SVG / PDF 用的是布局量出来的同一套折行（P-2）；
 * 4) 文件名里的非法字符、空主题兜底；
 * 5) PDF 的 CJK 走标准 CID 字体（不嵌字体，Windows 与 macOS 都能开）；
 * 6) 格式表与 dispatch 必须同步 —— 表里有一项、switch 里没分支，是只有点下去那天才炸的洞（emmx 就躺过）；
 * 7) JSON 是唯一走整棵树的导出：折叠掉的枝在画布上没有，在数据面上不能没有。
 *
 * 折叠的取舍在这一层有两个答案，是刻意的：大纲系（Markdown/CSV/TXT/OPML/HTML）跟着画布走，
 * 折叠掉的子树不出现；演示稿按整棵树出片 —— 收起分支是为了看图，不是为了删内容。
 * JSON 属于后者，理由见 toTreeJson。
 */
import { done, eq, near, ok, rejects } from "./_harness.ts";
import { createPage } from "../src/model/factory.ts";
import {
  A4_PORTRAIT,
  FORMATS,
  SAVE_AS_FORMATS,
  exportArtifact,
  formatOf,
  pdfPagesOf,
  transformPath,
} from "../src/engine/export/index.ts";
import { buildSvg, paintPage } from "../src/engine/export/svg.ts";
import { buildPdf } from "../src/engine/export/pdf.ts";
import {
  toCsv,
  toHtml,
  toMarkdown,
  toOpml,
  toSlidesMarkdown,
  toTaskTable,
  toText,
  toTreeJson,
} from "../src/engine/export/markup.ts";
import {
  insertChild,
  setCollapsed,
  setFloating,
  toggleRelationship,
  updateExtras,
  updateText,
} from "../src/engine/tree.ts";
import { outlineRows } from "../src/engine/projections.ts";
import { isTopic } from "../src/types/model.ts";
import type { Page } from "../src/types/model.ts";

const asText = (b: Uint8Array) => new TextDecoder().decode(b);

let cur = createPage("导出");
// createPage 给的根主题文字是"中心主题"，导出文件名取的就是它 —— 样张里先改成页名，
// 让"文件名取根主题"这一条断言真的在测根主题而不是兜底。
cur = updateText(cur, cur.rootId, "导出");
const root = () => cur.rootId;
function add(parentId: string, text: string): string {
  const r = insertChild(cur, parentId, text);
  cur = r.page;
  return r.id;
}

// ---------------------------------------------------------------- 样张：三层 + 备注 + 标签 + 任务 + 链接 + 折叠 + 浮动
const dev = add(root(), "开发");
const login = add(dev, "登录联调");
cur = updateExtras(cur, login, { note: "接口要\n对齐两次", labels: ["紧急", "安全"], hyperlink: { target: "https://example.com/a?x=1&y=2" } });
const report = add(dev, "报表导出");
cur = updateExtras(cur, report, { task: { status: "done", progress: 100, assignees: ["张三"], priority: "high", start: Date.UTC(2026, 9, 1), finish: Date.UTC(2026, 9, 3), duration: 3, tags: [], milestone: false } });
const qa = add(root(), "测试");
const qaDeep = add(qa, "两轮回归");
cur = setCollapsed(cur, qaDeep, true);
add(qaDeep, "用例清单");
const risky = add(root(), "=1+1");
cur = updateExtras(cur, risky, { note: '带"引号"、逗号，和\n换行' });
// 主题文字里带 &：SVG / OPML / HTML 三条转义路径都要吃下它
const memo = add(root(), "散记&备忘");
cur = setFloating(cur, memo, 400, 240);
const floatKid = add(memo, "浮动子");
// 有标签数组但是空的：JSON 侧的判据是"没内容就不出这个键"，样张里得真有这么一个主题。
cur = updateExtras(cur, floatKid, { labels: [] });
const page = cur;

/** 大纲投影的行数：中心主题 + 3 个主分支 + 2 个二级 + 折叠的那枝自身 + 浮动树两行。 */
const total = 9;

// ---------------------------------------------------------------- 格式表本身
{
  eq("十三种格式与导出对话框一一对应", FORMATS.length, 13);
  eq("格式 id 不重复", new Set(FORMATS.map((f) => f.id)).size, FORMATS.length);
  eq("每个格式都有扩展名与 MIME", FORMATS.every((f) => f.ext !== "" && f.mime.includes("/")), true);
  eq("未知 id 兜到第一项（.emmx）", formatOf("nope" as never).id, "emmx");
  eq("需要光栅化的三种格式标了 needsCanvas", FORMATS.filter((f) => f.needsCanvas).map((f) => f.id), ["png", "jpg", "pdf"]);
  eq("图片那一组是 PNG / JPG / SVG（蓝本 §3.12「导出 15 类：图片(PNG/JPG)」）",
    FORMATS.filter((f) => f.group === "图片").map((f) => f.id), ["svg", "png", "jpg"]);
}

// ---------------------------------------------------------------- 完整性门：表里每一项都要有落点
{
  // emmx 在表里（对话框按组渲染这张表），却故意不进导出引擎 —— 于是"表里加一项、switch 里忘加分支"
  // 只有用户点下去那天才炸。这一版之前就是这个状态：exportArtifact(emmx) 抛的是"不支持的导出格式"。
  // 判据遍历 FORMATS，所以漏一项就在这一条上红，而不是等运行时。
  const holes: string[] = [];
  for (const f of FORMATS) {
    try {
      await exportArtifact(page, f.id);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (m.startsWith("不支持的导出格式")) holes.push(f.id);
    }
  }
  eq("格式表里没有点了只会抛「不支持」的项", holes, []);
  ok(
    "另存为那一类里确实躺着 emmx（这张表空转的话，上面的循环一行都不会跑）",
    SAVE_AS_FORMATS.includes("emmx"),
    SAVE_AS_FORMATS.join(",")
  );
  for (const id of SAVE_AS_FORMATS) {
    await rejects(`${id} 的落点是另存为那条路（报错要指路）`, exportArtifact(page, id), "另存为");
  }
  ok("SVG 与 JSON 不属于另存为那一类", !SAVE_AS_FORMATS.includes("svg") && !SAVE_AS_FORMATS.includes("json"), "");
}

// ---------------------------------------------------------------- 四份文本导出的主题数必须一致（P-1）
{
  const outlineCount = (s: string) => (s.match(/<outline /g) ?? []).length;
  eq("纯文本大纲行数", toText(page).trimEnd().split("\n").length, total);
  eq("Markdown 大纲的主题条目数", (toMarkdown(page).match(/^[ \t]*- /gm) ?? []).length, total - 2);
  eq("Markdown 的标题只有中心主题与浮动主题", (toMarkdown(page).match(/^# /gm) ?? []).length, 2);
  eq("CSV 行数 = 表头 + 每个主题一行", toCsv(page).trimEnd().split("\r\n").length, total + 1);
  eq("OPML 的 outline 数与大纲投影同行", outlineCount(toOpml(page)), total);
  eq("折叠的子树在任何一份文本里都不出现", [toText(page), toMarkdown(page), toCsv(page), toOpml(page)].some((s) => s.includes("用例清单")), false);
  eq("浮动主题在四份文本里都在", [toText(page), toMarkdown(page), toCsv(page), toOpml(page)].every((s) => s.includes("散记")), true);
}

// ---------------------------------------------------------------- Markdown
{
  const md = toMarkdown(page);
  eq("中心主题是一级标题", md.startsWith("# 导出\n"), true);
  ok("层级用两个空格一档", md.includes("  - 登录联调") && md.includes("- 开发"), md.split("\n").slice(0, 6).join(" / "));
  ok("备注写成引用块，续行同缩进", md.includes("    > 接口要\n    > 对齐两次"), "");
  ok("链接单独一行", md.includes("    [https://example.com/a?x=1&y=2]"), "");
  ok("折叠在行尾留了注记", /<!-- 折叠 1 项 -->/.test(md), "");
}

// ---------------------------------------------------------------- CSV：Excel 会踩的两个坑
{
  const csv = toCsv(page);
  const lines = csv.trimEnd().split("\r\n");
  eq("表头是固定的十一列", lines[0].split(",").length, 11);
  ok("公式注入的前导 = 被单引号挡掉", lines.some((l) => l.includes("'=1+1")), lines.join(" | "));
  ok("含逗号与引号的备注整体加引号、引号翻倍", lines.some((l) => l.includes('"带""引号""、逗号，和')), "");
  eq("父级列取自上一层主题而不是自己", lines.find((l) => l.includes("登录联调"))?.split(",")[1], "开发");
  eq("日期按本地年月日", lines.find((l) => l.includes("报表导出"))?.split(",").slice(-3).join("|"), "done|2026-10-01|2026-10-03");
}

// ---------------------------------------------------------------- OPML
{
  const opml = toOpml(page);
  ok("声明了 OPML 2.0 与 UTF-8", opml.includes('<opml version="2.0">') && opml.startsWith("<?xml"), "");
  eq("标题是页名", opml.includes(`<head><title>${page.name}</title></head>`), true);
  eq("标签不进 OPML（它只带层级、备注和链接之外的结构）", opml.includes("紧急"), false);
  ok("备注写进 <note>", opml.includes("<note>接口要"), "");
  ok("& 在属性里被转义", opml.includes('text="散记&amp;备忘"'), "");
  eq("自闭合 + 开标签 = outline 总数", (opml.match(/<outline text="[^"]*"\/>/g) ?? []).length + (opml.match(/<outline text="[^"]*">/g) ?? []).length, total);
  eq("闭合标签数 = 非叶子且有备注的节点数", (opml.match(/<\/outline>/g) ?? []).length, opml.split("\n").filter((l) => l.includes("<outline") && !l.endsWith("/>")).length);
  const rootBlock = opml.split("\n").find((l) => l.includes('text="导出"')) ?? "";
  eq("中心主题的缩进是两层制表", rootBlock.indexOf("<outline"), 8);
}

// ---------------------------------------------------------------- 演示稿 Markdown
{
  const slides = toSlidesMarkdown(page);
  eq("封面 + 每个主分支一张", (slides.match(/^## /gm) ?? []).length, 4);
  eq("幻灯片之间用 --- 分隔", slides.split("\n\n---\n\n").length, 4);
  ok("要点带二级缩进", slides.includes("  - 用例清单"), "");
  ok("演示稿按整棵树出片，折叠不影响它", slides.includes("用例清单"), "");
}

// ---------------------------------------------------------------- HTML 单文件
{
  const html = toHtml(page, "导出样张");
  ok("是完整的单文件", html.startsWith("<!DOCTYPE html>") && html.includes("</html>"), "");
  ok("内嵌了 SVG", html.includes("<svg xmlns"), "");
  eq("大纲列表条数与大纲投影一致", (html.match(/<li>/g) ?? []).length, total);
  // 层级由 <ul> 的嵌套表达，不是内联 margin-left：那才是 HTML 的原生写法，
  // 也只有这样，HTML 导入（import 那边）才能不靠读样式表就把树带回来。
  ok("二级主题嵌在父主题的 <li> 里", html.includes("<li>开发<ul><li>登录联调"), "");
  ok("同级是兄弟，不再各写一个缩进值", html.includes("<li>登录联调</li><li>报表导出</li>"), "");
  eq("<ul> 的开合配平", (html.match(/<ul\b/g) ?? []).length, (html.match(/<\/ul>/g) ?? []).length);
  ok("标题转义", html.includes("<title>导出样张</title>"), "");
  ok("没有外链资源（双击就能看）", !/src="https?:|href="https?:/.test(html));
}

// ---------------------------------------------------------------- JSON 数据导出：整棵树，不是大纲
{
  const doc = JSON.parse(toTreeJson(page));
  eq("顶层是给程序认的标识与版本", [doc.kind, doc.version], ["z-mind.mindmap", 1]);
  eq("页名与版式码带上", [doc.name, doc.layout], ["导出", "balanced"]);
  const count = (ns: any[]): number => ns.reduce((n, x) => n + 1 + count(x.children ?? []), 0);
  const allTopics = Object.values(page.shapes).filter((s) => isTopic(s.type)).length;
  eq("折叠掉的子树也在 JSON 里（这是数据面，不是视图）", count(doc.roots), allTopics);
  ok("同一样张的大纲系少一枝，两条判据确实不同", [count(doc.roots), outlineRows(page).length], [10, 9]);
  eq("中心主题在第一根，浮动主题另起一根", doc.roots.length, 2);
  eq("浮动主题的根就是那个浮动主题", doc.roots[1].id, memo);
  // 这些变量名一律带 j 前缀：外层样张里 dev/login/report 是主题 id（字符串），
  // 同名一遮蔽，下面 toggleRelationship 拿到的就是 JSON 节点对象，关系线静默没加上。
  const jDev = doc.roots[0].children[0];
  eq("主分支顺序与 childIds 同序", jDev.children.map((x: any) => x.text), ["登录联调", "报表导出"]);
  const jLogin = jDev.children[0];
  eq("备注 / 标签 / 链接三类字段带着走", [jLogin.note, jLogin.labels, jLogin.link], [
    "接口要\n对齐两次",
    ["紧急", "安全"],
    "https://example.com/a?x=1&y=2",
  ]);
  const jReport = jDev.children[1];
  ok(
    "标签是空数组就不写 labels 键（有键没值，等于让读的人多分一支）",
    !("labels" in doc.roots[1].children[0]),
    JSON.stringify(doc.roots[1].children[0])
  );
  eq("任务字段用与 CSV 同一套写法（日期到日）", [jReport.task.assignees, jReport.task.progress, jReport.task.status, jReport.task.start], [
    ["张三"],
    100,
    "done",
    "2026-10-01",
  ]);
  ok(
    "没填的主题不写出空字段（note/labels/link/task 四键都是按需出现）",
    !["note", "labels", "link", "task"].some((k) => k in doc.roots[0]),
    Object.keys(doc.roots[0]).join(",")
  );
  eq("JSON 里的 id 就是形状 id（与样张同一个号）", [jLogin.id, jReport.id], [login, report]);
  const rel = toggleRelationship(page, login, report);
  eq("关系线是这份 JSON 里唯一不是树的部分，单独一段", JSON.parse(toTreeJson(rel)).relationships, [
    { from: login, to: report, text: "" },
  ]);
  const artifact = await exportArtifact(page, "json");
  eq("导出文件名跟着根主题", artifact.name, "导出.json");
  eq("MIME 是 JSON", artifact.mime, "application/json");
  eq("字节就是那份文本", new TextDecoder().decode(artifact.bytes), toTreeJson(page));
}

// ---------------------------------------------------------------- SVG：与画布同一套折行
{
  const svg = buildSvg(page, {});
  const paint = paintPage(page, {});
  // 标签条的小框也是 <rect>，它 fill="none"；这里只数主题自己的那个实心框（外加一张铺底，减掉）。
  eq("每个主题一个矩形", (svg.match(/<rect (?![^>]*fill="none")/g) ?? []).length - 1, paint.boxes.length);
  ok("根主题按第 0 档字号画", svg.includes('font-size="14"'), "");
  ok("线宽与圆角逐个盒子写", svg.includes('stroke-width="1"') && svg.includes("rx="), "");
  ok("& 被转义", svg.includes("&amp;"), "");
  eq("折行由布局一次算好，绘制不再折", paint.boxes.every((b) => b.lines.length > 0), true);
  const head = (svg.match(/viewBox="([^"]+)"/)![1] ?? "").split(" ");
  near("viewBox 的宽就是画布宽", Number(head[2]), paint.width);
  near("viewBox 的高就是画布高", Number(head[3]), paint.height);
  // PNG / 位图 PDF 是把这张 SVG 塞进 <img src="data:image/svg+xml,..."> 再光栅化的，
  // 那条路走的是严格的 XML 解析器：属性值里冒出一个裸双引号，字体名之后的整截断成第二个属性，
  // 图解码失败，用户拿到的是"SVG 光栅化失败"。node 这边没有 canvas，只能按良构性判。
  const ff = / font-family="([^"]*)"/.exec(svg)?.[1] ?? "";
  ok("font-family 是一整个属性值，中途没被裸引号截断", ff.includes("Microsoft") && ff.endsWith("sans-serif"), ff);
}

// ---------------------------------------------------------------- 浮动枝的孙主题：图形与文本同一批主题（P-1）
{
  let p = createPage("浮动枝");
  const put = (parentId: string, text: string): string => {
    const r = insertChild(p, parentId, text);
    p = r.page;
    return r.id;
  };
  const f = put(p.rootId, "散记");
  p = setFloating(p, f, 400, 240);
  const fk = put(f, "散记子");
  const gk = put(fk, "散记孙");
  const paint = paintPage(p, {});
  eq("浮动根、子、孙都有画布盒子", [f, fk, gk].map((id) => paint.boxes.some((b) => b.id === id)), [true, true, true]);
  eq("SVG 画出的主题数与大纲数出的一样", paint.boxes.length, outlineRows(p).length);
  ok("孙主题的文字真的进了 SVG", buildSvg(p, {}).includes("散记孙"), "");
  eq("显示层级裁的是浮动枝的层数，不是只裁主树", paintPage(p, { displayLevel: 1 }).boxes.length, 3);
  // 样张同一条判据：折叠、浮动、备注都算进来之后，两份投影仍要数出同一批主题。
  eq("样张：SVG 与大纲主题数一致", paintPage(page, {}).boxes.length, outlineRows(page).length);
}

// ---------------------------------------------------------------- PDF
{
  const pages = pdfPagesOf(page);
  eq("默认两页：图形 + 大纲", pages.length, 2);
  eq("关掉大纲页只剩一张图", pdfPagesOf(page, { withOutline: false }).length, 1);
  eq("横向 A4", [pages[0].width, pages[0].height], [842, 595]);
  const portrait = pdfPagesOf(page, { paper: A4_PORTRAIT });
  eq("换纸张就跟着换页宽", [portrait[0].width, portrait[0].height], [595, 842]);
  const textOps = pages[1].ops.filter((o) => o.k === "text");
  eq("大纲页每行一条文字", textOps.length - 1, total);
  eq("缩进随层级走", textOps[2].k === "text" ? (textOps[2] as { x: number }).x : -1, 40 + 14);
  const bytes = asText(buildPdf(pages, { title: "导出样张" }));
  ok("PDF 头是 1.4", bytes.startsWith("%PDF-1.4"), "");
  ok("结尾有 %%EOF", bytes.trimEnd().endsWith("%%EOF"), "");
  ok("中文走标准 CID 字体，不嵌字体文件", bytes.includes("/UniGB-UCS2-H") && !bytes.includes("/FontFile"), "");
  ok("大纲文字进了内容流", bytes.includes("Tj"), "");
  ok("图形页是矢量：连线走 path，不塞位图", pages[0].ops.some((o) => o.k === "path" && o.d.includes("C")), true);
  eq("图形页里没有 image 算子", pages[0].ops.some((o) => o.k === "image"), false);
}

// ---------------------------------------------------------------- 产物命名与字节
{
  const setText = (p: Page, s: string): Page => updateText(p, p.rootId, s);
  const svg = await exportArtifact(page, "svg");
  eq("文件名取根主题文字", svg.name, "导出.svg");
  eq("MIME 跟着格式表", svg.mime, "image/svg+xml");
  const csv = await exportArtifact(page, "csv");
  eq("CSV 带 BOM，Excel 打开中文才不会是乱码", [csv.bytes[0], csv.bytes[1], csv.bytes[2]], [0xef, 0xbb, 0xbf]);
  eq("CSV 内容是 UTF-8", asText(csv.bytes.slice(3)).startsWith("层级,父级,主题"), true);
  const md = await exportArtifact(page, "md");
  eq("Markdown 演示稿与大纲同扩展名", [md.name, (await exportArtifact(page, "slides-md")).name], ["导出.md", "导出.md"]);
  const pdf = await exportArtifact(page, "pdf-vector");
  eq("矢量 PDF 的 MIME", pdf.mime, "application/pdf");
  eq("矢量 PDF 的字节头", asText(pdf.bytes.slice(0, 8)), "%PDF-1.4");
  const renamed = await exportArtifact(setText(page, 'a/b\\c:d*e?f"g<h>i|'), "txt");
  eq("文件名里的非法字符换成下划线", renamed.name, "a_b_c_d_e_f_g_h_i_.txt");
  const blank = await exportArtifact(setText(page, ""), "txt");
  eq("空根主题退回页名", blank.name, "导出.txt");
  await rejects("PNG 在没有 canvas 的环境里明确报错而不是给一张空图", exportArtifact(page, "png"), "应用窗口");
  await rejects("位图 PDF 同一条路", exportArtifact(page, "pdf"), "应用窗口");
  await rejects("不支持的格式直接拒绝", exportArtifact(page, "docx" as never), "不支持的导出格式");
  ok("emmx 不在这里产出（它走 saveAs）", FORMATS.find((f) => f.id === "emmx")?.group, "文档");
}

// ---------------------------------------------------------------- path 映射
{
  const d = transformPath("M 10 20 C 30 40 50 60 70 80 H 90 V 100", (v) => v * 2, (v) => v * 2 + 1);
  eq("M/C 的数字成对映射，H 只动 x、V 只动 y", d, "M 20 41 C 60 81 100 121 140 161 H 180 V 201");
  eq("隐式命令沿用上一个（M 之后是 L）", transformPath("M 1 2 3 4", (v) => v, (v) => v), "M 1 2 L 3 4");
}

// ---------------------------------------------------------------- 任务表
{
  const t = toTaskTable(page);
  eq("只有填了任务字段的主题进表", t.rows.map((r) => r[0]), ["报表导出"]);
  eq("列头八项", t.columns.length, 8);
  eq("进度与状态取任务字段", t.rows[0].slice(3, 5), ["done", "100"]);
}

done();
