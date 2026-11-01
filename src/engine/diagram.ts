/**
 * AI 结构化图：协议 ⇄ 树 + 关系线 的原语（doc/复刻方案/00 §3.13 A 层延伸）。
 *
 * ## 为什么另起一个协议，而不是复用 outline.ts
 *
 * `outline.ts` 那份协议是「一段带缩进的文本 → 主题树」。它能表达**树**，
 * 表达不了**连线**：流程图的 A→B→C 若用父子边表达，B 就成了 A 的子节点，
 * 而真实语义是三个并列节点之间有向连接。用父子边去凑，画出来的是一棵树，
 * 长得却像流程图 —— 这类"形似而神不似"正是本仓要避免的复刻破绽。
 *
 * 所以结构化图走**第二份协议**，但**只此一份**：
 * - 协议只有这里一份（解析、校验、落树都在这个文件里）；
 * - 落树用的是 `engine/tree.ts` 的既有原语（insertChild / toggleRelationship），
 *   不另写一套建形状的逻辑 —— 建形状的规则（类型随层级、id 分配、父子双向一致）
 *   只有 tree.ts 那一处说了算。
 *
 * ## 协议形状
 *
 * ```json
 * {
 *   "nodes": [
 *     { "id": "n1", "text": "需求", "parent": null },
 *     { "id": "n2", "text": "设计", "parent": "n1" }
 *   ],
 *   "edges": [ { "from": "n1", "to": "n2", "text": "驱动" } ]
 * }
 * ```
 *
 * `parent` 构成**树**（进 `Page.shapes`），`edges` 是**关系线**（进 `Page.relationships`）。
 * 两者语义不同：前者是隶属，后者是连接。mind 的模型里这两件事也是两处存储。
 *
 * ## 为什么解析器要这么严
 *
 * LLM 的输出是**不可信输入**，和用户粘贴的文本一个级别。往 `Page.shapes` 里塞
 * 一棵有环的树，会让布局引擎的每一次遍历都死循环；塞一个悬空的 parentId，
 * 会造出"永远画不出来也删不掉"的孤儿节点；塞 5000 个节点，会让画布卡死。
 *
 * 所以这一层做四道闸：**结构合法 → 引用存在 → 无环 → 规模有界**。
 * 任何一道不过就整份拒绝（返回原因），而不是"尽力而为地修一修"——
 * 半修半坏的结构比明确失败更难排查。
 */
import type { Page, RelationshipShape, DocumentModel } from "../types/model.ts";
import { makeText, plainText } from "../types/model.ts";
import { retypeSubtree, toggleRelationship } from "./tree.ts";
import { nextShapeId } from "../model/factory.ts";

/** 协议的原始形状：LLM 回什么就是什么，不预设它一定合法。 */
export interface DiagramNode {
  id: string;
  text: string;
  /** null / 缺省 = 根。多个根会被挂到第一个根之下（见 normalize）。 */
  parent?: string | null;
}

export interface DiagramEdge {
  from: string;
  to: string;
  text?: string;
}

