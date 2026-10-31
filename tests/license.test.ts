/**
 * 会员闸门与兑换（stores/licenseStore.ts、utils/entitlement.ts、settingsStore.spendAiPoints）。
 *
 * 这里最重要的一条是「闸门与扣点必须同一个判据」。
 *
 * 缺陷形状（真实发生过，不是假想）：canGenerate 先放开了会员，而扣点的
 * spendAiPoints 在另一个文件里自己判了一遍点数不足 —— 于是
 *   闸门说「可以生成」 → ai.ts 调 spendAiPoints → 返回 false → 当成计费失败拦下
 * 用户点了按钮毫无反应，界面上没有任何报错。两处分叉就是这么来的。
 * 所以这条测试**成对**断言：闸门放行 ⇔ 扣点也放行，任何一侧单独改都会红。
 *
 * 另一条是「坏码不能清掉已有会员态」：用户手滑粘了一张废码，
 * 不该把自己原本有效的许可一起弄丢。
 *
 * 验签本身不在这里（Rust 侧 license.rs 有 10 例单测 + 端到端）。
 * 前端拿到的 status 是 Rust 验完签的结果，这里用桩把它喂进来。
 */
import { done, eq, ok, rejects } from "./_harness.ts";
import { native, type LicenseStatus } from "../src/services/native.ts";
import { useLicense, isMember } from "../src/stores/licenseStore.ts";
import { canGenerate, canSave } from "../src/utils/entitlement.ts";
import { useSettings } from "../src/stores/settingsStore.ts";
import { useQuota } from "../src/stores/quotaStore.ts";
import { useDoc } from "../src/stores/docStore.ts";
import { createHistory } from "../src/engine/history.ts";
import { createDocument } from "../src/model/factory.ts";
import { QUOTA } from "../src/model/constants.ts";

const FREE: LicenseStatus = {
  active: false,
  state: "free",
  tier: "free",
  issued: "",
  redeemedAt: "",
  reason: "尚未激活会员：可在「选项 → 会员」中输入兑换码激活",
};

const MEMBER: LicenseStatus = {
  active: true,
  state: "member",
  tier: "member",
  issued: "2026-10-31",
  redeemedAt: "2026-10-31T08:00:00Z",
  reason: "",
};

/** 把会员态直接钉成某个值：闸门测的是「给定状态下的行为」，不该依赖一次 IPC。 */
function setLicense(s: LicenseStatus): void {
  useLicense.setState({ status: s, loading: false, redeeming: false, error: null });
}

