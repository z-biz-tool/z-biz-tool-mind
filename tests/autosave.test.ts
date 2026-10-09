/**
 * 自动保存快照的"待处理"判定与了结（03 §1.3-18）。
 *
 * 覆盖的缺陷形状：
 * 1) 「忽略」必须真的把那一份从盘上带走 —— 以前只关弹窗，快照原地留着，
 *    于是同一份每次开机都再问一遍；这是这条链路第一次有测试；
 * 2) 判据是"快照晚于文件落盘时刻"：早于它的已经被真正的保存覆盖，恢复那种只会把用户往回带；
 * 3) 一次进程只问最新的一份，但**积压数和目录总数要一起回** ——
 *    逐份追问在真实积压面前不成立（每个自动保存周期新写一份文件，本机实测攒到 285 份），
 *    而「全部清掉」那颗确认框上必须写得出真实份数；
 * 4) 删已经不在了的那一份要回 false 而不是抛 —— 连点两次「忽略」不是错误；
 * 5) 快照路径在两端形状不同（Rust 带一层文档目录与时间戳文件名，浏览器就是那个 key），
 *    提示语里的文档名两头都得说对；
 * 6) 清空目录报的是**文件数**而不是"清过一次的 1"，否则弹窗里"这会删掉 N 份"和实际结果打脸。
 */
import { done, eq, ok } from "./_harness.ts";
import { native, type AutosaveItem } from "../src/services/native.ts";
import {
  autosaveNote,
  pendingAutosaves,
  pendingSnapshots,
  snapshotTitle,
} from "../src/services/autosave.ts";
import { useDoc } from "../src/stores/docStore.ts";

function item(path: string, at: number): AutosaveItem {
  return { path, size: 10, modifiedAt: at };
}

