/**
 * 布局引擎（doc/复刻方案/00 §3.4：位置是算出来的，不是存的）。
 * 覆盖的缺陷形状：
 * 1) 盒子按 DEFAULTS.fontSize 量、字按主题样式里的字号画 —— 折行会溢到框外（P-2 只有一条绘制路径）；
 * 2) 折叠与"显示层级"两套可见性必须少画同几笔；
 * 3) 下钻 only 之外整枝不进布局；
 * 4) 浮动主题保留用户拖出来的位置；
 * 5) 连线数量、包围盒与 order 自洽；
 * 6) 每个版式码都要有方向断言（曾经 24 码只有 2 码有断言，改 layout.ts 会静默改坏某一带），
 *    并且任何码都不许把两个主题画在同一个位置 —— 垂直时间线压回同一行、
 *    组织结构图（上下双向）压进中心主题，都是这么露出来的。
 */
import { done, eq, near, ok } from "./_harness.ts";
import { createPage } from "../src/model/factory.ts";
import {
  charWidth,
  computeLayout,
  measureShape,
  textWidth,
  wrapText,
} from "../src/engine/layout.ts";
import { paintPage } from "../src/engine/export/svg.ts";
import { defaultPalette, EDRAW_FONT_SIZES, styleFor } from "../src/engine/style.ts";
import {
  insertChild,
  setCollapsed,
  setFloating,
  updateStyle,
  updateText,
} from "../src/engine/tree.ts";
import { DEFAULTS, LAYOUT_LABELS } from "../src/model/constants.ts";
import { plainText } from "../src/types/model.ts";
import type { LayoutCode } from "../src/types/model.ts";

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
  eq(
    "高度 = 行高 + 上下内边距",
    b.h,
    Math.round(EDRAW_FONT_SIZES[0] * 1.35 + DEFAULTS.topicPadY * 2)
  );
}

// ---------------------------------------------------------------- 画布与导出共用一份折行
{
  cur = createPage("六投影同源");
  const dev = add(root(), "开发");
  add(dev, "登录联调 (AI 助手登录)");
  const longId = add(
    dev,
    "这是一段很长的中文主题文字用来验证超过最大文本宽度之后会不会折行折行再折行折了还要再折一直折下去"
  );
  add(longId, "Latin words that keep going and going and going until the wrap kicks in");
  add(root(), "上线");

  const layout = computeLayout(cur);
  const paint = paintPage(cur);
  eq("paint 的盒子数与布局的 order 一一对应", paint.boxes.length, layout.order.length);
  const drift = paint.boxes.filter(
    (b) => b.lines.join("\u0001") !== layout.boxes[b.id]?.lines.join("\u0001")
  );
  eq(
    "绘制不再自己折第二次（P-2 只有一条绘制路径）",
    drift.map((d) => d.id),
    []
  );
  const spill = paint.boxes.filter((b) =>
    b.lines.some((l) => textWidth(l, b.fontSize) > b.w - PAD + 0.5)
  );
  eq(
    "每一行都装得进自己的盒子",
    spill.map((s) => `${s.id}:${s.lines.length}`),
    []
  );
  eq("长中文主题确实折了行", layout.boxes[longId].lines.length > 1, true);
  eq(
    "折几行就把盒子垫高几行",
    layout.boxes[longId].h,
    Math.round(layout.boxes[longId].lines.length * 10 * 1.35 + DEFAULTS.topicPadY * 2)
  );
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
  eq(
    "measureShape 单独调用时按 opts 给的字号",
    measureShape(cur.shapes[root()], { fontSize: 20 }).w,
    4 * 20 + PAD
  );
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
  eq("折叠只藏子树，自己那行还在", computeLayout(setCollapsed(cur, a1, true)).order, [
    root(),
    a,
    a1,
    b,
    b1,
  ]);
  eq("显示 2 级时第 3 级不布局", computeLayout(cur, { displayLevel: 2 }).order, [
    root(),
    a,
    a1,
    b,
    b1,
  ]);
  eq("下钻只看选中的那一枝（含中心主题）", computeLayout(cur, { only: [a] }).order, [
    root(),
    a,
    a1,
    a11,
  ]);
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
  eq(
    "右向布局里所有分支都在中心主题右边",
    L.order.filter((id) => id !== root()).every((id) => L.boxes[id].x > 0),
    true
  );
  ok(
    "子盒子的左缘不压父盒子的右缘（至少留出水平间距）",
    L.boxes[c1k].x - L.boxes[c1k].w / 2 >= L.boxes[c1].x + L.boxes[c1].w / 2,
    ""
  );
  ok("同一层不重叠：子一在子二上面", L.boxes[c1k].y < L.boxes[c2k].y, "");
  eq("包围盒宽度与最外侧盒子一致", L.width, Math.round(L.bounds.maxX - L.bounds.minX));
  eq("包围盒高度与最外侧盒子一致", L.height, Math.round(L.bounds.maxY - L.bounds.minY));

  cur = createPage("双向平衡", "balanced");
  const r1 = add(root(), "右支");
  const l1 = add(root(), "左支");
  const balanced = computeLayout(cur);
  eq(
    "双向平衡把主分支分到两侧",
    [balanced.boxes[r1].x > 0, balanced.boxes[l1].x < 0],
    [true, true]
  );
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
  eq(
    "中心主题不连线到浮动主题，浮动枝内部照常连",
    L.connectors.map((c) => `${c.fromId}>${c.toId}`),
    [`${f}>${fk}`, `${fk}>${gk}`]
  );

  // 浮动枝也是主题树：孙主题在大纲/看板/甘特里是递归数得到的，图形侧同样得画出来，
  // 否则同一份树在两种投影下主题集不一致（P-1）。
  eq(
    "浮动枝的每个主题都有盒子",
    [fk, gk].map((id) => Boolean(L.boxes[id])),
    [true, true]
  );
  eq("浮动枝按自身根算层级：显示 1 层时孙主题不画", computeLayout(cur, { displayLevel: 1 }).order, [
    root(),
    f,
    fk,
  ]);
  eq(
    "显示 0 层只留根：浮动根和主根一样不受层级限制",
    computeLayout(cur, { displayLevel: 0 }).order,
    [root(), f]
  );
  ok("孙主题排在子的右侧", L.boxes[gk].x > L.boxes[fk].x, "");
}