export interface DiagramSpec {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

/** 解析成功后的规格：引用全部有效、树形无环。 */
export interface NormalizedDiagram {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** 根节点 id（唯一一个）。 */
  rootId: string;
}

/** 规模上限。画布上 300 个节点已经是"读不动"的量级，再多就是往用户机器上灌垃圾。 */
export const DIAGRAM_MAX_NODES = 300;
/** 深度上限：深过 12 层的树在画布上只有一根竖线，人眼看不出结构。 */
export const DIAGRAM_MAX_DEPTH = 12;
/** 单个节点文字上限：超了就是模型在写正文而不是写节点标签。 */
export const DIAGRAM_MAX_TEXT = 120;

/** 解析失败的统一口径：带一句能照着改的话。 */
export interface DiagramParseError {
  ok: false;
  message: string;
}

export type DiagramParseResult = { ok: true; diagram: NormalizedDiagram } | DiagramParseError;

/**
 * 从模型回包里抠出 JSON 对象。
 *
 * 模型爱在 JSON 外面裹东西：```json 围栏、"好的，这是图："这样的前言、
 * 结尾的客套话。直接 `JSON.parse` 整段必然失败。
 *
 * 这里按三步剥：剥围栏 → 找第一个 `{` 到最后一个 `}` → 解析。
 * 第三步失败（截断的 JSON）会明确报"内容不完整"，而不是吐一句"解析失败" ——
 * 截断通常意味着模型自己知道要写很长而被 max_tokens 砍断，用户换个更短的说法就有用。
 */
export function extractJson(text: string): { ok: true; value: unknown } | DiagramParseError {
  const raw = text.trim();
  if (!raw) return { ok: false, message: "AI 没有返回任何内容。" };

  // ① 剥代码围栏（```json … ``` 或 ``` … ```）
  let body = raw;
  const fence = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  if (fence) body = fence[1].trim();

  // ② 找 JSON 对象的边界。跳过围栏后通常就是纯 JSON，但模型仍可能加前言。
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end <= start) {
    // 有左括号没有右括号 ⇒ 内容被砍断了（多半是 max_tokens 截断）。
    // 这与"完全不是 JSON"是两回事，用户该知道该把描述写短，而不是重写。
    return {
      ok: false,
      message:
        "AI 返回的图数据不完整（多半是内容太长被截断了）。请把描述缩短一些，或减少要生成的内容。",
    };
  }
  if (start < 0 || end <= start) {
    return {
      ok: false,
      message: "AI 没有返回可识别的图数据（预期是 JSON）。请换一种更具体的描述后重试。",
    };
  }
  const slice = body.slice(start, end + 1);
  try {
    return { ok: true, value: JSON.parse(slice) };
  } catch {
    return {
      ok: false,
      message:
        "AI 返回的图数据不是完整 JSON（多半是内容太长被截断了）。请把描述缩短一些，或减少要生成的内容。",
    };
  }
}

/**
 * 把模型给的原始 JSON 变成**可落树**的规格。
 *
 * 四道闸，顺序不能换：
 * 1. **结构合法**：nodes/edges 必须是数组，元素形状对得上。
 * 2. **引用存在**：parent/from/to 指向的 id 必须存在。
 * 3. **无环**：parent 关系构成树（每个节点至多一个父亲，且不成环）。
 * 4. **规模有界**：节点数、深度、单字长度都有上限。
 *
 * 任何一道不过 ⇒ 整份拒绝并说明是哪一道。半修半坏的结构会让用户看到一张
 * 缺胳膊少腿的图，然后花半小时猜"AI 是不是坏了"。
 */
export function parseDiagram(text: string): DiagramParseResult {
  const extracted = extractJson(text);
  if (!extracted.ok) return extracted;
  return normalizeDiagram(extracted.value);
}

