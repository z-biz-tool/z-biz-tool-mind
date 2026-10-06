/**
 * 查找替换（doc/复刻方案/00 §3.18：区分大小写、全字匹配、含隐藏（折叠）内容）。
 *
 * 这里刻意覆盖的缺陷形状：
 * 1) 大小写开关只作用于拉丁字母，中文不受影响；
 * 2) 全字匹配不能吃前后缀（OrderService 不该被 Order 命中），
 *    但中英混排里的英文段（"AI助手" 里的 AI）在亿图里是可整词命中的；
 * 3) 命中偏移必须是"该字段内的偏移"：正文与备注共用一条 haystack 时不能把偏移串位；
 * 4) 结果顺序被遍历列表与大纲高亮共用，必须稳定（按 id 数值 + 偏移）；
 * 5) 替换走 updateText，会压平段内混排（模块自述的取舍），但计数要等于命中数；
 * 6) 跳转命中前必须展开折叠的祖先，否则"搜到了却看不见"；
 * 7) 正则元字符按字面量处理，用户输入 `(退款)` 不能当分组；
 * 8) §3.18 的查找目标写明「主题 / 注释·评论 / 标签」，标签目前是漏的。
 */
import { done, eq, ok } from "./_harness.ts";
import { createPage } from "../src/model/factory.ts";
import { insertChild, setCollapsed, updateExtras } from "../src/engine/tree.ts";
import { findMatches, matchCount, replaceAll, revealShape, stepIndex } from "../src/engine/search.ts";
import { outlineRows } from "../src/engine/projections.ts";
import { plainText, type Page, type ShapeExtras } from "../src/types/model.ts";

let pg = createPage("查找");
const add = (parent: string, text: string, extras: ShapeExtras = {}): string => {
  const r = insertChild(pg, parent, text);
  pg = extras.note || extras.labels ? updateExtras(r.page, r.id, extras) : r.page;
  return r.id;
};
const order = add("101", "Order 模块");
const order2 = add("101", "order 明细");
const mixed = add("101", "AI助手");
const service = add(order, "订单管理 OrderService");
const refundEntry = add("101", "退款入口", { note: "refund 规则说明 refund 走审批" });
const refundText = add(refundEntry, "对账 refund");
const long = add("101", `${"前".repeat(25)}needle${"后".repeat(25)}`);
const brackets = add("101", "（退款）手续费");
const deep = add("101", "层级");
const deepChild = add(deep, "隐藏的命中词");

const ids = (page: Page, q: string, opts = {}): string[] => findMatches(page, q, opts).map((m) => m.shapeId);
const spots = (page: Page, q: string, opts = {}): string[] => findMatches(page, q, opts).map((m) => `${m.shapeId}:${m.start}:${m.field}`);

// ---------------------------------------------------------------- 命中与开关
{
  eq("空查询不命中任何东西", findMatches(pg, "").length, 0);
  eq("默认忽略大小写（Order/order 都算）", ids(pg, "order"), [order, order2, service]);
  eq("区分大小写只留完全一致的那条", ids(pg, "order", { caseSensitive: true }), [order2]);
  eq("全字匹配不能吃后缀（OrderService 不算）", ids(pg, "Order", { caseSensitive: true, wholeWord: true }), [order]);
  eq("全字匹配对独立单词仍命中且仍忽略大小写", ids(pg, "order", { wholeWord: true }), [order, order2]);
  eq("非整词模式下中英混排正常命中", ids(pg, "AI"), [mixed]);
  // 引擎缺陷：search.ts:35 把 \\u4e00-\\u9fff 也当成"单词字符"，中英混排的英文段两头都被
  // 前后查断言拦住 → 用户搜 "AI" 一个都找不到（亿图实测能命中）
  eq("中英混排里的英文段要能整词命中", ids(pg, "AI", { wholeWord: true }), [mixed]);
  eq("正则元字符按字面量处理", [findMatches(pg, ".").length, findMatches(pg, "订.*单").length, ids(pg, "（退款）"), ids(pg, "(退款)")], [0, 0, [brackets], []]);
}

// ---------------------------------------------------------------- 备注、偏移与顺序
{
  eq("不开 inNote 时备注不参与", ids(pg, "refund"), [refundText]);
  const inNote = findMatches(pg, "refund", { inNote: true });
  eq("备注命中要标 field=note 且偏移相对备注本身", inNote.filter((m) => m.field === "note").map((m) => `${m.shapeId}:${m.start}:${m.length}`), [`${refundEntry}:0:6`, `${refundEntry}:12:6`]);
  eq("正文命中偏移仍相对正文", inNote.filter((m) => m.field === "text").map((m) => `${m.shapeId}:${m.start}`), [`${refundText}:3`]);
  eq("结果按主题 id 数值再按偏移排序（遍历与高亮共用这个序）", spots(pg, "refund", { inNote: true }), [`${refundEntry}:0:note`, `${refundEntry}:12:note`, `${refundText}:3:text`]);
  eq("同一主题多处命中单独可数", [matchCount(inNote, refundEntry), matchCount(inNote, refundText), matchCount(inNote, order)], [2, 1, 0]);
  eq("preview 前后各留 20 字并补省略号", findMatches(pg, "needle")[0]?.preview, `…${"前".repeat(20)}needle${"后".repeat(20)}…`);
  eq("整段很短的命中不带省略号", findMatches(pg, "手续费")[0]?.preview, "（退款）手续费");
  // 规格缺口：§3.18 查找目标写明「主题 / 注释·评论 / 标签」，search.ts 的 haystack 只有正文与备注
  eq("搜标签文本也要命中（§3.18 查找目标含「标签」）", ids(updateExtras(pg, service, { labels: ["refund-审批"] }), "refund-审批"), [service]);
  eq("标签命中的字段要标成 label 而不是 text", findMatches(updateExtras(pg, service, { labels: ["refund-审批"] }), "refund-审批").map((m) => m.field), ["label"]);
}