async function main(): Promise<void> {
  /* ---------------- 免费档：数值一条都没变（阴性对照） ---------------- */
  //
  // 会员放行是**加在闸门开头**的分支，免费档的整段逻辑必须原样活着。
  // 少了这一组，"顺手把免费档也放开"这种改动会一路绿灯。
  {
    setLicense(FREE);
    const doc = createDocument("免费档");
    const full = Array.from({ length: QUOTA.freeMaxFiles }, (_, i) => `/d/f${i}.emmx`);
    useQuota.setState({ saved: full });
    useDoc.setState({ path: null, hist: createHistory(doc) });

    const r = canSave(doc);
    eq("免费档存满 10 份后被拦下", r.ok, false);
    ok("免费档的拦下理由提到了会员", /会员/.test(r.reason), r.reason);

    // 再减一份就该放行 —— 证明拦下的确是「数量」而不是别的条件。
    useQuota.setState({ saved: full.slice(0, -1) });
    eq("免费档少于 10 份时放行", canSave(doc).ok, true);

    const g = canGenerate(QUOTA.aiCharsPerPoint * 3, 10, 9);
    eq("免费档 10-9=1 点不够 3 点时拦下", g.ok, false);
    eq("免费档仍然算出 need（调用方拿它做提示）", g.need, 3);
    eq("免费档 1 点就够时放行", canGenerate(QUOTA.aiCharsPerPoint, 10, 9).ok, true);
  }

  /* ---------------- 会员：闸门放行 ---------------- */
  {
    setLicense(MEMBER);
    const doc = createDocument("会员档");
    useQuota.setState({
      saved: Array.from({ length: QUOTA.freeMaxFiles + 5 }, (_, i) => `/d/m${i}.emmx`),
    });
    useDoc.setState({ path: null, hist: createHistory(doc) });

    eq("会员存超 10 份仍放行", canSave(doc), { ok: true, reason: "" });

    // 字数再大也放行：会员没有点数这一说。
    const chars = QUOTA.aiCharsPerPoint * 9999;
    const g = canGenerate(chars, 0, 0);
    eq("会员在点数为 0 时仍放行", g.ok, true);
    eq("会员的 need 仍然算出来（进度提示要用）", g.need, 9999);
  }

  /* ---------------- 闸门与扣点同口径（本次修的真 bug） ---------------- */
  //
  // 这是整份测试的核心。删掉 settingsStore 里那句 `if (isMember()) return true;`
  // 之后，只有这一组会红 —— 其它每一条都还是绿的。
  {
    setLicense(MEMBER);
    useSettings.setState({
      settings: {
        ...useSettings.getState().settings,
        quota: { ...useSettings.getState().settings.quota, aiPoints: 10, aiUsed: 9 },
      },
    });
    const chars = QUOTA.aiCharsPerPoint * 5; // 要 5 点，只剩 1 点

    const g = canGenerate(chars, 10, 9);
    eq("会员闸门放行（只剩 1 点也要放行）", g.ok, true);

    const spent = await useSettings.getState().spendAiPoints(chars);
    eq("扣点也放行（两处判据必须同口径）", spent, true);
    eq("会员扣点后 aiUsed 一分没动", useSettings.getState().settings.quota.aiUsed, 9);

    // 阴性对照：同一个人在免费档下，这两件事必须同时为 false。
    // 只测会员侧的话，"把扣点改成无条件 true"也能通过 —— 那是把闸门废掉了。
    setLicense(FREE);
    eq("免费档闸门拦下", canGenerate(chars, 10, 9).ok, false);
    eq("免费档扣点也拦下", await useSettings.getState().spendAiPoints(chars), false);
    eq("免费档扣点后 aiUsed 没动", useSettings.getState().settings.quota.aiUsed, 9);

    // 点数够的时候免费档照常扣 —— 确认拦截是"点不够"而不是"永久不扣了"。
    useSettings.setState({
      settings: {
        ...useSettings.getState().settings,
        quota: { ...useSettings.getState().settings.quota, aiPoints: 100, aiUsed: 0 },
      },
    });
    eq("免费档点数够时照常扣", await useSettings.getState().spendAiPoints(chars), true);
    eq("免费档扣了 5 点", useSettings.getState().settings.quota.aiUsed, 5);
  }

  /* ---------------- isMember 就是 status.active ---------------- */
  {
    setLicense(FREE);
    eq("free 档 isMember() 为假", isMember(), false);
    setLicense(MEMBER);
    eq("member 档 isMember() 为真", isMember(), true);
    // 无效许可（验签没过）也是非会员 —— 界面上会显示 reason，闸门上一视同仁。
    setLicense({
      ...FREE,
      state: "invalid",
      reason: "许可校验未通过（许可文件可能已被改动），请重新兑换",
    });
    eq("invalid 档不是会员", isMember(), false);
  }

  /* ---------------- 兑换：桩掉 native，只测 store 的状态机 ---------------- */
  {
    const realStatus = native.licenseStatus;
    const realRedeem = native.licenseRedeem;
    try {
      /* —— 成功 —— */
      setLicense(FREE);
      let seenCode: string | null = null;
      native.licenseRedeem = async (code: string) => {
        seenCode = code;
        return MEMBER;
      };
      await useLicense.getState().redeem("  ZBIZ-MIND-abc.def  ");
      eq("兑换码送出去前先 trim", seenCode, "ZBIZ-MIND-abc.def");
      eq("兑换成功后状态变成会员", useLicense.getState().status.state, "member");
      eq("兑换成功后没有遗留错误", useLicense.getState().error, null);
      eq("兑换结束 redeeming 归位", useLicense.getState().redeeming, false);

      /* —— 空码：不调 native、不抛错、只留一句人话 —— */
      let called = 0;
      native.licenseRedeem = async () => {
        called += 1;
        return MEMBER;
      };
      setLicense(FREE);
      await useLicense.getState().redeem("   ");
      eq("空码不该打到后端", called, 0);
      eq("空码给出提示", useLicense.getState().error, "请输入兑换码。");
      eq("空码不改变状态", useLicense.getState().status.state, "free");

      /* —— 坏码：抛错、留错误、**不清掉已有会员态** —— */
      native.licenseRedeem = async () => {
        throw new Error("兑换码编码不合法: invalid length");
      };
      setLicense(MEMBER); // 先是会员，再手滑粘一张废码
      await rejects(
        "坏码向上抛（界面要显示这句）",
        useLicense.getState().redeem("ZBIZ-MIND-不是码"),
        "兑换码编码不合法"
      );
      eq("坏码的错误被留住", useLicense.getState().error, "兑换码编码不合法: invalid length");
      eq("坏码不清掉原有会员态", useLicense.getState().status.state, "member");
      eq("坏码后 redeeming 归位", useLicense.getState().redeeming, false);

      /* —— 非 Error 的 rejection 也要能显示（Rust 侧有时给字符串） —— */
      native.licenseRedeem = async () => {
        throw "兑换码已失效";
      };
      setLicense(FREE);
      await rejects("字符串 rejection 也向上抛", useLicense.getState().redeem("x"));
      eq("字符串 rejection 被字符串化", useLicense.getState().error, "兑换码已失效");

      /* —— 重复点：redeeming 期间第二次调用直接返回 —— */
      let calls = 0;
      // 用对象属性而不是 `let release = null`：赋值发生在闭包里，
      // TS 的控制流分析看不见，会把 release 一路窄化成 null（调用点报 never）。
      const gate: { open: (() => void) | null } = { open: null };
      native.licenseRedeem = async () => {
        calls += 1;
        await new Promise<void>((r) => {
          gate.open = r;
        });
        return MEMBER;
      };
      setLicense(FREE);
      const first = useLicense.getState().redeem("ZBIZ-MIND-a.b");
      const second = useLicense.getState().redeem("ZBIZ-MIND-a.b");
      eq("并发第二次没有再打后端", calls, 1);
      gate.open?.();
      await Promise.all([first, second]);
      eq(
        "并发期间 refresh 不插队（不会被旧结果盖回免费档）",
        useLicense.getState().status.state,
        "member"
      );
    } finally {
      native.licenseStatus = realStatus;
      native.licenseRedeem = realRedeem;
    }
  }

  /* ---------------- refresh：读失败时的取舍 ---------------- */
  //
  // 这里钉的是一个**有意的取舍**，不是"读失败就清零"：
  // catch 里只可能是 IPC 断了（Rust 验签失败走的是 Ok(invalid_status)，会正常 set 进来）。
  // 一次通信抖动不该把已验证的会员踢回去拦保存；而"从没读到过"的用户初值本来就是免费档，
  // 方向没有放松。改这条之前先想清楚这两边各伤到谁。
  {
    const realStatus = native.licenseStatus;
    try {
      // 启动那一路：初值 UNKNOWN（免费档），读失败 ⇒ 仍是免费档，不装会员。
      setLicense({
        active: false,
        state: "free",
        tier: "free",
        issued: "",
        redeemedAt: "",
        reason: "",
      });
      native.licenseStatus = async () => {
        throw new Error("IPC 断了");
      };
      await useLicense.getState().refresh();
      eq("从没读到过 + 读失败 ⇒ 免费档", isMember(), false);
      eq("读失败后 loading 归位", useLicense.getState().loading, false);

      // 已是会员的中途：读失败 ⇒ 保留会员态（抖动不踢人）。
      setLicense(MEMBER);
      await useLicense.getState().refresh();
      eq("已验证的会员 + 读失败 ⇒ 保留会员态", isMember(), true);

      // 读得到就一律用读到的 —— 包括把会员降回免费（Rust 那边 license.json 被删了）。
      native.licenseStatus = async () => FREE;
      await useLicense.getState().refresh();
      eq("读得到就用读到的（会员降回免费）", isMember(), false);
    } finally {
      native.licenseStatus = realStatus;
    }
  }

  done();
}

void main();