/** 从已解析的 JSON 值做校验与归一（parseDiagram 的第二步，单独暴露便于测试）。 */
export function normalizeDiagram(value: unknown): DiagramParseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "AI 返回的图数据不是一个对象（预期含 nodes 与 edges）。" };
  }
  const v = value as Record<string, unknown>;
  const rawNodes = v.nodes;
  const rawEdges = v.edges;
  if (!Array.isArray(rawNodes)) {
    return { ok: false, message: "AI 返回的图数据缺少 nodes 列表。" };
  }
  if (rawNodes.length === 0) {
    return { ok: false, message: "AI 返回的图里没有任何节点。" };
  }
  if (rawNodes.length > DIAGRAM_MAX_NODES) {
    return {
      ok: false,
      message: `AI 返回的节点太多（${rawNodes.length} 个，上限 ${DIAGRAM_MAX_NODES} 个）。请缩小范围后重试。`,
    };
  }

  // ---- 闸 1：结构合法 ----
  const nodes: DiagramNode[] = [];
  for (const raw of rawNodes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, message: "AI 返回的 nodes 里有不是对象的条目。" };
    }
    const n = raw as Record<string, unknown>;
    const id = typeof n.id === "string" ? n.id.trim() : "";
    if (!id) return { ok: false, message: "AI 返回的节点缺少 id。" };
    if (typeof n.text !== "string") {
      return { ok: false, message: `AI 返回的节点「${id}」缺少 text。` };
    }
    const text = n.text.trim();
    if (!text) return { ok: false, message: `AI 返回的节点「${id}」文字为空。` };
    if (text.length > DIAGRAM_MAX_TEXT) {
      return {
        ok: false,
        message: `AI 返回的节点「${id}」文字过长（${text.length} 字，上限 ${DIAGRAM_MAX_TEXT} 字）。`,
      };
    }
    const parent = n.parent === undefined || n.parent === null ? null : String(n.parent).trim();
    nodes.push({ id, text, parent: parent || null });
  }

  // id 重复：后写的 parent 引用会指向"哪一个"变得不确定 —— 直接拒绝。
  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) {
      return { ok: false, message: `AI 返回的节点 id 重复：「${n.id}」。` };
    }
    ids.add(n.id);
  }

  // ---- 闸 2：引用存在 ----
  for (const n of nodes) {
    if (n.parent !== null && !ids.has(n.parent as string)) {
      return {
        ok: false,
        message: `AI 返回的节点「${n.id}」指向了不存在的父节点「${n.parent}」。`,
      };
    }
  }

  // ---- 闸 3：无环（在根检测**之前**，两道闸必须各自独立承责）----
  // 每个节点沿 parent 往上走，看能不能绕回自己。
  //
  // 两个实测过的坑，都写在这里防止退回去：
  // 1. 兜底计数器必须**独立于 seen**：`seen` 是 Set，环里反复 add 同一个 id
  //    不会让它变大 ⇒ 用 seen.size 当兜底上限，在真环上永远不触发 ——
  //    于是这一段变成死循环（变异对照时测试直接 ETIMEDOUT）。
  // 2. 本闸必须排在「根检测」之前：环 ⇒ 必然没有根，两道闸测的是同一件事的
  //    两个侧面。若根检测在前，纯环样本会被它拦下，环闸就成了永远不触发的
  //    哑判据（变异对照实测：撤掉环闸后只有一半断言变红 —— 判据重叠 = 失守）。
  for (const n of nodes) {
    const seen = new Set<string>([n.id]);
    let cur = n.parent;
    let steps = 0;
    while (cur) {
      if (seen.has(cur)) {
        return {
          ok: false,
          message: `AI 返回的节点「${n.id}」的父子关系构成了环（${[...seen].join(" → ")}）。`,
        };
      }
      seen.add(cur);
      if (++steps > 4096) break; // 脏数据里的环不该把 CPU 卡死
      cur = nodes.find((x) => x.id === cur)?.parent ?? null;
    }
  }

  // ---- 根与深度 ----
  // 没有 parent 的节点是根。多个根时：第一个当根，其余挂到根之下 ——
  // "模型漏填了一个 parent"是常见的轻微失误，而"整份图没有根"是真错误。
  const roots = nodes.filter((n) => n.parent === null);
  if (roots.length === 0) {
    return { ok: false, message: "AI 返回的图没有根节点（每个节点都指着自己的父节点）。" };
  }
  const rootId = roots[0].id;
  const fixed: DiagramNode[] = nodes.map((n) =>
    n.parent === null && n.id !== rootId ? { ...n, parent: rootId } : n
  );

  // 深度：沿 parent 链数。超上限就是"一根竖线"，人眼看不出结构。
  const byId = new Map(fixed.map((n) => [n.id, n]));
  for (const n of fixed) {
    let d = 0;
    let cur = n.parent;
    while (cur) {
      d += 1;
      if (d > DIAGRAM_MAX_DEPTH) {
        return {
          ok: false,
          message: `AI 返回的图太深（超过 ${DIAGRAM_MAX_DEPTH} 层）。请改成更扁的结构。`,
        };
      }
      cur = byId.get(cur)?.parent ?? null;
    }
  }

  // ---- 闸 4：边 ----
  const edges: DiagramEdge[] = [];
  if (rawEdges !== undefined) {
    if (!Array.isArray(rawEdges)) {
      return { ok: false, message: "AI 返回的 edges 不是列表。" };
    }
    for (const raw of rawEdges) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, message: "AI 返回的 edges 里有不是对象的条目。" };
      }
      const e = raw as Record<string, unknown>;
      const from = typeof e.from === "string" ? e.from.trim() : "";
      const to = typeof e.to === "string" ? e.to.trim() : "";
      if (!from || !to) {
        return { ok: false, message: "AI 返回的关系线缺少 from 或 to。" };
      }
      if (!ids.has(from) || !ids.has(to)) {
        return {
          ok: false,
          message: `AI 返回的关系线指向了不存在的节点（${from} → ${to}）。`,
        };
      }
      if (from === to) continue; // 自环没有语义，跳过即可，不必报错
      const text = typeof e.text === "string" ? e.text.trim() : "";
      edges.push({ from, to, text: text || undefined });
    }
  }

  return { ok: true, diagram: { nodes: fixed, edges, rootId } };
}

