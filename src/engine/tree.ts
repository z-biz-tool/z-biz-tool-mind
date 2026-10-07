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

import type { Page, RelationshipShape, Shape } from "../types/model.ts";
import { isTopic, makeText } from "../types/model.ts";
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
  childIds.splice(
    at === undefined ? childIds.length : Math.max(0, Math.min(at, childIds.length)),
    0,
    id
  );
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
  next = setChildren(
    next,
    grandfather,
    gpChildren.filter((c) => c !== id)
  );
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
  // 标注不在主题树上（子树顺着 childIds 走），删宿主时得另顺着 calloutIds 把它一起带走
  for (const d of [...doomed])
    for (const c of page.shapes[d]?.extras.calloutIds ?? []) doomed.add(c);
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
    relationships: next.relationships.filter((r) => !doomed.has(r.beginId) && !doomed.has(r.endId)),
  };
  for (const key of Object.keys(next.shapes)) {
    const sh = next.shapes[key];
    const links = sh.extras.biLinks?.filter((t) => !doomed.has(t));
    if (links && links.length !== sh.extras.biLinks?.length) {
      next = patch(next, key, { ...sh, extras: { ...sh.extras, biLinks: links } });
    }
  }
  return pruneOverlays(next, doomed);
}

/**
 * 主题删掉之后，盖着它的外框/概要、挂在它身上的标注要一起收尾。
 * 成员被删空的覆盖层不再是任何东西的边框，留着只会画出一个空框，所以连形带它的概要主题一起删；
 * 本来就一个成员都没有的（陌生 id 读进来的）不动 —— 那不是我们造的，删它等于改坏别人的文件。
 */
function pruneOverlays(page: Page, doomed: Set<string>): Page {
  const shapes: Record<string, Shape> = {};
  const gone = new Set<string>();
  for (const [id, s] of Object.entries(page.shapes)) {
    if (s.type === "Boundary" || s.type === "Summary") {
      const covered = s.extras.covered ?? [];
      const left = covered.filter((c) => !doomed.has(c));
      if (covered.length && !left.length) {
        gone.add(id);
        for (const c of s.childIds) gone.add(c);
        continue;
      }
      if (covered.length && left.length !== covered.length) {
        shapes[id] = { ...s, extras: { ...s.extras, covered: left } };
        continue;
      }
    }
    shapes[id] = s;
  }
  // 宿主删掉之后，calloutIds 里可能留下指向不存在的形状的引用：一并摘干净，
  // 否则布局层要逐个防着 undefined。
  for (const [id, s] of Object.entries(shapes)) {
    const cs = s.extras.calloutIds;
    if (cs?.some((c) => !shapes[c]))
      shapes[id] = { ...s, extras: { ...s.extras, calloutIds: cs.filter((c) => shapes[c]) } };
  }
  for (const id of gone) delete shapes[id];
  return { ...page, shapes };
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
  return patch(page, id, {
    ...s,
    text: { ...s.text, paragraphs: [{ runs: [{ text, charIx: 0 }], align: 1 }] },
  });
}

export function updateExtras(page: Page, id: string, extras: Partial<Shape["extras"]>): Page {
  const s = page.shapes[id];
  if (!s) return page;
  return patch(page, id, { ...s, extras: { ...s.extras, ...extras } });
}

/** 两端无序地找同一条关系线：反向再点一次不该多出一条。 */
export function relationshipBetween(
  page: Page,
  aId: string,
  bId: string
): RelationshipShape | undefined {
  return page.relationships.find(
    (r) => (r.beginId === aId && r.endId === bId) || (r.beginId === bId && r.endId === aId)
  );
}

/**
 * 连线 / 取消连线。亿图把关系线做成独立 Shape，但语义是"两点之间"，
 * 所以端点必须都还在页面上：选中的主题被删掉后由 prune 摘掉整条线（见 removeShape）。
 */
export function toggleRelationship(page: Page, aId: string, bId: string): Page {
  if (!aId || !bId || aId === bId) return page;
  if (!page.shapes[aId] || !page.shapes[bId]) return page;
  const hit = relationshipBetween(page, aId, bId);
  if (hit) return { ...page, relationships: page.relationships.filter((r) => r.id !== hit.id) };
  const rel: RelationshipShape = {
    id: nextShapeId(page),
    beginId: aId,
    endId: bId,
    text: makeText(""),
    style: {},
  };
  return { ...page, relationships: [...page.relationships, rel] };
}

/** 关系线上的说明文字；画布、SVG 导出和 emmx 写侧都读这一个字段。 */
export function setRelationshipText(page: Page, id: string, text: string): Page {
  const rel = page.relationships.find((r) => r.id === id);
  if (!rel) return page;
  return {
    ...page,
    relationships: page.relationships.map((r) =>
      r.id === id ? { ...r, text: makeText(text) } : r
    ),
  };
}

/** 覆盖层只盖主题：混进来的标注/外框 id、重复 id 与已删的 id 都在这一步滤掉。 */
function coverable(page: Page, ids: string[]): string[] {
  return [...new Set(ids)].filter((id) => isTopic(page.shapes[id]?.type));
}

const sameMembers = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join(";") === [...b].sort().join(";");

/** 找已经正好盖着这批主题的那一层：再点一次应该是取消，而不是叠第二层。 */
function layerOn(page: Page, type: "Boundary" | "Summary", covered: string[]): Shape | undefined {
  return Object.values(page.shapes).find(
    (s) => s.type === type && sameMembers(s.extras.covered ?? [], covered)
  );
}

