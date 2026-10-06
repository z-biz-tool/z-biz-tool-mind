/**
 * 导出对话框（Ribbon「导出」/ Ctrl+E）。
 *
 * 两条路径分开走，这是这份文件存在的理由：
 * - .emmx 是**文档本身**，交给 useDoc 的 saveAs —— 那里有免费版文件数闸门（P-4）、覆盖前自动备份、
 *   脏标记落盘；绕开它去 hand 一份 zip，等于把配额和备份两条规则各写两遍。
 * - 其余格式是**派生物**，走 engine/export 的 exportArtifact：只读文档，不动撤销栈、不动脏标记。
 *
 * 顺序是"先编码、后选路径"：位图路线（PNG / 位图 PDF）要在 WebView 里光栅化，大图会当场失败
 * （"图片编码失败，请减小倍率后重试"）。先算，错误落在对话框里，用户还能就地改倍率再来一次；
 * 先选路径，错误落在"已经挑好文件名"之后，用户会以为文件已经存上了。
 * 代价是取消选路径等于白算一次 —— 一次几百毫秒，比丢一次用户信任便宜。
 */
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Alert, Button, InputNumber, Modal, Segmented, Select, Switch, message } from "antd";
import { EmptyState } from "../_shared/index.ts";
import { DISPLAY_LEVELS } from "../model/constants.ts";
import type { Artifact, ExportFormat, ExportOptions } from "../engine/export/index.ts";
import {
  A4_LANDSCAPE,
  A4_PORTRAIT,
  FORMATS,
  exportArtifact,
  formatOf,
} from "../engine/export/index.ts";
import { native, pickSavePath } from "../services/native.ts";
import { computeLayout } from "../engine/layout.ts";
import { outlineRows } from "../engine/projections.ts";
import { activeDoc, activePage, useDoc } from "../stores/docStore.ts";
import { useUi } from "../stores/uiStore.ts";
import { isTopic } from "../types/model.ts";

const GROUPS = ["文档", "图片", "PDF", "文本"] as const;
type Group = (typeof GROUPS)[number];

/** 走画布的那几种：主题数由 computeLayout 说了算，pdf-vector 的图形页也一样按层级裁。 */
const GRAPHIC_FORMATS = new Set<ExportFormat>(["svg", "png", "pdf", "pdf-vector"]);

/** 留空 = 交给引擎默认（paintPage 里 background 缺省 "#ffffff"），不是一个叫"默认"的颜色。 */
const BACKGROUNDS = [
  { value: "", label: "跟随默认（白）" },
  { value: "#ffffff", label: "纯白" },
  { value: "#f5f6f8", label: "界面灰" },
  { value: "#1f2024", label: "深色" },
];

/** JPEG 质量只给三档：0.7 与 0.72 用户看不出区别，却多一个要解释的参数。 */
const QUALITIES = [
  { value: 0.92, label: "最高" },
  { value: 0.82, label: "较高" },
  { value: 0.7, label: "较小文件" },
];

const SCALES = ["1", "2", "3", "4"].map((s) => ({ label: `${s} 倍`, value: s }));

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
}