/**
 * 把规格落成一页：树进 `Page.shapes`，关系线进 `Page.relationships`。
 *
 * ## 为什么不用 insertChild 一路拼
 *
 * `insertChild` 每插一颗都会重算层级类型、重发 id、登记父子双向索引 ——
 * 它是"在**已有**树上插一颗"的原语。AI 一次给一整棵树，用它插 N 次：
 * 每一步都在改一张越来越大的页快照，是 O(N²) 的复制，而且中途任何一次失败
 * 都会留下一棵半棵的树。
 *
 * 所以这里**先算好整棵树**（含 id、类型、childIds），再一次性写进 `Page.shapes`。
 * 建形状的规则仍由 tree.ts 的 `topicTypeFor` 说了算，不另写一套。
 *
 * ## 幂等：同一份规格落两次
 *
 * 第二次会得到不同的 id（id 分配器看的是当前页的最大号）—— 这是对的：
 * "AI 生成图"是"再来一张"，不是"覆盖上一张"。
 */
export function applyDiagram(page: Page, spec: NormalizedDiagram): { page: Page; ids: string[] } {
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const rootNode = byId.get(spec.rootId);
  if (!rootNode) return { page, ids: [] };

  // 分配 id：按协议顺序发号，从当前页的下一号开始。
  // 关系线也占同一号段（见 factory.ts 的 nextShapeId 注释），所以最后统一补。
  const shapes: Record<string, typeof page.shapes[string]> = { ...page.shapes };
  const idOf = new Map<string, string>();
  let next = Number(nextShapeId(page));
  for (const n of spec.nodes) {
    const sid = String(next++);
    idOf.set(n.id, sid);
    shapes[sid] = {
      id: sid,
      // 类型由层级决定：根是 MainIdea，一级 MainTopic，更深 SubTopic。
      // 层级在这里算（协议里的 parent 链），规则本身来自 tree.ts。
      type: "SubTopic",
      parentId: null,
      childIds: [],
      text: makeText(n.text),
      transform: { x: 0, y: 0, w: 0, h: 0 },
      style: {},
      extras: {},
    };
  }

  // 建父子边并算层级。parentId 指**页内 id**，不是协议 id。
  //
  // 两个健壮性约束，都是实测过的坑：
  // 1. **必须迭代，不能递归**：落树是公开原语，调用方未必都走过 normalizeDiagram
  //    （导出、测试、将来的导入路径）。绕过校验的脏规格可以有任意长的 parent 链，
  //    递归回溯会直接爆栈 —— 深度闸只在校验层起作用，这里不能依赖它。
  // 2. **悬空的 parent 在这里必须跳过而不是崩**：`shapes[psid]` 拿到 undefined
  //    再 `.childIds.push` 会抛 TypeError —— 用户数据问题不该变成崩溃栈。
  //    跳过时按根处理（自成一个分支），不静默丢弃节点。
  const levelOf = new Map<string, number>();
  for (const n of spec.nodes) {
    let d = 0;
    let cur = n.parent;
    let steps = 0;
    while (cur) {
      d += 1;
      if (++steps > 4096) break; // 与闸 3 同口径：脏数据里的环不该把 CPU 卡死
      cur = byId.get(cur)?.parent ?? null;
    }
    levelOf.set(n.id, d);
  }
  // 按深度从浅到深挂：父节点的页内 id 所指的形状必然已经就位，无需递归。
  const ordered = [...spec.nodes].sort(
    (a, b) => (levelOf.get(a.id) ?? 0) - (levelOf.get(b.id) ?? 0)
  );
  for (const n of ordered) {
    const sid = idOf.get(n.id) as string;
    const psid = n.parent ? idOf.get(n.parent) : undefined;
    // 悬空引用走 else（idOf 里查不到 ⇒ psid 为 undefined）：当成根处理，不静默丢节点。
    // `shapes[psid]` 是多余一层的防御（idOf 里有的 id 必然已建形状），留着防将来改动。
    if (n.parent && psid && shapes[psid]) {
      shapes[sid].parentId = psid;
      shapes[psid].childIds.push(sid);
    } else {
      // 父节点不存在（悬空引用）：当成根处理，不静默丢弃这个节点。
      shapes[sid].parentId = null;
      levelOf.set(n.id, 0);
    }
  }

  // 层级算完，把类型补上（与 tree.ts 的 topicTypeFor 同一份规则）。
  for (const n of spec.nodes) {
    const sid = idOf.get(n.id) as string;
    const s = shapes[sid];
    const lvl = levelOf.get(n.id) ?? 0;
    s.type = lvl === 0 ? "MainIdea" : lvl === 1 ? "MainTopic" : "SubTopic";
  }

  let nextPage: Page = { ...page, shapes };

  // ---- 关系线 ----
  // 用 tree.ts 的 toggleRelationship 走同一条路：它会去重（反向再点一次不该多出一条），
  // 也会用 nextShapeId 发号（与主题不撞号）。
  for (const e of spec.edges) {
    const from = idOf.get(e.from);
    const to = idOf.get(e.to);
    if (!from || !to) continue;
    nextPage = toggleRelationship(nextPage, from, to);
    if (e.text) {
      const rel = nextPage.relationships.find(
        (r) => (r.beginId === from && r.endId === to) || (r.beginId === to && r.endId === from)
      );
      if (rel) {
        nextPage = {
          ...nextPage,
          relationships: nextPage.relationships.map((r) =>
            r.id === rel.id ? { ...r, text: makeText(e.text as string) } : r
          ),
        };
      }
    }
  }

  // AI 生成的内容打上 extras.ai（与 ai.ts 的 tagAi 同一口径：会话级，存盘即丢）。
  for (const n of spec.nodes) {
    const sid = idOf.get(n.id) as string;
    nextPage.shapes[sid] = { ...nextPage.shapes[sid], extras: { ...nextPage.shapes[sid].extras, ai: true } };
  }

  const ids = spec.nodes.map((n) => idOf.get(n.id) as string);
  return { page: nextPage, ids };
}

