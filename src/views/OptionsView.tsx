/**
 * 选项面板（亿图 F1 那一份"选项"对话框，七个分页正好对上 Settings 的七个节）。
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
import { LAYOUT_LABELS, QUOTA } from "../model/constants.ts";
import { native } from "../services/native.ts";
import type { AppInfo } from "../services/native.ts";
import { useRecent } from "../stores/recentStore.ts";
import { useSettings } from "../stores/settingsStore.ts";

/** 密钥在加密库里的条目名：只在这一个文件出现，改它等于换一份用户凭据，别散落。 */
const AI_KEY_NAME = "ai-api-key";

type SectionKey = "general" | "format" | "save" | "network" | "advanced" | "recent" | "quota";

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

  useEffect(() => {
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
  }, []);

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
              <Field label="语言">
                <Select
                  size="small"
                  value={settings.general.language}
                  onChange={(v: string) => void patch("general", { language: v })}
                  options={[
                    { value: "zh-CN", label: "简体中文" },
                    { value: "en-US", label: "English" },
                  ]}
                />
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
                hint="对应主题库里的 Edraw 主题编号；填一个不存在的编号会退到内置默认色板。"
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
                hint="自动：文字撑到换行上限就折行；固定：所有主题同一个框宽，长文字靠省略号收尾。"
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
              <Field label="代理方式">
                <Select
                  size="small"
                  value={settings.network.proxyMode}
                  onChange={(v: string) => void patch("network", { proxyMode: v })}
                  options={[
                    { value: "system", label: "跟随系统" },
                    { value: "none", label: "不用代理" },
                    { value: "manual", label: "手动" },
                  ]}
                />
              </Field>
              <Field
                label="代理地址"
                hint="只有“手动”这一档才会写进请求；其它模式下这两项存着也不生效。"
              >
                <Input
                  size="small"
                  style={{ width: 240 }}
                  disabled={settings.network.proxyMode !== "manual"}
                  placeholder="127.0.0.1"
                  value={settings.network.proxyHost}
                  onChange={(e) => void patch("network", { proxyHost: e.target.value })}
                />
              </Field>
              <Field label="代理端口">
                <InputNumber<number>
                  size="small"
                  disabled={settings.network.proxyMode !== "manual"}
                  min={0}
                  max={65535}
                  value={settings.network.proxyPort}
                  onChange={(v) => void patch("network", { proxyPort: toInt(v, 0, 65535) })}
                />
              </Field>
              <Field
                label="超时"
                hint="秒。AI 与模板库这类在线能力共用一个超时值；调太小会把慢一点的正常请求判成失败。"
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
          key: "advanced",
          label: "高级",
          children: (
            <div>
              {sectionHeader("advanced", "更新、日志与 AI 服务")}
              <Field label="自动检查更新">
                <Switch
                  size="small"
                  checked={settings.advanced.autoUpdate}
                  onChange={(v) => void patch("advanced", { autoUpdate: v })}
                />
              </Field>
              <Field label="发送崩溃报告">
                <Switch
                  size="small"
                  checked={settings.advanced.crashReport}
                  onChange={(v) => void patch("advanced", { crashReport: v })}
                />
              </Field>
              <Field
                label="日志级别"
                hint="debug 会把每次布局与解析都写满日志目录，只在复现问题的时候开。"
              >
                <Select
                  size="small"
                  value={settings.advanced.logLevel}
                  onChange={(v: string) => void patch("advanced", { logLevel: v })}
                  options={[
                    { value: "debug", label: "debug" },
                    { value: "info", label: "info" },
                    { value: "warn", label: "warn" },
                    { value: "error", label: "error" },
                  ]}
                />
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
