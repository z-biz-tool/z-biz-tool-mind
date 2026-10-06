/**
 * 快照式撤销/重做（doc/复刻方案/00 §3.3：撤销 100 步；QUOTA.undoMax 兜内存）。
 *
 * 覆盖的缺陷形状：
 * 1) 快照必须是深拷贝：调用方之后就地改 doc（含 media 的 Uint8Array）不能污染历史；
 * 2) 空栈 undo/redo 返回同一个对象（状态不可变性），canUndo/canRedo 与栈深一致；
 * 3) 新提交必须丢弃 redo 分支（否则"撤销-新编辑-重做"会拼出岔路的树）；
 * 4) 同标签 700ms 内合并成一步（打字），换标签或超时立刻另起一步；
 * 5) 栈深上限丢最老的，保留最近的；
 * 6) isDirty 与保存点 savedAt 的关系；
 * 7) undoLabel/redoLabel 的按钮文案。
 */
import { done, eq, ok } from "./_harness.ts";
import { createDocument } from "../src/model/factory.ts";
import {
  canRedo,
  canUndo,
  commit,
  createHistory,
  currentDoc,
  isDirty,
  redo,
  redoLabel,
  replacePresent,
  reset,
  stackDepth,
  undo,
  undoLabel,
  type HistoryState,
} from "../src/engine/history.ts";
import { QUOTA } from "../src/model/constants.ts";
import type { DocumentModel } from "../src/types/model.ts";

/** 每步给一个可辨认的文档（改活动页 id），断言"撤回到哪一步"就看这个字段。 */
const docAt = (base: DocumentModel, tag: string): DocumentModel => ({ ...base, activePageId: tag });
const tagOf = (s: HistoryState): string => currentDoc(s).activePageId;
const depth = (s: HistoryState) => stackDepth(s);

const base = createDocument("历史");

// ---------------------------------------------------------------- 初始与空栈
{
  const h = createHistory(base, "打开");
  eq("初始没有可撤销/可重做", [canUndo(h), canRedo(h)], [false, false]);
  eq("初始栈深 0/0", stackDepth(h), { undo: 0, redo: 0 });
  eq("present 就是打开时的那份", tagOf(h), "100");
  eq("标签取自 label", h.present.label, "打开");
  eq("空栈 undo 返回同一个对象（不产生新状态）", undo(h) === h, true);
  eq("空栈 redo 返回同一个对象", redo(h) === h, true);
  eq("刚打开不脏", isDirty(h, h.present.at), false);
}

// ---------------------------------------------------------------- commit：入栈与深拷贝隔离
{
  const src = createDocument("原件");
  src.media["a.png"] = new Uint8Array([1, 2, 3]);
  let h = createHistory(src, "打开");
  h = commit(h, docAt(src, "第一步"), "插入主题", { at: 1000 });
  eq("提交后 present 是新文档", tagOf(h), "第一步");
  eq("提交把旧 present 压进 past", depth(h), { undo: 1, redo: 0 });
  eq("present 的 label 是本次操作", h.present.label, "插入主题");
  eq("present 的 at 用调用方给的时间戳", h.present.at, 1000);
  // 快照必须是深拷贝：调用方之后就地改原对象，历史里不能有动静
  (src.media["a.png"] as Uint8Array)[0] = 99;
  src.pages[0].name = "被改名为污染";
  const snap = currentDoc(h);
  eq("media 字节是副本（改原件不动历史）", snap.media["a.png"]?.[0], 1);
  eq("pages 是副本", snap.pages[0].name, "原件");
  eq("历史里的文档与调用方的不是同一引用", snap === src, false);
}

// ---------------------------------------------------------------- undo / redo 往返
{
  let h = createHistory(base, "打开");
  for (let i = 1; i <= 4; i++) h = commit(h, docAt(base, `第${i}步`), `操作${i}`, { at: i * 5000 });
  eq("四步之后栈深", depth(h), { undo: 4, redo: 0 });
  const u1 = undo(h);
  eq("撤销一步回到上一步的内容", tagOf(u1), "第3步");
  eq("撤销把来路放进 future", depth(u1), { undo: 3, redo: 1 });
  ok("redo 是对称的（同一份文档对象）", currentDoc(redo(u1)) === currentDoc(h));
  let cur = h;
  while (canUndo(cur)) cur = undo(cur);
  eq("一路撤到底 = 打开时的那份", tagOf(cur), "100");
  eq("撤到底 future 有 4 步", stackDepth(cur).redo, 4);
  let up = cur;
  while (canRedo(up)) up = redo(up);
  eq("一路重做到顶", tagOf(up), "第4步");
  eq("来回一趟文档对象没变", currentDoc(up) === currentDoc(h), true);
}

// ---------------------------------------------------------------- commit 丢弃 redo 分支
{
  let h = createHistory(base, "打开");
  h = commit(h, docAt(base, "A"), "编辑A", { at: 1000 });
  h = commit(h, docAt(base, "B"), "编辑B", { at: 6000 });
  const u = undo(h);
  eq("撤销后有可重做", stackDepth(u).redo, 1);
  const branched = commit(u, docAt(base, "C"), "编辑C", { at: 11000 });
  eq("新编辑清空 redo 分支", stackDepth(branched).redo, 0);
  eq("新分支之后没有 redoLabel", redoLabel(branched), null);
  eq("分支内容是新提交", tagOf(branched), "C");
}

