/**
 * 实测默认值与配额（doc/复刻方案/00 §4）。
 * 数字来源：`_research/extract/doc1/page_page.xml.txt` 的 XML 属性，以及
 * `qm-cn.tsv` 里 MindMaster 自己的提示文案（"免费版本可保存最大文件个数为10个文件"等）。
 * 复刻要把它们当业务规则实现（P-4：配额是一等公民），不是当魔法数字。
 */

export const DEFAULTS = {
  /** `<Layout><HSpacing V="30"/>` 兄弟水平间距 */
  hSpacing: 30,
  /** `<Layout><VSpacing V="30"/>` 层级垂直间距 */
  vSpacing: 30,
  /** 主分支长度阈值默认值 */
  levelLength: 180,
  branchCount: 4,

  fontFamily: "Verdana",
  fontSize: 12,
  textColor: "#333333",
  topicFill: "#96b3df",
  lineColor: "#c6c6c6",
  lineWeight: 1,
  rounding: 4,

  /** 主题盒子尺寸下限（实测中心主题 111×50，文字 72×20）。 */
  topicMinW: 40,
  topicMinH: 24,
  topicPadX: 12,
  topicPadY: 8,
  /** 文字换行宽度上限：超过就折行（"自定义主题文本宽度"）。 */
  topicMaxTextW: 400,

  pageW: 2904,
  pageH: 2820,
  zoom: 1,

  ganttUnitWidth: 100,
  ganttStartTime: 28800, // 08:00
  ganttFinishTime: 57600, // 16:00
  ganttWorkDay: [1, 1, 1, 1, 1, 0, 0],

  emmxVersion: "7.2",
  pageIdBase: 100,
  shapeIdBase: 101,
} as const;

/** 缩放档位，来自 Ribbon 缩放菜单的 8 个固定项。 */
export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4];

/** "显示层级数" 1..9。 */
export const DISPLAY_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * 界面主题的遍历顺序与中文名。
 * 放在 model 层而不是 ThemeContext 里，是因为原生菜单（services/appMenu.ts）也要列这三项，
 * 而菜单模块不该为了两个字符串去 import 一份带 antd 的 React 上下文。
 */
export const THEME_ORDER = ["light", "dark", "system"] as const;
export type ThemeMode = (typeof THEME_ORDER)[number];
export const THEME_LABEL: Record<ThemeMode, string> = {
  light: "浅色",
  dark: "深色",
  system: "跟随系统",
};

export const QUOTA = {
  /** 免费版最多保存的文件数（提示文案原文）。 */
  freeMaxFiles: 10,
  /** 1 点 AI 点数约生成 10 个汉字。 */
  aiCharsPerPoint: 10,
  /** 智能解析字数区间。 */
  parseWordMin: 50,
  parseWordMax: 4500,
  /** 社区发布：标题 / 描述长度上限。 */
  publishTitleMax: 80,
  publishDescMax: 500,
  /** 分享链接有效期档位（天），0 表示永久。 */
  shareExpireDays: [3, 7, 30, 0],
  /** 最近文件列表上限。 */
  recentMax: 20,
  /** 历史版本份数。 */
  historyMax: 10,
  /** 回收站保留天数。 */
  trashKeepDays: 30,
  /** 撤销栈深度：快照式撤销靠它兜住内存。 */
  undoMax: 100,
} as const;

/** 社区发布标题禁用字符，原文照抄自 UserPublishDialogTest 的校验提示。 */
export const ILLEGAL_TITLE_CHARS = [
  "?",
  "*",
  ":",
  '"',
  "<",
  ">",
  "\\",
  "/",
  "|",
  "$",
  "%",
  "^",
  "#",
  "&",
  "+",
];

/** 主题 ID：默认套用 Edraw 主色板（theme.xml 实测 Accent1..10 与 ID=31/3/8）。 */
export const DEFAULT_THEME = {
  id: 31,
  name: "Edraw",
  colorId: 3,
  effectId: 31,
  textId: 8,
  shapeId: 31,
  rainbow: false,
} as const;

/** 实测 Angel 色板（theme.xml `<ThemeColor Name="Angel" ID="3">`）。 */
export const ANGEL_ACCENTS = [
  "#5e84ff",
  "#5c9dff",
  "#cc7eb0",
  "#ef6653",
  "#6b74b7",
  "#f8ae1a",
  "#4badd0",
  "#00af54",
  "#f38590",
  "#4dc7bc",
];

/** 顺序即布局下拉框的顺序；叫法照参考软件的字符串（`_research/extract/qm-cn.tsv`）。 */
export const LAYOUT_LABELS: Record<string, string> = {
  balanced: "双向平衡导图",
  logicRight: "思维导图（右）",
  logicLeft: "思维导图（左）",
  rightOnly: "单向导图",
  logicClockwise: "思维导图（顺时针）",
  logicCounterclockwise: "思维导图（逆时针）",
  balancedDown: "双向平衡向下",
  treeRight: "树状图（右下）",
  treeLeft: "树状图（左下）",
  treeUpRight: "树状图（右上）",
  treeUpLeft: "树状图（左上）",
  treeDownSym: "树状图（向下对称）",
  treeUpSym: "树状图（向上对称）",
  orgUp: "组织结构图（向上）",
  orgDown: "组织结构图（向下）",
  orgBoth: "组织结构图（上下双向）",
  stagger: "交叉树",
  staggerUp: "交叉树向上",
  radial: "放射图",
  sunburst: "扇形放射图",
  fishboneLeft: "鱼骨图（左）",
  fishboneRight: "鱼骨图（右）",
  braceLeft: "括号图（左）",
  braceRight: "括号图（右）",
  matrix: "矩阵图",
  treeTableLeft: "树形表格（左侧标题）",
  treeTableTop: "树形表格（顶部标题）",
  circlePacking: "圆形图",
  bubbleMap: "气泡图",
  timelineVertical: "时间轴（向下）",
  timelineUp: "时间轴（向上）",
  timelineHorizontal: "时间轴（向右）",
  timelineLeft: "时间轴（向左）",
  timelineWinding: "时间轴（S 形）",
  flowRight: "流程图（右向）",
  flowLeft: "流程图（左向）",
  flowDown: "流程图（向下）",
  flowUp: "流程图（向上）",
  free: "自由布局",
};
