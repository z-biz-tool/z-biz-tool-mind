/**
 * 思维导图投影的外壳（views/index.ts 里那个 MindMapView）。
 *
 * 画布本身（src/canvas）只管"把树画出来、把用户动作翻译成树操作"，
 * 布局类型、显示层级、批量折叠这些是**这一投影独有的工具**，放这里而不是 App 的总工具条：
 * 切到大纲/看板时它们没有意义，总工具条里出现灰掉的控件是亿图被吐槽过的细节。
 */
import { useMemo } from "react";
import { Button, ColorPicker, Segmented, Select, Tooltip } from "antd";
import { LAYOUT_LABELS } from "../model/constants.ts";
import { maxDepth, updateStyle } from "../engine/tree.ts";
import { applyPalette, styleFor } from "../engine/style.ts";
import { useDoc } from "../stores/docStore.ts";
import { useUi } from "../stores/uiStore.ts";
import type { LayoutCode, Page, Shape, ShapeStyle } from "../types/model.ts";
import { MindCanvas } from "../canvas/index.ts";

const LAYOUT_OPTIONS = (Object.keys(LAYOUT_LABELS) as LayoutCode[]).map((code) => ({
  value: code,
  label: LAYOUT_LABELS[code],
}));

const LEVEL_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ value: n, label: `${n} 级` }));

const SIZE_OPTIONS = [10, 12, 14, 16, 18, 20, 24, 28, 36, 48].map((n) => ({ value: n, label: `${n}` }));

