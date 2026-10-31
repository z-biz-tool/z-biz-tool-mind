/**
 * zbiz:// 深链接的 **mind 语义层**。
 *
 * ## 分工
 *
 * | 层 | 在哪 | 管什么 |
 * |----|----|--------|
 * | 协议 | `z-biz-tool-shared/protocol/deeplink` | 字节级编解码（金标 = Rust `cap-hub`） |
 * | 机制 | `z-biz-tool-shared/protocol/deeplinkReceiver` | 冷启动补取、事件监听、不静默吞掉 |
 * | **语义** | **本文件** | **收到深链后 mind 该做什么** |
 *
 * ## mind 支持的动作
 *
 * | action | 含义 | 参数 |
 * |--------|------|------|
 * | `open` | 打开一份脑图 | `file`（绝对路径） |
 * | `import` | 以「导入」方式载入一份脑图 | `file`（绝对路径） |
 *
 * ## 为什么只有「文件路径」这一种意图
 *
 * mind 的核心资产就是一份脑图文件（`.emmx`），家族里其它产品（box 的
 * 「交给兄弟应用」、note 的「文件交接」）递过来的也基本是路径。所以本仓的
 * 深链语义收敛到「打开某个路径」这一件事 —— 动作越多，越容易出现
 * 「动作名对不上、各仓各叫一套」的问题。
 *
 * ## 扩展名不由本层校验
 *
 * `cap_hub` 不校验扩展名（它只管协议字节），而 mind 的 `.emmx` 过滤在
 * Rust 侧 `openfile::pick()` 里 —— 但**那条过滤不经过 zbiz 通路**。
 * 所以本层只做「有没有路径」的判断，具体能不能打开交给 mind 自己的
 * 打开流程报错（那样用户看到的错误信息才带着 mind 的语境）。
 */

import type { Handoff } from "z-biz-tool-shared/protocol";

/**
 * Rust 侧 `cap_hub::Handoff` 的镜像。
 *
 * 名字叫 `HandoffItem` 是为了在本仓内部读起来更顺（本仓此前一直用这个名字），
 * 实质就是共享层的 `Handoff`。
 */
export type { Handoff as HandoffItem } from "z-biz-tool-shared/protocol";

/**
 * mind 的深链结果。
 *
 * `path` 非 null 表示要打开某个文件；
 * `problem` 非 null 表示接不住 —— 前端必须给可见提示（不静默吞掉）。
 */
export interface MindDeepLinkOutcome {
  /** 要打开的文件路径；null 表示不带打开意图 */
  path: string | null;
  /** 要不要按「导入」处理（而不是「打开」） */
  asImport: boolean;
  /** 发送方（from），仅用于提示与日志 */
  from: string | null;
  /** 无法适配时的原因 */
  problem: string | null;
}

/**
 * 把一条深链翻译成 mind 内的动作。
 *
 * 纯函数 —— 不碰 store、不碰 Tauri，所以可以直接单测。
 *
 * @param item 深链
 */
export function resolveMindDeepLink(item: Handoff): MindDeepLinkOutcome {
  const outcome: MindDeepLinkOutcome = {
    path: null,
    asImport: false,
    from: item.params.from ?? null,
    problem: null,
  };

  const action = item.action.trim() || "open";
  const path = item.params.file?.trim() ?? "";

  if (action !== "open" && action !== "import") {
    outcome.problem = `不认识的动作 ${action}`;
    return outcome;
  }

  if (!path) {
    outcome.problem = "深链里没有 file 参数";
    return outcome;
  }

  outcome.path = path;
  outcome.asImport = action === "import";
  return outcome;
}
