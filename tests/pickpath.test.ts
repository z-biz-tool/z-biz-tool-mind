/**
 * 原生选择框那一跳到底把什么递给了插件（03 §1.3-20）。
 *
 * savepath.test.ts 测的是两个纯函数；这里测**组装**：`pickSavePath` / `pickOpenPath`
 * 在桌面分支里拼出来的 `defaultPath`。这条只能靠假 window —— 装机版上"框停在哪个目录"
 * 是唯一能看出来的症状，而那症状就来自这一个字段，所以它必须在单测里也被钉住一次。
 *
 * 做法：`native.ts` 的 `isTauri` 在模块求值时读 `window.__TAURI_INTERNALS__`，
 * 于是先装假 window 再动态 import，让 `save()` / `open()` 落到 `plugin:dialog|*` 的
 * `invoke` 上，把参数原样记下来。真实的对话框当然还是装机侧验（Win32 `EnumWindows` 读 `#32770`）。
 */
import { done, eq, ok } from "./_harness.ts";

const DOC_DIR = "C:\\Users\\u\\Documents";

interface Sent {
  cmd: string;
  options: { title?: string; defaultPath?: string };
}

async function main(): Promise<void> {
  const sent: Sent[] = [];
  let appInfoCalls = 0;
  let dialogReply: string | null = null;

  (globalThis as Record<string, unknown>).window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === "app_info") {
          appInfoCalls += 1;
          return {
            version: "0.0.0-test",
            configDir: "C:\\Users\\u\\AppData\\Roaming\\z-mind",
            tempDir: "C:\\Users\\u\\AppData\\Local\\Temp",
            documentDir: DOC_DIR,
            os: "windows",
            arch: "x86_64",
          };
        }
        const options = (args as { options: { title?: string; defaultPath?: string } }).options;
        sent.push({ cmd, options: { title: options?.title, defaultPath: options?.defaultPath } });
        return dialogReply;
      },
    },
  };

  const { pickOpenPath, pickSavePath } = await import("../src/services/native.ts");
  const FILTER = [{ name: "脑图文件", extensions: ["emmx"] }];
  const last = () => sent[sent.length - 1];

  /* ---------------- 保存框 ---------------- */
  {
    await pickSavePath({ title: "另存为", defaultPath: "副本.emmx", dirHint: "D:\\proj", filters: FILTER });
    eq("命令名", last().cmd, "plugin:dialog|save");
    eq("有当前文档目录就用它（这是「框停在安装目录」的正解）", last().options.defaultPath, "D:\\proj\\副本.emmx");

    await pickSavePath({ title: "保存脑图", defaultPath: "未命名.emmx", filters: FILTER });
    eq("没文档时退回用户「文档」目录", last().options.defaultPath, `${DOC_DIR}\\未命名.emmx`);

    await pickSavePath({
      title: "导出",
      defaultPath: "E:\\somewhere\\out.txt",
      dirHint: "D:\\proj",
      filters: FILTER,
    });
    eq("调用方已经点名位置就一个字都不改", last().options.defaultPath, "E:\\somewhere\\out.txt");

    await pickSavePath({ title: "导出方案", defaultPath: "", filters: FILTER });
    eq("连名字都没有时不硬拼出一个目录路径", last().options.defaultPath, undefined);

    eq("「文档」目录只问一次（app_info 不是每次挑路径都重问）", appInfoCalls, 1);

    dialogReply = "D:\\proj\\真挑的.emmx";
    eq("挑中的路径原样带回", await pickSavePath({ title: "另存为", defaultPath: "a.emmx", filters: FILTER }), "D:\\proj\\真挑的.emmx");
    dialogReply = null;
    eq("取消就是 null，不是抛错", await pickSavePath({ title: "另存为", defaultPath: "a.emmx", filters: FILTER }), null);
  }

  /* ---------------- 打开框 ---------------- */
  {
    dialogReply = "C:\\zmind\\lib.emmx";
    await pickOpenPath({ title: "打开脑图文件", filters: FILTER });
    eq("打开也走同一条通道", last().cmd, "plugin:dialog|open");
    eq("打开框的起点同样不能是安装目录", last().options.defaultPath, DOC_DIR);

    await pickOpenPath({ title: "导入", defaultPath: "D:\\fix\\a.md", filters: FILTER });
    eq("给了起点就不覆盖", last().options.defaultPath, "D:\\fix\\a.md");

    dialogReply = null;
    eq("打开取消是 null", await pickOpenPath({ title: "打开", filters: FILTER }), null);
    ok("标题照样递到插件", last().options.title === "打开");
  }

  done();
}

main().catch((e) => {
  console.log("THROW", e);
  process.exitCode = 1;
});
