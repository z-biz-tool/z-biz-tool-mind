/**
 * 一棵树六个投影的读侧（doc/复刻方案/00 §0.3 P-1，§3.6 大纲 / §3.7 看板 / §3.8 幻灯片 /
 * §3.9 甘特 / §3.10 遍历 / §3.11 打印）。
 *
 * 这里刻意覆盖的缺陷形状：
 * 1) 同一份数据在两个投影里数出两个数 —— 折叠徽标 "+N"，大纲给子孙总数、画布给直接子节点数；
 * 2) 投影必须覆盖整棵树：浮动主题不在中心主题的子树里，甘特与看板会把它整支丢掉；
 * 3) 甘特「父条要罩住子条」（模块自述）只加长度不抬起点，子条比父条早开工时父条画错位置；
 * 4) 同一主题在看板与甘特里读出的进度不一致（标记完成 = 100% 这件事只有一处做了）；
 * 5) 大纲行序 = 遍历序列 = 打印分页顺序，三处各自 DFS 迟早分叉；
 * 6) 甘特的全局默认要能在真实 .emmx 的 <GanttOption> 里逐字对上（§4 关键数字）；
 * 7) 幻灯片要点只取两级（§3.8 未写死层数，先记下不判错）；投影全部只读，不许写回树。
 */
import { done, eq, ok, skip } from "./_harness.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPage, newGanttOption } from "../src/model/factory.ts";
import { insertChild, setCollapsed, setFloating, updateExtras, updateText } from "../src/engine/tree.ts";
import {
  depCreatesCycle,
  filterCards,
  ganttSchedule,
  ganttTicks,
  isWorkDay,
  kanbanBoard,
  kanbanByStatus,
  kanbanColumnGuard,
  outlineIndexToId,
  outlineRows,
  printPagePlan,
  slideDeck,
  sortCards,
  traverseFocus,
  traverseSequence,
} from "../src/engine/projections.ts";
import { paintPage } from "../src/engine/export/svg.ts";
import { QUOTA } from "../src/model/constants.ts";
import { plainText, type GanttOption, type Page, type ShapeExtras, type TaskData } from "../src/types/model.ts";

const DAY = 86_400_000;
/** 2026-10-05 是周一：工作日掩码 1;1;1;1;1;0;0 的起点。 */
const MON = new Date(2026, 9, 5).getTime();
const gantt: GanttOption = { ...newGanttOption(), startDate: MON };

/** 任务字段：只给必填项，其余留给投影去推导。 */
function T(t: Partial<TaskData>): TaskData {
  return { assignees: [], progress: 0, priority: "medium", status: "todo", tags: [], ...t };
}

let cur = createPage("投影");
const set = (p: Page) => {
  cur = p;
};
const add = (parent: string, text: string, extras?: ShapeExtras): string => {
  const r = insertChild(cur, parent, text);
  cur = r.page;
  if (extras) cur = updateExtras(cur, r.id, extras);
  return r.id;
};

// —— 主树：六个投影共用的同一棵树
const dev = add("101", "开发");
const login = add(dev, "登录联调", {
  labels: ["登录"],
  task: T({ status: "doing", progress: 40, priority: "high", assignees: ["张三", "李四"], finish: MON + 3 * DAY }),
});
const api = add(login, "接口对齐", { task: T({ status: "done" }) });
const report = add(dev, "报表导出", { task: T({ status: "done", tags: ["需求"] }) });
const test = add("101", "测试", { note: "两轮" });
const qa = add(test, "回归用例", { task: T({ status: "done", progress: 100 }) });
const launch = add("101", "上线", { task: T({ milestone: true }) });
const memo = add("101", "散记");
const memoTodo = add(memo, "浮动待办", { task: T({ status: "doing", progress: 10 }) });
cur = updateText(setFloating(cur, memo, 320, -210), "101", "发布计划");
const pg = cur;

const rows = (p: Page = pg) => outlineRows(p);
const idsOf = (p?: Page) => rows(p).map((r) => r.id);
const cardsOf = (p: Page) => kanbanBoard(p).flatMap((c) => c.cards);
const barsOf = (p: Page, g: GanttOption) => ganttSchedule(p, g);

