/**
 * 最小编辑的存盘无损验收（01 A-12 的点名器，顺带把 A-15 钉住）。
 *
 * 缺陷形状：旧写法是"签名一变就整颗 Shape 重建"，于是改一个字会顺手抹掉我们没建模的那几块 ——
 * 装机差分实测丢过 `<ToSuper>`、`<Geometries>` 路径缓存、第二条 `<Paragraph IX>`、
 * ShapeFormat@QuickMask、CX 上的 B/P 锚点，同时凭空发明出 LineCap/Rounding/LineStyle/Character@Style
 * 这些亿图根本没写的默认覆盖标记。反过来，模型里新长出来的主题因为不在 raw.order 里被整颗丢掉
 * （父亲的 SubLevel 还指向它：又丢数据又留悬空引用，那是 A-15）。
 *
 * 验收口径分两层：
 * - A 层（合成夹具）：把上面每一个码亲手种进一份亿图写法的 .emmx，走界面同一套 tree API 改一处，
 *   存盘后**按值**验它还在。键级差分看不见值级损失（TextFormatMask 从 0 被写成 10224 时计数不变），
 *   所以这一层钉的是值。
 * - B 层（真亿图文件）：改一处 → 存盘 → page.xml 的标签/属性差分只允许出现预期的那几条；
 *   再把没编辑过的那些 Shape 逐颗比字节 —— 没动的东西必须一字节都不差。
 *   缺 `_research/extract/fold/` 里的样张则 skip。
 *
 * 批 3I 起还钉一件事：界面点一次加粗（01 A-16），盘上的全部足迹必须只有一条 `Character@Style`。
 * 顺手钉住同一笔不许顺带发明 TaskInfo 的默认属性 —— 亿图/历史文件里根本没写它们的那些项。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { done, eq, ok, skip } from "./_harness.ts";
import { parseEmmx, writeEmmx } from "../src/engine/emmx/codec.ts";
import { decodeBytes, encodeText, readZip, writeZip } from "../src/engine/emmx/zip.ts";
import {
  getShape,
  insertChild,
  normalize,
  removeShape,
  setCollapsed,
  setTopicBold,
  updateExtras,
  updateStyle,
  updateText,
  updateTransform,
} from "../src/engine/tree.ts";
import { styleFor } from "../src/engine/style.ts";
import type { DocumentModel, Page, Shape } from "../src/types/model.ts";
import { plainText, usedCharIx } from "../src/types/model.ts";

const FOLD_DIR = join(process.cwd(), "_research", "extract", "fold");

// ================================================================ 公共小工具

const norm = (s: string): string => s.replace(/\\/g, "/");
/** 亿图和我们都写带缩进的 XML；比结构前把元素间的空白压掉（属性内部的空格留着）。 */
const compact = (xml: string): string => xml.replace(/>\s+</g, "><").trim();
const all = (hay: string, re: RegExp): string[] => hay.match(re) ?? [];

/**
 * 把 page.xml 切成一颗颗顶层 `<Shape>`。亿图的 Shape 是平铺兄弟（不嵌套），
 * 所以按 `<Shape` 前向断言切分就够了；`<ShapeFormat>`/`<Shapes>` 因为有词边界不会被误切。
 */
function shapeBlocks(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const chunk of compact(xml)
    .split(/(?=<Shape\b)/)
    .slice(1)) {
    const head = /^<Shape\b([^>]*)>/.exec(chunk);
    if (!head) continue;
    const attrs = head[1];
    const id = /\bID="([^"]+)"/.exec(attrs)?.[1] ?? "";
    const type = /\bType="([^"]+)"/.exec(attrs)?.[1] ?? "";
    if (attrs.trimEnd().endsWith("/")) {
      out.set(`${type}:${id}`, "");
      continue;
    }
    const end = chunk.indexOf("</Shape>");
    out.set(`${type}:${id}`, decoded(chunk.slice(head[0].length, end + "</Shape>".length)));
  }
  return out;
}
const blockOf = (blocks: Map<string, string>, id: string): string => {
  for (const [k, v] of blocks) if (k.endsWith(`:${id}`)) return v;
  return "";
};
/** 剥掉整棵正文子树：改标题时除它以外的一字节都不许变。 */
const withoutText = (block: string): string =>
  block.replace(/<Text>[\s\S]*<\/TextBlock><\/Text>/, "§");
/**
 * 比较用的规范化：亿图把 `>` 直接写在正文里（合法），我们的序列化器写 `&gt;` ——
 * 同一种内容的两种写法，不算差异。所以比的是解码之后的字节。
 */
const ENTITY: Record<string, string> = { gt: ">", lt: "<", quot: '"', apos: "'", amp: "&" };
const decoded = (block: string): string =>
  block.replace(/&(gt|lt|quot|apos|amp);/g, (_m, k) => ENTITY[k] ?? _m);
/** 属性顺序两边不一样（亿图写 `<CY B= P= V=`，我们写 `<CY V= P= B=`），所以按标签抓、再查属性。 */
const hasTag = (block: string, tag: string, attrs: Record<string, string>): boolean =>
  Object.entries(attrs).every(([k, v]) =>
    new RegExp(`<${tag}\\b[^>]*\\b${k}="${v}"[^>]*>`).test(block)
  );

const pageXmlOf = async (bytes: Uint8Array): Promise<string> => {
  const e = (await readZip(bytes)).find((x) => /page\/page\.xml$/i.test(norm(x.name)));
  if (!e) throw new Error("没有 page/page.xml");
  return decodeBytes(e.data);
};
const savedXml = async (doc: DocumentModel): Promise<string> => pageXmlOf(await writeEmmx(doc));

