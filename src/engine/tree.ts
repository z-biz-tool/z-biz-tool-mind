/**
 * 树的结构性操作（doc/复刻方案/00 §3.2、§3.3）。
 *
 * 全部是纯函数：`(page, args) => Page`，绝不就地改。
 * 为什么用"整页快照"而不是逆向操作做撤销：本文档级的树，一次改动牵连的字段
 * （parentId / childIds / 类型重算 / 编号）太多，逐个写逆操作是 bug 的温床；
 * 快照 + 深度上限（QUOTA.undoMax）在 500 主题的文档上内存也可控。
 *
 * 关键不变量（normalize 负责兜住）：
 * 1. 恰好一个 MainIdea，且它是 rootId；
 * 2. childIds 与 parentId 双向一致；
 * 3. 不存在环；
 * 4. 主题类型 = f(层级, 是否浮动)。
 */

import type { Page, Shape } from "../types/model.ts";
import { isTopic } from "../types/model.ts";
import { createShape, nextShapeId, topicTypeFor } from "../model/factory.ts";

export function getShape(page: Page, id: string): Shape | undefined {
  return page.shapes[id];
}

export function children(page: Page, id: string): Shape[] {
  const s = page.shapes[id];
  if (!s) return [];
  return s.childIds.map((c) => page.shapes[c]).filter((c): c is Shape => Boolean(c));
}

/** 可见子节点：折叠节点的子树在画布上不出现（但仍存在于模型里）。 */
export function visibleChildren(page: Page, id: string): Shape[] {
  const s = page.shapes[id];
  if (!s || s.extras.collapsed) return [];
  return children(page, id);
}

export function levelOf(page: Page, id: string): number {
  let n = 0;
  let cur = page.shapes[id];
  while (cur && cur.parentId) {
    const parent = page.shapes[cur.parentId];
    if (!parent) break;
    cur = parent;
    n += 1;
    if (n > 4096) break; // 脏数据里的环不该把 UI 卡死
  }
  return n;
}

export function ancestors(page: Page, id: string): string[] {
  const out: string[] = [];
  let cur = page.shapes[id]?.parentId ?? null;
  while (cur) {
    out.push(cur);
    cur = page.shapes[cur]?.parentId ?? null;
    if (out.length > 4096) break;
  }
  return out;
}

/** 含自身的后序 id 列表（删除、导出分支、编号重算都靠它）。 */
export function subtreeIds(page: Page, id: string): string[] {
  const out: string[] = [];
  const walk = (cur: string) => {
    for (const c of page.shapes[cur]?.childIds ?? []) walk(c);
    out.push(cur);
  };
  walk(id);
  return out;
}

export function descendants(page: Page, id: string): string[] {
  return subtreeIds(page, id).filter((x) => x !== id);
}

export function siblingIndex(page: Page, id: string): number {
  const s = page.shapes[id];
  if (!s || !s.parentId) return -1;
  return page.shapes[s.parentId]?.childIds.indexOf(id) ?? -1;
}

export function siblings(page: Page, id: string): Shape[] {
  const s = page.shapes[id];
  if (!s?.parentId) return [];
  return children(page, s.parentId);
}

/** 复制一份 shapes 并替换指定 id，其余共享引用。 */
function patch(page: Page, id: string, next: Shape): Page {
  return { ...page, shapes: { ...page.shapes, [id]: next } };
}

function patchMany(page: Page, entries: Iterable<Shape>): Page {
  const shapes = { ...page.shapes };
  for (const s of entries) shapes[s.id] = s;
  return { ...page, shapes };
}

function setChildren(page: Page, parentId: string, childIds: string[]): Page {
  const parent = page.shapes[parentId];
  if (!parent) return page;
  const shapes = { ...page.shapes, [parentId]: { ...parent, childIds } };
  for (const cid of childIds) {
    const c = shapes[cid];
    if (c && c.parentId !== parentId) shapes[cid] = { ...c, parentId };
  }
  return { ...page, shapes };
}

/**
 * 重算受影响的 Shape 类型。层级变化会连带整棵子树（MainTopic → SubTopic）。
 * 浮动主题与 Callout 不参与：它们的类型是用户显式选的。
 */
