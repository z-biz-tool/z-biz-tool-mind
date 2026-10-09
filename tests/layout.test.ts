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
 *    组织结构图（上下双向）压进中心主题，都是这么露出来的；
 * 7) 直角折线（树状图/组织结构图/矩阵图/竖向时间线的一级分支）一段斜线都不许有：
 *    elbowPath 曾经把"横、斜、竖"当成直角折线，只有截图才看得出来。
 *    判定必须逐条连线看（路径里有没有 C），按版式码整族分类会在曲线上恒真。
 * 8) 交叉树是反过来的一族：线本来就是一条斜穿过去的直线段，交叉是它的目的。
 *    它同样"没有 C"，所以不能塞进第 7 条的筛子里 —— 得单独一族判定"每条线恰好两点"，
 *    并要求层与层之间真的出现交叉。
 * 9) 顺/逆时针两码的唯一差别就是绕向：判定要把角度折成"从 12 点起、顺时针 0..360"再比单调，
 *    直接比 atan2 会在 ±180° 处断掉（-135° 看着比 135°"小"，其实是顺时针更靠后）。
 *    双向平衡向下 名字属于"平衡"一族、几何却是两条向下的条带，连线判定跟着几何走而不是跟着名字走。
 * 10) 自由布局是 P-2"位置是算出来的"那条规矩的完整例外（不再只有浮动根例外）：
 *    切进去要把屏幕上的位置钉进 transform，被折叠或"显示层级"挡在布局外的主题也得补一份，
 *    否则用户放开折叠就看到一整枝叠在中心主题上。
 * 11) 分支自由布局（00 §3.3）是叠加在智慧版式结果上的一次整体平移，只对二级主题生效：
 *    断言要按"整枝位移相同、别的枝与中心主题不动"来写，只比枝根那一个盒子内不能发现
 *    "只挪了根、孙子留在原地"这种最像真确的错。
 */
