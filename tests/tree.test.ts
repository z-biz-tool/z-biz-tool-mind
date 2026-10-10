/**
 * 树原语（一条树六个投影里"树"的那一半）。
 * 覆盖的缺陷形状：删根、把父节点拖进自己的子树、第一个分支无处降级、
 * 浮动主题脱离主树、拖浮动主题改位置后布局要认、挂回主树时浮动标记必须一起摘下、
 * 浮动根虽然没有父也必须删得掉、
 * 自由布局里新建的主题要落在父主题外侧（位置在这一版归用户，留 (0,0) 就是叠在中心主题上），
 * 分支自由布局（00 §3.3）的位移要累加、落回原位要摘干净，且自愈/改父/删除都不能顺手抹掉它，
 * 脏数据（parentId 指向不存在的节点）自愈但不能丢内容。
 */
import { done, eq, ok } from "./_harness.ts";
import { createPage } from "../src/model/factory.ts";
import {
  ancestors,
  branchIndex,
  children,
  descendants,
  demote,
  duplicateShape,
  insertChild,
  insertParent,
  insertSibling,
  levelOf,
  maxDepth,
  moveShape,
  normalize,
  promote,
  removeShape,
  resetBranch,
  setCollapsed,
  setFloating,
  setTopicBold,
  shiftBranch,
  siblingIndex,
  swapSibling,
  toggleCollapsed,
  updateExtras,
  updateText,
  updateTransform,
  visibleChildren,
} from "../src/engine/tree.ts";
import { plainText } from "../src/types/model.ts";
import type { Page } from "../src/types/model.ts";
import { computeLayout } from "../src/engine/layout.ts";

let p = createPage("测试");
const root = p.rootId;
const add = (page: typeof p, parentId: string, text: string, at?: number) => {
  const r = insertChild(page, parentId, text, at);
  return [r.page, r.id] as const;
};

// --- 插入与顺序
let A: string;
let B: string;
[p, A] = add(p, root, "A");
[p, B] = add(p, root, "B", 0);
eq("头部插入让 B 排第一", p.shapes[root].childIds[0], B);
eq("A 排第二", p.shapes[root].childIds[1], A);
eq("A 的层级", levelOf(p, A), 1);
eq("一级自动是 MainTopic", p.shapes[A].type, "MainTopic");
let A0: string;
[p, A0] = (() => {
  const r = insertSibling(p, A, "before", "A0");
  return [r.page, r.id] as const;
})();
eq(
  "before 插到 A 前面",
  p.shapes[root].childIds.indexOf(A0),
  p.shapes[root].childIds.indexOf(A) - 1
);
eq("兄弟序号", siblingIndex(p, A), 2);

// --- 深层类型
let A1: string;
let A1a: string;
[p, A1] = add(p, A, "A1");
[p, A1a] = add(p, A1, "A1a");
eq("二级是 SubTopic", p.shapes[A1].type, "SubTopic");
eq("三级还是 SubTopic", p.shapes[A1a].type, "SubTopic");
eq("A 的子数", children(p, A).length, 1);
ok("descendants 含孙子", descendants(p, A).includes(A1a));
eq("祖先链长度", ancestors(p, A1a).length, 3); // A1 → A → 中心主题

// --- 删除
const afterDel = removeShape(p, A);
ok("删除连带子树", !afterDel.shapes[A1] && !afterDel.shapes[A1a]);
ok("中心主题删不掉", Boolean(removeShape(p, root).shapes[root]));

// --- 升降级
let q = p;
let one: string;
let two: string;
[q, one] = add(q, root, "one");
[q, two] = add(q, root, "two");
let kid: string;
[q, kid] = add(q, one, "kid");
const demoted = demote(q, two);
ok("有前兄弟时可降级", demoted.ok);
eq("two 挂到 one 下", demoted.page.shapes[two].parentId, one);
// one 不是首个分支（前面还有 B / A0 / A），降级到 A 下才是对的；首个分支才无处可降
eq("非首分支降级到前兄弟下", demote(demoted.page, one).page.shapes[one].parentId, A);
const first = demoted.page.shapes[demoted.page.rootId].childIds[0];
ok("第一个分支无处降级", demote(demoted.page, first).ok === false);
const promoted = promote(demoted.page, two);
ok("升级成功", promoted.ok);
eq("two 回到根下", promoted.page.shapes[two].parentId, root);
eq(
  "升级后紧跟 one",
  promoted.page.shapes[root].childIds.indexOf(two),
  promoted.page.shapes[root].childIds.indexOf(one) + 1
);
ok("一级分支无法再升", promote(promoted.page, one).ok === false);