// ---------------------------------------------------------------- 全码几何回归（03 §1.3-1：过去 20 码只有 2 码有断言）
{
  cur = createPage("全码");
  const A = add(root(), "分支A");
  const B = add(root(), "分支B");
  const C = add(root(), "分支C");
  const A1 = add(A, "A一");
  const A2 = add(A, "A二");
  const A11 = add(A1, "A一一");
  const B1 = add(B, "B一");
  const ids = [root(), A, B, C, A1, A2, A11, B1];
  const CODES = Object.keys(LAYOUT_LABELS) as LayoutCode[];
  const box = (code: LayoutCode) => {
    const L = computeLayout({ ...cur, layout: { ...cur.layout, code } });
    return { L, at: (id: string) => L.boxes[id] };
  };
  /** 两两压框检测。自由布局不分派位置（本来就是叠在一起等用户拖），不参与。 */
  const overlaps = (L: ReturnType<typeof computeLayout>) => {
    const bs = ids.map((id) => L.boxes[id]);
    const bad: string[] = [];
    for (let i = 0; i < bs.length; i += 1)
      for (let j = i + 1; j < bs.length; j += 1) {
        const ox =
          Math.min(bs[i].x + bs[i].w / 2, bs[j].x + bs[j].w / 2) -
          Math.max(bs[i].x - bs[i].w / 2, bs[j].x - bs[j].w / 2);
        const oy =
          Math.min(bs[i].y + bs[i].h / 2, bs[j].y + bs[j].h / 2) -
          Math.max(bs[i].y - bs[i].h / 2, bs[j].y - bs[j].h / 2);
        if (ox > 1 && oy > 1) bad.push(`${bs[i].lines.join("")}×${bs[j].lines.join("")}`);
      }
    return bad;
  };

  ok("版式码表至少 24 码（蓝本 §3.3 的族与变体）", CODES.length >= 24, CODES.join(","));
  for (const code of CODES) {
    const L = computeLayout({ ...cur, layout: { ...cur.layout, code } });
    eq(`${code}：每个主题都算出盒子`, ids.filter((id) => !L.boxes[id]).length, 0);
    eq(`${code}：连线数 = 主题数 - 1`, L.connectors.length, ids.length - 1);
    if (code !== "free") eq(`${code}：主题互不压框`, overlaps(L), []);
    ok(
      `${code}：包围盒包住每个盒子`,
      ids.every((id) => {
        const b = L.boxes[id];
        return (
          b.x - b.w / 2 >= L.bounds.minX - 0.01 &&
          b.x + b.w / 2 <= L.bounds.maxX + 0.01 &&
          b.y - b.h / 2 >= L.bounds.minY - 0.01 &&
          b.y + b.h / 2 <= L.bounds.maxY + 0.01
        );
      }),
      ""
    );
  }

  // 树状图角向式：父节点站在自己子树的角上，同深度共用一列
  {
    const r = box("treeRight");
    eq(
      "树状图（右下）：子在父的下方且缩进向右",
      [r.at(A1).y > r.at(A).y, r.at(A1).x > r.at(A).x],
      [true, true]
    );
    ok("树状图（右下）：同深度共用一列", Math.abs(r.at(A1).x - r.at(A2).x) < 0.01, "");
    ok("树状图（右下）：再深一层继续向右缩进", r.at(A11).x > r.at(A1).x, "");
    eq(
      "树状图（右下）：一级分支按前序竖着堆",
      [r.at(A).y, r.at(B).y, r.at(C).y].map((v) => v > 0),
      [true, true, true]
    );
    const l = box("treeLeft");
    eq(
      "树状图（左下）：仍然向下，只把缩进翻到左边",
      [l.at(A1).y > l.at(A).y, l.at(A1).x < l.at(A).x],
      [true, true]
    );
    eq(
      "树状图（左下）不是向上：与向上对称式的 y 反号",
      l.at(A1).y > 0 && box("treeUpSym").at(A1).y < 0,
      true
    );
    const ur = box("treeUpRight");
    eq(
      "树状图（右上）：向上且向右",
      [ur.at(A1).y < ur.at(A).y, ur.at(A1).x > ur.at(A).x],
      [true, true]
    );
    const ul = box("treeUpLeft");
    eq(
      "树状图（左上）：向上且向左",
      [ul.at(A1).y < ul.at(A).y, ul.at(A1).x < ul.at(A).x],
      [true, true]
    );
    // 对称式：子树摊在父节点正下方，一级分支横着铺开
    const ds = box("treeDownSym");
    ok(
      "树状图（向下对称）：一级分支同排横铺",
      Math.abs(ds.at(A).y - ds.at(C).y) < 0.01 &&
        ds.at(A).x < ds.at(B).x &&
        ds.at(B).x < ds.at(C).x,
      ""
    );
    ok(
      "角向式与对称式不是同一套几何（亿图把它们分成六个菜单项）",
      Math.abs(ds.at(A).x - r.at(A).x) > 1,
      ""
    );
    ok(
      "组织结构图（向下）沿用居中摊开的对称几何",
      Math.abs(box("orgDown").at(A).x - ds.at(A).x) < 0.01,
      ""
    );
  }

  // 组织结构图（上下双向）：一级分支要从中心主题的外缘起算
  {
    const { at } = box("orgBoth");
    const rootBox = at(root());
    const first = Math.min(at(A).y, at(C).y);
    ok(
      "上下双向：下行分支的顶边在中心主题底边之下",
      first - at(A).h / 2 >= rootBox.y + rootBox.h / 2,
      `实际 ${first - at(A).h / 2} < ${rootBox.y + rootBox.h / 2}`
    );
    eq("上下双向：主分支分到上下两排", [at(A).y > 0, at(B).y < 0, at(C).y > 0], [true, true, true]);
  }

  // 时间轴：沿主轴必须单调，交替只发生在与主轴垂直的那根轴上
  {
    const v = box("timelineVertical");
    eq(
      "垂直时间线：一级分支沿 y 严格递增",
      [v.at(A).y < v.at(B).y, v.at(B).y < v.at(C).y],
      [true, true]
    );
    eq(
      "垂直时间线：一级分支左右交替",
      [v.at(A).x < 0, v.at(B).x > 0, v.at(C).x < 0],
      [true, true, true]
    );
    const h = box("timelineHorizontal");
    eq(
      "水平时间线：一级分支沿 x 严格递增、上下交替",
      [h.at(A).x < h.at(B).x, h.at(B).x < h.at(C).x, h.at(A).y < 0 && h.at(B).y > 0],
      [true, true, true]
    );
  }

  // 其余各族至少一条方向断言，重构 layout.ts 时不至于静默改坏某一带
  {
    eq("思维导图（右）：分支都在右侧", box("logicRight").at(A).x > 0, true);
    eq("思维导图（左）：分支都在左侧", box("logicLeft").at(A).x < 0, true);
    eq("单向导图与向右同构", box("rightOnly").at(A).x, box("logicRight").at(A).x);
    eq("括号图（右）：分支在右侧", box("braceRight").at(A).x > 0, true);
    eq("括号图（左）镜像", box("braceLeft").at(A).x, -box("braceRight").at(A).x);
    const bal = box("balanced");
    eq("双向平衡：主分支分到两侧", [bal.at(A).x > 0, bal.at(C).x < 0], [true, true]);
    const rad = box("radial");
    const rOf = (id: string) => Math.round(Math.hypot(rad.at(id).x, rad.at(id).y));
    eq("放射图：一级分支同处一圈", [rOf(A), rOf(B), rOf(C)], [rOf(A), rOf(A), rOf(A)]);
    ok("放射图：子分支比父分支离中心更远", rOf(A1) > rOf(A), `${rOf(A1)} ≤ ${rOf(A)}`);
    const pack = box("circlePacking");
    ok(
      "圆形图：一级分支也成圈",
      Math.abs(Math.hypot(pack.at(A).x, pack.at(A).y) - Math.hypot(pack.at(B).x, pack.at(B).y)) < 1,
      ""
    );
    const fb = box("fishboneRight");
    eq(
      "鱼骨图（右）：主分支沿 x 递增且上下分列",
      [fb.at(A).x < fb.at(B).x, fb.at(A).y < 0, fb.at(B).y > 0],
      [true, true, true]
    );
    eq("鱼骨图（左）镜像", Math.round(box("fishboneLeft").at(A).x), Math.round(-fb.at(A).x));
    const mx = box("matrix");
    eq(
      "矩阵图：主分支落进不同象限",
      [
        `${Math.sign(mx.at(A).x)},${Math.sign(mx.at(A).y)}`,
        `${Math.sign(mx.at(B).x)},${Math.sign(mx.at(B).y)}`,
      ],
      ["1,-1", "1,1"]
    );
    const wd = box("timelineWinding");
    eq(
      "S 型时间线：折返列在下一列才换 x",
      [Math.abs(wd.at(A).x - wd.at(B).x) < 0.01, wd.at(C).x > wd.at(B).x],
      [true, true]
    );
    // 自由布局不分派：位置就是 Shape.transform 存的那一份
    const fr = box("free");
    eq("自由布局：主题位置原样不动", fr.at(A).x, cur.shapes[A].transform.x);
  }
}

