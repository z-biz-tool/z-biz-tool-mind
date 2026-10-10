import type { ReactNode } from "react";
import { Popconfirm } from "antd";
import type { BackupEntry, RecentItem } from "../services/native.ts";
import { humanSize, timestampName } from "../utils/id.ts";

/** 列表行的公共骨架：一行标题 + 一行次要信息 + 右侧动作。 */
function Row({ main, meta, actions }: { main: ReactNode; meta: ReactNode; actions?: ReactNode }) {
  return (
    <div className="zm-row">
      <div className="zm-row-body">
        <div className="zm-row-title">{main}</div>
        <div className="zm-row-meta">{meta}</div>
      </div>
      {actions && <div className="zm-row-actions">{actions}</div>}
    </div>
  );
}

export function SectionTitle({ children, extra }: { children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="zm-section-title">
      <span>{children}</span>
      {extra}
    </div>
  );
}

export function RecentRow({
  item,
  onOpen,
  onRemove,
  onReveal,
  onPin,
  onDelete,
}: {
  item: RecentItem;
  onOpen: (item: RecentItem) => void;
  onRemove?: (item: RecentItem) => void;
  onReveal?: (item: RecentItem) => void;
  onPin?: (item: RecentItem) => void;
  onDelete?: (item: RecentItem) => void;
}) {
  return (
    <Row
      main={<button type="button" className="zm-link" onClick={() => onOpen(item)}>{item.title}</button>}
      meta={
        <>
          <span>{timestampName(new Date(item.openedAt))}</span>
          <span className="zm-tag">{item.kind === "local" ? "本地" : item.kind}</span>
          {item.pinned ? <span className="zm-tag">已固定</span> : null}
          <span className="zm-path">{item.path}</span>
        </>
      }
      actions={
        <>
          {onPin && (
            <button type="button" className="zm-btn zm-btn-ghost" onClick={() => onPin(item)}>
              {item.pinned ? "取消固定" : "固定"}
            </button>
          )}
          {onReveal && (
            <button type="button" className="zm-btn zm-btn-ghost" onClick={() => onReveal(item)}>
              打开所在
            </button>
          )}
          {onRemove && (
            <button type="button" className="zm-btn zm-btn-ghost" onClick={() => onRemove(item)}>
              移除
            </button>
          )}
          {onDelete && (
            <Popconfirm
              title="删除这个脑图？"
              description="文件移入回收站，可在“历史与备份 → 回收站”放回原处。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => onDelete(item)}
            >
              <button type="button" className="zm-btn zm-btn-ghost">
                删除文件
              </button>
            </Popconfirm>
          )}
        </>
      }
    />
  );
}

export function BackupRow({
  entry,
  onRestore,
  onDelete,
}: {
  entry: BackupEntry;
  onRestore?: (entry: BackupEntry) => void;
  onDelete?: (entry: BackupEntry) => void;
}) {
  return (
    <Row
      main={entry.title}
      meta={
        <>
          <span>{timestampName(new Date(entry.createdAt))}</span>
          <span className="zm-tag">{reasonLabel(entry.reason)}</span>
          <span>{humanSize(entry.size)}</span>
        </>
      }
      actions={
        <>
          {onRestore && (
            <button type="button" className="zm-btn" onClick={() => onRestore(entry)}>
              恢复
            </button>
          )}
          {onDelete && (
            <button type="button" className="zm-btn zm-btn-ghost" onClick={() => onDelete(entry)}>
              删除
            </button>
          )}
        </>
      }
    />
  );
}

/** reason 是 Rust 写入的英文标记，界面上只保留用户看得懂的那几种来源；认不出的原样显示。 */
function reasonLabel(reason: string): string {
  switch (reason) {
    case "save":
      return "保存";
    case "before-overwrite":
      return "覆盖前";
    case "before-restore":
      return "还原前";
    case "autosave":
      return "自动保存";
    case "trash":
      return "回收站";
    default:
      return reason;
  }
}