/**
 * 外框：给选中主题盖一层矩形。少于两个主题不盖 —— 一个主题自己就是框，
 * 盖上去只会多出一条线，亿图也是这么拦的。
 */
export function addBoundary(page: Page, ids: string[]): { page: Page; id: string | null } {
  const covered = coverable(page, ids);
  if (covered.length < 2) return { page, id: null };
  const hit = layerOn(page, "Boundary", covered);
  if (hit) return { page: removeOverlay(page, hit.id), id: null };
  const s = createShape(nextShapeId(page), "Boundary", "", null);
  s.extras.covered = covered;
  return { page: patch(page, s.id, s), id: s.id };
}

/**
 * 概要：大括号 + 括号尖上那个概要主题。
 * 亿图把概要主题挂在 Summary 形状自己下面（`<SubLevel V="127"/>`），不是挂在中心主题上，
 * 所以这里也建父子边 —— 写回去才是同一个结构。
 */
export function addSummary(
  page: Page,
  ids: string[],
  text = "概要"
): { page: Page; id: string | null } {
  const covered = coverable(page, ids);
  if (!covered.length) return { page, id: null };
  const hit = layerOn(page, "Summary", covered);
  if (hit) return { page: removeOverlay(page, hit.id), id: null };
  const sum = createShape(nextShapeId(page), "Summary", "", null);
  sum.extras.covered = covered;
  const withSum = patch(page, sum.id, sum);
  const label = createShape(nextShapeId(withSum), "SummaryTopic", text, sum.id);
  sum.childIds = [label.id];
  return { page: patchMany(withSum, [sum, label]), id: sum.id };
}

/** 标注：在宿主主题上挂一个气泡，多个按挂上的顺序排在宿主外侧。 */
export function addCallout(
  page: Page,
  hostId: string,
  text = ""
): { page: Page; id: string | null } {
  const host = page.shapes[hostId];
  if (!host || !isTopic(host.type)) return { page, id: null };
  const c = createShape(nextShapeId(page), "Callout", text, null);
  const withCallout = patch(page, c.id, c);
  return {
    page: patchMany(withCallout, [
      {
        ...host,
        extras: { ...host.extras, calloutIds: [...(host.extras.calloutIds ?? []), c.id] },
      },
    ]),
    id: c.id,
  };
}

/** 删掉一个覆盖层：外框、概要（连同它的概要主题）、或单个标注（同时从宿主身上摘掉引用）。 */
export function removeOverlay(page: Page, id: string): Page {
  const s = page.shapes[id];
  if (!s) return page;
  const gone = new Set<string>([id, ...(s.type === "Summary" ? s.childIds : [])]);
  const shapes: Record<string, Shape> = {};
  for (const [k, v] of Object.entries(page.shapes)) {
    if (gone.has(k)) continue;
    const cs = v.extras.calloutIds;
    if (cs?.includes(id))
      shapes[k] = { ...v, extras: { ...v.extras, calloutIds: cs.filter((c) => c !== id) } };
    else shapes[k] = v;
  }
  return { ...page, shapes };
}

/** 盖住某批主题的层（外框/概要）：给"选中主题→删除外框"这类反查用。 */
export function layersCovering(page: Page, ids: string[]): Shape[] {
  const set = new Set(ids);
  return Object.values(page.shapes).filter(
    (s) =>
      (s.type === "Boundary" || s.type === "Summary") &&
      (s.extras.covered ?? []).some((c) => set.has(c))
  );
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
    if (!isTopic(s.type)) continue;
    const p = s.parentId && shapes[s.parentId] ? s.parentId : null;
    s.parentId = p;
    if (p) shapes[p].childIds.push(id);
    else roots.push(id);
  }
  // 1b) 标注框不在主题树上。亿图有的文件把宿主的 id 写在标注的 <Super> 里，
  // 这条边必须落到宿主身上的 calloutIds：留在 parentId 上，它就会被当成"多出来的根"
  // 收编成中心主题的一根分支（实测 ThemeBase 的 110 号标注第一次编辑就变了形），
  // 写回去还会多出一个我们发明不了的 <Super>。
  for (const id of Object.keys(shapes)) {
    const s = shapes[id];
    if (s.type !== "Callout") continue;
    const p = s.parentId && shapes[s.parentId] ? s.parentId : null;
    if (p) {
      const list = shapes[p].extras.calloutIds ?? [];
      if (!list.includes(id))
        shapes[p] = { ...shapes[p], extras: { ...shapes[p].extras, calloutIds: [...list, id] } };
    }
    s.parentId = null;
  }
  // 2) 根：优先原有 rootId，其次唯一的 MainIdea，最后任意一个无父主题。
  const mainIdea = roots.find((id) => shapes[id].type === "MainIdea");
  const rootId =
    shapes[page.rootId] && roots.includes(page.rootId) ? page.rootId : (mainIdea ?? roots[0]);
  if (rootId) {
    shapes[rootId] = {
      ...shapes[rootId],
      parentId: null,
      type: shapes[rootId].floating ? shapes[rootId].type : "MainIdea",
    };
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

/**
 * "本页有多少个主题"只有一处算法：外框、概要、标注都是形状但不是主题，
 * 数 shapes 会把它们算进去（状态栏一度就是这么虚报的）。
 */
export function countTopics(page: Page): number {
  return Object.values(page.shapes).filter((s) => isTopic(s.type)).length;
}

/** 深度：根为 0。布局层按它决定"显示层级数"裁剪。 */ export function maxDepth(page: Page): number {
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
