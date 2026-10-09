/**
 * 原生保存框的落点（03 §1.3-20）。
 *
 * 覆盖的缺陷形状：装机版实测「导出」弹出来的框停在**安装目录**上 ——
 * Windows 只拿到裸文件名时把框放在进程工作目录，用户从开始菜单启动时那就是程序文件夹，
 * 于是"导出一个 txt"默认往 C:\Program Files 那一侧写。修法是递绝对路径出去，
 * 优先级 当前文档所在目录 → 用户「文档」目录 → 原样放过（已经在路径里就别改写它）。
 *
 * 这里测的是两个纯函数本身；`pickSavePath` 里那步组装依赖 IPC，装机侧用真框验。
 */
import { done, eq } from "./_harness.ts";
import { absSavePath, dirOf } from "../src/services/native.ts";

async function main(): Promise<void> {
  /* ---------------- dirOf：从已有文档路径摘出目录 ---------------- */
  {
    eq("Windows 带盘符的文档路径", dirOf("C:\\Users\\u\\Documents\\a.emmx"), "C:\\Users\\u\\Documents");
    eq("POSIX 路径", dirOf("/home/u/doc/a.md"), "/home/u/doc");
    eq("混着写也按最后一个分隔符切", dirOf("D:\\a/b/c.emmx"), "D:\\a/b");
    eq("盘根下的文件留盘符", dirOf("C:\\a.emmx"), "C:");
    eq("裸文件名没有目录，给 null", dirOf("a.emmx"), null);
    eq("根下单个名字不当目录用", dirOf("/a.txt"), null);
    eq("空串就是没文档", dirOf(""), null);
    eq("null 进 null 出", dirOf(null), null);
    eq("undefined 进 null 出", dirOf(undefined), null);
  }

  /* ---------------- absSavePath：保证递出去的是绝对路径 ---------------- */
  {
    // 1) 有提示目录 → 用它
    eq("裸文件名 + 文档目录提示", absSavePath("a.txt", "C:\\Users\\u\\Documents", null), "C:\\Users\\u\\Documents\\a.txt");
    eq("提示目录优先级高于兜底目录", absSavePath("a.txt", "D:\\x", "C:\\y"), "D:\\x\\a.txt");
    eq("空串提示不算提示，落到兜底", absSavePath("a.txt", "", "C:\\y"), "C:\\y\\a.txt");

    // 2) 没有提示 → 用「文档」目录兜底
    eq("兜底目录", absSavePath("笔记.md", null, "/home/u/Documents"), "/home/u/Documents/笔记.md");
    eq("兜底也是空就原样给回去", absSavePath("a.txt", null, ""), "a.txt");

    // 3) 调用方已经点名位置 → 一个字都不改（覆盖它等于偷改用户挑的目录）
    eq("Windows 绝对路径原样放过", absSavePath("C:\\a\\b.emmx", "D:\\x", "E:\\y"), "C:\\a\\b.emmx");
    eq("POSIX 绝对路径原样放过", absSavePath("/tmp/b.txt", "C:\\x", null), "/tmp/b.txt");
    eq("带相对目录也算带目录", absSavePath("out/b.csv", "C:\\x", null), "out/b.csv");

    // 4) 没有名字的几种退化
    eq("没名字就是没默认值", absSavePath(null, "C:\\x", "C:\\y"), undefined);
    eq("空名字不硬拼出一个目录来", absSavePath("", "C:\\x", null), undefined);

    // 5) 分隔符：目录尾巴上的斜杠不能拼成 `C:\\a\\\\b`，POSIX 目录不该被改成反斜杠
    eq("提示目录尾斜杠收掉", absSavePath("a.txt", "C:\\x\\", null), "C:\\x\\a.txt");
    eq("提示目录尾斜杠连续收掉", absSavePath("a.txt", "C:\\x\\\\", null), "C:\\x\\a.txt");
    eq("POSIX 提示目录用正斜杠", absSavePath("a.txt", "/home/u/Documents/", null), "/home/u/Documents/a.txt");
    eq("UNC 目录留反斜杠", absSavePath("a.txt", "\\\\nas\\share\\d", null), "\\\\nas\\share\\d\\a.txt");
    eq("盘根当目录时不丢掉冒号", absSavePath("a.txt", "C:", null), "C:\\a.txt");

    // 6) 真实调用点的组装方式：dirOf(当前文档) 喂给 hint
    eq(
      "从 C:\\zmind\\lib.emmx 另存为 → 停在 C:\\zmind",
      absSavePath("副本.emmx", dirOf("C:\\zmind\\lib.emmx"), null),
      "C:\\zmind\\副本.emmx"
    );
    eq(
      "新文档还没有路径 → 退回「文档」目录",
      absSavePath("未命名.emmx", dirOf(null), "C:\\Users\\u\\Documents"),
      "C:\\Users\\u\\Documents\\未命名.emmx"
    );
  }

  done();
}

main().catch((e) => {
  console.log("THROW", e);
  process.exitCode = 1;
});
