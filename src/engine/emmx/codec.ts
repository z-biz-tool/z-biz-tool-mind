/**
 * .emmx ⇄ DocumentModel。
 *
 * 关键取舍（为什么不是"全字段映射"）：
 * 亿图的一个 Shape 里挂着大量**派生数据** —— Geometries 是布局算完写回的缓存路径、
 * Text/Transform 是文本框实测尺寸、MMConnector 是连线缓存。P-2 说得很清楚：
 * 布局是算出来的，不是存出来的。所以复刻里这些字段**不参与语义**，
 * 但为了让用户用亿图打开我们保存的文件时看不出差别，未改动的节点必须**原样回写**。
 *
 * 做法：解析时把每个子节点的原始 XmlNode 与它的"语义指纹"一起存进 rawUnknown；
 * 保存时先逐个 Shape 比指纹 —— 指纹没变就写回原始节点；变过了也只**一颗子节点一颗子节点**地比，
 * 没动的那几颗继续带回原节点（01 A-12：整颗重建会把我们没建模的 ToSuper、Geometries 缓存、
 * 第二个 Paragraph、ShapeFormat@QuickMask、CX@B 一并抹掉）。
 * 于是得到一条可测的保证：`write(parse(x))` 与 `x` 结构等价，
 * 而任何编辑都只落到"真的被模型改过的那一颗子节点"上。
 */
import type {
  ColorValue,
  DocProperties,
  DocumentModel,
  FillFormat,
  FontSpec,
  GanttOption,
  Page,
  RelationshipShape,
  RichText,
  Shape,
  ShapeStyle,
  ShapeType,
  TaskData,
  TextParagraph,
} from "../../types/model.ts";
import { makeText, plainText, referencedChar } from "../../types/model.ts";
import { DEFAULTS } from "../../model/constants.ts";
import { LAYOUT_CODE_TO_NAME } from "../../types/model.ts";
import { createPage, newGanttOption } from "../../model/factory.ts";
import { readZip, writeZip, encodeText, decodeBytes, type ZipEntry } from "./zip.ts";
import {
  attr,
  detectEol,
  el,
  findAll,
  find,
  numAttr,
  numVnode,
  parseXml,
  serializeXml,
  valueOrText,
  vnode,
  vNode,
  type XmlEol,
  type XmlNode,
} from "./xparse.ts";
// 回写要按"画布怎么推导这一颗"补齐未声明的样式（01 A-17），所以这里必须用同一套推导，
// 而不是另配一组常数。style.ts / theme.ts 都不反向依赖 codec，没有循环。
import { defaultPalette, styleFor, type ThemePalette } from "../style.ts";
import { textWidth } from "../layout.ts";
import { cloneNode, paletteForDoc } from "./theme.ts";

const PAGE_XML = "page/page.xml";
const DOC_XML = "document.xml";
const THEME_XML = "theme.xml";
const RELS_XML = "rels/page_rels.xml";

/** 亿图给新画布的默认标签名。它的 page.xml 里不落这个字段，解析时按它补。 */
const DEFAULT_PAGE_NAME = "画布1";

function freshPageAttrs(page: Page): Record<string, string> {
  return {
    Type: "Page",
    QuickMask: "0",
    ID: page.id,
    Name: page.name,
    Zoom: round(page.props.zoom),
  };
}

/** 一个 Page 里所有需要"原样回写"的东西。 */
interface RawContainer {
  /** 子节点在源文件里的顺序，key 见 shapeKey / tagKey。 */
  order: string[];
  /** key → 原始节点。 */
  nodes: Record<string, XmlNode>;
  /** key → 语义指纹；写回时与当前模型再算一次比对。 */
  sig: Record<string, string>;
  /** Page 自身属性（ID/Type/Zoom/QuickMask…）。 */
  pageAttrs: Record<string, string>;
}

export interface ParseResult {
  doc: DocumentModel;
  warnings: string[];
}

export class EmmxError extends Error {}

// ---------------------------------------------------------------- 解析入口