// ---------------------------------------------------------------- 大纲投影
{
  eq(
    "行序：中心主题子树之后另起浮动主题一段，两段各自从 0 级数起",
    rows().map((r) => `${r.level}:${r.id}:${r.type}:${plainText(pg.shapes[r.id].text)}`),
    [
      "0:101:MainIdea:发布计划",
      "1:102:MainTopic:开发",
      "2:103:SubTopic:登录联调",
      "3:104:SubTopic:接口对齐",
      "2:105:SubTopic:报表导出",
      "1:106:MainTopic:测试",
      "2:107:SubTopic:回归用例",
      "1:108:MainTopic:上线",
      "0:109:Floating:散记",
      "1:110:SubTopic:浮动待办",
    ]
  );
  eq("hasChildren 看的是子树非空；未折叠时 collapsed 为假、行尾不挂 +N", [rows().filter((r) => r.hasChildren).map((r) => r.id), rows().filter((r) => r.collapsed).map((r) => r.id), rows().every((r) => r.hiddenCount === 0)], [["101", "102", "103", "106", "109"], [], true]);

  const folded = setCollapsed(pg, dev, true);
  eq("折叠后整条子树从大纲里消失（与画布所见一致）", idsOf(folded), ["101", "102", "106", "107", "108", "109", "110"]);
  const badge = outlineRows(folded).find((r) => r.id === dev);
  eq("折叠行自己标 collapsed + hasChildren", [badge?.collapsed, badge?.hasChildren], [true, true]);
  // 引擎缺陷：projections.ts:39 用 descendants()，export/svg.ts:78 用 childIds.length
  // —— 同一张图上"开发"这一格的徽标，大纲面板写 +3、画布写 +2，违反 P-1
  eq("同一个折叠徽标在画布与大纲里必须是同一个数（P-1）", [badge?.hiddenCount, paintPage(folded).boxes.find((b) => b.id === dev)?.hiddenCount], [3, 3]);
  eq("行号 → 主题 id：越界给 null，不给 undefined", [0, 1, 8, 9, 10, -1].map((n) => outlineIndexToId(pg, n)), ["101", "102", "109", "110", null, null]);
  eq("大纲行序就是遍历序列（键盘上下键与放映共用）", traverseSequence(pg), idsOf());
}

