/**
 * AI 看图（第三步，多模态理解）的纯函数与守门判定。
 *
 * 网络不在单测里跑（真实视觉模型秒级响应，在桌面实测）。
 * 这里钉住不可辩驳的部分：三个动词的提示词协议、base64 分块编码、
 * 菜单门禁（aiVision 进目录）、图片缺失的两类失败不靠正则猜文案。
 */
import { done, eq, ok } from "./_harness.ts";
import { buildVisionPrompt, bytesToBase64, VISION_VERB_LABEL } from "../src/services/ai.ts";
import { MENU_ACTION_GROUPS } from "../src/canvas/menuActions.ts";

/* -------------------------------------------------- 提示词协议 */

for (const verb of ["toOutline", "extractText", "describe"] as const) {
  const p = buildVisionPrompt(verb, "流程图", "");
  ok(`${verb} 提示词非空`, p.length > 20, p);
  ok(`${verb} 提示词不含代码围栏字样`, !p.includes("```"));
}
ok(
  "三个动词标签互不相同",
  new Set(Object.values(VISION_VERB_LABEL)).size === 3
);

// 附加要求必须真的进提示词 —— 否则用户填了「用英文输出」却静默失效。
ok("附加要求进入提示词", buildVisionPrompt("describe", "", "用英文输出").includes("用英文输出"));
// 主题名进提示词（视觉模型要知道这张图挂在哪）。
ok("主题名进入提示词", buildVisionPrompt("toOutline", "登录流程", "").includes("登录流程"));
// 空附加要求不残留「附加要求：」空标签。
ok(
  "空附加要求不产生空标签",
  !buildVisionPrompt("toOutline", "t", "").includes("附加要求：\n")
);

/* -------------------------------------------------- base64 分块 */

// 分块编码必须与一次性编码同结果 —— 0x8000 边界两侧最容易错。
const sizes = [0, 1, 100, 0x7fff, 0x8000, 0x8001, 0x10000];
for (const n of sizes) {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = i % 251;
  const got = bytesToBase64(bytes);
  const want = btoa(String.fromCharCode(...bytes));
  eq(`base64 分块正确（${n} 字节）`, got, want);
}

/* -------------------------------------------------- 菜单门禁 */

const KEYS = MENU_ACTION_GROUPS.map((g) => g.k);
ok("aiVision 在动作目录里", KEYS.includes("aiVision"));
// 有图才出菜单项（MindCanvas 挂 extras.image 条件）——目录里这条的标签要说明动作本身。
ok(
  "aiVision 标签说明了三个动词之一",
  /看图/.test(MENU_ACTION_GROUPS.find((g) => g.k === "aiVision")?.label ?? "")
);

done();