export function retypeSubtree(page: Page, rootId: string): Page {
  const touched: Shape[] = [];
  const walk = (id: string, level: number) => {
    const s = page.shapes[id];
    if (!s) return;
    if (!s.floating && isTopic(s.type)) {
      const want = topicTypeFor(level, false);
      if (s.type !== want) touched.push({ ...s, type: want });
    }
    for (const c of s.childIds) {
      const child = page.shapes[c];
      if (child && !child.floating) walk(c, level + 1);
    }
  };
  walk(rootId, levelOf(page, rootId));
  return touched.length ? patchMany(page, touched) : page;
}

export type InsertResult = { page: Page; id: string };

export function insertChild(page: Page, parentId: string, text = "", at?: number): InsertResult {
  const parent = page.shapes[parentId];
  if (!parent) return { page, id: "" };
  const id = nextShapeId(page);
  const level = levelOf(page, parentId) + 1;
  const shape = createShape(id, topicTypeFor(level, false), text, parentId);
  const childIds = [...parent.childIds];
  childIds.splice(at === undefined ? childIds.length : Math.max(0, Math.min(at, childIds.length)), 0, id);
  let next: Page = { ...page, shapes: { ...page.shapes, [id]: shape } };
  next = setChildren(next, parentId, childIds);
  return { page: next, id };
}

export type Side = "before" | "after";

export function insertSibling(page: Page, refId: string, side: Side, text = ""): InsertResult {
  const ref = page.shapes[refId];
  if (!ref?.parentId) return insertChild(page, refId, text);
  const ix = siblingIndex(page, refId);
  const at = side === "after" ? ix + 1 : ix;
  return insertChild(page, ref.parentId, text, at);
}

/** 为选中主题插入父主题：原节点整体下移一层，类型随层级重算。 */
export function insertParent(page: Page, id: string): InsertResult {
  const s = page.shapes[id];
  if (!s) return { page, id: "" };
  if (!s.parentId) return { page, id: "" }; // 中心主题不能有父主题
  const newId = nextShapeId(page);
  const grandfather = s.parentId;
  const gpChildren = [...(page.shapes[grandfather]?.childIds ?? [])];
  const ix = gpChildren.indexOf(id);
  if (ix < 0) return { page, id: "" };

  const parentShape = createShape(newId, s.type, "", grandfather);
  let next: Page = { ...page, shapes: { ...page.shapes, [newId]: parentShape } };
  // 先把 s 从 grandfather 摘掉，接到 newId 下
  next = setChildren(next, grandfather, gpChildren.filter((c) => c !== id));
  next = setChildren(next, newId, [id]);
  const gpAfter = [...gpChildren];
  gpAfter.splice(ix, 1, newId);
  next = setChildren(next, grandfather, gpAfter);
  // 原节点的类型要按新层级重算，其子树一起
  next = retypeSubtree(next, newId);
  return { page: next, id: newId };
}

/** 删除主题及其子树；中心主题不可删（返回原 page）。 */
export function removeShape(page: Page, id: string): Page {
  const s = page.shapes[id];
  if (!s || !s.parentId) return page;
  const doomed = new Set(subtreeIds(page, id));
  const parent = page.shapes[s.parentId];
  let next = setChildren(
    page,
    s.parentId,
    (parent?.childIds ?? []).filter((c) => c !== id)
  );
  const shapes = { ...next.shapes };
  for (const d of doomed) delete shapes[d];
  // 指向被删主题的关系线 / 双向链接要一起清掉，否则投影层会读到 undefined
  next = {
    ...next,
    shapes,
    relationships: next.relationships.filter(
      (r) => !doomed.has(r.beginId) && !doomed.has(r.endId)
    ),
  };
  for (const key of Object.keys(next.shapes)) {
    const sh = next.shapes[key];
    const links = sh.extras.biLinks?.filter((t) => !doomed.has(t));
    if (links && links.length !== sh.extras.biLinks?.length) {
      next = patch(next, key, { ...sh, extras: { ...sh.extras, biLinks: links } });
    }
  }
  return next;
}

/**
 * 跨分支移动（拖拽 / 剪切粘贴）。
 * 拒绝把节点移进自己的子树 —— 那会造出环，之后每次遍历都会死循环。
 */
