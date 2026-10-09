/**
 * 原生应用菜单栏（§3.1「键盘是第一公民」的另一半：菜单也得是系统的那一份）。
 *
 * 为什么用 Tauri 的菜单 API，而不是在窗口里画一条 HTML 菜单栏：mac 的菜单条在屏幕顶部、
 * 第一项必须是应用菜单，Windows 的落在标题栏下方 —— 同一份声明在两边各得其所；
 * HTML 菜单栏在 mac 上永远进不了系统菜单条，也就永远不符合 mac 的习惯。
 *
 * 为什么自定义项一律不带 accelerator（键位只写进文案）：键位在 utils/shortcuts 里是
 * **可自定义、可禁用、会查冲突**的，而 Windows 的原生菜单会把 accelerator 注册进加速键表
 * （tauri 在消息循环里 TranslateAcceleratorW），抢在网页收到按键之前吃掉它 ——
 * 用户改了键位，菜单上还是老键；更糟的是 Ctrl+A 会被菜单截走，画布的「全选主题」就此失灵。
 * 所以这里只把当前键位显示出来，按下去仍然走同一套 JS 派发。
 *
 * 同理不放 PredefinedMenuItem 的 Undo/Redo/Cut/Copy/Paste/SelectAll：它们自带
 * Ctrl+Z / Ctrl+C / Ctrl+A 这类加速键（muda 的预定义项会注册进同一张表），
 * 而撤销重做属于文档历史、全选属于画布，都轮不到系统去处理。
 * 预定义项只留 About 和 mac 应用菜单里的 Services / Hide 系列。
 *
 * 「退出」也不用预定义项：Windows 那边它直接 PostQuitMessage(0)，进程走了，未保存的改动
 * 也跟着走，而应用里每一条"换一份文档"的路都要先过那道确认。所以退出是一条普通命令
 * （quit，mac 上就是 ⌘Q），动作里先 guard 再 native.exit()。
 */
import type { CheckMenuItem, Menu, MenuOptions, MenuItem, Submenu } from "@tauri-apps/api/menu";
import { THEME_LABEL, THEME_ORDER, type ThemeMode } from "../model/constants.ts";
import { PROJECTIONS, type Projection } from "../stores/uiStore.ts";
import { native } from "./native.ts";
import { shortcutLabel, type ShortcutCommand } from "../utils/shortcuts.ts";

/** mac 的应用菜单第一项：系统会用自己的显示名渲染，这里只为让 spec 完整可测。 */
const APP_MENU_TITLE = "z-biz-tool-mind";

export interface MenuState {
  mac: boolean;
  hasDoc: boolean;
  undoDepth: number;
  redoDepth: number;
  projection: Projection;
  sidebar: boolean;
  theme: ThemeMode;
}

/** 交给系统的预定义项（没有 Quit：见上面那段注释）。 */
export type Predefined = "Services" | "Hide" | "HideOthers" | "ShowAll" | "About";

export type SpecLeaf =
  | { kind: "item"; id: string; text: string; enabled: boolean }
  | { kind: "check"; id: string; text: string; enabled: boolean; checked: boolean }
  | { kind: "pre"; pre: Predefined; text?: string }
  | { kind: "sep" }
  | { kind: "sub"; id: string; text: string; children: SpecLeaf[] };

export interface SpecMenu {
  id: string;
  text: string;
  children: SpecLeaf[];
}

const sep: SpecLeaf = { kind: "sep" };
const item = (id: string, text: string, enabled = true): SpecLeaf => ({
  kind: "item",
  id,
  text,
  enabled,
});
const check = (id: string, text: string, checked: boolean, enabled = true): SpecLeaf => ({
  kind: "check",
  id,
  text,
  checked,
  enabled,
});
const pre = (p: Predefined, text?: string): SpecLeaf => ({ kind: "pre", pre: p, text });
const sub = (id: string, text: string, children: SpecLeaf[]): SpecLeaf => ({
  kind: "sub",
  id,
  text,
  children,
});

/**
 * 纯函数：状态 → 菜单树。拆出来是为了能在 node 里断言两套平台的布局，
 * 而不必真的起一个窗口。结构只随 `mac` 变（进程内不变），其余状态一律走
 * enabled / checked / text，这样 syncAppMenu 只需要改属性、不需要重排菜单。
 */
