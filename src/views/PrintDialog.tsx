/**
 * 打印对话框（§3.11，Ribbon「打印」/ Ctrl+P）。
 *
 * 界面上每个数字都来自 engine/export/print 的那一份计划，没有第二处计算：
 * 页数、缩放、落在纸外的主题数都是 printPlanOf 给的，预览就是那几张真正会送进打印框的 SVG
 * （同一串字节，只是用 transform 缩成缩略图）。所以"预览里看到几页"和"打出几张纸"必然相等。
 *
 * 两个按钮两条路：
 * - 打印：把这份文档塞进隐藏 iframe，交给系统打印框（见 services/print）；
 * - 打印到文件：走位图 PDF 那条已经验过的路，页数与纸上尺寸都按同一份计划排。
 *    系统没有可用打印口时（例如某些 macOS WKWebView），这一条就是出路，不是装饰。
 */
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Alert,
  Button,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Switch,
  Tooltip,
  message,
} from "antd";
import { EmptyState } from "../_shared/index.ts";
import { DISPLAY_LEVELS } from "../model/constants.ts";
import { countTopics } from "../engine/tree.ts";
import {
  DEFAULT_MARGIN_MM,
  PAPERS,
  RANGES,
  SCALE_MODES,
  MM_TO_PX,
  paperOf,
  printDocumentHtml,
  printTitleOf,
  printJobOf,
  printSvgsOf,
  buildPrintPdfBytes,
} from "../engine/export/print.ts";
import type { PrintOptions, PrintRange, PrintScaleMode, Rect } from "../engine/export/print.ts";
import { printHtmlDocument, printSupported } from "../services/print.ts";
import { native, pickSavePath } from "../services/native.ts";
import { activePage, useDoc } from "../stores/docStore.ts";
import { useUi } from "../stores/uiStore.ts";

/** 缩略图最多四张：再多就不是"预览"而是"看幻灯片"了，而且首屏要算的 SVG 也白算。 */
const PREVIEW_SHEETS = 4;
const THUMB_W = 168;

const PAPER_GROUPS = [
  { label: "常用", ids: ["a3", "a4", "a5", "a6", "b4", "b5"] },
  {
    label: "工程与西式",
    ids: [
      "c",
      "d",
      "e",
      "quarto",
      "folio",
      "legal",
      "letter",
      "tabloid",
      "executive",
      "statement",
      "monarch",
    ],
  },
  { label: "信封", ids: ["env10", "c5", "c6", "dl", "b5env"] },
  { label: "跟随内容", ids: ["auto"] },
];

interface PrintDialogProps {
  open: boolean;
  onClose: () => void;
}