// ---------------------------------------------------------------- 连续打字合并（coalesce）
{
  let h = createHistory(base, "打开");
  h = commit(h, docAt(base, "ab"), "输入文字", { at: 0 });
  h = commit(h, docAt(base, "abc"), "输入文字", { at: 300 });
  h = commit(h, docAt(base, "abcd"), "输入文字", { at: 600 });
  eq("同标签 700ms 内的连续提交合成一步（现状）", stackDepth(h).undo, 1);
  eq("合并保留的是最新快照", tagOf(h), "abcd");
  // 合并段的时间戳必须钉在段首（历史曾把 present.at 跟着最后一次打字走，窗口永不超时）：
  // 这里 0→300→600 三连打字仍是一步，且 at 仍是第一笔的 0 —— 脏判定/距上次编辑都读它
  eq("合并组的时间戳是最早那一笔（窗口不滑动）", h.present.at, 0);
  const switched = commit(h, docAt(base, "换操作"), "插入主题", { at: 700 });
  eq("换标签立刻另起一步", stackDepth(switched).undo, 2);
  const timeout = commit(h, docAt(base, "隔很久"), "输入文字", { at: 5000 });
  eq("超过 700ms 另起一步", stackDepth(timeout).undo, 2);
  const never = commit(h, docAt(base, "禁用合并"), "输入文字", { at: 610, coalesceMs: 0 });
  eq("coalesceMs 0 = 禁用合并", stackDepth(never).undo, 2);
  eq("撤销把合并组标记清掉", undo(h).coalesce, null);
  const afterUndo = undo(h);
  const retype = commit(afterUndo, docAt(base, "又打字"), "输入文字", { at: 900 });
  eq("撤销后同样标签也不与旧组合并", stackDepth(retype).undo, 1);
}

// ---------------------------------------------------------------- 栈深上限
{
  let h = createHistory(base, "打开");
  for (let i = 1; i <= 12; i++) h = commit(h, docAt(base, `步${i}`), `操作${i}`, { at: i * 5000, limit: 3 });
  eq("limit 3 时 past 最长 2（present+past=3 份快照）", stackDepth(h).undo, 2);
  eq("丢的是最老的（past 只留最近两步）", h.past.map((p) => p.label), ["操作10", "操作11"]);
  eq("两步之外就撤不到了", canUndo(undo(undo(h))), false);
  let big = createHistory(base, "打开");
  for (let i = 0; i < 130; i++) big = commit(big, docAt(base, `步${i}`), `操作${i}`, { at: i * 5000 });
  eq("默认上限走 QUOTA.undoMax", stackDepth(big).undo, QUOTA.undoMax - 1);
  eq("保留的是最近的 99 步", big.past[big.past.length - 1].label, "操作128");
  eq("limit 1 时不留撤销栈", stackDepth(commit(createHistory(base, "打开"), base, "唯一步", { at: 1000, limit: 1 })).undo, 0);
}

// ---------------------------------------------------------------- isDirty 与保存点
{
  let h = createHistory(base, "打开");
  h = commit(h, docAt(base, "已保存"), "编辑一", { at: 1000 });
  const savedAt = h.present.at;
  h = commit(h, docAt(base, "未保存"), "编辑二", { at: 2000 });
  eq("保存之后再编辑就是脏", isDirty(h, savedAt), true);
  const back = undo(h);
  // 引擎缺陷：isDirty 把 "past 非空" 也当作脏 —— 撤销回到保存点（present.at == savedAt）
  // 之后 past 里还留着保存前的那些步，标题栏仍然亮"未保存"，关文件会多问一次
  eq("撤销回到保存点就不该再报脏", isDirty(back, savedAt), false);
  eq("撤销回到保存点的内容确实一致", tagOf(back), "已保存");
  eq("重做回去又变脏", isDirty(redo(back), savedAt), true);
}

// ---------------------------------------------------------------- undoLabel / redoLabel
{
  let h = createHistory(base, "打开");
  h = commit(h, docAt(base, "A"), "插入主题", { at: 1000 });
  eq("没撤销过的时候没有 redoLabel", redoLabel(h), null);
  // 引擎缺陷：undoLabel 取的是 past 最后一步（"将要回到的状态"），与 redoLabel 取
  // future[0]（"将要重做的操作"）语义不对称 → 撤销按钮文案永远滞后一步，这里显示"打开"而不是"插入主题"
  eq("undoLabel 应显示将被撤销的那次操作", undoLabel(h), "插入主题");
  const u = undo(h);
  eq("redoLabel 显示将被重做的操作", redoLabel(u), "插入主题");
  eq("撤到底没有可撤销的标签", undoLabel(u), null);
}

// ---------------------------------------------------------------- replacePresent / reset
{
  let h = createHistory(base, "打开");
  h = commit(h, docAt(base, "用户编辑"), "编辑", { at: 1000 });
  const laid = replacePresent(h, docAt(base, "布局回写"));
  eq("replacePresent 不增加栈深", stackDepth(laid).undo, stackDepth(h).undo);
  eq("replacePresent 换掉当前文档", tagOf(laid), "布局回写");
  eq("replacePresent 保留原 label", laid.present.label, h.present.label);
  eq("replacePresent 保留原时间戳（不算用户编辑）", laid.present.at, h.present.at);
  eq("replacePresent 之后仍可撤销", tagOf(undo(laid)), "100");
  eq("重做回到回写后的内容", tagOf(redo(undo(laid))), "布局回写");
  const fresh = reset(laid, docAt(base, "新文件"), "打开新文件");
  eq("换文件把两个栈都清空", stackDepth(fresh), { undo: 0, redo: 0 });
  eq("换文件的 label 可自定义", fresh.present.label, "打开新文件");
  eq("换文件后内容是新文档", tagOf(fresh), "新文件");
}

done();