// ---------------------------------------------------------------- 看板投影
{
  const board = kanbanBoard(pg);
  // 列 = 主分支（按 childIds 顺序）+ 浮动主题追加在后面：后者也带任务，P-1 要求投影不丢内容
  eq("列 = 中心主题的直接子分支 + 浮动主题，按 childIds 顺序", board.map((c) => `${c.id}:${c.name}:${c.cards.length}`), ["102:开发:2", "106:测试:1", "108:上线:0", "109:散记:1"]);
  eq("卡片字段取自主题的任务属性（§3.7：负责人/优先级/进度/截止/标签/子任务数）", cardsOf(pg).map((k) => `${k.id}|${k.title}|${k.columnId}|${k.status}|${k.priority}|${k.progress}|${k.assignees.join("+")}|${k.subCount}|${k.tags.join("+")}|${k.due ?? "-"}`), [
    `103|登录联调|102|doing|high|40|张三+李四|1|登录|${MON + 3 * DAY}`,
    "105|报表导出|102|done|medium|100||0|需求|-",
    "107|回归用例|106|done|medium|100||0||-",
    "110|浮动待办|109|doing|medium|10||0||-",
  ]);
  eq("列完成度 = 该列 done 卡片占比取整，空列记 0 不除零", board.map((c) => `${c.id}:${c.progress}`), ["102:50", "106:100", "108:0", "109:0"]);
  eq("泳道模式恒定给三条 todo/doing/done", kanbanByStatus(pg).map((l) => `${l.status}:${l.cards.map((c) => c.id).join("+")}`), ["todo:", "doing:103+110", "done:105+107"]);
  ok("同一主题在看板与甘特里读出的进度必须同一个数（P-1）", cardsOf(pg).every((k) => k.progress === barsOf(pg, gantt).find((b) => b.id === k.id)?.progress));
  // 缺陷回归：kanbanBoard 曾只走 children(root)，浮动主题（parentId 为空）整支不在任何一列里，
  // ganttSchedule 同样从 root 出发 —— 挂在浮动主题上的任务在两个投影里都读不到
  eq("挂在浮动主题上的任务不能在投影里凭空消失（P-1 不丢内容）", [cardsOf(pg).some((k) => k.id === memoTodo), barsOf(pg, gantt).some((b) => b.id === memoTodo)], [true, true]);

  let wide = createPage("宽");
  for (let i = 0; i < 9; i += 1) wide = insertChild(wide, wide.rootId, `列${i + 1}`).page;
  eq("10 列放行", [kanbanColumnGuard(wide).ok, kanbanColumnGuard(wide).reason], [true, undefined]);
  const wide2 = insertChild(wide, wide.rootId, "第10列").page;
  eq("正好 10 列仍是边界内", kanbanColumnGuard(wide2).ok, true);
  const wide3 = insertChild(wide2, wide2.rootId, "第11列").page;
  eq("11 列被拒并给出中文提示", kanbanColumnGuard(wide3), { ok: false, reason: `看板列数上限 ${QUOTA.freeMaxFiles}，请合并主分支` });
  // 注（不判错）：列数上限复用的是 QUOTA.freeMaxFiles「免费版文件数」，两个配额语义混在一起了；
  // 而且守卫只是旁路提示，kanbanBoard 自己照样把 11 列画出来。
  eq("守卫不拦投影：11 列仍照样数出来", [kanbanBoard(wide3).length, kanbanColumnGuard(wide3).ok], [11, false]);

  set(createPage("无任务"));
  const colB = add("101", "列甲");
  add(colB, "没填任务的主题");
  eq("没挂任务的主题默认待办：优先级 medium、进度 0，不会从看板上消失", cardsOf(cur).map((k) => `${k.id}|${k.columnId}|${k.status}|${k.priority}|${k.progress}|${k.assignees.length}|${k.tags.length}|${k.subCount}|${k.due ?? "-"}`), [`103|102|todo|medium|0|0|0|0|-`]);
}

// ---------------------------------------------------------------- 幻灯片投影
{
  const deck = slideDeck(pg);
  eq("封面 + 每个主分支一页，index 连续", deck.map((s) => `${s.index}:${s.id}:${s.title}`), ["0:101:发布计划", "1:102:开发", "2:106:测试", "3:108:上线"]);
  eq("封面备注取中心主题的笔记", deck[0].notes, "");
  eq("要点取主分支下两级并带缩进位", deck[1].bullets.map((b) => `${b.level}:${b.id}:${b.text}`), ["0:103:登录联调", "1:104:接口对齐", "0:105:报表导出"]);
  eq("每页备注取该分支的笔记", deck.map((s) => s.notes), ["", "", "两轮", ""]);
  set(createPage("空页"));
  eq("只有中心主题时只剩封面", slideDeck(cur).map((s) => `${s.index}:${s.title}`), ["0:中心主题"]);
}

