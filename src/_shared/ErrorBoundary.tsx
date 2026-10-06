import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorState } from "./States.tsx";

interface Props {
  children: ReactNode;
  /** 面板名出现在错误框里：用户截图报障时，这一行就是定位起点。 */
  label?: string;
  /** 重置键：切换它等于告诉边界"内容已换，重新来过"。 */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

/**
 * 视图级错误边界。
 *
 * 六个投影共享同一棵树，一个投影渲染崩溃不该把整个应用带走 ——
 * 崩溃的那一页丢了撤销栈之外，用户还会以为文档坏了。
 */
export class PanelErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.label ?? "panel"}]`, error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <ErrorState
        message={this.state.error.message}
        hint={`视图「${this.props.label ?? "未命名"}」渲染失败，文档数据没有受影响`}
        onRetry={() => this.setState({ error: null })}
      />
    );
  }
}

export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <PanelErrorBoundary label="应用">
      {children}
    </PanelErrorBoundary>
  );
}
