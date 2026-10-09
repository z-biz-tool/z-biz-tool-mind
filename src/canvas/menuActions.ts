/**
 * 画布右键菜单的动作目录（doc/复刻方案/00 §293「右键菜单 · 功能集合自定义」）。
 *
 * 目录单独成文件，是因为选项面板和画布要用同一份：k 就是画布 push 动作时那个键，
 * 两处各抄一份就会出现"勾了却没少"——面板以为裁掉了，画布还在给。
 */
export interface MenuAction {
  k: string;
  label: string;
  tip: string;
  run: () => void;
}

/** 可裁剪的动作，顺序就是菜单里的顺序。 */
export const MENU_ACTION_GROUPS: readonly { k: string; label: string }[] = [
  { k: "child", label: "插入子主题" },
  { k: "sibling", label: "插入同级主题" },
  { k: "fold", label: "折叠 / 展开分支" },
  { k: "branch", label: "复位被拖开的分支" },
  { k: "del", label: "删除主题或标注" },
  { k: "note", label: "附注（备注与超链接）" },
  { k: "edit", label: "改名 / 改文字" },
  { k: "callout", label: "新建标注" },
  { k: "boundary", label: "外框" },
  { k: "summary", label: "概要" },
  { k: "rel", label: "关系线（连线 / 取消连线）" },
  { k: "float", label: "新建自由主题" },
  { k: "fit", label: "适应画布" },
];

/** 亿图给的是"默认 / 极简"两套不可改的方案，这里同样只给两套一键覆盖，不让用户存方案。 */
export const MENU_PRESETS: readonly { label: string; keys: readonly string[] }[] = [
  { label: "默认（全部显示）", keys: [] },
  { label: "极简", keys: ["child", "sibling", "del", "edit", "fit"] },
];

/**
 * 按白名单裁剪，保持传入顺序。
 *
 * 空数组 = 不裁剪：config.rs 给这一节的默认值就是 `{ enabled: [] }`，老配置文件缺这一节时
 * merge_defaults 补出来的也是空 —— 那两条路都必须等于"全部显示"，否则升级一次菜单就空了。
 */
export function keepActions<T extends { k: string }>(
  items: readonly T[],
  enabled: readonly string[]
): T[] {
  if (!enabled.length) return [...items];
  return items.filter((it) => enabled.includes(it.k));
}
