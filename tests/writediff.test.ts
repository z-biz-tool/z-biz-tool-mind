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
  setRelationshipText,
  setTopicBold,
  setTopicFont,
  toggleRelationship,
  updateExtras,
  updateStyle,
  updateText,
  updateTransform,
} from "../src/engine/tree.ts";
import { styleFor } from "../src/engine/style.ts";
import { detectEol, parseXml, serializeXml } from "../src/engine/emmx/xparse.ts";
import { createDocument } from "../src/model/factory.ts";
import type { DocumentModel, Page, Shape } from "../src/types/model.ts";
import { plainText, referencedChar, usedCharIx } from "../src/types/model.ts";

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
/** 那一颗盘上的路径缓存整段（01 A-23 起它是被断言的对象：亿图照它画泡、也照它画字）。 */
const geoOf = (block: string): string =>
  /<Geometries>[\s\S]*?<\/Geometries>|<Geometries\/>/.exec(block)?.[0] ?? "(没有 <Geometries>)";
/** 剥掉整棵正文子树：改标题时除它以外的一字节都不许变。 */
const withoutText = (block: string): string =>
  block.replace(/<Text>[\s\S]*<\/TextBlock><\/Text>/, "§");
/**
 * 形状盒（一颗 Shape 里**先来**那个 `<Transform>`）的宽高。属性顺序两边不一样，所以只认 V。
 * 01 A-21 起它是被断言的对象：文字盒长多少，形状盒就该跟着长多少。
 */
const boxWH = (block: string): string => {
  const m = /^<Transform>[\s\S]*?<\/Transform>/.exec(block)?.[0] ?? "";
  const w = /<Width\b[^>]*\bV="([^"]+)"/.exec(m)?.[1];
  const h = /<Height\b[^>]*\bV="([^"]+)"/.exec(m)?.[1];
  return `${w}x${h}`;
};
/**
 * 剥掉"改正文本来就会带着动"的三块：形状盒、正文盒、由盒子决定的路径缓存（01 A-21）。
 * 剩下的子节点必须一字节不差 —— 这是"改名不许连累别的"在新口径下的形状。
 */
const untouchedOf = (block: string): string =>
  withoutText(block)
    .replace(/^<Transform>[\s\S]*?<\/Transform>/, "§")
    .replace(/<Geometries>[\s\S]*?<\/Geometries>|<Geometries\/>/, "§");

/**
 * 比较用的规范化：把实体解回字符再比字节。
 * 批 3O 之前这里还有一个理由 —— 亿图把 `>` 裸写在正文里，我们的序列化器写 `&gt;`，
 * 同一种内容两种写法。现在序列化器跟着亿图裸写了（01 A-25），这条规范化只剩"两边都可能
 * 出现 `&amp;` 之类同一字符的两种写法"这个用途，留着比去掉稳。
 */
const ENTITY: Record<string, string> = { gt: ">", lt: "<", quot: '"', apos: "'", amp: "&" };
const decoded = (block: string): string =>
  block.replace(/&(gt|lt|quot|apos|amp);/g, (_m, k) => ENTITY[k] ?? _m);
/** 属性顺序两边不一样（亿图写 `<CY B= P= V=`，我们写 `<CY V= P= B=`），所以按标签抓、再查属性。 */
const hasTag = (block: string, tag: string, attrs: Record<string, string>): boolean =>
  Object.entries(attrs).every(([k, v]) =>
    new RegExp(`<${tag}\\b[^>]*\\b${k}="${v}"[^>]*>`).test(block)
  );

/**
 * 抓文字盒那一层：一颗 Shape 里有两个 `<Transform>`，先来的是形状盒（布局给的），
 * `<Text><Transform>` 起的才是文字盒（01 A-18 的锚点住在这里）。
 * 属性顺序两份样张就不一样（`测试基础` 写 `<Width V="60"/>`、`系统测试` 写 `<Width B="3" P="0" V="60"/>`），
 * 所以先切区间、再逐标签抓 V，不假设顺序。
 */
const textBoxGeom = (block: string): { tw: number; th: number; cx: number; cy: number } => {
  const m = /<Text><Transform>([\s\S]*?)<\/Transform>/.exec(block);
  if (!m) return { tw: NaN, th: NaN, cx: NaN, cy: NaN };
  const val = (tag: string): number => {
    const e = new RegExp(`<${tag}\\b([^>]*?)\\/>`).exec(m[1]);
    return e ? Number(/\bV="([^"]+)"/.exec(e[1])?.[1] ?? "NaN") : NaN;
  };
  return { tw: val("Width"), th: val("Height"), cx: val("CX"), cy: val("CY") };
};
/** 亿图的口径：锚 = 文字盒在形状盒里的左/上内缩 + 自身半边。内缩是版式属性，我们不建模，只许跟着走。 */
const textBoxPad = (g: { tw: number; th: number; cx: number; cy: number }): string =>
  `${(g.cx - g.tw / 2).toFixed(1)}/${(g.cy - g.th / 2).toFixed(1)}`;
/** 形状盒比文字盒多出来的那一圈内缩（01 A-21 的不变量：亿图 1328 颗双盒形状里文字盒溢出 0 次）。 */
const insetOf = (block: string): string => {
  const [bw, bh] = boxWH(block).split("x").map(Number);
  const g = textBoxGeom(block);
  return `${bw - g.tw}/${bh - g.th}`;
};

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
 * cx/cy 是文字盒中心锚：亿图实测写的是"形状盒里的左/上内缩 + 自身半边"（88×18 那颗 → 7.0/2.4 内缩），
 * 而形状盒夹具是 120 宽 ⇒ 内缩不对称，"按形状盒中心写"会得到 60，两种规则才分得开（01 A-18）。
 * noWH 是"只有锚、没有盒子尺寸"的残缺写法：内缩反推不出来，整条得按没声明处理。
 */