// ---------------------------------------------------------------- 甘特投影
{
  set(createPage("甘特"));
  const g1 = add("101", "需求");
  const g11 = add(g1, "评审");
  const g111 = add(g11, "签字", { task: T({ status: "done" }) });
  const g2 = add("101", "开发");
  const g21 = add(g2, "编码", { task: T({ start: MON + 5 * DAY, duration: 2 }) });
  const g22 = add(g2, "验收", { task: T({ duration: 0 }) });
  const g3 = add("101", "上线", { task: T({ milestone: true, duration: 0.25, start: MON + 6 * DAY }) });
  const g0 = add("101", "前置调研", { task: T({ start: MON - 2 * DAY, duration: 1 }) });
  const gp = cur;
  const bars = ganttSchedule(gp, gantt);
  const bar = (id: string) => bars.find((b) => b.id === id);

  eq("行序 = 深度优先，中心主题自己不占一条", bars.map((b) => b.id), [g1, g11, g111, g2, g21, g22, g3, g0]);
  eq("没填日期时按同层顺序合成时间线（复刻默认，切过去必有反馈）", bars.map((b) => `${b.name}:${b.depth}:${b.offsetDays}:${b.lengthDays}`), [
    "需求:0:0:1",
    "评审:1:0:1",
    "签字:2:0:1",
    "开发:0:1:1",
    "编码:1:5:2",
    "验收:1:0:0.25",
    "上线:0:6:0.25",
    "前置调研:0:-2:1",
  ]);
  eq("工期为 0 也留 0.25 天的可视下限", bar(g22)?.lengthDays, 0.25);
  eq("未填工期默认 1 天", bar(g1)?.lengthDays, 1);
  eq("完成状态在没有进度时按 100% 画", bar(g111)?.progress, 100);
  eq("里程碑与概要标记", bars.map((b) => `${b.id}:${b.milestone ? "M" : "-"}${b.isSummary ? "S" : "-"}`).join(" "), "102:-S 103:-S 104:-- 105:-S 106:-- 107:-- 108:M- 109:--");
  eq("偏移以毫秒相对甘特起点换算，可负", [bar(g0)?.offsetDays, bar(g3)?.offsetDays], [-2, 6]);

  // 引擎缺陷：projections.ts:210-216 只求长度不抬起点 —— 子条比父条早开工时父条整体画错
  set(createPage("概要"));
  const sum = add("101", "阶段", { task: T({ start: MON + 5 * DAY, duration: 1 }) });
  const sumKid = add(sum, "任务", { task: T({ start: MON + 2 * DAY, duration: 4 }) });
  const sBars = ganttSchedule(cur, gantt);
  const sParent = sBars.find((b) => b.id === sum);
  const sChild = sBars.find((b) => b.id === sumKid);
  eq("子条落在父条区间内（模块自述：父条要罩住子条）", [sParent?.offsetDays, sParent?.offsetDays + sParent?.lengthDays, sChild?.offsetDays, sChild?.offsetDays + sChild?.lengthDays], [2, 6, 2, 6]);

  eq("横轴覆盖负偏移并把 0 也算进跨度", ganttTicks(bars, gantt), { days: 9, unitWidth: 100, total: 900 });
  eq("空甘特也给得出 1 天刻度", ganttTicks([], gantt), { days: 1, unitWidth: 100, total: 100 });
  eq("单位宽度跟随 gantt.unitWidth（§3.9 时间单位可配）", ganttTicks(bars, { ...gantt, unitWidth: 20 }), { days: 9, unitWidth: 20, total: 180 });

  eq("工作日掩码 1;1;1;1;1;0;0 自周一起铺开", [0, 1, 2, 3, 4, 5, 6].map((d) => isWorkDay(MON, d, gantt.workDay)), [true, true, true, true, true, false, false]);
  eq("掩码短于 7 位时缺位默认算工作日", [isWorkDay(MON, 2, [1, 1]), isWorkDay(MON, 6, [1, 1])], [true, true]);
  eq("偏移按四舍五入取整天", [isWorkDay(MON, 0.4, gantt.workDay), isWorkDay(MON, 5.6, gantt.workDay)], [true, false]);
  eq("往前跨一天是上周日", isWorkDay(MON, -1, gantt.workDay), false);
}

// ---------------------------------------------------------------- 遍历与打印分页
{
  eq("下钻焦点：回溯到一级分支为止，浮动主题自成一段", [login, api, dev, pg.rootId, memoTodo, memo, "9999"].map((id) => traverseFocus(pg, id)), [dev, dev, dev, pg.rootId, memo, memo, "9999"]);
  eq("每页 3 条：中心主题不占页，余数单独成页", printPagePlan(pg, 3), [["102", "103", "104"], ["105", "106", "107"], ["108", "109", "110"]]);
  eq("分页不重不漏", printPagePlan(pg, 4).flat().length, idsOf().length - 1);
  eq("每页 0 条按 1 条处理（不能死循环）", [printPagePlan(pg, 0).length, printPagePlan(pg, -1).length], [9, 9]);
  eq("整份一页时只出一页", printPagePlan(pg, 999), [idsOf().filter((id) => id !== pg.rootId)]);
  eq("折叠的内容不参与遍历与分页（§3.10 隐藏未遍历内容）", [printPagePlan(setCollapsed(pg, dev, true), 3).flat().length, traverseSequence(setCollapsed(pg, dev, true)).length], [6, 7]);
}

