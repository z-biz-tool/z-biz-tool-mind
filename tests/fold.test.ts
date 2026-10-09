/**
 * 折叠状态在 .emmx 里的真落点，以及它存不存得住。
 *
 * 缺陷形状（这里刻意覆盖的）：
 * 1) 读侧认错键。原先判折叠用的是 `<Layout><LayoutDirection V="0"/></Layout>`，但亿图自己写的
 *    五份用户图里 LayoutDirection=0 有三分之一挂在**叶子**主题上（软件质量 36/72、测试基础
 *    13/28、系统测试 9/14），叶子不可能被折叠 —— 那个键表达的不是折叠。按它读，一份 206 个主题
 *    的真图导进来有 72 个被标成折叠（35%），用户看到的就是"三分之一枝干凭空没了"。
 * 2) 真键是 `<Layout><Toggler V="1"/></Layout>`：系统测试里 22 个，22/22 全长在有子主题上，
 *    值域实测只有 "1"（未折叠就不写），且与 LayoutDirection 互斥。
 * 3) 写侧以前根本没落笔：collapsed 只有读没有写，界面里折一支再存盘，重开就全开了。
 * 4) `<Layout>` 是"部分建模"的节点：折叠归我们管，同一个节点里还住着 LayoutDirection、
 *    ImagePos、FlexoStyle、Margins 和我们看不懂的布局码。补折叠不能把它们洗掉。
 *
 * 夹具：合成那一份按亿图 config/empty.emmx 的真实写法排（含 <Layout> 的四个兄弟子元素）；
 * 真文件那一段读 `_research/extract/fold/` 里亿图 2022 年自己另存的三份，缺文件则 skip。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { done, eq, ok, skip } from "./_harness.ts";
import { parseEmmx, writeEmmx } from "../src/engine/emmx/codec.ts";
import { encodeText, readZip, writeZip, decodeBytes } from "../src/engine/emmx/zip.ts";
import { setCollapsed } from "../src/engine/tree.ts";
import type { DocumentModel, Page } from "../src/types/model.ts";

const FOLD_DIR = join(process.cwd(), "_research", "extract", "fold");

// ---------------------------------------------------------------- 合成夹具

const DOC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Document Version="12.0.0" DocVersion="12.0" DocGuid="{11111111-2222-3333-4444-555555555555}">
    <Properties>
        <AutoLayout V="1"/>
        <TimelineWidth V="1000"/>
        <CalloutLayout V="1"/>
        <ShowGroupName V="1"/>
        <Dpi V="1"/>
        <ActiveIndex V="0"/>
        <ScreenWidth V="1920"/>
        <ScreenHeight V="1080"/>
        <Platform V="win"/>
        <ModifyPlatform V="win"/>
        <Creator V="夹具"/>
        <Modifier V="夹具"/>
        <CreatedDate V="2022-08-09 08:23:11"/>
        <ModifiedDate V="2022-08-09 08:23:11"/>
        <Pages V="page"/>
    </Properties>
    <GanttOption>
        <WorkDay V="1;1;1;1;1;0;0"/>
        <MajorTick V="3"/>
        <MinorTick V="0"/>
        <StartDate V="0"/>
        <FinishDate V="0"/>
        <StartTime V="28800"/>
        <FinishTime V="57600"/>
        <UnitWidth V="100"/>
        <ChangeMinor V="0"/>
    </GanttOption>
    <MarkSheet/>
</Document>`;

/** 亿图 `<Shape>` 的紧凑写法；layout 传 "" 就是整个 `<Layout>` 节点都不写。 */
function shape(
  id: string,
  type: "MainIdea" | "MainTopic" | "SubTopic",
  label: string,
  level: string,
  layout: string
): string {
  return (
    `<Shape ID="${id}" Type="${type}">` +
    `<Transform><Width V="100"/><Height V="24"/><CX V="${Number(id) * 10}" B="1" P="0"/>` +
    `<CY V="${Number(id) * 5}" B="2" P="0"/></Transform>` +
    `<ShapeFormat QuickMask="0"><FillFormat/><LineFormat><LineWeight V="1"/></LineFormat></ShapeFormat>` +
    `<Text><Transform><Width V="60"/><Height V="18"/><CX V="30" B="1" P="0"/><CY V="9" B="2" P="0"/></Transform>` +
    `<TextBlock TextFormatMask="0"><Color V="#ff282828"/>` +
    `<Character IX="0" Family="微软雅黑" Size="12" Color="#282828"/><Paragraph IX="0" Align="4" SpLine="100"/>` +
    `<Text><pp PX="0" CX="0"><tp CX="0">${label}</tp></pp></Text></TextBlock></Text>` +
    `<LevelData>${level}</LevelData><Geometries/><ShapeStyle V="1"/>` +
    (layout ? `<Layout>${layout}</Layout>` : "") +
    `</Shape>`
  );
}

