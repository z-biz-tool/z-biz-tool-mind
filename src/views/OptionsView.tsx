/**
 * 选项面板（亿图 F1 那一份"选项"对话框，分页一节对上一份配置，Settings 里有几节就有几个分页）。
 *
 * 没有草稿态，也没有"确定"按钮：每个控件读 useSettings().settings、写 patch(section, partial)，
 * 改一下就落盘。亿图自己是改完即生效的，做成"草稿 + 确定"就多出一套状态同步 ——
 * 而界面已经按这些值实时渲染了（主题走 ThemeContext），用户看到"变了"却还没点确定，
 * 此时关掉窗口要回滚还是留下？回滚就得再抄一份快照，留下就是 bug。
 *
 * 数字一律夹紧后再写：Settings 里只有"我们保证存在的键"，缺的由 Rust 的 merge_defaults 补，
 * 上限则是配额（QUOTA）。超上限写进去会让 config.json 和实际行为不一致 —— 那是最难复现的一类不一致。
 */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Switch,
  Tabs,
  Tag,
  Tooltip,
} from "antd";
import { LoadingState } from "../_shared/index.ts";
import { MENU_ACTION_GROUPS, MENU_PRESETS, keepActions } from "../canvas/menuActions.ts";
import { LAYOUT_LABELS, QUOTA } from "../model/constants.ts";
import { native } from "../services/native.ts";
import {
  exportProfile,
  importKeymapProfile,
  importMenuProfile,
  keymapProfileXml,
  menuProfileXml,
} from "../services/profileIO.ts";
import type { AppInfo, CrashInfo, LogInfo, ProxyStatus } from "../services/native.ts";
import { useRecent } from "../stores/recentStore.ts";
import { useSettings } from "../stores/settingsStore.ts";
import type { Settings } from "../stores/settingsStore.ts";
import {
  SHORTCUT_COMMANDS,
  aliasChords,
  chordFromEvent,
  chordLabel,
  commandOfChord,
  defaultChordOf,
} from "../utils/shortcuts.ts";
import type { ShortcutCommand } from "../utils/shortcuts.ts";

/** 密钥在加密库里的条目名：只在这一个文件出现，改它等于换一份用户凭据，别散落。 */
const AI_KEY_NAME = "ai-api-key";

type SectionKey =
  | "general"
  | "format"
  | "save"
  | "network"
  | "shortcut"
  | "advanced"
  | "rightMenu"
  | "recent"
  | "quota";

interface OptionsViewProps {
  open: boolean;
  onClose: () => void;
}

/** 整数输入的落盘口径：清空（null / 空串 / NaN）退回下限，越界夹到区间内。 */
function toInt(raw: number | string | null, min: number, max: number): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 写盘失败的那句实话：配置没落下去，重启就回到原样（与 bindShortcut 同一口径）。 */
const WRITE_FAILED = "这一节没写进配置文件，重启就会回到原样：原因见面板顶部的错误。";

/** 方案文件的回执。tone 决定颜色：灰着的失败看起来就像成功了。 */
interface ProfileTip {
  tone: "ok" | "bad";
  text: string;
}

const okTip = (text: string): ProfileTip => ({ tone: "ok", text });

/** 加载回执：先说成了什么，再逐条说跳过了什么 —— 只报数字的话，用户不知道自己少了哪一条。 */
function receipt(okText: string, skipped: string[]): string {
  return skipped.length ? `${okText}跳过了 ${skipped.length} 条：${skipped.join("；")}` : okText;
}

