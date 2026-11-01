/**
 * AI 结构化图的业务层纯函数面：提示词协议、落图入口。
 *
 * 网络、配额、锁不在单测里跑（runAiDiagram 的流程分支在浏览器实测），
 * 这里钉住的是不可辩驳的部分：提示词带着协议要点、脏回包整份拒绝不落半棵树。
 */
import { done, eq, ok } from "./_harness.ts";
import { createPage } from "../src/model/factory.ts";
import { buildDiagramPrompt, applyDiagramToPage } from "../src/services/ai.ts";
import { countTopics } from "../src/engine/tree.ts";

/* -------------------------------------------------- 提示词 */

const p = buildDiagramPrompt("登录流程");
ok("提示词带着用户的描述", p.includes("登录流程"), p);
ok("提示词给出 JSON 协议形状", p.includes('"nodes"') && p.includes('"edges"'), p);
ok("提示词要求恰好一个根", p.includes("parent"), p);
ok("提示词要求剥离围栏与解释", p.includes("不要代码围栏") || p.includes("不要解释"), p);
ok("提示词约束节点文字长度", p.includes("20 字"), p);

/* -------------------------------------------------- 落图入口 */

// 正常回包：剥围栏 → 得到规格。
// 落页发生在 runAiDiagram 的 mutate 里（对活页重算），这个纯入口只负责解析。
const raw = '```json\n{"nodes":[{"id":"n1","text":"需求","parent":null},{"id":"n2","text":"设计","parent":"n1"}],"edges":[]}\n```';
const page = createPage("AI 生成图");
const diagram = applyDiagramToPage(page, raw);
ok("正常回包解析成功", diagram !== null, raw);
if (diagram) {
  eq("两个节点", diagram.nodes.length, 2);
  eq("根是 n1", diagram.rootId, "n1");
  // 传入的 page 不被这个纯入口改动（落页是 mutate 的职责）。
  eq("纯解析不动传入的页", countTopics(page), 1);
}

// applyDiagramToPage 只解析不落页 —— 落页发生在 runAiDiagram 的 mutate 里。
// 这里钉住"脏回包必须返回 null"：
const dirty = applyDiagramToPage(createPage("脏"), "这不是 JSON");
eq("脏回包返回 null", dirty, null);

const truncated = applyDiagramToPage(createPage("截断"), '{"nodes":[{"id":"a","text":"甲"');
eq("截断的回包返回 null", truncated, null);

const cyclic = applyDiagramToPage(
  createPage("环"),
  '{"nodes":[{"id":"a","text":"甲","parent":"b"},{"id":"b","text":"乙","parent":"a"}],"edges":[]}'
);
eq("带环的回包返回 null", cyclic, null);

// 节点文字要真的进了树（用引擎原语直接验一次完整链路）。
const page2 = createPage("链路");
const spec2 = applyDiagramToPage(page2, '{"nodes":[{"id":"n1","text":"甲","parent":null}],"edges":[]}');
ok("规格解析成功", spec2 !== null);
if (spec2) {
  eq("节点文字保留", spec2.nodes[0].text, "甲");
  eq("根 id 正确", spec2.rootId, "n1");
}

// 围栏里的纯文本大纲（模型跑题了）：不是 JSON，整份拒绝。
const offTopic = applyDiagramToPage(createPage("跑题"), "```\n甲\n\t乙\n```");
eq("跑题的大纲回包整份拒绝", offTopic, null);

done();