/** 亿图在 <Layout> 里跟 Toggler 做邻居的那几个码，一个都不许被写侧洗掉。 */
const LAYOUT_MATES =
  `<ImagePos V="1"/><FlexoStyle V="5"/><Layout V="8"/>` +
  `<Margins LeftMargin="18" TopMargin="14" RightMargin="18" BottomMargin="14"/>`;

const PAGE_XML =
  `<?xml version="1.0"?><Page ID="100" Type="Page" Name="折叠夹具" Zoom="1" QuickMask="0">` +
  `<PageProps><Width V="3072"/><Height V="2160"/><CX V="1536" B="1" P="0"/><CY V="1080" B="2" P="0"/>` +
  `<ScrollX V="0.5"/><ScrollY V="0.5"/></PageProps>` +
  `<Layout><HSpacing V="30"/><VSpacing V="30"/><Layout V="8"/><SectorAlign V="1"/></Layout>` +
  `<FillFormat/><PrintSetup FittoSheet="1" HSheet="1" VSheet="1" Background="1" Width="210" Height="297" Unit="mm"/>` +
  `<Theme ID="40" Rainbow="0" Effect="0" Name="Edraw"><ThemeColor V="3"/><ThemeEffect V="40"/>` +
  `<ThemeText V="40"/><ThemeShape V="40"/></Theme>` +
  // 102 折叠的枝（真键 Toggler=1，带子）
  shape("101", "MainIdea", "中心", `<SubLevel V="102;103"/>`, LAYOUT_MATES) +
  shape(
    "102",
    "MainTopic",
    "收起的枝",
    `<Super V="101"/><SubLevel V="104"/>`,
    `<Toggler V="1"/>` + LAYOUT_MATES
  ) +
  // 103 只是把枝分到左边，没折叠
  shape(
    "103",
    "MainTopic",
    "左边的枝",
    `<Super V="101"/><SubLevel V="105"/>`,
    `<LayoutDirection V="0"/>` + LAYOUT_MATES
  ) +
  // 104 叶子 + LayoutDirection=0：旧读法会把它判成折叠，这是本批的证伪样本
  shape("104", "SubTopic", "左边的叶子", `<Super V="102"/>`, `<LayoutDirection V="0"/>`) +
  // 105 叶子且完全没有 <Layout>
  shape("105", "SubTopic", "右边的叶子", `<Super V="103"/>`, "") +
  `</Page>`;

const bytesOf = async (pageXml: string): Promise<Uint8Array> =>
  writeZip([
    { name: "document.xml", data: encodeText(DOC_XML) },
    { name: "page/page.xml", data: encodeText(pageXml) },
    { name: "rels/page_rels.xml", data: encodeText(`<Relationships/>`) },
  ]);

const pageXmlOf = async (bytes: Uint8Array): Promise<string> =>
  decodeBytes((await readZip(bytes)).find((e) => /page\/page\.xml$/.test(e.name))!.data);

const withPage = (doc: DocumentModel, p: Page): DocumentModel => ({
  ...doc,
  pages: doc.pages.map((x) => (x.id === p.id ? p : x)),
});

const foldedIds = (doc: DocumentModel): string[] =>
  Object.values(doc.pages[0].shapes)
    .filter((s) => s.extras.collapsed)
    .map((s) => s.id)
    .sort();