// ---------------------------------------------------------------- 真实样本对照 + 只读性
{
  const snapshot = structuredClone(pg);
  outlineRows(pg);
  kanbanBoard(pg);
  slideDeck(pg);
  ganttSchedule(pg, gantt);
  traverseSequence(pg);
  printPagePlan(pg, 5);
  eq("六个投影全是只读函数，不写回树（P-1 的前提）", pg, snapshot);

  const file = join(process.cwd(), "_research", "extract", "doc1", "document.xml.txt");
  if (!existsSync(file)) {
    skip("甘特全局默认与实测 <GanttOption> 对照", "缺 _research/extract/doc1/document.xml.txt");
  } else {
    const xml = readFileSync(file, "utf8");
    const attr = (tag: string): string => xml.match(new RegExp(`<${tag} V="([^"]*)"`))?.[1] ?? "";
    eq(
      "newGanttOption() 与真实 .emmx 的 <GanttOption> 逐项对齐（§4 关键数字）",
      newGanttOption(),
      {
        workDay: attr("WorkDay").split(";").map(Number),
        majorTick: Number(attr("MajorTick")),
        minorTick: Number(attr("MinorTick")),
        startDate: Number(attr("StartDate")),
        finishDate: Number(attr("FinishDate")),
        startTime: Number(attr("StartTime")),
        finishTime: Number(attr("FinishTime")),
        unitWidth: Number(attr("UnitWidth")),
      }
    );
    ok("样本里确实读到了 7 位工作日掩码", attr("WorkDay").split(";").length === 7, `实测 ${attr("WorkDay")}`);
  }
}

// ---------------------------------------------------------------- 看板排序 / 筛选 / 里程碑（卡片菜单的数据面）
{
  let p = createPage("看板排序");
  const mk = (parent: string, text: string, extras?: ShapeExtras) => {
    const r = insertChild(p, parent, text);
    p = r.page;
    if (extras) p = updateExtras(p, r.id, extras);
    return r.id;
  };
  const a = mk(p.rootId, "甲列");
  const c1 = mk(a, "卡片A", { task: T({ priority: "high", finish: MON + 2 * DAY, milestone: true }), labels: ["红"] });
  const c2 = mk(a, "卡片B", { task: T({ priority: "low", finish: MON + 1 * DAY }), labels: ["蓝"] });
  const c3 = mk(a, "卡片C", { task: T({ priority: "medium" }) });
  const cards = kanbanBoard(p)[0].cards;
  eq("里程碑随卡片浮出（看板标签与甘特菱形读同一份）", cards.map((c) => (c.milestone ? 1 : 0)), [1, 0, 0]);
  eq("标题排序", sortCards(cards, "title").map((c) => c.id), [c1, c2, c3]);
  eq("截止日升序：先到的在前", sortCards(cards, "due").map((c) => c.id), [c2, c1, c3]);
  eq("截止日降序：没填日期的照样垫底，不参与翻转", sortCards(cards, "due", -1).map((c) => c.id), [c1, c2, c3]);
  eq("优先级排序：高→低", sortCards(cards, "priority").map((c) => c.id), [c1, c3, c2]);
  eq("优先级降序：低在前", sortCards(cards, "priority", -1).map((c) => c.id), [c2, c3, c1]);
  eq("手动 = 树序原样（引用都不换，看板不写树）", sortCards(cards, "manual"), cards);
  eq("筛选：标题包含", filterCards(cards, { text: "A" }).map((c) => c.id), [c1]);
  eq("筛选：标签也算在关键字里", filterCards(cards, { text: "蓝" }).map((c) => c.id), [c2]);
  eq("筛选：标签精确一道", filterCards(cards, { tag: "红" }).map((c) => c.id), [c1]);
  eq("筛选：关键字与大小写", filterCards(cards, { text: "a" }).map((c) => c.id), [c1]);
  eq("筛选：无命中给空数组", [filterCards(cards, { text: "不存在" }).length, filterCards(cards, { tag: "紫" }).length], [0, 0]);
}

