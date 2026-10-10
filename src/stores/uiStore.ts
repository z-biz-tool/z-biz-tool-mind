/**
 * 界面状态：投影、视图工具、对话框、搜索。
 *
 * 与文档状态严格分开：这里每一项都不进撤销栈，也不影响 .emmx 内容。
 * 缩放和"显示层级数"在亿图里是每页的属性（Zoom 存在 <Page>，显示层级存 <Layout>），
 * 但它们更像"我现在想看多深"，所以放 UI 侧；真要落盘时由 docStore 的 patchPage 写回。
 */
import { create } from "zustand";
import { DISPLAY_LEVELS, ZOOM_STEPS } from "../model/constants.ts";
import type { ExportFormat } from "../engine/export/index.ts";

export type Projection = "mindmap" | "outline" | "kanban" | "slides" | "gantt" | "traverse";

export const PROJECTIONS: { id: Projection; label: string }[] = [
  { id: "mindmap", label: "思维导图" },
  { id: "outline", label: "大纲" },
  { id: "kanban", label: "看板" },
  { id: "slides", label: "幻灯片" },
  { id: "gantt", label: "甘特" },
  { id: "traverse", label: "浏览" },
];

export type DialogKind =
  "export" | "print" | "options" | "search" | "history" | "share" | "topicInfo" | "themes" | "aiTopic" | null;

interface UiState {
  projection: Projection;
  zoom: number;
  /** 1..9，亿图的"显示层级数"。 */
  displayLevels: number;
  /**
   * 关系线"打开时自动展开"的揭示表：页 id → 要在视图层强制展开的主题 id。
   * 只影响绘制（paintPage 在派生副本上摘 collapsed），模型与 .emmx 的 <Toggler> 不动；
   * applyDoc 每次装文档都整表重算，手动折叠会把 id 从表里摘掉（用户仍然可以真折叠）。
   */
  revealByPage: Record<string, string[]>;
  dialog: DialogKind;
  exportFormat: ExportFormat;
  searchOpen: boolean;
  searchQuery: string;
  /** 查找目标：主题正文 / 备注与评论 / 标签（§3.18 的三类）。 */
  inText: boolean;
  inNote: boolean;
  inLabel: boolean;
  /** 关掉时折叠遮住的主题不参与搜索，也不参与替换。 */
  includeHidden: boolean;
  /** false = 只搜当前页，true = 整份文件所有画布。 */
  searchAllPages: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** 搜索结果里的当前项下标；-1 表示还没跳过。 */
  activeMatch: number;
  startPage: boolean;
  sidebar: boolean;
  setProjection: (p: Projection) => void;
  setZoom: (z: number) => void;
  stepZoom: (dir: 1 | -1) => void;
  fitZoom: () => void;
  /** 每 +1 就让画布重新求一次"整张图装进视口"的缩放与位移。 */
  fitNonce: number;
  setDisplayLevels: (n: number) => void;
  setReveal: (map: Record<string, string[]>) => void;
  removeReveal: (pageId: string, id: string) => void;
  /**
   * AI 生成期间的画布锁（§3.13 机制层）：true 时 docStore 的 mutate/mutateDoc 一律拒绝，
   * 画布上再盖一层遮罩挡住指针。收放只在 services/ai.ts 的生成流程里，别处不要碰。
   */
  aiBusy: boolean;
  setAiBusy: (v: boolean) => void;
  openDialog: (d: DialogKind) => void;
  closeDialog: () => void;
  setExportFormat: (f: ExportFormat) => void;
  setSearch: (
    patch: Partial<
      Pick<
        UiState,
        | "searchQuery"
        | "inText"
        | "inNote"
        | "inLabel"
        | "includeHidden"
        | "searchAllPages"
        | "caseSensitive"
        | "wholeWord"
      >
    >
  ) => void;
  setActiveMatch: (i: number) => void;
  setStartPage: (v: boolean) => void;
  toggleSidebar: () => void;
}

export const useUi = create<UiState>((set, get) => ({
  projection: "mindmap",
  zoom: 1,
  displayLevels: 3,
  revealByPage: {},
  dialog: null,
  exportFormat: "png",
  searchOpen: false,
  searchQuery: "",
  inText: true,
  inNote: false,
  inLabel: false,
  includeHidden: false,
  searchAllPages: false,
  caseSensitive: false,
  wholeWord: false,
  activeMatch: -1,
  startPage: true,
  sidebar: true,
  fitNonce: 0,

  setProjection: (projection) => set({ projection, startPage: false }),
  setZoom: (zoom) => set({ zoom: Math.min(4, Math.max(0.25, zoom)) }),
  stepZoom: (dir) => {
    const steps = ZOOM_STEPS;
    const z = get().zoom;
    // 档位对齐实测的 8 档缩放菜单：不在档位上时先跳到最近的一档。
    let ix = steps.indexOf(z as (typeof steps)[number]);
    if (ix < 0) {
      ix = steps.reduce(
        (best, s, i) => (Math.abs(s - z) < Math.abs(steps[best] - z) ? i : best),
        0
      );
    } else {
      ix = Math.min(steps.length - 1, Math.max(0, ix + dir));
    }
    set({ zoom: steps[ix] });
  },
  /**
   * "适应画布"是一次请求，不是一次计算：视口尺寸和布局外框都只在 MindCanvas 手里，
   * 这里能做的只有按一下铃。（以前它直接写 zoom=1，于是"打开时自动适应画布"这个选项
   * 无论开关都没有区别，按钮上的百分比也只是骗自己。）
   */
  fitZoom: () => set((s) => ({ fitNonce: s.fitNonce + 1 })),
  setDisplayLevels: (n) =>
    set({ displayLevels: DISPLAY_LEVELS.includes(n) ? n : get().displayLevels }),
  setReveal: (revealByPage) => set({ revealByPage }),
  removeReveal: (pageId, id) =>
    set((s) => {
      const list = s.revealByPage[pageId];
      if (!list?.includes(id)) return s;
      return { revealByPage: { ...s.revealByPage, [pageId]: list.filter((x) => x !== id) } };
    }),
  aiBusy: false,
  setAiBusy: (aiBusy) => set({ aiBusy }),
  openDialog: (dialog) => set({ dialog, searchOpen: dialog === "search" }),
  closeDialog: () => set({ dialog: null, searchOpen: false }),
  setExportFormat: (exportFormat) => set({ exportFormat }),
  setSearch: (patch) => set({ ...patch, activeMatch: -1 }),
  setActiveMatch: (activeMatch) => set({ activeMatch }),
  setStartPage: (startPage) => set({ startPage }),
  toggleSidebar: () => set((s) => ({ sidebar: !s.sidebar })),
}));
