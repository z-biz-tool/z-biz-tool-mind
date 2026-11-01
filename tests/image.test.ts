/**
 * 像素级生图的落图与渲染判定（第二步）。
 *
 * 网络不在单测里跑（真实网关 55s/张，在浏览器/桌面实测）。
 * 这里钉住不可辩驳的部分：媒体引用约定、渲染层的「引用在字节不在」退化路径。
 */
import { done, eq, ok } from "./_harness.ts";
import { createPage } from "../src/model/factory.ts";
import { insertChild, setFloating } from "../src/engine/tree.ts";
import { attachImageToShape, imageMediaName } from "../src/engine/diagram.ts";
import { paintPage, renderSvg } from "../src/engine/export/svg.ts";

/* -------------------------------------------------- 媒体引用约定 */

eq("media 键约定 ai-<id>.png", imageMediaName("123"), "ai-123.png");

let page = createPage("挂图");
const r = insertChild(page, page.rootId, "带图主题");
page = setFloating(r.page, r.id, 100, 100, true);
page = attachImageToShape(page, r.id, 320, 320);

const shape = page.shapes[r.id];
ok("extras.image 引用已写", Boolean(shape.extras.image));
eq("relId 与 media 键一致", shape.extras.image?.relId, imageMediaName(r.id));
eq("尺寸记录", shape.extras.image?.width, 320);

/* -------------------------------------------------- 渲染判定（paint 层） */

// ① 引用在、字节也在 → ShapePaint.image 有值
const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
const media = { [imageMediaName(r.id)]: bytes };
const p1 = paintPage(page, { media });
const box1 = p1.boxes.find((b) => b.id === r.id);
ok("字节在 → image 有值", Boolean(box1?.image), JSON.stringify(box1?.image));

// ② 引用在、字节不在（旧文档/被剥离）→ 退化成普通盒子，不崩
const p2 = paintPage(page, {});
const box2 = p2.boxes.find((b) => b.id === r.id);
eq("字节不在 → image 退化 null", box2?.image ?? null, null);

// ③ 引用不在 → 无图
const page2 = insertChild(createPage("无图"), createPage("无图").rootId, "纯文字").page;
const p3 = paintPage(page2, { media });
ok("无引用 → 无 image", p3.boxes.every((b) => !b.image));

/* -------------------------------------------------- SVG 输出 */

const svg1 = renderSvg(p1);
ok("SVG 含 <image", svg1.includes("<image"), svg1.slice(0, 200));
ok("SVG 含 data URL", svg1.includes("data:image/png;base64,"));

const svg2 = renderSvg(p2);
eq("无字节时 SVG 无 <image", svg2.includes("<image"), false);

/* -------------------------------------------------- 脏输入 */

const base = createPage("x");
const empty = attachImageToShape(base, "99999", 1, 1);
eq("挂到不存在的主题 → 原页原样返回", empty, base);

done();
