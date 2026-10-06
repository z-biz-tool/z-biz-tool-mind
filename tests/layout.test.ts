/**
 * 布局引擎（doc/复刻方案/00 §3.4：位置是算出来的，不是存的）。
 * 覆盖的缺陷形状：
 * 1) 盒子按 DEFAULTS.fontSize 量、字按主题样式里的字号画 —— 折行会溢到框外（P-2 只有一条绘制路径）；
 * 2) 折叠与"显示层级"两套可见性必须少画同几笔；
 * 3) 下钻 only 之外整枝不进布局；
 * 4) 浮动主题保留用户拖出来的位置；
 * 5) 连线数量、包围盒与 order 自洽。
 */
import { done, eq, near, ok } from "./_harness.ts";
import { createPage } from "../src/model/factory.ts";
import { charWidth, computeLayout, measureShape, textWidth, wrapText } from "../src/engine/layout.ts";
import { paintPage } from "../src/engine/export/svg.ts";
import { defaultPalette, EDRAW_FONT_SIZES, styleFor } from "../src/engine/style.ts";
import { insertChild, setCollapsed, setFloating, updateStyle, updateText } from "../src/engine/tree.ts";
import { DEFAULTS } from "../src/model/constants.ts";
import { plainText } from "../src/types/model.ts";

const PAD = DEFAULTS.topicPadX * 2;

let cur = createPage("布局");
const root = () => cur.rootId;
/** 建一个主题并留下可用的 cur —— 忘记接 page 是这套测试最容易写错的地方。 */
function add(parentId: string, text: string): string {
  const r = insertChild(cur, parentId, text);
  cur = r.page;
  return r.id;
}

// ---------------------------------------------------------------- 量宽用的字号 = 画字用的字号
{
  cur = createPage("字号同源");
  const b = computeLayout(cur).boxes[root()];
  eq("中心主题按第 0 档字号（实测 14）量宽", b.w, 4 * EDRAW_FONT_SIZES[0] + PAD);
  eq("一行装得下就不折行", b.lines, ["中心主题"]);
  eq("高度 = 行高 + 上下内边距", b.h, Math.round(EDRAW_FONT_SIZES[0] * 1.35 + DEFAULTS.topicPadY * 2));
}

// ---------------------------------------------------------------- 画布与导出共用一份折行
{
  cur = createPage("六投影同源");
  const dev = add(root(), "开发");
  add(dev, "登录联调 (AI 助手登录)");
  const longId = add(dev, "这是一段很长的中文主题文字用来验证超过最大文本宽度之后会不会折行折行再折行折了还要再折一直折下去");
  add(longId, "Latin words that keep going and going and going until the wrap kicks in");
  add(root(), "上线");

  const layout = computeLayout(cur);
  const paint = paintPage(cur);
  eq("paint 的盒子数与布局的 order 一一对应", paint.boxes.length, layout.order.length);
  const drift = paint.boxes.filter((b) => b.lines.join("\u0001") !== layout.boxes[b.id]?.lines.join("\u0001"));
  eq("绘制不再自己折第二次（P-2 只有一条绘制路径）", drift.map((d) => d.id), []);
  const spill = paint.boxes.filter((b) => b.lines.some((l) => textWidth(l, b.fontSize) > b.w - PAD + 0.5));
  eq("每一行都装得进自己的盒子", spill.map((s) => `${s.id}:${s.lines.length}`), []);
  eq("长中文主题确实折了行", layout.boxes[longId].lines.length > 1, true);
  eq("折几行就把盒子垫高几行", layout.boxes[longId].h, Math.round(layout.boxes[longId].lines.length * 10 * 1.35 + DEFAULTS.topicPadY * 2));
  const maxW = Math.max(...Object.values(layout.boxes).map((b) => b.w));
  ok("盒子宽度不超过主题文本宽度上限", maxW <= DEFAULTS.topicMaxTextW + PAD, `实测 ${maxW}`);
}

// ---------------------------------------------------------------- 用户改字号 → 盒子跟着长
{
  cur = createPage("自定义字号");
  cur = updateStyle(cur, root(), { font: { size: 20 } });
  const b = computeLayout(cur).boxes[root()];
  eq("用户字号优先于色板档位", b.w, 4 * 20 + PAD);
  eq("paint 也按同一个字号画", paintPage(cur).boxes.find((x) => x.id === root())?.fontSize, 20);
  eq("measureShape 单独调用时按 opts 给的字号", measureShape(cur.shapes[root()], { fontSize: 20 }).w, 4 * 20 + PAD);
}

// ---------------------------------------------------------------- 可见性：折叠 / 显示层级 / 下钻
{
  cur = createPage("可见性");
  const a = add(root(), "甲");
  const a1 = add(a, "甲一");
  const a11 = add(a1, "甲一甲");
  const b = add(root(), "乙");
  const b1 = add(b, "乙一");

  eq("全展开的节点数", computeLayout(cur).order.length, 6);
  eq("折叠只藏子树，自己那行还在", computeLayout(setCollapsed(cur, a1, true)).order, [root(), a, a1, b, b1]);
  eq("显示 2 级时第 3 级不布局", computeLayout(cur, { displayLevel: 2 }).order, [root(), a, a1, b, b1]);
  eq("下钻只看选中的那一枝（含中心主题）", computeLayout(cur, { only: [a] }).order, [root(), a, a1, a11]);
  eq("下钻另一枝", computeLayout(cur, { only: [b] }).order, [root(), b, b1]);
}

