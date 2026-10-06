/**
 * 文档主 store。
 *
 * 一条树六个投影（P-1），所以这里只存"树 + 撤销栈 + 选中态"，
 * 投影、布局、样式全部在渲染时现算 —— 任何把 computeLayout 结果写回 model 的做法
 * 都会让 .emmx 里的 Transform 变成真相源，那是亿图自己都会算错的地方。
 *
 * 历史用整篇文档快照（history.ts 解释了为什么不做逆操作），store 里只持 HistoryState，
 * 所有写路径都必须走 mutate()，否则撤销栈会漏一步 —— 这是这类编辑器最难查的一类 bug。
 */
import { create } from "zustand";
import type { DocumentModel, LayoutCode, Page, Shape } from "../types/model.ts";
import { plainText } from "../types/model.ts";
import { createDocument, createPage } from "../model/factory.ts";
import { LAYOUT_LABELS } from "../model/constants.ts";
import { canRedo, canUndo, commit, createHistory, currentDoc, redo, reset, stackDepth, undo, type HistoryState } from "../engine/history.ts";
import { normalize } from "../engine/tree.ts";
import { parseEmmx, writeEmmx } from "../engine/emmx/codec.ts";
import { native } from "../services/native.ts";
import { useSettings } from "./settingsStore.ts";
import { useUi } from "./uiStore.ts";

/**
 * 选项页的"默认布局"：新建文档和新建画布都必须真的读它，否则那个下拉框就是个摆设。
 * 配置里是按字符串存的（Rust 的 config.json 也存字符串），所以先对着 LAYOUT_LABELS 验一遍，
 * 认不出的值退回 balanced，而不是让一个脏值把布局算成 NaN。
 */
function defaultLayout(): LayoutCode {
  const v = useSettings.getState().settings.format.defaultLayout;
  return v in LAYOUT_LABELS ? (v as LayoutCode) : "balanced";
}

export interface DocStoreState {
  hist: HistoryState | null;
  /** null = 还没存过盘的新文档。 */
  path: string | null;
  title: string;
  activePageId: string;
  selection: string[];
  focusId: string | null;
  /** 正在就地输入文字的主题 id；null 表示没有编辑框开着。 */
  editingId: string | null;
  /** 上一次写盘（或打开）的时刻，状态栏与备份按它显示时间。 */
  savedAt: number;
  /**
   * 上一次落盘的那一份文档快照。脏判定比的是**对象身份**而不是时间戳：
   * commit 每次都会 structuredClone，所以任何编辑都会让当前快照变成另一个对象；
   * 而撤销/重做回到旧快照时同样不等于落盘那份 —— 宁可多报脏，也不能漏报（漏报会丢用户的东西）。
   */
  savedDoc: DocumentModel | null;
  busy: boolean;
  error: string | null;
  /** 打开真实文件时收集到的解析告警，界面上要看得见，不能默默吞掉。 */
  warnings: string[];
}

export interface DocStoreActions {
  newDoc: (title?: string) => Promise<void>;
  openBytes: (bytes: Uint8Array, path: string | null, title?: string) => Promise<boolean>;
  /** 把一份已解析好的文档装进编辑器（打开 / 导入 / 恢复快照三条路径共用）。 */
  applyDoc: (doc: DocumentModel, path: string | null, title?: string) => boolean;
  openPath: (path: string) => Promise<boolean>;
  save: () => Promise<boolean>;
  saveAs: (path: string) => Promise<boolean>;
  /** 唯一的写入口：改 Page，提交历史。返回 false 表示没有打开文档。 */
  mutate: (label: string, fn: (page: Page) => Page, opts?: { coalesceMs?: number }) => boolean;
  /** 只改选中态/布局缓存这类不该进撤销栈的东西。 */
  patchPage: (fn: (page: Page) => Page) => void;
  /** 文档级写入口：画布的增删改名。页内编辑一律走 mutate，两者不要混用。 */
  mutateDoc: (label: string, fn: (doc: DocumentModel) => DocumentModel) => boolean;
  addPage: (name?: string) => void;
  renamePage: (id: string, name: string) => void;
  removePage: (id: string) => boolean;
  switchPage: (id: string) => void;
  select: (ids: string[], focusId?: string | null) => void;
  setEditing: (id: string | null) => void;
  undoStep: () => void;
  redoStep: () => void;
  setTitle: (title: string) => void;
  setError: (msg: string | null) => void;
}

type DocStore = DocStoreState & DocStoreActions;

export function pageOf(doc: DocumentModel, id: string): Page {
  return doc.pages.find((p) => p.id === id) ?? doc.pages[0];
}

/** 当前页；组件里几乎每个投影都要它。 */
export function activePage(s: DocStoreState): Page | undefined {
  if (!s.hist) return undefined;
  return pageOf(currentDoc(s.hist), s.activePageId);
}

export function activeDoc(s: DocStoreState): DocumentModel | undefined {
  return s.hist ? currentDoc(s.hist) : undefined;
}

export function shapeOf(page: Page | undefined, id: string): Shape | undefined {
  return page?.shapes[id];
}

