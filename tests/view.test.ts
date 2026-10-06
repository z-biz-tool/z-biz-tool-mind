/**
 * 视口几何（"适应画布"与"打开时自动适应画布"共用的一次计算）。
 * 覆盖的缺陷形状：
 * 1) 视口还没量出来 / 内容是空的 —— 必须回 null，让调用方把请求欠着，而不是算出 NaN 位移；
 * 2) 小图不该被放大填满窗口：上限 100%，只解决"装不下"；
 * 3) 极端的窄高 / 矮宽内容按较短的那条边算，且不低于缩放档位下限；
 * 4) 位移是按内容外框中心推出来的，原点不在 (0,0) 时也不能算歪。
 */
import { done, eq, near, ok } from "./_harness.ts";
import { ZOOM_STEPS } from "../src/model/constants.ts";
import { fitView } from "../src/engine/view.ts";

const atOrigin = (width: number, height: number) => ({ minX: 0, minY: 0, width, height });

// --- 算不出来的小心情形
eq("视口宽度还没量到 → 不做适应", fitView({ w: 0, h: 600 }, atOrigin(300, 200)), null);
eq("内容包围盒是空的 → 不做适应", fitView({ w: 800, h: 600 }, atOrigin(0, 200)), null);
ok("视口比留边还小也不会算出负缩放", fitView({ w: 60, h: 60 }, atOrigin(300, 200))!.zoom === ZOOM_STEPS[0]);

// --- 上限 100%：小图保持原样，只居中
const small = fitView({ w: 1000, h: 800 }, atOrigin(200, 100));
ok("小图也能适应", small !== null);
eq("小图不放大", small!.zoom, 1);
eq("小图水平居中", small!.pan.x, 500 - 100);
eq("小图垂直居中", small!.pan.y, 400 - 50);

// --- 装不下才缩小，并留出四周的边
const wide = fitView({ w: 1000, h: 800 }, atOrigin(2000, 100));
ok("宽图能缩小", wide !== null);
near("按可用宽度算缩放", wide!.zoom, (1000 - 96) / 2000, 0.001);
near("缩小后正好占满可用宽度", wide!.zoom * 2000, 1000 - 96, 0.6);

// --- 长分支的文档按高度那条边算（这才是"打开时自动适应"存在的理由）
const tall = fitView({ w: 1000, h: 800 }, atOrigin(300, 2000));
ok("高图取更小的那个比例", tall !== null && tall!.zoom < wide!.zoom);
near("按可用高度算缩放", tall!.zoom, (800 - 96) / 2000, 0.001);

// --- 下限：再长也不能缩到看不见
const huge = fitView({ w: 1000, h: 800 }, atOrigin(300, 90000));
eq("缩到底也守住档位下限", huge!.zoom, ZOOM_STEPS[0]);

// --- 外框不在原点：位移要跟着 minX/minY 走
const off = fitView({ w: 1000, h: 800 }, { minX: -400, minY: 120, width: 200, height: 100 });
eq("非原点外框依旧居中", off!.pan.x, 500 - (-400 + 100));
eq("非原点外框的纵轴同样对齐", off!.pan.y, 400 - (120 + 50));

done();
