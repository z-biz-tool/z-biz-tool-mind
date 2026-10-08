/**
 * 领域模型：一条树，六个投影（doc/复刻方案/00 §0.3 P-1）。
 *
 * 这份类型表是按 `_research/extract/doc1..doc5/page_page.xml.txt` 的实测结构写的，
 * 不是凭想象：`<Shape Type ID>` 平铺在 Page 下，父子关系同时存在两个方向
 * （父的 `<LevelData><SubLevel V="102;110"/>` 与子的 `<LevelData><Super V="101"/>`），
 * 所以这里也保留 childIds + parentId 两份索引，round-trip 时才能还原出同样的 XML。
 */

/** .emmx 里出现过的 Shape 类型全集（doc1..doc5 实测 + 选项面板推断）。 */
export type ShapeType =
  | "MainIdea" // 中心主题
  | "MainTopic" // 主分支
  | "SubTopic" // 子分支
  | "Floating" // 浮动主题
  | "Callout" // 标注
  | "Boundary" // 外框
  | "Summary" // 概要
  | "SummaryTopic" // 概要主题
  | "MMConnector" // 分支连线（画布投影产物，不是用户数据）
  | "RelatConnector"; // 关系线（用户数据）

export const TOPIC_TYPES: ShapeType[] = [
  "MainIdea",
  "MainTopic",
  "SubTopic",
  "Floating",
  "SummaryTopic",
];

export function isTopic(t: ShapeType): boolean {
  return TOPIC_TYPES.includes(t);
}

/** 颜色四元组：V 是终值，Shade/Tint/Ref 是相对主色的推导参数，ThemeColor 指向色板槽位。 */
export interface ColorValue {
  /** `#rrggbb` 或 `#aarrggbb`，写入时始终给终值，读取时优先终值。 */
  v: string;
  shade?: number;
  tint?: number;
  /** 主色（推导基准）。 */
  ref?: string;
  /** ThemeColor 槽位，1..10 对应 Accent1..Accent10。 */
  themeColor?: number;
}

export type FillType = "None" | "Solid" | "Gradient" | "Hatch" | "Picture";

export interface FillFormat {
  type: FillType;
  color?: ColorValue;
  /** 渐变：角度 + 色标。 */
  angle?: number;
  stops?: { pos: number; color: ColorValue }[];
}

export type LineStyle = "Solid" | "Dashes" | "None";

export interface LineFormat {
  weight?: number;
  cap?: "Flat" | "Round" | "Square";
  rounding?: number;
  style?: LineStyle;
  fill?: FillFormat;
  beginArrow?: number;
  endArrow?: number;
}

/** 主题上可被用户覆盖的样式；未覆盖的键由主题逐级推导（doc/复刻方案/00 §3.5）。 */
export interface ShapeStyle {
  fill?: FillFormat;
  line?: LineFormat;
  font?: FontSpec;
  /** 形状：圆角矩形 / 椭圆 / 气泡 / 方框……（"改变形状"面板）。 */
  geometry?: string;
  /** 该 Shape 用主题派生色时的分支序号（Rainbow 模式按分支取色）。 */
  colorRef?: number;
  /** 独立配色：一旦置位，主题切换不再影响它（StyleMask 的作用）。 */
  mask?: number;
}

export interface FontSpec {
  family?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  align?: 0 | 1 | 2; // 左 / 中 / 右
  lineSpacing?: number;
}

/** 富文本：`Text` 下的 `pp`（段）/ `tp`（run），样式挂在 Character / Paragraph 列表上按 IX 取。 */
export interface RichText {
  paragraphs: TextParagraph[];
  characters: FontSpec[];
}

export interface TextParagraph {
  /** 一个 pp：由若干 tp 组成，tp 只能共用同一套样式索引（实测 CX/PX 只表达换行位置）。 */
  runs: { text: string; charIx: number }[];
  align?: 0 | 1 | 2;
  indentFirst?: number;
}

export function plainText(rt: RichText): string {
  return rt.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n");
}

export function makeText(text: string): RichText {
  return {
    characters: [{ size: 12, family: "Verdana", color: "#333333" }],
    paragraphs: [{ runs: [{ text, charIx: 0 }], align: 1 }],
  };
}