/** 标题优先用文件名，其次用中心主题的文字 —— 亿图的工作台就是这么显示的。 */
function deriveTitle(path: string | null, page: Page | undefined, fallback: string): string {
  if (path) {
    const base = path.split(/[\\/]/).pop() ?? path;
    return base.replace(/\.emmx$/i, "");
  }
  const root = page?.shapes[page.rootId];
  if (root) return plainText(root.text) || fallback;
  return fallback;
}

export const useDoc = create<DocStore>((set, get) => ({
  hist: null,
  path: null,
  title: "未命名脑图",
  activePageId: "",
  selection: [],
  focusId: null,
  editingId: null,
  savedAt: 0,
  savedDoc: null,
  busy: false,
  error: null,
  warnings: [],

  async newDoc(title) {
    const doc = createDocument(title ?? "中心主题", defaultLayout());
    const now = Date.now();
    set({
      hist: createHistory(doc, "新建"),
      path: null,
      title: title ?? "未命名脑图",
      activePageId: doc.pages[0].id,
      selection: [doc.pages[0].rootId],
      focusId: doc.pages[0].rootId,
      editingId: null,
      savedAt: now,
      savedDoc: doc,
      error: null,
      warnings: [],
    });
    // 新建是一张干净的画布：上一份文档留下的 30% 不该跟着过来。
    useUi.getState().setZoom(1);
  },

  async openBytes(bytes, path, title) {
    set({ busy: true });
    try {
      const { doc, warnings } = await parseEmmx(bytes);
      const ok = get().applyDoc(doc, path, title);
      set({ warnings, busy: false });
      return ok;
    } catch (e) {
      set({ busy: false, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  /**
   * 把一份已经解析好的文档装进编辑器：打开 .emmx、导入文本、恢复自动保存快照都走这里。
   * 单独露出来是因为导入路径产出的 DocumentModel 根本不经过 parseEmmx，
   * 而"重置历史 + 归一化 + 选中根节点"这套动作只应该有一个人写。
   */
  applyDoc(doc, path, title) {
    // 读回来的双向索引不能信：normalize 自愈一次，之后所有原语都能假定树是干净的。
    const clean: DocumentModel = { ...doc, pages: doc.pages.map(normalize) };
    const first = clean.pages[0];
    if (!first) return false;
    set((s) => ({
      hist: reset(s.hist ?? createHistory(clean, "打开"), clean, "打开"),
      path,
      title: title ?? deriveTitle(path, first, "未命名脑图"),
      activePageId: first.id,
      selection: [first.rootId],
      focusId: first.rootId,
      editingId: null,
      // 导入 / 恢复出来的内容一律算"还没落盘"：savedAt 归零，脏标记立刻成立。
      savedAt: path ? Date.now() : 0,
      savedDoc: path ? clean : null,
      warnings: [],
      busy: false,
      error: null,
    }));
    if (path) void native.recentTouch(path, deriveTitle(path, first, "未命名脑图"), "local").catch(() => undefined);
    // 打开文档总要让视口归位，但归哪儿由选项决定：勾了"打开时自动适应画布"就把整张图装进窗口，
    // 没勾就照文件自己记的缩放（亿图把它写在 <Page Zoom>，我们一直在读，却从来没用上）。
    if (useSettings.getState().settings.format.autoFitOnOpen) useUi.getState().fitZoom();
    else useUi.getState().setZoom(first.props.zoom);
    return true;
  },

  async openPath(path) {
    set({ busy: true });
    try {
      const bytes = await native.fileReadBytes(path);
      set({ busy: false });
      return await get().openBytes(bytes, path);
    } catch (e) {
      set({ busy: false, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  async save() {
    const s = get();
    if (!s.hist) return false;
    if (!s.path) return await s.saveAs(`${s.title}.emmx`);
    return await s.saveAs(s.path);
  },

  async saveAs(path) {
    const s = get();
    if (!s.hist) return false;
    set({ busy: true });
    try {
      const doc = currentDoc(s.hist);
      const now = new Date();
      const stamp: DocumentModel = {
        ...doc,
        properties: {
          ...doc.properties,
          modifiedDate: isoLocal(now),
          // 另存为时把 DocID 换掉：两份文件同名不同内容，靠 GUID 区分历史版本。
          docGuid: path === s.path ? doc.properties.docGuid : newGuid(),
        },
      };
      const bytes = await writeEmmx(stamp);
      const r = await native.fileWriteBytes(path, bytes, true);
      // 覆盖前 Rust 侧已自动留一份兜底；这一步是"每次保存都进历史版本"，归选项里的开关管。
      // 关掉它只是不再累积历史版本，兜底备份仍在，误操作不至于直接丢文件。
      if (useSettings.getState().settings.save.backupOnSave) {
        await native.backupNow(path, stamp.pages[0].name, "save", bytes).catch(() => undefined);
      }
      const at = Date.now();
      set({
        hist: { ...s.hist, present: { ...s.hist.present, doc: stamp } },
        path: r.path,
        title: deriveTitle(path, stamp.pages[0], s.title),
        savedAt: at,
        savedDoc: stamp,
        busy: false,
        error: null,
      });
      void native.recentTouch(r.path, deriveTitle(path, stamp.pages[0], s.title), "local").catch(() => undefined);
      return true;
    } catch (e) {
      set({ busy: false, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  mutate(label, fn, opts) {
    const s = get();
    if (!s.hist) return false;
    const doc = currentDoc(s.hist);
    const page = pageOf(doc, s.activePageId);
    const next = normalizePage(doc, page, fn(page));
    set({
      hist: commit(s.hist, next, label, { coalesceMs: opts?.coalesceMs }),
      error: null,
      title: s.path ? s.title : deriveTitle(null, next.pages.find((p) => p.id === s.activePageId) ?? page, s.title),
    });
    return true;
  },

  patchPage(fn) {
    const s = get();
    if (!s.hist) return;
    const doc = currentDoc(s.hist);
    const page = pageOf(doc, s.activePageId);
    const next = normalizePage(doc, page, fn(page));
    set({ hist: { ...s.hist, present: { ...s.hist.present, doc: next } } });
  },

  mutateDoc(label, fn) {
    const s = get();
    if (!s.hist) return false;
    set({ hist: commit(s.hist, fn(currentDoc(s.hist)), label) });
    return true;
  },

  addPage(name) {
    const s = get();
    const doc = s.hist ? currentDoc(s.hist) : undefined;
    if (!doc) return;
    // 画布 id 必须全文档唯一：page.id 是页签的 key，也是 document.xml 里的引用。
    const used = doc.pages.map((p) => Number(p.id)).filter((n) => Number.isFinite(n));
    const id = String(Math.max(0, ...used) + 1);
    const page = { ...createPage(name ?? `画布${doc.pages.length + 1}`, defaultLayout()), id };
    if (get().mutateDoc("新建画布", (d) => ({ ...d, pages: [...d.pages, page] }))) {
      set({ activePageId: page.id, selection: [page.rootId], focusId: page.rootId, editingId: null });
    }
  },

  renamePage(id, name) {
    get().mutateDoc("重命名画布", (d) => ({
      ...d,
      pages: d.pages.map((p) => (p.id === id ? { ...p, name } : p)),
    }));
  },

  removePage(id) {
    const s = get();
    const doc = s.hist ? currentDoc(s.hist) : undefined;
    if (!doc || doc.pages.length <= 1) return false; // 亿图也不允许删掉最后一张画布
    if (!s.mutateDoc("删除画布", (d) => ({ ...d, pages: d.pages.filter((p) => p.id !== id) }))) return false;
    const rest = (get().hist ? currentDoc(get().hist!) : doc).pages;
    const next = rest.find((p) => p.id !== id) ?? rest[0];
    set({ activePageId: next.id, selection: [next.rootId], focusId: next.rootId, editingId: null });
    return true;
  },

  switchPage(id) {
    const s = get();
    const page = s.hist && pageOf(currentDoc(s.hist), id);
    set({ activePageId: id, selection: page ? [page.rootId] : [], focusId: page?.rootId ?? null, editingId: null });
  },

  select(ids, focusId) {
    set({ selection: ids, focusId: focusId === undefined ? ids[0] ?? null : focusId, editingId: null });
  },

  setEditing(id) {
    set({ editingId: id });
  },

  undoStep() {
    const s = get();
    if (!s.hist || !canUndo(s.hist)) return;
    const hist = undo(s.hist);
    set({ hist, ...realign(hist, s) });
  },

  redoStep() {
    const s = get();
    if (!s.hist || !canRedo(s.hist)) return;
    const hist = redo(s.hist);
    set({ hist, ...realign(hist, s) });
  },

  setTitle(title) {
    set({ title });
  },

  setError(msg) {
    set({ error: msg });
  },
}));

/** 撤销栈对不上当前页时（多页文档）把活动页拉回存在的页。 */
function realign(hist: HistoryState, s: DocStoreState): Partial<DocStoreState> {
  const doc = currentDoc(hist);
  if (doc.pages.some((p) => p.id === s.activePageId)) return {};
  const first = doc.pages[0];
  return { activePageId: first.id, selection: [first.rootId], focusId: first.rootId };
}

/** 把改过的 Page 放回 doc，并只 normalize 这一页（其余页原样留着，避免动到 rawUnknown 缓存）。 */
function normalizePage(doc: DocumentModel, page: Page, next: Page): DocumentModel {
  const pages = doc.pages.map((p) => (p.id === page.id ? normalize(next) : p));
  return { ...doc, pages };
}

/**
 * 脏 = 当前快照不是落盘那一份，比的是对象身份。
 *
 * 时间戳做不到这件事：撤销回旧版本后 present.at 仍然晚于 savedAt，按时间判脏会一直 true；
 * 反过来"保存后再撤销到落盘那一份"又会被判成干净而漏掉。误报只是多问一次，漏报会丢用户的东西。
 */
export function dirtyOf(s: DocStoreState): boolean {
  return s.hist ? currentDoc(s.hist) !== s.savedDoc : false;
}

export function depthOf(s: DocStoreState): { undo: number; redo: number } {
  return s.hist ? stackDepth(s.hist) : { undo: 0, redo: 0 };
}

function isoLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function newGuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