/** 属性顺序两边不一样：亿图写 `<Shape ID= Type=`，我们重建时是 `<Shape Type= ID=`。 */
const shapeBlock = (xml: string, id: string): string =>
  new RegExp(`<Shape\\b[^>]*\\bID="${id}"[^>]*>([\\s\\S]*?)</Shape>`).exec(xml)?.[1] ?? "";
/** 写出的是带缩进的美化 XML，比结构前先把元素间的空白压掉（属性里的空格留着）。 */
const layoutOf = (xml: string, id: string): string =>
  (/<Layout>([\s\S]*?)<\/Layout>/.exec(shapeBlock(xml, id))?.[1] ?? "")
    .replace(/>\s+</g, "><")
    .trim();
const hasToggler = (xml: string, id: string): boolean =>
  /<Toggler V="1"\/>/.test(layoutOf(xml, id));

{
  const parsed = await parseEmmx(await bytesOf(PAGE_XML));
  const page = parsed.doc.pages[0];
  eq("合成夹具解析无告警", parsed.warnings.join(" | "), "");
  eq("主题数", Object.keys(page.shapes).length, 5);

  // --- 读：只认 Toggler
  eq("折叠的只有带 Toggler=1 的那一支", foldedIds(parsed.doc), ["102"]);
  ok("叶子上的 LayoutDirection=0 不再被当成折叠", !page.shapes["104"].extras.collapsed);
  ok("左边的枝（LayoutDirection=0，有子）也不被当成折叠", !page.shapes["103"].extras.collapsed);
  eq("SubLevel 仍然认得", page.shapes["101"].childIds.join(";"), "102;103");

  // --- 写：没动过的文档原样带回
  const sameXml = await pageXmlOf(await writeEmmx(parsed.doc));
  eq("未编辑时 102 的 Toggler 还在", hasToggler(sameXml, "102"), true);
  eq("未编辑时 103 没有 Toggler", hasToggler(sameXml, "103"), false);
  eq(
    "未编辑时 <Layout> 里那几个兄弟码原样在",
    [
      /LayoutDirection V="0"/.test(layoutOf(sameXml, "103")),
      /ImagePos V="1"/.test(layoutOf(sameXml, "103")),
      /FlexoStyle V="5"/.test(layoutOf(sameXml, "103")),
      /Margins /.test(layoutOf(sameXml, "103")),
      /<Layout V="8"\/>/.test(layoutOf(sameXml, "103")),
    ],
    [true, true, true, true, true]
  );

  // --- 写：展开那一支
  const opened = setCollapsed(page, "102", false);
  const openXml = await pageXmlOf(await writeEmmx(withPage(parsed.doc, opened)));
  eq("展开后不再写 Toggler", hasToggler(openXml, "102"), false);
  eq(
    "展开时同节点的兄弟码一个不丢",
    [
      /ImagePos V="1"/.test(layoutOf(openXml, "102")),
      /FlexoStyle V="5"/.test(layoutOf(openXml, "102")),
      /<Layout V="8"\/>/.test(layoutOf(openXml, "102")),
      /Margins LeftMargin="18"/.test(layoutOf(openXml, "102")),
    ],
    [true, true, true, true]
  );
  eq(
    "展开后重读仍是展开",
    foldedIds((await parseEmmx(await writeEmmx(withPage(parsed.doc, opened)))).doc),
    []
  );

  // --- 写：折一支原本没 Toggler 的
  const folded = setCollapsed(page, "103", true);
  const foldXml = await pageXmlOf(await writeEmmx(withPage(parsed.doc, folded)));
  eq("折叠左边的枝会补 Toggler", hasToggler(foldXml, "103"), true);
  eq(
    "补进去的 Toggler 排在 <Layout> 开头（跟亿图自己的写法一致）",
    layoutOf(foldXml, "103").startsWith(`<Toggler V="1"/>`),
    true
  );
  eq(
    "补 Toggler 不动 LayoutDirection",
    [
      /LayoutDirection V="0"/.test(layoutOf(foldXml, "103")),
      /ImagePos V="1"/.test(layoutOf(foldXml, "103")),
    ],
    [true, true]
  );
  eq(
    "折叠态存得回",
    foldedIds((await parseEmmx(await writeEmmx(withPage(parsed.doc, folded)))).doc),
    ["102", "103"]
  );

  // --- 写：给一个原本没有 <Layout> 的主题折叠
  const leafFolded = setCollapsed(page, "105", true);
  const leafXml = await pageXmlOf(await writeEmmx(withPage(parsed.doc, leafFolded)));
  eq("没有 <Layout> 的主题折叠时新建一个", layoutOf(leafXml, "105"), `<Toggler V="1"/>`);

  // --- 幂等
  const twice = await parseEmmx(await writeEmmx(withPage(parsed.doc, folded)));
  eq(
    "写两次折叠集不漂",
    foldedIds((await parseEmmx(await writeEmmx(twice.doc))).doc),
    foldedIds(twice.doc)
  );
}

