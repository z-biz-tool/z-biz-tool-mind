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
 * 8) §3.18 的查找目标写明「主题 / 注释·评论 / 标签」，三类各自可关；
 * 9) §3.18 的"含隐藏"默认关：折叠遮住的既搜不到也不该被替换掉，
 *    但"搜不到"必须能报出"有几处被藏住了"，否则用户会以为内容没了；
 * 10) §3.18 的范围（当前页 / 所有页）：跨页命中要带 pageId，替换要一次进一条历史。
 */
import { done, eq, ok } from "./_harness.ts";
import { createDocument, createPage } from "../src/model/factory.ts";
import { insertChild, setCollapsed, updateExtras } from "../src/engine/tree.ts";
import {
  findMatches,
  findMatchesDoc,
  hiddenMatchCount,
  hiddenMatchCountDoc,
  matchCount,
  replaceAll,
  replaceAllDoc,
  revealShape,
  stepIndex,
} from "../src/engine/search.ts";
import { outlineRows } from "../src/engine/projections.ts";
import { plainText, type DocumentModel, type Page, type ShapeExtras } from "../src/types/model.ts";

let pg = createPage("查找");
const add = (parent: string, text: string, extras: ShapeExtras = {}): string => {
  const r = insertChild(pg, parent, text);
  pg =
    extras.note || extras.labels || extras.comments
      ? updateExtras(r.page, r.id, extras)
      : r.page;
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
// 评论用一个别处都不出现的词做载体，免得动到上面那批 refund 的既有断言。
const commented = add("101", "评论载体", {
  comments: [{ author: "张子房", text: "这条 批注词 待确认", at: 0 }],
});

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
  // §3.18 的查找目标三类各自可关：标签默认关（短词会淹掉正文结果），开了才搜。
  const labeled = updateExtras(pg, service, { labels: ["refund-审批"] });
  eq("标签默认不参与搜索", ids(labeled, "refund-审批"), []);
  eq("开 inLabel 后搜标签文本要命中", ids(labeled, "refund-审批", { inLabel: true }), [service]);
  eq("标签命中的字段要标成 label 并带角标下标", findMatches(labeled, "refund-审批", { inLabel: true }).map((m) => `${m.field}:${m.labelIndex}`), ["label:0"]);
  eq("关掉正文就只剩标签", ids(labeled, "refund-审批", { inLabel: true, inText: false }), [service]);
  eq("评论算在「备注·评论」这一类里，默认搜不到", ids(pg, "批注词"), []);
  eq("开 inNote 后评论命中要标 field=comment 并带评论下标", findMatches(pg, "批注词", { inNote: true }).map((m) => `${m.shapeId}:${m.field}:${m.commentIndex}:${m.start}`), [`${commented}:comment:0:3`]);
}

// ---------------------------------------------------------------- 折叠：搜得到也要看得见
{
  const folded = setCollapsed(setCollapsed(pg, deep, true), order, true);
  eq("折叠起来的主题默认搜不到（§3.18 的「含隐藏」默认关）", ids(folded, "隐藏的命中词"), []);
  eq("勾上含隐藏就按模型全量搜", ids(folded, "隐藏的命中词", { includeHidden: true }), [deepChild]);
  eq("没折叠时同一查询照常命中（对照）", ids(pg, "隐藏的命中词"), [deepChild]);
  eq("折叠主题自己仍然算可见", ids(folded, "层级"), [deep]);
  eq(
    "被藏住的命中数要能单独报出来，供「另有 N 处」那句提示用",
    [hiddenMatchCount(folded, "隐藏的命中词"), hiddenMatchCount(folded, "层级"), hiddenMatchCount(pg, "隐藏的命中词")],
    [1, 0, 0]
  );
  eq("开着含隐藏时不再报隐藏数（否则提示会和结果打架）", hiddenMatchCount(folded, "隐藏的命中词", { includeHidden: true }), 0);
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
  // 替换的范围必须和命中表是同一份：面板说"共 0 处"却改掉折叠里的主题，用户只会以为是自己改错了。
  const foldedPage = setCollapsed(pg, deep, true);
  const skipHidden = replaceAll(foldedPage, "隐藏的命中词", "改掉了");
  eq("默认不勾含隐藏时，折叠里的命中不参与替换", [skipHidden.count, plainText(skipHidden.page.shapes[deepChild].text)], [0, "隐藏的命中词"]);
  const hitHidden = replaceAll(foldedPage, "隐藏的命中词", "改掉了", { includeHidden: true });
  eq("勾上含隐藏才真的改到折叠里那一处", [hitHidden.count, plainText(hitHidden.page.shapes[deepChild].text)], [1, "改掉了"]);
}

// ---------------------------------------------------------------- 跨页范围（§3.18 的"当前页 / 所有页"）
{
  const second = { ...createPage("第二页"), id: "2" };
  const ins = insertChild(second, second.rootId, "跨页的 needle 命中");
  const two: DocumentModel = { ...createDocument("跨页"), pages: [pg, ins.page], activePageId: pg.id };
  eq("空查询在文档级也是空操作", findMatchesDoc(two, "").length, 0);
  eq(
    "跨页命中按页的顺序串起来，每条带自己的 pageId",
    findMatchesDoc(two, "needle").map((m) => `${m.pageId}:${m.shapeId}`),
    [`${pg.id}:${long}`, `${ins.page.id}:${ins.id}`]
  );
  eq("单页搜索不吃别的页", ids(pg, "needle").length, 1);
  const foldedTwo: DocumentModel = { ...two, pages: [setCollapsed(pg, deep, true), ins.page] };
  eq(
    "隐藏命中数按页累加",
    [hiddenMatchCountDoc(two, "隐藏的命中词"), hiddenMatchCountDoc(foldedTwo, "隐藏的命中词")],
    [0, 1]
  );
  const all = replaceAllDoc(two, "needle", "针");
  eq("跨页替换一次改到两页", [all.count, plainText(all.doc.pages[0].shapes[long].text).includes("needle"), plainText(all.doc.pages[1].shapes[ins.id].text)], [2, false, "跨页的 针 命中"]);
  const none = replaceAllDoc(two, "只活在第二页的词", "换");
  eq("没命中的页保留原引用（撤销栈不背无谓的副本）", none.doc.pages[0] === pg, true);
  eq("空查询的跨页替换是空操作", (() => { const r = replaceAllDoc(two, "", "换"); return [r.count, r.doc === two]; })(), [0, true]);
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