export function PrintDialog({ open, onClose }: PrintDialogProps) {
  const page = useDoc((s) => activePage(s));
  const selection = useDoc((s) => s.selection);

  const [paperId, setPaperId] = useState("a4");
  const [landscape, setLandscape] = useState(true);
  const [marginMm, setMarginMm] = useState(DEFAULT_MARGIN_MM);
  const [mode, setMode] = useState<PrintScaleMode>("fitOne");
  const [scalePct, setScalePct] = useState(100);
  const [cols, setCols] = useState(2);
  const [rows, setRows] = useState(1);
  const [copies, setCopies] = useState(1);
  const [range, setRange] = useState<PrintRange>("page");
  const [levels, setLevels] = useState(useUi.getState().displayLevels);
  const [bounded, setBounded] = useState(false);
  const [bounds, setBounds] = useState<Rect | null>(null);
  const [busy, setBusy] = useState(false);
  const [msgApi, msgHolder] = message.useMessage();

  // 只在打开这一下把视图的显示层级取过来，之后两个入口各管各的（与导出对话框同一条规则）。
  useEffect(() => {
    if (open) setLevels(useUi.getState().displayLevels);
  }, [open]);

  const opts = useMemo<PrintOptions>(
    () => ({
      paperId,
      landscape,
      marginMm,
      mode,
      scalePct,
      gridCols: cols,
      gridRows: rows,
      copies,
      range,
      keepIds: selection,
      bounds: bounded ? bounds : null,
      displayLevel: levels,
    }),
    [
      paperId,
      landscape,
      marginMm,
      mode,
      scalePct,
      cols,
      rows,
      copies,
      range,
      selection,
      bounded,
      bounds,
      levels,
    ]
  );

  const job = useMemo(() => (page ? printJobOf(page, opts) : null), [page, opts]);
  const thumbs = useMemo(() => {
    if (!job) return [];
    return printSvgsOf(job.paint, { ...job.plan, views: job.plan.views.slice(0, PREVIEW_SHEETS) });
  }, [job]);

  const auto = paperId === "auto";
  const paper = paperOf(paperId);
  const needSelection = range !== "page" && selection.length === 0;
  const scaleLabel = `${Math.round((job?.plan.scale ?? 1) * 100)}%`;

  /** 把边界拉到"选中的那些主题"上；没选就明确说没选，而不是给一堆 0。 */
  function boundsToSelection() {
    if (!job || !page) return;
    const picked = job.paint.boxes.filter((b) => selection.includes(b.id));
    if (!picked.length) {
      msgApi.warning("先在画布上选中主题，再按「用选区范围」。");
      return;
    }
    const x = Math.min(...picked.map((b) => b.x));
    const y = Math.min(...picked.map((b) => b.y));
    const x1 = Math.max(...picked.map((b) => b.x + b.w));
    const y1 = Math.max(...picked.map((b) => b.y + b.h));
    setBounds({ x: round1(x), y: round1(y), w: round1(x1 - x), h: round1(y1 - y) });
  }

  async function doPrint() {
    if (!page || !job || busy) return;
    setBusy(true);
    try {
      await printHtmlDocument(printDocumentHtml(printTitleOf(page), job.paint, job.plan));
      msgApi.success(`已送出 ${job.plan.sheets} 页到系统打印框`);
    } catch (e) {
      msgApi.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doPrintToFile() {
    if (!page || !job || busy) return;
    setBusy(true);
    try {
      // 先编码后选路径：光栅化要在 WebView 里做，大图会当场失败（与导出对话框同一个顺序）。
      const bytes = await buildPrintPdfBytes(page, opts);
      const target = await pickSavePath({
        title: "打印到文件（PDF）",
        defaultPath: `${printTitleOf(page)}.pdf`,
        filters: [{ name: "PDF 文档", extensions: ["pdf"] }],
      });
      if (!target) return;
      await native.fileWriteBytes(target, bytes, true);
      msgApi.success(`已打印到文件：${target}`);
    } catch (e) {
      msgApi.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="打印"
      open={open}
      width={720}
      onCancel={onClose}
      footer={
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ marginRight: "auto", fontSize: 12, color: "var(--zm-text-2)" }}>
            {job
              ? `${job.plan.sheets} 张纸（${job.plan.grid.cols}×${job.plan.grid.rows} 页 × ${job.plan.copies} 份）· 缩放 ${scaleLabel} · ${job.paint.boxes.length} / ${page ? countTopics(page) : 0} 个主题`
              : "没有打开的文档"}
          </span>
          <Button onClick={onClose}>取消</Button>
          <Button disabled={!job} loading={busy} onClick={() => void doPrintToFile()}>
            打印到文件
          </Button>
          <Tooltip title={printSupported() ? "" : "当前环境没有打印口，请改用「打印到文件」"}>
            <Button
              type="primary"
              loading={busy}
              disabled={!job || needSelection}
              onClick={() => void doPrint()}
            >
              打印
            </Button>
          </Tooltip>
        </div>
      }
    >
      {msgHolder}
      {!page ? (
        <EmptyState
          title="没有打开的文档"
          description="打印的是当前页的派生物：先新建或打开一份脑图，这里的纸张与范围才有对象。"
        />
      ) : (
        <div style={{ display: "flex", gap: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minWidth: 0 }}>
            <Field label="纸张">
              <Select
                size="small"
                style={{ width: 210 }}
                value={paperId}
                onChange={(v: string) => setPaperId(v)}
                options={PAPER_GROUPS.map((g) => ({
                  label: g.label,
                  options: g.ids
                    .filter((id) => PAPERS.some((p) => p.id === id))
                    .map((id) => {
                      const p = paperOf(id);
                      return {
                        value: id,
                        label: `${p.label}${p.id === "auto" ? "" : ` ${p.wMm}×${p.hMm}mm`}`,
                      };
                    }),
                }))}
              />
            </Field>

            <Field
              label="方向"
              note={auto ? "自动尺寸跟着内容走，横纵没有区别。" : "默认横向：导图是宽的东西。"}
            >
              <Segmented
                size="small"
                disabled={auto}
                value={landscape ? "landscape" : "portrait"}
                onChange={(v) => setLandscape(v === "landscape")}
                options={[
                  { label: "横向", value: "landscape" },
                  { label: "纵向", value: "portrait" },
                ]}
              />
            </Field>

            <Field label="页边距" note="毫米，四边同值；自动尺寸固定为 0。">
              <InputNumber<number>
                size="small"
                min={0}
                max={50}
                disabled={auto}
                value={marginMm}
                addonAfter="mm"
                onChange={(v) => setMarginMm(typeof v === "number" ? v : DEFAULT_MARGIN_MM)}
              />
            </Field>

            <Field label="缩放" note={SCALE_MODES.find((m) => m.id === mode)?.note}>
              <Select
                size="small"
                style={{ width: 210 }}
                value={mode}
                onChange={(v: PrintScaleMode) => setMode(v)}
                options={SCALE_MODES.map((m) => ({ value: m.id, label: m.label }))}
              />
            </Field>

            {mode === "fitMulti" ? (
              <Field label="网格" note="行列数就是这张图摊成几页；缩放取该网格下能用的最大值。">
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <InputNumber<number>
                    size="small"
                    min={1}
                    max={10}
                    value={cols}
                    addonAfter="列"
                    onChange={(v) => setCols(typeof v === "number" ? v : 2)}
                  />
                  <InputNumber<number>
                    size="small"
                    min={1}
                    max={10}
                    value={rows}
                    addonAfter="行"
                    onChange={(v) => setRows(typeof v === "number" ? v : 1)}
                  />
                </div>
              </Field>
            ) : null}

            {mode === "center" || mode === "exact" ? (
              <Field label="比例" note="100% 就是画布上的真实尺寸（1px = 1/96in）。">
                <InputNumber<number>
                  size="small"
                  min={10}
                  max={400}
                  step={10}
                  value={scalePct}
                  addonAfter="%"
                  onChange={(v) => setScalePct(typeof v === "number" ? v : 100)}
                />
              </Field>
            ) : null}

            <Field label="范围" note={RANGES.find((r) => r.id === range)?.note}>
              <Select
                size="small"
                style={{ width: 210 }}
                value={range}
                onChange={(v: PrintRange) => setRange(v)}
                options={RANGES.map((r) => ({ value: r.id, label: r.label }))}
              />
            </Field>

            <Field label="层级" note="与画布那个开关同一个含义：只显示根下前 N 层。">
              <Select
                size="small"
                style={{ width: 120 }}
                value={levels}
                onChange={(v: number) => setLevels(v)}
                options={DISPLAY_LEVELS.map((n) => ({ value: n, label: `根下 ${n} 层` }))}
              />
            </Field>

            <Field label="打印边界">
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Switch
                    size="small"
                    checked={bounded}
                    onChange={(v) => {
                      setBounded(v);
                      if (v && !bounds) {
                        const p = job?.paint;
                        if (p)
                          setBounds({
                            x: round1(p.minX),
                            y: round1(p.minY),
                            w: round1(p.width),
                            h: round1(p.height),
                          });
                      }
                    }}
                  />
                  {bounded ? (
                    <Button size="small" onClick={boundsToSelection}>
                      用选区范围
                    </Button>
                  ) : null}
                </div>
                {bounded && bounds ? (
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    {(["x", "y", "w", "h"] as const).map((k) => (
                      <InputNumber<number>
                        key={k}
                        size="small"
                        min={k === "w" || k === "h" ? 1 : undefined}
                        style={{ width: 96 }}
                        value={bounds[k]}
                        addonAfter={k}
                        onChange={(v) =>
                          setBounds({ ...bounds, [k]: typeof v === "number" ? v : bounds[k] })
                        }
                      />
                    ))}
                    <span style={{ fontSize: 12, color: "var(--zm-text-2)" }}>
                      画布坐标（约 {(bounds.w / MM_TO_PX).toFixed(0)}×
                      {(bounds.h / MM_TO_PX).toFixed(0)}mm）
                    </span>
                  </div>
                ) : null}
                {!bounded ? (
                  <div style={{ fontSize: 12, color: "var(--zm-text-2)", lineHeight: 1.5 }}>
                    未设置打印边界：整页内容都打。开启后只打边界内的主题，跨边界的连线不留断头。
                  </div>
                ) : null}
              </div>
            </Field>

            <Field
              label="份数"
              note="份数在这里把整组页面重复 N 遍；打印机驱动里的首选项仍由系统那张面板管。"
            >
              <InputNumber<number>
                size="small"
                min={1}
                max={99}
                value={copies}
                onChange={(v) => setCopies(typeof v === "number" ? v : 1)}
              />
            </Field>

            {needSelection ? (
              <Alert
                type="warning"
                showIcon
                message="这个范围要先在画布上选中主题：当前没有选区，所以「打印」是灰的。"
                style={{ fontSize: 12 }}
              />
            ) : null}
            {job && job.plan.outside > 0 ? (
              <Alert
                type="warning"
                showIcon
                message={`有 ${job.plan.outside} 个主题的中心落在纸张范围之外，不会被打印。换缩放模式或减少页边距。`}
                style={{ fontSize: 12 }}
              />
            ) : null}
            {job && job.paint.boxes.length === 0 ? (
              <Alert
                type="info"
                showIcon
                message="按当前的范围与边界，这一份一张纸上也画不出任何主题。"
                style={{ fontSize: 12 }}
              />
            ) : null}
          </div>

          <div style={{ width: THUMB_W + 16, flexShrink: 0 }}>
            <div style={{ fontSize: 12, color: "var(--zm-text-2)", marginBottom: 6 }}>
              预览（
              {paper.id === "auto" ? "自动尺寸" : `${job?.plan.paperMm.w}×${job?.plan.paperMm.h}mm`}
              ）
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {thumbs.map((svg, i) => (
                <Thumb key={i} svg={svg} plan={job?.plan} index={i} />
              ))}
              {job && job.plan.views.length > PREVIEW_SHEETS ? (
                <div style={{ fontSize: 12, color: "var(--zm-text-2)" }}>
                  还有 {job.plan.views.length - PREVIEW_SHEETS} 页未显示
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** 缩略图用的就是那几张要进打印框的 SVG，只加一个 transform。 */
function Thumb({
  svg,
  plan,
  index,
}: {
  svg: string;
  plan?: { boxPx: { w: number; h: number } };
  index: number;
}) {
  if (!plan) return null;
  const k = THUMB_W / plan.boxPx.w;
  return (
    <div style={{ position: "relative" }}>
      <div
        style={{
          width: THUMB_W,
          height: plan.boxPx.h * k,
          overflow: "hidden",
          border: "1px solid var(--zm-border)",
          background: "#fff",
        }}
        dangerouslySetInnerHTML={{
          __html: `<div style="transform:scale(${k});transform-origin:0 0">${svg}</div>`,
        }}
      />
      <span
        style={{
          position: "absolute",
          right: 2,
          bottom: 2,
          fontSize: 10,
          padding: "0 4px",
          borderRadius: 3,
          background: "var(--zm-hover)",
          color: "var(--zm-text-2)",
        }}
      >
        {index + 1}
      </span>
    </div>
  );
}

function Field({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
      <span style={{ width: 48, flexShrink: 0, fontSize: 12, lineHeight: "26px" }}>{label}</span>
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

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export default PrintDialog;