// --- 插入父主题
const withParent = insertParent(p, A1);
ok("插父成功", withParent.id !== "");
eq("原节点挂到新父下", withParent.page.shapes[A1].parentId, withParent.id);
ok("中心主题不能插父", insertParent(withParent.page, root).id === "");

// --- 移动成环
let mv = p;
let x: string;
let y: string;
[mv, x] = add(mv, root, "x");
[mv, y] = add(mv, x, "y");
eq("禁止把父移进自己子树", moveShape(mv, x, y).shapes[x].parentId, mv.shapes[x].parentId);
eq("禁止自移", moveShape(mv, x, x).shapes[x].parentId, mv.shapes[x].parentId);

// --- 兄弟互换：A 原本排第三，两次上移才到最前
const sw = swapSibling(swapSibling(p, A, -1), A, -1);
eq("两次上移后 A 在最前", sw.shapes[root].childIds[0], A);
eq(
  "首位再上移越界不动",
  swapSibling(sw, A, -1).shapes[root].childIds.join(","),
  sw.shapes[root].childIds.join(",")
);
eq(
  "末位再下移越界不动",
  swapSibling(sw, sw.shapes[root].childIds[sw.shapes[root].childIds.length - 1], 1).shapes[
    root
  ].childIds.join(","),
  sw.shapes[root].childIds.join(",")
);

// --- 折叠
const col = setCollapsed(p, A, true);
eq("折叠后可见子为 0", visibleChildren(col, A).length, 0);
ok("children 不变", visibleChildren(col, A).length === 0 && children(col, A).length > 0);
eq("再点一次展开", visibleChildren(toggleCollapsed(col, A), A).length, children(col, A).length);

// --- 浮动主题：脱离主树、位置自定、布局仍算得出子节点
const fl = setFloating(p, B, 900, 700);
eq("类型转浮动", fl.shapes[B].type, "Floating");
eq("floating 标志", fl.shapes[B].floating, true);
eq("脱离父链", fl.shapes[B].parentId, null);
eq("位置是用户给的", fl.shapes[B].transform.x, 900);
const flBoxes = computeLayout(fl).boxes;
ok("浮动主题进入布局", Boolean(flBoxes[B]));
eq("中心主题不受影响", flBoxes[root] !== undefined, true);
const unfl = setFloating(fl, B, 900, 700, false);
eq("取消浮动回到根下", unfl.shapes[B].parentId, root);
ok("取消浮动后 childIds 补齐", unfl.shapes[root].childIds.includes(B));
eq("中心主题拒绝转浮动", setFloating(p, root, 1, 1).shapes[root].type, "MainIdea");

// --- 拖动浮动主题：位置是唯一由用户决定的坐标（P-2），拖完布局要认，整枝子树跟着走
const [withKid, bk] = add(fl, B, "B 的孩子");
const dragged = updateTransform(withKid, B, { x: 1200, y: 800 });
eq("只改 x/y", [dragged.shapes[B].transform.x, dragged.shapes[B].transform.y], [1200, 800]);
eq("保留自己拖出来的尺寸", dragged.shapes[B].transform.w, fl.shapes[B].transform.w);
eq("别的主题不受牵连", dragged.shapes[A].transform.x, fl.shapes[A].transform.x);
const dBoxes = computeLayout(dragged).boxes;
eq("浮动根按新坐标摆", [dBoxes[B].x, dBoxes[B].y], [1200, 800]);
ok("子树跟着走", dBoxes[bk].x > 1200);
ok("未知 id 是空操作", updateTransform(fl, "不存在的id", { x: 1 }) === fl);
// 把浮动根挂回主树：浮动标记必须一起摘下，否则类型停在 Floating、导出照写 FreePostion
const back = moveShape(fl, B, A);
eq("挂回主树即不再是浮动主题", back.shapes[B].floating, false);
eq("类型跟着层级重算", back.shapes[B].type, "SubTopic");
eq("父的 childIds 补上", back.shapes[A].childIds.includes(B), true);
ok("回到主树后仍在布局里", Boolean(computeLayout(back).boxes[B]));
// 浮动根没有 parentId，但它是用户建的：必须删得掉，并连带自己的整枝子树
const flDel = removeShape(dragged, B);
ok("删掉浮动根与它的子树", !flDel.shapes[B] && !flDel.shapes[bk]);
eq("删浮动根不动主树", flDel.shapes[root].childIds.join(","), fl.shapes[root].childIds.join(","));
ok("中心主题仍然删不掉（同样没有 parentId，但不是浮动）", removeShape(fl, root) === fl);