import { done, eq, near, ok } from "./_harness.ts";
import { createPage } from "../src/model/factory.ts";
import {
  charWidth,
  computeLayout,
  measureShape,
  textWidth,
  toFreeLayout,
  wrapText,
} from "../src/engine/layout.ts";
import { paintPage, renderSvg } from "../src/engine/export/svg.ts";
import type { NodeBox } from "../src/engine/layout.ts";
import { defaultPalette, EDRAW_FONT_SIZES, styleFor } from "../src/engine/style.ts";
import {
  insertChild,
  resetBranch,
  setCollapsed,
  setFloating,
  shiftBranch,
  updateStyle,
  updateText,
  updateTransform,
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

// ---------------------------------------------------------------- 自由布局：整张图的位置都归用户
{
  cur = createPage("自由布局");
  const a = add(root(), "甲");
  const a1 = add(a, "甲一");
  const a2 = add(a, "甲二");
  const b = add(root(), "乙");
  const ids = [a, a1, a2, b];
  const before = computeLayout(cur);
  let p = toFreeLayout(cur);
  eq("切进去就改成了 free 码", p.layout.code, "free");
  eq(
    "钉住的位置 = 切进来那一刻屏幕上算出来的位置，一个像素都不差",
    ids.map((id) => [p.shapes[id].transform.x, p.shapes[id].transform.y]),
    ids.map((id) => [before.boxes[id].x, before.boxes[id].y])
  );
  eq(
    "钉完再布局不许跳位（跳了就是引擎还在重算）",
    ids.map((id) => {
      const L = computeLayout(p).boxes[id];
      return [L.x, L.y];
    }),
    ids.map((id) => [before.boxes[id].x, before.boxes[id].y])
  );
  eq("已经在这儿了就是空操作", toFreeLayout(p) === p, true);

  // 画布上拖主题落进的就是这条 updateTransform（过去只有浮动根能用它）
  p = updateTransform(p, a1, { x: 999, y: -77 });
  eq(
    "自由布局里主题停在哪就是哪",
    (() => {
      const L = computeLayout(p).boxes[a1];
      return [L.x, L.y];
    })(),
    [999, -77]
  );
  eq("再切一次 free 也不把用户拖出来的位置冲掉", toFreeLayout(p).shapes[a1].transform.x, 999);

  // 折叠着的分支不在布局里，不补一份位置的话用户放开折叠就看到一整枝叠在中心主题上
  cur = createPage("自由布局含折叠");
  const c = add(root(), "丙");
  const c1 = add(c, "丙一");
  const c2 = add(c, "丙二");
  cur = setCollapsed(cur, c, true);
  ok("折叠后这一枝确实不在布局里", !computeLayout(cur).boxes[c1]);
  const pf = setCollapsed(toFreeLayout(cur), c, false);
  const off = computeLayout(pf);
  ok(
    "放开折叠后主题不叠在原点上",
    [c1, c2].every((id) => Math.abs(off.boxes[id].x) > 1 || Math.abs(off.boxes[id].y) > 1),
    ""
  );
  ok(
    "补出来的位置各算各的，同排两个主题不叠在一起",
    off.boxes[c1].x !== off.boxes[c2].x || off.boxes[c1].y !== off.boxes[c2].y,
    ""
  );
  ok("整枝都落在父主题外侧", off.boxes[c1].x > pf.shapes[c].transform.x, "");

  // 被"显示层级"裁掉的主题走的是同一条补位置的路，而屏上看得见的那几层必须原位不动
  cur = createPage("自由布局含深层");
  const d = add(root(), "丁");
  const d1 = add(d, "丁一");
  const shown = computeLayout(cur, { displayLevel: 1 });
  const pd = toFreeLayout(cur, { displayLevel: 1 });
  eq(
    "看得见的第一层钉的是屏幕上的位置",
    [pd.shapes[d].transform.x, pd.shapes[d].transform.y],
    [shown.boxes[d].x, shown.boxes[d].y]
  );
  ok(
    "被裁掉的深处主题也有位置，放开层级不会叠回原点",
    Math.abs(pd.shapes[d1].transform.x) > 1 || Math.abs(pd.shapes[d1].transform.y) > 1,
    ""
  );
}

// ---------------------------------------------------------------- 分支自由布局：智慧版式里把一整枝拖开（00 §3.3）
{
  cur = createPage("分支自由");
  const a = add(root(), "甲");
  const a1 = add(a, "甲一");
  const a11 = add(a1, "甲一一");
  const b = add(root(), "乙");
  const b1 = add(b, "乙一");
  const moved = [a, a1, a11];
  const still = [b, b1];
  const base = computeLayout(cur);
  const at = (L: typeof base, id: string) => [L.boxes[id].x, L.boxes[id].y];

  eq("没拖过就是空写，page 都还是同一个", shiftBranch(cur, a, 0, 0) === cur, true);
  let p = shiftBranch(cur, a, 40, -25);
  eq("位移记在被拖的那一条二级主题上", p.shapes[a].offset, { x: 40, y: -25 });
  const L = computeLayout(p);
  eq(
    "整枝一起走：根、子、孙的位移一模一样",
    moved.map((id) => at(L, id).map((v, i) => v - at(base, id)[i])),
    [
      [40, -25],
      [40, -25],
      [40, -25],
    ]
  );
  eq(
    "别的枝和中心主题都留在引擎算出来的地方",
    [...still, root()].map((id) => at(L, id)),
    [...still, root()].map((id) => at(base, id))
  );
  eq(
    "枝内相对结构没被压扁：子还是在父外侧同样的距离",
    [L.boxes[a1].x - L.boxes[a].x, L.boxes[a11].x - L.boxes[a1].x],
    [base.boxes[a1].x - base.boxes[a].x, base.boxes[a11].x - base.boxes[a1].x]
  );

  // 第二次拖是在屏幕上接着走，不是把上一次的距离当成新起点
  p = shiftBranch(p, a, -10, 5);
  eq("两次拖累加", p.shapes[a].offset, { x: 30, y: -20 });
  p = shiftBranch(p, a, -30, 20);
  eq("拖回原位就不算被拖过（不留一个 {0,0} 进文件）", "offset" in p.shapes[a], false);
  eq(
    "位置也确实回到了原来那一份",
    moved.map((id) => at(computeLayout(p), id)),
    moved.map((id) => at(base, id))
  );

  // 右键菜单的复位走另一条入口，行为要和"拖回原位"一致
  p = resetBranch(shiftBranch(cur, b, 12, 34), b);
  eq("复位摘掉字段", "offset" in p.shapes[b], false);
  eq("复位后位置回到引擎那份", at(computeLayout(p), b1), at(base, b1));
  eq("没拖过的主题复位是空写", resetBranch(cur, b) === cur, true);

  // 三级往上的位移引擎不认：枝内结构归布局，不然换版式时没法解释一堆枝内偏移
  const deep = shiftBranch(cur, a1, 100, 100);
  eq(
    "只有二级主题上的位移生效",
    [a1, a11].map((id) => at(computeLayout(deep), id)),
    [a1, a11].map((id) => at(base, id))
  );

  // 连线读的是同一份 boxes，整枝跟着走是免费的；不能顺手多画或少画一条
  const wired = computeLayout(shiftBranch(cur, a, 60, 0));
  eq("连线条数不变", wired.connectors.length, base.connectors.length);
  ok(
    "拖过的那一条连线形状变了（端点跟着盒子走）",
    wired.connectors.find((c) => c.toId === a1)!.d !==
      base.connectors.find((c) => c.toId === a1)!.d,
    ""
  );
  eq(
    "没拖的那一条一个字都不差",
    wired.connectors.find((c) => c.toId === b1)!.d,
    base.connectors.find((c) => c.toId === b1)!.d
  );

  // 主轴类版式：沿主轴拖远要把轴伸长，横拖不该让轴拐弯（轴身是穿过中心主题的那条直线）
  const nums = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  const tl = (page: typeof cur) =>
    computeLayout({ ...page, layout: { ...page.layout, code: "timelineHorizontal" } });
  const t0 = tl(cur);
  const along = tl(shiftBranch(cur, b, 120, 0));
  const cross = tl(shiftBranch(cur, b, 0, 90));
  eq("沿主轴拖远，主轴末端跟着伸长", nums(along.axis!.d)[2] > nums(t0.axis!.d)[2], true);
  eq("横拖不改主轴的纵向位置（轴还是原来那条直线）", nums(cross.axis!.d)[1], nums(t0.axis!.d)[1]);
  eq("但主题自己确实离开了轴", cross.boxes[b].y !== t0.boxes[b].y, true);

  // 切进自由布局要把"含位移的屏幕位置"当成用户坐标钉住，位移本身不能再加一次
  const dragged = shiftBranch(cur, a, 50, 50);
  const onScreen = computeLayout(dragged);
  const baked = toFreeLayout(dragged);
  eq(
    "钉进 transform 的是拖过之后的屏幕位置",
    [baked.shapes[a11].transform.x, baked.shapes[a11].transform.y],
    [onScreen.boxes[a11].x, onScreen.boxes[a11].y]
  );
  eq("自由布局里不会再叠加一次位移", at(computeLayout(baked), a11), [
    onScreen.boxes[a11].x,
    onScreen.boxes[a11].y,
  ]);

  // 拖动中的实时跟随（§1.3-12 遗留）：临时位移只进这一帧的 boxes，不碰 model
  const liveIn = (page: typeof cur, id: string, x: number, y: number) =>
    computeLayout(page, { liveBranch: { id, x, y } });
  const pv = liveIn(cur, a, 30, -10);
  eq(
    "预览里整枝跟着走",
    moved.map((id) => at(pv, id).map((v, i) => v - at(base, id)[i])),
    [
      [30, -10],
      [30, -10],
      [30, -10],
    ]
  );
  eq(
    "别的枝与中心主题不动",
    [...still, root()].map((id) => at(pv, id)),
    [...still, root()].map((id) => at(base, id))
  );
  eq("预览不写 model：位移没落到 Shape.offset 上", "offset" in cur.shapes[a], false);
  eq(
    "同一帧再算一次不带预览，就回到存档位置（预览是纯函数，没有残留）",
    at(computeLayout(cur), a11),
    at(base, a11)
  );
  eq(
    "预览叠在已存位移之上（接着屏幕走，不是从存档位置重算）",
    at(liveIn(shiftBranch(cur, a, 40, -25), a, 10, 5), a),
    [at(base, a)[0] + 50, at(base, a)[1] - 20]
  );
  eq(
    "松手不跳位：提交同样的位移之后，盒子与预览逐值相同",
    moved.map((id) => at(computeLayout(shiftBranch(cur, a, 30, -10)), id)),
    moved.map((id) => at(pv, id))
  );
  eq("三级上的预览同样不生效（只有二级吃位移）", at(liveIn(cur, a1, 100, 100), a11), at(base, a11));
  const freeLive = { ...cur, layout: { ...cur.layout, code: "free" as LayoutCode } };
  eq(
    "自由布局里没有预览位移这回事（那里的坐标本来就是用户的）",
    at(liveIn(freeLive, a, 30, -10), a),
    at(computeLayout(freeLive), a)
  );
  eq("预览不改连线条数", pv.connectors.length, base.connectors.length);
  ok(
    "预览里连线端点跟着走",
    pv.connectors.find((c) => c.toId === a1)!.d !== base.connectors.find((c) => c.toId === a1)!.d,
    ""
  );
  eq(
    "没拖的那一条连线一个字都不差",
    pv.connectors.find((c) => c.toId === b1)!.d,
    base.connectors.find((c) => c.toId === b1)!.d
  );
  // 画布读的是 paintPage 那一份，参数收下却不转给 computeLayout 就等于没做（真会踩：选项加了、转发漏了）
  const p0 = paintPage(cur);
  const p1 = paintPage(cur, { liveBranch: { id: a, x: 30, y: -10 } });
  const atPaint = (P: typeof p0, id: string) => {
    const b = P.boxes.find((x) => x.id === id)!;
    return [b.x, b.y];
  };
  eq(
    "paintPage 转发预览位移：整枝逐值平移",
    moved.map((id) => atPaint(p1, id).map((v, i) => v - atPaint(p0, id)[i])),
    [
      [30, -10],
      [30, -10],
      [30, -10],
    ]
  );
  eq(
    "没拖的盒子一个像素不动",
    still.map((id) => atPaint(p1, id)),
    still.map((id) => atPaint(p0, id))
  );
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
  /** 整族折线的版式：树状图 / 组织结构图 / 矩阵图，加上条带向下的双向平衡向下。 */
  const isElbowFamily = (code: LayoutCode) =>
    code.startsWith("tree") ||
    code.startsWith("org") ||
    code === "matrix" ||
    code === "balancedDown";
  /** 整族曲线的版式：横着推进的三条时间线（竖直主轴那条才是混用族）+ 绕圈的一族。 */
  const CURVE_FAMILY: LayoutCode[] = [
    "timelineHorizontal",
    "timelineLeft",
    "timelineWinding",
    "radial",
    "sunburst",
    "circlePacking",
    "logicClockwise",
    "logicCounterclockwise",
  ];
  const isCurveFamily = (code: LayoutCode) => CURVE_FAMILY.includes(code);
  /** 整族斜线的版式：交叉树两码，一条线段从父框直接穿到子框。 */
  const isSlantFamily = (code: LayoutCode) => code === "stagger" || code === "staggerUp";
  /** 逐条判定：路径里没有 C 才是直角折线。 */
  const isElbow = (d: string) => !d.includes("C");
  /** 数一条路径里有几段斜线：直角折线族出现斜线段就是画错了（组织结构图曾经中间一段是斜的）。 */
  const slanted = (d: string) => {
    const n = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    let bad = 0;
    for (let i = 2; i + 1 < n.length; i += 2)
      if (n[i] !== n[i - 2] && n[i + 1] !== n[i - 1]) bad += 1;
    return bad;
  };
  /** 折线的顶点序列（M/L 都是绝对坐标，两两成点）。 */
  const pts = (d: string): [number, number][] => {
    const n = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    const out: [number, number][] = [];
    for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]);
    return out;
  };
  /** 严格相交的连线对数：共端点（同父的兄弟从同一个点出发）不算交叉。 */
  const crossings = (L: ReturnType<typeof computeLayout>) => {
    const cr = (o: number[], p: number[], q: number[]) =>
      (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    let n = 0;
    for (let i = 0; i < L.connectors.length; i += 1)
      for (let j = i + 1; j < L.connectors.length; j += 1) {
        const a = pts(L.connectors[i].d);
        const b = pts(L.connectors[j].d);
        for (let x = 0; x + 1 < a.length; x += 1)
          for (let y = 0; y + 1 < b.length; y += 1)
            if (
              cr(a[x], a[x + 1], b[y]) * cr(a[x], a[x + 1], b[y + 1]) < 0 &&
              cr(b[y], b[y + 1], a[x]) * cr(b[y], b[y + 1], a[x + 1]) < 0
            )
              n += 1;
      }
    return n;
  };
  /** 严格落在框内才算（贴边是连线的正常落点）。 */
  const insideBox = (b: NodeBox, x: number, y: number) =>
    x > b.x - b.w / 2 + 0.5 &&
    x < b.x + b.w / 2 - 0.5 &&
    y > b.y - b.h / 2 + 0.5 &&
    y < b.y + b.h / 2 - 0.5;

  ok("版式码表至少 32 码（蓝本 §3.3 的族与变体）", CODES.length >= 32, CODES.join(","));
  for (const code of CODES) {
    const L = computeLayout({ ...cur, layout: { ...cur.layout, code } });
    eq(`${code}：每个主题都算出盒子`, ids.filter((id) => !L.boxes[id]).length, 0);
    eq(`${code}：连线数 = 主题数 - 1`, L.connectors.length, ids.length - 1);
    if (code !== "free") eq(`${code}：主题互不压框`, overlaps(L), []);
    // 斜线族"没有 C"但不是折线，混进下面的斜段检测会把自己判挂
    const elbows = isSlantFamily(code) ? [] : L.connectors.filter((c) => isElbow(c.d));
    if (isSlantFamily(code)) {
      eq(
        `${code}：每条连线就是一段直线（两点）`,
        L.connectors.filter((c) => pts(c.d).length !== 2).map((c) => c.id),
        []
      );
      eq(`${code}：连线之间真的交叉`, crossings(L) >= 1, true);
    }
    if (isElbowFamily(code))
      eq(
        `${code}：整族连线都是直角折线`,
        L.connectors.filter((c) => !isElbow(c.d)).map((c) => c.id),
        []
      );
    if (isCurveFamily(code))
      eq(
        `${code}：整族连线都是曲线`,
        elbows.map((c) => c.id),
        []
      );
    if (code === "timelineVertical" || code === "timelineUp") {
      // 两种走向混用：一级分支竖着接、更深的子主题横着接，缺一半就是改坏了分发
      eq(
        `${code}：折线与曲线各占一半以上`,
        [elbows.length >= 3, L.connectors.length - elbows.length >= 3],
        [true, true]
      );
    }
    // 斜段与"出线后折回父框"只在折线上成立，曲线本来就该是斜的：逐条判定，别按码整族判。
    eq(
      `${code}：直角折线一段斜线都没有`,
      elbows.filter((c) => slanted(c.d) > 0).map((c) => c.id),
      []
    );
    // 垂直时间线的首枝曾经如此（根底边 17.5、首枝顶边 15，折线中线落在 16.25，
    // 线从底边出来又钻回根框）。
    eq(
      `${code}：直角折线出线后不折回父框`,
      elbows
        .filter((c) => {
          const p = L.boxes[L.boxes[c.toId].parentId ?? ""];
          const v = pts(c.d);
          return !p || v.length < 2 || insideBox(p, v[1][0], v[1][1]);
        })
        .map((c) => c.id),
      []
    );
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
    const { L, at } = box("orgBoth");
    const rootBox = at(root());
    const first = Math.min(at(A).y, at(C).y);
    ok(
      "上下双向：下行分支的顶边在中心主题底边之下",
      first - at(A).h / 2 >= rootBox.y + rootBox.h / 2,
      `实际 ${first - at(A).h / 2} < ${rootBox.y + rootBox.h / 2}`
    );
    eq("上下双向：主分支分到上下两排", [at(A).y > 0, at(B).y < 0, at(C).y > 0], [true, true, true]);
    // 连线进出的是哪条边：上行枝要从顶边出、从子框底边进，写死"底出顶进"会让线穿回中心主题
    const nums = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    const dn = nums(L.connectors.find((c) => c.toId === A)?.d ?? "");
    const upp = nums(L.connectors.find((c) => c.toId === B)?.d ?? "");
    eq(
      "上下双向：下行连线从中心主题底边出、进子框顶边",
      [dn[1], dn[dn.length - 1]],
      [rootBox.y + rootBox.h / 2, at(A).y - at(A).h / 2]
    );
    eq(
      "上下双向：上行连线从中心主题顶边出、进子框底边",
      [upp[1], upp[upp.length - 1]],
      [rootBox.y - rootBox.h / 2, at(B).y + at(B).h / 2]
    );
  }

  // 双向平衡向下：分侧照"双向平衡"（前半右、后半左），生长方向照组织结构图的条带（都朝下）
  {
    const { at } = box("balancedDown");
    const rootBox = at(root());
    eq(
      "双向平衡向下：除中心主题外全在下方",
      ids.filter((id) => id !== root() && at(id).y <= rootBox.y),
      []
    );
    eq(
      "双向平衡向下：主分支分到左右两半",
      [at(A).x > 0, at(B).x > 0, at(C).x < 0],
      [true, true, true]
    );
    ok(
      "双向平衡向下：一级分支同排横铺（不是上下两排）",
      Math.abs(at(A).y - at(B).y) < 0.01 && Math.abs(at(B).y - at(C).y) < 0.01,
      `${at(A).y}/${at(B).y}/${at(C).y}`
    );
    // 分派的是一条带还是两条带：orgBoth 按奇偶上下分，本族按前半后半左右分 —— B 的位置正好相反
    const ob = box("orgBoth");
    eq("双向平衡向下 ≠ 上下双向：B 回到下排", [at(B).y > 0, ob.at(B).y < 0], [true, true]);
    eq(
      "双向平衡向下：条带内部仍按深度往下推进",
      [at(A1).y > at(A).y, at(A11).y > at(A1).y],
      [true, true]
    );
    ok(
      "双向平衡向下：一级分支顶边在中心主题底边之下",
      at(A).y - at(A).h / 2 >= rootBox.y + rootBox.h / 2,
      `${at(A).y - at(A).h / 2} < ${rootBox.y + rootBox.h / 2}`
    );
  }

  // 三条时左半只有一个分支，反着铺看不出来 —— 四枝才暴露"由内向外"的分支序
  {
    let p = createPage("平衡向下四枝");
    const ins = (parentId: string, text: string) => {
      const r = insertChild(p, parentId, text);
      p = r.page;
      return r.id;
    };
    const r0 = p.rootId;
    const kA = ins(r0, "分支A");
    const kB = ins(r0, "分支B");
    const kC = ins(r0, "分支C");
    const kD = ins(r0, "分支D");
    const L = computeLayout({ ...p, layout: { ...p.layout, code: "balancedDown" } });
    const at = (id: string) => L.boxes[id];
    eq("四枝：右半按文档序由内向外铺", at(kA).x < at(kB).x && at(kA).x > 0, true);
    eq("四枝：左半反过来铺，C 靠内、D 靠外", at(kC).x > at(kD).x && at(kC).x < 0, true);
    ok(
      "四枝：两半之间留出一条间距（不是肩并肩挤到 x=0）",
      at(kA).x - at(kA).w / 2 - (at(kC).x + at(kC).w / 2) >= DEFAULTS.vSpacing - 0.01,
      `实测间隙 ${at(kA).x - at(kA).w / 2 - (at(kC).x + at(kC).w / 2)}`
    );
    eq(
      "四枝：左右两半互不越界",
      [Math.max(at(kA).x, at(kB).x) > 0, Math.min(at(kC).x, at(kD).x) < 0],
      [true, true]
    );
  }

  // 交叉树：同层错位排（先排完各家第 1 子再排第 2 子），线因此穿起来
  {
    const st = box("stagger");
    eq(
      "交叉树：一层一行，A二 被 B一 挤到右边去",
      [st.at(A1).x < st.at(B1).x, st.at(B1).x < st.at(A2).x],
      [true, true]
    );
    eq(
      "交叉树：第二层三个主题同排",
      [st.at(A1).y, st.at(A1).y - st.at(B1).y, st.at(A1).y - st.at(A2).y],
      [st.at(A1).y, 0, 0]
    );
    eq("交叉树：向下生长", st.at(A).y > st.at(root()).y, true);
    const symOrdered = box("treeDownSym").at(A2).x < box("treeDownSym").at(B1).x;
    const stagOrdered = st.at(A2).x < st.at(B1).x;
    ok(
      "交叉树不是对称树：同一层的左右顺序不一样（对称式把 A二 排在 B一 左边）",
      symOrdered !== stagOrdered,
      ""
    );
    eq("交叉树：连线交叉数 > 0", crossings(st.L) >= 1, true);
    const su = box("staggerUp");
    eq("交叉树向上：向上生长", su.at(A).y < su.at(root()).y, true);
    // 同一套 layoutStagger 只把 dirY 翻号：沿 y 镜像（各自取整，容 ±1），x 原样
    near("交叉树向上 = 交叉树沿 y 镜像", su.at(A1).y, -st.at(A1).y, 1.01);
    eq("交叉树向上的 x 不动", su.at(A1).x, st.at(A1).x);
    eq("交叉树向上的连线也交叉", crossings(su.L) >= 1, true);
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
    // 主轴推进从中心主题的外缘起算：首枝的近侧缘必须在根的对侧缘之外，否则折线会出框又折回框里。
    const vr = v.at(root());
    ok(
      "垂直时间线：首枝顶边在中心主题底边之下",
      v.at(A).y - v.at(A).h / 2 >= vr.y + vr.h / 2,
      `实际 ${v.at(A).y - v.at(A).h / 2} < ${vr.y + vr.h / 2}`
    );
    const hr = h.at(root());
    ok(
      "水平时间线：首枝左缘在中心主题右缘之右",
      h.at(A).x - h.at(A).w / 2 >= hr.x + hr.w / 2,
      `实际 ${h.at(A).x - h.at(A).w / 2} < ${hr.x + hr.w / 2}`
    );
    // 向上 / 向左是同一套 layoutSpine 把 dir 翻号，所以只该"沿主轴镜像"，另一根轴原样不动
    const u = box("timelineUp");
    eq(
      "时间轴（向上）：一级分支沿 y 反向推进、左右交替与向下同侧",
      [u.at(A).y > u.at(B).y, u.at(B).y > u.at(C).y, u.at(A).x < 0, u.at(B).x > 0],
      [true, true, true, true]
    );
    // 镜像允许 ±1：坐标各自取整，-77 与 -78 是同一个位置（跨轴那根才是精确同值）
    near("时间轴（向上）= 向下沿 y 镜像", u.at(A1).y, -v.at(A1).y, 1.01);
    eq("时间轴（向上）的 x 与向下完全同值", u.at(A1).x, v.at(A1).x);
    const le = box("timelineLeft");
    eq(
      "时间轴（向左）：一级分支沿 x 反向推进、上下交替与向右同侧",
      [le.at(A).x > le.at(B).x, le.at(B).x > le.at(C).x, le.at(A).y < 0, le.at(B).y > 0],
      [true, true, true, true]
    );
    near("时间轴（向左）= 向右沿 x 镜像", le.at(A1).x, -h.at(A1).x, 1.01);
    eq("时间轴（向左）的 y 与向右完全同值", le.at(A1).y, h.at(A1).y);
  }

  // 主轴：时间轴四向 + 鱼骨左右要画出一条带箭头的轴，其余版式没有轴
  {
    const axisOf = (code: LayoutCode) =>
      computeLayout({ ...cur, layout: { ...cur.layout, code } }).axis;
    const noAxis = CODES.filter(
      (c) =>
        axisOf(c) &&
        !["timelineHorizontal", "timelineLeft", "timelineVertical", "timelineUp"].includes(c) &&
        c !== "fishboneRight" &&
        c !== "fishboneLeft"
    );
    eq("只有主轴类版式给轴", noAxis, []);
    const noAxis2 = CODES.filter(
      (c) =>
        !axisOf(c) &&
        (c.startsWith("timeline") || c.startsWith("fishbone")) &&
        c !== "timelineWinding"
    );
    eq("主轴类版式个个都有轴", noAxis2, []);
    const ha = axisOf("timelineHorizontal")!;
    const la = axisOf("timelineLeft")!;
    const va = axisOf("timelineVertical")!;
    const ua = axisOf("timelineUp")!;
    // 轴身是一条 M/L，箭头是两条短线：三段都在，缺一段就是画了半条轴
    eq("轴身是一条直线段", (ha.d.match(/L/g) ?? []).length, 1);
    eq("箭头两条短线", (ha.head.match(/L/g) ?? []).length, 2);
    const [h0, h1] = pts(ha.d);
    const [l0, l1] = pts(la.d);
    const [v0, v1] = pts(va.d);
    const [u0, u1] = pts(ua.d);
    ok("向右：轴往正方向伸", h1[0] > h0[0], ha.d);
    ok("向左：轴往负方向伸", l1[0] < l0[0], la.d);
    ok("向下：轴沿 y 正向伸", v1[1] > v0[1], va.d);
    ok("向上：轴沿 y 负向伸", u1[1] < u0[1], ua.d);
    near("向左 = 向右沿 x 镜像（轴身端点）", l1[0], -h1[0]);
    eq("向左 = 向右沿 x 镜像（y 不动）", l1[1], h1[1]);
    near("向上 = 向下沿 y 镜像（轴身端点）", u1[1], -v1[1], 1.01);
    eq("向上 = 向下沿 y 镜像（x 不动）", u1[0], v1[0]);
    const fb = pts(axisOf("fishboneRight")!.d);
    // 轴穿过一级分支的锚点：水平主轴时锚点就在中心主题的中心线上
    eq("水平主轴与中心主题同高", fb[0][1], fb[1][1]);
    eq("竖直主轴与中心主题同列", v0[0], v1[0]);
    // 轴不能从中心主题的圆心起画（会把根框压在轴下），要从它的前缘起
    const rootBox = box("timelineHorizontal").at(root());
    ok("向右：轴起点在中心主题右缘之外", h0[0] >= rootBox.x + rootBox.w / 2 - 0.5, `${h0[0]}`);
    ok("轴终点越过最后一个一级分支", h1[0] > rootBox.x, `${h1[0]}`);
    ok("轴色跟中心主题的线色同源", ha.line === va.line && ha.line.length > 3, ha.line);
    // 画布与导出共用一份：轴进了布局结果，导出就必须原样抄一遍，不许有第二条画法
    const axisSvg = renderSvg(
      paintPage({ ...cur, layout: { ...cur.layout, code: "timelineHorizontal" } })
    );
    const plainSvg = renderSvg(
      paintPage({ ...cur, layout: { ...cur.layout, code: "logicRight" } })
    );
    const strokes = (s: string) => (s.match(/ stroke-width="2"/g) ?? []).length;
    eq("导出 SVG 里多出两条轴线（轴身 + 箭头）", strokes(axisSvg) - strokes(plainSvg), 2);
    ok("导出的轴身与布局同一份 path", axisSvg.includes(ha.d), ha.d);
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
    // 扇形放射图 = 放射图只取上半圈：整张图压在中心主题之上，一级分支仍同处一圈
    const sun = box("sunburst");
    const rr = (id: string) =>
      Math.round(Math.hypot(sun.at(id).x, sun.at(id).y - sun.at(root()).y));
    eq(
      "扇形放射图：除中心主题外全在上方",
      ids.filter((id) => id !== root() && sun.at(id).y >= sun.at(root()).y),
      []
    );
    eq("扇形放射图：一级分支同处一圈", [rr(A), rr(B), rr(C)], [rr(A), rr(A), rr(A)]);
    // 第二层也必须踩在同一道弧上：半径一旦改成"从各自父节点量"（链式），这一层就散开，
    // 整张图斜着甩成一坨 —— 装机目检就是这么发现的，靠上面那条一级分支的断言抓不到。
    eq(
      "扇形放射图：二级分支也同处一圈，且比一级那圈更远",
      [rr(A1), rr(A2), rr(B1), rr(A1) < rr(A11)],
      [rr(A1), rr(A1), rr(A1), true]
    );
    ok("扇形放射图：子分支离中心更远", rr(A1) > rr(A), `${rr(A1)} ≤ ${rr(A)}`);
    const pack = box("circlePacking");
    ok(
      "圆形图：一级分支也成圈",
      Math.abs(Math.hypot(pack.at(A).x, pack.at(A).y) - Math.hypot(pack.at(B).x, pack.at(B).y)) < 1,
      ""
    );
    // 顺时针 / 逆时针：与放射图共用同一份半径表，差别全在"从 12 点起步"和绕向
    const cw = box("logicClockwise");
    const ccw = box("logicCounterclockwise");
    /** 折成"从 12 点起、顺时针 0..360"：atan2 在 ±180° 处断掉，-135° 其实是顺时针更靠后。 */
    const at12 = (at: (id: string) => NodeBox, id: string) => {
      const r0 = at(root());
      const q = at(id);
      return (Math.round((Math.atan2(q.x - r0.x, -(q.y - r0.y)) * 180) / Math.PI) + 360) % 360;
    };
    const ringR = (at: (id: string) => NodeBox, id: string) =>
      Math.round(Math.hypot(at(id).x - at(root()).x, at(id).y - at(root()).y));
    const cwSeq = [A, B, C].map((id) => at12(cw.at, id));
    const ccwSeq = [A, B, C].map((id) => at12(ccw.at, id));
    ok(
      "思维导图（顺时针）：文档序 = 从 12 点起顺时针绕",
      cwSeq.every((v, i) => i === 0 || v > cwSeq[i - 1]),
      cwSeq.join(",")
    );
    ok(
      "思维导图（逆时针）：文档序 = 从 12 点起逆时针绕",
      ccwSeq.every((v, i) => i === 0 || v < ccwSeq[i - 1]),
      ccwSeq.join(",")
    );
    eq("两码的首枝都落在起步方向的前半圈", [cw.at(A).x > 0, ccw.at(A).x < 0], [true, true]);
    eq(
      "绕圈两码铺满一整圈（扇形放射图那族才只取半圈）",
      [
        [1, -1].every((s) => [A, B, C].some((id) => Math.sign(cw.at(id).y) === s)),
        [1, -1].every((s) => [A, B, C].some((id) => Math.sign(cw.at(id).x) === s)),
      ],
      [true, true]
    );
    eq(
      "绕圈两码：一级分支同处一圈",
      [ringR(cw.at, A), ringR(cw.at, B), ringR(cw.at, C)],
      [ringR(cw.at, A), ringR(cw.at, A), ringR(cw.at, A)]
    );
    // 半径必须是"以根为圆心的同心环"：链式那套（放射图在用）会把二三级一路甩出画布，
    // 装机目检就是这么打回这两码的第一版的 —— 一级同圈抓不到，两层都得钉住。
    eq(
      "绕圈两码：二级分支也同处一圈，且比一级那圈更远",
      [ringR(cw.at, A1), ringR(cw.at, A2), ringR(cw.at, B1), ringR(cw.at, A1) > ringR(cw.at, A)],
      [ringR(cw.at, A1), ringR(cw.at, A1), ringR(cw.at, A1), true]
    );
    eq(
      "绕圈两码共用同一份环半径",
      [ringR(ccw.at, A), ringR(ccw.at, A1)],
      [ringR(cw.at, A), ringR(cw.at, A1)]
    );
    ok(
      "顺时针：更深的分支离中心更远",
      ringR(cw.at, A1) > ringR(cw.at, A),
      `${ringR(cw.at, A1)} ≤ ${ringR(cw.at, A)}`
    );
    eq(
      "逆时针 = 顺时针沿纵轴镜像（x 反号、y 不动）",
      ids.filter(
        (id) =>
          Math.abs(cw.at(id).x + ccw.at(id).x) > 1.01 || Math.abs(cw.at(id).y - ccw.at(id).y) > 1.01
      ),
      []
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
