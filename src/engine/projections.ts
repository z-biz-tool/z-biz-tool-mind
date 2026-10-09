/**
 * 六个投影里的四个：大纲 / 看板 / 幻灯片 / 甘特 / 演讲遍历（doc/复刻方案/00 §0.3 P-1）。
 *
 * 这里全部是 `Page -> 只读视图` 的纯函数，没有一处写回树。
 * 用户在某个投影里做的操作（拖卡片、改进度）由 store 翻译成 tree 原语，
 * 再重新计算投影 —— 这样六种视图永远不会互相打架。
 */
import type { GanttOption, Page, Shape, TaskStatus } from "../types/model.ts";
import { plainText } from "../types/model.ts";
import { children, descendants } from "./tree.ts";
import { outlineEntries } from "./outline.ts";
import { QUOTA } from "../model/constants.ts";

// ---------------------------------------------------------------- 大纲

export interface OutlineRow {
  id: string;
  level: number;
  text: string;
  type: Shape["type"];
  hasChildren: boolean;
  collapsed: boolean;
  /** 折叠起来时藏了多少个子孙，行尾的 "+3" 徽标。 */
  hiddenCount: number;
}

/**
 * 大纲面板的行。行序一律取自 engine/outline 的 outlineEntries ——
 * 面板与"复制大纲/导出文本"必须数出同一批行，两份各自的 DFS 迟早会分叉（P-1）。
 */
export function outlineRows(page: Page): OutlineRow[] {
  return outlineEntries(page).map(({ id, level, shape }) => ({
    id,
    level,
    text: plainText(shape.text),
    type: shape.type,
    hasChildren: shape.childIds.length > 0,
    collapsed: Boolean(shape.extras.collapsed),
    hiddenCount: shape.extras.collapsed ? descendants(page, id).length : 0,
  }));
}

/** 大纲里第 n 行对应树里的哪个 id —— 键盘上下键与画布选中共用一套索引。 */
export function outlineIndexToId(page: Page, row: number): string | null {
  return outlineRows(page)[row]?.id ?? null;
}

// ---------------------------------------------------------------- 看板

export interface KanbanCard {
  id: string;
  title: string;
  columnId: string;
  assignees: string[];
  priority: string;
  progress: number;
  due?: number;
  /** 里程碑（§3.5 任务部件）：甘特画菱形、看板打标。 */
  milestone?: boolean;
  tags: string[];
  subCount: number;
  status: TaskStatus;
}

/** 看板排序键。manual = 树序（投影永远可退回的基准，排序不写树）。 */
export type KanbanSortKey = "manual" | "title" | "due" | "priority";

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/**
 * 卡片排序。只影响看板这一层的展示顺序，树一个字节都不动（P-1：投影无状态）。
 * 截止日那条特殊：没填日期的卡片永远垫底 —— 升序时它们本来就最大，降序翻转会沉到最前，
 * "最紧急的排最后"不是任何一种用法。
 */
export function sortCards(cards: KanbanCard[], key: KanbanSortKey, dir: 1 | -1 = 1): KanbanCard[] {
  if (key === "manual") return cards;
  const arr = [...cards];
  arr.sort((a, b) => {
    if (key === "title") return dir * a.title.localeCompare(b.title, "zh");
    if (key === "priority") return dir * ((PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1));
    if (!a.due && !b.due) return 0;
    if (!a.due) return 1;
    if (!b.due) return -1;
    return dir * (a.due - b.due);
  });
  return arr;
}

/** 卡片筛选：标题或标签包含关键字（不区分大小写），标签可再精确卡一道。 */
export function filterCards(cards: KanbanCard[], f: { text?: string; tag?: string }): KanbanCard[] {
  const text = f.text?.trim().toLowerCase();
  return cards.filter((c) => {
    if (text && !c.title.toLowerCase().includes(text) && !c.tags.some((t) => t.toLowerCase().includes(text)))
      return false;
    if (f.tag && !c.tags.includes(f.tag)) return false;
    return true;
  });
}

export interface KanbanColumn {
  id: string;
  name: string;
  cards: KanbanCard[];
  /** 列本身的完成度，取卡片的平均值。 */
  progress: number;
}

