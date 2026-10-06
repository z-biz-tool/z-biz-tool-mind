import type { ReactNode } from "react";

/**
 * 三种"没有内容"的状态。
 *
 * 分开写是因为它们对应的用户动作完全不同：空是"去创建"，加载是"等一等"，
 * 错误是"重试或看日志"。用一个组件加 message 参数糊在一起，最后界面里
 * 所有失败都长成一个灰色小字，用户学不会区分。
 */

interface EmptyProps {
  title?: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ title = "暂无内容", description, action }: EmptyProps) {
  return (
    <div className="zm-state">
      <div className="zm-state-title">{title}</div>
      {description && <div className="zm-state-desc">{description}</div>}
      {action}
    </div>
  );
}

export function LoadingState({ tip = "加载中…" }: { tip?: string }) {
  return (
    <div className="zm-state">
      <div className="zm-spinner" aria-hidden />
      <div className="zm-state-desc">{tip}</div>
    </div>
  );
}

interface ErrorProps {
  message: string;
  onRetry?: () => void;
  hint?: string;
}

export function ErrorState({ message, onRetry, hint }: ErrorProps) {
  return (
    <div className="zm-state zm-state-error">
      <div className="zm-state-title">出错了</div>
      <div className="zm-state-desc">{message}</div>
      {hint && <div className="zm-state-desc">{hint}</div>}
      {onRetry && (
        <button type="button" className="zm-btn" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}

/**
 * 骨架屏的行数由调用方给：列表类面板（最近文件、历史版本）如果只转一个圈，
 * 用户无法预判马上要出现的行数，读秒之后还得重新适应整块版面。
 */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div style={{ padding: 12, display: "grid", gap: 10 }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="zm-skeleton-row" />
      ))}
    </div>
  );
}
