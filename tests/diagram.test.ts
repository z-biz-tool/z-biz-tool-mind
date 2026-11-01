/**
 * AI 结构化图的协议面：解析、四道闸、落树。
 *
 * 这里钉的是**不可辩驳的部分**：模型给的 JSON 是什么形状，我们怎么把它变成一棵树。
 * 网络、配额、锁不在单测里跑（services/ai.ts 那条路径要在浏览器实测），
 * 但"模型给了脏数据"这件事本身是**可复现**的 —— 所以这里用脏样本当夹具。
 *
 * 变异对照的靶子（改这几处必须精确变红）：
 * ① 去掉「引用存在」闸 ⇒ 悬空 parent 的用例红
 * ② 去掉「无环」闸 ⇒ 环的用例红
 * ③ 去掉「深度上限」 ⇒ 深树的用例红
 * ④ applyDiagram 里 parentId 不回写 ⇒ 落树后父子不一致的用例红
 */
import { done, eq, ok } from "./_harness.ts";
import { createPage } from "../src/model/factory.ts";
import {
  DIAGRAM_MAX_DEPTH,
  DIAGRAM_MAX_NODES,
  applyDiagram,
  extractJson,
  normalizeDiagram,
  parseDiagram,
  placeDiagram,
} from "../src/engine/diagram.ts";
import { countTopics, insertChild, toggleRelationship } from "../src/engine/tree.ts";
import { plainText } from "../src/types/model.ts";

/* -------------------------------------------------- 剥壳 */

const fenced = extractJson('```json\n{"nodes":[],"edges":[]}\n```');
ok("剥掉代码围栏", fenced.ok && (fenced.value as { nodes: unknown[] }).nodes.length === 0);

const withPreamble = extractJson('好的，这是图：\n{"nodes":[{"id":"a","text":"甲"}]}\n希望对你有帮助！');
ok("剥掉前言与客套", withPreamble.ok);

const truncated = extractJson('{"nodes":[{"id":"a","text":"甲"');
eq(
  "截断的 JSON 要说清是截断，不是笼统的解析失败",
  truncated.ok ? "ok" : truncated.message.includes("截断"),
  true
);

const noJson = extractJson("我今天不太方便画图");
eq("没有 JSON 时明确说没有", noJson.ok ? "ok" : noJson.message.includes("JSON"), true);

/* -------------------------------------------------- 正常解析 */

const good = parseDiagram(
  JSON.stringify({
    nodes: [
      { id: "n1", text: "需求", parent: null },
      { id: "n2", text: "设计", parent: "n1" },
      { id: "n3", text: "开发", parent: "n1" },
      { id: "n4", text: "接口", parent: "n2" },
    ],
    edges: [{ from: "n1", to: "n2", text: "驱动" }],
  })
);
ok("正常规格解析成功", good.ok, good.ok ? "" : good.message);
if (good.ok) {
  eq("四个节点", good.diagram.nodes.length, 4);
  eq("一条边", good.diagram.edges.length, 1);
  eq("根是 n1", good.diagram.rootId, "n1");
  eq("边的文字保留", good.diagram.edges[0].text, "驱动");
}

/* -------------------------------------------------- 闸 1：结构 */

const notObject = normalizeDiagram([1, 2, 3]);
eq("不是对象要拒绝", notObject.ok, false);

const noNodes = normalizeDiagram({ edges: [] });
eq("缺 nodes 要拒绝", noNodes.ok, false);

const emptyNodes = normalizeDiagram({ nodes: [], edges: [] });
eq("空节点要拒绝", emptyNodes.ok, false);

const noId = normalizeDiagram({ nodes: [{ text: "甲" }] });
eq("缺 id 要拒绝", noId.ok, false);

const noText = normalizeDiagram({ nodes: [{ id: "a" }] });
eq("缺 text 要拒绝", noText.ok, false);

const blankText = normalizeDiagram({ nodes: [{ id: "a", text: "   " }] });
eq("空文字要拒绝", blankText.ok, false);

const dupId = normalizeDiagram({
  nodes: [
    { id: "a", text: "甲" },
    { id: "a", text: "乙" },
  ],
});
eq("id 重复要拒绝", dupId.ok, false);
eq("id 重复要说明是哪个 id", dupId.ok ? "" : dupId.message.includes("a"), true);

