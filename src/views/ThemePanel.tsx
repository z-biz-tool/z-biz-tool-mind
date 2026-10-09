/**
 * 主题风格面板（03 §1.3-17）：把"这份文档用哪套配色"变成一个能存下来、能改、能删的地方。
 *
 * 文案逐条取自参考软件的解包字符串（`_research/extract/qm-cn.tsv`）：
 * 「主题风格」「自定义主题」「创建自定义主题」「暂无自定义主题」
 * 「没有可用的自定义主题。是否从当前文档提取主题？」「确定删除该主题风格？」
 * 「保存失败，该自定义主题已经存在。」「自定义主题名称：」「保存主题」「主题颜色」「主题字体」「当前默认」
 * 「新建」「修改」「删除」「应用」「一级主题 / 二级主题」「中心主题」。
 * 只有一句没照抄：亿图删主题时说"应用该主题的文档将被恢复到默认主题"—— 那是因为它存的是**引用**；
 * 我们"应用"时把色值写进了文档自己的 theme.xml，删库里的这套动不了已经存过的文件，所以这里说实话。
 *
 * 为什么放在编辑器里而不是选项对话框：这一件事改的是**这份文档**，
 * 而 OptionsView 每一项改的都是 `~/.z-mind/config.json`（全局）。把文档级操作塞进全局对话框，
 * 用户会以为换了台机器这份配色也跟着走。只有"设为当前默认"那一个按钮确实是全局的，它写的就是配置。
 */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Alert,
  Button,
  ColorPicker,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Tag,
  Tooltip,
} from "antd";
import { activeDoc, activePage, useDoc } from "../stores/docStore.ts";
import { usePalette } from "../stores/usePalette.ts";
import { useSettings } from "../stores/settingsStore.ts";
import { contrastText, levelFill } from "../engine/style.ts";
import {
  ACCENT_MAX,
  ACCENT_MIN,
  BUILTIN_DEFAULT,
  BUILTIN_DEFAULT_ID,
  blankTheme,
  extractTheme,
  FONT_LEVEL_MAX,
  paletteOfTheme,
  removeTheme,
  samePalette,
  saveTheme,
  applyTheme,
  THEME_MAX,
  THEME_NAME_MAX,
  THEME_REASON_TEXT,
  type StoredTheme,
} from "../engine/themelib.ts";

/** 层级 → 那一档字号叫什么。"中心主题""一级主题"这类叫法都取自参考软件（Application / AudioPage）。 */
const CN_NUM = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];
const levelLabel = (i: number): string => (i === 0 ? "中心主题" : `${CN_NUM[i - 1] ?? i}级主题`);

/** 字号本身的区间（pt）。档数上限不在这里重复：那是 themelib 的 FONT_LEVEL_MAX，两处必须同一个数。 */
const FONT_PT_MIN = 6;
const FONT_PT_MAX = 96;

/** 一排色块：库里每一套都靠它认，所以两行的色块数不同要一眼看得出来。 */
function Swatches({ accents }: { accents: string[] }) {
  return (
    <span style={{ display: "inline-flex", gap: 3, alignItems: "center", verticalAlign: "middle" }}>
      {accents.map((c, i) => (
        <span
          key={`${c}-${i}`}
          title={`${c}（Accent${i + 1}）`}
          style={{
            width: 16,
            height: 16,
            borderRadius: 3,
            background: c,
            border: "1px solid var(--zm-border)",
          }}
        />
      ))}
    </span>
  );
}

/** 四格小样：用的就是画布那条推导式（style.levelFill），预览不会比画布好看。 */
function Preview({ theme }: { theme: StoredTheme }) {
  const pal = paletteOfTheme(theme);
  const cells = [
    { label: "中心主题", level: 0, main: true, branch: 0 },
    { label: "一级主题", level: 1, main: false, branch: 0 },
    { label: "二级主题", level: 2, main: false, branch: 0 },
    { label: "另一支", level: 1, main: false, branch: 1 },
  ];
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {cells.map((c) => {
        const base = pal.accents[c.branch % pal.accents.length];
        const fill = levelFill(base, c.level, c.main);
        return (
          <span
            key={c.label}
            style={{
              background: fill,
              color: contrastText(fill),
              borderRadius: 4,
              padding: "3px 8px",
              fontSize: 12,
            }}
          >
            {c.label}
          </span>
        );
      })}
    </div>
  );
}

interface EditorProps {
  initial: StoredTheme;
  isNew: boolean;
  /** 没有打开文档时不给"应用"：这一钮改的是文档，库里改的是配置，两件事别混。 */
  canApply: boolean;
  onApply: (t: StoredTheme) => void;
  onSave: (t: StoredTheme) => Promise<string | null>;
  onClose: () => void;
}