/**
 * 把一棵树挂到画布上的某个位置。
 *
 * 两种落法：
 * - `replace`：清空整页，只留这张图（"生成一张新的图"）。
 * - `attach`：挂到现有中心主题之下（"在这张图上补一块"）。
 *
 * 默认 `replace` —— 「AI 生成图」的心智是"给我一张图"，不是"在我的图上加点东西"。
 * 用户想要后者时，从选中主题的 AI 助手里走"生成子主题"那条路。
 */
export function placeDiagram(
  page: Page,
  spec: NormalizedDiagram,
  mode: "replace" | "attach" = "replace"
): { page: Page; ids: string[] } {
  const rootIdx = spec.nodes.findIndex((n) => n.id === spec.rootId);

  if (mode === "attach") {
    // 挂到中心主题之下。协议根在落树后是 MainIdea 类型，而主树只有一个
    // MainIdea（tree.ts 不变量 1），所以协议根要降一级，整棵子树的类型
    // 随新层级重算 —— 不重算的话，协议里的一级分支仍顶着 MainTopic，
    // 实际已经到了第三层，主题类型和层级对不上（与 tree.ts 不变量 4 冲突）。
    const r = applyDiagram(page, spec);
    const rootSid = r.ids[rootIdx];
    if (!rootSid) return r;
    let next = r.page;
    // 主树的中心主题：页里**原有**的那颗（applyDiagram 不会动它）。
    const mainId = page.shapes[page.rootId] ? page.rootId : undefined;
    if (!mainId) return r;
    const main = next.shapes[mainId];
    next = {
      ...next,
      shapes: {
        ...next.shapes,
        [mainId]: { ...main, childIds: [...main.childIds, rootSid] },
        [rootSid]: { ...next.shapes[rootSid], parentId: mainId },
      },
    };
    // 整棵新枝按挂载后的层级重算类型（retypeSubtree 是 tree.ts 的既有原语）。
    next = retypeSubtree(next, rootSid);
    return { page: next, ids: r.ids };
  }

  // replace：整页只留这张图。applyDiagram 不会删旧形状，删是这里的职责 ——
  // 但**关系线必须跟着清**：指向已删形状的关系线留在页里，投影层读到
  // undefined 会画不出或直接崩（tree.ts 的 removeShape 里 prune 的同一条纪律）。
  const r = applyDiagram(page, spec);
  const rootSid = r.ids[rootIdx];
  if (!rootSid) return r;
  const shapes = { ...r.page.shapes };
  const keep = new Set(r.ids);
  for (const id of Object.keys(shapes)) {
    if (!keep.has(id)) delete shapes[id];
  }
  const relationships = r.page.relationships.filter(
    (rel) => keep.has(rel.beginId) && keep.has(rel.endId)
  );
  // 中心主题换成这张图的根：它已经在落树时是 MainIdea（applyDiagram 按
  // 协议根的层级定了类型），这里只确认 parentId 为空。
  shapes[rootSid] = { ...shapes[rootSid], type: "MainIdea", parentId: null };
  return { page: { ...r.page, rootId: rootSid, shapes, relationships }, ids: r.ids };
}