/* -------------------------------------------------- 闸 2：引用存在 */

// 样本要**只**违反这一条：节点自己的结构合法、树无环、规模有界。
// 若样本同时踩了别的闸，去掉这道闸时错误会被别的闸兜住，测试就不红了 ——
// 那样这条判据就没有牙齿（变异对照实测过：共用样本会让"引用闸"变哑）。
const dangling = normalizeDiagram({
  nodes: [
    { id: "a", text: "甲" },
    { id: "b", text: "乙", parent: "ghost" },
  ],
});
eq("悬空的 parent 要拒绝", dangling.ok, false);
eq("悬空 parent 要点名", dangling.ok ? "" : dangling.message.includes("ghost"), true);
eq("悬空 parent 要指出是哪个节点", dangling.ok ? "" : dangling.message.includes("b"), true);

const danglingEdge = normalizeDiagram({
  nodes: [
    { id: "a", text: "甲" },
    { id: "b", text: "乙" },
  ],
  edges: [{ from: "a", to: "ghost" }],
});
eq("悬空的边要拒绝", danglingEdge.ok, false);
eq("悬空的边要点名", danglingEdge.ok ? "" : danglingEdge.message.includes("ghost"), true);

const edgeNotArray = normalizeDiagram({
  nodes: [{ id: "a", text: "甲" }],
  edges: "nope",
});
eq("edges 不是数组要拒绝", edgeNotArray.ok, false);

const edgeNoEnds = normalizeDiagram({
  nodes: [{ id: "a", text: "甲" }],
  edges: [{ from: "a" }],
});
eq("边缺 to 要拒绝", edgeNoEnds.ok, false);

/* -------------------------------------------------- 闸 3：环 */

const cyclic = normalizeDiagram({
  nodes: [
    { id: "a", text: "甲", parent: "b" },
    { id: "b", text: "乙", parent: "a" },
  ],
});
eq("成环要拒绝", cyclic.ok, false);
eq("成环要说明是环", cyclic.ok ? "" : cyclic.message.includes("环"), true);
// 环闸必须**独立承责**：不能被"没有根节点"那道闸兜住。
// 判据重叠 = 判据失守：撤掉环闸后这两条都必须变红。
eq(
  "成环不能被「没有根节点」那道闸兜住",
  cyclic.ok ? "" : cyclic.message.includes("没有根节点"),
  false
);

const selfCycle = normalizeDiagram({
  nodes: [{ id: "a", text: "甲", parent: "a" }],
});
eq("自环要拒绝", selfCycle.ok, false);

/* -------------------------------------------------- 闸 4：规模 */

const tooMany = normalizeDiagram({
  nodes: Array.from({ length: DIAGRAM_MAX_NODES + 1 }, (_, i) => ({
    id: `n${i}`,
    text: `节点${i}`,
  })),
});
eq("节点超上限要拒绝", tooMany.ok, false);

const tooDeep = normalizeDiagram({
  // 单根、链式、无环 —— 只违反深度这一条。
  nodes: Array.from({ length: DIAGRAM_MAX_DEPTH + 2 }, (_, i) => ({
    id: `n${i}`,
    text: `第${i}层`,
    parent: i === 0 ? null : `n${i - 1}`,
  })),
});
eq("太深要拒绝", tooDeep.ok, false);
eq("太深要说明", tooDeep.ok ? "" : tooDeep.message.includes("深"), true);

const longText = normalizeDiagram({
  nodes: [{ id: "a", text: "字".repeat(200) }],
});
eq("单字过长要拒绝", longText.ok, false);

/* -------------------------------------------------- 多根的处理 */

const twoRoots = normalizeDiagram({
  nodes: [
    { id: "a", text: "甲" },
    { id: "b", text: "乙" },
  ],
});
ok("两个根不算错", twoRoots.ok);
if (twoRoots.ok) {
  eq("第一个根当根", twoRoots.diagram.rootId, "a");
  eq("第二个根挂到根下", twoRoots.diagram.nodes.find((n) => n.id === "b")?.parent, "a");
}

/* -------------------------------------------------- 落树 */