/** 一行的骨架：标签、控件、控件下面那行小字说明（说明摊开写，不当 tooltip 的第二层菜单）。 */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "7px 0" }}>
      <span
        style={{ width: 132, flexShrink: 0, textAlign: "right", fontSize: 13, lineHeight: "26px" }}
      >
        {label}
      </span>
      <div style={{ minWidth: 0 }}>
        {children}
        {hint ? (
          <div style={{ fontSize: 12, color: "var(--zm-text-2)", marginTop: 4, lineHeight: 1.5 }}>
            {hint}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 配额表：文案直接引实测提示原文的语气，用户在哪里被挡住，就该在哪里看到同一条规则。 */
const QUOTA_ROWS: { label: string; value: string }[] = [
  { label: "免费版可保存的文件数", value: `${QUOTA.freeMaxFiles} 个` },
  { label: "AI 每点可生成的字数", value: `约 ${QUOTA.aiCharsPerPoint} 个汉字` },
  { label: "智能解析字数区间", value: `${QUOTA.parseWordMin} – ${QUOTA.parseWordMax} 字` },
  { label: "社区发布标题上限", value: `${QUOTA.publishTitleMax} 字` },
  { label: "社区发布描述上限", value: `${QUOTA.publishDescMax} 字` },
  { label: "撤销栈深度", value: `${QUOTA.undoMax} 步` },
  { label: "历史版本份数", value: `${QUOTA.historyMax} 份` },
  { label: "最近文件条数", value: `${QUOTA.recentMax} 条` },
  { label: "回收站保留", value: `${QUOTA.trashKeepDays} 天` },
];

/** 日志目录里留几天的文件。数值与 Rust log.rs 的 KEEP_FILES 同源，改一处要改两处。 */
const LOG_KEEP = 14;
/** 崩溃记录一份一个文件，只留最新这么多份。与 Rust crash.rs 的 KEEP_FILES 同源。 */
const CRASH_KEEP = 20;

/** 目录来自 canvas/menuActions.ts：面板上画的格子必须和菜单里 push 的键是同一份。 */
const ALL_MENU_KEYS = MENU_ACTION_GROUPS.map((g) => g.k);

export function OptionsView({ open, onClose }: OptionsViewProps) {
  const settings = useSettings((s) => s.settings);
  const loaded = useSettings((s) => s.loaded);
  const saving = useSettings((s) => s.saving);
  const storeError = useSettings((s) => s.error);
  const load = useSettings((s) => s.load);
  const patch = useSettings((s) => s.patch);
  const resetSection = useSettings((s) => s.resetSection);
  const clearRecent = useRecent((s) => s.clearRecent);

  // API Key 是唯一不能进 settings 的输入：它只活在下面这份临时态里，按"保存密钥"才进本机加密库。
  const [apiKey, setApiKey] = useState("");
  const [secretTip, setSecretTip] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [info, setInfo] = useState<AppInfo | null>(null);
  // 日志与代理的"实际状态"而不是设置值：这两项都可能因为平台原因不生效，界面要说真话。
  const [logs, setLogs] = useState<LogInfo | null>(null);
  const [proxy, setProxy] = useState<ProxyStatus | null>(null);
  const [logTip, setLogTip] = useState<string | null>(null);
  // 崩溃记录同理：开关说了不算，Rust 里那份阈值说了才算；份数也只有它知道。
  const [crash, setCrash] = useState<CrashInfo | null>(null);
  const [crashTip, setCrashTip] = useState<string | null>(null);
  // 快捷键面板正在录哪一条（null = 没在录），以及那句"这条键已经归谁"的话。
  const [recording, setRecording] = useState<ShortcutCommand | null>(null);
  const [shortcutTip, setShortcutTip] = useState<string | null>(null);
  // 方案文件的回执分两页各留一份：Tabs 访问过的分页仍然挂在那里，共用一条消息会同时出现在两页上。
  const [menuProfileTip, setMenuProfileTip] = useState<ProfileTip | null>(null);
  const [keyProfileTip, setKeyProfileTip] = useState<ProfileTip | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);

  useEffect(() => {
    // 这些读的是外壳里的**现状**，不是设置值：日志份数、崩溃份数、加密库里有没有密钥，
    // 都会在面板关着的这段时间里变。所以每次开框都重新问一遍，别拿首次挂载那份旧数说话。
    // 开框先探一次"加密库里到底有没有"：secretReveal 会把明文读进输入框，
    // 而用户多数只想知道自己配没配过 —— 不该为了看一个布尔值就看到密钥本身。
    void native
      .secretExists(AI_KEY_NAME)
      .then(setHasKey)
      .catch(() => undefined);
    void native
      .appInfo()
      .then(setInfo)
      .catch(() => undefined);
    void native
      .logInfo()
      .then(setLogs)
      .catch(() => undefined);
    void native
      .crashInfo()
      .then(setCrash)
      .catch(() => undefined);
    void native
      .proxyStatus()
      .then(setProxy)
      .catch(() => undefined);
  }, [open]);

  useEffect(() => {
    // 对话框可能被任何视图打开（工具栏、错误面板、F1），不保证有人替我们 load() 过。
    if (!useSettings.getState().loaded) void load();
  }, [load]);

  async function saveKey() {
    const v = apiKey.trim();
    if (!v) {
      setSecretTip("密钥是空值，没有写入加密库。");
      return;
    }
    try {
      await native.secretStore(AI_KEY_NAME, v);
      setHasKey(true);
      setSecretTip("已写入本机加密库。");
    } catch (e) {
      setSecretTip(e instanceof Error ? e.message : String(e));
    }
  }

  async function loadKey() {
    try {
      const v = await native.secretReveal(AI_KEY_NAME);
      setApiKey(v ?? "");
      setHasKey(!!v);
      setSecretTip(v ? "已从本机加密库载入。" : "这台机器上没有存过密钥。");
    } catch (e) {
      setSecretTip(e instanceof Error ? e.message : String(e));
    }
  }

  async function dropKey() {
    try {
      await native.secretDrop(AI_KEY_NAME);
      setApiKey("");
      setHasKey(false);
      setSecretTip("已从本机加密库删除。");
    } catch (e) {
      setSecretTip(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * 日志级别改完就到 Rust 里生效（不用重启），所以这里立刻回读一次真实阈值：
   * 万一写盘失败，界面显示的是磁盘上的那一档，而不是我以为的那一档。
   */
  async function changeLogLevel(v: string) {
    await patch("advanced", { logLevel: v });
    try {
      const applied = await native.logSetLevel(v);
      setLogs(await native.logInfo());
      setLogTip(null);
      if (applied !== v) await patch("advanced", { logLevel: applied });
    } catch (e) {
      setLogTip(e instanceof Error ? e.message : String(e));
    }
  }

  async function openLogDir() {
    try {
      await native.logOpenDir();
      setLogTip(null);
    } catch (e) {
      setLogTip(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * 崩溃开关也走"改完回读"：真正决定下一次写不写的是 Rust 里那份阈值，
   * 面板显示的 enabled 是从它那儿问回来的，不是我以为存进去的那个布尔。
   */
  async function changeCrashReport(v: boolean) {
    await patch("advanced", { crashReport: v });
    try {
      setCrash(await native.crashInfo());
      setCrashTip(null);
    } catch (e) {
      setCrashTip(e instanceof Error ? e.message : String(e));
    }
  }

  async function openCrashDir() {
    try {
      await native.crashOpenDir();
      setCrashTip(null);
    } catch (e) {
      setCrashTip(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * 网络一节改完都回读一次真实状态。
   *
   * 代理是否成立由三项共同决定（档位 + 地址 + 端口），只监听档位那一个控件的话，
   * 用户把地址填完、界面还停在"地址还没填"那句旧话上 —— 说明文字就成了假的。
   */
  async function patchNetwork(value: Partial<Settings["network"]>) {
    await patch("network", value);
    try {
      setProxy(await native.proxyStatus());
    } catch {
      setProxy(null);
    }
  }

  /**
   * 离开手动档就把地址与端口一起清掉，两个平台都要这样。
   *
   * 桌面端 Rust 在落盘前会做这件事（net::sanitize）并把它写回的那一节回报给界面，
   * 浏览器模式没有 Rust 那一层：不在这里清，"切到别的档就把这两格清空"这句提示就是假的。
   */
  async function changeProxyMode(v: string) {
    await patchNetwork(
      v === "manual" ? { proxyMode: v } : { proxyMode: v, proxyHost: "", proxyPort: 0 }
    );
  }

  /**
   * 落一次键位改动：chord 传 null 恢复默认，传 "" 禁用这条命令。
   *
   * 冲突判 commandOfChord 而不是只翻 custom 表：没写进配置的默认键（Ctrl+F 这种）一样占着位置，
   * 只比配置就会让两条命令撞上同一个键，而监听器只认表里先建的那一条 —— 到时用户看到的是
   * "我明明把搜索改走了，Ctrl+F 却还在开搜索"。
   */
  async function bindShortcut(cmd: ShortcutCommand, chord: string | null) {
    const next = { ...settings.shortcut.custom };
    if (chord === null) delete next[cmd];
    else next[cmd] = chord;
    const applied = await patch("shortcut", { custom: next });
    setShortcutTip(
      applied ? null : "这一条没写进配置文件，重启就会回到原样：原因见面板顶部的错误。"
    );
  }

  function rebindShortcut(cmd: ShortcutCommand, chord: string) {
    const owner = commandOfChord(chord);
    if (owner && owner !== cmd) {
      const label = SHORTCUT_COMMANDS.find((c) => c.cmd === owner)?.label ?? owner;
      setShortcutTip(`这个键位当前是「${label}」的。先去那一行把它改走或禁掉，再回来按这条。`);
      return;
    }
    // 键位换回默认值就当没改过：把 "ctrl+s" 这种值留在配置里，以后默认表动一次，
    // 这一行就会莫名其妙地"被用户改过"，恢复默认也恢复不到新默认上。
    void bindShortcut(cmd, chord === defaultChordOf(cmd) ? null : chord);
    setRecording(null);
  }

  /**
   * 方案文件的四条路（两页 × 导出/加载）形状一样，所以走同一个壳：一次只让一个在跑，
   * 取消和失败都在按钮下面说一句，不另开弹窗 —— 这一页本来就是改完即落盘，叠窗只会多一套状态。
   */
  async function runProfile(say: (tip: ProfileTip) => void, fn: () => Promise<ProfileTip>) {
    if (profileBusy) return;
    setProfileBusy(true);
    try {
      say(await fn());
    } catch (e) {
      say({ tone: "bad", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setProfileBusy(false);
    }
  }

  const exportMenuProfile = () =>
    runProfile(setMenuProfileTip, async () => {
      const target = await exportProfile("rightMenu", menuProfileXml(settings.rightMenu.enabled));
      return okTip(target ? `已导出到 ${target}` : "已取消导出。");
    });

  const loadMenuProfile = () =>
    runProfile(setMenuProfileTip, async () => {
      const got = await importMenuProfile();
      if (!got) return okTip("已取消加载。");
      const applied = await patch("rightMenu", { enabled: got.profile.enabled });
      if (!applied) return { tone: "bad", text: WRITE_FAILED };
      return okTip(
        receipt(
          `已加载：菜单里给 ${
            got.profile.enabled.length
              ? `${got.profile.enabled.length} 个动作`
              : "全部 12 个动作（这份文件写的是整套显示）"
          }。`,
          got.profile.skipped
        )
      );
    });

  const exportKeymapProfile = () =>
    runProfile(setKeyProfileTip, async () => {
      const target = await exportProfile("shortcut", keymapProfileXml(settings.shortcut.custom));
      return okTip(target ? `已导出到 ${target}` : "已取消导出。");
    });

  const loadKeymapProfile = () =>
    runProfile(setKeyProfileTip, async () => {
      const got = await importKeymapProfile();
      if (!got) return okTip("已取消加载。");
      const { custom, skipped } = got.profile;
      const applied = await patch("shortcut", { custom });
      if (!applied) return { tone: "bad", text: WRITE_FAILED };
      const off = Object.values(custom).filter((v) => !v).length;
      return okTip(
        receipt(
          `已按这份方案换掉整套键位：改走 ${Object.keys(custom).length - off} 条、禁用 ${off} 条，其余一律回到默认。`,
          skipped
        )
      );
    });

  /** 回执那一行：坏消息要红，灰着的失败看起来就像成功了。 */
  function tipRow(tip: ProfileTip | null) {
    if (!tip) return null;
    return (
      <div
        style={{
          fontSize: 12,
          marginTop: 4,
          color: tip.tone === "bad" ? "#d4380d" : "var(--zm-text-2)",
        }}
      >
        {tip.text}
      </div>
    );
  }

  /** 每个分页右上角的"恢复本节"：只重置这一节，其它节一个字都不动。 */
  function sectionHeader(section: SectionKey, title: string) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <b style={{ fontSize: 13 }}>{title}</b>
        <Button size="small" onClick={() => void resetSection(section)}>
          恢复本节默认
        </Button>
      </div>
    );
  }

  const body = !loaded ? (
    <LoadingState tip="正在读取配置文件…" />
  ) : (
    <Tabs
      items={[
        {
          key: "general",
          label: "常规",
          children: (
            <div>
              {sectionHeader("general", "界面与交互")}
              <Field label="主题">
                <Radio.Group
                  value={settings.general.theme}
                  onChange={(e) => void patch("general", { theme: e.target.value })}
                  options={[
                    { label: "浅色", value: "light" },
                    { label: "深色", value: "dark" },
                    { label: "跟随系统", value: "system" },
                  ]}
                  optionType="button"
                  size="small"
                />
              </Field>
              <Field
                label="语言"
                hint="全应用只有简体中文这一套文案（antd 的 locale 也是写死的），没有第二份翻译可切。亿图在这里给英文选项，我们不给 —— 选了等于没选的开关不该放在这儿。"
              >
                <span style={{ fontSize: 12, color: "var(--zm-text-2)" }}>
                  简体中文（仅此一套）
                </span>
              </Field>
              <Field
                label="启动恢复上次会话"
                hint="冷启动时自动打开最近列表里最后用过的那份文件；关掉就总是停在开始页。"
              >
                <Switch
                  size="small"
                  checked={settings.general.restoreLastSession}
                  onChange={(v) => void patch("general", { restoreLastSession: v })}
                />
              </Field>
              <Field
                label="显示快捷操作条"
                hint="单选一个主题时在它上方浮出的一条：子主题、同级、折叠、删除、改名。多选或正在打字时不出现。"
              >
                <Switch
                  size="small"
                  checked={settings.general.showQuickBar}
                  onChange={(v) => void patch("general", { showQuickBar: v })}
                />
              </Field>
              <Field
                label="拖动画布的按键"
                hint="默认右键：左键留给选中和框选主题，不会一拖就把选区弄没。"
              >
                <Select
                  size="small"
                  value={settings.general.canvasDragButton}
                  onChange={(v: "left" | "right") => void patch("general", { canvasDragButton: v })}
                  options={[
                    { value: "left", label: "左键" },
                    { value: "right", label: "右键" },
                  ]}
                />
              </Field>
              <Field
                label="滚轮缩放的锚点"
                hint="以光标为锚点时，光标底下的内容放大后仍在原处；以画布中心为锚点会先把目标推到中心。"
              >
                <Select
                  size="small"
                  value={settings.general.wheelZoom}
                  onChange={(v: "cursor" | "center") => void patch("general", { wheelZoom: v })}
                  options={[
                    { value: "cursor", label: "光标位置" },
                    { value: "center", label: "画布中心" },
                  ]}
                />
              </Field>
            </div>
          ),
        },
        {
          key: "format",
          label: "格式",
          children: (
            <div>
              {sectionHeader("format", "新文档的默认样式")}
              <Field
                label="默认布局"
                hint="只影响新建的文档与画布；导入的文档按源文件走，已存在的页把布局记在自己的 <Layout V> 里，改这里不会回头改它们。"
              >
                <Select
                  style={{ width: 220 }}
                  value={settings.format.defaultLayout}
                  onChange={(v: string) => void patch("format", { defaultLayout: v })}
                  options={Object.entries(LAYOUT_LABELS).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                />
              </Field>
              <Field
                label="默认主题 ID"
                hint="这个编号现在只落进配置文件：色板只有一套内置的 Edraw 默认值，没有主题库可挑，所以改它还不影响画面。导入的文档自带自己的配色，与这里无关。"
              >
                <Input
                  size="small"
                  style={{ width: 220 }}
                  value={settings.format.defaultThemeId}
                  onChange={(e) => void patch("format", { defaultThemeId: e.target.value })}
                />
              </Field>
              <Field
                label="打开时自动适配"
                hint="按整棵树的包围盒算一次缩放，长分支的文档不至于打开后只剩中心主题。"
              >
                <Switch
                  size="small"
                  checked={settings.format.autoFitOnOpen}
                  onChange={(v) => void patch("format", { autoFitOnOpen: v })}
                />
              </Field>
              <Field
                label="主题文字宽度"
                hint="固定：本页所有主题对齐到同一个框宽（取本页最宽那个），更长的文字折行；自动：每个主题按自己的文字收着。"
              >
                <Radio.Group
                  value={settings.format.topicWidthMode}
                  onChange={(e) => void patch("format", { topicWidthMode: e.target.value })}
                  options={[
                    { label: "自动", value: "auto" },
                    { label: "固定", value: "fixed" },
                  ]}
                  optionType="button"
                  size="small"
                />
              </Field>
            </div>
          ),
        },
        {
          key: "save",
          label: "保存",
          children: (
            <div>
              {sectionHeader("save", "自动保存与历史版本")}
              <Field label="自动保存">
                <Switch
                  size="small"
                  checked={settings.save.autoSave}
                  onChange={(v) => void patch("save", { autoSave: v })}
                />
              </Field>
              <Field
                label="自动保存间隔"
                hint="分钟，1–1440。低于 1 会被服务侧夹成 1（这里也先夹一次）：Rust 那边按“每分钟最多醒一次”排定时器，写 0 进去只会得到一个语义不明的“一直在存”。"
              >
                <InputNumber<number>
                  size="small"
                  min={1}
                  max={1440}
                  value={settings.save.autoSaveIntervalMin}
                  onChange={(v) => void patch("save", { autoSaveIntervalMin: toInt(v, 1, 1440) })}
                />
              </Field>
              <Field
                label="历史版本份数"
                hint={`上限 ${QUOTA.historyMax} 份。写更大的数没用：backup_now 落盘之后按同一个数裁文件，超出的几份当场就被删掉，配置里的数字反而成了骗人的承诺。`}
              >
                <InputNumber<number>
                  size="small"
                  min={1}
                  max={QUOTA.historyMax}
                  value={settings.save.historyCount}
                  onChange={(v) =>
                    void patch("save", { historyCount: toInt(v, 1, QUOTA.historyMax) })
                  }
                />
              </Field>
              <Field
                label="每次保存都留一份"
                hint="就是 saveAs 之后那次显式 backupNow；关掉只剩“覆盖前”那一份兜底。"
              >
                <Switch
                  size="small"
                  checked={settings.save.backupOnSave}
                  onChange={(v) => void patch("save", { backupOnSave: v })}
                />
              </Field>
              <Field
                label="备份目录"
                hint="留空表示用应用数据目录下的 backups；请填绝对路径。这个目录和自动保存不是同一个。"
              >
                <Input
                  size="small"
                  style={{ width: 300 }}
                  placeholder="留空 = 默认目录"
                  value={settings.save.backupDir}
                  onChange={(e) => void patch("save", { backupDir: e.target.value })}
                />
              </Field>
              <Field
                label="回收站保留天数"
                hint={`默认 ${QUOTA.trashKeepDays} 天。这是回收站（被删掉的文件）的保留期，和历史版本份数是两套闸门，别互相套用。`}
              >
                <InputNumber<number>
                  size="small"
                  min={1}
                  max={365}
                  value={settings.save.backupKeepDays}
                  onChange={(v) => void patch("save", { backupKeepDays: toInt(v, 1, 365) })}
                />
              </Field>
            </div>
          ),
        },
        {
          key: "network",
          label: "网络",
          children: (
            <div>
              {sectionHeader("network", "代理与超时")}
              <Field
                label="代理方式"
                hint={
                  proxy
                    ? proxy.message
                    : "读取代理当前状态失败：这一档是否生效要问桌面外壳，浏览器模式由浏览器自己决定。"
                }
              >
                <Select
                  size="small"
                  value={settings.network.proxyMode}
                  onChange={(v: string) => void changeProxyMode(v)}
                  options={[
                    { value: "system", label: "跟随系统" },
                    { value: "none", label: "不用代理" },
                    { value: "manual", label: "手动" },
                  ]}
                />
              </Field>
              <Field
                label="代理地址"
                hint="只有“手动”这一档会用地址和端口，切到别的档就把这两格清空；地址里不能有空格或引号。改完要重启应用。"
              >
                <Input
                  size="small"
                  style={{ width: 240 }}
                  disabled={settings.network.proxyMode !== "manual"}
                  placeholder="127.0.0.1"
                  value={settings.network.proxyHost}
                  onChange={(e) => void patchNetwork({ proxyHost: e.target.value })}
                />
              </Field>
              <Field label="代理端口">
                <InputNumber<number>
                  size="small"
                  disabled={settings.network.proxyMode !== "manual"}
                  min={0}
                  max={65535}
                  value={settings.network.proxyPort}
                  onChange={(v) => void patchNetwork({ proxyPort: toInt(v, 0, 65535) })}
                />
              </Field>
              <Field
                label="超时"
                hint="秒。这一项由 AI 生成读取（写请求的等待上限）；调太小会把慢一点的正常请求判成失败。"
              >
                <InputNumber<number>
                  size="small"
                  min={1}
                  max={300}
                  value={settings.network.timeoutSec}
                  onChange={(v) => void patch("network", { timeoutSec: toInt(v, 1, 300) })}
                />
              </Field>
            </div>
          ),
        },
        {
          key: "shortcut",
          label: "快捷键",
          children: (
            <div>
              {sectionHeader("shortcut", "全量可自定义、可禁用、可恢复默认")}
              <div
                style={{
                  fontSize: 12,
                  color: "var(--zm-text-2)",
                  margin: "4px 0 10px",
                  lineHeight: 1.6,
                }}
              >
                点一下键位格子进入录制，按下的组合键就是这条命令的新键位：至少要带一个修饰键 （Ctrl
                / Shift / Alt），或者直接用 F1–F12 / Esc 这类功能键。抢别人正在用的键不会抢，
                会当场说清这条键归谁。改完立即生效，工具栏按钮上的悬浮提示跟着一起改。
                <b>禁用之后没有键盘入口</b>，按钮和菜单项都还在 —— 这一页只管键盘。 这张表就是
                <code style={{ fontSize: 12 }}>~/.z-mind/config.json</code> 的 shortcut.custom
                节，换机器要带走就用下面两个按钮整套搬。
              </div>
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <Button size="small" loading={profileBusy} onClick={exportKeymapProfile}>
                    导出键位方案
                  </Button>
                  <Button size="small" loading={profileBusy} onClick={loadKeymapProfile}>
                    加载键位方案
                  </Button>
                  <span style={{ fontSize: 12, color: "var(--zm-text-2)", lineHeight: "24px" }}>
                    文件里只写动过的键；加载是整套替换，没提的命令一律回到默认键位。
                  </span>
                </div>
                {tipRow(keyProfileTip)}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {SHORTCUT_COMMANDS.map((c) => {
                  const stored = settings.shortcut.custom[c.cmd];
                  const touched = stored !== undefined;
                  const off = stored === "";
                  const chord = touched ? stored : defaultChordOf(c.cmd);
                  const rec = recording === c.cmd;
                  const alias = aliasChords(c.cmd);
                  return (
                    <div
                      key={c.cmd}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr auto auto",
                        alignItems: "center",
                        gap: "0 10px",
                        fontSize: 13,
                        padding: "3px 0",
                        borderBottom: "1px solid var(--zm-border)",
                      }}
                    >
                      <span>
                        {c.label}
                        <span style={{ color: "var(--zm-text-2)", fontSize: 12 }}>
                          （{c.group}）
                        </span>
                        {touched && !off ? <Tag style={{ marginLeft: 6 }}>已改</Tag> : null}
                      </span>
                      <Input
                        size="small"
                        readOnly
                        style={{ width: 150, textAlign: "center", cursor: "text" }}
                        value={rec ? "按下新键位…" : off ? "已禁用" : chordLabel(chord)}
                        onFocus={() => {
                          setRecording(c.cmd);
                          setShortcutTip(null);
                        }}
                        onBlur={() => {
                          setRecording((r) => (r === c.cmd ? null : r));
                          setShortcutTip(null);
                        }}
                        onKeyDown={(e) => {
                          // Tab 留给"跳到下一格"，别把换焦点也当成键位。
                          if (e.key === "Tab") return;
                          e.preventDefault();
                          // 录制时把键吃掉：否则 Esc 会被外层对话框当成"关掉选项"。
                          e.stopPropagation();
                          if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
                          const next = chordFromEvent(e.nativeEvent);
                          if (!next) {
                            setShortcutTip(
                              "这组键不成键位：修饰键之外还要一个字母、数字或 F1–F12 / Esc。"
                            );
                            return;
                          }
                          setRecording(null);
                          // 按回默认键就等于恢复默认，别把同一个键再钉一份进配置里。
                          void rebindShortcut(c.cmd, next);
                        }}
                      />
                      <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        {alias.length ? (
                          <span style={{ fontSize: 12, color: "var(--zm-text-2)" }}>
                            还认 {alias.map(chordLabel).join("、")}
                          </span>
                        ) : null}
                        <Button
                          size="small"
                          disabled={!touched}
                          onClick={() => void bindShortcut(c.cmd, null)}
                        >
                          恢复默认
                        </Button>
                        <Button
                          size="small"
                          danger
                          disabled={off}
                          onClick={() => void bindShortcut(c.cmd, "")}
                        >
                          禁用
                        </Button>
                      </span>
                    </div>
                  );
                })}
              </div>
              {shortcutTip ? (
                <div style={{ fontSize: 12, color: "#d4380d", marginTop: 8 }}>{shortcutTip}</div>
              ) : null}
            </div>
          ),
        },
        {
          key: "advanced",
          label: "高级",
          children: (
            <div>
              {sectionHeader("advanced", "更新、日志与 AI 服务")}
              <Field
                label="自动检查更新"
                hint="检查、下载、安装三条路一条都没通：没有更新源地址，也没有签名校验，所以这个开关按不动。等双平台的发布通道建好再接上，届时这一行会自己活过来。"
              >
                <Switch size="small" checked={settings.advanced.autoUpdate} disabled />
              </Field>
              <Field
                label="发送崩溃报告"
                hint="名字沿用亿图，做的其实只是本机留痕：崩一次在 crashes 目录写一个带栈的文本文件，不上传任何东西。关下去之后连目录都不会建，一次也不记。改完立即生效，不用重启。"
              >
                <Switch
                  size="small"
                  checked={settings.advanced.crashReport}
                  onChange={(v) => void changeCrashReport(v)}
                />
              </Field>
              <Field
                label="崩溃记录"
                hint={
                  crash === null ? (
                    (crashTip ??
                    "崩溃记录状态读不到：当前环境没有桌面外壳，前端只能把错误打在控制台里。")
                  ) : (
                    <>
                      一次一份，只留最新 {CRASH_KEEP} 份；开关关着时一次都不写。
                      {crash.dir ? (
                        <>
                          <br />
                          <code style={{ fontSize: 12 }}>{crash.dir}</code>
                          <br />
                          {crash.files
                            ? `${crash.files} 份 / 共 ${(crash.bytes / 1024).toFixed(1)} KB，最新一份 ${crash.latest}。`
                            : "还没有记录过崩溃。"}
                          {/* "在不在记录"只有外壳知道：浏览器模式不落盘，问出来的永远是关，说出来反而误导。 */}
                          <br />
                          当前是否在记录：<b>{crash.enabled ? "是" : "否"}</b>。
                        </>
                      ) : (
                        "（浏览器模式不落盘）"
                      )}
                    </>
                  )
                }
              >
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Button size="small" onClick={() => void openCrashDir()}>
                    打开记录目录
                  </Button>
                  {crashTip ? (
                    <span style={{ fontSize: 12, color: "#d4380d" }}>{crashTip}</span>
                  ) : null}
                </div>
              </Field>
              <Field
                label="日志级别"
                hint="debug 会把每次布局与解析都写满日志目录，只在复现问题的时候开；off 一个字都不记。改完立即生效，不用重启。"
              >
                <Select
                  size="small"
                  value={settings.advanced.logLevel}
                  onChange={(v: string) => void changeLogLevel(v)}
                  // 档位取自外壳的回报而不是在这里抄一份：Rust 认 off，界面漏了它，
                  // 用户手改过 config.json 之后这一格就会显示一个下拉里没有的值。
                  options={(logs?.levels ?? ["off", "error", "warn", "info", "debug"])
                    .slice()
                    .reverse()
                    .map((v) => ({ value: v, label: v }))}
                />
              </Field>
              <Field
                label="运行日志"
                hint={
                  logs === null ? (
                    (logTip ?? "日志状态读不到：当前环境没有桌面外壳，日志只打在浏览器控制台里。")
                  ) : (
                    <>
                      一天一份，最多留 {LOG_KEEP} 份；级别不够的那一行根本不写。
                      {logs.dir ? (
                        <>
                          <br />
                          <code style={{ fontSize: 12 }}>{logs.file || logs.dir}</code>
                          <br />
                          {logs.files} 份 / 共 {(logs.bytes / 1024).toFixed(1)} KB， 当前生效级别{" "}
                          <b>{logs.level}</b>。
                        </>
                      ) : (
                        "（浏览器模式不落盘）"
                      )}
                    </>
                  )
                }
              >
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Button size="small" onClick={() => void openLogDir()}>
                    打开日志目录
                  </Button>
                  {logTip ? <span style={{ fontSize: 12, color: "#d4380d" }}>{logTip}</span> : null}
                </div>
              </Field>
              <Field
                label="AI 服务端点"
                hint="留空用内置地址。这一项只是端点和模型名，不含任何凭据。"
              >
                <Input
                  size="small"
                  style={{ width: 300 }}
                  placeholder="https://…"
                  value={settings.advanced.aiEndpoint}
                  onChange={(e) => void patch("advanced", { aiEndpoint: e.target.value })}
                />
              </Field>
              <Field label="AI 模型名">
                <Input
                  size="small"
                  style={{ width: 220 }}
                  value={settings.advanced.aiModel}
                  onChange={(e) => void patch("advanced", { aiModel: e.target.value })}
                />
              </Field>
              <Field
                label="API Key"
                hint={
                  <>
                    密钥只进本机加密库（native.secretStore AES-256-GCM，主密钥 master.key
                    与密文同目录、0600），绝不写 settings：这一节会被整份存成 config.json， 而
                    config.json 躺在应用数据目录里，同步盘和备份目录都会把它一起带走 ——
                    明文密钥跟着走一遍就等于泄露一次。
                  </>
                }
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    alignItems: "flex-start",
                  }}
                >
                  <Input.Password
                    size="small"
                    style={{ width: 300 }}
                    placeholder="sk-…"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Tooltip title="本页只把密钥放进加密库，不发任何请求：连通性测试要读端点、带凭据，那是 services/ai.ts 的职责。">
                      <Button size="small" type="primary" onClick={() => void saveKey()}>
                        保存密钥
                      </Button>
                    </Tooltip>
                    <Button size="small" onClick={() => void loadKey()}>
                      载入已有密钥
                    </Button>
                    <Button size="small" danger onClick={() => void dropKey()}>
                      清空密钥
                    </Button>
                    {hasKey ? (
                      <Tooltip title="只问“有没有”，不读出内容。输入框里现在是空的，点“载入已有密钥”才会把明文取回来。">
                        <Tag style={{ margin: 0, alignSelf: "center" }} color="green">
                          加密库里已存有一份
                        </Tag>
                      </Tooltip>
                    ) : null}
                  </div>
                  {secretTip ? (
                    <span style={{ fontSize: 12, color: "var(--zm-text-2)" }}>{secretTip}</span>
                  ) : null}
                </div>
              </Field>
            </div>
          ),
        },
        {
          key: "rightMenu",
          label: "右键菜单",
          children: (
            <div>
              {sectionHeader("rightMenu", "画布右键菜单的功能集合")}
              <div
                style={{
                  fontSize: 12,
                  color: "var(--zm-text-2)",
                  margin: "4px 0 10px",
                  lineHeight: 1.6,
                }}
              >
                取消勾选就等于从菜单里去掉，改完立即生效 —— 菜单是每次右键现算的，不用重开。
                这一节只管<b>右键菜单</b>：快捷操作条、工具栏和快捷键都不受它影响，
                去掉"删除主题或标注"之后，选中主题按 Delete 照样删得掉。
                换机器要带走这份勾选就用下面的 方案文件，它导出的就是{" "}
                <code style={{ fontSize: 12 }}>~/.z-mind/config.json</code> 里 rightMenu 那一节，抄
                XML 的形状是给人在看的。
              </div>
              <Field
                label="预设方案"
                hint="亿图的预设也是不可改的：点一下只覆盖下面的勾选，不产生能存下来的新方案。"
              >
                <div style={{ display: "flex", gap: 8 }}>
                  {MENU_PRESETS.map((p) => (
                    <Button
                      key={p.label}
                      size="small"
                      type={
                        p.keys.length === settings.rightMenu.enabled.length &&
                        p.keys.every((k) => settings.rightMenu.enabled.includes(k))
                          ? "primary"
                          : "default"
                      }
                      onClick={() => void patch("rightMenu", { enabled: [...p.keys] })}
                    >
                      {p.label}
                    </Button>
                  ))}
                </div>
              </Field>
              <Field
                label="方案文件"
                hint="一份 xml 就是上面这份勾选。加载是整份替换这一节：文件里没提的动作一律回到「全部显示」。"
              >
                <div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Button size="small" loading={profileBusy} onClick={exportMenuProfile}>
                      导出方案
                    </Button>
                    <Button size="small" loading={profileBusy} onClick={loadMenuProfile}>
                      加载方案
                    </Button>
                  </div>
                  {tipRow(menuProfileTip)}
                </div>
              </Field>
              <Field
                label="菜单里显示这些动作"
                hint={
                  <>
                    顺序就是菜单里的顺序，实际某次右键给几条还要看选中的是什么（主主题没有"删除"，
                    标注泡只有改名和删除）。
                    <b>最后一项取消不了</b>：空列表在这份配置里的意思就是"全部显示"（默认值），
                    让它表示"什么都不给"的话，恢复默认和清空勾选就成了同一件事。
                  </>
                }
              >
                <Checkbox.Group
                  value={
                    settings.rightMenu.enabled.length ? settings.rightMenu.enabled : ALL_MENU_KEYS
                  }
                  onChange={(v) => {
                    const next = v as string[];
                    if (!next.length) return;
                    void patch("rightMenu", { enabled: next });
                  }}
                  options={MENU_ACTION_GROUPS.map((g) => ({ label: g.label, value: g.k }))}
                  style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 24px" }}
                />
              </Field>
              <Field
                label="预览"
                hint="这一行用画布同一份裁剪函数算出来，不是照着勾选状态手写的示意。"
              >
                <span style={{ fontSize: 12, color: "var(--zm-text-2)" }}>
                  {keepActions(MENU_ACTION_GROUPS, settings.rightMenu.enabled)
                    .map((g) => g.label)
                    .join("、") || "（空）"}
                </span>
              </Field>
            </div>
          ),
        },
        {
          key: "recent",
          label: "最近",
          children: (
            <div>
              {sectionHeader("recent", "最近文件")}
              <Field
                label="保留条数"
                hint={`上限 ${QUOTA.recentMax} 条（实测文案：亿图脑图保存最近 20 个文件）。改这里会同时调 native.recentSetCapacity，把服务侧的裁表阈值一起改掉 —— 只写 config 的话列表还按老数字淘汰。`}
              >
                <InputNumber<number>
                  size="small"
                  min={1}
                  max={QUOTA.recentMax}
                  value={settings.recent.maxCount}
                  onChange={(v) => {
                    const n = toInt(v, 1, QUOTA.recentMax);
                    void patch("recent", { maxCount: n });
                    void native.recentSetCapacity(n).catch(() => undefined);
                  }}
                />
              </Field>
              <Field
                label="清空列表"
                hint="只删列表条目，不动磁盘上的文件；找回文件请用开始页的“打开 .emmx”。"
              >
                <Button size="small" danger onClick={() => void clearRecent()}>
                  清空最近文件列表
                </Button>
              </Field>
            </div>
          ),
        },
        {
          key: "quota",
          label: "配额",
          children: (
            <div>
              {sectionHeader("quota", "免费版规则（只读）")}
              <div
                style={{
                  fontSize: 12,
                  color: "var(--zm-text-2)",
                  margin: "4px 0 8px",
                  lineHeight: 1.6,
                }}
              >
                这些数字来自 model/constants.ts 的
                QUOTA，是业务规则而不是可调项（P-4）：界面上每一处限制都从同一份常量取，
                改这里才会改到全部；把它们做成开关，等于把付费墙藏起来。
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  gap: "0 16px",
                  border: "1px solid var(--zm-border)",
                  borderRadius: 4,
                  padding: "8px 12px",
                  fontSize: 13,
                }}
              >
                <span>剩余 AI 点数</span>
                <span>
                  <b>
                    {settings.quota.aiPoints - settings.quota.aiUsed}
                    <span style={{ fontWeight: 400, color: "var(--zm-text-2)" }}>
                      {" "}
                      / {settings.quota.aiPoints}（已用 {settings.quota.aiUsed}）
                    </span>
                  </b>
                </span>
                {QUOTA_ROWS.map((r) => (
                  <div key={r.label} style={{ display: "contents" }}>
                    <span style={{ color: "var(--zm-text-2)" }}>{r.label}</span>
                    <span>{r.value}</span>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 12, color: "var(--zm-text-2)", marginTop: 8 }}>
                点数按“约 {QUOTA.aiCharsPerPoint} 个汉字 1 点”向上取整扣，见
                useSettings.spendAiPoints。
              </div>
              {info ? (
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--zm-text-2)",
                    marginTop: 10,
                    lineHeight: 1.8,
                    borderTop: "1px solid var(--zm-border)",
                    paddingTop: 8,
                  }}
                >
                  <div>
                    版本 <b style={{ color: "var(--zm-text)" }}>{info.version}</b> · {info.os}/
                    {info.arch}
                  </div>
                  {/* 配置目录是"历史版本/备份到底在盘上哪儿"的答案：出问题让人翻日志时，
                      只有应用内这一个地方能拿到真实路径（本机与 CI 的 AppData 前缀并不同）。 */}
                  <div style={{ wordBreak: "break-all" }} title={info.configDir}>
                    配置目录 {info.configDir}
                  </div>
                </div>
              ) : null}
            </div>
          ),
        },
      ]}
    />
  );

  return (
    <Modal
      title="选项"
      open={open}
      width={760}
      onCancel={onClose}
      footer={
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, color: "var(--zm-text-2)", marginRight: "auto" }}>
            {saving ? "正在写入配置文件…" : "改动已即时生效，无需保存"}
          </span>
          <Button onClick={onClose}>关闭</Button>
        </div>
      }
    >
      {storeError ? (
        <Alert type="error" showIcon message={storeError} style={{ marginBottom: 8 }} />
      ) : null}
      {body}
    </Modal>
  );
}

export default OptionsView;