/** 这张图里主题的纯文字（诊断与提示用）。 */
export function diagramTexts(page: Page, ids: readonly string[]): string[] {
  return ids.map((id) => (page.shapes[id] ? plainText(page.shapes[id].text) : "")).filter(Boolean);
}

// ======================================================================
// 像素级图（第二步）：生图结果落到一个主题上。
//
// 媒体引用约定（全仓唯一一份）：
// - 字节进 `doc.media["ai-<shapeId>.png"]`（.emmx 的 media/ 容器已有读写通路，
//   不动亿图 XML 格式 —— 零格式风险）；
// - 引用记 `extras.image = { relId: "ai-<shapeId>.png", width, height }`；
// - 渲染层（画布/SVG/PNG/PDF）看到 extras.image 就画 <image>。
// 读侧（从 .emmx 回读 image）暂不实现：亿图样张没有 AI 图，第三步做。
// ======================================================================

/**
 * 把一张 PNG（base64）挂到一个主题上：引用进 extras。
 * 字节本身由调用方写进 doc.media（键用 imageMediaName(shapeId)）——
 * mutateDoc 才能改 media，本函数只管页内。
 */
export function attachImageToShape(
  page: Page,
  shapeId: string,
  width: number,
  height: number
): Page {
  const s = page.shapes[shapeId];
  if (!s) return page;
  const name = imageMediaName(shapeId);
  return {
    ...page,
    shapes: {
      ...page.shapes,
      [shapeId]: { ...s, extras: { ...s.extras, image: { relId: name, width, height } } },
    },
  };
}

/** media 字典的键（docStore 侧用它写 DocumentModel.media）。 */
export function imageMediaName(shapeId: string): string {
  return `ai-${shapeId}.png`;
}

/**
 * 原地替换一张图的字节（AI 改图用）。
 *
 * ## 为什么只换字节、不动引用
 *
 * `extras.image` 记着 relId 与宽高。改图时**引用必须保持不变**：
 * - relId 不变 ⇒ 形状不用重建，位置、层级、折叠状态、连���全不受影响；
 * - 宽高不变 ⇒ 画布布局不跳（网关的 img2img 输出尺寸 = 输入尺寸，
 *   尺寸本来就不该变；真变了也要按原尺寸走，否则这根枝会忽然长一截）。
 *
 * 换字节而不是换新主题还有第二个好处：media 在文档快照里
 * （structuredClone 认得 Uint8Array），所以撤销能真的把原图还回来。
 *
 * 纯函数：媒体约定只有这一份，别处再写一遍"怎么换图"迟早会和 attachImageToShape 漂移。
 */
export function replaceImageBytes(
  doc: DocumentModel,
  relId: string,
  bytes: Uint8Array
): DocumentModel {
  return { ...doc, media: { ...doc.media, [relId]: bytes } };
}

/** 关系线的类型别名导出，便于外部引用而不必引 types/model.ts。 */
export type { RelationshipShape };
