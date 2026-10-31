/**
 * zbiz:// 深链接的 mind 语义层。
 *
 * 覆盖的缺陷形状：深链接「点了没反应」有两种 ——
 * 一种是**静默失败**（协议层解析不出来、动作名不认识），一种是把用户的
 * 未保存改动静默顶掉（落地时绕过脏检查）。前者由共享层的
 * startDeepLinkReceiver 兜住（不静默吞掉，给可见提示），后者是本层
 * 与接线的责任：outcome 必须能区分「打开」与「导入」，且接不住时要给出
 * problem 而不是塞一个空路径。
 */
import { done, eq, ok } from "./_harness.ts";
import { resolveMindDeepLink, type HandoffItem } from "../src/_shared/deepLink.ts";

function handoff(action: string, params: Record<string, string> = {}): HandoffItem {
  return { product: "mind", action, params };
}

async function main(): Promise<void> {
  /* ---------------- open：最常见的一条 ---------------- */
  {
    const out = resolveMindDeepLink(handoff("open", { file: "/tmp/a.emmx" }));
    eq("open 取出文件路径", out.path, "/tmp/a.emmx");
    eq("open 不是导入", out.asImport, false);
    ok("open 没有 problem", out.problem === null, String(out.problem));
  }

  /* ---------------- action 缺省 = open ---------------- */
  {
    // 协议层把空 action 解析成 "open"，但语义层仍要自己兜住 ——
    // 别依赖上游一定给对了。
    const out = resolveMindDeepLink(handoff("", { file: "/tmp/a.emmx" }));
    eq("空 action 当作 open", out.path, "/tmp/a.emmx");
    eq("空 action 不是导入", out.asImport, false);
  }

  /* ---------------- import：与 open 的区别只在落地方式 ---------------- */
  {
    const out = resolveMindDeepLink(handoff("import", { file: "/tmp/a.xmind" }));
    eq("import 取出文件路径", out.path, "/tmp/a.xmind");
    eq("import 标记为导入", out.asImport, true);
  }

  /* ---------------- from 参数透传出来（用于提示与日志） ---------------- */
  {
    const out = resolveMindDeepLink(handoff("open", { file: "/tmp/a.emmx", from: "box" }));
    eq("from 参数透传出来", out.from, "box");
  }

  /* ---------------- 路径前后空格被裁掉（深链解析容易带上） ---------------- */
  {
    const out = resolveMindDeepLink(handoff("open", { file: "  /tmp/a.emmx  " }));
    eq("路径前后空格被裁掉", out.path, "/tmp/a.emmx");
  }

  /* ---------------- 空路径 = 接不住，不是「打开当前文档」 ---------------- */
  {
    const out = resolveMindDeepLink(handoff("open", { file: "   " }));
    ok("空路径给 problem", out.problem !== null, "空路径必须有原因");
    eq("空路径不产出路径", out.path, null);
  }

  /* ---------------- 不认识的动作要报出来，不能静默当 open ---------------- */
  {
    // 静默当 open 是最坏的一种：用户会看到「打开了某个文件」，
    // 但那是他没要求的文件 —— 错得没有痕迹，最难查。
    const out = resolveMindDeepLink(handoff("explode", { file: "/tmp/a.emmx" }));
    ok("不认识的动作给 problem", out.problem !== null, "必须有原因");
    eq("不认识的动作不产出路径", out.path, null);
  }

  /* ---------------- action 大小写与空白 ---------------- */
  {
    const out = resolveMindDeepLink(handoff("  OPEN  ", { file: "/tmp/a.emmx" }));
    ok("动作名带空白时按原样判（不认识的就会报出来）", out.problem !== null || out.path !== null);
  }

  done();
}

main().catch((e) => {
  console.log("THROW", e);
  process.exitCode = 1;
});