/** 建 / 改一套主题。字段就是 theme.xml 里真存的那三样：主色档、字号档、字族。 */
function ThemeEditor({ initial, isNew, canApply, onApply, onSave, onClose }: EditorProps) {
  const [draft, setDraft] = useState<StoredTheme>(initial);
  const [tip, setTip] = useState<string | null>(null);
  const set = (patch: Partial<StoredTheme>) => setDraft((d) => ({ ...d, ...patch }));

  const setAccent = (i: number, hex: string) => {
    const next = [...draft.accents];
    next[i] = hex;
    set({ accents: next });
  };
  /** 加一档补 Angel 同档、减一档从尾部收：档数就是槽位号的上限，压缩前面那几档会让全体错位。 */
  const resize = (delta: number) => {
    const n = Math.min(ACCENT_MAX, Math.max(ACCENT_MIN, draft.accents.length + delta));
    const next = [...draft.accents];
    while (next.length < n) {
      next.push(BUILTIN_DEFAULT.accents[next.length % BUILTIN_DEFAULT.accents.length]);
    }
    set({ accents: next.slice(0, n) });
  };
  /** 清空那一格（null / 非数字）就保持原值：字号没有"空"这个状态，主题字体档数由加减两钮管。 */
  const setSize = (i: number, v: number | string | null) => {
    const raw = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
    if (!Number.isFinite(raw)) return;
    const next = [...draft.fontSizes];
    next[i] = Math.min(FONT_PT_MAX, Math.max(FONT_PT_MIN, Math.round(raw)));
    set({ fontSizes: next });
  };
  const resizeSizes = (delta: number) => {
    const n = Math.min(FONT_LEVEL_MAX, Math.max(1, draft.fontSizes.length + delta));
    const next = [...draft.fontSizes];
    while (next.length < n) next.push(next[next.length - 1] ?? 10);
    set({ fontSizes: next.slice(0, n) });
  };

  const save = () => {
    void onSave(draft).then((err) => {
      setTip(err);
      if (!err) onClose();
    });
  };

  return (
    <Modal
      title={isNew ? "创建自定义主题" : "修改自定义主题"}
      open
      width={640}
      onCancel={onClose}
      footer={
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, color: "var(--zm-text-2)", marginRight: "auto" }}>
            {isNew
              ? `自定义主题最多存 ${THEME_MAX} 套，名称不能重复。`
              : "改完点「保存主题」才会落进配置。"}
          </span>
          <Button onClick={onClose}>取消</Button>
          {canApply ? (
            <Button onClick={() => onApply(draft)} title="不存进库，只把这套色用到当前文档">
              应用
            </Button>
          ) : null}
          <Button type="primary" onClick={save}>
            保存主题
          </Button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 108, textAlign: "right", fontSize: 13, flexShrink: 0 }}>
            自定义主题名称：
          </span>
          <Input
            size="small"
            style={{ width: 260 }}
            maxLength={THEME_NAME_MAX}
            placeholder="给这套配色起个名"
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            onPressEnter={save}
          />
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <span
            style={{
              width: 108,
              textAlign: "right",
              fontSize: 13,
              flexShrink: 0,
              lineHeight: "28px",
            }}
          >
            主题颜色
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", maxWidth: 430 }}>
              {draft.accents.map((c, i) => (
                <Tooltip
                  key={i}
                  title={`Accent${i + 1}：第 ${i + 1} 档主色（分支按这几档轮转取色）`}
                >
                  <ColorPicker
                    size="small"
                    value={c}
                    onChangeComplete={(v) => setAccent(i, v.toHexString())}
                  />
                </Tooltip>
              ))}
            </div>
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                fontSize: 12,
                color: "var(--zm-text-2)",
              }}
            >
              <Button
                size="small"
                disabled={draft.accents.length >= ACCENT_MAX}
                onClick={() => resize(1)}
              >
                加一档
              </Button>
              <Button
                size="small"
                disabled={draft.accents.length <= ACCENT_MIN}
                onClick={() => resize(-1)}
              >
                减一档
              </Button>
              <span>{draft.accents.length} 档：分支比这多就回头重用第一档。</span>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <span
            style={{
              width: 108,
              textAlign: "right",
              fontSize: 13,
              flexShrink: 0,
              lineHeight: "28px",
            }}
          >
            主题字体
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Input
              size="small"
              style={{ width: 200 }}
              value={draft.fontFamily}
              onChange={(e) => set({ fontFamily: e.target.value })}
              placeholder="字体名，如 微软雅黑"
            />
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", maxWidth: 430 }}>
              {draft.fontSizes.map((n, i) => (
                <Tooltip key={i} title={levelLabel(i)}>
                  <InputNumber
                    size="small"
                    style={{ width: 58 }}
                    min={FONT_PT_MIN}
                    max={FONT_PT_MAX}
                    value={n}
                    onChange={(v) => setSize(i, v)}
                  />
                </Tooltip>
              ))}
            </div>
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                fontSize: 12,
                color: "var(--zm-text-2)",
              }}
            >
              <Button
                size="small"
                disabled={draft.fontSizes.length >= FONT_LEVEL_MAX}
                onClick={() => resizeSizes(1)}
              >
                加一级
              </Button>
              <Button
                size="small"
                disabled={draft.fontSizes.length <= 1}
                onClick={() => resizeSizes(-1)}
              >
                减一级
              </Button>
              <span>从左到右是中心主题、一级、二级……比这更深的层级一律用最后一档。</span>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ width: 108, textAlign: "right", fontSize: 13, flexShrink: 0 }}>预览</span>
          <Preview theme={draft} />
        </div>
        {tip ? <Alert type="error" showIcon message={tip} /> : null}
        <div style={{ fontSize: 12, color: "var(--zm-text-2)" }}>
          字体名要和系统里装的一样才显示得出来；导出的 SVG/PDF 只带这个名字，不带字体文件。
        </div>
      </div>
    </Modal>
  );
}

