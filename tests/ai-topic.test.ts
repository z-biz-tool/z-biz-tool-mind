/**
 * AI A 层的纯函数面（02 §3，批 3R）：四个动词的提示词、落树打标、替换语义。
 *
 * 网络与配额不在单测里跑 —— runAiOnTopic 的流程分支（未配置 / 锁 / 结算）在浏览器实测，
 * 这里钉住的是不可辩驳的部分：提示词里带着该带的东西、落树只给新主题打标、
 * 精简/再生成真的摘掉原子枝且关系线跟着清、缩进协议仍只有 outline.ts 那一份。
 */
import { done, eq, ok } from "./_harness.ts";
import { createPage } from "../src/model/factory.ts";
import { insertChild, toggleRelationship } from "../src/engine/tree.ts";
import { AI_VERB_LABEL, applyTopicAction, buildTopicPrompt } from "../src/services/ai.ts";
import { plainText } from "../src/types/model.ts";

/* -------------------------------------------------- 提示词 */

const sub = buildTopicPrompt("subtopics", "市场计划", []);
ok("生成子主题的提示词带着主题文字", sub.includes("市场计划"), sub);
ok("生成子主题说清数量", sub.includes("5~8"), sub);

const exp = buildTopicPrompt("expand", "增长", ["渠道", "定价"]);
ok("丰富内容列出已有子主题让模型避开", exp.includes("渠道、定价"), exp);
ok("丰富内容说清数量", exp.includes("4~6"), exp);

const con = buildTopicPrompt("condense", "增长", ["渠道", "定价"]);
ok("精简内容看着子内容说话", con.includes("渠道") && con.includes("定价"), con);
ok("精简内容说清数量", con.includes("3~5"), con);

const regen = buildTopicPrompt("regen", "增长", ["旧甲"]);
eq("再生成提示词不含旧子主题", regen.includes("旧甲"), false);
ok("再生成说清数量", regen.includes("5~8"), regen);

eq("空标题占位，不把空串塞进提示词", buildTopicPrompt("subtopics", "", []).includes("（无标题）"), true);
eq("四个动词都有中文标签", Object.keys(AI_VERB_LABEL).length, 4);

/* -------------------------------------------------- 落树与打标 */

let page = createPage("AI 助手");
page = insertChild(page, page.rootId, "甲").page;
page = insertChild(page, page.rootId, "乙").page;
const root = page.rootId;
const [a, b] = page.shapes[root].childIds;
const base = Object.keys(page.shapes).length;

const ins = applyTopicAction(page, root, "subtopics", "一\n二\n三");
eq("三个子主题挂到锚点下", ins.shapes[root].childIds.length, 5);
const fresh = ins.shapes[root].childIds.slice(2);
ok(
  "新主题带着 AI 标",
  fresh.every((id) => ins.shapes[id].extras.ai === true),
  JSON.stringify(fresh.map((id) => ins.shapes[id].extras))
);
ok("原有主题不打标", ins.shapes[a].extras.ai !== true && ins.shapes[b].extras.ai !== true);

// 制表符缩进是模型最爱的返回格式：不摊平就整层消失（ai.ts flattenIndent 的存在理由）
const tabbed = applyTopicAction(page, root, "subtopics", "\t子一\n\t\t孙一\n子二");
eq("制表符行不消失", tabbed.shapes[root].childIds.length, 4);
const firstNew = tabbed.shapes[root].childIds[2];
eq("制表符的层级照旧", plainText(tabbed.shapes[tabbed.shapes[firstNew].childIds[0]].text), "孙一");

// 模型爱包代码围栏：不剥掉会多出一个叫 markdown 的主题
const bare = applyTopicAction(page, root, "subtopics", "一\n二");
const fenced = applyTopicAction(page, root, "subtopics", "```text\n一\n二\n```");
eq("围栏剥掉才落树", Object.keys(fenced.shapes).length, Object.keys(bare.shapes).length);

/* -------------------------------------------------- 替换语义（精简 / 再生成） */

const con2 = applyTopicAction(page, root, "condense", "要点甲\n要点乙");
// 不能按 id 判"旧枝没了"：删两个再插两个，id 分配器会把 102/103 复用给新主题，按文字判才作数。
const conTexts = Object.values(con2.shapes).map((s) => plainText(s.text));
ok("精简摘掉了原有子枝", conTexts.includes("甲") === false && conTexts.includes("乙") === false, JSON.stringify(conTexts));
eq("精简落进的是新的关键点", con2.shapes[root].childIds.length, 2);
ok(
  "关键点也带着 AI 标",
  con2.shapes[root].childIds.every((id) => con2.shapes[id].extras.ai === true)
);
eq("精简不碰锚点自己", plainText(con2.shapes[root].text), plainText(page.shapes[root].text));

const withRel = toggleRelationship(page, a, b);
eq("夹具里确有一条关系线", withRel.relationships.length, 1);
const regen2 = applyTopicAction(withRel, root, "regen", "新甲");
eq("摘子枝时关系线跟着清", regen2.relationships.length, 0);
ok("锚点还在树上", regen2.shapes[root] !== undefined);

// 空 / 不可识别的输出：树必须原样返回，不能拿空串把子枝洗掉
eq("空输出不动树", applyTopicAction(page, root, "condense", "") === page, true);
eq("纯空白不动树", applyTopicAction(page, root, "regen", "  \n  ") === page, true);
eq("夹具本身没被改", Object.keys(page.shapes).length, base);

done();
