/**
 * 外壳（Shell）：stores、六个投影、原生能力在这里拼成一个应用。
 *
 * 这一层只搬运，不判定：业务规则一律在 engine/ 与 utils/entitlement，文件与配置 IO 一律在
 * services/native。外壳里每个 if 关心的都只是"这一步用户能不能看见"。
 * 唯一的例外是"未保存就换文档"那道确认 —— 它同时需要脏标记和用户意志，只有外壳两个都有。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App as AntdApp, Button, Dropdown, Input, Modal, Segmented, Tabs, Tooltip } from "antd";
import type { MenuProps } from "antd";
import {
  AppErrorBoundary,
  AppShell,
  PanelErrorBoundary,
  ThemeProvider,
  ToolGroup,
  useTheme,
} from "./_shared/index.ts";
import { PROJECTION_VIEWS } from "./views/index.ts";
import { StartView } from "./views/StartView.tsx";
import { SearchPanel } from "./views/SearchPanel.tsx";
import { HistoryPanel } from "./views/HistoryPanel.tsx";
import { ExportDialog } from "./views/ExportDialog.tsx";
import { PrintDialog } from "./views/PrintDialog.tsx";
import { TopicInfoDialog } from "./views/TopicInfoDialog.tsx";
import { OptionsView } from "./views/OptionsView.tsx";
import { activeDoc, activePage, depthOf, dirtyOf, useDoc } from "./stores/docStore.ts";
import { countTopics } from "./engine/tree.ts";
import { PROJECTIONS, useUi, type Projection } from "./stores/uiStore.ts";
import { THEME_LABEL, THEME_ORDER, type ThemeMode } from "./model/constants.ts";
import { startRecentListeners, useRecent } from "./stores/recentStore.ts";
import { useSettings } from "./stores/settingsStore.ts";
import {
  registerShortcuts,
  setShortcutOverrides,
  shortcutLabel,
  useGlobalShortcuts,
  isMac,
  type ShortcutHandlers,
} from "./utils/shortcuts.ts";
import { canSave } from "./utils/entitlement.ts";
import { humanSize, timestampName } from "./utils/id.ts";
import { installAppMenu, syncAppMenu, type MenuState } from "./services/appMenu.ts";
import { autosaveNote, newestPendingAutosave, startAutosave } from "./services/autosave.ts";
import { installCrashWatch } from "./services/crash.ts";
import { runAiInsert } from "./services/ai.ts";
import {
  listen,
  native,
  pickOpenPath,
  pickSavePath,
  type AutosaveItem,
} from "./services/native.ts";
import { IMPORT_EXTENSIONS, importBytes, importFilter, sniff } from "./engine/import/index.ts";

/** 打开只收 .emmx，导入用 importFilter()：两条路径的报错文案不同，合成一个选择框就没法解释失败原因。 */
const EMMX_FILTER = [{ name: "亿图脑图文件", extensions: ["emmx"] }];

/** 菜单项 id 前缀 → 动作的分发靠这两个前缀，写在一处免得两边拼字符串拼歪。 */
const PROJ_ID = "view-proj-";
const THEME_ID = "theme-";

function stemOf(p: string): string {
  return (p.split(/[\\/]/).pop() ?? p).replace(/\.[^.]+$/, "") || p;
}

function clockOf(at: number): string {
  return at ? new Date(at).toLocaleString("zh-CN", { hour12: false }) : "未保存";
}

/** 未保存时"换一份文档"前的确认：三个按钮三种后果，不做"取消=丢弃"那种偷懒的映射。 */
interface PendingSwitch {
  label: string;
  run: () => void;
}