export function ThemePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const doc = useDoc((s) => activeDoc(s));
  const page = useDoc((s) => activePage(s));
  const mutateDoc = useDoc((s) => s.mutateDoc);
  const palette = usePalette();
  const list = useSettings((s) => s.settings.themes.custom);
  const defaultId = useSettings((s) => s.settings.format.defaultThemeId);
  const patch = useSettings((s) => s.patch);
  const loaded = useSettings((s) => s.loaded);
  const load = useSettings((s) => s.load);
  const [editing, setEditing] = useState<{
    key: string;
    initial: StoredTheme;
    isNew: boolean;
  } | null>(null);
  const [tip, setTip] = useState<string | null>(null);

  useEffect(() => {
    // 面板可能从工具条、也可能从键盘（Ctrl+Shift+T）打开，不保证有人替我们 load() 过。
    if (open && !useSettings.getState().loaded) void load();
  }, [open, load]);

  if (!open) return null;
  const hasDoc = !!(doc && page);
  const current = doc && page ? extractTheme(doc, page) : undefined;

  async function writeList(next: StoredTheme[]): Promise<boolean> {
    const applied = await patch("themes", { custom: next });
    setTip(applied ? null : "主题库没写进配置文件，重启就会回到原样。");
    return !!applied;
  }

  /**
   * 应用 = 把这套色写进这份文档的 theme.xml（一步撤销）。
   * 同色板再点一次是空转，不涨撤销栈 —— 这点与「改布局」那些钮同一个口径。
   */
  function apply(t: StoredTheme) {
    if (!doc || !page) return;
    if (samePalette(palette, paletteOfTheme(t))) {
      setTip(`「${t.name}」就是这份文档此刻在用的配色，没有改动。`);
      return;
    }
    mutateDoc(`应用主题「${t.name}」`, (d) => applyTheme(d, page, t));
    setTip(
      `已把「${t.name}」写进这份文档的 theme.xml，导出文件带着它走。` +
        `单独配过色的主题不跟着变 —— 要它们交还给主题，用工具条上的「恢复主题配色」。`
    );
  }

  async function saveDraft(t: StoredTheme): Promise<string | null> {
    const res = saveTheme(list, t);
    if (!res.ok) return THEME_REASON_TEXT[res.reason];
    return (await writeList(res.list)) ? null : "配置写入失败，这一套没存住。";
  }

  /** 一行上挂哪些标签：全局的"当前默认"与这份文档的"正在用"是两件事，分开说。 */
  function tagsOf(t: StoredTheme): TagSpec[] {
    const out: TagSpec[] = [];
    if (t.id === defaultId) out.push({ text: "当前默认", color: "green" });
    if (current && samePalette(palette, paletteOfTheme(t)))
      out.push({ text: "本文档正在用", color: "blue" });
    return out;
  }

  function actionsOf(t: StoredTheme, removable: boolean): ReactNode {
    const isBuiltin = t.id === BUILTIN_DEFAULT_ID;
    const onDefault = defaultId === t.id;
    return (
      <>
        {hasDoc ? (
          <Button size="small" onClick={() => apply(t)}>
            应用
          </Button>
        ) : null}
        {isBuiltin ? null : (
          <Button
            size="small"
            onClick={() => setEditing({ key: `m-${t.id}`, initial: { ...t }, isNew: false })}
          >
            修改
          </Button>
        )}
        <Tooltip
          title={`新建文档就用这一套起手（写 ${onDefault ? "回" : ""} config.json，全局设置，不动现有文件）`}
        >
          <Button
            size="small"
            type={onDefault ? "primary" : "default"}
            onClick={() =>
              void patch("format", { defaultThemeId: onDefault ? BUILTIN_DEFAULT_ID : t.id })
            }
          >
            设为当前默认
          </Button>
        </Tooltip>
        {removable ? (
          <Popconfirm
            title="确定删除该主题风格？"
            description="已经写进文档的配色不受影响：这里存的是色值本身，不是对库的引用。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() =>
              void writeList(removeTheme(list, t.id)).then(
                (ok) => ok && setTip(`已删掉「${t.name}」。`)
              )
            }
          >
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        ) : null}
      </>
    );
  }

  return (
    <Modal
      title="主题风格"
      open={open}
      width={720}
      onCancel={onClose}
      footer={
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, color: "var(--zm-text-2)", marginRight: "auto" }}>
            内置只有「{BUILTIN_DEFAULT.name}」一套：亿图那 47 套的色值仓库里没有实测依据，不编。
          </span>
          <Button onClick={onClose}>关闭</Button>
        </div>
      }
    >
      {!loaded ? (
        <Alert type="info" showIcon message="正在读取配置文件…" />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {current ? (
            <Section title="当前文档">
              <Row
                name={current.name}
                theme={current}
                tags={[{ text: "本文档正在用", color: "blue" }]}
                actions={
                  <Button
                    size="small"
                    onClick={() =>
                      setEditing({
                        key: `x-${Date.now()}`,
                        initial: { ...current, id: "" },
                        isNew: true,
                      })
                    }
                  >
                    创建自定义主题
                  </Button>
                }
              />
              <Note>
                这一行读的是文件里 theme.xml 说的那几档色（{current.accents.length} 档 ·{" "}
                {current.fontFamily}）。应用一套主题之后，这一行就跟着显示那套。
              </Note>
            </Section>
          ) : (
            <Alert
              type="info"
              showIcon
              message="现在没有打开文档：可以管理主题库、也可以设新文档的默认那套，「应用」要等有文档时才给。"
            />
          )}

          <Section title="内置">
            <Row
              name={BUILTIN_DEFAULT.name}
              theme={BUILTIN_DEFAULT}
              tags={tagsOf(BUILTIN_DEFAULT)}
              actions={actionsOf(BUILTIN_DEFAULT, false)}
            />
          </Section>

          <Section
            title="自定义主题"
            right={
              <Button
                size="small"
                type="primary"
                onClick={() =>
                  setEditing({
                    key: `n-${Date.now()}`,
                    initial: current ? { ...current, id: "", name: "" } : blankTheme(),
                    isNew: true,
                  })
                }
              >
                新建
              </Button>
            }
          >
            {list.length ? (
              list.map((t) => (
                <Row
                  key={t.id}
                  name={t.name}
                  theme={t}
                  tags={tagsOf(t)}
                  actions={actionsOf(t, true)}
                />
              ))
            ) : (
              <Note>
                暂无自定义主题。没有可用的自定义主题。
                {current ? (
                  <Button
                    size="small"
                    style={{ marginLeft: 8 }}
                    onClick={() =>
                      setEditing({
                        key: `x-${Date.now()}`,
                        initial: { ...current, id: "" },
                        isNew: true,
                      })
                    }
                  >
                    从当前文档提取主题
                  </Button>
                ) : null}
              </Note>
            )}
          </Section>

          {tip ? <Alert type="info" showIcon message={tip} /> : null}
        </div>
      )}

      {editing ? (
        <ThemeEditor
          key={editing.key}
          initial={editing.initial}
          isNew={editing.isNew}
          canApply={hasDoc}
          onApply={(t) => {
            apply(t);
            setEditing(null);
          }}
          onSave={saveDraft}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Modal>
  );
}

/* ---------------------------------------------------------------- 行 */

function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <b style={{ fontSize: 13 }}>{title}</b>
        {right}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{children}</div>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 12, color: "var(--zm-text-2)" }}>{children}</div>;
}

interface TagSpec {
  text: string;
  color?: string;
}

function Row({
  name,
  theme,
  tags,
  actions,
}: {
  name: string;
  theme: StoredTheme;
  tags: TagSpec[];
  actions: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        border: "1px solid var(--zm-border)",
        borderRadius: 4,
        padding: "6px 10px",
      }}
    >
      <Swatches accents={theme.accents} />
      <span style={{ fontSize: 13, minWidth: 96 }}>{name}</span>
      <span style={{ fontSize: 12, color: "var(--zm-text-2)" }}>
        {theme.fontFamily} · {theme.fontSizes.join("/")}
      </span>
      {tags.map((t) => (
        <Tag key={t.text} color={t.color} style={{ margin: 0 }}>
          {t.text}
        </Tag>
      ))}
      <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>{actions}</span>
    </div>
  );
}

export default ThemePanel;