/** 中心点 + 宽高 + 锚点。P/B 是 .emmx 的 Pivot/Bottom 标志，实测 P="0" B="1" 表示 X 取中心、B="2" 表示 Y 取中心。 */
export interface Transform {
  x: number; // 中心
  y: number;
  w: number;
  h: number;
}

export interface Hyperlink {
  kind: "web" | "file" | "topic" | "email";
  target: string;
  label?: string;
}

export interface ImageRef {
  relId: string;
  rid?: string;
  /** 相对主题的排版位置（实测在 Text/Transform 之外另有一组）。 */
  width?: number;
  height?: number;
}

export interface AttachmentRef {
  relId: string;
  name: string;
  size: number;
}

export interface CommentItem {
  author: string;
  text: string;
  at: number;
}

export interface MarkItem {
  /** 图标名（来自 MarkSheet / iconfont）。 */
  name: string;
  /** 序号，决定同一组里的显示顺序。 */
  pos: number;
}

export interface TableCell {
  text: string;
  colSpan?: number;
  rowSpan?: number;
  fill?: string;
  bold?: boolean;
}

export interface TableData {
  cols: number;
  rows: number;
  cells: TableCell[][];
}

export type TaskStatus = "todo" | "doing" | "done";
export type TaskPriority = "low" | "medium" | "high";

/** 看板任务字段（doc/复刻方案/00 §3.7）：负责人、起止、进度、优先级、标签。 */
export interface TaskData {
  assignees: string[];
  start?: number; // 毫秒
  finish?: number;
  duration?: number; // 天
  progress: number; // 0..100
  priority: TaskPriority;
  status: TaskStatus;
  tags: string[];
  milestone?: boolean;
}

export interface ShapeExtras {
  note?: string;
  hyperlink?: Hyperlink;
  image?: ImageRef;
  attachments?: AttachmentRef[];
  comments?: CommentItem[];
  labels?: string[];
  marks?: MarkItem[];
  formula?: { latex: string };
  table?: TableData;
  task?: TaskData;
  /** 双向链接目标主题 id（"@/" 或 "[[" 生成）。 */
  biLinks?: string[];
  /**
   * 覆盖层盖住的主题 id：外框（Type=Boundary）和概要大括号（Type=Summary）都用它。
   * 线格式是 `<BoundaryData><Shapes V="104;111;113"/></BoundaryData>`，分号分隔的主题 id，
   * 不是兄弟下标 —— 亿图里被盖住的主题可以跨分支、可以改顺序，下标模型表达不了。
   */
  covered?: string[];
  /** 编号（分支编号）。 */
  numbering?: string;
  /** 挂在这个主题上的标注框 id，按顺序编号（线格式 `<Callout V="182;183"/>`）。 */
  calloutIds?: string[];
  /** 折叠：只显示到本层。 */
  collapsed?: boolean;
}

export interface Shape {
  id: string;
  type: ShapeType;
  parentId: string | null;
  /** 顺序有意义：`.emmx` 的 SubLevel 就是按它排兄弟的。 */
  childIds: string[];
  text: RichText;
  transform: Transform;
  style: ShapeStyle;
  extras: ShapeExtras;
  /** 浮动主题的位置是用户拖出来的（其它主题的位置由布局引擎写回，见 P-2）。 */
  floating?: boolean;
}

export type LayoutCode =
  | "balanced" // 双向平衡
  | "logicRight" // 思维导图（右）
  | "logicLeft" // 思维导图（左）
  | "rightOnly" // 单向导图
  | "treeRight" // 树状图（右下）
  | "treeLeft" // 树状图（左下）
  | "treeUpRight" // 树状图（右上）
  | "treeUpLeft" // 树状图（左上）
  | "treeDownSym" // 树状图（向下对称）
  | "treeUpSym" // 树状图（向上对称）
  | "orgUp" // 组织结构图（向上）
  | "orgDown" // 组织结构图（向下）
  | "orgBoth" // 组织结构图（上下双向）
  | "radial" // 放射图
  | "fishboneLeft" // 鱼骨图（左）
  | "fishboneRight" // 鱼骨图（右）
  | "braceLeft" // 括号图（左）
  | "braceRight" // 括号图（右）
  | "matrix" // 矩阵图
  | "circlePacking" // 圆形图
  | "timelineVertical" // 时间轴（向下）
  | "timelineUp" // 时间轴（向上）
  | "timelineHorizontal" // 时间轴（向右）
  | "timelineLeft" // 时间轴（向左）
  | "timelineWinding" // 时间轴（S 形）
  | "free"; // 自由布局