// ---------------------------------------------------------------- 甘特依赖（完工→开工）与成环守卫（§3.9）
{
  let p = createPage("甘特依赖");
  const mk = (parent: string, text: string, extras?: ShapeExtras) => {
    const r = insertChild(p, parent, text);
    p = r.page;
    if (extras) p = updateExtras(p, r.id, extras);
    return r.id;
  };
  const a = mk(p.rootId, "设计", { task: T({ start: MON, duration: 3 }) });
  const b = mk(p.rootId, "开发", { task: T({ start: MON, duration: 2, deps: [] }) });
  // B 显式开工比 A 收工早：依赖把它顶到 A 之后（FS：完工才开工）
  const b2 = mk(p.rootId, "测试", { task: T({ start: MON, duration: 1 }) });
  p = updateExtras(p, b, { task: T({ start: MON, duration: 2, deps: [a] }) });
  let bars = ganttSchedule(p, gantt);
  const of = (id: string) => bars.find((x) => x.id === id);
  eq("前置收工前不许开工", [of(b)?.offsetDays, of(b)?.lengthDays], [3, 2]);
  eq("没依赖的原样保留", [of(a)?.offsetDays, of(b2)?.offsetDays], [0, 0]);
  // 链式：设计→开发→上线，两轮收敛
  const c = mk(p.rootId, "上线", { task: T({ start: MON, duration: 1 }) });
  p = updateExtras(p, c, { task: T({ start: MON, duration: 1, deps: [b] }) });
  bars = ganttSchedule(p, gantt);
  eq("链式依赖逐级推", [of(b)?.offsetDays, of(c)?.offsetDays], [3, 5]);
  // 环：A 依赖 C、C 又依赖 B、B 依赖 A —— 迭代封顶兜住，不挂死、不无限推
  p = updateExtras(p, a, { task: T({ start: MON, duration: 3, deps: [c] }) });
  bars = ganttSchedule(p, gantt);
  ok("成环也返回（迭代封顶）", bars.length === 4, `bars=${bars.length}`);
  ok("环判据：直接回边", depCreatesCycle(p, b, a), "");
  ok("环判据：间接回边（C 的链走得到 B）", depCreatesCycle(p, b, c), "");
  ok("环判据：无关两任务不是环", !depCreatesCycle(p, a, b2), "");
  ok("环判据：自己依赖自己", depCreatesCycle(p, a, a), "");
  // 概要条包络：给"设计"挂个子任务，依赖把子任务推走后父条要罩住
  const s1 = mk(a, "调研", { task: T({ start: MON, duration: 1, deps: [c] }) });
  bars = ganttSchedule(p, gantt);
  const parent = of(a);
  const kidBar = of(s1);
  ok(
    "概要条罩住被依赖推走的子条",
    parent !== undefined &&
      kidBar !== undefined &&
      parent.offsetDays <= kidBar.offsetDays &&
      parent.offsetDays + parent.lengthDays >= kidBar.offsetDays + kidBar.lengthDays,
    `父=[${parent?.offsetDays},${(parent?.offsetDays ?? 0) + (parent?.lengthDays ?? 0)}] 子=[${kidBar?.offsetDays},${(kidBar?.offsetDays ?? 0) + (kidBar?.lengthDays ?? 0)}]`
  );
  eq("bar 带上 deps 供连线画", of(b)?.deps, [a]);
}

// ---------------------------------------------------------------- 幻灯片隐藏页（§3.8 幻灯片管理）
{
  let p = createPage("隐藏页");
  const mk = (parent: string, text: string) => {
    const r = insertChild(p, parent, text);
    p = r.page;
    return r.id;
  };
  const b1 = mk(p.rootId, "第一页");
  const b2 = mk(p.rootId, "第二页");
  p = updateExtras(p, b2, { slideHidden: true });
  const deck = slideDeck(p);
  eq(
    "隐藏页在编辑器里照常列出并打标（藏起来就找不回了）",
    deck.map((s) => `${s.index}:${s.title}:${s.hidden ? 1 : 0}`),
    ["0:中心主题:0", "1:第一页:0", "2:第二页:1"]
  );
  eq("放映序列跳过隐藏页", deck.filter((s) => !s.hidden).map((s) => s.title), ["中心主题", "第一页"]);
  p = updateExtras(p, b2, { slideHidden: undefined });
  eq("取消隐藏后回到放映序列", slideDeck(p).filter((s) => !s.hidden).length, 3);
}

done();
