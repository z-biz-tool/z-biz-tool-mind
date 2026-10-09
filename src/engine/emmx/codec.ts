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
 * 保存时逐个 Shape 比指纹 —— 指纹没变就写回原始节点，变过了就按模型重新生成。
 * 于是得到一条可测的保证：`write(parse(x))` 与 `x` 结构等价，
 * 而任何编辑都会落到重新生成的分支上。
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
  TextParagraph,
} from "../../types/model.ts";
import { makeText, plainText } from "../../types/model.ts";
import { DEFAULTS } from "../../model/constants.ts";
import { LAYOUT_CODE_TO_NAME } from "../../types/model.ts";
import { createPage, newGanttOption } from "../../model/factory.ts";
import { readZip, writeZip, encodeText, decodeBytes, type ZipEntry } from "./zip.ts";
import {
  attr,
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
  type XmlNode,
} from "./xparse.ts";

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
  if (!pageEntries.length) throw new EmmxError("page/ 下没有任何页面");

  const docRoot = parseXml(decodeBytes(docEntry.data));
  const media: Record<string, Uint8Array> = {};
  for (const e of entries) if (/^media\//i.test(e.name)) media[e.name] = e.data;
  // 亿图在包里另存一张 thumbnail.jpeg 给"打开"对话框做预览：它不属于任何 Shape，
  // 但按名字带回原字节，总比整条 entry 消失好。
  const thumb = entries.find((e) => /^thumbnail\.\w+$/i.test(e.name));
  if (thumb) media[thumb.name] = thumb.data;
  // 空的 <Relationships/> 亿图也照样写一条；"有没有这个文件"和"里面有没有条目"是两件事。
  const relsPresent = entries.some((e) => /^rels\/page_rels\.xml$/i.test(e.name));

  const rels = parseRels(entries);
  const pages: Page[] = [];
  for (const pe of pageEntries) {
    pages.push(parsePage(pe.name, decodeBytes(pe.data), rels.map, warnings));
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
    themeRoot: pageThemeRoot(entries),
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

function pageThemeRoot(entries: ZipEntry[]): XmlNode | undefined {
  const hit = entries.find((e) => /^theme\.xml$/i.test(e.name));
  if (!hit) return undefined;
  try {
    return parseXml(decodeBytes(hit.data));
  } catch {
    return undefined;
  }
}

function parseRels(entries: ZipEntry[]): {
  map: Record<string, string>;
  list: { id: string; target: string }[];
} {
  const map: Record<string, string> = {};
  const list: { id: string; target: string }[] = [];
  for (const e of entries) {
    if (!/^rels\/.*\.xml$/i.test(e.name)) continue;
    let root: XmlNode;
    try {
      root = parseXml(decodeBytes(e.data));
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
  return { map, list };
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
        const rel: RelationshipShape = {
          id: sid,
          beginId:
            vnode(find(child, "BeginPt"), "X") ?? attr(find(child, "BeginPt") ?? child, "ID"),
          endId: vnode(find(child, "EndPt"), "X") ?? attr(find(child, "EndPt") ?? child, "ID"),
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
  if (vnode(layoutNode, "LayoutDirection", "") === "0") extras.collapsed = true;
  // 分支自由布局的位移（§3.3）。这一对读作 [dx,dy]；长度不够就当成"没拖过"，
  // 不猜半个值 —— 脏数据在这里的正确答案是回到引擎位置，而不是把分支挪到原点。
  const branchOffset = splitNumbers(attr(find(n, "BranchOffset"), "V", ""));
  // 外框/概要与标注框都是"分号分隔的 id 列表写在 V 上"：找错属性这两个字段就永远是空的。
  const covered = vnode(find(n, "BoundaryData"), "Shapes", "");
  if (covered) extras.covered = covered.split(";").filter(Boolean);
  const callouts = attr(find(n, "Callout"), "V", "");
  if (callouts) extras.calloutIds = callouts.split(";").filter(Boolean);

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
    characters: characters.length
      ? characters
      : [{ family: DEFAULTS.fontFamily, size: DEFAULTS.fontSize }],
  };
}

/** Character@Style 是按位标志：实测 1 = 加粗（中心主题），2 = 斜体，4 = 下划线。 */
function parseCharacter(n: XmlNode): FontSpec {
  const style = numAttr(n, "Style", 0);
  const f: FontSpec = {
    family: attr(n, "Family", DEFAULTS.fontFamily),
    size: numAttr(n, "Size", DEFAULTS.fontSize),
    color: attr(n, "Color", DEFAULTS.textColor),
    bold: (style & 1) !== 0,
  };
  if (style & 2) f.italic = true;
  if (style & 4) f.underline = true;
  return f;
}

function characterStyle(f: FontSpec): number {
  return (f.bold ? 1 : 0) | (f.italic ? 2 : 0) | (f.underline ? 4 : 0);
}

function buildTextNode(rt: RichText): XmlNode {
  const tb = el("TextBlock", { TextFormatMask: "10224" });
  const font = rt.characters[0] ?? { size: DEFAULTS.fontSize };
  tb.children.push(el("Color", { V: withAlpha(font.color ?? DEFAULTS.textColor) }));
  rt.characters.forEach((c, ix) => {
    tb.children.push(
      el("Character", {
        Style: characterStyle(c),
        Family: c.family ?? DEFAULTS.fontFamily,
        IX: ix,
        Size: c.size ?? DEFAULTS.fontSize,
        Color: (c.color ?? DEFAULTS.textColor).replace(/^#ff(?=[0-9a-f]{6}$)/i, "#"),
      })
    );
  });
  rt.paragraphs.forEach((p, ix) => {
    tb.children.push(
      el("Paragraph", { SpLine: "100", Align: p.align ?? 1, IX: ix, IndFirst: p.indentFirst })
    );
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
  const tw = Math.max(1, Math.round(measureTextWidth(rt)));
  const th = Math.max(1, Math.round(rt.paragraphs.length * (font.size ?? DEFAULTS.fontSize) * 1.4));
  return el("Text", {}, [
    el("Transform", {}, [
      vNode("Width", tw),
      vNode("Height", th),
      vNode("CX", 0),
      attachP(vNode("CY", 0), "2"),
    ]),
    tb,
  ]);
}

/** 文本盒宽度粗估：只用于重新生成节点时的几何，画布上真正的尺寸由布局引擎说了算。 */
function measureTextWidth(rt: RichText): number {
  const lines = plainText(rt).split("\n");
  const size = rt.characters[0]?.size ?? DEFAULTS.fontSize;
  let max = 0;
  for (const l of lines) max = Math.max(max, l.length * size * 0.62);
  return Math.min(DEFAULTS.topicMaxTextW, Math.max(size, max));
}

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
  const docRoot = buildDocumentXml(doc);
  entries.push({ name: DOC_XML, data: encodeText(serializeXml(docRoot)) });

  doc.pages.forEach((page, ix) => {
    entries.push({
      name: pageEntryName(ix),
      data: encodeText(serializeXml(buildPageXml(page, ctx))),
    });
  });

  const themeRaw = doc.rawUnknown?.themeRoot as XmlNode | undefined;
  if (themeRaw) entries.push({ name: THEME_XML, data: encodeText(serializeXml(themeRaw)) });
  const relsPresent = Boolean(doc.rawUnknown?.relsPresent);
  if (ctx.rels.length || relsPresent) {
    const r = el("Relationships");
    for (const x of ctx.rels)
      r.children.push(el("Relationship", { Id: x.id, Target: `../${x.target}` }));
    entries.push({ name: RELS_XML, data: encodeText(serializeXml(r)) });
  }
  for (const [name, data] of Object.entries(doc.media)) entries.push({ name, data });

  return writeZip(entries, { compress: true, modifiedAt: new Date() });
}

interface WriteCtx {
  rels: { id: string; target: string }[];
  media: Record<string, Uint8Array>;
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
  for (const key of order) {
    if (key.startsWith("#")) {
      const { id } = splitShapeKey(key);
      if (!raw) {
        const fresh = page.shapes[id];
        const built = fresh ? buildShape(fresh, ctx) : undefined;
        if (built) {
          root.children.push(built);
          emitted.add(key);
        }
        continue;
      }
      const rebuilt = rebuildShape(key, page, ctx, raw);
      if (rebuilt) {
        root.children.push(rebuilt);
        emitted.add(key);
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
  return root;
}

/** 新建页面的规范顺序：页面级标签在前，Shape 按 id 数值序在后。 */
function defaultOrder(page: Page): string[] {
  const ids = Object.keys(page.shapes).sort((a, b) => Number(a) - Number(b));
  return [...Array.from(PAGE_TAGS), ...ids.map((id) => shapeKey(id, page.shapes[id].type))];
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
    return sigOfRelationship(rel) === raw.sig[key] ? raw.nodes[key] : buildRelationship(rel, ctx);
  }
  const shape = page.shapes[id];
  if (!shape) return undefined; // 用户删掉的 Shape：不再回写
  if (sigOfShape(shape) === raw.sig[key]) return raw.nodes[key];
  return buildShape(shape, ctx, raw.nodes[key]);
}

function buildShape(s: Shape, ctx: WriteCtx, from?: XmlNode): XmlNode | undefined {
  if (!s.id) return undefined;
  const n = el("Shape", { Type: s.type, ID: s.id });
  n.children.push(
    el("Transform", {}, [
      vNode("CX", round(s.transform.x)),
      attachP(vNode("CY", round(s.transform.y)), "2"),
      vNode("Width", round(s.transform.w)),
      vNode("Height", round(s.transform.h)),
    ])
  );
  const sf = el("ShapeFormat");
  if (s.style.fill) sf.children.push(buildFill(s.style.fill));
  if (s.style.line) sf.children.push(buildLine(s.style.line));
  n.children.push(sf);
  n.children.push(buildTextNode(s.text));

  const ld = el("LevelData");
  if (s.parentId) ld.children.push(vNode("Super", s.parentId));
  if (s.childIds.length) ld.children.push(vNode("SubLevel", s.childIds.join(";")));
  n.children.push(ld);
  // Geometries 留空：P-2 布局是算出来的，亿图重开时会按 Transform 重新生成路径缓存。
  n.children.push(el("Geometries"));
  n.children.push(el("ShapeStyle", { V: "1" }));
  // 独立配色必须能存住：丢了 StyleMask，重开后再换主题就会把用户挑的颜色盖掉。
  if (s.style.mask !== undefined) n.children.push(el("StyleMask", { V: s.style.mask }));
  if (s.extras.attachments?.length) {
    const att = el("Attachments");
    for (const a of s.extras.attachments) {
      att.children.push(el("Attachment", { Res: a.relId, Name: a.name }));
      if (!ctx.rels.some((r) => r.id === a.relId)) {
        ctx.rels.push({ id: a.relId, target: mediaTarget(a.name, ctx.media) });
      }
    }
    n.children.push(att);
  }
  if (s.extras.covered?.length)
    n.children.push(el("BoundaryData", {}, [vNode("Shapes", s.extras.covered.join(";"))]));
  if (s.extras.calloutIds?.length)
    n.children.push(el("Callout", { V: s.extras.calloutIds.join(";") }));
  // 分支自由布局（doc/复刻方案/00 §3.3）的位移。亿图没有这个字段，节点名是我们自造的，
  // 它读不懂只会忽略 —— 这条只保证"在我们这儿拖开的枝，存了再开还在"。
  if (s.offset) n.children.push(el("BranchOffset", { V: `${s.offset.x};${s.offset.y}` }));
  carryUntouched(s, n, from);
  return n;
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
}

function normLabels(raw?: string): string {
  return (raw ?? "").split(";").filter(Boolean).join(";");
}
/** 附件名 → media/ 里的真实路径；找不到就按原名挂到 media/ 下。 */
function mediaTarget(name: string, media: Record<string, Uint8Array>): string {
  const hit = Object.keys(media).find((k) => k === name || k.endsWith(`/${name}`));
  return hit ?? `media/${name}`;
}

function buildRelationship(r: RelationshipShape, ctx: WriteCtx): XmlNode {
  void ctx;
  const n = el("Shape", { Type: "RelatConnector", ID: r.id });
  n.children.push(el("RelatConnector", { Thickness: "0" }));
  n.children.push(el("BeginPt", { ID: r.beginId }));
  n.children.push(el("EndPt", { ID: r.endId }));
  n.children.push(buildTextNode(r.text));
  // 线色、线宽、虚线都挂在 style 上：漏掉 ShapeFormat 的话，签名一变整份节点重生成，
  // 用户挑过的线色就静默回到默认（和标签那条是同一类"读得到写不回"的 bug）。
  const sf = el("ShapeFormat");
  if (r.style.fill) sf.children.push(buildFill(r.style.fill));
  if (r.style.line) sf.children.push(buildLine(r.style.line));
  if (sf.children.length) n.children.push(sf);
  if (r.style.mask !== undefined) n.children.push(el("StyleMask", { V: r.style.mask }));
  n.children.push(el("Geometries"));
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

function buildLine(l: NonNullable<ShapeStyle["line"]>): XmlNode {
  // 线型写在属性上（读侧 attr(n,"LineStyle")），线色写在 <LineFill> 里：
  // 写成 <FillFormat> 或漏掉 LineStyle，重开时解析不到，改一次线色就等于把颜色丢掉。
  const n = el("LineFormat", { LineStyle: l.style ?? "Solid" });
  if (l.weight !== undefined) n.children.push(vNode("LineWeight", l.weight));
  if (l.rounding !== undefined) n.children.push(vNode("Rounding", l.rounding));
  if (l.cap) n.children.push(vNode("LineCap", l.cap));
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