// ---------------------------------------------------------------- 文本测量原语
{
  eq(
    "中日韩按 1 em、空格按 0.3 em",
    [charWidth("中", 10), charWidth("　", 10), charWidth(" ", 10)],
    [10, 10, 3]
  );
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
    [root(), m, s].map((id) =>
      Math.max(
        DEFAULTS.topicMinW,
        Math.round(
          textWidth(
            plainText(cur.shapes[id].text),
            styleFor(cur, cur.shapes[id], palette).font.size
          ) + PAD
        )
      )
    )
  );
  eq(
    "字号确实按层级递减",
    [root(), m, s].map((id) => styleFor(cur, cur.shapes[id], palette).font.size),
    [14, 12, 10]
  );
}

// ---------------------------------------------------------------- 主题框宽：固定 / 自动
{
  cur = createPage("框宽");
  const a = add(root(), "短");
  const b = add(root(), "这是一条明显长得多得多的分支主题");
  const auto = computeLayout(cur);
  const fixed = computeLayout(cur, { topicWidthMode: "fixed" });
  const widest = Math.max(...Object.values(auto.boxes).map((x) => x.w));
  ok("自动模式下长短不一", auto.boxes[a].w < auto.boxes[b].w);
  eq("固定模式整页同一个框宽", new Set(Object.values(fixed.boxes).map((x) => x.w)).size, 1);
  eq("固定取的是本页最宽那个", fixed.boxes[a].w, widest);
  ok("长主题不再靠撑宽，靠折行", fixed.boxes[b].lines.length >= auto.boxes[b].lines.length);
  ok("折出来的行数不会把盒子压矮", fixed.boxes[b].h >= auto.boxes[b].h);
  const p = paintPage(cur, { topicWidthMode: "fixed" });
  eq("画布与导出共用同一个开关", new Set(p.boxes.map((x) => x.w)).size, 1);
}

done();