export async function parseEmmx(bytes: Uint8Array): Promise<ParseResult> {
  const warnings: string[] = [];
  const entries = await readZip(bytes);
  const names = new Set(entries.map((e) => e.name.toLowerCase()));
  if (names.has("readme.txt") && !names.has(DOC_XML)) {
    throw new EmmxError("文件已加密，需要输入密码后才能打开");
  }
  const docEntry = pickEntry(entries, DOC_XML);
  if (!docEntry) throw new EmmxError("缺少 document.xml，这不是一个脑图文件");
  const pageEntries = entries
    .filter((e) => /^page\/[^/]+\.xml$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!pageEntries.length) {
    // 92 份官方样张里 87 份是亿图 V12 的云端/模板容器：页面内容在 mmpage/page.bin 那串自研
    // varint/TLV 流里，包里根本没有 page/*.xml（01 A-14）。不猜着解 —— 猜出来的 reader
    // 只会把"打不开"换成更坏的"打开了但内容是编的"。但这句话得让用户知道下一步做什么：
    // 实测用户自己在亿图里另存的文件走的是 XML 容器，所以"打开后另存一份"是真能走通的路。
    const v12 = entries.some((e) => /(^|\/)page\.bin$/i.test(e.name) || /\.bkiwi$/i.test(e.name));
    throw new EmmxError(
      v12
        ? "这份 .emmx 用的是亿图 V12 的二进制页面容器（page.bin），本程序只能打开 XML 容器的文件。请在亿图里打开它再「另存为」成 .emmx，或改用 XMind / Markdown 等格式走「导入」。"
        : "这份 .emmx 里没有可读的页面（page/ 是空的），文件可能是空包或被截断了。请换一份，或在亿图里重新另存一份 .emmx。"
    );
  }

  const docText = decodeBytes(docEntry.data);
  const docRoot = parseXml(docText);
  // 行尾要跟着原文落（01 A-19）：整档判一条，判据见 xparse.detectEol 的实测注释。
  const eolSeen: XmlEol[] = [detectEol(docText)];
  const media: Record<string, Uint8Array> = {};
  for (const e of entries) if (/^media\//i.test(e.name)) media[e.name] = e.data;
  // 亿图在包里另存一张 thumbnail.jpeg 给"打开"对话框做预览：它不属于任何 Shape，
  // 但按名字带回原字节，总比整条 entry 消失好。
  const thumb = entries.find((e) => /^thumbnail\.\w+$/i.test(e.name));
  if (thumb) media[thumb.name] = thumb.data;
  // 空的 <Relationships/> 亿图也照样写一条；"有没有这个文件"和"里面有没有条目"是两件事。
  const theme = pageThemeRoot(entries);
  eolSeen.push(theme.eol);
  // 空的 <Relationships/> 亿图也照样写一条；"有没有这个文件"和"里面有没有条目"是两件事。
  const relsPresent = entries.some((e) => /^rels\/page_rels\.xml$/i.test(e.name));

  const rels = parseRels(entries);
  eolSeen.push(rels.eol);
  const pages: Page[] = [];
  for (const pe of pageEntries) {
    const pageText = decodeBytes(pe.data);
    eolSeen.push(detectEol(pageText));
    pages.push(parsePage(pe.name, pageText, rels.map, warnings));
  }

  const propsNode = find(docRoot, "Properties");
  const ganttNode = find(docRoot, "GanttOption");
  const props = parseProperties(docRoot, propsNode, warnings);
  const gantt = parseGantt(ganttNode);
  const markSheet = findAll(find(docRoot, "MarkSheet") ?? el("MarkSheet"), "Mark").map((m) => ({
    name: attr(m, "Name"),
    label: attr(m, "Label", attr(m, "Name")),
    group: attr(m, "Group"),
  }));

  const raw: Record<string, unknown> = {
    documentRoot: docRoot,
    documentSig: sigOfDocument(props, gantt, pages.length),
    themeRoot: theme.root,
    // 存盘要沿用的行尾：任一部件用 CRLF 就整档按 CRLF 落（01 A-19）。
    docEol: eolSeen.includes("\r\n") ? "\r\n" : "\n",
    // 原 rels 清单：原样回写的 Shape 不会经过 buildShape，它们的 rId 只能靠这份表恢复。
    relEntries: rels.list,
    relsPresent,
    // Properties / GanttOption 的源顺序与源值：亿图在这里放的字段比我们能改的多
    //（ShowGroupName、ModifyPlatform、ChangeMinor…），未知的必须原样带回。
    propsSection: sectionRaw(propsNode),
    ganttSection: sectionRaw(ganttNode),
  };

  return {
    doc: {
      properties: props,
      pages,
      activePageId: pages[0].id,
      gantt,
      markSheet,
      media,
      rawUnknown: raw,
    },
    warnings,
  };
}

function pickEntry(entries: ZipEntry[], want: string): ZipEntry | undefined {
  return entries.find((e) => e.name.replace(/\\/g, "/").toLowerCase() === want.toLowerCase());
}

function pageThemeRoot(entries: ZipEntry[]): { root?: XmlNode; eol: XmlEol } {
  const hit = entries.find((e) => /^theme\.xml$/i.test(e.name));
  if (!hit) return { eol: "\n" };
  const text = decodeBytes(hit.data);
  try {
    return { root: parseXml(text), eol: detectEol(text) };
  } catch {
    return { eol: detectEol(text) };
  }
}

function parseRels(entries: ZipEntry[]): {
  map: Record<string, string>;
  list: { id: string; target: string }[];
  eol: XmlEol;
} {
  const map: Record<string, string> = {};
  const list: { id: string; target: string }[] = [];
  let eol: XmlEol = "\n";
  for (const e of entries) {
    if (!/^rels\/.*\.xml$/i.test(e.name)) continue;
    const text = decodeBytes(e.data);
    if (detectEol(text) === "\r\n") eol = "\r\n";
    let root: XmlNode;
    try {
      root = parseXml(text);
    } catch {
      continue;
    }
    for (const r of findAll(root, "Relationship")) {
      const target = attr(r, "Target")
        .replace(/^\.\.\//, "")
        .replace(/^\.\//, "");
      const id = attr(r, "Id");
      if (!(id in map)) list.push({ id, target });
      map[id] = target;
    }
  }
  return { map, list, eol };
}

// ---------------------------------------------------------------- document.xml

/** `<Properties>`/`<GanttOption>` 的源快照：亿图写的字段比我们能改的多，未知的要原样带回原位。 */
interface SectionRaw {
  order: string[];
  values: Record<string, string>;
}

function sectionRaw(node: XmlNode | undefined): SectionRaw {
  const order: string[] = [];
  const values: Record<string, string> = {};
  for (const c of node?.children ?? []) {
    if (order.includes(c.tag)) continue;
    order.push(c.tag);
    values[c.tag] = valueOrText(c);
  }
  return { order, values };
}

function parseProperties(
  docRoot: XmlNode,
  node: XmlNode | undefined,
  warnings: string[]
): DocProperties {
  // 实测 5 份语料 + 亿图模板：Version 与 DocGuid 挂在 <Document> 身上，不在 <Properties> 里。
  const head = docRoot.attrs ?? {};
  if (!node) {
    warnings.push("document.xml 没有 Properties，按默认值补齐");
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    return {
      version: head.Version || DEFAULTS.emmxVersion,
      docGuid: head.DocGuid ?? "",
      creator: "",
      modifier: "",
      createdDate: now,
      modifiedDate: now,
      platform: "win",
      dpi: 1,
      screenWidth: 1920,
      screenHeight: 1080,
      autoLayout: true,
      timelineWidth: 1000,
      calloutLayout: 1,
    };
  }
  const a = node.attrs;
  const pick = (...keys: string[]): string => {
    for (const k of keys) if (a[k] !== undefined) return a[k];
    const child = keys.map((k) => find(node, k)).find(Boolean);
    return child ? valueOrText(child) : "";
  };
  return {
    version: head.Version || pick("Version", "version") || DEFAULTS.emmxVersion,
    docGuid: head.DocGuid || pick("DocID", "DocGuid", "ID"),
    creator: pick("Creator", "CreateUser"),
    modifier: pick("Modifier", "LastSavedUser", "SaveUser"),
    createdDate: pick("CreatedData", "CreatedDate", "CreateTime"),
    modifiedDate: pick("ModifiedData", "ModifiedDate", "SaveTime"),
    platform: pick("Platform", "Application") === "Mac" ? "mac" : "win",
    dpi: Number(pick("Dpi", "DPI", "DotPerInch")) || 1,
    screenWidth: Number(pick("ScreenWidth")) || 1920,
    screenHeight: Number(pick("ScreenHeight")) || 1080,
    autoLayout: pick("AutoLayout", "LayoutMemory") !== "0",
    timelineWidth: Number(pick("TimelineWidth")) || 1000,
    calloutLayout: Number(pick("CalloutLayout")) || 1,
  };
}

function parseGantt(node: XmlNode | undefined): GanttOption {
  const g = newGanttOption();
  if (!node) return g;
  const read = (tag: string, dflt: number): number => {
    const v = vnode(node, tag) ?? find(node, tag)?.attrs.V ?? undefined;
    const n = Number(v);
    return v !== undefined && Number.isFinite(n) ? n : dflt;
  };
  const work = vnode(node, "WorkDay");
  return {
    workDay: work ? work.split(";").map((x) => Number(x) || 0) : g.workDay,
    majorTick: read("MajorTick", g.majorTick),
    minorTick: read("MinorTick", g.minorTick),
    startDate: read("StartDate", g.startDate),
    finishDate: read("FinishDate", g.finishDate),
    startTime: read("StartTime", g.startTime),
    finishTime: read("FinishTime", g.finishTime),
    unitWidth: read("UnitWidth", g.unitWidth),
  };
}

// ---------------------------------------------------------------- page.xml

function parsePage(
  entryName: string,
  src: string,
  rels: Record<string, string>,
  warnings: string[]
): Page {
  const root = parseXml(src);
  if (root.tag !== "Page") throw new EmmxError(`${entryName} 的根节点不是 Page`);
  const id = attr(root, "ID") || attr(root, "Id");
  const layoutNode = find(root, "Layout");
  const propsNode = find(root, "PageProps");
  const printNode = find(root, "PrintSetup");
  const themeNode = find(root, "Theme");
  const fillNode = find(root, "FillFormat");

  const base = createPage(attr(root, "Name") || DEFAULT_PAGE_NAME);
  const raw: RawContainer = { order: [], nodes: {}, sig: {}, pageAttrs: { ...root.attrs } };

  const shapes: Record<string, Shape> = {};
  const relationships: RelationshipShape[] = [];
  for (const child of root.children) {
    if (child.tag === "Shape") {
      const type = attr(child, "Type");
      const sid = attr(child, "ID");
      if (type === "MMConnector") {
        // 布局缓存：不进模型，只原样保留（P-2）。
        keep(raw, shapeKey(sid, type), child, "cache");
        continue;
      }
      if (type === "RelatConnector") {
        // 端点的真键是 `<ConnectMap From="起" To="止"/>`（01 A-24：54 份真文件里 20 颗关系线，20/20 都带它）。
        // `<BeginPt>/<EndPt>` 上挂的只是 X/Y 坐标属性，既没有 ID 也没有子节点 —— 旧读法从那里取，
        // 拿到的永远是空串：导入的连线在模型里两端全空，画布画不出、toggleRelationship 也认不出重复。
        // To/From 各对应哪一头是量出来的：EndPt 恰好落在 To 那颗的泡边上（3 份文档 3/3 距离 0.0，
        // ThemeBase 夹具里 BeginPt 落在 From 的泡边上同样是 0.0），箭头就是指着 To 的那一头。
        // `ID=` 那种形式只有我们旧版写过，留着当回退，旧文件才还能连得上。
        const ends = relEndpoints(child);
        const rel: RelationshipShape = {
          id: sid,
          beginId: ends.beginId,
          endId: ends.endId,
          text: parseRichText(find(child, "Text")),
          style: parseShapeStyle(child),
        };
        relationships.push(rel);
        keep(raw, shapeKey(sid, type), child, sigOfRelationship(rel));
        continue;
      }
      const shape = parseShape(child, rels, warnings);
      shapes[shape.id] = shape;
      keep(raw, shapeKey(shape.id, type), child, sigOfShape(shape));
      continue;
    }
    const key = tagKey(child.tag, raw.order.length);
    keep(raw, key, child, "page");
  }

  // 发号水位要统计所有 Shape，包括被当成缓存丢掉的 MMConnector。
  let maxShapeId = 0;
  for (const child of root.children) {
    if (child.tag !== "Shape") continue;
    const n = Number(attr(child, "ID"));
    if (Number.isFinite(n) && n > maxShapeId) maxShapeId = n;
  }

  const page: Page = {
    id,
    name: attr(root, "Name") || base.name,
    rootId: pickRoot(shapes),
    shapes,
    relationships,
    layout: {
      code: layoutCodeOf(layoutNode),
      rawCode: rawLayoutCode(layoutNode),
      hSpacing: numVnode(layoutNode, "HSpacing", DEFAULTS.hSpacing),
      vSpacing: numVnode(layoutNode, "VSpacing", DEFAULTS.vSpacing),
      levelLength: splitNumbers(vnode(layoutNode, "LevelLength", "")),
      branchCount: splitNumbers(vnode(layoutNode, "BranchCount", "")),
      rainbow: vnode(layoutNode, "Rainbow", attr(layoutNode ?? el("Layout"), "Rainbow")) === "1",
    },
    props: {
      width: numVnode(propsNode, "Width", base.props.width),
      height: numVnode(propsNode, "Height", base.props.height),
      scrollX: numVnode(propsNode, "ScrollX", base.props.scrollX),
      scrollY: numVnode(propsNode, "ScrollY", base.props.scrollY),
      zoom: Number(root.attrs.Zoom ?? 1) || 1,
      background: fillNode ? parseFill(fillNode) : undefined,
    },
    print: parsePrint(printNode, base.print),
    theme: parseThemeRef(themeNode, base.theme),
    maxShapeId: maxShapeId || undefined,
    rawUnknown: raw as unknown as Record<string, unknown>,
  };
  raw.sig[PAGE_SIG] = sigOfPage(page);
  return page;
}

function pickRoot(shapes: Record<string, Shape>): string {
  const main = Object.values(shapes).find((s) => s.type === "MainIdea");
  if (main) return main.id;
  const orphan = Object.values(shapes).find((s) => !s.parentId);
  return orphan?.id ?? Object.keys(shapes)[0] ?? "";
}

function layoutCodeOf(layoutNode: XmlNode | undefined): Page["layout"]["code"] {
  const n = numVnode(layoutNode, "Layout", 0);
  return LAYOUT_CODE_TO_NAME[n] ?? "balanced";
}

/**
 * <Layout V> 的原样数字码，缺节点当"没有"。
 * 亿图自己的文件里出现过 6 / 7 / 8 三种，我们只认 6 和 8 —— 认不出的码必须带回去，
 * 否则"打开再保存"会把别人文件里的 7 悄悄改成 6，那是改坏用户的文档而不是 round-trip。
 */
function rawLayoutCode(layoutNode: XmlNode | undefined): number | undefined {
  return numVnode(layoutNode, "Layout", 0) || undefined;
}

function splitNumbers(s: string | undefined): number[] {
  if (!s) return [];
  return s
    .split(";")
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x));
}

function keep(raw: RawContainer, key: string, node: XmlNode, sig: string): void {
  if (!(key in raw.nodes)) raw.order.push(key);
  raw.nodes[key] = node;
  raw.sig[key] = sig;
}

/** 页面级语义签名存放的 key，不会和 `#Type:ID` / `Tag@i` 撞上。 */
const PAGE_SIG = "__page__";

/** 页面级可由模型重新生成的标签；其余标签一律原样回写。 */
const PAGE_TAGS = new Set(["PageProps", "Layout", "FillFormat", "PrintSetup", "Theme"]);

function shapeKey(id: string, type: string): string {
  return `#${type}:${id}`;
}

/**
 * 与 shapeKey 严格配对的反解析。
 * 注意 `#` 是紧跟 Type 的前缀而不是独立的一段：`"#MainIdea:101".split(":")` 只有两项，
 * 直接按下标取 [1]/[2] 会把 Type 当成 ID，于是所有 Shape 都被当成"已删除"而不回写。
 */
function splitShapeKey(key: string): { type: string; id: string } {
  const body = key.slice(1);
  const ix = body.indexOf(":");
  return ix < 0 ? { type: body, id: "" } : { type: body.slice(0, ix), id: body.slice(ix + 1) };
}

function tagKey(tag: string, seen: number): string {
  return `${tag}@${seen}`;
}

function parseShape(n: XmlNode, rels: Record<string, string>, warnings: string[]): Shape {
  const type = (attr(n, "Type", "SubTopic") || "SubTopic") as ShapeType;
  const id = attr(n, "ID");
  const ld = find(n, "LevelData");
  const sub = vnode(ld, "SubLevel", "");
  const childIds = sub ? sub.split(";").filter(Boolean) : [];
  const superId = vnode(ld, "Super", "");
  const t = find(n, "Transform");
  const style = parseShapeStyle(n);
  const extras: Shape["extras"] = {};

  const note = vnode(find(n, "Comment"), "Text") ?? vnode(find(n, "Note"), "V");
  if (note) extras.note = note;
  const link = find(n, "HyperLink") ?? find(n, "Hyperlink");
  if (link) {
    const address = vnode(link, "Address") ?? attr(link, "Address");
    if (address)
      extras.hyperlink = { kind: /^https?:/i.test(address) ? "web" : "file", target: address };
  }
  const attach = find(n, "Attachments");
  if (attach) {
    extras.attachments = findAll(attach, "Attachment").map((a) => {
      const relId = attr(a, "Res");
      const path = rels[relId] ?? "";
      if (!path) warnings.push(`主题 ${id} 的附件 ${relId} 在 rels 里找不到目标`);
      return { relId, name: attr(a, "Name", path.split("/").pop() ?? relId), size: 0 };
    });
  }
  const labels = vnode(find(n, "Labels"), "V");
  if (labels) extras.labels = labels.split(";").filter(Boolean);
  const layoutNode = find(n, "Layout");
  // 折叠的真落点。早先这里读的是 LayoutDirection=="0"，那是认错键：亿图自己写的五份用户图里
  // LayoutDirection=0 有三分之一挂在叶子主题上（软件质量 36/72、测试基础 13/28、系统测试 9/14），
  // 而叶子不可能被折叠；真键 Toggler 值域只有 "1"、不写即未折叠，且系统测试那 22 个全都长在有子主题上，
  // 与 LayoutDirection 互斥。LayoutDirection 仍归 LayoutDirection，交给 carryUntouched 原样带回。
  if (vnode(layoutNode, "Toggler", "") === "1") extras.collapsed = true;
  // 分支自由布局的位移（§3.3）。这一对读作 [dx,dy]；长度不够就当成"没拖过"，
  // 不猜半个值 —— 脏数据在这里的正确答案是回到引擎位置，而不是把分支挪到原点。
  const branchOffset = splitNumbers(attr(find(n, "BranchOffset"), "V", ""));
  // 外框/概要与标注框都是"分号分隔的 id 列表写在 V 上"：找错属性这两个字段就永远是空的。
  const covered = vnode(find(n, "BoundaryData"), "Shapes", "");
  if (covered) extras.covered = covered.split(";").filter(Boolean);
  const callouts = attr(find(n, "Callout"), "V", "");
  if (callouts) extras.calloutIds = callouts.split(";").filter(Boolean);
  // 任务信息（看板/甘特共用，§3.5）。亿图的 .emmx 里没有这个概念，TaskInfo 是我们自造的节点
  // （同 BranchOffset 的先例：参考软件读不懂只会忽略）——没有它，用户排好的期存盘就丢。
  const taskNode = find(n, "TaskInfo");
  if (taskNode) {
    const numA = (a: string): number | undefined => {
      const raw = attr(taskNode, a, "");
      if (raw === "") return undefined;
      const v = Number(raw);
      return Number.isFinite(v) ? v : undefined;
    };
    const listA = (a: string): string[] | undefined => {
      const raw = attr(taskNode, a, "");
      if (!raw) return undefined;
      const arr = raw.split(";").filter(Boolean);
      return arr.length ? arr : undefined;
    };
    extras.task = {
      assignees: listA("Assignees") ?? [],
      progress: numA("Progress") ?? 0,
      priority: (attr(taskNode, "Priority", "medium") || "medium") as TaskData["priority"],
      status: (attr(taskNode, "Status", "todo") || "todo") as TaskData["status"],
      tags: listA("Tags") ?? [],
      start: numA("Start"),
      finish: numA("Finish"),
      duration: numA("Duration"),
      milestone: attr(taskNode, "Milestone", "") === "1" || undefined,
      deps: listA("Deps"),
    };
  }

  return {
    id,
    type,
    parentId: superId || null,
    childIds,
    text: parseRichText(find(n, "Text")),
    transform: {
      x: numVnode(t, "CX", 0),
      y: numVnode(t, "CY", 0),
      w: numVnode(t, "Width", 0),
      h: numVnode(t, "Height", 0),
    },
    style,
    extras,
    floating: type === "Floating" || Boolean(vnode(layoutNode, "FreePostion", "")),
    offset:
      branchOffset.length === 2 && (branchOffset[0] || branchOffset[1])
        ? { x: branchOffset[0], y: branchOffset[1] }
        : undefined,
  };
}

function parseShapeStyle(n: XmlNode): ShapeStyle {
  const out: ShapeStyle = {};
  const sf = find(n, "ShapeFormat") ?? find(n, "ShapeStyle");
  if (sf) {
    const fill = find(sf, "FillFormat");
    if (fill) out.fill = parseFill(fill);
    const line = find(sf, "LineFormat");
    if (line) out.line = parseLine(line);
  }
  const color = out.fill?.color;
  if (color) {
    if (color.shade !== undefined) out.mask = (out.mask ?? 0) | 1;
    if (color.tint !== undefined) out.mask = (out.mask ?? 0) | 2;
    if (color.themeColor !== undefined) out.colorRef = color.themeColor;
  }
  // 实测亿图在 </Geometries> 之后、每个 Shape 上都写 <StyleMask V>（doc1..5 共 1167 个形状，
  // 取值只有 1/2/3）。上面自己按 Shade/Tint 数出来的只是推导线索，文件里写了就以它为准。
  const styleMask = numVnode(n, "StyleMask", 0);
  if (styleMask > 0) out.mask = styleMask;
  return out;
}

function parseColor(n: XmlNode | undefined): ColorValue | undefined {
  if (!n) return undefined;
  const v = n.attrs.V ?? n.attrs.Color;
  if (!v) return undefined;
  const c: ColorValue = { v };
  if (n.attrs.Shade !== undefined) c.shade = Number(n.attrs.Shade);
  if (n.attrs.Tint !== undefined) c.tint = Number(n.attrs.Tint);
  if (n.attrs.Ref !== undefined) c.ref = n.attrs.Ref;
  if (n.attrs.ThemeColor !== undefined) c.themeColor = Number(n.attrs.ThemeColor);
  return c;
}

function parseFill(n: XmlNode): FillFormat {
  const type = (attr(n, "Type", "None") as FillFormat["type"]) || "None";
  const grad = find(n, "GradFill") ?? find(n, "Gradient");
  if (grad) {
    return {
      type: "Gradient",
      angle: numVnode(grad, "Angle", 0),
      stops: findAll(grad, "Stop").map((s) => ({
        pos: numAttr(s, "Pos", numAttr(s, "Angle", 0)),
        color: parseColor(s) ?? { v: "#000000" },
      })),
    };
  }
  return { type, color: parseColor(find(n, "Color")) };
}

function parseLine(n: XmlNode): ShapeStyle["line"] {
  const cap = vnode(n, "LineCap", "Flat");
  const lineFill = find(n, "LineFill");
  return {
    weight: numVnode(n, "LineWeight", numAttr(n, "Weight", DEFAULTS.lineWeight)),
    rounding: numVnode(n, "Rounding", DEFAULTS.rounding),
    cap: cap === "Round" || cap === "Square" ? cap : "Flat",
    style: attr(n, "LineStyle", "Solid") === "Dashes" ? "Dashes" : "Solid",
    fill: lineFill ? parseFill(lineFill) : undefined,
    beginArrow: numVnode(n, "BeginArrow", 0),
    endArrow: numVnode(n, "EndArrow", 0),
  };
}

function parsePrint(n: XmlNode | undefined, dflt: Page["print"]): Page["print"] {
  if (!n) return dflt;
  const paper = find(n, "PaperSize") ?? n;
  return {
    ...dflt,
    unit: (vnode(paper, "Unit", dflt.unit) as Page["print"]["unit"]) || dflt.unit,
    paperW: numVnode(paper, "Width", dflt.paperW),
    paperH: numVnode(paper, "Height", dflt.paperH),
    marginTop: numVnode(n, "TopMargin", dflt.marginTop),
    marginRight: numVnode(n, "RightMargin", dflt.marginRight),
    marginBottom: numVnode(n, "BottomMargin", dflt.marginBottom),
    marginLeft: numVnode(n, "LeftMargin", dflt.marginLeft),
    fitToSheet: vnode(n, "FitToSheet", dflt.fitToSheet ? "1" : "0") === "1",
    printBackground: vnode(n, "PrintBackground", dflt.printBackground ? "1" : "0") === "1",
  };
}

function parseThemeRef(n: XmlNode | undefined, dflt: Page["theme"]): Page["theme"] {
  if (!n) return dflt;
  const findId = (tag: string): number => {
    const hit = find(n, tag);
    if (!hit) return -1;
    return numAttr(hit, "ID", numVnode(hit, "ID", -1));
  };
  const color = findId("ThemeColor");
  const effect = findId("ThemeEffect");
  const text = findId("ThemeText");
  const shape = findId("ThemeShape");
  return {
    ...dflt,
    id: numAttr(n, "ID", dflt.id),
    name: attr(n, "Name", dflt.name),
    colorId: color > 0 ? color : dflt.colorId,
    effectId: effect > 0 ? effect : dflt.effectId,
    textId: text > 0 ? text : dflt.textId,
    shapeId: shape > 0 ? shape : dflt.shapeId,
    rainbow: attr(n, "Rainbow", dflt.rainbow ? "1" : "0") === "1",
  };
}

// ---------------------------------------------------------------- 富文本

function parseRichText(textNode: XmlNode | undefined): RichText {
  const tb = textNode ? find(textNode, "TextBlock") : undefined;
  if (!tb) return makeText("");
  const characters = findAll(tb, "Character").map(parseCharacter);
  const paraNodes = findAll(tb, "Paragraph");
  const inner = find(tb, "Text");
  const ppNodes = inner ? findAll(inner, "pp") : [];
  const paragraphs: TextParagraph[] = ppNodes.map((pp, i) => {
    const p = paraNodes[Math.min(i, paraNodes.length - 1)];
    const runs = findAll(pp, "tp").map((tp) => ({
      text: valueOrText(tp),
      charIx: numAttr(tp, "CX", 0),
    }));
    const out: TextParagraph = { runs: runs.length ? runs : [{ text: "", charIx: 0 }] };
    if (p) {
      const a = numAttr(p, "Align", 1);
      out.align = (a === 0 || a === 2 ? a : 1) as 0 | 1 | 2;
      if (p.attrs.IndFirst !== undefined) out.indentFirst = numAttr(p, "IndFirst", 0);
    } else out.align = 1;
    return out;
  });
  return {
    paragraphs: paragraphs.length ? paragraphs : [{ runs: [{ text: "", charIx: 0 }], align: 1 }],
    // 一条 Character 都没有时留一个空样式：什么都不声明。
    // 补成 DEFAULTS 的那套会让显示层以为"文件说了 12/微软雅黑"，把主题推导顶掉。
    characters: characters.length ? characters : [{}],
  };
}

/**
 * `Character@Style` 是按位标志：实测 1 = 加粗（中心主题），2 = 斜体，4 = 下划线。
 *
 * 亿图写了哪个属性，模型里才有那一项 —— 缺位不能读成"用户要默认值"。
 * 这一条是 01 A-17 的根：把没写的 `Size` 补成 12、`Color` 补成 #333333，显示层就分不清
 * "文件说的 12"和"我们自己种的 12"，换主题/新主题的字号也就没了推导的余地。
 * （实测被 run 引用的 827 条 Character 里 Family/Size/Color 出现率都是 100%，所以原样带回不变：
 * 缺位的只有我们新建的主题那一种。）
 */
function parseCharacter(n: XmlNode): FontSpec {
  const f: FontSpec = {};
  if (n.attrs.Family !== undefined) f.family = n.attrs.Family;
  if (n.attrs.Size !== undefined) f.size = numAttr(n, "Size", DEFAULTS.fontSize);
  if (n.attrs.Color !== undefined) f.color = attr(n, "Color", DEFAULTS.textColor);
  const style = numAttr(n, "Style", 0);
  if (n.attrs.Style !== undefined) {
    f.bold = (style & 1) !== 0;
    if (style & 2) f.italic = true;
    if (style & 4) f.underline = true;
  }
  return f;
}

function characterStyle(f: FontSpec): number {
  return (f.bold ? 1 : 0) | (f.italic ? 2 : 0) | (f.underline ? 4 : 0);
}

/**
 * 重建出来的节点只带建模过的属性；亿图写在同一颗上的其余属性一律跟着走。
 * modeled 是"模型会管这些键"的名单，即使本次没落笔也不许从原节点带回来 ——
 * 否则用户刚取消的加粗会被原样复活。modeled 之外的键模型压根不知道存在，带回才是无损。
 */
function adoptAttrs(built: XmlNode, raw: XmlNode | undefined, modeled: string[]): void {
  if (!raw) return;
  const skip = new Set([...modeled, ...Object.keys(built.attrs)]);
  for (const [k, v] of Object.entries(raw.attrs)) if (!skip.has(k)) built.attrs[k] = v;
}

/**
 * 这一颗在画布上按哪一档字族/字号/字色画：`styleFor` 的推导结果（主题 + 层级 + 独立配色）。
 * 只拿来补"文件里没声明"的那几项 —— 声明过的照原值写回，否则用户在亿图里调好的字号会被我们换掉。
 */
function fontHint(ctx: WriteCtx, s: Shape): FontSpec | undefined {
  if (!ctx.page) return undefined;
  const f = styleFor(ctx.page, s, ctx.palette ?? defaultPalette()).font;
  return { family: f.family, size: f.size, color: f.color };
}

function buildTextNode(
  rt: RichText,
  src?: XmlNode,
  hint?: FontSpec,
  box?: { w: number; h: number },
  /** 文字盒落盘的宽高。样式位改动时沿用原盒，别让盒子跟着我们的尺重量一遍（01 A-21）。 */
  dims?: { w: number; h: number }
): XmlNode {
  const rawTb = src ? find(src, "TextBlock") : undefined;
  const rawByIx = (tag: string): Map<string, XmlNode> => {
    const m = new Map<string, XmlNode>();
    if (rawTb) for (const c of findAll(rawTb, tag)) m.set(c.attrs.IX ?? "", c);
    return m;
  };
  const rawChars = rawByIx("Character");
  const rawParas = rawByIx("Paragraph");
  const tb = el("TextBlock", {
    // 掩码表达"哪些文本项算独立覆盖主题"，我们完全不建模：原节点写过就跟着走，
    // 只有新建的主题才用亿图主题节点上实测到的那个常数。
    TextFormatMask: rawTb?.attrs.TextFormatMask ?? "10224",
  });
  // 文字盒的底色和高度按**被引用的那一条**算（`characters[0]` 可能压根没被引用）。
  // 用户在界面上改字号写的也是这一条 —— 盘上的宽高和画布上的盒子从同一个字号出发（01 A-17）。
  // 没声明的那几项按画布同一套推导补齐：写死成 Verdana/12/#333333 的话，盘上写 12、屏上画 10，
  // 亿图一打开就看到两套；那三个常数也只在 hint 缺席（写手没拿到这一页）时兜底。
  const font = referencedChar(rt) ?? {};
  const size = fontSizeOf(rt, hint);
  const family = font.family ?? hint?.family ?? DEFAULTS.fontFamily;
  const color = font.color ?? hint?.color ?? DEFAULTS.textColor;
  tb.children.push(el("Color", { V: withAlpha(color) }));
  rt.characters.forEach((c, ix) => {
    const style = characterStyle(c);
    const ch = el("Character", {
      // Style 是按位标志，没加粗/斜体/下划线时亿图根本不写这个属性（实测），我们也就不写。
      Style: style || undefined,
      Family: c.family ?? family,
      IX: ix,
      Size: c.size ?? size,
      Color: (c.color ?? color).replace(/^#ff(?=[0-9a-f]{6}$)/i, "#"),
    });
    // 文字背景色之类我们读不到也写不出的键，改字号/改名时不该跟着蒸发。
    adoptAttrs(ch, rawChars.get(String(ix)), ["Style", "Family", "IX", "Size", "Color"]);
    tb.children.push(ch);
  });
  rt.paragraphs.forEach((p, ix) => {
    const para = el("Paragraph", {
      SpLine: "100",
      Align: p.align ?? 1,
      IX: ix,
      IndFirst: p.indentFirst,
    });
    adoptAttrs(para, rawParas.get(String(ix)), ["SpLine", "Align", "IX", "IndFirst"]);
    tb.children.push(para);
  });
  const inner = el("Text");
  rt.paragraphs.forEach((p) => {
    const pp = el("pp", { CX: "0", PX: "1" });
    p.runs.forEach((r) =>
      pp.children.push({ tag: "tp", attrs: { CX: String(r.charIx) }, children: [], text: r.text })
    );
    inner.children.push(pp);
  });
  tb.children.push(inner);
  const { w: tw, h: th } = dims ?? textBoxSize(rt, hint);
  const rawXf = src ? find(src, "Transform") : undefined;
  const a = textAnchors(rawXf, tw, th, box);
  return el("Text", {}, [
    el("Transform", {}, [
      vNode("Width", tw),
      vNode("Height", th),
      attachP(vNode("CX", round(a.cx)), "1"),
      attachP(vNode("CY", round(a.cy)), "2"),
    ]),
    tb,
  ]);
}

/**
 * 文字盒的中心锚（01 A-18）。亿图给每一颗带文字盒的形状都写了 CX/CY（10 份 XML 容器样张、1344 个文字盒，
 * 全非 0、一根 0 都没有），那个值是"文字盒在形状盒里的内缩 + 自身半边"。实测内缩不对称也不居中：
 * 二级主题多为 7.0/8.3，中心主题 19.3，标注框 10.3~13.3，连线标签 −38.5（文字盒比形状盒还宽）。
 * 所以"中心 = 形状盒中心"这个假设站不住，只能从原节点反推内缩量再套新盒子 ——
 * 盒子尺寸没变时算回原值（逐字节一致），改名/改字号时内缩照旧、中心只随半边移动。
 *
 * 那个 0 是我们旧写手发明的（写死在 CX/CY 上），照它反推会得到负内缩（把文字摁到左上角外），
 * 所以"两根轴都是 0"按没声明处理，走形状盒中心 —— 亿图自己新建的主题实测左右内缩相等（empty.emmx 25.9/26.3）。
 * 原节点压根没有锚的只有我们新建的形状，同一条路。
 */
function textAnchors(
  rawXf: XmlNode | undefined,
  tw: number,
  th: number,
  box?: { w: number; h: number }
): { cx: number; cy: number } {
  const rawCx = rawXf ? numVnode(rawXf, "CX", NaN) : NaN;
  const rawCy = rawXf ? numVnode(rawXf, "CY", NaN) : NaN;
  const rawTw = rawXf ? numVnode(rawXf, "Width", NaN) : NaN;
  const rawTh = rawXf ? numVnode(rawXf, "Height", NaN) : NaN;
  const declared =
    [rawCx, rawCy, rawTw, rawTh].every((n) => Number.isFinite(n)) && !(rawCx === 0 && rawCy === 0);
  if (declared) return { cx: rawCx + (tw - rawTw) / 2, cy: rawCy + (th - rawTh) / 2 };
  // 形状盒还没算出来（w=0，合成夹具里新建的那颗就是）时退成"内缩 0"，
  // 免得把中心压回 0 —— 那正是这条要修掉的那个值。
  return {
    cx: (box && box.w > 0 ? box.w : tw) / 2,
    cy: (box && box.h > 0 ? box.h : th) / 2,
  };
}

/**
 * 亿图给每一型新建形状写的 (形状盒 − 文字盒) 总内缩，01 A-21。
 * 取值是众数：用户图 8 份 + 亿图自己写盘的 `config/{empty,ThemeBase}.emmx` 里 1343 颗双盒形状，
 * 形状宽 − 文字宽 = SubTopic 14.00（1050 颗）/ MainTopic 35.00（34 颗）/ Callout 27.00（31 颗）/
 * MainIdea 39.00（8 颗）/ Floating 35.00、SummaryTopic 11.00（各 1 颗，来自亿图新建的那份模板）；
 * 高 = 5.50 / 16.00 / 16.00 / 30.00 / 16.00 / 10.00。
 * Boundary 与 Summary 在语料里根本没有文字盒（1273 颗无 `<Text>`），所以不进这张表 —— 没有观察就不猜。
 */
const SHAPE_INSET: Partial<Record<ShapeType, { w: number; h: number }>> = {
  MainIdea: { w: 39, h: 30 },
  MainTopic: { w: 35, h: 16 },
  SubTopic: { w: 14, h: 5.5 },
  Floating: { w: 35, h: 16 },
  Callout: { w: 27, h: 16 },
  SummaryTopic: { w: 11, h: 10 },
};

/**
 * 这一颗的形状盒该写多大（01 A-21）。
 *
 * 亿图的不变量是"形状盒 = 文字盒 + 一层按型内缩"：8 份 XML 容器样张的 1328 颗双盒形状里，
 * 文字盒比形状盒还宽的出现 **0** 次。而模型里 `transform.w/h` 从导入后再没人写过（布局只写 x/y），
 * 于是改名/改字号时文字盒在长、形状盒不动 —— 亿图一打开就是字压出框外；我们新建的主题更是直接落 0×0。
 *
 * 内缩跟着**这一颗自己**的走（原形状盒 − 原文字盒）：`dims` 沿用原盒时算回原值，未编辑的字节照旧复用；
 * 拿不到这条内缩时才按类型的实测众数补（原盒 0×0 是我们旧版写下的，不满足上面那条不变量，
 * 不能当"内缩 0"用；原文件没写文字盒、或这颗是新建的，同理）。表里也没有的类型退回模型值 —— 没有观察就不猜。
 */
function shapeBoxOf(
  s: Shape,
  dims: { w: number; h: number },
  rawTransform: XmlNode | undefined,
  rawTw: number,
  rawTh: number
): { w: number; h: number } {
  const rawW = rawTransform ? numVnode(rawTransform, "Width", NaN) : NaN;
  const rawH = rawTransform ? numVnode(rawTransform, "Height", NaN) : NaN;
  const d = SHAPE_INSET[s.type];
  const axis = (
    rawBox: number,
    rawT: number,
    text: number,
    doc: number | undefined,
    model: number
  ): number => {
    const inset = rawBox >= rawT ? rawBox - rawT : doc;
    if (inset === undefined) return Number.isFinite(rawBox) ? rawBox : model;
    return text + inset;
  };
  return {
    w: axis(rawW, rawTw, dims.w, d?.w, s.transform.w),
    h: axis(rawH, rawTh, dims.h, d?.h, s.transform.h),
  };
}

/**
 * 文字盒的宽高按亿图自己的盘上口径来（01 A-17 的影响面实测，三份样张 505 个带文字盒的顶层 Shape）。
 * 宽 = 4 + Σ 字符宽度，且字符宽度按 size+4 取（亿图给每个字多留 4pt 前进量）：这样对 ±2pt 命中 240/505、
 * 中位残差 3pt。旧的 `0.62×字数×字号` 系统性写窄（平均偏 +59.7pt、命中 0/505），亿图打开我们改名或改字号的
 * 那一颗就看到盒子比字短。行高 = size×1.75：实测每行高 9→16、10→18、12→20、13→22，比值 1.67–1.80 不是一条
 * 直线（它来自主题档位而不是纯比例），取 505 个盒子的均值 1.736 再朝上，宁可略高也不叫亿图裁行。
 * 字符宽度用的是画布那套 `textWidth`，两处同一个尺。
 */
const TEXT_ADVANCE_PAD = 4;
const TEXT_LINE_H = 1.75;

function measureTextWidth(rt: RichText, size: number): number {
  let widest = 0;
  for (const line of plainText(rt).split("\n"))
    widest = Math.max(widest, textWidth(line, size + TEXT_ADVANCE_PAD));
  return Math.min(DEFAULTS.topicMaxTextW, Math.max(size, widest + TEXT_ADVANCE_PAD));
}

/** 这一颗的文字按哪一号写：被引用的那条声明优先，没声明才用画布那套推导（01 A-17）。 */
function fontSizeOf(rt: RichText, hint?: FontSpec): number {
  return referencedChar(rt)?.size ?? hint?.size ?? DEFAULTS.fontSize;
}

/** 文字盒的宽高（盘上 `<Text><Transform>` 那两把尺）。写形状盒时要同一个数，别再量第二遍。 */
function textBoxSize(rt: RichText, hint?: FontSpec): { w: number; h: number } {
  const size = fontSizeOf(rt, hint);
  return {
    w: Math.max(1, Math.round(measureTextWidth(rt, size))),
    h: Math.max(1, Math.round(rt.paragraphs.length * size * TEXT_LINE_H)),
  };
}

/**
 * 亿图写这两个标记的**顺序**在它自己手里就不统一：11 份真语料 39178 个 `<CX>/<CY>/<X>/<Y>` 里
 * V→P→B 最常见（X/Y 各 5698、CX/CY 各 1629），B→P→V（5012/1320）和 P→B→V（4494/1250）也各有几千，
 * V→B→P 只占 140+46。既然它自己写四种、读我们那一份也照样认（真机反复验过值级生效），顺序不是复刻目标，
 * 我们只保证全篇用同一种 —— 早先记的"亿图 660/660 都是 V→B→P"是数错了，这条按上面这遍普查改口。
 */
function attachP(n: XmlNode, b: string): XmlNode {
  n.attrs.P = "0";
  n.attrs.B = b;
  return n;
}

function withAlpha(hex: string): string {
  const h = hex.replace("#", "");
  if (h.length === 6) return `#ff${h}`;
  if (h.length === 3)
    return `#ff${h
      .split("")
      .map((c) => c + c)
      .join("")}`;
  return hex;
}

// ---------------------------------------------------------------- 语义指纹

function sigOfShape(s: Shape): string {
  return [
    s.type,
    s.parentId ?? "",
    s.childIds.join(";"),
    JSON.stringify(s.text),
    round(s.transform.x),
    round(s.transform.y),
    round(s.transform.w),
    round(s.transform.h),
    JSON.stringify(s.style),
    JSON.stringify(s.extras),
    s.floating ? "1" : "0",
    // 分支位移（§3.3）必须进指纹：拖一整枝只改这一个字段，漏了它就会被判"没动过"，
    // 于是原节点整份原样带回，用户拖开的枝第二次保存就悄悄回到引擎位置了。
    s.offset ? `${s.offset.x};${s.offset.y}` : "",
  ].join("\u0001");
}

function sigOfRelationship(r: RelationshipShape): string {
  return [r.id, r.beginId, r.endId, JSON.stringify(r.text), JSON.stringify(r.style)].join("\u0001");
}

function sigOfPage(p: Page): string {
  return [
    p.name,
    p.rootId,
    p.layout.code,
    p.layout.hSpacing,
    p.layout.vSpacing,
    p.layout.rainbow ? 1 : 0,
    JSON.stringify(p.layout.levelLength),
    JSON.stringify(p.layout.branchCount),
    round(p.props.width),
    round(p.props.height),
    round(p.props.zoom),
    JSON.stringify(p.props.background),
    JSON.stringify(p.theme),
    JSON.stringify(p.print),
  ].join("\u0001");
}

function sigOfDocument(d: DocProperties, g: GanttOption, pages: number): string {
  return JSON.stringify([d, g, pages]);
}

function round(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function rawOf(page: Page): RawContainer {
  return page.rawUnknown as unknown as RawContainer;
}

// ---------------------------------------------------------------- 序列化

export async function writeEmmx(doc: DocumentModel): Promise<Uint8Array> {
  const entries: ZipEntry[] = [];
  const seeded = (doc.rawUnknown?.relEntries as { id: string; target: string }[] | undefined) ?? [];
  const ctx: WriteCtx = { rels: seeded.map((r) => ({ ...r })), media: doc.media };
  // 行尾跟着原文走（01 A-19）：亿图的部件全是 CRLF，我们旧版无条件用 "\n"，
  // 于是一份没动过的文件保存一次就多出一万次行尾改动——"最小编辑不动别处"因此只在语义层成立。
  // 新建的文档没有源可读，按 "\n" 落。
  const eol = (doc.rawUnknown?.docEol as XmlEol | undefined) ?? "\n";
  const docRoot = buildDocumentXml(doc);
  entries.push({ name: DOC_XML, data: encodeText(serializeXml(docRoot, "    ", eol)) });

  doc.pages.forEach((page, ix) => {
    ctx.page = page;
    ctx.palette = paletteForDoc(doc, page);
    entries.push({
      name: pageEntryName(ix),
      data: encodeText(serializeXml(buildPageXml(page, ctx), "    ", eol)),
    });
  });

  const themeRaw = doc.rawUnknown?.themeRoot as XmlNode | undefined;
  if (themeRaw)
    entries.push({ name: THEME_XML, data: encodeText(serializeXml(themeRaw, "    ", eol)) });
  const relsPresent = Boolean(doc.rawUnknown?.relsPresent);
  if (ctx.rels.length || relsPresent) {
    const r = el("Relationships");
    for (const x of ctx.rels)
      r.children.push(el("Relationship", { Id: x.id, Target: `../${x.target}` }));
    entries.push({ name: RELS_XML, data: encodeText(serializeXml(r, "    ", eol)) });
  }
  for (const [name, data] of Object.entries(doc.media)) entries.push({ name, data });

  return writeZip(entries, { compress: true, modifiedAt: new Date() });
}

interface WriteCtx {
  rels: { id: string; target: string }[];
  media: Record<string, Uint8Array>;
  /**
   * 正在写的这一页 + 这一页的色板（`writeEmmx` 逐页换着填）。
   * 回写一颗 Shape 时，文件里没声明的那几项样式要按画布同一套推导补齐 ——
   * 否则盘上写的是 12、屏上画的是 10，亿图一打开就看出两套（01 A-17）。
   */
  page?: Page;
  palette?: ThemePalette;
  /** 这一页里每种形状型的第一份现成路径缓存，给新建的那颗借轮廓用（01 A-23，见 geoPool）。 */
  geoPool?: Map<string, XmlNode>;
}

/**
 * 亿图新建文件时 Properties/GanttOption 的实际书写顺序（语料 doc1 就是它在本机新建的文件）。
 * 只有"源里不存在这个字段"时才按这里的顺序补，避免给老文件凭空加项。
 */
const DOC_PROP_ORDER = [
  "AutoLayout",
  "TimelineWidth",
  "CalloutLayout",
  "Dpi",
  "ScreenWidth",
  "ScreenHeight",
  "Platform",
  "ModifyPlatform",
  "Creator",
  "CreatedDate",
  "ModifiedDate",
  "Modifier",
];
const GANTT_ORDER = [
  "WorkDay",
  "MajorTick",
  "MinorTick",
  "StartDate",
  "FinishDate",
  "StartTime",
  "FinishTime",
  "UnitWidth",
  "ChangeMinor",
];

/**
 * 按"源顺序 + 模型新值"重建 `<X><Y V="…"/></X>` 这一节。
 * 模型改得了的字段用模型值，改不了的（ShowGroupName、ModifyPlatform、亿图新版本加的项）
 * 原样带回；源里没有的字段才按默认顺序补上。
 */
function buildSection(
  tag: string,
  raw: SectionRaw | undefined,
  owned: Map<string, string>,
  dfltOrder: string[]
): XmlNode {
  const order = raw?.order.length ? raw.order : dfltOrder;
  const children: XmlNode[] = [];
  for (const name of order) {
    const v = owned.get(name) ?? raw?.values[name];
    if (v !== undefined) children.push(vNode(name, v));
  }
  for (const [name, v] of owned) {
    if (order.includes(name) || v === "") continue;
    children.push(vNode(name, v));
  }
  return el(tag, {}, children);
}

function propsOwned(d: DocProperties): Map<string, string> {
  const m = new Map<string, string>();
  m.set("AutoLayout", d.autoLayout ? "1" : "0");
  m.set("TimelineWidth", String(d.timelineWidth));
  m.set("CalloutLayout", String(d.calloutLayout));
  m.set("Dpi", String(d.dpi));
  m.set("ScreenWidth", String(d.screenWidth));
  m.set("ScreenHeight", String(d.screenHeight));
  m.set("Creator", d.creator);
  m.set("CreatedDate", d.createdDate);
  m.set("ModifiedDate", d.modifiedDate);
  m.set("Modifier", d.modifier);
  return m;
}

function ganttOwned(g: GanttOption): Map<string, string> {
  const m = new Map<string, string>();
  m.set("WorkDay", g.workDay.join(";"));
  m.set("MajorTick", String(g.majorTick));
  m.set("MinorTick", String(g.minorTick));
  m.set("StartDate", String(g.startDate));
  m.set("FinishDate", String(g.finishDate));
  m.set("StartTime", String(g.startTime));
  m.set("FinishTime", String(g.finishTime));
  m.set("UnitWidth", String(g.unitWidth));
  return m;
}

function buildDocumentXml(doc: DocumentModel): XmlNode {
  const raw = doc.rawUnknown as
    | {
        documentRoot?: XmlNode;
        documentSig?: string;
        propsSection?: SectionRaw;
        ganttSection?: SectionRaw;
      }
    | undefined;
  const want = sigOfDocument(doc.properties, doc.gantt, doc.pages.length);
  if (raw?.documentRoot && raw.documentSig === want) return raw.documentRoot;

  // Version / DocGuid 属于 <Document> 本身；Platform 只在"源里没有"时按当前平台补，
  // 有源值时上面已经原样带回。
  const root = el("Document", { Version: doc.properties.version, DocGuid: doc.properties.docGuid });
  const owned = propsOwned(doc.properties);
  if (!raw?.propsSection) {
    owned.set("Platform", doc.properties.platform);
    owned.set("ModifyPlatform", doc.properties.platform);
  }
  root.children.push(buildSection("Properties", raw?.propsSection, owned, DOC_PROP_ORDER));
  root.children.push(
    buildSection("GanttOption", raw?.ganttSection, ganttOwned(doc.gantt), GANTT_ORDER)
  );
  const ms = el("MarkSheet");
  for (const m of doc.markSheet)
    ms.children.push(el("Mark", { Name: m.name, Label: m.label, Group: m.group }));
  root.children.push(ms);
  return root;
}

function buildPageXml(page: Page, ctx: WriteCtx): XmlNode {
  const raw = page.rawUnknown ? rawOf(page) : undefined;
  // 新建那颗主题要借的现成轮廓池（01 A-23），一页一份：亿图的形状是逐页存的，借隔壁页的同型轮廓
  // 等于把另一套色板/主题的圆角写进这一页。
  ctx.geoPool = raw ? geoPool(raw) : undefined;
  // 实测亿图的 <Page> 只有 Type/QuickMask/Zoom/ID，页面名不落在 page.xml 里。
  // 已有文件必须守住这个属性集（多写一个 Name 就是给亿图制造无法理解的字段）；
  // 只有我们新建的页面才需要把名字写进去，否则重开丢了标签名。
  const attrs: Record<string, string> = raw
    ? { ...raw.pageAttrs, ID: page.id, Zoom: round(page.props.zoom) }
    : freshPageAttrs(page);
  // 用户真的改过标签名才补 Name：亿图自己的文件里 <Page> 没有 Name，
  // 默认名 "画布1" 是解析时补的，照写出去就破坏了原文件结构。
  if (raw && attrs.Name === undefined && page.name !== DEFAULT_PAGE_NAME) attrs.Name = page.name;
  const root = el("Page", attrs);
  const pageChanged = !raw || raw.sig[PAGE_SIG] !== sigOfPage(page);

  const regen: Record<string, () => XmlNode> = {
    PageProps: () => buildPageProps(page),
    Layout: () => buildLayout(page),
    FillFormat: () =>
      page.props.background ? buildFill(page.props.background) : el("FillFormat", { Type: "None" }),
    PrintSetup: () => buildPrint(page.print),
    Theme: () => buildTheme(page.theme),
  };

  const emitted = new Set<string>();
  // 已有文件：按原始子节点顺序回写，未改动的 Shape 用原节点（见文件头的取舍）。
  // 新建页面：没有 raw，走下面的 defaultOrder。
  const order = raw ? raw.order : defaultOrder(page);
  // 已经在上面的循环里回写过的"模型形状 id"。判据要跟着 Type 一起看：
  // MMConnector / RelatConnector 这两类原始键也带 id，把它们算进来会把新增形状误判成"已回写"
  //（亿图里连线和主题共用一个号段，实测 系统测试.emmx 的 #MMConnector:529 就压住了新发的 529 号）。
  const emittedIds = new Set<string>();
  for (const key of order) {
    if (key.startsWith("#")) {
      const { type, id } = splitShapeKey(key);
      if (!raw) {
        const fresh = page.shapes[id];
        const built = fresh ? buildShape(fresh, ctx) : undefined;
        if (built) {
          root.children.push(built);
          emitted.add(key);
          emittedIds.add(id);
        }
        continue;
      }
      const rebuilt = rebuildShape(key, page, ctx, raw);
      if (rebuilt) {
        root.children.push(rebuilt);
        emitted.add(key);
        if (type !== "MMConnector" && type !== "RelatConnector") emittedIds.add(id);
      }
      continue;
    }
    const node = raw?.nodes[key];
    if (!node) continue;
    if (pageChanged && PAGE_TAGS.has(node.tag)) {
      if (!emitted.has(node.tag)) {
        root.children.push(regen[node.tag]());
        emitted.add(node.tag);
      }
      continue;
    }
    root.children.push(node);
    emitted.add(node.tag);
  }
  if (pageChanged) {
    for (const [tag, make] of Object.entries(regen)) {
      if (!emitted.has(tag)) root.children.push(make());
    }
  }
  for (const rel of page.relationships) {
    const key = shapeKey(rel.id, "RelatConnector");
    if (!emitted.has(key)) {
      root.children.push(buildRelationship(rel, ctx));
      emitted.add(key);
    }
  }
  // 模型里新长出来的形状（在导入的图上加枝/加自由主题）不在 raw.order 里，
  // 只按原顺序回写就会静默丢掉那一颗 —— 而父亲的 SubLevel 已经指向它，等于又丢数据又留悬空引用。
  // 补在页面末尾，走与新建页同一条构造路径（没有 raw 节点可复用）。
  for (const s of Object.values(page.shapes)) {
    if (emittedIds.has(s.id)) continue;
    const built = buildShape(s, ctx);
    if (built) {
      root.children.push(built);
      emittedIds.add(s.id);
    }
  }
  return root;
}

/** 新建页面的规范顺序：页面级标签在前，Shape 按 id 数值序在后。 */
function defaultOrder(page: Page): string[] {
  const ids = Object.keys(page.shapes).sort((a, b) => Number(a) - Number(b));
  return [...Array.from(PAGE_TAGS), ...ids.map((id) => shapeKey(id, page.shapes[id].type))];
}

/**
 * 这一页里"每一型形状的第一份非空路径缓存"（01 A-23）。
 *
 * 亿图自己新建的主题没有原始缓存可带回，而空缓存它读不懂 —— 实测那颗在亿图里既不画泡也不画字。
 * 同型形状的现成路径是最有出处的轮廓：边界点带 P="1"，会按借入的那颗新盒子自己缩放。
 * 这一页里借不到同型的才退回按型补矩形（RECT_NO_LINE），两样都没有观察的型才留空写法。
 * 连线（MMConnector / RelatConnector）的路径按两个端点算、且是 Closed="0" 的曲线，不是泡的轮廓，不进池。
 */
function geoPool(raw: RawContainer): Map<string, XmlNode> {
  const pool = new Map<string, XmlNode>();
  for (const key of raw.order) {
    if (!key.startsWith("#")) continue;
    const { type } = splitShapeKey(key);
    if (type === "MMConnector" || type === "RelatConnector") continue;
    if (pool.has(type)) continue;
    const node = raw.nodes[key];
    const geo = node ? find(node, "Geometries") : undefined;
    if (geo && geo.children.length) pool.set(type, geo);
  }
  return pool;
}

/**
 * 这一型主题的轮廓在亿图语料里就是盒子的四个角（01 A-23）。取值是"这一段带不带 NoLine"：
 * 真语料 1374 颗 SubTopic/MainTopic/MainIdea 的第一段 <Geometry> 全是
 * MoveTo(0,0) → (w,0) → (w,h) → (0,h) → 回起点，贴边的点写 P="1"、原点写 P="0"（B 恒为 X=1/Y=2）。
 * 属性形式按每型众数：SubTopic 带 NoLine（1294/1317；亿图两种顺序都写，`Closed` 在前是 810/484 的那一头），
 * MainTopic/MainIdea 只写 Closed。没有观察的型（Floating、Callout 的尾巴、Summary…）一律不发明。
 */
const RECT_NO_LINE: Partial<Record<ShapeType, boolean>> = {
  SubTopic: true,
  MainTopic: false,
  MainIdea: false,
};

function rectGeometries(type: ShapeType, w: number, h: number): XmlNode | undefined {
  const noLine = RECT_NO_LINE[type];
  if (noLine === undefined || !(w > 0) || !(h > 0)) return undefined;
  const pt = (tag: string, x: number, y: number): XmlNode =>
    el(tag, {}, [
      // 只取属性集合，不追属性顺序：亿图在同一批真文件里对 X/Y 混着写三种顺序
      // （B→P→V 2506 / P→B→V 2247 / V→P→B 859），它是按名字读的。
      // 值为 0 的那一根写 P="0"，贴盒子边的写 P="1"（随盒子缩放）。
      el("X", { V: round(x), P: x === 0 ? "0" : "1", B: "1" }),
      el("Y", { V: round(y), P: y === 0 ? "0" : "1", B: "2" }),
    ]);
  return el("Geometries", {}, [
    el("Geometry", noLine ? { Closed: "1", NoLine: "1" } : { Closed: "1" }, [
      pt("MoveTo", 0, 0),
      pt("LineTo", w, 0),
      pt("LineTo", w, h),
      pt("LineTo", 0, h),
      pt("LineTo", 0, 0),
    ]),
  ]);
}

/**
 * 这一颗该落盘的 `<Geometries>`（01 A-23）。
 *
 * - 原文件里是非空路径 ⇒ 原样带回。盒子改了、样式改了都不作废：亿图就是照这份路径画泡、画字的，
 *   而贴着边的点带 P="1"，会随新盒子缩放（真机对照实验：只把空缓存换回原路径、盒子仍是我们放大到 2.6 倍
 *   的那一颗，泡和字一起回来了）。
 * - 原文件里是空缓存（我们旧版写下的；亿图自己产出的文档里空缓存 0 颗 —— 3 份 MindMaster 自动备份
 *   1010 颗形状、10 份真文档 2636 颗形状，都是 0）或是根本没有 ⇒
 *   先借这一页同型形状的第一份现成轮廓，借不到就按亿图的矩形写法补一颗（见 RECT_NO_LINE），
 *   两条都没有观察时才维持原样 —— 已有的节点一颗都不许删，也没有的节点也不乱加。
 */
function geometryNode(
  type: ShapeType,
  ctx: WriteCtx,
  from: XmlNode | undefined,
  rawGeometries: XmlNode | undefined,
  box: { w: number; h: number }
): XmlNode | undefined {
  if (rawGeometries?.children.length) return rawGeometries;
  const donor = ctx.geoPool?.get(type);
  const healed = donor ? cloneNode(donor) : rectGeometries(type, box.w, box.h);
  return healed ?? (from ? rawGeometries : el("Geometries"));
}

function rebuildShape(
  key: string,
  page: Page,
  ctx: WriteCtx,
  raw: RawContainer
): XmlNode | undefined {
  const { type, id } = splitShapeKey(key);
  if (type === "MMConnector") return raw.nodes[key];
  if (type === "RelatConnector") {
    const rel = page.relationships.find((r) => r.id === id);
    if (!rel) return raw.nodes[key];
    return sigOfRelationship(rel) === raw.sig[key]
      ? raw.nodes[key]
      : buildRelationship(rel, ctx, raw.nodes[key]);
  }
  const shape = page.shapes[id];
  if (!shape) return undefined; // 用户删掉的 Shape：不再回写
  if (sigOfShape(shape) === raw.sig[key]) return raw.nodes[key];
  return buildShape(shape, ctx, raw.nodes[key]);
}

function buildShape(s: Shape, ctx: WriteCtx, from?: XmlNode): XmlNode | undefined {
  if (!s.id) return undefined;
  const n = el("Shape", { Type: s.type, ID: s.id });
  // 回写粒度：一颗子节点决定一次"复用原文件里那一份，还是按模型重建"。
  // 旧写法是整颗 Shape 重建（sigOfShape 一变就全交给我们自己的 build），于是改一个字
  // 都会顺手抹掉 buildShape 不建模的那几块 —— 装机差分实测丢过 ToSuper、<Geometries> 路径缓存、
  // 第二个 <Paragraph>、ShapeFormat@QuickMask、CX 上的 B/P，同时凭空多出我们发明的默认值。
  // 现在没动过的子节点是**原节点对象**，一个字节都不经过我们的想象。
  const rawOf = (tag: string) => (from ? find(from, tag) : undefined);
  const keep = (tag: string, same: boolean, built: () => XmlNode | undefined): void => {
    const r = rawOf(tag);
    const node = r && same ? r : built();
    if (node) n.children.push(node);
  };

  // 两边都过一遍 round 再比：亿图写 707.621、我们写 707.62，那是量具的精度差，
  // 不是用户挪了位置 —— 按原始字符串比会把每一颗 Shape 都判成改过。
  const rawTransform = rawOf("Transform");
  const rawText = rawOf("Text");
  const rawRt = rawText ? parseRichText(rawText) : undefined;
  const sameText = rawRt !== undefined && canon(rawRt) === canon(s.text);
  const hint = fontHint(ctx, s);
  const rawTextXf = rawText ? find(rawText, "Transform") : undefined;
  const rawTw = rawTextXf ? numVnode(rawTextXf, "Width", NaN) : NaN;
  const rawTh = rawTextXf ? numVnode(rawTextXf, "Height", NaN) : NaN;
  // 文字盒的尺寸：**字还是那些字、行还是那几行、号还是那一号**时沿用原盒。
  // 加粗/字色/字族这些样式位改动会让 `<Text>` 整棵重建，但不该让盒子跟着我们的尺重量一遍 ——
  // 量出来的差是尺的精度差（±2pt 只命中 240/505），一旦落到形状盒上就会连累 <Geometries> 路径缓存（01 A-21）。
  const sameGlyphs =
    rawRt !== undefined &&
    Number.isFinite(rawTw) &&
    Number.isFinite(rawTh) &&
    plainText(rawRt) === plainText(s.text) &&
    rawRt.paragraphs.length === s.text.paragraphs.length &&
    fontSizeOf(rawRt, hint) === fontSizeOf(s.text, hint);
  const dims = sameGlyphs ? { w: rawTw, h: rawTh } : textBoxSize(s.text, hint);
  // 形状盒要在比 Transform 之前算出来（01 A-21）：比的是"这一颗该落盘的那一份"，
  // 不是模型里那份从导入后就没被人写过的旧值。
  const box = shapeBoxOf(s, dims, rawTransform, rawTw, rawTh);
  const sameTransform =
    Boolean(rawTransform) &&
    (["CX", "CY", "Width", "Height"] as const).every((tag, i) => {
      const want = [s.transform.x, s.transform.y, box.w, box.h][i];
      return round(numVnode(rawTransform, tag, NaN)) === round(want);
    });
  keep("Transform", sameTransform, () =>
    el("Transform", {}, [
      // 亿图给每个 CX/CY 都写了 B/P 锚点标记（实测 660/660），重建时照它的写法补齐，
      // 不然改一次标题就会让 CX@B、CX@P 各少一条。
      attachP(vNode("CX", round(s.transform.x)), "1"),
      attachP(vNode("CY", round(s.transform.y)), "2"),
      vNode("Width", round(box.w)),
      vNode("Height", round(box.h)),
    ])
  );

  // 样式与正文用"读一遍原文再比"而不是比 XML：亿图写 `<FillFormat/>` 表示无填充，
  // 我们写 `<FillFormat Type="None"/>`，字面不同而语义相同 —— 按读侧的口径比才不会白重建一次。
  const rawShapeFormat = rawOf("ShapeFormat");
  const sameShapeFormat =
    Boolean(rawShapeFormat) &&
    canon(readStyle(rawShapeFormat)) === canon({ fill: s.style.fill, line: s.style.line });
  keep("ShapeFormat", sameShapeFormat, () => {
    const sf = el("ShapeFormat");
    if (s.style.fill) sf.children.push(buildFill(s.style.fill));
    if (s.style.line)
      sf.children.push(
        buildLine(s.style.line, rawShapeFormat && find(rawShapeFormat, "LineFormat"))
      );
    // 亿图每个 ShapeFormat 都带一张我们没建模的 QuickMask（实测 4095，意思是"这些项算独立覆盖"）；
    // 改一次颜色不该把这张掩码洗掉，所以原节点上的其它属性一律跟着走。
    for (const [k, v] of Object.entries(rawShapeFormat?.attrs ?? {})) sf.attrs[k] ??= v;
    return sf;
  });

  keep("Text", sameText, () => {
    // 形状盒用上面刚算出的那一份：锚点、文字盒、形状盒必须是同一个尺。
    const outer = { w: Number(round(box.w)), h: Number(round(box.h)) };
    const t = buildTextNode(s.text, rawText, hint, outer, dims);
    carryParagraphRecords(rawText, t);
    return t;
  });

  const rawLevel = rawOf("LevelData");
  const levelNode = (): XmlNode => {
    const ld = el("LevelData");
    if (s.parentId) ld.children.push(vNode("Super", s.parentId));
    // 亿图在同一个 <LevelData> 里还挂着我们没建模的兄弟节点（ToSuper、TogglerID…）：
    // 父子指针真的变了也得把它们带回来，不然删一次折叠标记就顺手抹掉一条指针缓存。
    if (rawLevel)
      for (const c of rawLevel.children)
        if (c.tag !== "Super" && c.tag !== "SubLevel") ld.children.push(c);
    if (s.childIds.length) ld.children.push(vNode("SubLevel", s.childIds.join(";")));
    return ld;
  };
  // 复用原节点的条件是"父子指针逐字对得上"。coveredBy 只查模型这一边，孩子变少时它会说
  // "原节点已经包住了"，于是把还指向已删主题的那份 SubLevel 带回盘上 —— 又留悬空引用又没删掉。
  const sameLevel =
    rawLevel !== undefined &&
    vnode(rawLevel, "Super", "") === (s.parentId ?? "") &&
    vnode(rawLevel, "SubLevel", "") === s.childIds.join(";");
  keep("LevelData", sameLevel, levelNode);

  // 路径缓存只要原文件里有，就永远原样带回：盒子尺寸变了、样式变了都不作为作废理由（01 A-23）。
  // 这一条推翻了本批早先的判据"盒子一变就把缓存清空"—— 真机上亿图是**照这份路径画泡、也照它画字**的，
  // 空缓存 = 泡和字一起消失；而贴着盒子边的那些点带 P="1"（按盒子比例），实测 95pt 宽的旧路径
  // 落在 249pt 的新盒上照样把改名后的那行字完整包住。
  // 判据只放在 geometryNode 一处：keep() 这边再判一次会造出一段永远走不到的代码。
  const geo = geometryNode(s.type, ctx, from, rawOf("Geometries"), box);
  if (geo) n.children.push(geo);

  // <ShapeStyle V> 是"这一族里第几号外形/样式"，我们没建模（读侧只把它当 ShapeFormat 的替补容器）。
  // 实测亿图写的是 5 而不是我们的常量 1，所以源里有就原样带回，只有新建的形状才落我们那一份。
  const rawShapeStyle = rawOf("ShapeStyle");
  keep("ShapeStyle", Boolean(rawShapeStyle), () => rawShapeStyle ?? el("ShapeStyle", { V: "1" }));
  // 独立配色必须能存住：丢了 StyleMask，重开后再换主题就会把用户挑的颜色盖掉。
  keep("StyleMask", coveredBy(rawOf("StyleMask"), el("StyleMask", { V: s.style.mask })), () =>
    s.style.mask === undefined ? undefined : el("StyleMask", { V: s.style.mask })
  );

  const rawAttachments = rawOf("Attachments");
  const attachments = s.extras.attachments ?? [];
  const sameAttachments =
    rawAttachments !== undefined &&
    findAll(rawAttachments, "Attachment").length === attachments.length &&
    coveredBy(rawAttachments, attachmentNode(attachments));
  keep("Attachments", sameAttachments, () => {
    if (!attachments.length) return undefined;
    const att = attachmentNode(attachments);
    // 关系表这一笔只有真的把节点写出去才要补：复用 raw 时它本来就在 document.xml.rels 里。
    for (const a of attachments) {
      if (!ctx.rels.some((r) => r.id === a.relId)) {
        ctx.rels.push({ id: a.relId, target: mediaTarget(a.name, ctx.media) });
      }
    }
    return att;
  });

  keep(
    "BoundaryData",
    coveredBy(
      rawOf("BoundaryData"),
      el("BoundaryData", {}, [vNode("Shapes", (s.extras.covered ?? []).join(";"))])
    ),
    () =>
      s.extras.covered?.length
        ? el("BoundaryData", {}, [vNode("Shapes", s.extras.covered.join(";"))])
        : undefined
  );
  keep(
    "Callout",
    coveredBy(rawOf("Callout"), el("Callout", { V: (s.extras.calloutIds ?? []).join(";") })),
    () =>
      s.extras.calloutIds?.length ? el("Callout", { V: s.extras.calloutIds.join(";") }) : undefined
  );
  // 分支自由布局（doc/复刻方案/00 §3.3）的位移。亿图没有这个字段，节点名是我们自造的，
  // 它读不懂只会忽略 —— 这条只保证"在我们这儿拖开的枝，存了再开还在"。
  keep(
    "BranchOffset",
    coveredBy(
      rawOf("BranchOffset"),
      el("BranchOffset", { V: s.offset ? `${s.offset.x};${s.offset.y}` : "" })
    ),
    () => (s.offset ? el("BranchOffset", { V: `${s.offset.x};${s.offset.y}` }) : undefined)
  );
  // 任务信息：同一条自造节点的路。进度/优先级/状态/起止/里程碑/成员/标签/前置全部收进属性，
  // 空字段不写，重开时 parse 侧还原成 undefined；读侧补的默认值在盘上本来就没有位置，也不许落笔。
  keep(
    "TaskInfo",
    coveredBy(rawOf("TaskInfo"), buildTaskInfo(s.extras.task, rawOf("TaskInfo"))),
    () => buildTaskInfo(s.extras.task, rawOf("TaskInfo"))
  );
  carryUntouched(s, n, from);
  return n;
}

/** 只取读侧认得的 fill/line 两项，用来和模型比（raw 里多出来的兄弟节点不参与比较，但会跟着原节点带回）。 */
function readStyle(sf: XmlNode | undefined): { fill?: FillFormat; line?: ShapeStyle["line"] } {
  const fill = sf ? find(sf, "FillFormat") : undefined;
  const line = sf ? find(sf, "LineFormat") : undefined;
  return { fill: fill ? parseFill(fill) : undefined, line: line ? parseLine(line) : undefined };
}

/**
 * 亿图的 `<Paragraph IX>` 是"第 IX 段的样式记录"，条数可以比正文段落多
 * （实测 系统测试.emmx 里那颗只有一个 `<pp>` 的 MainTopic 带着 IX=0/1 两条：一条 SpLine、一条 IndFirst）。
 * 我们的模型按 `<pp>` 建模，重建 `<Text>` 时多出来的那条会被顺手抹掉 —— 用户没改过的字节不该少，
 * 按 IX 补回原位置（插在最后一条 Paragraph 之后，保持亿图"Character* Paragraph* Text"的排布）。
 */
function carryParagraphRecords(rawText: XmlNode | undefined, built: XmlNode): void {
  const rawTb = rawText ? find(rawText, "TextBlock") : undefined;
  const mine = find(built, "TextBlock");
  if (!rawTb || !mine) return;
  const have = new Set(findAll(mine, "Paragraph").map((p) => p.attrs.IX ?? ""));
  const extra = findAll(rawTb, "Paragraph").filter((p) => !have.has(p.attrs.IX ?? ""));
  if (!extra.length) return;
  let at = mine.children.length;
  mine.children.forEach((c, i) => {
    if (c.tag === "Paragraph") at = i + 1;
  });
  mine.children.splice(at, 0, ...extra);
}

/** 附件那一份 <Attachments>：纯构造，比较与写盘共用一个口径。 */
function attachmentNode(list: NonNullable<Shape["extras"]["attachments"]>): XmlNode {
  return el(
    "Attachments",
    {},
    list.map((a) => el("Attachment", { Res: a.relId, Name: a.name }))
  );
}

/** 任务信息：读侧给"盘上根本没写"的属性补的那个默认值。省略它们才算无损（重读还是同一个默认）。 */
const TASK_DEFAULTS: Record<string, string> = { Progress: "0", Priority: "medium", Status: "todo" };

/** 任务信息那一颗自造节点（属性全在 <TaskInfo> 自己身上）。 */
function buildTaskInfo(t: Shape["extras"]["task"], raw?: XmlNode): XmlNode | undefined {
  if (!t) return undefined;
  const attrs: Record<string, string | number | undefined> = {
    Progress: round(t.progress),
    Priority: t.priority,
    Status: t.status,
    ...(t.start !== undefined ? { Start: String(Math.round(t.start)) } : {}),
    ...(t.finish !== undefined ? { Finish: String(Math.round(t.finish)) } : {}),
    ...(t.duration !== undefined ? { Duration: String(t.duration) } : {}),
    ...(t.milestone ? { Milestone: "1" } : {}),
    ...(t.assignees.length ? { Assignees: t.assignees.join(";") } : {}),
    ...(t.tags.length ? { Tags: t.tags.join(";") } : {}),
    ...(t.deps?.length ? { Deps: t.deps.join(";") } : {}),
  };
  // 原节点没写过这一项、而模型里那个值只是读侧补的默认 ⇒ 不落笔：
  // 否则改一次加粗会让 TaskInfo 凭空长出 Priority/Status 两个键（用户压根没碰过任务）。
  // 原节点写过的一律跟着走，用户真改成非默认值的也照样落盘 —— 改回默认值这一笔没有盘上记号，
  // 与 Character@Style 同一个口径（亿图从不写 Style="0"），见 03 §1.3-24 的遗留说明。
  for (const [k, v] of Object.entries(attrs))
    if (raw?.attrs[k] === undefined && String(v) === TASK_DEFAULTS[k]) delete attrs[k];
  return el("TaskInfo", attrs);
}

/** 比较用的稳定 JSON：键序不同的等价对象要判等（模型对象可能来自编辑路径，键序与解析结果不同）。 */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.keys(x as object)
          .sort()
          .reduce<Record<string, unknown>>((acc, k) => {
            acc[k] = (x as Record<string, unknown>)[k];
            return acc;
          }, {})
      : x
  );
}

/**
 * built 想表达的那几项（属性 + 子元素按 tag 与出现次序配对），raw 是不是已经一个不差？
 *
 * 是 ⇒ raw 是 built 的超集，直接带回 raw（它揣着我们不写的邻居：ShapeStyle 上多出来的属性、
 * LevelData 里没建模的兄弟节点）。**built 断言了而 raw 没有**算不等 —— 否则那一笔会被静默丢掉。
 * 数值允许 round 级的差异：那是量具精度，不是用户改过。
 */
function coveredBy(raw: XmlNode | undefined, built: XmlNode | undefined): boolean {
  if (!raw || !built) return false;
  for (const [k, v] of Object.entries(built.attrs)) {
    const mine = raw.attrs[k];
    if (mine === undefined || (mine !== v && !numSame(v, mine))) return false;
  }
  if (built.text && raw.text !== built.text) return false;
  const byTag = new Map<string, XmlNode[]>();
  for (const c of raw.children) {
    const list = byTag.get(c.tag);
    if (list) list.push(c);
    else byTag.set(c.tag, [c]);
  }
  for (const c of built.children) {
    const list = byTag.get(c.tag);
    if (!list?.length || !coveredBy(list.shift(), c)) return false;
  }
  return true;
}

/** 两个字符串数值上等不等（round 归一化后比）；有一边不是数字就不等。 */
function numSame(a: string, b: string): boolean {
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && round(x) === round(y);
}

/** buildShape 会自己重建的标签；Shape 上其余的子元素都要从原节点带回来。 */
const SHAPE_OWN_TAGS = new Set([
  "Transform",
  "ShapeFormat",
  "Text",
  "LevelData",
  "Geometries",
  "ShapeStyle",
  "StyleMask",
  "Attachments",
  "BoundaryData",
  "Callout",
  "BranchOffset",
  "TaskInfo",
]);

/**
 * 改一个主题不该顺手抹掉它身上我们不重建的字段。
 *
 * 批注、超链接与标签是"模型里有、写侧一直没落笔"的三个：签名一变整份节点重生成，
 * 原文件里的这两块就没了。规则是 —— 值没动过就原样带回亿图自己的写法（我们不猜它的
 * 元素布局），值改过才按读侧认得的写法重建；用户在界面里删掉的，这里就真的不再写。
 * 其余没建模的元素一律带回：宁可保留我们看不懂的字节，也不要"打开一次再保存就少一块"。
 */
function carryUntouched(s: Shape, n: XmlNode, from?: XmlNode): void {
  const rawNote = from
    ? (vnode(find(from, "Comment"), "Text") ?? vnode(find(from, "Note"), "V"))
    : undefined;
  const linkNode = from ? (find(from, "HyperLink") ?? find(from, "Hyperlink")) : undefined;
  const rawLink = linkNode ? (vnode(linkNode, "Address") ?? attr(linkNode, "Address")) : undefined;
  // 读侧按 split(";").filter(Boolean) 理解标签，比较前先按同一规则归一化，否则 "A;A;" 会被当成改过。
  const rawLabels = from ? normLabels(vnode(find(from, "Labels"), "V")) : undefined;
  const modelLabels = normLabels((s.extras.labels ?? []).join(";"));
  // <Layout> 是"部分建模"的节点：折叠态归我们管，里面其余的码（LayoutDirection、ImagePos、
  // Margins、我们不认的布局记忆）一律留着 —— 界面里折一下再存，不该顺手把亿图的布局信息洗掉。
  const rawLayout = from ? find(from, "Layout") : undefined;
  const rawFolded = vnode(rawLayout, "Toggler", "") === "1";
  const folded = Boolean(s.extras.collapsed);
  for (const c of from?.children ?? []) {
    if (SHAPE_OWN_TAGS.has(c.tag)) continue;
    if (c.tag === "Comment" || c.tag === "Note") {
      if (s.extras.note === rawNote) n.children.push(c);
      continue;
    }
    if (c.tag === "HyperLink" || c.tag === "Hyperlink") {
      if (s.extras.hyperlink?.target === rawLink) n.children.push(c);
      continue;
    }
    if (c.tag === "Labels") {
      if (rawLabels === modelLabels) n.children.push(c);
      continue;
    }
    if (c.tag === "Layout") {
      n.children.push(folded === rawFolded ? c : withToggler(c, folded));
      continue;
    }
    n.children.push(c);
  }
  if (s.extras.note !== undefined && s.extras.note !== rawNote) {
    n.children.push(el("Comment", {}, [vNode("Text", s.extras.note)]));
  }
  if (s.extras.hyperlink && s.extras.hyperlink.target !== rawLink) {
    n.children.push(el("HyperLink", {}, [vNode("Address", s.extras.hyperlink.target)]));
  }
  if (modelLabels && modelLabels !== rawLabels) {
    n.children.push(el("Labels", {}, [vNode("V", modelLabels)]));
  }
  // 新建的主题本来就没有 <Layout>：折叠了才补一个，没折叠就不写（亿图的写法是"没折叠不留节点"）。
  if (folded && !rawLayout) n.children.push(el("Layout", {}, [vNode("Toggler", "1")]));
}

/**
 * 换掉 `<Layout>` 里的 Toggler，其余子元素与属性一律保留。
 *
 * 加在开头而不是追加：亿图自己就把 Toggler 写在 `<Layout>` 的第一个位置，
 * 位置跟着原作者比按我们的习惯排更稳。
 */
function withToggler(raw: XmlNode, folded: boolean): XmlNode {
  const kids = raw.children.filter((c) => c.tag !== "Toggler");
  if (folded) kids.unshift(vNode("Toggler", "1"));
  return { tag: raw.tag, attrs: { ...raw.attrs }, children: kids, text: raw.text };
}

function normLabels(raw?: string): string {
  return (raw ?? "").split(";").filter(Boolean).join(";");
}
/** 附件名 → media/ 里的真实路径；找不到就按原名挂到 media/ 下。 */
function mediaTarget(name: string, media: Record<string, Uint8Array>): string {
  const hit = Object.keys(media).find((k) => k === name || k.endsWith(`/${name}`));
  return hit ?? `media/${name}`;
}

/**
 * 一颗原始关系线上记的两个端点号（01 A-24）。真键是 `<ConnectMap From="起" To="止"/>`；
 * `ID=` 那种形式只有我们旧版写过，留着当回退，旧文件才还能连得上。
 */
function relEndpoints(from: XmlNode): { beginId: string; endId: string } {
  const cm = find(from, "ConnectMap");
  return {
    beginId: attr(cm, "From") || attr(find(from, "BeginPt") ?? from, "ID"),
    endId: attr(cm, "To") || attr(find(from, "EndPt") ?? from, "ID"),
  };
}

/** 亿图自己写关系线时的先后次序（重建时没建模的那几段要跟着它，见 01 A-24 的两份观察）。 */
const REL_ORDER = [
  "ConnectMap",
  "BeginPt",
  "EndPt",
  "Text",
  "ShapeFormat",
  "StyleMask",
  "Geometries",
];

function buildRelationship(r: RelationshipShape, ctx: WriteCtx, from?: XmlNode): XmlNode {
  void ctx;
  const n = el("Shape", { Type: "RelatConnector", ID: r.id });
  const rawOf = (tag: string): XmlNode | undefined => (from ? find(from, tag) : undefined);
  const rawEnds = from ? relEndpoints(from) : { beginId: "", endId: "" };
  const sameEnds = Boolean(from) && rawEnds.beginId === r.beginId && rawEnds.endId === r.endId;

  const rawText = rawOf("Text");
  const rawRt = rawText ? parseRichText(rawText) : undefined;
  const sameText = rawRt !== undefined && canon(rawRt) === canon(r.text);
  const textNode = (): XmlNode => {
    const t = buildTextNode(r.text, rawText);
    if (rawText) carryParagraphRecords(rawText, t);
    return t;
  };
  // 线色、线宽、虚线都挂在 style 上：漏掉 ShapeFormat 的话，签名一变整份节点重生成，
  // 用户挑过的线色就静默回到默认（和标签那条是同一类"读得到写不回"的 bug）。
  const rawSf = rawOf("ShapeFormat");
  // 但只有 style 真的变了才值得重生成：只改标签字时重量一遍会把模型没建模的那几件抹掉 ——
  // 装机前差分实测丢过 <EndArrow ID Size>（箭头款式）、<LinePattern ID>（虚线）与 Rounding（01 A-24）。
  const sameStyle =
    from !== undefined &&
    rawSf !== undefined &&
    JSON.stringify(r.style) === JSON.stringify(parseShapeStyle(from));
  const sf = el("ShapeFormat");
  if (r.style.fill) sf.children.push(buildFill(r.style.fill));
  if (r.style.line) sf.children.push(buildLine(r.style.line, rawSf && find(rawSf, "LineFormat")));
  for (const [k, v] of Object.entries(rawSf?.attrs ?? {})) sf.attrs[k] ??= v;
  // 连线的路径缓存与两端坐标都按旧端点算：端点一动这两份就是假的（留空让亿图自己重算，
  // 这一条待真机确认，见 01 A-24）。端点没动（只改标签字、线色、线宽）时必须原样带回 ——
  // "留空亿图会自己补"在主题那颗上已被真机推翻（01 A-23：空缓存 = 泡和字一起消失）。
  const parts: Record<string, XmlNode | undefined> = {
    // 亿图 0/20 颗关系线里写过 <RelatConnector Thickness>：那是我们旧版发明的元素，不再写也不带回。
    ConnectMap: el("ConnectMap", { From: r.beginId, To: r.endId }),
    BeginPt: sameEnds ? rawOf("BeginPt") : undefined,
    EndPt: sameEnds ? rawOf("EndPt") : undefined,
    Text: sameText ? rawText : textNode(),
    ShapeFormat: sameStyle
      ? rawSf
      : sf.children.length || Object.keys(sf.attrs).length
        ? sf
        : undefined,
    StyleMask: r.style.mask !== undefined ? el("StyleMask", { V: r.style.mask }) : undefined,
    Geometries: (sameEnds ? rawOf("Geometries") : undefined) ?? el("Geometries"),
  };
  // 按原文件的子节点顺序逐位放回：建模的那几段换成上面算出来的，没建模的
  // （Transform/LevelData/ShapeStyle/PathText/TextChanged/TogglerID…）原样带走，一个都不发明。
  const done = new Set<string>();
  for (const c of from?.children ?? []) {
    if (c.tag === "RelatConnector") continue;
    if (c.tag in parts) {
      const p = parts[c.tag];
      if (p && !done.has(c.tag)) {
        n.children.push(p);
        done.add(c.tag);
      }
      continue;
    }
    n.children.push(c);
  }
  for (const tag of REL_ORDER) {
    if (done.has(tag)) continue;
    const p = parts[tag];
    if (p) n.children.push(p);
  }
  return n;
}

function buildColor(c: ColorValue): XmlNode {
  return el("Color", {
    V: c.v,
    Shade: c.shade,
    Tint: c.tint,
    Ref: c.ref,
    ThemeColor: c.themeColor,
  });
}

function buildFill(f: FillFormat, tag = "FillFormat"): XmlNode {
  const n = el(tag, { Type: f.type });
  if (f.type === "Gradient") {
    const g = el("GradFill", { Angle: f.angle ?? 0 });
    for (const s of f.stops ?? []) {
      g.children.push(
        el("Stop", { Pos: s.pos, V: s.color.v, Shade: s.color.shade, Tint: s.color.tint })
      );
    }
    n.children.push(g);
    return n;
  }
  if (f.color) n.children.push(buildColor(f.color));
  return n;
}

function buildLine(l: NonNullable<ShapeStyle["line"]>, src?: XmlNode): XmlNode {
  // 线型写在属性上（读侧 attr(n,"LineStyle")），线色写在 <LineFill> 里：
  // 写成 <FillFormat> 或漏掉 LineStyle，重开时解析不到，改一次线色就等于把颜色丢掉。
  // src = 原文件里那一颗 LineFormat。亿图只写用户真动过的项，而我们读侧把缺省都填成了默认值，
  // 所以"源里没有 + 值正好是那个默认值"就不写（01 A-12：发明默认值等于凭空加覆盖标记）。
  const had = (tag: string) => src === undefined || find(src, tag) !== undefined;
  const hadAttr = (key: string) => src === undefined || src.attrs[key] !== undefined;
  const style = l.style ?? "Solid";
  const n = el("LineFormat", {
    LineStyle: hadAttr("LineStyle") || style !== "Solid" ? style : undefined,
  });
  if (l.weight !== undefined && (had("LineWeight") || l.weight !== DEFAULTS.lineWeight))
    n.children.push(vNode("LineWeight", l.weight));
  if (l.rounding !== undefined && (had("Rounding") || l.rounding !== DEFAULTS.rounding))
    n.children.push(vNode("Rounding", l.rounding));
  if (l.cap && (had("LineCap") || l.cap !== "Flat")) n.children.push(vNode("LineCap", l.cap));
  if (l.beginArrow) n.children.push(vNode("BeginArrow", l.beginArrow));
  if (l.endArrow) n.children.push(vNode("EndArrow", l.endArrow));
  if (l.fill) n.children.push(buildFill(l.fill, "LineFill"));
  return n;
}

function buildPageProps(p: Page): XmlNode {
  return el("PageProps", {}, [
    vNode("Width", p.props.width),
    vNode("Height", p.props.height),
    vNode("ScrollX", p.props.scrollX),
    vNode("ScrollY", p.props.scrollY),
  ]);
}

/**
 * 写回 <Layout V>：码没被人在界面里改过时，原样带回读到的数字（含我们不认得的 7）；
 * 改过或本来就是我们自己造的页，才按当前 code 反查。
 */
function layoutCodeOfPage(p: Page): string {
  const raw = p.layout.rawCode;
  if (raw !== undefined && (LAYOUT_CODE_TO_NAME[raw] ?? "balanced") === p.layout.code)
    return String(raw);
  return Object.entries(LAYOUT_CODE_TO_NAME).find(([, v]) => v === p.layout.code)?.[0] ?? "6";
}

function buildLayout(p: Page): XmlNode {
  const code = layoutCodeOfPage(p);
  const n = el("Layout", {}, [
    vNode("Layout", code),
    vNode("HSpacing", p.layout.hSpacing),
    vNode("VSpacing", p.layout.vSpacing),
  ]);
  if (p.layout.levelLength.length)
    n.children.push(vNode("LevelLength", p.layout.levelLength.join(";")));
  if (p.layout.branchCount.length)
    n.children.push(vNode("BranchCount", p.layout.branchCount.join(";")));
  if (p.layout.rainbow) n.children.push(vNode("Rainbow", 1));
  return n;
}

function buildPrint(pr: Page["print"]): XmlNode {
  const n = el("PrintSetup");
  n.children.push(el("PaperSize", { V: `${pr.paperW};${pr.paperH}` }));
  n.children.push(vNode("Unit", pr.unit));
  n.children.push(vNode("TopMargin", pr.marginTop));
  n.children.push(vNode("RightMargin", pr.marginRight));
  n.children.push(vNode("BottomMargin", pr.marginBottom));
  n.children.push(vNode("LeftMargin", pr.marginLeft));
  n.children.push(vNode("FitToSheet", pr.fitToSheet ? 1 : 0));
  n.children.push(vNode("PrintBackground", pr.printBackground ? 1 : 0));
  return n;
}

function buildTheme(t: Page["theme"]): XmlNode {
  const n = el("Theme", { ID: t.id, Name: t.name, Rainbow: t.rainbow ? "1" : "0" });
  n.children.push(el("ThemeColor", { ID: t.colorId }));
  n.children.push(el("ThemeEffect", { ID: t.effectId }));
  n.children.push(el("ThemeText", { ID: t.textId }));
  n.children.push(el("ThemeShape", { ID: t.shapeId }));
  return n;
}

// ---------------------------------------------------------------- 模型等价比较

/** 语义比较：忽略 rawUnknown（那是缓存），media 只比名字。 */
export function modelEquals(a: DocumentModel, b: DocumentModel): boolean {
  return (
    stable(a) === stable(b) &&
    Object.keys(a.media).sort().join() === Object.keys(b.media).sort().join()
  );
}

/**
 * 只读地规范化成可比较的字符串。
 * 注意不能 delete 原对象的 rawUnknown —— 那会把解析缓存真删掉，
 * 之后一次保存就退化成"全部重新生成"，用户文件里的派生数据会丢。
 */
function stable(doc: DocumentModel): string {
  return JSON.stringify(doc, (key, value) => {
    if (key === "rawUnknown" || key === "media") return undefined;
    if (value instanceof Uint8Array) return undefined;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) {
        if (k === "rawUnknown") continue;
        out[k] = (value as Record<string, unknown>)[k];
      }
      return out;
    }
    return value;
  });
}

/** 只取第一个页面的容器结构是亿图的实测行为；多页时后续页面用 page2.xml 递增命名（待确认）。 */
export function pageEntryName(ix: number): string {
  return ix === 0 ? PAGE_XML : `page/page${ix + 1}.xml`;
}

export function hasAnyPage(doc: DocumentModel): boolean {
  return doc.pages.length > 0 && Object.keys(doc.pages[0].shapes).length > 0;
}
