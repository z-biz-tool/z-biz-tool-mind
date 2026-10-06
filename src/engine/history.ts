/**
 * 快照式撤销（doc/复刻方案/00 §3.3：撤销/重做 100 步）。
 *
 * 为什么整份文档快照而不是命令式逆操作：这棵树的编辑原语太多
 * （插入/删除/升降级/跨分支移动/概要外框/样式/文本），逆操作要一一配对，
 * 漏一个就是"撤销之后树坏了"这种最难查的 bug。文档是纯数据，
 * structuredClone 一次几十 KB，配合 QUOTA.undoMax 截断，内存可控。
 */
import type { DocumentModel } from "../types/model.ts";
import { QUOTA } from "../model/constants.ts";
import { cloneDocument } from "../model/factory.ts";

export interface HistoryStep {
  doc: DocumentModel;
  label: string;
  /** 这一段编辑的起始时刻（合并成一段时是最早那一笔）。 */
  at: number;
  /** 这一段编辑的最后一笔时刻；未合并时与 at 相同。脏判定看这个，否则连续打字跨过保存点会被当成没改过。 */
  endAt: number;
}

export interface HistoryState {
  present: HistoryStep;
  past: HistoryStep[];
  future: HistoryStep[];
  /** 已合并到 present 的连续同标签编辑（打字不该产生 100 条记录）。 */
  coalesce: string | null;
}

export function createHistory(doc: DocumentModel, label = "打开"): HistoryState {
  const at = Date.now();
  const step: HistoryStep = { doc: cloneDocument(doc), label, at, endAt: at };
  return { present: step, past: [], future: [], coalesce: null };
}

export function currentDoc(state: HistoryState): DocumentModel {
  return state.present.doc;
}

/**
 * 提交一次编辑。`label` 相同且间隔小于 keepMs 时合并（连续输入同一主题的文字）。
 * 合并的语义是"只保留最新快照，但保留最早的时间戳"，撤销时整段回退。
 */
export function commit(
  state: HistoryState,
  doc: DocumentModel,
  label: string,
  opts: { limit?: number; coalesceMs?: number; at?: number } = {}
): HistoryState {
  const limit = opts.limit ?? QUOTA.undoMax;
  const keepMs = opts.coalesceMs ?? 700;
  const at = opts.at ?? Date.now();
  const step: HistoryStep = { doc: cloneDocument(doc), label, at, endAt: at };

  if (state.coalesce === label && at - state.present.at < keepMs) {
    // 时间戳取段首：合并的是"这一段连续打字"，跟着最后一次打字走的话，
    // 一直打字的用户这一段永远不超时，读 present.at 的地方（脏判定、距上次编辑）全都会算错。
    // endAt 仍跟着最后一笔走 —— 脏判定要的是"这段编辑最晚改于何时"。
    return { present: { ...step, at: state.present.at }, past: state.past, future: [], coalesce: label };
  }
  const past = [...state.past, state.present];
  while (past.length > limit - 1) past.shift(); // 丢最老的，栈深恒定
  return { present: step, past, future: [], coalesce: label };
}

export function canUndo(state: HistoryState): boolean {
  return state.past.length > 0;
}

export function canRedo(state: HistoryState): boolean {
  return state.future.length > 0;
}

export function undo(state: HistoryState): HistoryState {
  const prev = state.past[state.past.length - 1];
  if (!prev) return state;
  return {
    present: prev,
    past: state.past.slice(0, -1),
    future: [state.present, ...state.future],
    coalesce: null,
  };
}

export function redo(state: HistoryState): HistoryState {
  const next = state.future[0];
  if (!next) return state;
  return {
    present: next,
    past: [...state.past, state.present].slice(-QUOTA.undoMax),
    future: state.future.slice(1),
    coalesce: null,
  };
}

/** 外部改了当前文档但不想进撤销栈（例如自动布局写回坐标）。 */
export function replacePresent(state: HistoryState, doc: DocumentModel): HistoryState {
  return { ...state, present: { ...state.present, doc: cloneDocument(doc) }, coalesce: null };
}

/** 换文件：栈清空，并把"保存点"标记交给 UI 判断脏不脏。 */
export function reset(state: HistoryState, doc: DocumentModel, label = "打开"): HistoryState {
  void state;
  return createHistory(doc, label);
}

/**
 * 脏 = 当前这份快照比保存点新。
 * 只看 present 自己的时间戳，不看 past 长度：撤销回到保存点之后，past 里仍然留着保存前
 * 那几步，用"栈非空即脏"会让标题栏一直亮着"未保存"，关文件时白问一次。
 */
export function isDirty(state: HistoryState, savedAt: number): boolean {
  return state.present.endAt > savedAt;
}

export function stackDepth(state: HistoryState): { undo: number; redo: number } {
  return { undo: state.past.length, redo: state.future.length };
}

/**
 * 撤销按钮的文案是"将被撤销的那次操作"，也就是 present 自己的 label；
 * past 最后一步是撤销之后要回到的状态，拿它当文案会永远滞后一步。
 */
export function undoLabel(state: HistoryState): string | null {
  return state.past.length ? state.present.label : null;
}

export function redoLabel(state: HistoryState): string | null {
  return state.future.length ? state.future[0].label : null;
}