// ---------------------------------------------------------------- 关系：位置自洽
{
  cur = createPage("右向", "logicRight");
  const c1 = add(root(), "分支一");
  const c2 = add(root(), "分支二");
  const c1k = add(c1, "子一");
  const c2k = add(c2, "子二");

  const L = computeLayout(cur);
  eq("连线数 = 除中心主题外每个可见节点一条", L.connectors.length, L.order.length - 1);
  eq("中心主题横向居中", L.boxes[root()].x, 0);
  eq("右向布局里所有分支都在中心主题右边", L.order.filter((id) => id !== root()).every((id) => L.boxes[id].x > 0), true);
  ok("子盒子的左缘不压父盒子的右缘（至少留出水平间距）", L.boxes[c1k].x - L.boxes[c1k].w / 2 >= L.boxes[c1].x + L.boxes[c1].w / 2, "");
  ok("同一层不重叠：子一在子二上面", L.boxes[c1k].y < L.boxes[c2k].y, "");
  eq("包围盒宽度与最外侧盒子一致", L.width, Math.round(L.bounds.maxX - L.bounds.minX));
  eq("包围盒高度与最外侧盒子一致", L.height, Math.round(L.bounds.maxY - L.bounds.minY));

  cur = createPage("双向平衡", "balanced");
  const r1 = add(root(), "右支");
  const l1 = add(root(), "左支");
  const balanced = computeLayout(cur);
  eq("双向平衡把主分支分到两侧", [balanced.boxes[r1].x > 0, balanced.boxes[l1].x < 0], [true, true]);
}

// ---------------------------------------------------------------- 浮动主题
{
  cur = createPage("浮动");
  const f = add(root(), "散记");
  cur = setFloating(cur, f, 300, -200);
  const fk = add(f, "散记子");
  const gk = add(fk, "散记孙");
  const L = computeLayout(cur);
  eq("浮动主题带着它的子一起进布局", L.order, [root(), f, fk, gk]);
  eq("浮动主题的落点是用户拖出来的，不是算出来的", [L.boxes[f].x, L.boxes[f].y], [300, -200]);
  eq("浮动的子主题堆在右下", [L.boxes[fk].x > 300, L.boxes[fk].y > -200], [true, true]);
  eq("中心主题不连线到浮动主题，浮动枝内部照常连", L.connectors.map((c) => `${c.fromId}>${c.toId}`), [`${f}>${fk}`, `${fk}>${gk}`]);

  // 浮动枝也是主题树：孙主题在大纲/看板/甘特里是递归数得到的，图形侧同样得画出来，
  // 否则同一份树在两种投影下主题集不一致（P-1）。
  eq("浮动枝的每个主题都有盒子", [fk, gk].map((id) => Boolean(L.boxes[id])), [true, true]);
  eq("浮动枝按自身根算层级：显示 1 层时孙主题不画", computeLayout(cur, { displayLevel: 1 }).order, [root(), f, fk]);
  eq("显示 0 层只留根：浮动根和主根一样不受层级限制", computeLayout(cur, { displayLevel: 0 }).order, [root(), f]);
  ok("孙主题排在子的右侧", L.boxes[gk].x > L.boxes[fk].x, "");
}

// ---------------------------------------------------------------- 文本测量原语
{
  eq("中日韩按 1 em、空格按 0.3 em", [charWidth("中", 10), charWidth("　", 10), charWidth(" ", 10)], [10, 10, 3]);
  near("大写拉丁按 0.66 em", charWidth("A", 10), 6.6);
  near("小写拉丁按 0.55 em", charWidth("a", 10), 5.5);
  eq("textWidth 是逐字累加", textWidth("中a", 10), 15.5);
  eq("显式换行先拆再折", wrapText("甲\n乙丙", 10, 20), ["甲", "乙丙"]);
  eq("装不下才折，正好装得不折", wrapText("甲乙", 10, 20), ["甲乙"]);
  eq("空文本仍给一行（盒子不能没有基线）", wrapText("", 10, 20), [""]);
  cur = updateText(createPage("空"), root(), "");
  eq("空主题按宽度下限给盒子", computeLayout(cur).boxes[root()].w, DEFAULTS.topicMinW);
}

// ---------------------------------------------------------------- 样式与布局同一档位
{
  cur = createPage("档位");
  const m = add(root(), "主题");
  const s = add(m, "子题");
  add(s, "孙题");
  const L = computeLayout(cur);
  const palette = defaultPalette();
  eq(
    "每层盒子的宽度 = 该层样式字号量出来的文字宽（topicMinW 兜底）",
    [root(), m, s].map((id) => L.boxes[id].w),
    [root(), m, s].map((id) => Math.max(DEFAULTS.topicMinW, Math.round(textWidth(plainText(cur.shapes[id].text), styleFor(cur, cur.shapes[id], palette).font.size) + PAD)))
  );
  eq("字号确实按层级递减", [root(), m, s].map((id) => styleFor(cur, cur.shapes[id], palette).font.size), [14, 12, 10]);
}

done();