const STATUS_ORDER: TaskStatus[] = ["todo", "doing", "done"];

function statusOf(s: Shape): TaskStatus {
  return s.extras.task?.status ?? "todo";
}

/**
 * 进度只有一个定义：标了完成就是 100%（勾完任务的人通常不会再去填百分数）。
 * 看板与甘特共用这一个函数 —— 同一主题在两个投影里读出两个百分比就是 P-1 破口。
 */
function progressOf(s: Shape): number {
  const p = s.extras.task?.progress ?? 0;
  return statusOf(s) === "done" ? Math.max(p, 100) : p;
}

/** 自由主题（浮动主题）不在中心主题的子树里，但它们的任务同样是任务：投影要接住，不能整支丢掉。 */
function floatingRoots(page: Page): Shape[] {
  return Object.values(page.shapes).filter((s) => s.floating && !s.parentId);
}

export function kanbanBoard(page: Page): KanbanColumn[] {
  const roots = [...children(page, page.rootId), ...floatingRoots(page)];
  return roots.map((col) => {
    const cards: KanbanCard[] = [];
    for (const c of children(page, col.id)) {
      cards.push({
        id: c.id,
        title: plainText(c.text),
        columnId: col.id,
        assignees: c.extras.task?.assignees ?? [],
        priority: c.extras.task?.priority ?? "medium",
        progress: progressOf(c),
        due: c.extras.task?.finish,
        milestone: c.extras.task?.milestone ?? false,
        tags: c.extras.labels ?? c.extras.task?.tags ?? [],
        subCount: c.childIds.length,
        status: statusOf(c),
      });
    }
    const done = cards.filter((k) => k.status === "done").length;
    return {
      id: col.id,
      name: plainText(col.text),
      cards,
      progress: cards.length ? Math.round((done / cards.length) * 100) : 0,
    };
  });
}

/** 看板泳道模式：按状态分列，而不是按主分支分列。 */
export function kanbanByStatus(page: Page): { status: TaskStatus; cards: KanbanCard[] }[] {
  const all: KanbanCard[] = [];
  for (const col of kanbanBoard(page)) all.push(...col.cards);
  return STATUS_ORDER.map((status) => ({ status, cards: all.filter((c) => c.status === status) }));
}