// --- 脏数据自愈
const dirty = { ...p, shapes: { ...p.shapes, [A]: { ...p.shapes[A], parentId: "99999" } } };
const fixed = normalize(dirty);
ok("不丢节点", Object.keys(fixed.shapes).length === Object.keys(dirty.shapes).length);
eq("重挂到中心主题", fixed.shapes[A].parentId, fixed.rootId);
ok(
  "双向索引自洽",
  Object.values(fixed.shapes).every((sh) =>
    sh.childIds.every((c) => fixed.shapes[c]?.parentId === sh.id)
  )
);
const cyc = normalize({
  ...p,
  shapes: { ...p.shapes, [root]: { ...p.shapes[root], parentId: A } },
});
ok("去环后根没有父", cyc.shapes[cyc.rootId].parentId === null);

// --- 其它
eq("maxDepth 从 0 起", maxDepth(p) >= 2, true);
eq("branchIndex 从 0 起", branchIndex(fixed, fixed.shapes[fixed.rootId].childIds[0]), 0);
const noop = updateText(p, "不存在的id", "x");
eq("updateText 对未知 id 是空操作", Object.keys(noop.shapes).length, Object.keys(p.shapes).length);
eq("文本读回", plainText(updateText(p, A, "改过").shapes[A].text), "改过");

// --- 加粗的落点：text.characters（01 A-16 —— 那是它在 .emmx 里唯一有家可回的地方）
{
  const on = setTopicBold(p, A, true);
  eq("工具栏那颗写进 characters[0].bold", on.shapes[A].text.characters[0].bold, true);
  eq(
    "同时记一份节点级覆盖（亿图没有「显式不加粗」的写法，靠它让中心主题那一下按得动）",
    on.shapes[A].style.font?.bold,
    true
  );
  eq("再点一次回到不加粗", setTopicBold(on, A, false).shapes[A].text.characters[0].bold, undefined);
  eq("取消时节点级记 false", setTopicBold(on, A, false).shapes[A].style.font?.bold, false);
  eq("翻转不动字号", setTopicBold(on, A, false).shapes[A].text.characters[0].size, p.shapes[A].text.characters[0].size);
  eq("未知 id 是空操作（连页面对象都不换）", setTopicBold(p, "不存在的id", true), p);
  // 只改被 run 引用的那几条：亿图文件里实测有 38 条没人引用的样式条目，跟着改就是无谓动别人的字节。
  const multi: Page = {
    ...p,
    shapes: {
      ...p.shapes,
      [A]: {
        ...p.shapes[A],
        text: {
          paragraphs: [{ runs: [{ text: "甲", charIx: 0 }], align: 1 }],
          characters: [{ size: 12 }, { size: 14 }],
        },
      },
    },
  };
  const t = setTopicBold(multi, A, true).shapes[A].text.characters;
  eq("IX=0 被引用 → 改它", t[0].bold, true);
  eq("IX=1 没人引用 → 原样不动", t[1].bold, undefined);
  eq("样式条目数量不许增减", t.length, 2);
  eq("段落结构不动", plainText(setTopicBold(multi, A, true).shapes[A].text), "甲");
}

// --- 自由布局：新建主题的位置是用户数据，不给位置就叠在中心主题上
{
  const fp = { ...p, layout: { ...p.layout, code: "free" as const } };
  const one = insertChild(fp, root, "自由一");
  const two = insertChild(one.page, root, "自由二");
  const t1 = two.page.shapes[one.id].transform;
  const t2 = two.page.shapes[two.id].transform;
  ok(
    "新主题落在父主题外侧，不是 (0,0)",
    Math.abs(t1.x) > 1 || Math.abs(t1.y) > 1,
    JSON.stringify(t1)
  );
  ok("同排两个孩子不叠在一起", t1.x !== t2.x || t1.y !== t2.y, JSON.stringify([t1, t2]));
  eq("布局引擎重算时认这份位置", computeLayout(two.page).boxes[one.id].x, t1.x);
  const up = insertParent(two.page, one.id);
  const tp = up.page.shapes[up.id].transform;
  ok("插入的父主题不盖住自己的孩子", tp.x !== t1.x || tp.y !== t1.y, JSON.stringify([tp, t1]));
  // 别的版式位置归引擎：新建主题一律留空，等布局算
  const bp = insertChild(
    { ...p, layout: { ...p.layout, code: "balanced" as const } },
    root,
    "普通"
  );
  eq(
    "非自由布局不写位置",
    [bp.page.shapes[bp.id].transform.x, bp.page.shapes[bp.id].transform.y],
    [0, 0]
  );
  // 浮动枝的子主题由浮动根现算，写了也没人读
  const fpage = setFloating(fp, A, 300, -200);
  const fchild = insertChild(fpage, A, "浮动子");
  eq(
    "浮动主题的孩子仍然留空位置",
    [fchild.page.shapes[fchild.id].transform.x, fchild.page.shapes[fchild.id].transform.y],
    [0, 0]
  );
}

