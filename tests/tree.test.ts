/**
 * 树原语（一条树六个投影里"树"的那一半）。
 * 覆盖的缺陷形状：删根、把父节点拖进自己的子树、第一个分支无处降级、
 * 浮动主题脱离主树、拖浮动主题改位置后布局要认、挂回主树时浮动标记必须一起摘下、
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
  insertChild,
  insertParent,
  insertSibling,
  levelOf,
  maxDepth,
  moveShape,
  normalize,
  promote,
  removeShape,
  setCollapsed,
  setFloating,
  siblingIndex,
  swapSibling,
  toggleCollapsed,
  updateText,
  updateTransform,
  visibleChildren,
} from "../src/engine/tree.ts";
import { plainText } from "../src/types/model.ts";
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
eq("before 插到 A 前面", p.shapes[root].childIds.indexOf(A0), p.shapes[root].childIds.indexOf(A) - 1);
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
eq("升级后紧跟 one", promoted.page.shapes[root].childIds.indexOf(two), promoted.page.shapes[root].childIds.indexOf(one) + 1);
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
eq("首位再上移越界不动", swapSibling(sw, A, -1).shapes[root].childIds.join(","), sw.shapes[root].childIds.join(","));
eq("末位再下移越界不动",
  swapSibling(sw, sw.shapes[root].childIds[sw.shapes[root].childIds.length - 1], 1).shapes[root].childIds.join(","),
  sw.shapes[root].childIds.join(","));

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

// --- 脏数据自愈
const dirty = { ...p, shapes: { ...p.shapes, [A]: { ...p.shapes[A], parentId: "99999" } } };
const fixed = normalize(dirty);
ok("不丢节点", Object.keys(fixed.shapes).length === Object.keys(dirty.shapes).length);
eq("重挂到中心主题", fixed.shapes[A].parentId, fixed.rootId);
ok(
  "双向索引自洽",
  Object.values(fixed.shapes).every((sh) => sh.childIds.every((c) => fixed.shapes[c]?.parentId === sh.id))
);
const cyc = normalize({ ...p, shapes: { ...p.shapes, [root]: { ...p.shapes[root], parentId: A } } });
ok("去环后根没有父", cyc.shapes[cyc.rootId].parentId === null);

// --- 其它
eq("maxDepth 从 0 起", maxDepth(p) >= 2, true);
eq("branchIndex 从 0 起", branchIndex(fixed, fixed.shapes[fixed.rootId].childIds[0]), 0);
const noop = updateText(p, "不存在的id", "x");
eq("updateText 对未知 id 是空操作", Object.keys(noop.shapes).length, Object.keys(p.shapes).length);
eq("文本读回", plainText(updateText(p, A, "改过").shapes[A].text), "改过");

done();