// ---------------------------------------------------------------- 真亿图文件

type Case = { file: string; toggler: number; direction: number; expectFolded: string[] };
const REAL: Case[] = [
  { file: "系统测试_backup_0823d.emmx", toggler: 22, direction: 14, expectFolded: [] },
  { file: "软件质量_backup_242322.emmx", toggler: 0, direction: 72, expectFolded: [] },
  { file: "测试基础_backup_222219.emmx", toggler: 0, direction: 28, expectFolded: [] },
];

for (const c of REAL) {
  const p = join(FOLD_DIR, c.file);
  if (!existsSync(p)) {
    skip(c.file, `找不到夹具 ${p}`);
    continue;
  }
  const doc = (await parseEmmx(new Uint8Array(readFileSync(p)))).doc;
  const page = doc.pages[0];
  const topics = Object.values(page.shapes).filter((s) => /Topic$/.test(s.type));
  const got = topics.filter((s) => s.extras.collapsed).map((s) => s.id);
  const src = decodeBytes(
    (await readZip(new Uint8Array(readFileSync(p)))).find((e) => /page\/page\.xml$/i.test(e.name))!
      .data
  );
  const togglerCount = (src.match(/<Toggler\b/g) || []).length;
  const dirCount = (src.match(/<LayoutDirection\b/g) || []).length;

  eq(`${c.file}：夹具里 Toggler 数`, togglerCount, c.toggler);
  eq(`${c.file}：夹具里 LayoutDirection 数`, dirCount, c.direction);
  eq(`${c.file}：导入后的折叠数 == Toggler 数`, got.length, c.toggler);
  eq(
    `${c.file}：一个叶子主题都不该被标成折叠`,
    got.filter((id) => !page.shapes[id].childIds.length),
    []
  );
  if (c.toggler === 0) {
    eq(`${c.file}：0 个 Toggler 就该 0 个折叠（旧读法在这里报 ${c.direction}）`, got.length, 0);
  }
  // 存盘要能保住原样：不改任何东西写一次，折叠集与那两个键都不许漂。
  const back = (await parseEmmx(await writeEmmx(doc))).doc.pages[0];
  const backTopics = Object.values(back.shapes).filter((s) => /Topic$/.test(s.type));
  eq(
    `${c.file}：原样存一次，折叠集不变`,
    backTopics
      .filter((s) => s.extras.collapsed)
      .map((s) => s.id)
      .sort(),
    got.slice().sort()
  );
  const backSrc = decodeBytes(
    (await readZip(await writeEmmx(doc))).find((e) => /page\/page\.xml$/i.test(e.name))!.data
  );
  eq(
    `${c.file}：存回去还留着 ${c.toggler} 个 Toggler`,
    (backSrc.match(/<Toggler\b/g) || []).length,
    c.toggler
  );
  eq(
    `${c.file}：存回去不许把 LayoutDirection 洗掉（旧读法会把它当折叠写没）`,
    (backSrc.match(/<LayoutDirection\b/g) || []).length,
    c.direction
  );
}

done();