export function menuSpec(state: MenuState): SpecMenu[] {
  const { mac, hasDoc, undoDepth, redoDepth, projection, sidebar, theme } = state;
  // Windows 的菜单标签里 \t 之后的部分会右对齐成快捷键列；mac 的标题没有这个约定，用空格。
  const chord = (text: string, cmd: ShortcutCommand): string =>
    `${text}${mac ? "  " : "\t"}${shortcutLabel(cmd, mac)}`;
  // 「退出」做成普通命令而不是预定义项：预定义项直接把进程收掉，未保存的改动跟着没，
  // 而这里每一条"换一份文档"的路都要先过那道确认（动作在 App.tsx 的 doQuit）。
  const quit = item("file-quit", chord(mac ? `退出 ${APP_MENU_TITLE}` : "退出", "quit"));

  const file: SpecLeaf[] = [
    item("file-new", chord("新建", "newDoc")),
    item("file-open", chord("打开 .emmx…", "open")),
    item("file-import", "导入…"),
    sep,
    item("file-save", chord("保存", "save"), hasDoc),
    item("file-save-as", chord("另存为…", "saveAs"), hasDoc),
    sep,
    item("file-export", chord("导出…", "export"), hasDoc),
    item("file-print", chord("打印…", "print"), hasDoc),
    sep,
    item("file-history", "历史版本与回收站", hasDoc),
  ];
  // mac 的「退出」按惯例在应用菜单里，文件菜单再加一条就是重复；Windows 没有应用菜单，只能放这儿。
  if (!mac) file.push(sep, quit);

  const edit: SpecLeaf[] = [
    item("edit-undo", chord("撤销", "undo"), hasDoc && undoDepth > 0),
    item("edit-redo", chord("重做", "redo"), hasDoc && redoDepth > 0),
    sep,
    item("edit-search", chord("查找与替换…", "search"), hasDoc),
  ];

  const view: SpecLeaf[] = [
    ...PROJECTIONS.map((p) => check(`view-proj-${p.id}`, p.label, projection === p.id, hasDoc)),
    sep,
    check("view-sidebar", "侧栏", sidebar, hasDoc),
    sep,
    item("view-zoom-out", "缩小", hasDoc),
    item("view-zoom-in", "放大", hasDoc),
    item("view-zoom-fit", "适应画布", hasDoc),
    sep,
    item("view-themes", chord("主题风格…", "themes")),
    sub(
      "view-theme",
      "界面主题",
      THEME_ORDER.map((t) => check(`theme-${t}`, THEME_LABEL[t], theme === t))
    ),
  ];

  const help: SpecLeaf[] = [item("help-options", chord("选项与快捷键…", "options"))];
  if (!mac) help.push(sep, pre("About", "关于"));

  const menus: SpecMenu[] = [];
  if (mac) {
    menus.push({
      id: "app",
      text: APP_MENU_TITLE,
      children: [
        pre("About", `关于 ${APP_MENU_TITLE}`),
        sep,
        pre("Services", "服务"),
        sep,
        pre("Hide", "隐藏"),
        pre("HideOthers", "隐藏其它"),
        pre("ShowAll", "显示全部"),
        sep,
        quit,
      ],
    });
  }
  // Windows 的菜单栏认 & 助记键（Alt+F 直接展开「文件」），中文软件的写法是把字母括在末尾；
  // mac 的菜单栏标题没有这套约定，多出来的 (&X) 会原样印在屏幕上。
  const bar = (label: string, key: string): string => (mac ? label : `${label}(&${key})`);
  menus.push(
    { id: "file", text: bar("文件", "F"), children: file },
    { id: "edit", text: bar("编辑", "E"), children: edit },
    { id: "view", text: bar("视图", "V"), children: view },
    { id: "help", text: bar("帮助", "H"), children: help }
  );
  return menus;
}

/** 原生菜单项类型太宽，直接用官方选项类型里的那个联合。 */
type NativeItem = NonNullable<MenuOptions["items"]>[number];

type Tracked = {
  item: MenuItem | CheckMenuItem;
  text: string;
  enabled: boolean;
  checked?: boolean;
};

/**
 * id → 正在用的那一项的句柄与上一次应用的值。
 * 菜单活在 Rust 那边，前端只拿得到 rid；每次状态变动都靠这张表判断"哪几项真的变了"，
 * 免得一个无关的渲染就发几十个 IPC。
 */
const tracked = new Map<string, Tracked>();
let appMenu: Menu | null = null;
let installing: Promise<boolean> | null = null;
let syncChain: Promise<void> = Promise.resolve();