const withPage = (doc: DocumentModel, p: Page): DocumentModel => ({
  ...doc,
  pages: doc.pages.map((x) => (x.id === p.id ? p : x)),
});

/** 标签计数 + 属性键计数；对属性**值**不敏感，所以对重排不敏感 —— 这正是"有没有东西被写丢"的尺。 */
function census(xml: string): { tags: Map<string, number>; attrs: Map<string, number> } {
  const c = compact(xml);
  const tags = new Map<string, number>();
  for (const m of c.matchAll(/<([A-Za-z_][\w.:-]*)/g)) tags.set(m[1], (tags.get(m[1]) ?? 0) + 1);
  const attrs = new Map<string, number>();
  for (const m of c.matchAll(/<([A-Za-z_][\w.:-]*)\s([^>]*?)\/?>/g))
    for (const a of m[2].matchAll(/([\w.:-]+)\s*=\s*"/g)) {
      const k = `${m[1]}@${a[1]}`;
      attrs.set(k, (attrs.get(k) ?? 0) + 1);
    }
  return { tags, attrs };
}
interface Delta {
  key: string;
  before: number;
  after: number;
}
function diff(before: Map<string, number>, after: Map<string, number>): Delta[] {
  const out: Delta[] = [];
  for (const k of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const x = before.get(k) ?? 0;
    const y = after.get(k) ?? 0;
    if (x !== y) out.push({ key: k, before: x, after: y });
  }
  return out;
}
/** 两份 page.xml 的键级差分，收成一条可读串：A 层用它量"这一笔在盘上到底留了多少足迹"。 */
const keyDelta = (a: string, b: string): string => {
  const ca = census(a);
  const cb = census(b);
  return diff(ca.tags, cb.tags)
    .concat(diff(ca.attrs, cb.attrs))
    .map((x) => `${x.key}:${x.before}→${x.after}`)
    .sort()
    .join(" | ");
};

// ================================================================ A 层：合成夹具

const DOC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Document Version="12.0.0" DocVersion="12.0" DocGuid="{11111111-2222-3333-4444-555555555555}">
    <Properties>
        <AutoLayout V="1"/>
        <ScreenWidth V="1920"/>
        <ScreenHeight V="1080"/>
        <Platform V="win"/>
        <Creator V="夹具"/>
        <Pages V="page"/>
    </Properties>
    <MarkSheet/>
</Document>`;

/**
 * 亿图正文盒的写法。mask/bk/space 这几处是我们的模型完全没建模的键，
 * 专门种下来看它们活不活得过存盘；extra 那条是"样式记录比正文段落多"的第二条 Paragraph。
 * style 反过来：Character@Style 是模型**管着**的键（加粗），亿图写了、模型取消后就不许被带回来。
 */
function textBox(
  label: string,
  opts: { mask?: string; bk?: string; style?: string; extra?: string } = {}
): string {
  return (
    `<Text><Transform><Width V="88"/><Height V="18"/><CX V="0" B="1" P="0"/><CY V="0" B="2" P="0"/></Transform>` +
    `<TextBlock TextFormatMask="${opts.mask ?? "10224"}"><Color V="#ff282828"/>` +
    `<Character IX="0" Family="微软雅黑" Size="12" Color="#282828"${opts.bk ? ` BkColor="${opts.bk}"` : ""}${
      opts.style ? ` Style="${opts.style}"` : ""
    }/>` +
    `<Paragraph IX="0" Align="1" SpLine="100"/>` +
    (opts.extra ?? "") +
    `<Text><pp PX="1" CX="0"><tp CX="0">${label}</tp></pp></Text></TextBlock></Text>`
  );
}

/** 亿图给每颗主题带的<Geometries> 路径缓存：里面全是我们的模型没建模的点。 */
const GEO_CACHE =
  `<Geometries><Geometry Closed="1" NoLine="1" NoFill="0">` +
  `<MoveTo><X B="1" P="0" V="0"/><Y B="2" P="0" V="0"/></MoveTo>` +
  `<LineTo><X B="1" P="1" V="68"/><Y B="2" P="0" V="0"/></LineTo>` +
  `<LineTo><X B="1" P="1" V="68"/><Y B="2" P="1" V="23.5"/></LineTo></Geometry></Geometries>`;

/** `<Layout>` 是部分建模的：Toggler 归我们管，ImagePos/FlexoStyle/Layout/Margins 这几个邻居必须原样留着。 */
const LAYOUT_MATES =
  `<ImagePos V="1"/><FlexoStyle V="5"/><Layout V="8"/>` +
  `<Margins LeftMargin="18" TopMargin="14" RightMargin="18" BottomMargin="14"/>`;

const SHAPE_101 =
  `<Shape ID="101" Type="MainIdea">` +
  `<Transform><Width V="140"/><Height V="32"/><CX V="500" B="1" P="0"/><CY V="300" B="2" P="0"/></Transform>` +
  `<ShapeFormat QuickMask="0"><FillFormat/><LineFormat><LineWeight V="1"/></LineFormat></ShapeFormat>` +
  textBox("中心") +
  `<LevelData><SubLevel V="102;103"/></LevelData><Geometries/><ShapeStyle V="1"/></Shape>`;

// 102 是"浑身种满没建模的码"的那一颗：ToSuper、QuickMask=4095、第二条 Paragraph、路径缓存、
// ShapeStyle V="5"、文字背景色、掩码 0（我们自己的常数是 10224）、CX/CY 的 B/P 锚点、707.621 的精度位。
const SHAPE_102 =
  `<Shape ID="102" Type="MainTopic">` +
  `<Transform><Width V="120"/><Height V="28"/><CX V="707.621" B="1" P="0"/><CY V="233.417" B="2" P="0"/></Transform>` +
  `<ShapeFormat QuickMask="4095"><FillFormat Type="Solid"><Color V="#ff2196f3"/></FillFormat>` +
  `<LineFormat><LineWeight V="1.5"/><Rounding V="2"/><LineCap V="Round"/></LineFormat></ShapeFormat>` +
  textBox("分支甲", {
    mask: "0",
    bk: "#ffff00",
    extra: `<Paragraph IX="1" IndFirst="0" SpaceBefore="12"/>`,
  }) +
  `<LevelData><Super V="101"/><ToSuper V="103"/><SubLevel V="104"/></LevelData>` +
  GEO_CACHE +
  `<ShapeStyle V="5"/><StyleMask V="2"/><Layout>${LAYOUT_MATES}</Layout></Shape>`;

// 103 故意只带 LineWeight：动它的填充时若凭空长出 Rounding/LineCap/LineStyle，就是我们在发明默认值。
const SHAPE_103 =
  `<Shape ID="103" Type="MainTopic">` +
  `<Transform><Width V="120"/><Height V="28"/><CX V="300" B="1" P="0"/><CY V="400" B="2" P="0"/></Transform>` +
  `<ShapeFormat QuickMask="4095"><FillFormat Type="Solid"><Color V="#ff4caf50"/></FillFormat>` +
  `<LineFormat><LineWeight V="1"/></LineFormat></ShapeFormat>` +
  textBox("分支乙") +
  `<LevelData><Super V="101"/><SubLevel V="105"/></LevelData><Geometries/><ShapeStyle V="5"/>` +
  `<Layout><LayoutDirection V="1"/>${LAYOUT_MATES}</Layout></Shape>`;

// 叶子的两种特殊写法：style 那颗是"亿图写了加粗"，task 那颗是"属性只写了一半的自造节点"。
const leaf = (
  id: string,
  superId: string,
  label: string,
  opts: { style?: string; task?: string } = {}
): string =>
  `<Shape ID="${id}" Type="SubTopic">` +
  `<Transform><Width V="100"/><Height V="24"/><CX V="${Number(id) * 3}" B="1" P="0"/><CY V="${Number(id) * 7}" B="2" P="0"/></Transform>` +
  `<ShapeFormat QuickMask="4095"><FillFormat/><LineFormat><LineWeight V="1"/></LineFormat></ShapeFormat>` +
  textBox(label, { style: opts.style }) +
  `<LevelData><Super V="${superId}"/></LevelData><Geometries/><ShapeStyle V="1"/>${
    opts.task ?? ""
  }</Shape>`;

// 连接线在 .emmx 里也是 Shape，占同一套号段：900 被它占了，新主题就不许发到 900。
const CONNECTOR_900 =
  `<Shape ID="900" Type="MMConnector">` +
  `<MMConnector BeginID="102" EndID="103" Thickness="2"/>` +
  `<Geometries><Geometry Closed="0"><MoveTo><X B="1" P="0" V="0"/></MoveTo></Geometry></Geometries>` +
  `</Shape>`;

const PAGE_XML =
  `<?xml version="1.0"?><Page ID="100" Type="Page" Name="无损夹具" Zoom="1" QuickMask="0">` +
  `<PageProps><Width V="3072"/><Height V="2160"/><CX V="1536" B="1" P="0"/><CY V="1080" B="2" P="0"/>` +
  `<ScrollX V="0.5"/><ScrollY V="0.5"/></PageProps>` +
  `<Layout><HSpacing V="30"/><VSpacing V="30"/><Layout V="8"/><SectorAlign V="1"/></Layout>` +
  `<FillFormat/><PrintSetup FittoSheet="1" HSheet="1" VSheet="1" Background="1" Width="210" Height="297" Unit="mm"/>` +
  `<Theme ID="40" Rainbow="0" Effect="0" Name="Edraw"><ThemeColor V="3"/><ThemeEffect V="40"/>` +
  `<ThemeText V="40"/><ThemeShape V="40"/></Theme>` +
  SHAPE_101 +
  SHAPE_102 +
  SHAPE_103 +
  leaf("104", "102", "甲的叶子", { task: `<TaskInfo Progress="50"/>` }) +
  leaf("105", "103", "乙的叶子", { style: "1" }) +
  CONNECTOR_900 +
  `</Page>`;

const ORIG = shapeBlocks(PAGE_XML);

{
  const bytes = await writeZip([
    { name: "document.xml", data: encodeText(DOC_XML) },
    { name: "page/page.xml", data: encodeText(PAGE_XML) },
    { name: "rels/page_rels.xml", data: encodeText(`<Relationships/>`) },
  ]);
  const parsed = await parseEmmx(bytes);
  eq("夹具解析无告警", parsed.warnings.join(" | "), "");
  const base = parsed.doc.pages[0];
  eq("夹具主题数", Object.keys(base.shapes).length, 5);
  eq("102 挂着父", getShape(base, "102")?.parentId, "101");
  ok("连接线不进模型：它只占号段", getShape(base, "900") === undefined);

  // -------------------------------------------------- 改标题：除正文外一字节都不许动
  const renamed = shapeBlocks(
    await savedXml(withPage(parsed.doc, updateText(base, "102", "改名了")))
  );
  const r102 = blockOf(renamed, "102");
  ok("正文真的改了", /<tp CX="0">改名了<\/tp>/.test(r102));
  eq("改标题不许动正文以外任何一颗子节点", withoutText(r102), withoutText(blockOf(ORIG, "102")));
  ok("ToSuper 还在", /<ToSuper V="103"\/>/.test(r102));
  ok("QuickMask 还是 4095", /<ShapeFormat QuickMask="4095">/.test(r102));
  ok(
    "路径缓存一个点都没少",
    /<Geometry Closed="1" NoLine="1" NoFill="0">/.test(r102) && all(r102, /<LineTo>/g).length === 2
  );
  ok("第二条 Paragraph 还在", /<Paragraph IX="1" IndFirst="0" SpaceBefore="12"\/>/.test(r102));
  ok("文字背景色带回来了（值级：census 看不见这一条）", /BkColor="#ffff00"/.test(r102));
  ok("掩码跟着原文件写 0，没被常数洗成 10224", /<TextBlock TextFormatMask="0">/.test(r102));
  ok("ShapeStyle 还是亿图写的 5", /<ShapeStyle V="5"\/>/.test(r102));
  ok("CX 的精度位与 B/P 锚点原样", /<CX V="707.621" B="1" P="0"\/>/.test(r102));
  ok("不许发明 Character@Style", !/Character[^>]*\bStyle=/.test(r102));
  ok("不许发明 LineFormat@LineStyle", !/<LineFormat[^>]*LineStyle=/.test(r102));
  for (const id of ["101", "103", "104", "105", "900"]) {
    eq(`改标题不许连累 ${id}`, blockOf(renamed, id), blockOf(ORIG, id));
  }

  // -------------------------------------------------- 折叠：只加 Toggler，邻居一个不少
  const folded = shapeBlocks(await savedXml(withPage(parsed.doc, setCollapsed(base, "102", true))));
  const f102 = blockOf(folded, "102");
  ok("折叠写上了 Toggler", /<Toggler V="1"\/>/.test(f102));
  for (const mate of ["ImagePos", "FlexoStyle", 'Layout V="8"', "Margins"]) {
    ok(`折叠不许洗掉 <Layout> 的邻居 ${mate}`, f102.includes(mate));
  }
  ok("折叠后 ToSuper 还在", /<ToSuper V="103"\/>/.test(f102));
  ok("折叠后路径缓存还在", /<Geometry Closed="1"/.test(f102));
  eq("折叠只动 102 这一颗", blockOf(folded, "103"), blockOf(ORIG, "103"));

  // -------------------------------------------------- 改填充：ShapeFormat 整颗重建，掩码与线得跟着走
  const styled = shapeBlocks(
    await savedXml(
      withPage(
        parsed.doc,
        updateStyle(base, "102", { fill: { type: "Solid", color: { v: "#ffff0000" } } })
      )
    )
  );
  const s102 = blockOf(styled, "102");
  ok("新填充写上了", /<FillFormat Type="Solid"><Color V="#ffff0000"\/><\/FillFormat>/.test(s102));
  ok("QuickMask 跟着回来", /<ShapeFormat QuickMask="4095">/.test(s102));
  ok(
    "线宽/圆角/端点按原样重写",
    /<LineWeight V="1.5"\/><Rounding V="2"\/><LineCap V="Round"\/>/.test(s102)
  );
  ok("StyleMask 还在", /<StyleMask V="2"\/>/.test(s102));
  ok("ShapeStyle 还是 5", /<ShapeStyle V="5"\/>/.test(s102));
  ok("改色不牵连正文树", /BkColor="#ffff00"/.test(s102));
  ok("改色后 ToSuper 还在", /<ToSuper V="103"\/>/.test(s102));
  ok(
    "改色后 <Geometries> 这颗必须还在（缓存允许失效，不允许整颗没）",
    /<Geometries(\/|>)/.test(s102)
  );

  // -------------------------------------------------- 只改色时不许发明默认值
  const styled103 = shapeBlocks(
    await savedXml(
      withPage(
        parsed.doc,
        updateStyle(base, "103", { fill: { type: "Solid", color: { v: "#ff00ff00" } } })
      )
    )
  );
  const s103 = blockOf(styled103, "103");
  ok("103 的新填充写上了", /<Color V="#ff00ff00"\/>/.test(s103));
  ok("103 的 LineWeight 跟着走", /<LineWeight V="1"\/>/.test(s103));
  ok("原文件没写 Rounding，我们也不写", !/<Rounding\b/.test(s103));
  ok("原文件没写 LineCap，我们也不写", !/<LineCap\b/.test(s103));
  ok("原文件没写 LineStyle，我们也不写", !/<LineFormat[^>]*LineStyle=/.test(s103));

  // -------------------------------------------------- 拖动：位置变了，锚点与树都得在
  const moved = shapeBlocks(
    await savedXml(withPage(parsed.doc, updateTransform(base, "102", { y: 400 })))
  );
  const m102 = blockOf(moved, "102");
  ok("新位置写上了", hasTag(m102, "CY", { V: "400", B: "2", P: "0" }), m102.slice(0, 200));
  ok("拖动后 CX 的锚点还在", hasTag(m102, "CX", { B: "1", P: "0" }));
  ok("拖动后 ToSuper 还在", /<ToSuper V="103"\/>/.test(m102));
  ok("拖动后第二条 Paragraph 还在", /<Paragraph IX="1"/.test(m102));

  // -------------------------------------------------- 新增主题：这颗必须真的落到盘上（A-15）
  const inserted = insertChild(base, "102", "新加的枝");
  const grown = normalize(inserted.page);
  const newId = inserted.id;
  ok("新主题的号躲开了连接线占的 900", Number(newId) > 900, newId);
  const grew = shapeBlocks(await savedXml(withPage(parsed.doc, grown)));
  const nShape = blockOf(grew, newId);
  ok("新增的主题真的写进盘上了", nShape.length > 0, `盘上找不到 ${newId}`);
  ok("新主题带着自己的父指针", /<Super V="102"\/>/.test(nShape));
  const subOf102 = /<SubLevel V="([^"]*)"\/>/.exec(blockOf(grew, "102"))?.[1] ?? "";
  ok(`父亲的 SubLevel 真的收了这一号（${subOf102}）`, subOf102.split(";").includes(newId));
  ok("新增不许连累 102 的 ToSuper", /<ToSuper V="103"\/>/.test(blockOf(grew, "102")));
  const ids = [...grew.keys()].map((k) => k.split(":")[1]);
  eq("盘上没有重号的 Shape", new Set(ids).size, ids.length);
  ok("连接线 900 一个字节没变", blockOf(grew, "900") === blockOf(ORIG, "900"));
  const back = (await parseEmmx(await writeEmmx(withPage(parsed.doc, grown)))).doc.pages[0];
  eq("重开后新主题的父还是 102", getShape(back, newId)?.parentId, "102");
  eq(
    "重开后新主题的标题",
    getShape(back, newId) ? plainText(getShape(back, newId)!.text) : "",
    "新加的枝"
  );
  eq("重开后主题总数", Object.keys(back.shapes).length, 6);

  // -------------------------------------------------- 改任务状态：原节点属性不全，带回旧的会把这一笔吞掉
  const task104 = getShape(base, "104")?.extras.task;
  ok(
    "亿图没写的概念：夹具只写了 Progress，读侧要把默认补齐",
    task104?.progress === 50 && task104.status === "todo"
  );
  const taskPage = withPage(
    parsed.doc,
    updateExtras(base, "104", { task: { ...task104!, status: "done" as const } })
  );
  const tasked = shapeBlocks(await savedXml(taskPage));
  const info104 = /<TaskInfo\b[^>]*>/.exec(blockOf(tasked, "104"))?.[0] ?? "";
  ok(
    "状态改完必须真的落盘（原节点没有 Status，不许把它当超集带回）",
    /Status="done"/.test(info104),
    info104
  );
  ok("进度跟着原文件的值走，没被洗成 0", /Progress="50"/.test(info104), info104);
  ok("原文件没写 Priority，这一笔也没碰它 ⇒ 不许发明默认值", !/Priority=/.test(info104), info104);
  eq("改任务不许连累 102", blockOf(tasked, "102"), blockOf(ORIG, "102"));
  const taskBack = (await parseEmmx(await writeEmmx(taskPage))).doc.pages[0];
  eq("重开后任务状态", taskBack.shapes["104"]?.extras.task?.status, "done");
  eq("重开后任务进度", taskBack.shapes["104"]?.extras.task?.progress, 50);
  eq(
    "盘上没有的 Priority 读回还是那个默认",
    taskBack.shapes["104"]?.extras.task?.priority,
    "medium"
  );
  // 把优先级改成非默认值：这一笔必须落盘，不能因为"原节点没写过"而被当成超集带回。
  const hiXml = await savedXml(
    withPage(
      parsed.doc,
      updateExtras(base, "104", { task: { ...task104!, priority: "high" as const } })
    )
  );
  const hiInfo = /<TaskInfo\b[^>]*>/.exec(blockOf(shapeBlocks(hiXml), "104"))?.[0] ?? "";
  ok("用户真改了 Priority ⇒ 必须落盘", /Priority="high"/.test(hiInfo), hiInfo);
  ok("没碰的 Status 仍不落盘", !/Status=/.test(hiInfo), hiInfo);

  // -------------------------------------------------- 取消加粗：模型管着的键不许从原文件复活
  const s105 = getShape(base, "105")!;
  eq("加粗从 Character@Style 读进模型", s105.text.characters[0]?.bold, true);
  const unbolded = shapeBlocks(
    await savedXml(
      withPage(parsed.doc, {
        ...base,
        shapes: {
          ...base.shapes,
          "105": {
            ...s105,
            text: {
              ...s105.text,
              characters: s105.text.characters.map((c) => ({ ...c, bold: false })),
            },
          },
        },
      })
    )
  );
  const u105 = blockOf(unbolded, "105");
  ok(
    "取消加粗后盘上不许留 Style（亿图写了 Style=1，带回就等于把用户刚取消的东西复活）",
    !/Character[^>]*\bStyle=/.test(u105),
    u105
  );
  ok(
    "取消加粗只动 Style，Family/Size 还在",
    /Family="微软雅黑"/.test(u105) && /Size="12"/.test(u105)
  );
  ok("取消加粗不牵连 <ShapeFormat> 的掩码", /<ShapeFormat QuickMask="4095">/.test(u105));
  eq("取消加粗不许连累 102", blockOf(unbolded, "102"), blockOf(ORIG, "102"));

  // -------------------------------------------------- 界面点加粗的那一下：全盘足迹只许 Character@Style（01 A-16）
  {
    // 基线取"同一套写手、这一次什么都没改"的输出，而不是夹具原文 ——
    // 比的是"这一笔改了什么"，两边的字节口径必须一致（夹具的 Width/Height 是手写的实测值）。
    const STYLE = /Character[^>]*\bStyle=/;
    const STYLE_ALL = new RegExp(STYLE.source, "g");
    const bare = await savedXml(parsed.doc);
    const bareBlocks = shapeBlocks(bare);
    // 亿图只在 105 上写过 Style="1"；中心主题和一级分支明明是粗的，盘上却一个字节都没有 ——
    // 那个粗是层级推出来的，不是文件里的信息，所以它不许有盘上落点。
    eq("写手的基线输出：全盘只有 105 那一条原生加粗", all(bare, STYLE_ALL).length, 1);
    for (const id of ["101", "102", "103", "104"])
      ok(`推导出的粗不落盘：${id} 没有 Style`, !STYLE.test(blockOf(bareBlocks, id)));

    const boldPage = setTopicBold(base, "104", true);
    const boldXml = await savedXml(withPage(parsed.doc, boldPage));
    const boldBlocks = shapeBlocks(boldXml);
    eq(
      "点一次加粗，盘上只多一个 Character@Style，其余键计数一个不动",
      keyDelta(bare, boldXml),
      "Character@Style:1→2"
    );
    const b104 = blockOf(boldBlocks, "104");
    ok("加粗写在这颗的 Character 上", /<Character[^>]*Style="1"/.test(b104), b104);
    ok('不许发明亿图不写的 Style="0"', !/Style="0"/.test(boldXml));
    eq("加粗不许连累正文以外的子节点", withoutText(b104), withoutText(blockOf(ORIG, "104")));
    for (const id of ["101", "102", "103", "105", "900"])
      eq(`加粗只动 104，不许连累 ${id}`, blockOf(boldBlocks, id), blockOf(ORIG, id));

    const again = (await parseEmmx(await writeEmmx(withPage(parsed.doc, boldPage)))).doc.pages[0];
    eq(
      "重开还是粗：characters[0] 从 Style 读回 true",
      again.shapes["104"]?.text.characters[0]?.bold,
      true
    );
    ok("重开后界面算出来也是粗", styleFor(again, again.shapes["104"]).font.bold === true);
    const off = setTopicBold(again, "104", false);
    const offXml = await savedXml(withPage(parsed.doc, off));
    ok(
      '取消加粗后这颗的 Style 整条消失（不是写 Style="0"）',
      !STYLE.test(blockOf(shapeBlocks(offXml), "104"))
    );
    eq("取消加粗的足迹回到零：与没编辑过的输出同键数", keyDelta(bare, offXml), "");

    // 亿图原生的那颗加粗（105）由界面点灭：同一个 op、同一个键。
    const kill105 = setTopicBold(base, "105", false);
    const killXml = await savedXml(withPage(parsed.doc, kill105));
    ok("亿图写过的 105 点灭后 Style 消失", !STYLE.test(blockOf(shapeBlocks(killXml), "105")));
    eq("点灭 105 后全盘一条 Style 都不剩", all(killXml, STYLE_ALL).length, 0);

    // 钉住已知遗留（03 §1.3-24）：层级默认就粗的那些主题，"取消加粗"在本次会话里生效，
    // 但亿图没有"显式不加粗"的写法，所以这一笔不落盘 —— 重开又按层级变回粗。
    const veto = setTopicBold(base, "101", false);
    ok(
      "会话内否决生效：中心主题算出来不粗",
      styleFor(veto, veto.shapes["101"]).font.bold === false
    );
    const vetoXml = await savedXml(withPage(parsed.doc, veto));
    eq("这一笔没有盘上落点（不凭空发明记号）", all(vetoXml, STYLE_ALL).length, 1);
    const reVeto = (await parseEmmx(await writeEmmx(withPage(parsed.doc, veto)))).doc.pages[0];
    ok(
      "重开后按层级仍是粗的（已知遗留，改这条要先确证 TextFormatMask）",
      styleFor(reVeto, reVeto.shapes["101"]).font.bold === true
    );
  }

  // -------------------------------------------------- 删叶子：那颗没了，指向它的地方也不许留
  const pruned = shapeBlocks(await savedXml(withPage(parsed.doc, removeShape(base, "104"))));
  eq("删掉的叶子不再回写", blockOf(pruned, "104"), "");
  ok("父亲的 SubLevel 不再指向它", !/V="104"/.test(blockOf(pruned, "102")));
  ok("全盘没有悬空的 Super", ![...pruned.values()].some((b) => /<Super V="104"\/>/.test(b)));
  // 父亲的 <LevelData> 本来就该跟着变（那一号要从 SubLevel 里划掉），所以比的时候把它也剥掉。
  eq(
    "删除不许连累 102 的正文树与路径缓存",
    withoutText(blockOf(pruned, "102")).replace(/<LevelData>[\s\S]*?<\/LevelData>/, "§"),
    withoutText(blockOf(ORIG, "102")).replace(/<LevelData>[\s\S]*?<\/LevelData>/, "§")
  );
  ok("父亲的 ToSuper 得跟着重建活下来", /<ToSuper V="103"\/>/.test(blockOf(pruned, "102")));
}

// ================================================================ B 层：真亿图文件

/** 被编辑那颗的 <Geometries> 路径缓存必须失效 —— 这是允许的减项，其余一律算写丢。 */
const GEOM_KEYS = new Set([
  "Geometry",
  "Geometry@Closed",
  "Geometry@NoFill",
  "Geometry@NoLine",
  "MoveTo",
  "LineTo",
  "X",
  "X@B",
  "X@P",
  "X@V",
  "Y",
  "Y@B",
  "Y@P",
  "Y@V",
]);
/** 改填充时真正的那一处变化：多一个 Color 节点、FillFormat 从没有 Type 变成有 Type。 */
const FILL_KEYS = new Set([...GEOM_KEYS, "Color", "Color@V", "FillFormat@Type"]);
const TOGGLER_KEYS = new Set(["Toggler", "Toggler@V"]);
/** 新增一颗主题的全部足迹 —— 只许是这颗自己的，别的一律不许动。 */
const NEW_KEYS = new Set([
  "CX",
  "CX@B",
  "CX@P",
  "CX@V",
  "CY",
  "CY@B",
  "CY@P",
  "CY@V",
  "Character",
  "Character@Color",
  "Character@Family",
  "Character@IX",
  "Character@Size",
  "Color",
  "Color@V",
  "Geometries",
  "Height",
  "Height@V",
  "LevelData",
  "Paragraph",
  "Paragraph@Align",
  "Paragraph@IX",
  "Paragraph@SpLine",
  "Shape",
  "Shape@ID",
  "Shape@Type",
  "ShapeFormat",
  "ShapeStyle",
  "ShapeStyle@V",
  "Super",
  "Super@V",
  "Text",
  "TextBlock",
  "TextBlock@TextFormatMask",
  "Transform",
  "Width",
  "Width@V",
  "pp",
  "pp@CX",
  "pp@PX",
  "tp",
  "tp@CX",
]);
/** 删掉一颗叶子时它会带走的东西（含它自己那份 <Note>、<Layout> 邻居、路径缓存）。 */
const DELETE_KEYS = new Set([
  ...NEW_KEYS,
  ...GEOM_KEYS,
  "FillFormat",
  "FillFormat@Type",
  "FlexoStyle",
  "FlexoStyle@V",
  "ImagePos",
  "ImagePos@V",
  "Layout",
  "Layout@V",
  "LineFill",
  "LineFill@Type",
  "LineFormat",
  "LineWeight",
  "LineWeight@V",
  "Margins",
  "Margins@BottomMargin",
  "Margins@LeftMargin",
  "Margins@RightMargin",
  "Margins@TopMargin",
  "Note",
  "Note@Height",
  "Note@ICX",
  "Note@ICY",
  "Note@Lock",
  "Note@Width",
  "Note@X",
  "Note@Y",
  "Paragraph@IndFirst",
  "Paragraph@SpaceAfter",
  "Paragraph@SpaceBefore",
  "ShapeFormat@QuickMask",
  "StyleMask",
  "StyleMask@V",
  "SubLevel",
  "SubLevel@V",
  "ToSuper",
  "ToSuper@V",
  "TogglerID",
  "TogglerID@V",
  "Character@Style",
]);

interface Scenario {
  label: string;
  allow: Set<string>;
  apply: (doc: DocumentModel, target?: Shape) => DocumentModel;
  /** 差分里必须出现的键（方向性证明）；缺一条就是"该改的没改"。 */
  expect?: (d: Delta[]) => void;
  /** 这一条的前提：挑不到这样的主题就整条 skip，而不是让测试替样张的内容背书。 */
  find?: (doc: DocumentModel) => Shape | undefined;
}

const someTopic = (p: Page, pick: (s: Shape) => boolean): Shape =>
  Object.values(p.shapes).find((s) => /Topic$/.test(s.type) && s.id !== p.rootId && pick(s))!;
/** 同上但允许中心主题：亿图原生写下的那几条加粗就在中心主题上（系统测试实测 8 颗根）。 */
const anyTopic = (p: Page, pick: (s: Shape) => boolean): Shape | undefined =>
  Object.values(p.shapes).find((s) => (s.type === "MainIdea" || /Topic$/.test(s.type)) && pick(s));

const SCENARIOS: Scenario[] = [
  {
    label: "改一个主题的标题",
    allow: new Set<string>(),
    apply: (doc) => {
      const p = doc.pages[0];
      return withPage(doc, updateText(p, someTopic(p, () => true).id, "差分点名器改名"));
    },
  },
  {
    label: "折一支",
    allow: TOGGLER_KEYS,
    apply: (doc) => {
      const p = doc.pages[0];
      const s = someTopic(p, (x) => x.childIds.length > 0 && !x.extras.collapsed);
      return withPage(doc, setCollapsed(p, s.id, true));
    },
    expect: (d) =>
      ok(
        "折一支要真的落笔",
        d.some((x) => x.key === "Toggler" && x.after > x.before)
      ),
  },
  {
    label: "展开全部",
    allow: TOGGLER_KEYS,
    apply: (doc) => {
      let p = doc.pages[0];
      for (const s of Object.values(p.shapes))
        if (s.extras.collapsed) p = setCollapsed(p, s.id, false);
      return withPage(doc, p);
    },
  },
  {
    label: "改一个主题的填充色",
    allow: FILL_KEYS,
    apply: (doc) => {
      const p = doc.pages[0];
      const s = someTopic(p, () => true);
      return withPage(
        doc,
        updateStyle(p, s.id, {
          fill: { type: "Solid", color: { v: "#ff000000" } },
          mask: ((s.style.mask ?? 0) | 1) as number,
        })
      );
    },
  },
  {
    label: "拖动一个主题",
    allow: GEOM_KEYS,
    apply: (doc) => {
      const p = doc.pages[0];
      const s = someTopic(p, () => true);
      return withPage(doc, updateTransform(p, s.id, { y: s.transform.y + 77 }));
    },
  },
  {
    label: "新增一个子主题",
    allow: NEW_KEYS,
    apply: (doc) => {
      const p = doc.pages[0];
      return withPage(doc, normalize(insertChild(p, p.rootId, "差分点名器新增").page));
    },
    expect: (d) => {
      const shape = d.find((x) => x.key === "Shape");
      ok(
        "新增的主题数 +1",
        shape !== undefined && shape.after - shape.before === 1,
        JSON.stringify(shape)
      );
      ok(
        "新增不许让任何码变少",
        d.every((x) => x.after > x.before),
        JSON.stringify(d.filter((x) => x.after < x.before))
      );
    },
  },
  {
    label: "删掉一个叶子主题",
    allow: DELETE_KEYS,
    apply: (doc) => {
      const p = doc.pages[0];
      return withPage(doc, removeShape(p, someTopic(p, (s) => s.childIds.length === 0).id));
    },
    expect: (d) => {
      const shape = d.find((x) => x.key === "Shape");
      ok(
        "删掉的主题数 -1",
        shape !== undefined && shape.after - shape.before === -1,
        JSON.stringify(shape)
      );
      ok(
        "删除不许让任何码变多",
        d.every((x) => x.after < x.before),
        JSON.stringify(d.filter((x) => x.after > x.before))
      );
    },
  },
  {
    // 01 A-16 的真文件验收：界面点一次加粗，全盘只许多一条 Character@Style。
    // 挑"正文只引用一条文字样式、且那条当前不粗"的主题 —— 这样 +1 是唯一可能的结果。
    // 不限定样式条目总数：真文件里确有写了却没被引用的条目（系统测试实测 8 颗根的粗条目就没被引用），
    // 它们原样跟着走，不参与这一笔。
    label: "点一次加粗",
    allow: new Set(["Character@Style"]),
    find: (doc) => {
      const p = doc.pages[0];
      return anyTopic(p, (x) => {
        const u = usedCharIx(x.text);
        return u.length === 1 && x.text.characters[u[0]]?.bold !== true;
      });
    },
    apply: (doc, s) => withPage(doc, setTopicBold(doc.pages[0], s!.id, true)),
    expect: (d) =>
      ok(
        "加粗要真的落笔成 Character@Style",
        d.some((x) => x.key === "Character@Style" && x.after > x.before),
        JSON.stringify(d)
      ),
  },
  {
    // 反过来：亿图原生带 Style="1" 的那些主题，点灭之后只能少、不能改成 Style="0"。
    // 不锁定"少几条"：同一颗上可能有多条被引用的样式，全按亿图的写法抹掉就是减。
    label: "点灭亿图原生的加粗",
    allow: new Set(["Character@Style"]),
    find: (doc) => {
      const p = doc.pages[0];
      return anyTopic(p, (x) =>
        usedCharIx(x.text).some((ix) => x.text.characters[ix]?.bold === true)
      );
    },
    apply: (doc, s) => withPage(doc, setTopicBold(doc.pages[0], s!.id, false)),
    expect: (d) =>
      ok(
        '点灭要真的把 Style 抹掉，而不是写成 Style="0"',
        d.some((x) => x.key === "Character@Style" && x.after < x.before),
        JSON.stringify(d)
      ),
  },
];

const REAL_FILES = [
  "系统测试_backup_0823d.emmx",
  "软件质量_backup_242322.emmx",
  "测试基础_backup_222219.emmx",
];

for (const f of REAL_FILES) {
  const path = join(FOLD_DIR, f);
  if (!existsSync(path)) {
    skip(`${f}`, "真亿图样张不在仓库里（_research/extract/fold/）");
    continue;
  }
  const bytes = new Uint8Array(readFileSync(path));
  const srcXml = await pageXmlOf(bytes);
  const before = census(srcXml);
  const original = (await parseEmmx(bytes)).doc;
  const editedId = someTopic(original.pages[0], () => true).id;

  // 值级那一刀：只改一个字，除被改的那颗以外，每一颗 Shape 必须一字节都不差。
  const blocksBefore = shapeBlocks(srcXml);
  const blocksAfter = shapeBlocks(
    await savedXml(withPage(original, updateText(original.pages[0], editedId, "差分点名器改名")))
  );
  eq(
    `${f}｜改一个字不许打乱 Shape 的排列`,
    [...blocksAfter.keys()].join(","),
    [...blocksBefore.keys()].join(",")
  );
  const offenders: string[] = [];
  for (const [k, v] of blocksBefore) {
    if (k.endsWith(`:${editedId}`)) continue;
    if (blocksAfter.get(k) !== v) offenders.push(k);
  }
  eq(`${f}｜改一个字：没编辑的那些 Shape 逐颗字节一致`, offenders.join(","), "");
  eq(
    `${f}｜改一个字只动那一棵正文树`,
    withoutText(blockOf(blocksAfter, editedId)),
    withoutText(blockOf(blocksBefore, editedId))
  );

  for (const sc of SCENARIOS) {
    const target = sc.find ? sc.find(original) : undefined;
    if (sc.find && !target) {
      skip(`${f}｜${sc.label}`, "这份样张里没有满足前提的主题");
      continue;
    }
    const after = census(await savedXml(sc.apply(original, target)));
    const d = diff(before.tags, after.tags).concat(diff(before.attrs, after.attrs));
    const unexpected = d
      .filter((x) => !sc.allow.has(x.key))
      .map((x) => `${x.key}: ${x.before}->${x.after}`);
    eq(`${f}｜${sc.label}：差分只允许预期那几条`, unexpected.join(" | "), "");
    if (sc.expect) sc.expect(d);
  }
}

done();