export function kanbanColumnGuard(page: Page): { ok: boolean; reason?: string } {
  // 数的是真实会画出来的列：主分支 + 浮动主题列
  const n = children(page, page.rootId).length + floatingRoots(page).length;
  if (n > QUOTA.freeMaxFiles) {
    return { ok: false, reason: `看板列数上限 ${QUOTA.freeMaxFiles}，请合并主分支` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- 幻灯片

export interface SlideBlock {
  id: string;
  index: number;
  title: string;
  /** 要点：主分支的下两级，第三级缩进。 */
  bullets: { text: string; level: number; id: string }[];
  notes: string;
}

export function slideDeck(page: Page): SlideBlock[] {
  const cover: SlideBlock = {
    id: page.rootId,
    index: 0,
    title: plainText(page.shapes[page.rootId]?.text ?? { paragraphs: [], characters: [] }),
    bullets: [],
    notes: page.shapes[page.rootId]?.extras.note ?? "",
  };
  const out: SlideBlock[] = [cover];
  for (const branch of children(page, page.rootId)) {
    const bullets: SlideBlock["bullets"] = [];
    for (const c of children(page, branch.id)) {
      bullets.push({ text: plainText(c.text), level: 0, id: c.id });
      for (const g of children(page, c.id)) bullets.push({ text: plainText(g.text), level: 1, id: g.id });
    }
    out.push({
      id: branch.id,
      index: out.length,
      title: plainText(branch.text),
      bullets,
      notes: branch.extras.note ?? "",
    });
  }
  return out;
}

// ---------------------------------------------------------------- 甘特

export interface GanttBar {
  id: string;
  name: string;
  depth: number;
  /** 相对甘特起点的偏移，单位：天（可为负，UI 端裁剪）。 */
  offsetDays: number;
  lengthDays: number;
  progress: number;
  assignees: string[];
  milestone: boolean;
  isSummary: boolean;
}

const DAY_MS = 86_400_000;

/**
 * 有时间字段就按时间排；没有就按"同层顺序依次推"合成一条时间线。
 * 亿图的甘特视图在用户没填日期时是空的，复刻里给它一个可见的默认，
 * 是为了让"从导图切到甘特"这一步永远有反馈。
 */
export function ganttSchedule(page: Page, gantt: GanttOption): GanttBar[] {
  const out: GanttBar[] = [];
  const baseMs = gantt.startDate || Date.now();
  const cursor: number[] = [];
  const walk = (id: string, depth: number) => {
    const s = page.shapes[id];
    if (!s || s.id === page.rootId) {
      for (const c of children(page, id)) walk(c.id, depth);
      return;
    }
    const task = s.extras.task;
    const length = Math.max(0.25, task?.duration ?? 1);
    let offsetDays: number;
    if (task?.start !== undefined) {
      offsetDays = (task.start - baseMs) / DAY_MS;
    } else {
      offsetDays = cursor[depth] ?? 0;
      cursor[depth] = offsetDays + length;
      cursor.length = depth + 1;
    }
    out.push({
      id,
      name: plainText(s.text),
      depth,
      offsetDays,
      lengthDays: length,
      progress: progressOf(s),
      assignees: task?.assignees ?? [],
      milestone: Boolean(task?.milestone),
      isSummary: s.childIds.length > 0,
    });
    const self = out[out.length - 1];
    for (const c of children(page, id)) walk(c.id, depth + 1);
    // 父条要罩住子条：两端都跟着抬，只加长度的话子条比父条早开工时父条整条画错位置。
    // 只有挂了任务的主题才有自己的排期；没挂任务的是一行占位，合成出来的 1 天不该被撑开。
    if (task && self.isSummary) {
      for (const k of children(page, id)) {
        const kb = out.find((x) => x.id === k.id);
        if (!kb) continue;
        const start = Math.min(self.offsetDays, kb.offsetDays);
        self.lengthDays = Math.max(self.lengthDays, kb.offsetDays + kb.lengthDays - start);
        self.offsetDays = start;
      }
    }
  };
  walk(page.rootId, 0);
  for (const f of floatingRoots(page)) walk(f.id, 0);
  return out;
}

/** 甘特横轴刻度：跳过非工作日，和 gantt.workDay 一致。 */
export function ganttTicks(bars: GanttBar[], gantt: GanttOption): { days: number; unitWidth: number; total: number } {
  const min = Math.min(0, ...bars.map((b) => b.offsetDays));
  const max = Math.max(1, ...bars.map((b) => b.offsetDays + b.lengthDays));
  const days = Math.ceil(max - Math.floor(min));
  return { days, unitWidth: gantt.unitWidth, total: days * gantt.unitWidth };
}

/** 日期是否落在工作日（workDay 以周一为首位，实测默认 1;1;1;1;1;0;0）。 */
export function isWorkDay(baseMs: number, offsetDays: number, workDay: number[]): boolean {
  const ms = baseMs + Math.round(offsetDays) * DAY_MS;
  const dow = (new Date(ms).getDay() + 6) % 7; // 0 = 周一
  return (workDay[dow] ?? 1) === 1;
}

// ---------------------------------------------------------------- 演讲 / 遍历

/** 演讲模式顺序：可见子树的前序遍历，和大纲行序完全一致。 */
export function traverseSequence(page: Page): string[] {
  return outlineRows(page).map((r) => r.id);
}

/** 遍历到第 n 步时，应当高亮哪个祖先分支（下钻模式用）。 */
export function traverseFocus(page: Page, shapeId: string): string {
  let id = shapeId;
  for (;;) {
    const s = page.shapes[id];
    if (!s || !s.parentId || s.parentId === page.rootId) return id;
    id = s.parentId;
  }
}

export function printPagePlan(page: Page, perSlide: number): string[][] {
  const seq = traverseSequence(page).filter((id) => id !== page.rootId);
  const out: string[][] = [];
  for (let i = 0; i < seq.length; i += Math.max(1, perSlide)) out.push(seq.slice(i, i + Math.max(1, perSlide)));
  return out;
}
