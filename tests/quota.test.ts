/**
 * 免费档「已保存文件数」的记账（01 A-13）。
 *
 * 缺陷形状：保存闸门过去拿最近列表去重当"已经存过几个文件"，而 recentTouch 在**打开**文档时就调了 ——
 * 于是"打开过 10 份"变成"一个都存不了"，用户一份没存就被提示升级。
 * 修法是把账本从那张表里搬出去：只记真的落过盘的路径。
 * 这里同时钉住搬出去之后才补上的两个后门 ——
 * 最近列表的容量能在选项里调到 1 条，"清空最近文件"更是一键清整张表，
 * 账本跟着它们走的话，改一下设置就能无限保存。
 */
import { done, eq, ok } from "./_harness.ts";
import { native, type RecentItem } from "../src/services/native.ts";
import { useQuota } from "../src/stores/quotaStore.ts";
import { useRecent } from "../src/stores/recentStore.ts";
import { useDoc } from "../src/stores/docStore.ts";
import { canSave } from "../src/utils/entitlement.ts";
import { createHistory } from "../src/engine/history.ts";
import { createDocument } from "../src/model/factory.ts";
import { QUOTA } from "../src/model/constants.ts";

// 浏览器后备走 localStorage，node 里没有这个全局。装一份内存实现，让两端同一套判据可测。
const bucket = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => bucket.get(k) ?? null,
  setItem: (k: string, v: string) => void bucket.set(k, v),
  removeItem: (k: string) => void bucket.delete(k),
  clear: () => bucket.clear(),
  key: () => null,
  length: 0,
};

function recentItem(path: string): RecentItem {
  return { path, title: path, kind: "local", openedAt: Date.now(), pinned: false };
}

async function main(): Promise<void> {
  const paths = Array.from({ length: 12 }, (_, i) => `D:/docs/q${i}.emmx`);
  const doc = createDocument("配额测试");

  /* ---------------- A-13 本体：打开过 ≠ 存过 ---------------- */
  {
    for (const p of paths) await native.recentTouch(p, p, "local");
    eq("最近列表装了 12 份", (await native.recentList()).length, 12);
    eq("打开不留一笔账", (await native.quotaSavedList()).length, 0);

    // 旧写法在这里就判死了：used = 12 条最近路径 ⇒ "已保存 12 个文件" ⇒ 一个都存不了。
    useQuota.setState({ saved: [] });
    useRecent.setState({ recent: paths.map(recentItem) });
    useDoc.setState({ path: null, hist: createHistory(doc) });
    eq("读满十份之后仍然能保存", canSave(doc), { ok: true, reason: "" });
  }

  /* ---------------- 存满才拦，重复保存同一份不涨名额 ---------------- */
  {
    for (let i = 0; i < QUOTA.freeMaxFiles; i++) await native.quotaMarkSaved(paths[i]);
    eq("存过十份之后账上是十条", (await native.quotaSavedList()).length, 10);
    await native.quotaMarkSaved(paths[0]);
    eq("同一份再存一次不重复占名额", (await native.quotaSavedList()).length, 10);

    await useQuota.getState().refresh();
    eq("store 回读到的是同一份账", useQuota.getState().saved.length, 10);
    const gate = canSave(doc);
    ok("存满十份才该拦", !gate.ok, gate.reason);
    ok(
      "理由里带上限与实际数",
      gate.reason.includes(String(QUOTA.freeMaxFiles)) && gate.reason.includes("10"),
      gate.reason
    );
  }

  /* ---------------- 两条后门：调容量 / 清空列表都不该重置名额 ---------------- */
  {
    await native.recentClear();
    eq("清空最近文件之后列表空了", (await native.recentList()).length, 0);
    eq("但账本一条没少", (await native.quotaSavedList()).length, 10);

    await native.recentSetCapacity(1);
    for (let i = 0; i < 5; i++) await native.recentTouch(`D:/docs/evict${i}.emmx`, "E", "local");
    eq("容量调到 1 之后列表只剩一条", (await native.recentList()).length, 1);
    eq("列表容量管不着账本", (await native.quotaSavedList()).length, 10);

    // 旧写法在这里 both 失效：清一次列表 ⇒ used=0 ⇒ 又能存 10 份；调容量同理。
    await useQuota.getState().refresh();
    ok("清空列表后依然拦得住", !canSave(doc).ok);
  }

  /* ---------------- 删掉的文档该把名额还回来 ---------------- */
  {
    // 闸门文案写的是"请删除不需要的文件"，删了却不还名额那句话就是假的。
    const before = (await native.quotaSavedList()).length;
    await native.fileRemove(paths[3]);
    eq("删一份还一格", (await native.quotaSavedList()).length, before - 1);
    await useQuota.getState().refresh();
    ok("腾出格子之后就能存了", canSave(doc).ok);

    const trashed = (await native.trashList()).find((t) => t.docPath === paths[3]);
    const back = await native.trashRestore(trashed?.id ?? "");
    eq("放回盘上的重新占一格", (await native.quotaSavedList()).length, before);
    await useQuota.getState().refresh();
    ok("恢复之后又满了", !canSave(doc).ok, back);
  }

  /* ---------------- 当前打开的那一份不跟自己抢名额 ---------------- */
  {
    // 满格时重存已经在账上的文件必须放行：它没新增文件，只是把已有的那份盖掉。
    const counted = paths[0];
    useDoc.setState({ path: counted, hist: createHistory(doc) });
    ok("满格时覆盖自己已有的那份仍然放行", canSave(doc).ok);
    // 换成一个不在账上的路径，就是一次真的新增，该拦。
    useDoc.setState({ path: "D:/docs/brand-new.emmx" });
    ok("满格时另存成新文件要拦", !canSave(doc).ok);
    useDoc.setState({ path: null });
  }

  done();
}

void main();