// --- 分支自由布局的写入侧：位移记在二级主题上，落回原位就把字段摘掉
{
  const one = shiftBranch(p, A, 30, -20);
  eq("记下的是这一枝的位移", one.shapes[A].offset, { x: 30, y: -20 });
  eq("别处不受影响", one.shapes[B].offset, undefined);
  const two = shiftBranch(one, A, 5, 5);
  eq("再拖一次是在原位移上累加", two.shapes[A].offset, { x: 35, y: -15 });
  eq("取整：亚像素位移不该进文件", shiftBranch(p, A, 2.4, -1.6).shapes[A].offset, { x: 2, y: -2 });
  const back = shiftBranch(one, A, -30, 20);
  eq("拖回原位不留 {0,0}", "offset" in back.shapes[A], false);
  eq("复位走另一条入口，结果一样", "offset" in resetBranch(one, A), false);
  eq("本来没拖过的主题复位是空写", resetBranch(p, A) === p, true);
  eq("未知 id 的位移是空写", shiftBranch(p, "不存在的id", 10, 10) === p, true);
  // 自愈与改父都不该顺手抹掉这份用户意图：normalize 重建每个 shape 都要带着走
  const healed = normalize({ ...one, shapes: { ...one.shapes } });
  eq("normalize 之后位移还在", healed.shapes[A].offset, { x: 30, y: -20 });
  const movedDown = moveShape(one, A, B);
  eq("换父亲不抹掉位移（回到根下时引擎会再认它）", movedDown.shapes[A].offset, {
    x: 30,
    y: -20,
  });
  eq("删掉这一枝就不再有这个主题（位移跟着走）", Boolean(removeShape(one, A).shapes[A]), false);
}

// ---------------------------------------------------------------- 复制卡片：看板「复制卡片」的数据面（duplicateShape）
{
  let q = createPage("复制");
  const qroot = q.rootId;
  const grow = (parent: string, text: string) => {
    const r = insertChild(q, parent, text);
    q = r.page;
    return r.id;
  };
  const b1 = grow(qroot, "枝一");
  const s1 = grow(b1, "孙一");
  grow(s1, "曾孙");
  const b2 = grow(qroot, "枝二");
  q = updateExtras(updateText(q, b1, "枝一改"), b1, {
    task: { assignees: ["张三"], progress: 40, priority: "high", status: "doing", tags: ["红"], start: 1000, finish: 2000 },
    note: "便签",
  });
  const r = duplicateShape(q, b1);
  const cid = r.id;
  ok("副本拿到全新 id", cid.length > 0 && cid !== b1 && !q.shapes[cid], cid);
  const copy = r.page.shapes[cid];
  const orig = r.page.shapes[b1];
  eq("副本插在原件紧后", r.page.shapes[qroot].childIds, [b1, cid, b2]);
  eq("子树结构照抄", [copy.childIds.length, r.page.shapes[copy.childIds[0]].childIds.length], [1, 1]);
  eq("文字逐级相同", [plainText(copy.text), plainText(r.page.shapes[copy.childIds[0]].text)], ["枝一改", "孙一"]);
  eq("任务字段整份带走", [
    copy.extras.task?.priority,
    copy.extras.task?.progress,
    copy.extras.task?.assignees,
    copy.extras.task?.tags,
    copy.extras.note,
  ], ["high", 40, ["张三"], ["红"], "便签"]);
  ok("任务对象是拷贝不是引用（改副本不许串到原件）", copy.extras.task !== orig.extras.task);
  eq("副本的父链接指向原件的父亲", copy.parentId, qroot);
  eq("原件一个字节没动", r.page.shapes[b1], q.shapes[b1]);
  // 浮动根：位置是用户数据（P-2），副本要带着走
  const f = grow(qroot, "散记");
  const fq = setFloating(q, f, 320, -210);
  const fr = duplicateShape(fq, f);
  const fc = fr.page.shapes[fr.id];
  eq("浮动根副本：仍是浮动、不挂父、位置照抄", [
    Boolean(fc.floating),
    fc.parentId,
    [fc.transform.x, fc.transform.y],
  ], [true, null, [320, -210]]);
  eq("中心主题不可复制", duplicateShape(fq, fq.rootId).id, "");
  eq("未知 id 是空写", duplicateShape(fq, "不存在的id").page, fq);
}

done();