function textBox(
  label: string,
  opts: {
    mask?: string;
    bk?: string;
    style?: string;
    extra?: string;
    cx?: string;
    cy?: string;
    noWH?: boolean;
  } = {}
): string {
  const wh = opts.noWH ? "" : `<Width V="88"/><Height V="18"/>`;
  return (
    `<Text><Transform>` +
    wh +
    `<CX V="${opts.cx ?? "51"}" B="1" P="0"/><CY V="${opts.cy ?? "11.4"}" B="2" P="0"/></Transform>` +
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

/**
 * 亿图给一颗 SubTopic 写的第一段轮廓就是它自己盒子的四个角（01 A-23：真语料 1317 颗 SubTopic 全是这一种写法，
 * 贴边的点 P="1"、原点 P="0"；B 恒为 X=1/Y=2，属性顺序亿图自己混着写，这里按 V→P→B 那一种）。104 带着它 —— 这一型的"现成轮廓"就住在这一页里。
 */
const SUB_GEO =
  `<Geometries><Geometry Closed="1" NoLine="1">` +
  `<MoveTo><X V="0" P="0" B="1"/><Y V="0" P="0" B="2"/></MoveTo>` +
  `<LineTo><X V="100" P="1" B="1"/><Y V="0" P="0" B="2"/></LineTo>` +
  `<LineTo><X V="100" P="1" B="1"/><Y V="24" P="1" B="2"/></LineTo>` +
  `<LineTo><X V="0" P="0" B="1"/><Y V="24" P="1" B="2"/></LineTo>` +
  `<LineTo><X V="0" P="0" B="1"/><Y V="0" P="0" B="2"/></LineTo></Geometry></Geometries>`;

/** 103 自己那份轮廓（同型、别的尺寸）：它存在的意义就是"借来的"与"自己的"能在字节上分开。 */
const GEO_103 =
  `<Geometries><Geometry Closed="1">` +
  `<MoveTo><X V="0" P="0" B="1"/><Y V="0" P="0" B="2"/></MoveTo>` +
  `<LineTo><X V="120" P="1" B="1"/><Y V="0" P="0" B="2"/></LineTo>` +
  `<LineTo><X V="120" P="1" B="1"/><Y V="28" P="1" B="2"/></LineTo>` +
  `<LineTo><X V="0" P="0" B="1"/><Y V="28" P="1" B="2"/></LineTo>` +
  `<LineTo><X V="0" P="0" B="1"/><Y V="0" P="0" B="2"/></LineTo></Geometry></Geometries>`;

/** `<Layout>` 是部分建模的：Toggler 归我们管，ImagePos/FlexoStyle/Layout/Margins 这几个邻居必须原样留着。 */
const LAYOUT_MATES =
  `<ImagePos V="1"/><FlexoStyle V="5"/><Layout V="8"/>` +
  `<Margins LeftMargin="18" TopMargin="14" RightMargin="18" BottomMargin="14"/>`;

const SHAPE_101 =
  `<Shape ID="101" Type="MainIdea">` +
  `<Transform><Width V="140"/><Height V="32"/><CX V="500" B="1" P="0"/><CY V="300" B="2" P="0"/></Transform>` +
  `<ShapeFormat QuickMask="0"><FillFormat/><LineFormat><LineWeight V="1"/></LineFormat></ShapeFormat>` +
  // 101 的文字盒故意缺 Width/Height：四值不齐就没法反推内缩，必须按"没声明"走形状盒中心（01 A-18）。
  textBox("中心", { noWH: true }) +
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
// 它另带一份**自己的**轮廓（GEO_103，尺寸与 102 那份不同）：这一型在这一页里就有两颗，
// "带回自己那一份"和"借隔壁那一份"从此能在字节上分开。
const SHAPE_103 =
  `<Shape ID="103" Type="MainTopic">` +
  `<Transform><Width V="120"/><Height V="28"/><CX V="300" B="1" P="0"/><CY V="400" B="2" P="0"/></Transform>` +
  `<ShapeFormat QuickMask="4095"><FillFormat Type="Solid"><Color V="#ff4caf50"/></FillFormat>` +
  `<LineFormat><LineWeight V="1"/></LineFormat></ShapeFormat>` +
  textBox("分支乙") +
  `<LevelData><Super V="101"/><SubLevel V="105"/></LevelData>${GEO_103}<ShapeStyle V="5"/>` +
  `<Layout><LayoutDirection V="1"/>${LAYOUT_MATES}</Layout></Shape>`;

// 叶子的两种特殊写法：style 那颗是"亿图写了加粗"，task 那颗是"属性只写了一半的自造节点"。
// 105 另外带着一根"两根轴都是 0"的锚 —— 那是我们旧写手发明的写法，亿图 1344/1344 个文字盒都不这么写，
// 拿它反推内缩会得到负内缩，所以必须按"没声明"处理（01 A-18）。
const leaf = (
  id: string,
  superId: string,
  label: string,
  opts: { style?: string; task?: string; cx?: string; cy?: string; geo?: string } = {}
): string =>
  `<Shape ID="${id}" Type="SubTopic">` +
  `<Transform><Width V="100"/><Height V="24"/><CX V="${Number(id) * 3}" B="1" P="0"/><CY V="${
    Number(id) * 7
  }" B="2" P="0"/></Transform>` +
  `<ShapeFormat QuickMask="4095"><FillFormat/><LineFormat><LineWeight V="1"/></LineFormat></ShapeFormat>` +
  textBox(label, { style: opts.style, cx: opts.cx, cy: opts.cy }) +
  `<LevelData><Super V="${superId}"/></LevelData>${opts.geo ?? `<Geometries/>`}<ShapeStyle V="1"/>${
    opts.task ?? ""
  }</Shape>`;

// 连接线在 .emmx 里也是 Shape，占同一套号段：900 被它占了，新主题就不许发到 900。
const CONNECTOR_900 =
  `<Shape ID="900" Type="MMConnector">` +
  `<MMConnector BeginID="102" EndID="103" Thickness="2"/>` +
  `<Geometries><Geometry Closed="0"><MoveTo><X B="1" P="0" V="0"/></MoveTo></Geometry></Geometries>` +
  `</Shape>`;

/** 亿图给关系线写的路径缓存：一段 Closed="0" 的贝塞尔，坐标全 P="0"，原点在这颗自己的 CX/CY（两端的中间）。 */
const REL_GEO =
  `<Geometries><Geometry Closed="0">` +
  `<MoveTo><X V="2.62904" B="1" P="0"/><Y V="43.5" B="2" P="0"/></MoveTo>` +
  `<CurveTo><X V="-2.62904" B="1" P="0"/><Y V="-43.5" B="2" P="0"/>` +
  `<A V="10.4524" B="1" P="0"/><B V="-1.25" B="2" P="0"/>` +
  `<C V="-11.7334" B="1" P="0"/><D V="2.75" B="2" P="0"/></CurveTo></Geometry></Geometries>`;

// 关系线的端点真键是 <ConnectMap From="起" To="止"/>（01 A-24：54 份真文件里 20 颗线，20/20 都带它；
// 亿图 0/20 写过我们旧版那个 <RelatConnector Thickness>）。BeginPt/EndPt 挂的是坐标，不是指针。
// PathText/LevelData/ShapeStyle/Transform 与线里的 EndArrow 都是模型没建模的邻居。
const REL_901 =
  `<Shape ID="901" Type="RelatConnector">` +
  `<ConnectMap From="102" To="103"/>` +
  `<PathText V="0"/>` +
  `<BeginPt X="1156.76" Y="782.75"/>` +
  `<EndPt X="1151.51" Y="695.75"/>` +
  `<Transform><Width V="0"/><Height V="0"/><CX V="1154.13" B="1" P="0"/><CY V="739.25" B="2" P="0"/></Transform>` +
  `<ShapeFormat QuickMask="0"><FillFormat/><LineFormat><LineWeight V="1"/><LineCap V="Round"/>` +
  `<EndArrow ID="5" Size="4"/><LineFill Type="Solid"><Color V="#fff38590"/></LineFill></LineFormat></ShapeFormat>` +
  textBox("对照") +
  `<LevelData/>` +
  REL_GEO +
  `<ShapeStyle V="101"/></Shape>`;

// 我们旧版写下的那种关系线：端点挂在 <BeginPt ID=../>，还带一个亿图从不写的 <RelatConnector Thickness>。
// 读侧要认得它（回退），回写时要把真键补上、把自造的那个元素摘掉。
const REL_902_LEGACY =
  `<Shape ID="902" Type="RelatConnector">` +
  `<RelatConnector Thickness="0"/>` +
  `<BeginPt ID="104"/>` +
  `<EndPt ID="105"/>` +
  textBox("旧版线") +
  `<Geometries/></Shape>`;

/** 页头那几块（PageProps/Layout/FillFormat/PrintSetup/Theme）两份夹具共用：Shape 那一截才是各层自己的。 */
const PAGE_HEAD =
  `<?xml version="1.0"?><Page ID="100" Type="Page" Name="无损夹具" Zoom="1" QuickMask="0">` +
  `<PageProps><Width V="3072"/><Height V="2160"/><CX V="1536" B="1" P="0"/><CY V="1080" B="2" P="0"/>` +
  `<ScrollX V="0.5"/><ScrollY V="0.5"/></PageProps>` +
  `<Layout><HSpacing V="30"/><VSpacing V="30"/><Layout V="8"/><SectorAlign V="1"/></Layout>` +
  `<FillFormat/><PrintSetup FittoSheet="1" HSheet="1" VSheet="1" Background="1" Width="210" Height="297" Unit="mm"/>` +
  `<Theme ID="40" Rainbow="0" Effect="0" Name="Edraw"><ThemeColor V="3"/><ThemeEffect V="40"/>` +
  `<ThemeText V="40"/><ThemeShape V="40"/></Theme>`;

const PAGE_XML =
  PAGE_HEAD +
  SHAPE_101 +
  SHAPE_102 +
  SHAPE_103 +
  // 104 的锚点故意带三位小数：反推出来的中心是 33.006 这种值，看存盘有没有按全篇的两位精度收口。
  leaf("104", "102", "甲的叶子", {
    task: `<TaskInfo Progress="50"/>`,
    cx: "51.006",
    cy: "11.449",
    geo: SUB_GEO,
  }) +
  leaf("105", "103", "乙的叶子", { style: "1", cx: "0", cy: "0" }) +
  CONNECTOR_900 +
  REL_901 +
  REL_902_LEGACY +
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

  // -------------------------------------------------- 改标题：正文、形状盒、路径缓存之外一字节都不许动
  const renamed = shapeBlocks(
    await savedXml(withPage(parsed.doc, updateText(base, "102", "改名了")))
  );
  const r102 = blockOf(renamed, "102");
  ok("正文真的改了", /<tp CX="0">改名了<\/tp>/.test(r102));
  eq(
    "改标题不许动这三块以外的任何一颗子节点",
    untouchedOf(r102),
    untouchedOf(blockOf(ORIG, "102"))
  );
  ok("ToSuper 还在", /<ToSuper V="103"\/>/.test(r102));
  ok("QuickMask 还是 4095", /<ShapeFormat QuickMask="4095">/.test(r102));
  // 01 A-21：亿图的不变量是"形状盒 = 文字盒 + 一层按型内缩"（1328 颗双盒形状里溢出 0 次）。
  // 夹具 102 原盒 120×28、原文字盒 88×18 ⇒ 内缩 32/10；"改名了"量出来 52×21 ⇒ 新盒 84×31。
  eq("形状盒跟着文字盒一起动（带原内缩 32/10）", boxWH(r102), "84x31");
  eq("内缩那份守恒，不许被我们的尺洗成新常数", insetOf(r102), insetOf(blockOf(ORIG, "102")));
  ok(
    "盒子改了也原样带回亿图那份路径缓存（清空它 = 亿图既不画泡也不画字，01 A-23）",
    r102.includes(GEO_CACHE),
    r102.slice(0, 260)
  );
  ok("第二条 Paragraph 还在", /<Paragraph IX="1" IndFirst="0" SpaceBefore="12"\/>/.test(r102));
  ok("文字背景色带回来了（值级：census 看不见这一条）", /BkColor="#ffff00"/.test(r102));
  ok("掩码跟着原文件写 0，没被常数洗成 10224", /<TextBlock TextFormatMask="0">/.test(r102));
  ok("ShapeStyle 还是亿图写的 5", /<ShapeStyle V="5"\/>/.test(r102));
  ok(
    "重建的形状盒仍带 B/P 锚点（按亿图最常见的那一种顺序 V→P→B），精度按全篇统一的两位收口",
    /<CX V="707.62" P="0" B="1"\/>/.test(r102),
    "盘上是 " + (/<CX [^>]*>/.exec(r102)?.[0] ?? "(无 CX)")
  );
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
  // 01 A-21：折叠没碰字，盒子就不该跟着我们的尺重量一遍 —— 量出的差是尺的精度差，
  // 一旦落到形状盒上会连累 <Geometries> 整颗清空。
  eq("折叠不动字 ⇒ 形状盒一个点都不许动", boxWH(f102), boxWH(blockOf(ORIG, "102")));
  ok("折叠时形状盒整块复用（707.621 的精度位还在）", /<CX V="707.621" B="1" P="0"\/>/.test(f102));
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
    "改色只动 ShapeFormat，路径缓存原样带回（01 A-23：清空就等于在亿图里画不出这一颗）",
    s102.includes(GEO_CACHE)
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
  // 01 A-23：这一页里同型有两颗，103 必须带回**它自己**那一份，而不是隔壁 102 的 ——
  // "借隔壁"只在这一颗自己没有轮廓时才发生（见上面 105 那一条）。
  eq("改色那颗带回的是它自己的轮廓，不是隔壁同型那一份", geoOf(s103), GEO_103);

  // -------------------------------------------------- 拖动：位置变了，锚点与树都得在
  const moved = shapeBlocks(
    await savedXml(withPage(parsed.doc, updateTransform(base, "102", { y: 400 })))
  );
  const m102 = blockOf(moved, "102");
  ok("新位置写上了", hasTag(m102, "CY", { V: "400", B: "2", P: "0" }), m102.slice(0, 200));
  eq("拖动只改位置，不改盒子（01 A-21）", boxWH(m102), boxWH(blockOf(ORIG, "102")));
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
  // 01 A-21：新建的主题此前落 0×0（`makeShape` 的种子），亿图打开就是一行没有框的字。
  // 亿图给这一型的盒子比文字盒宽 14、高 5.5（1050 颗 SubTopic 的众数），按它补。
  ok(`新主题的形状盒不再是 0×0（量出 ${boxWH(nShape)}）`, boxWH(nShape) !== "0x0");
  eq("新主题的内缩用亿图自己新建形状那一档", insetOf(nShape), "14/5.5");
  // 01 A-23：亿图照 <Geometries> 画泡、也照它画字，空缓存那颗 = 泡和字一起看不见。
  // 这一页里有同型（SubTopic）的现成轮廓 ⇒ 新建的这颗直接借 104 那一份、逐字节带回：
  // 贴边的点带 P="1"，会随新那颗自己的盒子缩放，所以我们不必（也不该）替它重算坐标。
  const nGeo = geoOf(nShape);
  ok(`新主题带的不是空缓存（盘上是 ${nGeo.slice(0, 30)}…）`, !/<Geometries\/>/.test(nGeo));
  eq("新主题借的就是这一页同型的那一份现成轮廓", nGeo, SUB_GEO);

  // 这一型在这一页里没有现成轮廓 ⇒ 按亿图自己的矩形写法补一段（真语料 1374 颗主题的第一段 <Geometry>
  // 全是盒子四角）。中心主题 101 正走这一条：它盘上是空缓存，页里也没有别的 MainIdea 可借。
  const grew101 = shapeBlocks(
    await savedXml(withPage(parsed.doc, updateText(base, "101", "中心主题的名字长了一大截")))
  );
  const g101 = blockOf(grew101, "101");
  {
    const g = geoOf(g101);
    const [w, h] = boxWH(g101).split("x").map(Number);
    ok(
      "MainIdea 无轮廓可借 ⇒ 补一段封闭矩形（MoveTo + 4 根 LineTo）",
      /<Geometry Closed="1">/.test(g) && (g.match(/<LineTo\b/g) ?? []).length === 4,
      g
    );
    ok(
      `补的点落在它自己放大后的形状盒上（${w}×${h}）`,
      g.includes(`<X V="${w}" P="1" B="1"/>`) && g.includes(`<Y V="${h}" P="1" B="2"/>`),
      g
    );
    ok('原点的两根轴都写 P="0"', /<X V="0" P="0" B="1"\/><Y V="0" P="0" B="2"\/>/.test(g), g);
  }

  // 我们旧版写下的空缓存（105 那颗）编辑到它时同样得治好 —— 借这一页同型的现成轮廓。
  const grew105 = shapeBlocks(
    await savedXml(withPage(parsed.doc, updateText(base, "105", "乙的叶子改名")))
  );
  const L105 = blockOf(grew105, "105");
  eq(
    "旧版留下的空缓存被编辑时借到同型轮廓（不许把它留在亿图画不出来的样子）",
    geoOf(L105),
    SUB_GEO
  );
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

  // -------------------------------------------------- 关系线：端点读对键，改动只碰该碰的（01 A-24）
  eq("夹具里的关系线进模型", base.relationships.length, 2);
  eq("真键读法：ConnectMap 的 From 就是 beginId", base.relationships[0]?.beginId, "102");
  eq("真键读法：ConnectMap 的 To 就是 endId", base.relationships[0]?.endId, "103");
  eq(
    "我们旧版写的 BeginPt@ID 形式还能回退读出来",
    `${base.relationships[1]?.beginId}-${base.relationships[1]?.endId}`,
    "104-105"
  );
  eq("改一颗主题的标题不许连累关系线", blockOf(renamed, "901"), blockOf(ORIG, "901"));

  // 只改标签字：端点没动 ⇒ 两端坐标、那段曲线、以及模型里没建模的邻居都得原样带回。
  const relTxt = shapeBlocks(
    await savedXml(withPage(parsed.doc, setRelationshipText(base, "901", "改名了的关系线")))
  );
  const r901 = blockOf(relTxt, "901");
  ok("标签真的改了", /<tp CX="0">改名了的关系线<\/tp>/.test(r901), r901.slice(0, 240));
  eq("端点没动就原样带回亿图那段曲线", geoOf(r901), REL_GEO);
  ok(
    "两端坐标原样带回",
    r901.includes(`<BeginPt X="1156.76" Y="782.75"/>`) &&
      r901.includes(`<EndPt X="1151.51" Y="695.75"/>`),
    r901
  );
  ok(
    "ConnectMap 还在，且还是原来那两个号",
    /<ConnectMap\b[^>]*\bFrom="102"/.test(r901) && /<ConnectMap\b[^>]*\bTo="103"/.test(r901),
    r901
  );
  for (const seg of [
    `<PathText V="0"/>`,
    `<LevelData/>`,
    `<ShapeStyle V="101"/>`,
    `<EndArrow ID="5" Size="4"/>`,
    `<Transform><Width V="0"/><Height V="0"/>`,
  ])
    ok(`模型里没写的 ${seg.slice(1, 26)} 不许在重建时丢`, r901.includes(seg), r901);
  // 同一位上的那一段也不能被"带回一份 + 再补一份"写两遍：亿图读的是第一份，第二份是坏文件。
  // 只数开标签 `<Tag`（闭标签 `</Tag>` 里也含这段名字），且只数这一层里亿图只写一次的键
  // —— `<Text>` 那颗按亿图的真写法本来就有两层，`<Transform>` 形状盒与文字盒各一份。
  for (const tag of [
    "ConnectMap",
    "BeginPt",
    "EndPt",
    "Geometries",
    "ShapeFormat",
    "LevelData",
    "PathText",
    "ShapeStyle",
    "TextBlock",
    "CurveTo",
  ])
    eq(
      `重建出来的关系线每段只许出现一次（<${tag}）`,
      (r901.match(new RegExp(`<${tag}\\b`, "g")) ?? []).length,
      1
    );

  // 旧版那颗：回写时补上亿图认的真键，摘掉亿图 0/20 写过的自造元素。
  const relLeg = shapeBlocks(
    await savedXml(withPage(parsed.doc, setRelationshipText(base, "902", "旧版线改名")))
  );
  const r902 = blockOf(relLeg, "902");
  ok(
    "旧版那颗回写后带上 ConnectMap",
    /<ConnectMap\b[^>]*\bFrom="104"/.test(r902) && /<ConnectMap\b[^>]*\bTo="105"/.test(r902),
    r902
  );
  ok("亿图从不写的 <RelatConnector Thickness> 不再留在盘上", !/<RelatConnector\b/.test(r902), r902);

  // 端点一换号，按旧端点算的曲线与坐标就都是假的：不许原样带走（这一条的真机后果另记 01 A-24）。
  const movedRel: Page = {
    ...base,
    relationships: base.relationships.map((x) => (x.id === "901" ? { ...x, endId: "104" } : x)),
  };
  const m901 = blockOf(shapeBlocks(await savedXml(withPage(parsed.doc, movedRel))), "901");
  ok("端点换了号，ConnectMap 跟着改", /<ConnectMap\b[^>]*\bTo="104"/.test(m901), m901);
  eq("端点一动，旧曲线不留在盘上", geoOf(m901), "<Geometries/>");
  ok("端点一动，旧坐标也不留", !m901.includes(`<BeginPt X="1156.76"`), m901.slice(0, 240));

  // 我们这边新连的一条：模型里只有两个端点号，没有任何亿图算出来的坐标/曲线/外框。
  // 盘上就只许写亿图认的那把真键 —— 自造 BeginPt 坐标等于替亿图算它没让我们算的路径（01 A-24）。
  const newRel = toggleRelationship(base, "104", "101");
  const relId = newRel.relationships.find(
    (x) => !base.relationships.some((y) => y.id === x.id)
  )?.id;
  ok("模型里真的多了一条", Boolean(relId));
  const n901 = blockOf(shapeBlocks(await savedXml(withPage(parsed.doc, newRel))), relId ?? "");
  ok(`新那条真的落到盘上了（${relId}）`, n901.length > 0, `盘上找不到 ${relId}`);
  ok(
    "新那条带 ConnectMap，两端号就是模型里那两个",
    /<ConnectMap\b[^>]*\bFrom="104"/.test(n901) && /<ConnectMap\b[^>]*\bTo="101"/.test(n901),
    n901
  );
  ok("新那条不发明 BeginPt/EndPt 坐标", !/<BeginPt\b|<EndPt\b/.test(n901), n901);
  ok("新那条不发明形状外框与曲线（亿图 0/20 也没让我们写）", geoOf(n901) === "<Geometries/>", n901);
  ok("也不写我们旧版那个自造元素", !/<RelatConnector\b/.test(n901), n901);
  const relBack = (await parseEmmx(await writeEmmx(withPage(parsed.doc, newRel)))).doc.pages[0];
  eq(
    "重开读回这一条的两端",
    `${relBack.relationships.find((x) => x.id === relId)?.beginId}-${
      relBack.relationships.find((x) => x.id === relId)?.endId
    }`,
    "104-101"
  );

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
    // withoutText 把整棵 `<Text>` 剥掉了，所以文字盒的尺寸要在这一层按值再钉一次：
    // 样式位只改样式，不许让盒子跟着我们的尺重量一遍（01 A-21 的 dims 沿用）。
    const gBold = textBoxGeom(b104);
    const gBare = textBoxGeom(blockOf(bareBlocks, "104"));
    eq("加粗前后文字盒宽高一个点都不动", `${gBold.tw}x${gBold.th}`, `${gBare.tw}x${gBare.th}`);
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

  // -------------------------------------------------- 字号/字色/字体族：这一笔在盘上的全部足迹（01 A-17）
  {
    // 键级差分对纯值变更是盲的（Size 从 12 变成 16 它读作"什么都没发生"），所以这一批全按值断言。
    const attrOf = (block: string, tag: string, attr: string): string | undefined =>
      new RegExp(`<${tag}\\b[^>]*\\b${attr}="([^"]*)"`).exec(block)?.[1];
    /** 一颗 Shape 里有两层 Transform：先来的那是盒子（布局给的），后来的才是文字盒。 */
    const textBoxWH = (block: string): string => {
      const m = /<Text><Transform><Width V="([^"]+)"\/><Height V="([^"]+)"\/>/.exec(block);
      return m ? `${m[1]}x${m[2]}` : "";
    };
    const bare = await savedXml(parsed.doc);
    eq(
      "基线：夹具 5 颗主题 + 2 条关系线，各带一条 Character",
      all(bare, /<Character\b/g).length,
      7
    );

    // ① 字号：落在被引用的那一条上，文字盒宽高跟着重算，其余一颗都不许动。
    const up = setTopicFont(base, "104", { size: 16 });
    const upXml = await savedXml(withPage(parsed.doc, up));
    const upBlocks = shapeBlocks(upXml);
    const u104 = blockOf(upBlocks, "104");
    eq("字号写在 Character@Size 上", attrOf(u104, "Character", "Size"), "16");
    eq("改字号不新增也不减少任何一条码（值变了，计数没变）", keyDelta(bare, upXml), "");
    eq("文字盒宽高跟着重算：宽 4 + 4 字 ×(16+4)，高 1 段 ×16×1.75", textBoxWH(u104), "84x28");
    eq(
      "这颗在正文、形状盒与路径缓存以外一字节都不动",
      untouchedOf(u104),
      untouchedOf(blockOf(ORIG, "104"))
    );
    // 01 A-21：形状盒必须一起长 —— 夹具 104 原盒 100×24、原文字盒 88×18 ⇒ 内缩 12/6 ⇒ 新盒 96×34。
    eq("形状盒带着原内缩 12/6 一起改尺寸", boxWH(u104), "96x34");
    ok("形状盒始终包住文字盒（亿图 1328 颗里溢出 0 次）", Number(boxWH(u104).split("x")[0]) > 84);
    ok("文字背景色这类没建模的键活下来了", /BkColor="#ffff00"/.test(blockOf(upBlocks, "102")));
    for (const id of ["101", "102", "103", "105", "900"])
      eq(`改 104 的字号不许连累 ${id}`, blockOf(upBlocks, id), blockOf(ORIG, id));
    const upBack = (await parseEmmx(await writeEmmx(withPage(parsed.doc, up)))).doc.pages[0];
    eq(
      "重开读回 16：文件写了就照它（01 A-17）",
      referencedChar(upBack.shapes["104"].text)?.size,
      16
    );
    eq("画布也算出同一个 16", styleFor(upBack, upBack.shapes["104"]).font.size, 16);

    // ② 字色：`Character@Color` 和文字盒底色 `<Color V>` 是同一个来源，改色两处一起走。
    const dyed = setTopicFont(base, "104", { color: "#e91e63" });
    const d104 = blockOf(shapeBlocks(await savedXml(withPage(parsed.doc, dyed))), "104");
    eq("字色写在 Character@Color 上（6 位 RGB）", attrOf(d104, "Character", "Color"), "#e91e63");
    eq("盒底色同一个值，补齐成亿图的 8 位写法", attrOf(d104, "Color", "V"), "#ffe91e63");
    eq("改字色不许重测文字盒（样式位沿用原盒 88×18）", textBoxWH(d104), "88x18");
    const dyedBack = (await parseEmmx(await writeEmmx(withPage(parsed.doc, dyed)))).doc.pages[0];
    eq("重开读回同一个字色", referencedChar(dyedBack.shapes["104"].text)?.color, "#e91e63");
    eq(
      "画布也按它画，不再用底色推出来的那个",
      styleFor(dyedBack, dyedBack.shapes["104"]).font.color,
      "#e91e63"
    );

    // ③ 字体族
    const faced = setTopicFont(base, "104", { family: "宋体" });
    const f104 = blockOf(shapeBlocks(await savedXml(withPage(parsed.doc, faced))), "104");
    eq("字体族写在 Character@Family 上", attrOf(f104, "Character", "Family"), "宋体");
    eq("改字体族也不重测文字盒", textBoxWH(f104), "88x18");
    const facedBack = (await parseEmmx(await writeEmmx(withPage(parsed.doc, faced)))).doc.pages[0];
    eq("重开读回同一个字族", referencedChar(facedBack.shapes["104"].text)?.family, "宋体");

    // ④ 两个家存不同值时的裁决：节点级 `style.font` 在推导链上排得更外层，
    //    旧写法（只改它）画布看得见、存盘带不走；这一笔必须把它清掉，否则用户刚点的值被旧值压住。
    const stale = updateStyle(base, "104", { font: { size: 20 } });
    eq("旧写法的节点级值确实会盖住文件里那条", styleFor(stale, stale.shapes["104"]).font.size, 20);
    eq(
      "而它没有线上落点：盘上还是文件写的那条",
      attrOf(
        blockOf(shapeBlocks(await savedXml(withPage(parsed.doc, stale))), "104"),
        "Character",
        "Size"
      ),
      "12"
    );
    const fixed = setTopicFont(stale, "104", { size: 16 });
    eq("这一笔把节点级那个旧值清了", fixed.shapes["104"].style.font?.size, undefined);
    const fixedXml = await savedXml(withPage(parsed.doc, fixed));
    const fixed104 = blockOf(shapeBlocks(fixedXml), "104");
    eq("盘上写的是刚点的那个", attrOf(fixed104, "Character", "Size"), "16");
    const fixedBack = (await parseEmmx(await writeEmmx(withPage(parsed.doc, fixed)))).doc.pages[0];
    eq("重开也还是它（存盘带得走了）", styleFor(fixedBack, fixedBack.shapes["104"]).font.size, 16);

    // ⑤ 新建的主题：模型里什么都不声明（`makeText` 的种子是空样式），盘上必须按画布那套推导补齐，
    //    而不是写死 Verdana/12/#333333 —— 那三个常数和屏上画的层级字号不是一套，亿图打开就是两套。
    const kid = insertChild(base, "102", "新枝");
    const kidPage = normalize(kid.page);
    const kBlock = blockOf(shapeBlocks(await savedXml(withPage(parsed.doc, kidPage))), kid.id);
    const want = styleFor(kidPage, getShape(kidPage, kid.id)!);
    eq(
      "新主题的 Size 落的是画布推导的那个",
      attrOf(kBlock, "Character", "Size"),
      String(want.font.size)
    );
    eq("Family 同样跟主题走，不跟常数走", attrOf(kBlock, "Character", "Family"), want.font.family);
    eq("Color 也一样", attrOf(kBlock, "Character", "Color"), want.font.color);
    ok("新主题不落 Style：没点加粗就不发明记号", !/Character[^>]*Style=/.test(kBlock));
    const kidBack = (await parseEmmx(await writeEmmx(withPage(parsed.doc, kidPage)))).doc.pages[0];
    eq(
      "重开后盘上那个值就是画布那个值（不再有「写 12 画 10」这一说）",
      styleFor(kidBack, kidBack.shapes[kid.id]).font.size,
      want.font.size
    );
    eq("文字盒宽高也从同一个字号量起：4 + 2 字 ×(10+4)、1 段 ×10×1.75", textBoxWH(kBlock), "32x18");
    eq("新建那颗的形状盒按亿图的内缩补齐，不再是 0×0", boxWH(kBlock), "46x23.5");
  }

  // -------------------------------------------------- 文字盒中心锚：内缩从原节点反推，不是居中也不是 0（01 A-18）
  {
    const geom = textBoxGeom;
    const padOf = textBoxPad;

    // ① 什么都没改：原节点整颗带回，锚点连字节都不动（这是"不许把 51 洗成 0"的最直接的一条）。
    const bare = shapeBlocks(await savedXml(parsed.doc));
    eq("没编辑的那颗：文字盒锚点原样", padOf(geom(blockOf(bare, "102"))), "7.0/2.4");

    // ② 改标题：盒子变窄 36pt ⇒ 锚点只许随半边移动 18pt，内缩 7.0/2.4 必须原封不动。
    const rn = shapeBlocks(await savedXml(withPage(parsed.doc, updateText(base, "102", "改名了"))));
    const r102 = geom(blockOf(rn, "102"));
    eq("改标题重算了文字盒：4 + 3 字 ×16、1 段 ×12×1.75", `${r102.tw}x${r102.th}`, "52x21");
    eq("锚点按内缩反推：51+(52−88)/2、11.4+(21−18)/2", `${r102.cx}/${r102.cy}`, "33/12.9");
    eq("内缩一个点都没变", padOf(r102), "7.0/2.4");
    ok("不是写死 0（那是旧写手发明的）", r102.cx !== 0 && r102.cy !== 0);
    ok("也不是「形状盒中心」那个假设（120/2=60）", r102.cx !== 60);

    // ③ 改字号：同一条规则，锚点随半边移动；键级差分对纯值变更是盲的，所以按值钉。
    const up = shapeBlocks(
      await savedXml(withPage(parsed.doc, setTopicFont(base, "102", { size: 16 })))
    );
    const u102 = geom(blockOf(up, "102"));
    eq("改字号后的锚点：51+(64−88)/2、11.4+(28−18)/2", `${u102.cx}/${u102.cy}`, "39/16.4");
    eq("内缩还是那一份内缩", padOf(u102), "7.0/2.4");

    // ④ 我们旧写手洗成 0 的那些文件（夹具 105 就是这种）：按"没声明"处理，走形状盒中心，
    //    否则拿 0 反推会得到负内缩（把文字摁出形状盒），比原 bug 更糟。
    const zero = shapeBlocks(
      await savedXml(withPage(parsed.doc, updateText(base, "105", "乙改名")))
    );
    const z105 = geom(blockOf(zero, "105"));
    // 这一笔同时长大了形状盒（01 A-21）：原盒 100×24、原文字盒 88×18 ⇒ 内缩 12/6，
    // "乙改名"量出 52×21 ⇒ 新盒 64×27 ⇒ 兜底的"形状盒中心"是 32/13.5。
    eq("0/0 的锚 ⇒ 按形状盒中心（盒子这一笔也一起补大了）", `${z105.cx}/${z105.cy}`, "32/13.5");
    ok("绝不反推成负内缩", z105.cx > 0 && z105.cx < 64 && z105.cy > 0 && z105.cy < 27);

    // ⑤ 新建的主题：没有原节点 ⇒ 内缩只能按亿图自己新建形状那一档补（01 A-21），锚点再取其中心。
    const kid = insertChild(base, "102", "新枝");
    const kidPage = normalize(kid.page);
    const k102 = geom(blockOf(shapeBlocks(await savedXml(withPage(parsed.doc, kidPage))), kid.id));
    eq(
      "新建那颗：锚点 = 补齐后的形状盒中心（46×23.5 的一半）",
      `${k102.cx}/${k102.cy}`,
      "23/11.75"
    );
    ok("新建那颗不落 0", k102.cx !== 0 && k102.cy !== 0);

    // ⑥ 反推出来的锚点带尾数时按全篇统一的两位精度收口（夹具 104 的锚点故意写成 51.006/11.449）。
    //    不收口的话浮点尾数会一次比一次长地写进盘里，重开再存一次就多一位。
    const prec = shapeBlocks(
      await savedXml(withPage(parsed.doc, updateText(base, "104", "改名了")))
    );
    const p104 = geom(blockOf(prec, "104"));
    eq("51.006+(52−88)/2、11.449+(21−18)/2 ⇒ 两位精度", `${p104.cx}/${p104.cy}`, "33.01/12.95");
    ok("这一笔也没把锚点写回 0", p104.cx !== 0 && p104.cy !== 0);

    // ⑦ 只有锚、没有盒子尺寸的那种残缺节点（夹具 101）：反推不出内缩，整条按"没声明"处理，
    //    走形状盒中心 —— 拿半边项去补一个不存在的原宽度会得到 NaN，写进盘里就是坏文件。
    //    这一颗的形状盒也拿不到自己的内缩，于是按 MainIdea 的实测众数 39/30 补（01 A-21）：
    //    "改名了"量出 52×21 ⇒ 新盒 91×51 ⇒ 中心 45.5/25.5。
    const partial = shapeBlocks(
      await savedXml(withPage(parsed.doc, updateText(base, "101", "改名了")))
    );
    const q101 = geom(blockOf(partial, "101"));
    eq("缺 Width/Height ⇒ 按类型众数补盒子（91×51）后取中心", `${q101.cx}/${q101.cy}`, "45.5/25.5");
    ok("算不出内缩也不许写 NaN", Number.isFinite(q101.cx) && Number.isFinite(q101.cy));
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

// ================================================================ A2 层：我们旧版写下的那一份
// 亿图真语料里空缓存 0 颗，但我们旧版写下的每一份里每一颗都是空的（01 A-23）。
// 这一页里没有同型的现成轮廓可借 —— 治它只能按亿图自己的矩形写法补一段。
{
  const LEGACY_PAGE =
    PAGE_HEAD +
    `<Shape ID="101" Type="MainIdea">` +
    `<Transform><Width V="140"/><Height V="32"/><CX V="500" B="1" P="0"/><CY V="300" B="2" P="0"/></Transform>` +
    `<ShapeFormat><FillFormat/><LineFormat><LineWeight V="1"/></LineFormat></ShapeFormat>` +
    textBox("中心", { noWH: true }) +
    `<LevelData><SubLevel V="105"/></LevelData><Geometries/><ShapeStyle V="1"/></Shape>` +
    leaf("105", "101", "旧版的一颗") +
    `</Page>`;
  const bytes = await writeZip([
    { name: "document.xml", data: encodeText(DOC_XML) },
    { name: "page/page.xml", data: encodeText(LEGACY_PAGE) },
    { name: "rels/page_rels.xml", data: encodeText(`<Relationships/>`) },
  ]);
  const legacy = (await parseEmmx(bytes)).doc;
  const lp = legacy.pages[0];
  const legacyOrig = shapeBlocks(LEGACY_PAGE);
  const renamed = shapeBlocks(
    await savedXml(withPage(legacy, updateText(lp, "105", "旧版的一颗改长了")))
  );
  const h105 = blockOf(renamed, "105");
  const g = geoOf(h105);
  const [hw, hh] = boxWH(h105).split("x").map(Number);
  ok(
    `无轮廓可借 ⇒ 按矩形补出它自己放大后的形状盒（${hw}×${hh}）`,
    g.includes(`<X V="${hw}" P="1" B="1"/>`) && g.includes(`<Y V="${hh}" P="1" B="2"/>`),
    g
  );
  ok(
    "SubTopic 那一段带亿图的 NoLine 码，且是 MoveTo + 4 根 LineTo",
    /<Geometry Closed="1" NoLine="1">/.test(g) && (g.match(/<LineTo\b/g) ?? []).length === 4,
    g
  );
  eq("治好的那颗内缩守恒", insetOf(h105), insetOf(blockOf(legacyOrig, "105")));
  eq(
    "没被编辑的那一颗原样带回（空缓存只在真被改到时才治，不整篇重画）",
    blockOf(renamed, "101"),
    blockOf(legacyOrig, "101")
  );
}

// ================================================================ B 层：真亿图文件

/**
 * 路径缓存里的全部码。01 A-23 起它们**不再出现在任何一笔编辑的差分里** —— 亿图照这份路径画泡也画字，
 * 清一次就叫那一颗在亿图里彻底看不见，所以留着这几项做门闩：下面各条 allow 都不许包含它们，
 * 一旦哪天又有人把缓存清空，这几条码就会冒出来把测试挂掉（早先的口径是"盒子变了就作废"，真机上被推翻）。
 */
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
const FILL_KEYS = new Set(["Color", "Color@V", "FillFormat@Type"]);
const TOGGLER_KEYS = new Set(["Toggler", "Toggler@V"]);
/** 新增一颗主题的全部足迹 —— 只许是这颗自己的，别的一律不许动。
 *  含整段路径缓存：01 A-23 起新建的那颗必须带轮廓（借同型的现成一份，借不到按亿图的矩形补），
 *  留空缓存就是叫亿图画不出泡也画不出字。 */
const NEW_KEYS = new Set([
  ...GEOM_KEYS,
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
    // 01 A-23：改名会把文字盒与形状盒一起放大（A-21），但路径缓存一条码都不许多、也不许少 ——
    // 亿图照这份路径画泡也画字，贴边的点带 P="1" 会随新盒子缩放。旧口径"盒子变了就清空"在真机上是一颗空白泡。
    // allow 空集就是这一条的断言：键级差分里冒出任何一项都算写丢或写多。
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
    // 拖动只改 CX/CY 的值；键级差分应当为空（01 A-23：路径缓存跟着原样带回，不再被清空）。
    allow: new Set<string>(),
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
    `${f}｜改一个字只动正文、形状盒与路径缓存`,
    untouchedOf(blockOf(blocksAfter, editedId)),
    untouchedOf(blockOf(blocksBefore, editedId))
  );
  // 01 A-21 的真文件口径：形状盒始终包住文字盒，而且内缩跟着这一颗自己走 —— 改名前后必须同值。
  ok(
    `${f}｜改名后文字盒仍不溢出形状盒（亿图 1328 颗里溢出 0 次）`,
    Number(boxWH(blockOf(blocksAfter, editedId)).split("x")[0]) >=
      textBoxGeom(blockOf(blocksAfter, editedId)).tw,
    `${boxWH(blockOf(blocksBefore, editedId))} → ${boxWH(blockOf(blocksAfter, editedId))}`
  );
  eq(
    `${f}｜改名后形状盒与文字盒的内缩守恒`,
    insetOf(blockOf(blocksAfter, editedId)),
    insetOf(blockOf(blocksBefore, editedId))
  );

  // 值级第一刀的补充（01 A-18）：正文一动，文字盒就要重建，锚点（`<Text><Transform><CX/CY>`）
  // 以前被写死成 0 —— 亿图 10 份样张 1344 个文字盒里一个 0 都没有。锚点按值比，键级点名器看不见。
  {
    const g0 = textBoxGeom(blockOf(blocksBefore, editedId));
    const g1 = textBoxGeom(blockOf(blocksAfter, editedId));
    ok(
      `${f}｜样张自己的锚点非 0（亿图从不写 0）`,
      g0.cx !== 0 && g0.cy !== 0 && Number.isFinite(g0.cx),
      JSON.stringify(g0)
    );
    ok(
      `${f}｜改名重建后的锚点不再是 0`,
      g1.cx !== 0 && g1.cy !== 0,
      `${JSON.stringify(g0)} → ${JSON.stringify(g1)}`
    );
    eq(`${f}｜改名后文字盒内缩不变（锚点只随半边移动）`, textBoxPad(g1), textBoxPad(g0));
  }

  // 值级第二刀（01 A-17）：改字号。census 只数出现次数，Size 从原值变到 16 它是盲的，
  // 所以这里必须逐颗比字节，再按亿图自己的落点（Character@Size）断言值本身。
  {
    const target = anyTopic(original.pages[0], (x) => usedCharIx(x.text).length === 1);
    if (!target) {
      skip(`${f}｜改一个主题的字号`, "这份样张里没有只引用一条文字样式的主题");
    } else {
      const sized = setTopicFont(original.pages[0], target.id, { size: 16 });
      const xml = await savedXml(withPage(original, sized));
      // 基线取"同一套写手、这一笔什么都没改"的输出，而不是样张原文：比的是这一笔动了什么。
      const bareXml = await savedXml(original);
      const after = shapeBlocks(xml);
      eq(
        `${f}｜改字号不许打乱 Shape 的排列`,
        [...after.keys()].join(","),
        [...blocksBefore.keys()].join(",")
      );
      const bad: string[] = [];
      for (const [k, v] of blocksBefore) {
        if (k.endsWith(`:${target.id}`)) continue;
        if (after.get(k) !== v) bad.push(k);
      }
      eq(`${f}｜改字号：没编辑的那些 Shape 逐颗字节一致`, bad.join(","), "");
      const blk = blockOf(after, target.id);
      ok(
        `${f}｜改字号落在被引用的那条 Character 上`,
        /<Character[^>]*Size="16"/.test(blk),
        blk.slice(0, 240)
      );
      {
        // 盒子换尺寸时锚点必须跟着半边移动，内缩那份不许变（01 A-18）。
        const g0 = textBoxGeom(blockOf(blocksBefore, target.id));
        const g1 = textBoxGeom(blk);
        eq(`${f}｜改字号后文字盒内缩不变`, textBoxPad(g1), textBoxPad(g0));
        ok(`${f}｜改字号后锚点非 0`, g1.cx !== 0 && g1.cy !== 0, JSON.stringify(g1));
      }
      eq(
        `${f}｜改字号只动正文、形状盒与路径缓存`,
        untouchedOf(blk),
        untouchedOf(blockOf(blocksBefore, target.id))
      );
      eq(
        `${f}｜改字号后形状盒与文字盒的内缩守恒`,
        insetOf(blk),
        insetOf(blockOf(blocksBefore, target.id))
      );
      // 01 A-23：改字号同样会把盒子放大，但路径缓存原样带回 ⇒ 整页键级差分为空（"零条码"= 只改了值）。
      // 早先这里要先把 GEOM_KEYS 滤掉，因为那时改一次字号就连着一段轮廓一起写丢。
      eq(
        `${f}｜改字号的盘上足迹：零条码（只改了值，路径缓存一段都没少）`,
        keyDelta(bareXml, xml),
        ""
      );
      const back = (await parseEmmx(await writeEmmx(withPage(original, sized)))).doc.pages[0];
      eq(`${f}｜重开读回 16`, referencedChar(back.shapes[target.id].text)?.size, 16);
      eq(`${f}｜画布也算出 16`, styleFor(back, back.shapes[target.id]).font.size, 16);
    }
  }

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

// ================================================================ 未编辑往返的逐字节口径（01 A-19 行尾 / A-25 正文 `>`）

/** 这份文件里的部件按哪种行尾落。单行部件读不出倾向，所以判"整档一条"要看别的部件说话（实测亿图从不跨部件混用）。 */
const eolOf = (t: string): string =>
  t.includes("\r\n") ? "CRLF" : t.includes("\n") ? "LF" : "单行";
const partOf = async (bytes: Uint8Array, re: RegExp): Promise<string> => {
  const e = (await readZip(bytes)).find((x) => re.test(norm(x.name)));
  if (!e) throw new Error(`包里没有 ${re.source} 这个条目`);
  return decodeBytes(e.data);
};
const crlfx = (t: string): string => t.replace(/\n/g, "\r\n");

{
  // detectEol 的三条判据 + serializeXml 的 eol 参数（含结尾那一个）。
  eq("detectEol：含 \\r\\n 就判 CRLF", detectEol("a\r\nb\nc"), "\r\n");
  eq("detectEol：纯 LF 判 LF", detectEol("a\nb"), "\n");
  eq("detectEol：整块没换行时不硬判", detectEol("abc"), "\n");
  const shapeNode = parseXml('<A><B V="1"/></A>');
  eq(
    "serializeXml 的 eol 同时管连接与结尾",
    serializeXml(shapeNode, "  ", "\r\n"),
    '<?xml version="1.0" encoding="utf-8"?>\r\n<A>\r\n  <B V="1"/>\r\n</A>\r\n'
  );
  eq(
    "不传 eol 时仍是 LF（新建文档那条路）",
    serializeXml(shapeNode, "  "),
    '<?xml version="1.0" encoding="utf-8"?>\n<A>\n  <B V="1"/>\n</A>\n'
  );
}

{
  // 亿图的部件全是 CRLF。旧写法无条件用 "\n" 拼接，于是"打开一次再存"就把整份文件的行尾洗掉，
  // 前面所有"没动的东西一字节都不差"的验收因此只能在去空白之后比（compact/decoded 那套规范化就是为此存在的）。
  // theme.xml 走的是"缓存原节点"那条路（不经过任何 build*），rels 是现造的，
  // 这两类都必须显式接整档行尾 —— 少接一个，那份部件就在 CRLF 的文件里落成 LF。
  const crlfZip = await writeZip([
    { name: "document.xml", data: encodeText(crlfx(DOC_XML)) },
    { name: "theme.xml", data: encodeText(crlfx(`<Theme><Fill><c FColor="1;0"/></Fill></Theme>`)) },
    { name: "page/page.xml", data: encodeText(PAGE_XML) },
    { name: "rels/page_rels.xml", data: encodeText(crlfx(`<Relationships/>`)) },
  ]);
  const saved = await writeEmmx((await parseEmmx(crlfZip)).doc);
  eq("CRLF 的文件保存后还是 CRLF", eolOf(await partOf(saved, /document\.xml$/i)), "CRLF");
  // page.xml 原文是挤在一行的（单行部件自己判不出行尾），落盘必须跟着整档的约定走；
  // rels 那份是保存时现造的、根本没有源节点，同样只能靠整档这一条。
  eq("单行的 page.xml 跟着整档落", eolOf(await partOf(saved, /page\/page\.xml$/i)), "CRLF");
  eq("照搬的 theme.xml 跟着整档落", eolOf(await partOf(saved, /theme\.xml$/i)), "CRLF");
  eq("现造的 rels 也跟着整档落", eolOf(await partOf(saved, /page_rels\.xml$/i)), "CRLF");

  const lfZip = await writeZip([
    { name: "document.xml", data: encodeText(DOC_XML) },
    { name: "theme.xml", data: encodeText(`<Theme><Fill><c FColor="1;0"/></Fill></Theme>`) },
    { name: "page/page.xml", data: encodeText(PAGE_XML) },
  ]);
  const savedLf = await writeEmmx((await parseEmmx(lfZip)).doc);
  eq("LF 的文件保存后还是 LF", eolOf(await partOf(savedLf, /document\.xml$/i)), "LF");
  eq("page.xml 继承整档：这里该是 LF", eolOf(await partOf(savedLf, /page\/page\.xml$/i)), "LF");
  eq("theme.xml 继承整档：这里该是 LF", eolOf(await partOf(savedLf, /theme\.xml$/i)), "LF");

  // 新建的文档根本没有部件可读，那条路必须还是 LF —— 别让"沿用原文"顺手改掉无源可依的默认值。
  eq(
    "新建文档没有源可循，按 LF 落",
    eolOf(await partOf(await writeEmmx(createDocument()), /document\.xml$/i)),
    "LF"
  );
}

{
  // 正文里的 `>` 亿图裸写：121 份真文件里 `&gt;` 出现 0 次，而含裸 `>` 的正文有 40 处。
  // 旧序列化无条件转义，于是用户敲的一个箭头每次保存都被换成实体 —— 行尾修好之后，
  // 逐字节比对第一次把这一处暴露出来（同一颗主题：`--->` 变成 `--&gt;`）。
  const bytes = await writeZip([
    { name: "document.xml", data: encodeText(DOC_XML) },
    { name: "page/page.xml", data: encodeText(PAGE_XML) },
    { name: "rels/page_rels.xml", data: encodeText(`<Relationships/>`) },
  ]);
  const { doc } = await parseEmmx(bytes);
  const page = doc.pages[0];
  const arrowed = withPage(doc, updateText(page, "102", "甲>乙"));
  const xml = await savedXml(arrowed);
  ok(
    "正文里的 > 不再被改成实体",
    xml.includes('<tp CX="0">甲>乙</tp>') && !xml.includes("&gt;"),
    xml.slice(0, 200)
  );
  const backArrow = (await parseEmmx(await writeEmmx(arrowed))).doc;
  eq("含 > 的正文重开还是原样", plainText(backArrow.pages[0].shapes["102"].text), "甲>乙");

  // 唯一必须转义的是 `]]>`：那是字符数据的结束符，裸写会让节点在中间被截断。
  const bracket = withPage(doc, updateText(page, "102", "甲]]>乙"));
  const bracketXml = await savedXml(bracket);
  ok(
    "]]> 仍然转义（否则字符数据提前结束）",
    bracketXml.includes("甲]]&gt;乙"),
    bracketXml.slice(0, 200)
  );
  const backBracket = (await parseEmmx(await writeEmmx(bracket))).doc;
  eq("含 ]]> 的正文重开还是原样", plainText(backBracket.pages[0].shapes["102"].text), "甲]]>乙");
}

const REAL_PARTS = /(^|\/)(document\.xml|theme\.xml|page\/page\.xml)$/i;

for (const f of REAL_FILES) {
  const path = join(FOLD_DIR, f);
  if (!existsSync(path)) {
    skip(`${f}｜未编辑往返每个部件逐字节一致`, "真亿图样张不在仓库里（_research/extract/fold/）");
    continue;
  }
  const bytes = new Uint8Array(readFileSync(path));
  const out = await writeEmmx((await parseEmmx(bytes)).doc);
  const before = await readZip(bytes);
  const after = await readZip(out);
  const bad: string[] = [];
  let seen = 0;
  for (const e of before) {
    if (!REAL_PARTS.test(norm(e.name))) continue;
    seen += 1;
    const a = after.find((x) => norm(x.name) === norm(e.name));
    if (!a) {
      bad.push(`${e.name}：整条没了`);
      continue;
    }
    if (decodeBytes(a.data) !== decodeBytes(e.data)) bad.push(e.name);
  }
  // 这一条是 A-19/A-25 的终点：那两处（行尾、正文 > ）任何一个复发，这里立刻不是一字节。
  // 先钉"可比部件真的有三个"，免得整条断言在空集合上恒真（01 A-20 那条口径）。
  eq(`${f}｜这份样张该有三个可比部件`, seen, 3);
  ok(`${f}｜什么都不改，存盘的每个部件逐字节一致（原文全 CRLF）`, bad.length === 0, bad.join(","));
  // rels 不进上面这条：亿图写 `<Relationship Target Id>`、我们写 `<Relationship Id Target>`，
  // 属性顺序早先已定为非复刻目标（11 份 39178 个点普查）。这里只钉"条目一条不少、值一个不改"。
  const relsOf = async (b: Uint8Array): Promise<string> => {
    const t = await partOf(b, /page_rels\.xml$/i).catch(() => "");
    return [...t.matchAll(/<Relationship\b[^>]*\/>/g)]
      .map((m) =>
        [...m[0].matchAll(/="([^"]*)"/g)]
          .map((q) => q[1])
          .sort()
          .join("=")
      )
      .sort()
      .join("|");
  };
  eq(`${f}｜rels 条目与值原样带走（属性顺序不比）`, await relsOf(out), await relsOf(bytes));
}

done();
