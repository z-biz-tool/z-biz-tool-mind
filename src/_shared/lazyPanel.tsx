import { Suspense, lazy, type FC } from "react";
import { LoadingState } from "./States.tsx";

/**
 * 投影面板一律懒加载。
 *
 * 甘特、看板、幻灯片这些视图共享不到多少代码，打进首屏只会让启动变慢；
 * 亿图自己切到甘特视图时也有明显的重排耗时，我们至少让"加载态"是真的。
 *
 * 参数是 FC 而不是 ComponentType：类型上排除了 class 组件，省掉 <Panel {...props} />
 * 那句永远写不对的 RefAttributes 交叉类型。
 */
export function lazyPanel<P extends object>(factory: () => Promise<{ default: FC<P> }>, label: string) {
  const Panel = lazy(factory);
  return function LazyPanel(props: P) {
    return (
      <Suspense fallback={<LoadingState tip={`正在准备${label}…`} />}>
        <Panel {...props} />
      </Suspense>
    );
  };
}