/** .emmx 的 `<Layout V="n">` 数字码。亿图自己的语料里只出现过 6 / 7 / 8，认不出的码由 codec 原样带回。 */
export const LAYOUT_CODE_TO_NAME: Record<number, LayoutCode> = {
  6: "balanced",
  8: "logicRight",
};

export interface LayoutSpec {
  code: LayoutCode;
  /** 读到的 `<Layout V>` 原样数字码；写回时用它区分"这份文档本来就是那个码"。 */
  rawCode?: number;
  hSpacing: number;
  vSpacing: number;
  /** 主分支长度阈值（"显示层级数/分支长度"）。 */
  levelLength: number[];
  branchCount: number[];
  /** 彩虹色：同一主分支下用同一色。 */
  rainbow: boolean;
}

export interface PageProps {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  zoom: number;
  background?: FillFormat;
}

export interface PrintSetup {
  unit: "mm" | "inch" | "pixel";
  paperW: number;
  paperH: number;
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
  fitToSheet: boolean;
  printBackground: boolean;
}

export interface ThemeRef {
  id: number;
  name: string;
  /** 四个可独立混搭的子主题（doc/复刻方案/00 §2.5）。 */
  colorId: number;
  effectId: number;
  textId: number;
  shapeId: number;
  rainbow: boolean;
}

export interface RelationshipShape {
  id: string;
  beginId: string;
  endId: string;
  text: RichText;
  style: ShapeStyle;
}

export interface Page {
  id: string;
  name: string;
  rootId: string;
  shapes: Record<string, Shape>;
  /** 关系线是独立 Shape，但语义上是"两点之间"，单独存更好维护。 */
  relationships: RelationshipShape[];
  layout: LayoutSpec;
  props: PageProps;
  print: PrintSetup;
  theme: ThemeRef;
  /** 打开文档时的原始 XML 中未识别的部分，原样带回，避免二次保存丢字段。 */
  rawUnknown?: Record<string, unknown>;
  /**
   * 页面里已用过的最大数值 Shape ID，包含不进模型的 MMConnector / RelatConnector。
   * 实测亿图把主题与缓存连线的 ID 交叉编号（主题 101/102/104，连线 103/105…），
   * 新主题发号只看 shapes 就会撞上缓存连线的 ID。
   */
  maxShapeId?: number;
}

export interface DocProperties {
  version: string; // "7.2"
  docGuid: string;
  creator: string;
  modifier: string;
  createdDate: string;
  modifiedDate: string;
  platform: "win" | "mac" | "web";
  dpi: number;
  screenWidth: number;
  screenHeight: number;
  autoLayout: boolean;
  timelineWidth: number;
  calloutLayout: number;
}

export interface GanttOption {
  /** 周一..周日是否工作日，实测默认 "1;1;1;1;1;0;0"。 */
  workDay: number[];
  majorTick: number;
  minorTick: number;
  startDate: number;
  finishDate: number;
  /** 一天内的时刻（秒）：28800 = 08:00。 */
  startTime: number;
  finishTime: number;
  /** 单位宽度（像素/天），实测默认 100。 */
  unitWidth: number;
}

export interface MarkDefinition {
  name: string;
  label: string;
  group: string;
}

export interface DocumentModel {
  properties: DocProperties;
  pages: Page[];
  activePageId: string;
  gantt: GanttOption;
  markSheet: MarkDefinition[];
  /** media/ 目录里的资源（附件、图片），键是 zip 内相对路径。 */
  media: Record<string, Uint8Array>;
  /** 加密文档解密失败时的原始字节，UI 用它提示"文件已加密"。 */
  encrypted?: boolean;
  /** document.xml 里未映射到模型的节点原样带回，二次保存不丢字段。 */
  rawUnknown?: Record<string, unknown>;
}

/** 关系线在 .emmx 里也有 Transform/Geometries，但复刻里只关心端点与文字。 */
export type Projection = "mindmap" | "outline" | "kanban" | "slides" | "gantt" | "traverse";

export interface Selection {
  shapeIds: string[];
  anchorId: string | null;
  editingId: string | null;
}