async function main(): Promise<void> {
  /* ---------------- 判据本身 ---------------- */
  {
    const t0 = 1_000;
    eq("空列表就是没得问", pendingSnapshots([], 0), []);
    eq(
      "早于落盘时刻的快照不再问（它已经被真正的保存覆盖）",
      pendingSnapshots([item("a", 900), item("b", 1_100)], t0).map((i) => i.path),
      ["b"]
    );
    eq(
      "恰好等于落盘时刻的也不问",
      pendingSnapshots([item("a", 1_000)], t0).map((i) => i.path),
      []
    );
    eq(
      "新到旧排队：弹窗一次只能说一份，先说最该看的",
      pendingSnapshots([item("旧", 1_100), item("最新", 1_500), item("次新", 1_300)], t0).map(
        (i) => i.path
      ),
      ["最新", "次新", "旧"]
    );
    eq(
      "没存过盘的文档没有基线，全部待处理",
      pendingSnapshots([item("a", 5)], 0).map((i) => i.path),
      ["a"]
    );
  }

  /* ---------------- 了结那一份（浏览器模式，与桌面同一条 API） ---------------- */
  {
    const bytes = new Uint8Array([1, 2, 3]);
    await native.autosaveWrite("快照甲", bytes);
    await native.autosaveWrite("快照乙", bytes);
    const before = (await native.autosaveList()).filter((i) => /^快照[甲乙]/.test(i.path));
    eq("两份都落进了列表", before.length, 2);

    const first = before[0].path;
    eq("带走一份应报已删掉", await native.autosaveDrop(first), true);
    eq(
      "剩下的那份还在（不能顺手清掉整目录）",
      (await native.autosaveList()).filter((i) => /^快照[甲乙]/.test(i.path)).map((i) => i.path),
      [before[1].path]
    );
    eq(
      "再点一次「忽略」：本来就不在了，回 false 而不是抛",
      await native.autosaveDrop(first),
      false
    );
    ok("没在列表里的路径不该被当成删掉了", !(await native.autosaveDrop("从没写过的一个 key")));
    await native.autosaveDrop(before[1].path);
    eq(
      "两份都答完就没有待处理了",
      (await native.autosaveList()).filter((i) => /^快照[甲乙]/.test(i.path)).length,
      0
    );
  }

  /* ---------------- 基线来自 store，不是硬编码 0 ---------------- */
  {
    const bytes = new Uint8Array([9]);
    const stamp = Date.now();
    await native.autosaveWrite("基线测试", bytes);
    const saved = await native.autosaveList();
    const mine = saved.find((i) => i.path.startsWith("基线测试"))!;
    ok("快照写进去了", !!mine, JSON.stringify(saved.map((i) => i.path)));

    useDoc.setState({ path: null, savedAt: 0 });
    const all = (await pendingAutosaves()).pending;
    ok(
      "没存过盘 ⇒ 这一份在待处理里",
      all.some((i) => i.path === mine.path)
    );

    // 把"上一次写盘"摆到这份快照之后：它就已经被真正的保存覆盖了。
    useDoc.setState({ path: "D:/x/基线测试.emmx", savedAt: mine.modifiedAt + 60_000 });
    ok(
      "落盘晚于快照 ⇒ 不再拿它打扰用户",
      !(await pendingAutosaves()).pending.some((i) => i.path === mine.path)
    );
    // 同一份文档，但落盘时刻在快照之前（比如恢复之后又动了没存）。
    useDoc.setState({ savedAt: Math.max(0, stamp - 10_000) });
    ok(
      "快照更新 ⇒ 仍然要问",
      (await pendingAutosaves()).pending.some((i) => i.path === mine.path)
    );
    await native.autosaveDrop(mine.path);
    useDoc.setState({ path: null, savedAt: 0 });
  }

  /* ---------------- 积压的出口：只问一份，但份数要说得出口 ---------------- */
  {
    const bytes = new Uint8Array([7]);
    const keys = ["积压甲", "积压乙", "积压丙"];
    for (const k of keys) await native.autosaveWrite(k, bytes);

    const { pending, total } = await pendingAutosaves();
    eq("这三份都数得到", keys.filter((k) => pending.some((i) => i.path.startsWith(k))).length, 3);
    ok("排第一的就是弹窗要问的那一份", pending.length > 0 && !!pending[0].path);
    ok("三份都在总数里", total >= 3, `total=${total}`);

    // 把基线抬到这三份之后：一份都不该问，可目录里的份数不许跟着一起"假装清零" ——
    // 「全部清掉」那颗确认框写的是总数，写成待处理条数的话，用户点下去删掉的是比数字更多的东西。
    useDoc.setState({ path: "D:/x/积压甲.emmx", savedAt: Date.now() + 600_000 });
    const quiet = await pendingAutosaves();
    eq("落盘晚于全部快照 ⇒ 一份都不问", quiet.pending.length, 0);
    ok("总数仍然数得到那三份", quiet.total >= 3, `total=${quiet.total}`);
    useDoc.setState({ path: null, savedAt: 0 });

    const n = await native.autosaveClear();
    eq("清空报的是文件数，不是「清过一次 = 1」", n, quiet.total);
    const after = await pendingAutosaves();
    eq("清空之后没有待处理", after.pending.length, 0);
    eq("清空之后总数归零", after.total, 0);
  }

  /* ---------------- 提示语里的文档名：两端路径形状不同 ---------------- */
  {
    const rust = item("C:\\Users\\me\\.z-mind\\autosave\\季度规划\\20261010_034112_502.emmx", 1);
    ok(
      "Rust 那一种取倒数第二段当文档名",
      autosaveNote(rust).includes("「季度规划」"),
      autosaveNote(rust)
    );
    const web = item("季度规划", 1);
    ok("浏览器那一种直接用 key", autosaveNote(web).includes("「季度规划」"), autosaveNote(web));
    const odd = item("D:/a/b/一个不像时间戳的文件名", 1);
    ok(
      "文件名不是时间戳 ⇒ 就报文件名，不许把整条路径塞进引号里",
      autosaveNote(odd).includes("「一个不像时间戳的文件名」") &&
        !autosaveNote(odd).includes("D:/a/b"),
      autosaveNote(odd)
    );
    ok("句子仍然完整", autosaveNote(odd).includes("自动保存快照"), autosaveNote(odd));
    // 恢复出来的那份文档，标题必须和提示语里报的是同一个名字 ——
    // 用快照文件名（Rust 那一种是时间戳）的话，用户会得到一份叫 20261010_041532_997 的文档。
    eq("恢复用的标题取文档名", snapshotTitle(rust), "季度规划（自动保存）");
    eq("浏览器那一种也是同一个名字", snapshotTitle(web), "季度规划（自动保存）");
    eq(
      "文件名不是时间戳 ⇒ 标题就用那个文件名，不许露出路径",
      snapshotTitle(odd),
      "一个不像时间戳的文件名（自动保存）"
    );
  }

  done();
}

void main();