const page0 = createPage("结构化图");
const spec = normalizeDiagram({
  nodes: [
    { id: "n1", text: "需求", parent: null },
    { id: "n2", text: "设计", parent: "n1" },
    { id: "n3", text: "开发", parent: "n1" },
    { id: "n4", text: "接口", parent: "n2" },
  ],
  edges: [{ from: "n1", to: "n3", text: "并行" }],
});
ok("落树用的规格是合法的", spec.ok);
if (spec.ok) {
  const applied = applyDiagram(page0, spec.diagram);
  const ids = applied.ids;
  eq("落了四颗形状", ids.length, 4);

  // 父子双向一致：这是 tree.ts 的头号不变量，AI 落树也不能破。
  let consistent = true;
  for (const id of ids) {
    const s = applied.page.shapes[id];
    for (const c of s.childIds) {
      if (!applied.page.shapes[c]) consistent = false;
      else if (applied.page.shapes[c].parentId !== id) consistent = false;
    }
    if (s.parentId) {
      const p = applied.page.shapes[s.parentId];
      if (!p || !p.childIds.includes(id)) consistent = false;
    }
  }
  ok("父子双向索引一致", consistent);

  const root = applied.page.shapes[ids[0]];
  eq("协议根落成 MainIdea", root.type, "MainIdea");
  eq("根是 MainTopic 的孩子 —— 不，它是根", root.parentId, null);
  const child = applied.page.shapes[ids[1]];
  eq("一级分支是 MainTopic", child.type, "MainTopic");
  const grand = applied.page.shapes[ids[3]];
  eq("更深是 SubTopic", grand.type, "SubTopic");

  eq("关系线落了一条", applied.page.relationships.length, 1);
  const rel = applied.page.relationships[0];
  eq("关系线的文字在", plainText(rel.text), "并行");
  ok(
    "关系线两端都在页里",
    Boolean(applied.page.shapes[rel.beginId]) && Boolean(applied.page.shapes[rel.endId])
  );

  ok(
    "每个节点都带 AI 标",
    ids.every((id) => applied.page.shapes[id].extras.ai === true)
  );

  // id 不撞号：形状与关系线共用号段（nextShapeId 的注释里明写了这件事）。
  const allIds = [...ids, ...applied.page.relationships.map((r) => r.id)];
  eq("id 不重复", new Set(allIds).size, allIds.length);
}

/* -------------------------------------------------- 落成整页（replace） */

if (spec.ok) {
  const replaced = placeDiagram(page0, spec.diagram, "replace");
  const kept = Object.keys(replaced.page.shapes);
  eq("replace 后只剩这张图的形状", kept.length, 4);
  eq("中心主题换成图的根", replaced.page.rootId, replaced.ids[0]);
  eq("新中心主题是 MainIdea", replaced.page.shapes[replaced.page.rootId].type, "MainIdea");
  eq("主题数正确", countTopics(replaced.page), 4);
  ok("旧中心主题没留下", !replaced.page.shapes[page0.rootId]);
}

/* -------------------------------------------------- 挂到现有树上（attach） */

if (spec.ok) {
  let host = createPage("宿主");
  const base = countTopics(host);
  const attached = placeDiagram(host, spec.diagram, "attach");
  eq("attach 增加了四颗主题", countTopics(attached.page) - base, 4);
  // 主树仍然只有一个 MainIdea（tree.ts 不变量 1）。
  const mainIdeas = Object.values(attached.page.shapes).filter((s) => s.type === "MainIdea");
  eq("主树仍只有一个 MainIdea", mainIdeas.length, 1);
  eq("宿主中心主题没被换掉", attached.page.rootId, host.rootId);
}

/* -------------------------------------------------- 落树层的健壮性 */

// 落树是**公开原语**：调用方未必都走过 normalizeDiagram。
// 悬空的 parent 在落树时必须被跳过，而不是抛 TypeError ——
// 「用户数据有问题」不该变成「应用崩了」。
//
// 同时这一段也钉住「必须迭代不能递归」：绕过校验的脏规格可以有任意长的
// parent 链，递归回溯会直接爆栈。这里用一条超过调用栈承受力的链来验。
const deepSpec = {
  nodes: Array.from({ length: 100_000 }, (_, i) => ({
    id: `n${i}`,
    text: `第${i}层`,
    parent: i === 0 ? null : `n${i - 1}`,
  })),
  edges: [],
  rootId: "n0",
};
let deepCrashed = false;
try {
  applyDiagram(createPage("深链"), deepSpec);
} catch (e) {
  deepCrashed = e instanceof RangeError; // 爆栈是 RangeError，普通抛错不算
}
eq("十万级深链不爆栈（迭代不是递归）", deepCrashed, false);