type MenuApi = typeof import("@tauri-apps/api/menu");

async function buildOne(
  leaf: SpecLeaf,
  api: MenuApi,
  onAction: (id: string) => void
): Promise<NativeItem> {
  switch (leaf.kind) {
    case "sep":
      return await api.PredefinedMenuItem.new({ item: "Separator" });
    case "pre":
      return await api.PredefinedMenuItem.new({
        item: leaf.pre === "About" ? { About: null } : leaf.pre,
        text: leaf.text,
      });
    case "item": {
      const created = await api.MenuItem.new({
        id: leaf.id,
        text: leaf.text,
        enabled: leaf.enabled,
        action: onAction,
      });
      tracked.set(leaf.id, { item: created, text: leaf.text, enabled: leaf.enabled });
      return created;
    }
    case "check": {
      const created = await api.CheckMenuItem.new({
        id: leaf.id,
        text: leaf.text,
        enabled: leaf.enabled,
        checked: leaf.checked,
        action: onAction,
      });
      tracked.set(leaf.id, {
        item: created,
        text: leaf.text,
        enabled: leaf.enabled,
        checked: leaf.checked,
      });
      return created;
    }
    case "sub":
      return await api.Submenu.new({
        id: leaf.id,
        text: leaf.text,
        items: await Promise.all(leaf.children.map((c) => buildOne(c, api, onAction))),
      });
  }
}

async function doInstall(onAction: (id: string) => void, state: MenuState): Promise<boolean> {
  const api = await import("@tauri-apps/api/menu");
  const specs = menuSpec(state);
  const submenus: Submenu[] = [];
  for (const m of specs) {
    submenus.push(
      await api.Submenu.new({
        id: `menu-${m.id}`,
        text: m.text,
        items: await Promise.all(m.children.map((c) => buildOne(c, api, onAction))),
      })
    );
  }
  const menu = await api.Menu.new({ items: submenus });
  await menu.setAsAppMenu();
  appMenu = menu;
  return true;
}

/**
 * 装上原生菜单栏；浏览器模式（没有 IPC）或任何一步失败都返回 false，
 * 调用方据此决定要不要继续显示工具栏上那个「⋯ 更多」下拉 —— 菜单没了，入口也不能跟着没。
 *
 * 失败之后不重试：返回 false 已经让界面退回原样，反复撞同一个坏掉的菜单只会刷日志。
 */
export function installAppMenu(onAction: (id: string) => void, state: MenuState): Promise<boolean> {
  if (!native.available) return Promise.resolve(false);
  // StrictMode 下 effects 会双跑，而这里是异步的：第二次必须等同一次的结果，
  // 否则会建两份菜单、setAsAppMenu 两次，前一份 rid 泄漏在 Rust 那边。
  if (!installing) {
    installing = doInstall(onAction, state).catch((e: unknown) => {
      console.warn("原生菜单栏装配失败，界面退回工具栏「更多」：", e);
      return false;
    });
  }
  return installing;
}

async function applyState(state: MenuState): Promise<void> {
  const jobs: Promise<void>[] = [];
  const walk = (leaves: SpecLeaf[]): void => {
    for (const leaf of leaves) {
      if (leaf.kind === "sub") {
        walk(leaf.children);
        continue;
      }
      if (leaf.kind !== "item" && leaf.kind !== "check") continue;
      const prev = tracked.get(leaf.id);
      if (!prev) continue;
      if (prev.text !== leaf.text) {
        prev.text = leaf.text;
        jobs.push(prev.item.setText(leaf.text));
      }
      if (prev.enabled !== leaf.enabled) {
        prev.enabled = leaf.enabled;
        jobs.push(prev.item.setEnabled(leaf.enabled));
      }
      if (leaf.kind === "check" && prev.checked !== leaf.checked) {
        prev.checked = leaf.checked;
        jobs.push((prev.item as CheckMenuItem).setChecked(leaf.checked));
      }
    }
  };
  walk(menuSpec(state).flatMap((m) => m.children));
  await Promise.all(jobs);
}

/**
 * 把最新状态推进菜单：只改文案 / 可用 / 勾选，不重建结构。
 * 排队而不是并发：两次 sync 交叉写同一项时，后一次的期望值可能先落地。
 */
export function syncAppMenu(state: MenuState): void {
  if (!appMenu) return;
  syncChain = syncChain.then(() => applyState(state)).catch(() => {});
}
