/**
 * 思维导图投影的外壳（views/index.ts 里那个 MindMapView）。
 *
 * 画布本身（src/canvas）只管"把树画出来、把用户动作翻译成树操作"，
 * 布局类型、显示层级、批量折叠这些是**这一投影独有的工具**，放这里而不是 App 的总工具条：
 * 切到大纲/看板时它们没有意义，总工具条里出现灰掉的控件是亿图被吐槽过的细节。
 */
import { useMemo } from "react";
import { Segmented, Select, Tooltip } from "antd";
import { LAYOUT_LABELS } from "../model/constants.ts";
import { maxDepth } from "../engine/tree.ts";
import { useDoc } from "../stores/docStore.ts";
import { useUi } from "../stores/uiStore.ts";
import type { LayoutCode, Page } from "../types/model.ts";
import { MindCanvas } from "../canvas/index.ts";

const LAYOUT_OPTIONS = (Object.keys(LAYOUT_LABELS) as LayoutCode[]).map((code) => ({
  value: code,
  label: LAYOUT_LABELS[code],
}));

const LEVEL_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ value: n, label: `${n} 级` }));

export function MindMapView({ page }: { page: Page }) {
  const mutate = useDoc((s) => s.mutate);
  const displayLevels = useUi((s) => s.displayLevels);
  const setDisplayLevels = useUi((s) => s.setDisplayLevels);
  const deepest = useMemo(() => maxDepth(page), [page]);

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