export function moveShape(page: Page, id: string, newParentId: string, at?: number): Page {
  const s = page.shapes[id];
  const target = page.shapes[newParentId];
  if (!s || !target || id === newParentId) return page;
  if (s.parentId === newParentId && at === undefined) return page;
  if (target.floating && !s.floating) return page;
  if (subtreeIds(page, id).includes(newParentId)) return page;

  const oldParent = s.parentId;
  let next = page;
  if (oldParent) {
    next = setChildren(
      next,
      oldParent,
      (next.shapes[oldParent]?.childIds ?? []).filter((c) => c !== id)
    );
  }
  const list = [...(next.shapes[newParentId]?.childIds ?? [])];
  const ix = at === undefined ? list.length : Math.max(0, Math.min(at, list.length));
  list.splice(ix, 0, id);
  next = setChildren(next, newParentId, list);
  // 浮动性跟着父走：普通主题移进浮动主题下即成为浮动主题的兄弟 -> 保持普通
  next = retypeSubtree(next, id);
  if (oldParent) next = retypeSubtree(next, oldParent);
  return next;
}

/** Tab：变成"上一个兄弟"的孩子。第一个兄弟无处可降，返回原页并给出原因。 */
export function demote(page: Page, id: string): { page: Page; ok: boolean } {
  const ix = siblingIndex(page, id);
  if (ix <= 0) return { page, ok: false };
  const prevId = page.shapes[page.shapes[id].parentId as string].childIds[ix - 1];
  return { page: moveShape(page, id, prevId), ok: true };
}

/** Shift+Tab：升到父节点的父节点下，紧随父节点之后。 */
export function promote(page: Page, id: string): { page: Page; ok: boolean } {
  const s = page.shapes[id];
  if (!s?.parentId) return { page, ok: false };
  const parent = page.shapes[s.parentId];
  const grand = parent?.parentId;
  if (!grand) return { page, ok: false }; // 一级分支已是最高层
  const list = [...(page.shapes[grand]?.childIds ?? [])];
  const at = list.indexOf(parent.id) + 1;
  return { page: moveShape(page, id, grand, at), ok: true };
}

/** 兄弟互换（"下移/上移"）。越界不动。 */
export function swapSibling(page: Page, id: string, dir: -1 | 1): Page {
  const s = page.shapes[id];
  if (!s?.parentId) return page;
  const list = [...(page.shapes[s.parentId]?.childIds ?? [])];
  const ix = list.indexOf(id);
  const to = ix + dir;
  if (ix < 0 || to < 0 || to >= list.length) return page;
  list.splice(ix, 1);
  list.splice(to, 0, id);
  return setChildren(page, s.parentId, list);
}

export function setCollapsed(page: Page, id: string, collapsed: boolean): Page {
  const s = page.shapes[id];
  if (!s) return page;
  return patch(page, id, { ...s, extras: { ...s.extras, collapsed } });
}

export function toggleCollapsed(page: Page, id: string): Page {
  const s = page.shapes[id];
  return setCollapsed(page, id, !s?.extras.collapsed);
}

/**
 * 转为 / 取消浮动主题。
 * 浮动主题的位置是用户拖出来的（P-2 的唯一定位例外），所以它脱离主树：
 * parentId 置空，由布局层按存储坐标原样摆放；取消浮动时挂回中心主题。
 */
export function setFloating(page: Page, id: string, x: number, y: number, floating = true): Page {
  const s = page.shapes[id];
  if (!s || s.floating === floating) return page;
  if (floating && s.type === "MainIdea") return page; // 中心主题不能浮动
  if (floating) {
    let next = patch(page, id, {
      ...s,
      floating: true,
      type: "Floating",
      parentId: null,
      transform: { ...s.transform, x, y },
    });
    // 必须同时从父的 childIds 里摘掉，否则它既在主树里又在浮动树里，取消浮动时会重复挂两次。
    if (s.parentId) {
      next = setChildren(
        next,
        s.parentId,
        (next.shapes[s.parentId]?.childIds ?? []).filter((c) => c !== id)
      );
    }
    return next;
  }
  const un = patch(page, id, {
    ...s,
    floating: false,
    type: topicTypeFor(1, false),
    parentId: page.rootId,
    transform: { ...s.transform, x, y },
  });
  const list = [...(page.shapes[page.rootId]?.childIds ?? [])];
  if (!list.includes(id)) list.push(id);
  return setChildren(un, page.rootId, list);
}

export function updateText(page: Page, id: string, text: string): Page {
  const s = page.shapes[id];
  if (!s) return page;
  return patch(page, id, { ...s, text: { ...s.text, paragraphs: [{ runs: [{ text, charIx: 0 }], align: 1 }] } });
}