const dirtySpec = {
  nodes: [
    { id: "a", text: "甲", parent: null },
    { id: "b", text: "乙", parent: "ghost" },
  ],
  edges: [],
  rootId: "a",
};
let crashed = false;
let dirtyApplied: ReturnType<typeof applyDiagram> | null = null;
try {
  dirtyApplied = applyDiagram(createPage("脏规格"), dirtySpec);
} catch {
  crashed = true;
}
eq("悬空 parent 落树不崩", crashed, false);
ok("悬空 parent 的节点仍在页里", Boolean(dirtyApplied?.ids.length === 2));
if (dirtyApplied) {
  const bId = dirtyApplied.ids[1];
  eq("悬空 parent 的节点被当成根", dirtyApplied.page.shapes[bId].parentId, null);
}

/* -------------------------------------------------- replace 与 attach 的收尾纪律 */

// replace 删掉了页里所有旧形状：指向它们的关系线必须跟着清，
// 否则投影层读到 undefined（tree.ts removeShape 里 prune 的同一条纪律）。
if (spec.ok) {
  // 先造一页：有旧主题、有一条挂在旧主题上的关系线。
  let host = createPage("replace 夹具");
  host = insertChild(host, host.rootId, "旧甲").page;
  host = insertChild(host, host.rootId, "旧乙").page;
  const [c1, c2] = host.shapes[host.rootId].childIds;
  host = toggleRelationship(host, c1, c2);
  eq("夹具里有一条关系线", host.relationships.length, 1);

  const replaced = placeDiagram(host, spec.diagram, "replace");
  ok(
    "replace 后没有悬空的关系线",
    replaced.page.relationships.every(
      (r) => replaced.page.shapes[r.beginId] && replaced.page.shapes[r.endId]
    )
  );
  // spec 自带一条边（n1→n3"并行"）：它必须保留；指向已删旧主题的那条必须清掉。
  eq("replace 后只剩这张图自己的关系线", replaced.page.relationships.length, 1);
  ok(
    "旧主题之间的关系线被清掉",
    replaced.page.relationships.every(
      (r) => r.beginId !== c1 && r.beginId !== c2 && r.endId !== c1 && r.endId !== c2
    )
  );

  // attach：整棵新枝的类型要按挂载后的层级重算。
  const host2 = createPage("attach 夹具");
  const attached = placeDiagram(host2, spec.diagram, "attach");
  const rootIdx = spec.diagram.nodes.findIndex((n) => n.id === spec.diagram.rootId);
  const rootSid = attached.ids[rootIdx];
  eq("attach 后协议根是 MainTopic（降一级）", attached.page.shapes[rootSid].type, "MainTopic");
  // 协议里的一级分支（n2/n3）挂载后到了第三层，必须是 SubTopic。
  const n2 = attached.ids[spec.diagram.nodes.findIndex((n) => n.id === "n2")];
  const n4 = attached.ids[spec.diagram.nodes.findIndex((n) => n.id === "n4")];
  eq("协议一级分支降为 SubTopic", attached.page.shapes[n2].type, "SubTopic");
  eq("协议深层也是 SubTopic", attached.page.shapes[n4].type, "SubTopic");
  // 双向索引仍然一致。
  const rootShape = attached.page.shapes[rootSid];
  eq("协议根的父是中心主题", rootShape.parentId, host2.rootId);
  ok(
    "中心主题的 childIds 收了协议根",
    attached.page.shapes[host2.rootId].childIds.includes(rootSid)
  );
}

/* -------------------------------------------------- 脏数据不留痕 */

// 脏输入必须**整份拒绝**，而不是"尽力而为地修一修"：
// 半修半坏的结构会让用户看到一张缺胳膊少腿的图，然后花半小时猜"AI 是不是坏了"。
const dirty = parseDiagram("这不是 JSON");
eq("脏输入被整份拒绝", dirty.ok, false);
ok("脏输入要带一句能照着改的话", !dirty.ok && dirty.message.length > 10);
ok(
  "拒绝的理由要点名缺什么",
  !dirty.ok && (dirty.message.includes("JSON") || dirty.message.includes("内容"))
);

done();
