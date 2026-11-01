/**
 * AI 改图（第四步，图生图）的纯函数与守门判定。
 *
 * 网络不在单测里跑（真实网关改图 1~3 分钟，在桌面实测）。
 * 这里钉住不可辩驳的部分：力度档位的语义边界、提示词协议、
 * 媒体字节替换的原语（引用不动、字节换新）、菜单门禁。
 */
import { done, eq, ok } from "./_harness.ts";
import {
  buildEditPrompt,
  denoiseOf,
  EDIT_DENOISE_PRESETS,
  DEFAULT_EDIT_DENOISE_KEY,
} from "../src/services/ai.ts";
import { replaceImageBytes, imageMediaName } from "../src/engine/diagram.ts";
import { MENU_ACTION_GROUPS } from "../src/canvas/menuActions.ts";
import { createPage } from "../src/model/factory.ts";
import { insertChild, setFloating } from "../src/engine/tree.ts";
import { attachImageToShape } from "../src/engine/diagram.ts";

/* -------------------------------------------------- 力度档位 */

// 网关把 denoise 钳在 0.05~0.95（KSampler 的 1.0 = 完全重画，原图彻底丢掉）。
for (const p of EDIT_DENOISE_PRESETS) {
  ok(
    `档位 ${p.key} 的力度在网关可接受范围内`,
    p.denoise > 0.05 && p.denoise < 0.95,
    `${p.key}=${p.denoise}`
  );
  ok(`档位 ${p.key} 有说明`, p.tip.trim().length > 0);
  ok(`档位 ${p.key} 有中文标签`, p.label.trim().length > 0);
}

// 默认档位必须真的能改结构：实测 FLUX schnell 在 0.5~0.6 只改纹理，
// ≥0.85 才明显改结构。默认定低 ⇒ 用户说「改成跑车」却只换了个滤镜。
ok(
  "默认档位的力度足以改变结构",
  denoiseOf(DEFAULT_EDIT_DENOISE_KEY) >= 0.85,
  `默认 ${DEFAULT_EDIT_DENOISE_KEY}=${denoiseOf(DEFAULT_EDIT_DENOISE_KEY)}`
);

// 档位之间必须有可感知的差异，否则三档就是同一个东西的三种写法。
const levels = EDIT_DENOISE_PRESETS.map((p) => p.denoise).sort((a, b) => a - b);
for (let i = 1; i < levels.length; i++) {
  ok(
    `相邻档位有区分度（${levels[i - 1]} vs ${levels[i]}）`,
    levels[i] - levels[i - 1] >= 0.15,
    `差 ${(levels[i] - levels[i - 1]).toFixed(2)}`
  );
}

// 未知档位不能变成 0（那等于"几乎不重画"）。
ok("未知档位回落到默认", denoiseOf("不存在的档位" as never) === 0.85);

/* -------------------------------------------------- 提示词协议 */

const p = buildEditPrompt("改成夜晚的街道", "城市漫游");
ok("改图提示词非空", p.length > 20);
ok("改图要求进入提示词", p.includes("改成夜晚的街道"));
ok("主题名进入提示词", p.includes("城市漫游"));
// 要求里若含代码围栏，别把提示词本身搞出围栏（网关按纯文本送 CLIP）。
ok("提示词本身不含代码围栏", !p.includes("```"));

/* -------------------------------------------------- 媒体字节替换 */

// 替换字节后：引用（relId / 宽高）必须纹丝不动，只有 media 里的字节换新。
let page = createPage("改图");
const r = insertChild(page, page.rootId, "带图主题");
page = setFloating(r.page, r.id, 100, 100, true);
page = attachImageToShape(page, r.id, 320, 320);

const relId = imageMediaName(r.id);
const doc0 = {
  pages: [page],
  media: { [relId]: new Uint8Array([1, 2, 3]) },
  properties: { docGuid: "g" },
  rawUnknown: {},
};

const newBytes = new Uint8Array([9, 9, 9, 9]);
const doc1 = replaceImageBytes(doc0 as never, relId, newBytes);

// 字节换新
eq("字节长度已更新", doc1.media[relId].length, 4);
eq("字节内容已更新", Array.from(doc1.media[relId]), [9, 9, 9, 9]);
// 原文档不受影响（纯函数）
eq("原文档的字节没被动", Array.from(doc0.media[relId]), [1, 2, 3]);
// 引用不动：形状的 extras.image 与宽高都没变
const shapeAfter = doc1.pages[0].shapes[r.id];
eq("引用 relId 不变", shapeAfter.extras.image?.relId, relId);
eq("引用宽度不变", shapeAfter.extras.image?.width, 320);
eq("引用高度不变", shapeAfter.extras.image?.height, 320);
// media 里别的键不能被抹掉
const doc2 = replaceImageBytes(
  { ...doc1, media: { ...doc1.media, "别的.png": new Uint8Array([7]) } } as never,
  relId,
  newBytes
);
ok("别的媒体项仍在", Boolean(doc2.media["别的.png"]));

/* -------------------------------------------------- 菜单门禁 */

const KEYS = MENU_ACTION_GROUPS.map((g) => g.k);
ok("aiEditImage 在动作目录里", KEYS.includes("aiEditImage"));
ok(
  "aiEditImage 标签说明了改图",
  /改图/.test(MENU_ACTION_GROUPS.find((g) => g.k === "aiEditImage")?.label ?? "")
);

done();
