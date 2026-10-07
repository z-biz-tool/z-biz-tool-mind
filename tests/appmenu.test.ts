/**
 * 原生菜单栏的声明部分（doc/复刻方案/00 §3.19：菜单是系统的那一份，工具栏只留高频）。
 *
 * appMenu.ts 故意拆成"纯 spec + 薄装配"，所以这里能在 node 里断言只有真窗口才看得见的事：
 * 1) 两套平台的顶层结构与退出/关于的落点（mac 在应用菜单，Windows 在文件/帮助）；
 * 2) 没有文档时哪些项该灰着 —— 灰掉而不是消失，用户才找得到功能在哪儿；
 * 3) 键位写进文案而不是 accelerator：原生加速键会抢在网页之前吃掉按键，
 *    把可自定义的键位表和画布的 Ctrl+A 全选都废掉；
 * 4) 结构不随状态增减：syncAppMenu 只改属性，一旦 spec 会加减项，菜单就会和缓存错位。
 */
import { done, eq, ok } from "./_harness.ts";
import {
  installAppMenu,
  menuSpec,
  syncAppMenu,
  type MenuState,
  type SpecLeaf,
  type SpecMenu,
} from "../src/services/appMenu.ts";
import { setShortcutOverrides } from "../src/utils/shortcuts.ts";

type IdNode = Extract<SpecLeaf, { id: string }>;

const BASE: MenuState = {
  mac: false,
  hasDoc: true,
  undoDepth: 2,
  redoDepth: 1,
  projection: "mindmap",
  sidebar: true,
  theme: "light",
};

const spec = (patch: Partial<MenuState> = {}): SpecMenu[] => menuSpec({ ...BASE, ...patch });

/** 深度摊平：子菜单自己也在里面，这样"整棵树 id 唯一"才覆盖得到分组。 */
function nodes(menus: SpecMenu[]): SpecLeaf[] {
  const out: SpecLeaf[] = [];
  const rec = (ls: SpecLeaf[]): void => {
    for (const l of ls) {
      out.push(l);
      if (l.kind === "sub") rec(l.children);
    }
  };
  for (const m of menus) rec(m.children);
  return out;
}

function need(menus: SpecMenu[], id: string): IdNode {
  const hit = nodes(menus).find((n): n is IdNode => "id" in n && n.id === id);
  if (!hit) throw new Error(`菜单里没有 ${id}`);
  return hit;
}

const tops = (menus: SpecMenu[]): string[] => menus.map((m) => m.text);
/** 按中文名找菜单只是让断言好读；真正定位用 id，这样顶层文案加不加助记键都不影响断言。 */
const MENU_ID: Record<string, string> = {
  文件: "file",
  编辑: "edit",
  视图: "view",
  帮助: "help",
  "z-biz-tool-mind": "app",
};
const byName = (menus: SpecMenu[], menu: string): SpecMenu => {
  const m = menus.find((x) => x.id === (MENU_ID[menu] ?? menu));
  if (!m) throw new Error(`没有「${menu}」这个菜单`);
  return m;
};
const childIds = (menus: SpecMenu[], menu: string): string[] =>
  byName(menus, menu)
    .children.filter((c) => "id" in c)
    .map((c) => (c as IdNode).id);
const pres = (menus: SpecMenu[], menu: string): string[] =>
  byName(menus, menu).children.flatMap((c) => (c.kind === "pre" ? [c.pre] : []));

// ---- 顶层结构
// Windows 的顶层标题带 Alt 助记键（Alt+F 展开文件），mac 的标题里没有 & 这套约定。
eq("Windows 顶层四个菜单", tops(spec()), ["文件(&F)", "编辑(&E)", "视图(&V)", "帮助(&H)"]);
eq("mac 第一项是应用菜单", tops(spec({ mac: true })), [
  "z-biz-tool-mind",
  "文件",
  "编辑",
  "视图",
  "帮助",
]);
eq("mac 的应用菜单只有系统项", pres(spec({ mac: true }), "z-biz-tool-mind").length, 5);

// ---- 退出 / 关于的落点
// 「退出」两边都是自定义项（预定义项直接退进程，会绕过未保存检查），只是位置按各自惯例放。
ok("Windows 的文件菜单以退出收尾", childIds(spec(), "文件").at(-1) === "file-quit");
eq("Windows 的帮助菜单带关于", pres(spec(), "帮助"), ["About"]);
ok(
  "mac 的文件菜单不放退出（在应用菜单里）",
  !childIds(spec({ mac: true }), "文件").includes("file-quit")
);
ok(
  "mac 的退出在应用菜单末尾",
  childIds(spec({ mac: true }), "z-biz-tool-mind").at(-1) === "file-quit"
);
eq("mac 的帮助菜单不放关于", pres(spec({ mac: true }), "帮助"), []);
eq("mac 的应用菜单放关于与系统项", pres(spec({ mac: true }), "z-biz-tool-mind"), [
  "About",
  "Services",
  "Hide",
  "HideOthers",
  "ShowAll",
]);
eq("两边都没有预定义的 Quit", pres(spec(), "文件"), []);