export function updateExtras(page: Page, id: string, extras: Partial<Shape["extras"]>): Page {
  const s = page.shapes[id];
  if (!s) return page;
  return patch(page, id, { ...s, extras: { ...s.extras, ...extras } });
}

export function updateStyle(page: Page, id: string, style: Partial<Shape["style"]>): Page {
  const s = page.shapes[id];
  if (!s) return page;
  return patch(page, id, { ...s, style: { ...s.style, ...style } });
}

export function updateTransform(page: Page, id: string, t: Partial<Shape["transform"]>): Page {
  const s = page.shapes[id];
  if (!s) return page;
  return patch(page, id, { ...s, transform: { ...s.transform, ...t } });
}

/**
 * 双向索引修复 + 去环 + 类型重算。
 * 从 .emmx 读回来的数据不能假设干净：Super/SubLevel 任一侧缺失都要能自愈，
 * 否则第二次保存会把 undefined 写回文件，把好数据永久改掉。
 */
export function normalize(page: Page): Page {
  const shapes: Record<string, Shape> = {};
  for (const [id, s] of Object.entries(page.shapes)) shapes[id] = { ...s, childIds: [] };

  // 1) 只用 parentId 重建 childIds（parentId 更可信：子知道自己爹，爹的列表可能漏）。
  const roots: string[] = [];
  for (const id of Object.keys(shapes)) {
    const s = shapes[id];
    if (!isTopic(s.type) && s.type !== "Callout") continue;
    const p = s.parentId && shapes[s.parentId] ? s.parentId : null;
    s.parentId = p;
    if (p) shapes[p].childIds.push(id);
    else roots.push(id);
  }
  // 2) 根：优先原有 rootId，其次唯一的 MainIdea，最后任意一个无父主题。
  const mainIdea = roots.find((id) => shapes[id].type === "MainIdea");
  const rootId = shapes[page.rootId] && roots.includes(page.rootId) ? page.rootId : mainIdea ?? roots[0];
  if (rootId) {
    shapes[rootId] = { ...shapes[rootId], parentId: null, type: shapes[rootId].floating ? shapes[rootId].type : "MainIdea" };
    for (const other of roots.filter((r) => r !== rootId && !shapes[r].floating)) {
      // 多出来的"无父主题"挂到根下：删掉它等于删用户的稿子，太危险。
      shapes[rootId].childIds.push(other);
      shapes[other] = { ...shapes[other], parentId: rootId };
    }
  }
  // 3) 去环：DFS 遇到已在栈上的 id 就剪断这条父子边。
  const seen = new Set<string>();
  const stack = new Set<string>();
  const visit = (id: string) => {
    if (stack.has(id)) {
      const parent = shapes[id].parentId;
      if (parent) {
        shapes[parent].childIds = shapes[parent].childIds.filter((c) => c !== id);
        shapes[id] = { ...shapes[id], parentId: rootId && rootId !== id ? rootId : null };
      }
      return;
    }
    if (seen.has(id)) return;
    seen.add(id);
    stack.add(id);
    for (const c of [...shapes[id].childIds]) visit(c);
    stack.delete(id);
  };
  if (rootId) visit(rootId);
  for (const id of Object.keys(shapes)) if (!seen.has(id)) visit(id);

  let next: Page = { ...page, shapes, rootId: rootId ?? page.rootId };
  if (rootId) next = retypeSubtree(next, rootId);
  return next;
}

/** 深度：根为 0。布局层按它决定"显示层级数"裁剪。 */
export function maxDepth(page: Page): number {
  let max = 0;
  const walk = (id: string, d: number) => {
    if (d > max) max = d;
    for (const c of page.shapes[id]?.childIds ?? []) walk(c, d + 1);
  };
  walk(page.rootId, 0);
  return max;
}

/** 分支序号：主分支 index（Rainbow 取色、编号、主题派生色都按它走）。 */
export function branchIndex(page: Page, id: string): number {
  const chain = [id, ...ancestors(page, id)];
  const i = chain.length - 2; // chain[chain.length-1] 是根
  const root = page.shapes[page.rootId];
  const firstLevel = chain[i];
  return root?.childIds.indexOf(firstLevel ?? "") ?? -1;
}