// ---------------------------------------------------------------- 折叠：搜得到也要看得见
{
  const folded = setCollapsed(setCollapsed(pg, deep, true), order, true);
  eq("折叠起来的主题照样能搜到（搜的是模型全量）", ids(folded, "隐藏的命中词"), [deepChild]);
  const revealed = revealShape(folded, deepChild);
  eq("跳转前把折叠的祖先逐个展开（非祖先的折叠态不动）", [Boolean(revealed.shapes[deep].extras.collapsed), Boolean(revealed.shapes[deepChild].extras.collapsed), Boolean(revealed.shapes[order].extras.collapsed)], [false, false, true]);
  eq("展开后大纲投影里真的能读到那一行", outlineRows(revealed).some((r) => r.id === deepChild), true);
  eq("折叠时大纲投影读不到那一行（对照）", outlineRows(folded).some((r) => r.id === deepChild), false);
  ok("没有折叠时原样返回同一对象", revealShape(pg, deepChild) === pg);
  ok("未知 id 原样返回不炸", revealShape(pg, "99999") === pg);
  eq("折叠的主题自身仍然可见：折叠只吃子树", [Boolean(revealShape(folded, order).shapes[order].extras.collapsed), outlineRows(revealShape(folded, order)).some((r) => r.id === order)], [true, true]);
}

// ---------------------------------------------------------------- 替换
const multiId = "900";
/** 段内混排：一条主题两个段落两段文字 */
function withTwoParagraphs(): Page {
  const root = pg.shapes["101"];
  const shape = { ...root, id: multiId, parentId: "101", childIds: [] as string[], text: { characters: [], paragraphs: [{ runs: [{ text: "上行", charIx: 0 }], align: 1 }, { runs: [{ text: "下行", charIx: 0 }], align: 1 }] } };
  return { ...pg, shapes: { ...pg.shapes, [multiId]: shape } };
}
{
  const one = replaceAll(pg, "refund", "退款流程");
  eq("替换计数等于命中数", [one.count, ids(one.page, "refund")], [1, []]);
  eq("替换正文后旧词彻底消失", plainText(one.page.shapes[refundText].text), "对账 退款流程");
  const both = replaceAll(pg, "refund", "退款流程", { inNote: true });
  eq("开 inNote 后备注里的多处一起换", [both.count, plainText(both.page.shapes[refundEntry].text), both.page.shapes[refundEntry].extras.note], [3, "退款入口", "退款流程 规则说明 退款流程 走审批"]);
  const cs = replaceAll(pg, "order", "订单", { caseSensitive: true });
  eq("区分大小写只换一致的那些", [cs.count, plainText(cs.page.shapes[order].text), plainText(cs.page.shapes[order2].text)], [1, "Order 模块", "订单 明细"]);
  const ci = replaceAll(pg, "order", "订单");
  eq("默认忽略大小写时两处都换", [ci.count, plainText(ci.page.shapes[order].text), plainText(ci.page.shapes[service].text)], [3, "订单 模块", "订单管理 订单Service"]);
  const flat = replaceAll(updateExtras(pg, brackets, { note: "备注里有（退款）字样" }), "（退款）", "撤款");
  eq("替换也按字面量匹配括号", [flat.count, plainText(flat.page.shapes[brackets].text)], [1, "撤款手续费"]);
  eq("替换串含 $ 时按普通字符处理（不做正则反向引用）", plainText(replaceAll(pg, "needle", "$&尾").page.shapes[long].text), `${"前".repeat(25)}$&尾${"后".repeat(25)}`);
  const empty = replaceAll(pg, "", "任何");
  eq("空查询是空操作", [empty.count, empty.page === pg], [0, true]);
  eq("替换走 updateText：多段主题被压平成一段（模块自述的取舍）", replaceAll(withTwoParagraphs(), "上行", "改过").page.shapes[multiId].text.paragraphs.length, 1);
}

// ---------------------------------------------------------------- 环形步进
{
  eq(
    "查找列表的环形步进",
    [
      [stepIndex(0, 3, 1), stepIndex(1, 3, 1), stepIndex(2, 3, 1)],
      [stepIndex(0, 3, -1), stepIndex(1, 3, -1), stepIndex(2, 3, -1)],
      [stepIndex(-1, 3, 1), stepIndex(0, 1, 1), stepIndex(0, 1, -1)],
      [stepIndex(0, 0, 1), stepIndex(4, 0, -1)],
    ],
    [[1, 2, 0], [2, 0, 1], [0, 0, 0], [-1, -1]]
  );
  const list = findMatches(pg, "refund", { inNote: true });
  let cursor = -1;
  const walked: string[] = [];
  for (let i = 0; i < list.length; i += 1) {
    cursor = stepIndex(cursor, list.length, 1);
    walked.push(`${list[cursor].shapeId}:${list[cursor].field}`);
  }
  eq("从 -1 起连按下一个正好把命中走一圈", walked, [`${refundEntry}:note`, `${refundEntry}:note`, `${refundText}:text`]);
}

done();