// ---- 文件 / 编辑 的项序
eq("文件菜单项序", childIds(spec(), "文件"), [
  "file-new",
  "file-open",
  "file-import",
  "file-save",
  "file-save-as",
  "file-export",
  "file-print",
  "file-history",
  "file-quit",
]);
eq("编辑菜单项序", childIds(spec(), "编辑"), ["edit-undo", "edit-redo", "edit-search"]);
eq(
  "视图菜单里六个投影 + 侧栏 + 三个缩放",
  childIds(spec(), "视图").filter((id) => id.startsWith("view-")),
  [
    "view-proj-mindmap",
    "view-proj-outline",
    "view-proj-kanban",
    "view-proj-slides",
    "view-proj-gantt",
    "view-proj-traverse",
    "view-sidebar",
    "view-zoom-out",
    "view-zoom-in",
    "view-zoom-fit",
    "view-theme",
  ]
);

// ---- 没有文档时：灰掉，不是删掉
const noDoc = spec({ hasDoc: false });
eq("开始页上文件菜单还是九项", childIds(noDoc, "文件").length, 9);
for (const id of ["file-new", "file-open", "file-import", "help-options", "file-quit"])
  ok(`${id} 没有文档时仍可用`, need(noDoc, id).enabled === true);
for (const id of [
  "file-save",
  "file-save-as",
  "file-export",
  "file-print",
  "file-history",
  "edit-undo",
  "edit-redo",
  "edit-search",
  "view-sidebar",
  "view-zoom-in",
  "view-proj-kanban",
])
  ok(`${id} 没有文档时该灰`, need(noDoc, id).enabled === false);
ok("界面主题没有文档时也能换", need(noDoc, "theme-dark").enabled === true);

// ---- 撤销/重做跟着栈深走
ok("栈是空的就灰掉撤销", need(spec({ undoDepth: 0 }), "edit-undo").enabled === false);
ok("没有可重做就灰掉重做", need(spec({ redoDepth: 0 }), "edit-redo").enabled === false);
ok("有栈就亮着", need(spec({ undoDepth: 1, redoDepth: 3 }), "edit-redo").enabled === true);

// ---- 键位写进文案
eq("Windows 菜单文案里的键位", need(spec(), "file-save").text, "保存\tCtrl+S");
eq("mac 用 ⌘ 且没有制表符", need(spec({ mac: true }), "file-save").text, "保存  ⌘S");
eq(
  "改过键位之后菜单文案跟着改",
  (() => {
    setShortcutOverrides({ save: "ctrl+shift+b" });
    const t = need(spec(), "file-save").text;
    setShortcutOverrides({});
    return t;
  })(),
  "保存\tCtrl+Shift+B"
);
eq(
  "禁用了键位就照说（而不是继续印一个按了没用的键）",
  (() => {
    setShortcutOverrides({ save: "" });
    const t = need(spec(), "file-save").text;
    setShortcutOverrides({});
    return t;
  })(),
  "保存\t（已禁用）"
);
eq("选项的键位是 F1", need(spec(), "help-options").text, "选项与快捷键…\tF1");

// ---- 勾选项：同组里必须只有一个被勾
const checks = (menus: SpecMenu[], prefix: string) =>
  nodes(menus).filter(
    (n): n is Extract<SpecLeaf, { kind: "check" }> => n.kind === "check" && n.id.startsWith(prefix)
  );
eq(
  "投影勾了当前那个",
  checks(spec({ projection: "kanban" }), "view-proj-")
    .filter((c) => c.checked)
    .map((c) => c.id),
  ["view-proj-kanban"]
);
eq(
  "主题勾了当前那个",
  checks(spec({ theme: "system" }), "theme-")
    .filter((c) => c.checked)
    .map((c) => c.id),
  ["theme-system"]
);
eq("侧栏勾着", need(spec(), "view-sidebar").checked, true);
eq("侧栏收起就不勾", need(spec({ sidebar: false }), "view-sidebar").checked, false);

// ---- 不给原生加速键（抢在网页之前吃掉按键的那条路一律不走）
ok(
  "spec 里没有任何 accelerator 字段",
  nodes(spec({ mac: true })).every((n) => !("accelerator" in n))
);

// ---- 结构稳定：状态只改属性，不减项（syncAppMenu 靠这个不变量）
const ids = (menus: SpecMenu[]): string[] =>
  nodes(menus)
    .filter((n) => "id" in n)
    .map((n) => (n as IdNode).id);
eq("有文档 / 没文档的项序一模一样", ids(spec({ hasDoc: false })), ids(spec({ hasDoc: true })));
eq(
  "栈深变化不改结构",
  ids(spec({ undoDepth: 0, redoDepth: 0 })),
  ids(spec({ undoDepth: 9, redoDepth: 9 }))
);
setShortcutOverrides({ save: "ctrl+shift+b" });
const withOverride = ids(spec());
setShortcutOverrides({});
eq("改键位不改结构", withOverride, ids(spec()));

// ---- id 唯一 + 非空文案
const all = ids(spec({ mac: true }));
eq("整棵树的 id 不重复", new Set(all).size, all.length);
ok(
  "每一条自定义项都有名字",
  nodes(spec({ mac: true })).every(
    (n) => n.kind === "sep" || n.kind === "pre" || n.text.trim().length > 0
  )
);

// ---- 浏览器模式：装不上，也不许抛
eq("浏览器模式 installAppMenu 回 false", await installAppMenu(() => {}, BASE), false);
syncAppMenu({ ...BASE, hasDoc: false });
ok("没装成菜单时 sync 只是空转", true);

done();