function Shell() {
  const { message } = AntdApp.useApp();
  const doc = useDoc((s) => activeDoc(s));
  const page = useDoc((s) => activePage(s));
  const title = useDoc((s) => s.title);
  const path = useDoc((s) => s.path);
  const savedAt = useDoc((s) => s.savedAt);
  const busy = useDoc((s) => s.busy);
  const warnings = useDoc((s) => s.warnings);
  const selection = useDoc((s) => s.selection);
  const activePageId = useDoc((s) => s.activePageId);
  const dirty = useDoc((s) => dirtyOf(s));
  // 选择器必须回原始值：depthOf 每次调用都 new 一个 {undo, redo}，
  // useSyncExternalStore 会把它当成"快照变了"，于是无限重渲染（zustand v5 的 getSnapshot 告警）。
  const undoDepth = useDoc((s) => depthOf(s).undo);
  const redoDepth = useDoc((s) => depthOf(s).redo);

  const projection = useUi((s) => s.projection);
  const setProjection = useUi((s) => s.setProjection);
  const startPage = useUi((s) => s.startPage);
  const setStartPage = useUi((s) => s.setStartPage);
  const dialog = useUi((s) => s.dialog);
  const openDialog = useUi((s) => s.openDialog);
  const closeDialog = useUi((s) => s.closeDialog);
  const zoom = useUi((s) => s.zoom);
  const stepZoom = useUi((s) => s.stepZoom);
  const fitZoom = useUi((s) => s.fitZoom);
  const sidebar = useUi((s) => s.sidebar);
  const toggleSidebar = useUi((s) => s.toggleSidebar);

  const { mode } = useTheme();
  const patchSettings = useSettings((s) => s.patch);

  const [pendingSwitch, setPendingSwitch] = useState<PendingSwitch | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [snapshot, setSnapshot] = useState<AutosaveItem | null>(null);

  const hasDoc = Boolean(doc && page);

  /* ---------------- 写盘 ---------------- */

  /** 唯一的保存出口：配额闸门（P-4）→ 缺路径就选 → saveAs。返回 false 表示什么都没写。 */
  const saveNow = useCallback(async (): Promise<boolean> => {
    const s = useDoc.getState();
    const current = activeDoc(s);
    if (!current) return false;
    const gate = canSave(current);
    if (!gate.ok) {
      message.warning(gate.reason);
      return false;
    }
    let target = s.path;
    if (!target) {
      target = await pickSavePath({
        title: "保存脑图",
        defaultPath: `${s.title}.emmx`,
        filters: EMMX_FILTER,
      });
      if (!target) return false;
      if (!/\.[^.]+$/.test(target)) target += ".emmx";
    }
    const ok = await s.saveAs(target);
    if (ok) message.success(`已保存：${useDoc.getState().path}`);
    else message.error(useDoc.getState().error ?? "保存失败");
    return ok;
  }, [message]);

  const saveTo = useCallback(
    async (target: string) => {
      const s = useDoc.getState();
      const current = activeDoc(s);
      if (!current) return;
      const gate = canSave(current);
      if (!gate.ok) {
        message.warning(gate.reason);
        return;
      }
      const ok = await s.saveAs(/\.[^.]+$/.test(target) ? target : `${target}.emmx`);
      if (ok) message.success(`已另存为：${useDoc.getState().path}`);
      else message.error(useDoc.getState().error ?? "另存为失败");
    },
    [message]
  );

  /* ---------------- 换文档 ---------------- */

  const guard = useCallback((label: string, run: () => void) => {
    const s = useDoc.getState();
    if (!s.hist || !dirtyOf(s)) {
      run();
      return;
    }
    setPendingSwitch({ label, run });
  }, []);

  const resolveSwitch = useCallback(
    async (how: "save" | "discard" | "cancel") => {
      const next = pendingSwitch;
      setPendingSwitch(null);
      if (!next || how === "cancel") return;
      if (how === "save" && !(await saveNow())) return;
      next.run();
    },
    [pendingSwitch, saveNow]
  );

  const show = useCallback(
    (ok: boolean) => {
      if (ok) setStartPage(false);
    },
    [setStartPage]
  );

  const doNew = useCallback(() => {
    guard("新建", () => {
      void useDoc
        .getState()
        .newDoc()
        .then(() => setStartPage(false));
    });
  }, [guard, setStartPage]);

  const openPicked = useCallback(
    (picked: string) => {
      guard("打开", () => {
        void useDoc
          .getState()
          .openPath(picked)
          .then((ok) => {
            show(ok);
            if (!ok) message.error(useDoc.getState().error ?? `打开失败：${picked}`);
          });
      });
    },
    [guard, message, show]
  );

  const doOpen = useCallback(async () => {
    // 先弹选择框再过脏检查：反过来会让用户在模态框背后挑完文件名，回来时选择框已经没了。
    const picked = await pickOpenPath({ title: "打开脑图文件", filters: EMMX_FILTER });
    if (picked) openPicked(picked);
  }, [openPicked]);

  /**
   * 关联打开：双击 .emmx 交给我们的路径由 Rust 那边排队（Windows/Linux 来自命令行，
   * macOS 来自 RunEvent::Opened），这里只负责把队列取空。
   *
   * 走 openPicked 而不是自己调 openPath，是为了让"手上还有没存的改动"那道确认跟手动「打开」
   * 一模一样 —— 同一件事不该有两个流程。
   * 一次取到多份时只开第一份并说清楚：一个窗口装不下一堆文档，假装都开了才是坑。
   */
  const openQueued = useCallback(async () => {
    const paths = await native.takeOpenPaths();
    if (!paths.length) return;
    openPicked(paths[0]);
    if (paths.length > 1) {
      message.warning(`收到 ${paths.length} 个文件，只打开了第 1 个：一个窗口只能放一份脑图。`);
    }
  }, [message, openPicked]);

  /**
   * 导入。格式分发只认 importBytes 这一处：这里再抄一份 switch，引擎加了格式界面却
   * 还在说"暂不支持"—— .xmind 就被这么埋过一回（解析器在 engine 里躺着，没人调用）。
   * .emmx 例外：它走「打开」那条路，要的是带路径的文档登记，不是"导入一份新内容"。
   */
  const doImport = useCallback(async () => {
    const picked = await pickOpenPath({ title: "导入", filters: importFilter() });
    if (!picked) return;
    const kind = sniff(picked);
    if (kind === "emmx") {
      openPicked(picked);
      return;
    }
    if (kind === "unknown") {
      message.error(
        `认不出这个格式：${stemOf(picked)}。可导入的是 ${IMPORT_EXTENSIONS.join("、")}。`
      );
      return;
    }
    guard("导入", () => {
      void (async () => {
        try {
          const bytes = await native.fileReadBytes(picked);
          const built = await importBytes(picked, bytes);
          const shapes = built.pages.reduce((n, p) => n + Object.keys(p.shapes).length, 0);
          if (!shapes) {
            message.error(
              "没有解析出任何主题：请确认文件是缩进文本 / Markdown / FreeMind / OPML / CSV / XMind 之一。"
            );
            return;
          }
          const pages = built.pages.length > 1 ? `、${built.pages.length} 页` : "";
          if (useDoc.getState().applyDoc(built, null, stemOf(picked))) {
            setStartPage(false);
            message.success(
              `已导入 ${shapes} 个主题${pages}（${kind}），还没有写进 .emmx，用「保存」落盘。`
            );
          }
        } catch (e) {
          message.error(e instanceof Error ? e.message : String(e));
        }
      })();
    });
  }, [guard, message, openPicked, setStartPage]);

  const doSaveAs = useCallback(async () => {
    const s = useDoc.getState();
    if (!s.hist) return;
    const target = await pickSavePath({
      title: "另存为",
      defaultPath: `${s.title}.emmx`,
      filters: EMMX_FILTER,
    });
    if (target) await saveTo(target);
  }, [saveTo]);

  const doAi = useCallback(async () => {
    const r = await runAiInsert("AI 生成主题");
    if (r.ok) message.success(r.message);
    else message.warning(r.message);
  }, [message]);

  /**
   * 菜单「退出」：先过一遍未保存检查再收进程。
   * 系统那边的 Quit / Alt+F4 不会问，所以这条必须是自己的命令 + native.exit()，
   * 而不是原生预定义项 —— 用户丢掉未保存的改动比多按一次确认更糟。
   */
  const doQuit = useCallback(() => {
    guard("退出", () => void native.exit());
  }, [guard]);

  /* ---------------- 启动：设置 / 列表 / 自动保存兜命 ---------------- */

  useEffect(() => {
    void useSettings.getState().load();
    void useRecent.getState().refreshAll();
  }, []);

  useEffect(() => startAutosave(), []);
  useEffect(() => startRecentListeners(), []);
  // 监听从一开始就挂着：崩溃可能发生在设置读回来之前，那一会儿由 Rust 侧的阈值决定写不写。
  useEffect(() => installCrashWatch(), []);

  /**
   * 关联打开的两个触发点：启动时取一次队列（双击新进程那条路），
   * 以及收到 open-path 信号时再取一次（macOS 复用同一进程那条路）。
   * 两条路共用同一次出队，所以谁先到都不影响"只开一遍"。
   *
   * assocDone 是"这一轮问过了"：恢复上次会话那段效果必须等它，
   * 否则双击 B 文件冷启动时，会先被"上次打开的 A"顶回来，把用户的明确意图藏掉。
   */
  const [assocDone, setAssocDone] = useState(false);
  useEffect(() => {
    let alive = true;
    let un: (() => void) | null = null;
    void openQueued().finally(() => {
      if (alive) setAssocDone(true);
    });
    void listen("open-path", () => void openQueued()).then((f) => {
      if (alive) un = f;
      else f();
    });
    return () => {
      alive = false;
      un?.();
    };
  }, [openQueued]);

  /** 启动时问一句"有没有没存下来的东西"；判定与格式化都在 services/autosave，这里只负责打断。 */
  useEffect(() => {
    let alive = true;
    void newestPendingAutosave().then((item) => {
      if (alive && item) setSnapshot(item);
    });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 启动时恢复上次会话：选项开着，冷启动就直接回到"上次打开的那一份"。
   *
   * 三条退让：崩溃快照的恢复询问优先（那是没存下来的东西，压着它开文件等于把改动藏起来）；
   * 已经有文档就不插手（用户可能是自己挑的文件）；整个进程只做一次，之后他回起始页是自愿的，
   * 不能每次回起始页都被一份"上次会话"顶回去。
   * 第四条：关联打开问过了再说（assocDone）—— 双击的是 B，就不能先把 A 顶上来。
   */
  const settingsLoaded = useSettings((s) => s.loaded);
  const recentItems = useRecent((s) => s.recent);
  const recentLoading = useRecent((s) => s.loading);
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current) return;
    const restore = useSettings.getState().settings.general.restoreLastSession;
    if (!settingsLoaded || !restore || recentLoading || snapshot || !assocDone) return;
    if (!useDoc.getState().hist) {
      const last = [...recentItems].sort((a, b) => b.openedAt - a.openedAt)[0];
      if (last) {
        autoOpened.current = true;
        openPicked(last.path);
        return;
      }
    }
    autoOpened.current = true;
  }, [settingsLoaded, recentLoading, recentItems, snapshot, assocDone, openPicked]);

  const restoreSnapshot = useCallback(async () => {
    const item = snapshot;
    setSnapshot(null);
    if (!item) return;
    const run = async () => {
      try {
        const bytes = await native.fileReadBytes(item.path);
        const ok = await useDoc
          .getState()
          .openBytes(bytes, null, `${stemOf(item.path)}（自动保存）`);
        if (ok) {
          setStartPage(false);
          message.success("已恢复自动保存快照；这些改动还没有落盘，请用「另存为」。");
        } else message.error(useDoc.getState().error ?? "快照读取失败");
      } catch (e) {
        message.error(e instanceof Error ? e.message : String(e));
      }
    };
    guard("恢复快照", () => void run());
  }, [guard, message, setStartPage, snapshot]);

  /* ---------------- 快捷键 / 关闭保护 ---------------- */

  // 注册表里放一个"永远指向最新闭包"的转发对象：命令实现每次渲染都是新函数，
  // 而注册只该发生一次 —— 这两件事由一个 ref 来调和。
  // 必须是"改同一个对象"（Object.assign），不能"换一个新对象"：注册进去的是引用本身，
  // 重新赋值会让注册表永远停在首屏那一份闭包 —— 那里 hasDoc 恒为 false，
  // 实测 Ctrl+E / Ctrl+P 按下去什么都不发生，而工具栏上的按钮明明是亮着的。
  const commands = useRef<ShortcutHandlers>({});
  Object.assign(commands.current, {
    newDoc: doNew,
    open: () => void doOpen(),
    save: () => void saveNow(),
    saveAs: () => void doSaveAs(),
    search: () => (dialog === "search" ? closeDialog() : openDialog("search")),
    undo: () => useDoc.getState().undoStep(),
    redo: () => useDoc.getState().redoStep(),
    export: () => {
      if (hasDoc) openDialog("export");
    },
    print: () => {
      if (hasDoc) openDialog("print");
    },
    options: () => openDialog("options"),
    // 浏览器模式没有"退进程"这件事可做（脚本关不掉标签页），所以这条只在桌面端注册：
    // 注册成 undefined 就是不注册，Ctrl+Q 照常落回网页，而不是弹一道点了没用的确认。
    quit: native.available ? doQuit : undefined,
    closeDialog,
  });
  useEffect(() => registerShortcuts(commands.current), []);
  useGlobalShortcuts();

  // 键位表要从配置里过一遍才生效：面板改的是 settings.shortcut.custom，监听器改不了自己的表。
  // 订阅这一节顺带让上面那些 shortcutLabel(...) 在改键后重算 —— 不然按钮的悬浮提示会一直
  // 显示老键位，而按下的是新键位。
  const shortcutCustom = useSettings((s) => s.settings.shortcut.custom);
  useEffect(() => {
    setShortcutOverrides(shortcutCustom);
  }, [shortcutCustom]);

  /* ---------------- 原生菜单栏 ---------------- */

  /**
   * 菜单项 → 命令的转发。和 commands 那份注册表同一个套路：菜单只装一次，
   * 而每个动作都得用当次渲染的闭包（hasDoc、dialog 这些都在变），所以用 ref 指过去。
   */
  const menuRun = useRef<(id: string) => void>(() => {});
  menuRun.current = (id: string) => {
    if (id.startsWith(PROJ_ID)) {
      if (hasDoc) setProjection(id.slice(PROJ_ID.length) as Projection);
      return;
    }
    if (id.startsWith(THEME_ID)) {
      void patchSettings("general", { theme: id.slice(THEME_ID.length) as ThemeMode });
      return;
    }
    switch (id) {
      case "file-new":
        doNew();
        return;
      case "file-open":
        void doOpen();
        return;
      case "file-import":
        void doImport();
        return;
      case "file-save":
        void saveNow();
        return;
      case "file-save-as":
        void doSaveAs();
        return;
      case "file-export":
        if (hasDoc) openDialog("export");
        return;
      case "file-print":
        if (hasDoc) openDialog("print");
        return;
      case "file-history":
        dialog === "history" ? closeDialog() : openDialog("history");
        return;
      case "file-quit":
        doQuit();
        return;
      case "edit-undo":
        useDoc.getState().undoStep();
        return;
      case "edit-redo":
        useDoc.getState().redoStep();
        return;
      case "edit-search":
        dialog === "search" ? closeDialog() : openDialog("search");
        return;
      case "view-sidebar":
        if (hasDoc) toggleSidebar();
        return;
      case "view-zoom-out":
        stepZoom(-1);
        return;
      case "view-zoom-in":
        stepZoom(1);
        return;
      case "view-zoom-fit":
        fitZoom();
        return;
      case "help-options":
        openDialog("options");
        return;
    }
  };

  // shortcutCustom 也在依赖里：键位一改，菜单文案里的 Ctrl+S 就得跟着改，
  // 而 menuState 里那几项没有一个会变。
  const menuState = useMemo<MenuState>(
    () => ({ mac: isMac(), hasDoc, undoDepth, redoDepth, projection, sidebar, theme: mode }),
    [hasDoc, undoDepth, redoDepth, projection, sidebar, mode, shortcutCustom]
  );
  // 菜单只装一次，但要拿到"此刻"的状态与"此刻"的动作，所以两处都走 ref。
  const menuStateRef = useRef(menuState);
  menuStateRef.current = menuState;

  const [nativeMenu, setNativeMenu] = useState(false);
  useEffect(() => {
    let alive = true;
    void installAppMenu((id) => menuRun.current(id), menuStateRef.current).then((ok) => {
      if (alive) setNativeMenu(ok);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    syncAppMenu(menuState);
  }, [menuState]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Chromium 要求赋值才认这条提示；自定义文案在桌面 WebView 里早就不显示了。
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  /* ---------------- 页签 / 侧栏 / 投影 ---------------- */

  const pages = doc?.pages ?? [];
  const tabItems = useMemo(
    () =>
      pages.map((p) => ({
        key: p.id,
        label: (
          <span onDoubleClick={() => setRenaming({ id: p.id, name: p.name })} title="双击重命名">
            {p.name}
          </span>
        ),
      })),
    [pages]
  );

  const aside =
    !sidebar || !page ? null : dialog === "search" ? (
      <SearchPanel page={page} />
    ) : dialog === "history" ? (
      <HistoryPanel page={page} />
    ) : null;
  const Projection = PROJECTION_VIEWS[projection];
  const label = PROJECTIONS.find((p) => p.id === projection)?.label ?? "思维导图";

  /* ---------------- 渲染 ---------------- */

  /* 工具栏按"手上有没有一份能改的文档"分两套。开始页摆一整排灰按钮，读起来像是这些
     功能坏了，而不是"这里还没打开文档"；有文档时把低频项收进「更多」。
     收进菜单只是换个地方点：每条命令的键盘入口一个都没动（见 utils/shortcuts）。
     装了系统菜单栏之后，低频项就交给它 —— 标题栏下面那排"文件 编辑 视图 帮助"才是用户
     找功能的地方，工具栏只留高频动作；此时不再渲染「⋯ 更多」，同一件事不该有两个入口。
     浏览器模式没有原生菜单，「更多」必须留着，否则另存为/导出/打印就只剩键盘入口。 */
  const atStart = !hasDoc || startPage;
  const cycleTheme = () =>
    void patchSettings("general", {
      theme: THEME_ORDER[(THEME_ORDER.indexOf(mode) + 1) % THEME_ORDER.length],
    });
  const menuItem = (text: string, cmd?: string) => (
    <span style={{ display: "flex", gap: 24, justifyContent: "space-between" }}>
      {text}
      {cmd ? <span style={{ color: "var(--zm-text-2)" }}>{shortcutLabel(cmd)}</span> : null}
    </span>
  );
  const moreItems: MenuProps["items"] = [
    { key: "saveAs", label: menuItem("另存为", "saveAs"), onClick: () => void doSaveAs() },
    { type: "divider" },
    {
      key: "search",
      label: menuItem("查找", "search"),
      onClick: () => (dialog === "search" ? closeDialog() : openDialog("search")),
    },
    {
      key: "history",
      label: menuItem("历史版本"),
      onClick: () => (dialog === "history" ? closeDialog() : openDialog("history")),
    },
    { type: "divider" },
    { key: "export", label: menuItem("导出", "export"), onClick: () => openDialog("export") },
    { key: "print", label: menuItem("打印", "print"), onClick: () => openDialog("print") },
    {
      key: "theme",
      label: `界面主题：${THEME_LABEL[mode]}（点击切换）`,
      onClick: cycleTheme,
    },
  ];
  const fileButtons = (
    <>
      <Button size="small" onClick={doNew} title={shortcutLabel("newDoc")}>
        新建
      </Button>
      <Button size="small" onClick={() => void doOpen()} title={shortcutLabel("open")}>
        打开
      </Button>
      <Tooltip
        title={`导入 XMind / FreeMind / OPML / Markdown / CSV / 缩进文本（${IMPORT_EXTENSIONS.join("、")}）`}
      >
        <Button size="small" onClick={() => void doImport()}>
          导入
        </Button>
      </Tooltip>
    </>
  );
  const optionsButton = (
    <Button size="small" onClick={() => openDialog("options")} title={shortcutLabel("options")}>
      选项
    </Button>
  );

  const toolbar = atStart ? (
    <>
      <ToolGroup>{fileButtons}</ToolGroup>
      {!nativeMenu && (
        <ToolGroup>
          {optionsButton}
          <Tooltip title={`界面主题：${THEME_LABEL[mode]}，点击切换下一个`}>
            <Button size="small" onClick={cycleTheme}>
              主题
            </Button>
          </Tooltip>
        </ToolGroup>
      )}
    </>
  ) : (
    <>
      <ToolGroup>
        {fileButtons}
        <Button size="small" onClick={() => void saveNow()} title={shortcutLabel("save")}>
          保存
        </Button>
      </ToolGroup>

      <ToolGroup>
        <Button
          size="small"
          disabled={!undoDepth}
          onClick={() => useDoc.getState().undoStep()}
          title={`${shortcutLabel("undo")}（还能撤 ${undoDepth} 步）`}
        >
          撤销
        </Button>
        <Button
          size="small"
          disabled={!redoDepth}
          onClick={() => useDoc.getState().redoStep()}
          title={`${shortcutLabel("redo")}（还能重做 ${redoDepth} 步）`}
        >
          重做
        </Button>
        <Button size="small" onClick={() => void doAi()}>
          AI 生成
        </Button>
      </ToolGroup>

      <ToolGroup>
        <Segmented
          size="small"
          value={projection}
          options={PROJECTIONS.map((p) => ({ label: p.label, value: p.id }))}
          onChange={(v) => setProjection(v as Projection)}
        />
        <Button size="small" onClick={() => stepZoom(-1)} title="缩小">
          －
        </Button>
        <Button size="small" onClick={() => fitZoom()} title="适应画布">
          {Math.round(zoom * 100)}%
        </Button>
        <Button size="small" onClick={() => stepZoom(1)} title="放大">
          ＋
        </Button>
      </ToolGroup>

      {!nativeMenu && (
        <ToolGroup>
          {optionsButton}
          <Button size="small" type={sidebar ? "primary" : "default"} onClick={toggleSidebar}>
            侧栏
          </Button>
          <Dropdown menu={{ items: moreItems }} trigger={["click"]} placement="bottomRight">
            <Button size="small" title="另存为 · 查找 · 历史版本 · 导出 · 打印 · 主题">
              ⋯ 更多
            </Button>
          </Dropdown>
        </ToolGroup>
      )}
    </>
  );

  const status = (
    <>
      <span>{label}</span>
      <span className="zm-path" title={path ?? "未保存的文档"}>
        {path ?? "未保存"}
      </span>
      <span>{dirty ? "有未保存的修改" : savedAt ? `已保存 ${clockOf(savedAt)}` : "尚未保存"}</span>
      {page && <span>{countTopics(page)} 个主题</span>}
      {page && selection.length > 1 && <span>选中 {selection.length} 个</span>}
      <span>{warnings.length ? `解析告警 ${warnings.length} 条` : "无解析告警"}</span>
      <span>
        撤销栈 {undoDepth}/{undoDepth + redoDepth}
      </span>
      <span className="zm-bar-spacer" />
      <span>
        {busy ? "处理中…" : native.available ? "桌面模式" : "浏览器模式（文件与备份受限）"}
      </span>
    </>
  );

  return (
    <>
      <AppShell
        title={title}
        dirty={dirty}
        toolbar={toolbar}
        tabs={
          hasDoc ? (
            <Tabs
              size="small"
              type="editable-card"
              activeKey={activePageId}
              items={tabItems}
              onChange={(id) => useDoc.getState().switchPage(id)}
              onEdit={(target, action) => {
                if (action === "add") {
                  useDoc.getState().addPage();
                  return;
                }
                if (typeof target !== "string") return;
                if (!useDoc.getState().removePage(target))
                  message.warning("至少需要保留一张画布。");
              }}
              tabBarExtraContent={
                <Button size="small" type="text" onClick={() => setStartPage(true)}>
                  开始页
                </Button>
              }
            />
          ) : null
        }
        status={status}
        aside={aside ? <PanelErrorBoundary label="侧栏面板">{aside}</PanelErrorBoundary> : null}
      >
        {!doc || !page || startPage ? (
          <StartView onNew={doNew} onOpen={openPicked} onImport={() => void doImport()} />
        ) : (
          <PanelErrorBoundary label={`投影「${label}」`} resetKey={projection}>
            <Projection page={page} />
          </PanelErrorBoundary>
        )}
      </AppShell>

      <ExportDialog open={dialog === "export"} onClose={closeDialog} />
      <PrintDialog open={dialog === "print"} onClose={closeDialog} />
      <OptionsView open={dialog === "options"} onClose={closeDialog} />
      <TopicInfoDialog page={page} onClose={closeDialog} />

      <Modal
        open={Boolean(pendingSwitch)}
        title={pendingSwitch ? `${pendingSwitch.label}：当前文档有未保存的修改` : ""}
        onCancel={() => setPendingSwitch(null)}
        mask={{ closable: false }}
        keyboard={false}
        footer={[
          <Button key="cancel" onClick={() => void resolveSwitch("cancel")}>
            取消
          </Button>,
          <Button key="discard" danger onClick={() => void resolveSwitch("discard")}>
            不保存
          </Button>,
          <Button key="save" type="primary" onClick={() => void resolveSwitch("save")}>
            保存并继续
          </Button>,
        ]}
      >
        <p>「{title}」里有还没写进文件的改动。</p>
        <p>
          保存并继续：先写盘再换文档；不保存：丢掉这些改动（自动保存快照仍留在备份中心）；取消：留在当前文档。
        </p>
      </Modal>

      <Modal
        open={Boolean(renaming)}
        title="重命名画布"
        okText="重命名"
        onCancel={() => setRenaming(null)}
        onOk={() => {
          if (renaming?.name.trim())
            useDoc.getState().renamePage(renaming.id, renaming.name.trim());
          setRenaming(null);
        }}
      >
        <Input
          value={renaming?.name ?? ""}
          onChange={(e) => setRenaming((r) => (r ? { ...r, name: e.target.value } : r))}
          onPressEnter={() => {
            if (renaming?.name.trim())
              useDoc.getState().renamePage(renaming.id, renaming.name.trim());
            setRenaming(null);
          }}
          placeholder="画布名称"
        />
      </Modal>

      <Modal
        open={Boolean(snapshot)}
        title="发现未保存的自动保存快照"
        okText="恢复"
        cancelText="忽略"
        onCancel={() => setSnapshot(null)}
        onOk={() => void restoreSnapshot()}
      >
        <p>{snapshot ? autosaveNote(snapshot) : ""}</p>
        <p>
          {snapshot
            ? `位置：${snapshot.path} · ${humanSize(snapshot.size)} · ${timestampName(new Date(snapshot.modifiedAt))}`
            : ""}
        </p>
        <p>恢复后这些改动算"还没落盘"，请用「另存为」写成文件。</p>
      </Modal>
    </>
  );
}

/**
 * 根组件：provider 栈 + 壳子。
 *
 * 顺序是有讲究的：AppErrorBoundary 在最外层，否则投影崩了连"出错了"都渲染不出来；
 * ThemeProvider 在 antd 的 App 之外，因为 App 要用 ConfigProvider 的 token 才能把
 * message 的气泡渲染成当前主题；壳子在最内层，它才是碰业务 store 的那个人。
 */
export default function App() {
  return (
    <AppErrorBoundary>
      <ThemeProvider>
        <AntdApp>
          <Shell />
        </AntdApp>
      </ThemeProvider>
    </AppErrorBoundary>
  );
}