export function ExportDialog({ open, onClose }: ExportDialogProps) {
  const format = useUi((s) => s.exportFormat);
  const setFormat = useUi((s) => s.setExportFormat);
  const levelsInUi = useUi((s) => s.displayLevels);

  const doc = useDoc((s) => activeDoc(s));
  const page = useDoc((s) => activePage(s));
  const title = useDoc((s) => s.title);

  const [scale, setScale] = useState(2);
  const [quality, setQuality] = useState(0.92);
  const [landscape, setLandscape] = useState(true);
  const [withOutline, setWithOutline] = useState(true);
  const [levels, setLevels] = useState(levelsInUi);
  const [background, setBackground] = useState("");
  const [padding, setPadding] = useState(40);
  const [busy, setBusy] = useState(false);

  /**
   * 提示用 message.useMessage()，不用 App.useApp() 也不用静态 message：
   * 没被 <App> 包住时 App.useApp() 拿到的是 antd 默认 context 里的空对象（context.js 写的是
   * `message: {}`），调用即 undefined is not a function；静态方法能弹，但不吃 ConfigProvider
   * 的主题，深色界面上浮一块浅色提示。hook 自带 holder，挂在自己这棵树里，两种外壳都不翻车。
   */
  const [msgApi, msgHolder] = message.useMessage();

  // 只在"打开对话框"这一下把工具栏的显示层级取过来当初始值。
  // 之后改这里的层级不反写视图：否则关掉对话框画布跟着变，两个入口抢同一份状态。
  useEffect(() => {
    if (open) setLevels(useUi.getState().displayLevels);
  }, [open]);

  const spec = formatOf(format);

  /**
   * 这个数字必须按所选格式算，不能一个数通吃：
   * 图形系（SVG / PNG / 位图 PDF）走 computeLayout，显示层级之外不画、折叠的子树整枝不画；
   * 文本系走 outlineRows，折叠跟随画布，但层级不裁 —— 大纲导出被裁掉层级等于偷偷删内容。
   * 判据不一致还拼成一句"本页将输出 X 个主题"，用户就会拿图形系的裁切去猜文本产物的内容。
   * 浮动主题自成一根（不在中心主题子树里），两条路都带着它，所以这里不用再特殊处理。
   */
  const visibleCount = useMemo(() => {
    if (!page) return 0;
    if (!GRAPHIC_FORMATS.has(format)) return outlineRows(page).length;
    const layout = computeLayout(page, { displayLevel: levels });
    return layout.order.filter((id) => {
      const s = page.shapes[id];
      return s && isTopic(s.type);
    }).length;
  }, [page, levels, format]);

  const totalTopics = useMemo(
    () => (page ? Object.values(page.shapes).filter((s) => isTopic(s.type)).length : 0),
    [page]
  );

  function options(): ExportOptions {
    const opts: ExportOptions = { scale, displayLevel: levels, padding };
    if (background) opts.background = background;
    if (format === "pdf") {
      opts.quality = quality;
      opts.paper = landscape ? A4_LANDSCAPE : A4_PORTRAIT;
    }
    if (format === "pdf-vector") {
      opts.withOutline = withOutline;
      opts.paper = landscape ? A4_LANDSCAPE : A4_PORTRAIT;
    }
    return opts;
  }

  function pickPath(name: string): Promise<string | null> {
    return pickSavePath({
      title: `导出为 ${spec.label}`,
      defaultPath: name,
      filters: [{ name: spec.label, extensions: [spec.ext] }],
    });
  }

  /**
   * emmx 不经过 exportArtifact：内容还是那份文档，规则全在 saveAs 里。
   * 这里用 saveAs 而不是 save()：这一页的语义是"导出到用户挑的那个路径"，
   * save() 会写回当前路径，用户会以为已经存到了刚选的那个位置。
   */
  async function runEmmx() {
    const safe = title.replace(/[\\/:*?"<>|]/g, "_") || "未命名脑图";
    const target = await pickPath(`${safe}.emmx`);
    if (!target) return;
    const ok = await useDoc.getState().saveAs(target);
    if (ok) {
      msgApi.success(`已导出：${target}`);
      return;
    }
    // saveAs 把失败原因写进 docStore.error（免费版文件数闸门也走这一条），原样搬过来；
    // 否则对话框不声不响地留在原地，用户只看到按钮转了一下。
    msgApi.error(useDoc.getState().error ?? `保存失败：${target}`);
  }

  async function runExport() {
    if (!doc || !page || busy) return;
    setBusy(true);
    try {
      if (format === "emmx") {
        await runEmmx();
        return;
      }
      let artifact: Artifact;
      try {
        artifact = await exportArtifact(page, format, options());
      } catch (e) {
        // Rust 与引擎抛出来的本来就是完整中文句子，原样贴出来，别再包一层"导出失败"把原因遮住。
        msgApi.error(e instanceof Error ? e.message : String(e));
        return;
      }
      const target = await pickPath(artifact.name);
      if (!target) return; // 取消：浏览器模式下本来也写不到那个路径，不算错误、不弹提示
      try {
        await native.fileWriteBytes(target, artifact.bytes, true);
        msgApi.success(`已导出：${target}`);
      } catch (e) {
        msgApi.error(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  const isText = spec.group === "文本";

  return (
    <Modal
      title="导出"
      open={open}
      width={560}
      onCancel={onClose}
      footer={
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ marginRight: "auto", fontSize: 12, color: "var(--zm-text-2)" }}>
            {page ? `本页将输出 ${visibleCount} / 共 ${totalTopics} 个主题` : "没有打开的文档"}
          </span>
          <Button onClick={onClose}>取消</Button>
          <Button
            type="primary"
            loading={busy}
            disabled={!doc || !page}
            onClick={() => void runExport()}
          >
            {format === "emmx" ? "另存为 .emmx" : "导出"}
          </Button>
        </div>
      }
    >
      {msgHolder}
      {!doc || !page ? (
        <EmptyState
          title="没有打开的文档"
          description="导出的是文档的派生物：先新建或打开一份脑图，这里的格式与参数才有对象。"
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {GROUPS.map((g) => (
            <FormatRow key={g} group={g} current={format} onPick={setFormat} />
          ))}

          {format === "emmx" ? (
            <Alert
              type="info"
              showIcon
              message="这一条走文档保存那条路（saveAs）：免费版文件数闸门、覆盖前备份、脏标记落盘都在里面，导出对话框不复制这套规则。"
              style={{ fontSize: 12 }}
            />
          ) : null}

          {isText ? (
            <div style={{ fontSize: 12, color: "var(--zm-text-2)", lineHeight: 1.6 }}>
              文本类导出只读大纲结构，不经过布局：倍率、底色、内边距这些渲染参数对这一组没有意义（exportArtifact
              的那几条分支根本不读 opts），所以这里不给。
            </div>
          ) : (
            <>
              <Field label="显示层级">
                <Select
                  size="small"
                  style={{ width: 120 }}
                  value={levels}
                  onChange={(v: number) => setLevels(v)}
                  options={DISPLAY_LEVELS.map((n) => ({ value: n, label: `根下 ${n} 层` }))}
                />
              </Field>
              <Field label="内边距" note="图形四周留白，默认 40。">
                <InputNumber<number>
                  size="small"
                  min={0}
                  max={200}
                  value={padding}
                  onChange={(v) => setPadding(typeof v === "number" ? v : 40)}
                />
              </Field>
              {format === "pdf-vector" ? (
                <Field
                  label="底色"
                  note="矢量 PDF 的第一条绘制指令就是整页铺白，底色参数在这里没有落点，所以不给。"
                >
                  <span style={{ fontSize: 12, color: "var(--zm-text-2)" }}>固定为白</span>
                </Field>
              ) : (
                <Field
                  label="底色"
                  note="PNG 光栅化前引擎先铺一层白，所以底色只影响图形本身；要真透明请用 SVG。"
                >
                  <Select
                    size="small"
                    style={{ width: 150 }}
                    value={background}
                    onChange={(v: string) => setBackground(v)}
                    options={BACKGROUNDS}
                  />
                </Field>
              )}
            </>
          )}

          {format === "png" || format === "pdf" ? (
            <Field
              label="倍率"
              note={
                format === "png"
                  ? "位图在 WebView 的 canvas 上光栅化：浏览器模式照样能出真 PNG，所以这里不需要“请先用桌面版”那种提示。"
                  : "位图 PDF 的清晰度全靠倍率，文件按面积涨。编码走 canvas.toBlob，浏览器与桌面同一条路。"
              }
            >
              <Segmented
                size="small"
                value={String(scale)}
                onChange={(v) => setScale(Number(v))}
                options={SCALES}
              />
            </Field>
          ) : null}

          {format === "pdf" || format === "pdf-vector" ? (
            <Field label="纸张" note="默认横向：导图是宽的东西。">
              <Segmented
                size="small"
                value={landscape ? "landscape" : "portrait"}
                onChange={(v) => setLandscape(v === "landscape")}
                options={[
                  { label: "A4 横向", value: "landscape" },
                  { label: "A4 纵向", value: "portrait" },
                ]}
              />
            </Field>
          ) : null}

          {format === "pdf" ? (
            <Field label="图片质量" note="JPEG 压缩率，只影响位图 PDF。">
              <Select
                size="small"
                style={{ width: 150 }}
                value={quality}
                onChange={(v: number) => setQuality(v)}
                options={QUALITIES}
              />
            </Field>
          ) : null}

          {format === "pdf-vector" ? (
            <Field label="附大纲页" note="第二页是整份大纲（outlineRows）；关掉就只有一张图。">
              <Switch size="small" checked={withOutline} onChange={setWithOutline} />
            </Field>
          ) : null}

          {format === "svg" ? (
            <div style={{ fontSize: 12, color: "var(--zm-text-2)", lineHeight: 1.6 }}>
              SVG 是纯函数产物，不经过光栅化：没有倍率与质量，只有上面那几项渲染参数。
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

/** 一组格式一行。选中态用内联样式：shared-style.css 里没有"按钮选中"这一档，不为此改外壳样式。 */
function FormatRow({
  group,
  current,
  onPick,
}: {
  group: Group;
  current: ExportFormat;
  onPick: (f: ExportFormat) => void;
}) {
  const list = FORMATS.filter((f) => f.group === group);
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
      <span
        style={{
          width: 44,
          flexShrink: 0,
          fontSize: 12,
          color: "var(--zm-text-2)",
          lineHeight: "26px",
        }}
      >
        {group}
      </span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {list.map((f) => {
          const on = f.id === current;
          return (
            <button
              key={f.id}
              type="button"
              className="zm-btn"
              style={
                on
                  ? {
                      borderColor: "var(--zm-accent)",
                      color: "var(--zm-accent)",
                      background: "var(--zm-hover)",
                    }
                  : { color: "var(--zm-text-2)" }
              }
              onClick={() => onPick(f.id)}
            >
              {f.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Field({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
      <span style={{ width: 44, flexShrink: 0, fontSize: 12, lineHeight: "26px" }}>{label}</span>
      <div style={{ minWidth: 0 }}>
        {children}
        {note ? (
          <div style={{ fontSize: 12, color: "var(--zm-text-2)", marginTop: 4, lineHeight: 1.5 }}>
            {note}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default ExportDialog;