export function MindMapView({ page }: { page: Page }) {
  const mutate = useDoc((s) => s.mutate);
  const displayLevels = useUi((s) => s.displayLevels);
  const setDisplayLevels = useUi((s) => s.setDisplayLevels);
  const deepest = useMemo(() => maxDepth(page), [page]);
  const selection = useDoc((s) => s.selection);
  /** 回显取选中的第一个：多选时"混合值"没有稳定的显示法，显示第一个比显示空值更诚实。 */
  const picked = page.shapes[selection[0] ?? ""];
  /** 控件上显示的是**画出来的那个色**，不是 style 里存的那个：没独立配色时 style.fill 是空的。 */
  const look = picked ? styleFor(page, picked) : undefined;
  /** 用户自己配过色 = StyleMask 的 bit0，此时换主题不再影响它，"跟随主题"才有意义。 */
  const pinned = (picked?.style.mask ?? 0) & 1 ? true : false;

  /** 样式只改选中的主题，其余节点原样留着 —— 一次 mutate 就是一步撤销。 */
  const styleSelected = (label: string, patch: (s: Shape) => Partial<ShapeStyle>) => {
    if (!selection.length) return;
    mutate(label, (p) => {
      let out = p;
      for (const id of selection) if (out.shapes[id]) out = updateStyle(out, id, patch(out.shapes[id]));
      return out;
    });
  };

  /** 有多少主题被用户单独配过色 —— 它决定"恢复主题配色"这一钮有没有事可做。 */
  const pinnedCount = useMemo(
    () => Object.values(page.shapes).filter((s) => ((s.style.mask ?? 0) & 1) !== 0).length,
    [page],
  );

  /**
   * 恢复主题配色：先把独立配色那一位清掉，再让 applyPalette 按色板整体重算。
   * 只做后一半是空转 —— applyPalette 唯一跳过的就是被 pin 住的那些。
   * 其余位照原样留着：那是文件里带来的信息（如 tint），不是用户在这儿按下的颜色。
   */
  const resetTheme = () =>
    mutate("恢复主题配色", (p) => {
      const cleared = {
        ...p,
        shapes: Object.fromEntries(
          Object.entries(p.shapes).map(([id, s]) => {
            const rest = (s.style.mask ?? 0) & ~1;
            const style: ShapeStyle = { ...s.style, fill: undefined };
            if (rest) style.mask = rest;
            else delete style.mask;
            return [id, { ...s, style }];
          }),
        ),
      };
      return applyPalette(cleared);
    });

  /** 批量折叠只写 extras.collapsed，不动结构：撤销一步就能整套还原。 */
  const collapseBranches = (collapsed: boolean) => {
    mutate(collapsed ? "全部折叠" : "全部展开", (p) => {
      const shapes = { ...p.shapes };
      for (const id of Object.keys(shapes)) {
        const s = shapes[id];
        if (id === p.rootId || s.childIds.length === 0) continue;
        shapes[id] = { ...s, extras: { ...s.extras, collapsed } };
      }
      return { ...p, shapes };
    });
  };

  return (
    <div className="zm-projection">
      <div className="zm-projection-bar">
        <span className="zm-bar-label">布局</span>
        <Select
          size="small"
          style={{ width: 168 }}
          value={page.layout.code}
          options={LAYOUT_OPTIONS}
          onChange={(code: LayoutCode) =>
            mutate("改布局", (p) => ({ ...p, layout: { ...p.layout, code } }))
          }
        />
        <Tooltip title="只显示前 N 级，深处的内容收起来但不删除">
          <span className="zm-bar-label">显示层级</span>
        </Tooltip>
        <Segmented
          size="small"
          value={displayLevels}
          options={LEVEL_OPTIONS.slice(0, Math.max(2, Math.min(9, deepest + 1)))}
          onChange={(v) => setDisplayLevels(Number(v))}
        />
        <span className="zm-bar-label">共 {deepest + 1} 级 · {Object.keys(page.shapes).length} 个主题</span>
        <div className="zm-bar-spacer" />
        <span className="zm-bar-label">
          样式{selection.length > 1 ? ` ${selection.length} 个主题` : ""}
        </span>
        <ColorPicker
          size="small"
          disabled={!picked}
          value={look?.fill}
          onChangeComplete={(c) =>
            styleSelected("改填充色", (s) => ({
              fill: { ...s.style.fill, type: "Solid", color: { v: c.toHexString() } },
              mask: (s.style.mask ?? 0) | 1,
            }))
          }
        />
        <ColorPicker
          size="small"
          disabled={!picked}
          value={look?.font.color}
          onChangeComplete={(c) =>
            styleSelected("改文字色", (s) => ({ font: { ...s.style.font, color: c.toHexString() } }))
          }
        />
        <Select
          size="small"
          style={{ width: 76 }}
          disabled={!picked}
          value={look?.font.size}
          options={SIZE_OPTIONS}
          onChange={(size: number) => styleSelected("改字号", (s) => ({ font: { ...s.style.font, size } }))}
        />
        <Tooltip title="加粗只改选中的主题">
          <Button
            size="small"
            type={look?.font.bold ? "primary" : "default"}
            disabled={!picked}
            onClick={() =>
              // 取推导值来翻转：中心主题本来就没存 bold，对着 undefined 取反会得到 true，
              // 用户看下去就是"第一次点没反应"。
              styleSelected("切换加粗", (s) => ({ font: { ...s.style.font, bold: !styleFor(page, s).font.bold } }))
            }
          >
            <b>B</b>
          </Button>
        </Tooltip>
        {pinned && (
          <Tooltip title="取消这部分的独立配色，重新跟着主题走">
            <Button
              size="small"
              onClick={() =>
                styleSelected("跟随主题", (s) => ({ fill: undefined, mask: (s.style.mask ?? 0) & ~1 }))
              }
            >
              跟随主题
            </Button>
          </Tooltip>
        )}
        {pinnedCount ? (
          <Tooltip title={`当前有 ${pinnedCount} 个主题被单独配过色；这一步把它们全部交还给主题。之后仍可用撤销恢复。`}>
            <Button size="small" onClick={resetTheme}>
              恢复主题配色（{pinnedCount}）
            </Button>
          </Tooltip>
        ) : null}
        <button type="button" className="zm-btn zm-btn-ghost" onClick={() => collapseBranches(true)}>
          全部折叠
        </button>
        <button type="button" className="zm-btn zm-btn-ghost" onClick={() => collapseBranches(false)}>
          全部展开
        </button>
      </div>
      <div className="zm-projection-body">
        <MindCanvas page={page} />
      </div>
    </div>
  );
}

export default MindMapView;
