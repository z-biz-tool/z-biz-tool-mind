//! 会员许可（license）：兑换码验签 + 本机许可文件读写。
//!
//! 方案全文见 `z-biz-tool-lead/doc/品牌与商业化/01_mind会员收银台方案.md`。
//!
//! ## 安全模型
//!
//! - **私钥只在签发侧**（lead 的 `scripts/issue-license.mjs`，存在 `~/.zbiz/`），
//!   绝不进任何仓库、绝不进客户端二进制。
//! - **客户端只内置公钥**，且必须是**编译期常量** —— 一旦改成从外部文件读，
//!   用户改一个文本文件就能把「是不是会员」改成真，整个闸门归零。
//! - **验签与「是不是会员」的判定全部在本模块**（Rust 侧）。前端只读
//!   `license_status()` 的结果；前端没有任何能被绕过或伪造的会员态。
//! - **每次读取都重新验签**，而不是读完就信：`license.json` 是用户可写的普通文件，
//!   手改 `tier` / `issued` 会立刻让签名校验失败、退回非会员。
//!
//! ## 为什么是 ed25519 而不是对称签名
//!
//! 对称方案（HMAC）意味着**客户端持有验签密钥**，用户反编译取出即可自己签码。
//! ed25519 下私钥只在签发侧，客户端只有公钥 —— 拿到公钥推不出私钥。
//!
//! ## 兑换码格式
//!
//! ```text
//! ZBIZ-MIND-<base64url(payload)>.<base64url(signature)>
//! payload   = {"v":1,"product":"mind","tier":"member","issued":"YYYY-MM-DD","nonce":"<16 hex>"}
//! signature = ed25519(payload 原始字节)，64 字节
//! ```
//!
//! 编码用 base64url（RFC 4648 §5，`-` `_` 替代 `+` `/`，不带 `=` 补位）：
//! 两端各一行转换，没有 base62 那种大整数需求 —— 2026-10-31 实测 base62 解码在
//! Rust 侧直接撞 u128 溢出（150 字节载荷的数值远超 u128），而 base64url 两端都是原生能力。

use std::path::PathBuf;

use data_encoding::{BASE64URL_NOPAD, HEXLOWER};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::config::write_private;
use crate::log;

/// 兑换码前缀。必须与签发侧 `issue-license.mjs` 的 `CODE_PREFIX` 一致 ——
/// lead 的 `verify-license-integrity.mjs` 会在 CI 里比对两端的常量。
const CODE_PREFIX: &str = "ZBIZ-MIND-";

/// 载荷版本。对应签发侧的 `PAYLOAD_VERSION`；升版本时旧码要能给出可懂的提示。
const PAYLOAD_VERSION: u64 = 1;

/// 本兑换码只服务的产品。跨产品复用同一个码是签发侧的笔误，要在客户端拦下。
const EXPECTED_PRODUCT: &str = "mind";

/// 会员档位。将来若有「专业档」，这里加一个常量、`check_fields` 改成白名单即可。
const EXPECTED_TIER: &str = "member";

/// 内置公钥（32 字节 hex）—— **编译期常量，不读外部文件**。
///
/// 与签发侧私钥 `~/.zbiz/license-signing.key` 对应。两端一致性由两道闸门保证：
/// - 签发工具本地自检：加载私钥后会推导出公钥，与它的 `PUBKEY_HEX` 不一致就拒绝签名
///   （防「密钥文件被换过但没人发现，于是发出的码客户端全都不认」）。
/// - lead 的 `verify-license-integrity.mjs`（CI）：比对本常量与签发工具的常量。
///
/// 公钥本身可以公开：拿到公钥推不出私钥。
const PUBLIC_KEY_HEX: &str = "67a61b17d8cb10d8bcd1ca2d425877a4bb2d8130892c4af524f0f772f8a92bbe";

const LICENSE_FILE: &str = "license.json";

fn license_path() -> PathBuf {
    crate::config::get_config_dir().join(LICENSE_FILE)
}

/// 内置公钥。解析失败会一路把兑换/读取带成「非会员」—— fail closed。
fn embedded_key() -> Result<VerifyingKey, String> {
    let bytes = HEXLOWER
        .decode(PUBLIC_KEY_HEX.as_bytes())
        .map_err(|e| format!("内置公钥解码失败: {}", e))?;
    let arr: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| "内置公钥长度不是 32 字节".to_string())?;
    VerifyingKey::from_bytes(&arr).map_err(|e| format!("内置公钥不合法: {}", e))
}

/// 兑换码载荷。字段与签发侧的 payload 一一对应。
#[derive(Debug, Clone, Deserialize, Serialize)]
struct Payload {
    v: u64,
    product: String,
    tier: String,
    issued: String,
    nonce: String,
    /// 签发时的备注（例如「内测赠送」）。只作展示，不参与任何判定。
    #[serde(default)]
    #[allow(dead_code)]
    note: Option<String>,
}

/// 本机许可文件的内容。
///
/// 存的是**兑换码原文**而不是解析后的字段：这样 `status()` 与 `redeem()` 走的是
/// 同一条验签路径，不存在「落盘时验过、读取时只信字段」这种分叉 ——
/// 分叉处就是被改动的地方。
#[derive(Debug, Clone, Deserialize, Serialize)]
struct StoredLicense {
    code: String,
    redeemed_at: String,
}

/// 前端可见的会员态。`reason` 是中文整句，直接展示，前端不需要再拼文案。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    /// 是否是可用的会员（验签通过且字段合规）。
    pub active: bool,
    /// `member` | `free` | `invalid`。`invalid` = 有许可文件但校验不过。
    pub state: String,
    /// 档位，当前恒为 `member` 或 `free`。
    pub tier: String,
    /// 签发日期（`YYYY-MM-DD`），未激活为空串。
    pub issued: String,
    /// 兑换时间（本机本地时间），未激活为空串。
    pub redeemed_at: String,
    /// 非会员时说明为什么；会员时为空串。
    pub reason: String,
}

fn free_status(reason: &str) -> LicenseStatus {
    LicenseStatus {
        active: false,
        state: "free".into(),
        tier: "free".into(),
        issued: String::new(),
        redeemed_at: String::new(),
        reason: reason.into(),
    }
}

/// 有许可文件但验不过：与「从没兑换过」区分开，用户才知道该做什么。
fn invalid_status() -> LicenseStatus {
    LicenseStatus {
        active: false,
        state: "invalid".into(),
        tier: "free".into(),
        issued: String::new(),
        redeemed_at: String::new(),
        reason: "许可校验未通过（许可文件可能已被改动），请重新兑换".into(),
    }
}

/// base64url 解码。签发侧不带 `=` 补位；用户从聊天窗口/邮件里复制时
/// 可能被补上或带进空白，容忍这两样，其余严格。
fn decode_b64url(s: &str) -> Result<Vec<u8>, String> {
    let trimmed = s.trim().trim_end_matches('=');
    BASE64URL_NOPAD
        .decode(trimmed.as_bytes())
        .map_err(|e| format!("兑换码编码不合法: {}", e))
}

/// 载荷字段合规检查。
///
/// 拆成独立纯函数是为了可测：验签需要签名才能走到这一步，而「签发侧笔误写错产品」
/// 这类分支不该依赖一把真私钥才测得到。
fn check_fields(p: &Payload) -> Result<(), String> {
    if p.v != PAYLOAD_VERSION {
        return Err(format!(
            "兑换码版本 v{} 不受支持（本客户端只认 v{}），请升级客户端",
            p.v, PAYLOAD_VERSION
        ));
    }
    if p.product != EXPECTED_PRODUCT {
        return Err(format!("兑换码属于产品 {}，不能在 mind 中使用", p.product));
    }
    if p.tier != EXPECTED_TIER {
        return Err(format!("兑换码档位 {} 不是会员档", p.tier));
    }
    if p.issued.trim().is_empty() {
        return Err("兑换码缺少签发日期".into());
    }
    Ok(())
}

/// 用指定公钥验一张兑换码。
///
/// 顺序是 **先验签、再解析、再查字段**：签名没过就绝不看内容 ——
/// 否则报错文案会替攻击者确认「哪一处字段被判错了」，
/// 而这些内容本来一律不该被信任。
fn verify_with(key: &VerifyingKey, code: &str) -> Result<Payload, String> {
    let code = code.trim();
    let Some(rest) = code.strip_prefix(CODE_PREFIX) else {
        return Err("兑换码前缀不对（应为 ZBIZ-MIND- 开头）".into());
    };
    let parts: Vec<&str> = rest.split('.').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Err("兑换码格式不对（应为 ZBIZ-MIND-<载荷>.<签名>）".into());
    }
    let payload_bytes = decode_b64url(parts[0])?;
    let sig_bytes = decode_b64url(parts[1])?;
    if sig_bytes.len() != 64 {
        return Err(format!(
            "签名字节数不对（应为 64，实际 {}）",
            sig_bytes.len()
        ));
    }
    let sig = Signature::from_slice(&sig_bytes).map_err(|e| format!("签名格式不对: {}", e))?;
    key.verify(&payload_bytes, &sig)
        .map_err(|_| "签名校验不通过：兑换码不是本产品签发的，或已被改动".to_string())?;
    let payload: Payload = serde_json::from_slice(&payload_bytes)
        .map_err(|e| format!("兑换码载荷不是合法 JSON: {}", e))?;
    check_fields(&payload)?;
    Ok(payload)
}

fn now_local() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// 读取当前会员态。任何一步异常都收敛成「非会员」，绝不 panic ——
/// 读个状态不该让应用挂掉。
pub fn status() -> LicenseStatus {
    match embedded_key() {
        Ok(key) => status_with(&key),
        // 内置公钥坏了 = 这台机器上没人能被验成会员，属于「fail closed」，
        // 但要留下日志，不然表现为「用户兑换了却没生效」，无从查起。
        Err(e) => {
            log::log(
                "error",
                "license",
                &format!("内置许可公钥不可用，按非会员处理: {e}"),
            );
            free_status("内置许可公钥不可用，请升级客户端")
        }
    }
}

fn status_with(key: &VerifyingKey) -> LicenseStatus {
    let text = match std::fs::read_to_string(license_path()) {
        Ok(t) => t,
        Err(_) => {
            return free_status("尚未激活会员：可在「选项 → 会员」中输入兑换码激活");
        }
    };
    let stored: StoredLicense = match serde_json::from_str(&text) {
        Ok(s) => s,
        Err(_) => {
            log::log("warn", "license", "许可文件不是合法 JSON，按非会员处理");
            return invalid_status();
        }
    };
    match verify_with(key, &stored.code) {
        Ok(p) => LicenseStatus {
            active: true,
            state: "member".into(),
            tier: p.tier,
            issued: p.issued,
            redeemed_at: stored.redeemed_at,
            reason: String::new(),
        },
        Err(e) => {
            // 手改 license.json、密钥轮换过、或者文件被截断，都会落到这条。
            log::log(
                "warn",
                "license",
                &format!("许可校验未通过，按非会员处理: {e}"),
            );
            invalid_status()
        }
    }
}

/// 兑换一张兑换码。验不过就直接报错，**不落盘** ——
/// 否则一次手滑的粘贴会把用户原本有效的许可覆盖掉。
pub fn redeem(code: &str) -> Result<LicenseStatus, String> {
    redeem_with(&embedded_key()?, code)
}

fn redeem_with(key: &VerifyingKey, code: &str) -> Result<LicenseStatus, String> {
    let payload = verify_with(key, code)?;
    let stored = StoredLicense {
        code: code.trim().to_string(),
        redeemed_at: now_local(),
    };
    let text =
        serde_json::to_string_pretty(&stored).map_err(|e| format!("序列化许可文件失败: {}", e))?;
    write_private(&license_path(), text.as_bytes())?;
    log::log(
        "info",
        "license",
        &format!("兑换成功：{} 档，签发日 {}", payload.tier, payload.issued),
    );
    Ok(status_with(key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    /// 测试沙盒。`redeem` 会写 license.json，必须指到临时目录。
    /// **必须已持有 `crate::lock_config_env()`** —— 环境变量是进程级的，
    /// 不拿锁就改等于把别人的沙盒换掉（见 lib.rs 里的事故记录）。
    fn isolated(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "z-mind-license-{}-{}-{}",
            tag,
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::env::set_var("Z_MIND_CONFIG_DIR", &dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 一把**测试**密钥，从固定 32 字节种子构造。
    ///
    /// ed25519 的种子是任意 32 字节，所以不需要引 rand —— 用固定种子还有个好处：
    /// 测试可复现，不随每次运行的随机数变。
    ///
    /// 私钥只活在测试内存里，不落盘、不进仓库：一张**能用的**兑换码如果落进
    /// 公开仓库，等于把会员白送出去 —— 本机许可没有服务端核销，
    /// 同一张码可以在每台机器上各兑一次。
    fn test_key(seed: u8) -> (SigningKey, VerifyingKey) {
        let sk = SigningKey::from_bytes(&[seed; 32]);
        let vk = sk.verifying_key();
        (sk, vk)
    }

    /// 造一张指定私钥签出来的兑换码。
    fn make_code(sk: &SigningKey, mutate: impl FnOnce(&mut serde_json::Value)) -> String {
        let mut payload = serde_json::json!({
            "v": PAYLOAD_VERSION,
            "product": EXPECTED_PRODUCT,
            "tier": EXPECTED_TIER,
            "issued": "2026-10-31",
            "nonce": "0011223344556677",
        });
        mutate(&mut payload);
        let bytes = serde_json::to_vec(&payload).unwrap();
        let sig = sk.sign(&bytes);
        format!(
            "{}{}.{}",
            CODE_PREFIX,
            BASE64URL_NOPAD.encode(&bytes),
            BASE64URL_NOPAD.encode(&sig.to_bytes())
        )
    }

    /// **核心阴性对照**：一张格式完全正确、字段完全合法，但由**别的**私钥签出来的
    /// 兑换码，内置公钥必须拒绝。
    ///
    /// 这条是客户端这条链上唯一无法在 CI 里用真私钥覆盖的环节（私钥不该进 CI），
    /// 所以它必须自己有牙齿：一旦有人把 `verify_code` 换成「跳过验签」，
    /// 或把公钥常量改成测试用的那把，这条会立刻变红。
    #[test]
    fn embedded_key_rejects_a_foreign_signature() {
        let (sk, _vk) = test_key(1);
        let code = make_code(&sk, |_| {});
        let key = embedded_key().unwrap();
        assert!(
            verify_with(&key, &code).is_err(),
            "别家私钥签的码不该被内置公钥验过"
        );
    }

    /// 上一条的**阳性对照**：同一张码用它自己的公钥必须验得过。
    /// 没有这条，上一条可能因为「码本身造错了」而通过 —— 那样的判据是假的。
    #[test]
    fn the_same_code_verifies_under_its_own_key() {
        let (sk, vk) = test_key(1);
        let code = make_code(&sk, |_| {});
        let p = verify_with(&vk, &code).unwrap();
        assert_eq!(p.product, EXPECTED_PRODUCT);
        assert_eq!(p.tier, EXPECTED_TIER);
        assert_eq!(p.issued, "2026-10-31");
    }

    #[test]
    fn empty_and_malformed_codes_are_rejected() {
        let key = embedded_key().unwrap();
        for bad in [
            "",
            "   ",
            "ZBIZ-MIND-",
            "ZBIZ-MIND-abc",         // 没有分隔点
            "ZBIZ-MIND-abc.def.ghi", // 多了一个点
            "ZBIZ-MIND-.def",        // 载荷为空
            "ZBIZ-MIND-abc.",        // 签名为空
            "HELLO-abc.def",         // 前缀不对
            "ZBIZ-MIND-!!!not-base64!!.AAAA",
        ] {
            assert!(
                verify_with(&key, bad).is_err(),
                "该被拒绝的兑换码没被拒绝: {bad:?}"
            );
        }
    }

    #[test]
    fn a_short_signature_is_rejected() {
        let (sk, _vk) = test_key(2);
        let code = make_code(&sk, |_| {});
        let (p, s) = split_code(&code);
        // 砍掉签名最后一个字符 ⇒ 不是 64 字节。
        let broken = format!("{}{}.{}", CODE_PREFIX, p, &s[..s.len() - 1]);
        assert!(verify_with(&embedded_key().unwrap(), &broken).is_err());
    }

    /// 拆开兑换码，返回（载荷 base64, 签名 base64），前缀已去掉。
    ///
    /// **前缀必须先去掉**：`ZBIZ-MIND-` 里的字符全都在 base64url 字母表内
    /// （`-` 正是 base64url 的第 63 号字符），留着它去解码不会报「有非法字符」，
    /// 而是解出一段毫无意义的字节 —— 第一版测试就栽在这里。
    fn split_code(code: &str) -> (String, String) {
        let rest = code
            .strip_prefix(CODE_PREFIX)
            .expect("测试造的码都该带前缀");
        let (p, s) = rest.split_once('.').expect("测试造的码都该有分隔点");
        (p.to_string(), s.to_string())
    }

    /// 篡改载荷的一个字节 ⇒ 签名校验必须失败。
    #[test]
    fn a_tampered_payload_is_rejected() {
        let (sk, vk) = test_key(3);
        let code = make_code(&sk, |_| {});
        let (p, s) = split_code(&code);
        let mut bytes = decode_b64url(&p).unwrap();
        bytes[0] ^= 0x01;
        let broken = format!("{}{}.{}", CODE_PREFIX, BASE64URL_NOPAD.encode(&bytes), s);
        assert!(
            verify_with(&vk, &broken).is_err(),
            "改过一个字节就不该验得过"
        );
    }

    #[test]
    fn wrong_fields_are_rejected() {
        let base = Payload {
            v: PAYLOAD_VERSION,
            product: EXPECTED_PRODUCT.into(),
            tier: EXPECTED_TIER.into(),
            issued: "2026-10-31".into(),
            nonce: "n".into(),
            note: None,
        };
        // 各自独立改一处，确认每一条判据都在工作（不是一条覆盖掉其它）。
        let mut wrong_v = base.clone();
        wrong_v.v = 99;
        assert!(check_fields(&wrong_v).is_err(), "版本不对要拦");

        let mut wrong_product = base.clone();
        wrong_product.product = "file".into();
        assert!(check_fields(&wrong_product).is_err(), "别的产品的码要拦");

        let mut wrong_tier = base.clone();
        wrong_tier.tier = "trial".into();
        assert!(check_fields(&wrong_tier).is_err(), "非会员档要拦");

        let mut empty_issued = base.clone();
        empty_issued.issued = "  ".into();
        assert!(check_fields(&empty_issued).is_err(), "缺签发日期要拦");

        assert!(check_fields(&base).is_ok(), "合规定位不该被拦");
    }

    /// 兑换 → 读取 → 改文件 → 读取，全链路。
    ///
    /// 用测试密钥注入（`redeem_with` / `status_with`），真私钥的端到端验收走
    /// `e2e_real_key_redeem`（`#[ignore]`，本地手动跑）。
    #[test]
    fn redeem_status_and_tamper_roundtrip() {
        let _g = crate::lock_config_env();
        let dir = isolated("roundtrip");
        let (sk, vk) = test_key(4);

        // 1) 未兑换 ⇒ free
        let s = status_with(&vk);
        assert!(!s.active);
        assert_eq!(s.state, "free");
        assert!(!s.reason.is_empty(), "非会员要给出原因");

        // 2) 兑换 ⇒ member
        let code = make_code(&sk, |_| {});
        let s = redeem_with(&vk, &code).unwrap();
        assert!(s.active, "兑换成功后应当是会员: {s:?}");
        assert_eq!(s.state, "member");
        assert_eq!(s.tier, "member");
        assert_eq!(s.issued, "2026-10-31");
        assert!(!s.redeemed_at.is_empty());

        // 3) 换一把钥匙读 ⇒ 必须退回 invalid（等价于「内置公钥换了 / 文件被改了」）
        let (_sk2, vk2) = test_key(5);
        let s = status_with(&vk2);
        assert!(!s.active);
        assert_eq!(s.state, "invalid");

        // 4) 手改许可文件里的码 ⇒ 验签失败，退回 invalid。
        //    这就是「本地文件改改就是会员」这条老路被堵死的地方。
        //
        //    注意改法：只翻载荷里的一个字节、**签名原样留着**。
        //    第一版在这里用同一把私钥重新签了一张合法的码，验签当然过 ——
        //    那测的是「合法码能通过」，跟篡改毫无关系。真正的用户动作是
        //    直接编辑 license.json 的文本，签名不可能跟着变。
        let path = license_path();
        let mut stored: StoredLicense =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let (p, s) = split_code(&stored.code);
        let mut bytes = decode_b64url(&p).unwrap();
        bytes[0] ^= 0x01;
        stored.code = format!("{}{}.{}", CODE_PREFIX, BASE64URL_NOPAD.encode(&bytes), s);
        std::fs::write(&path, serde_json::to_string(&stored).unwrap()).unwrap();
        let s = status_with(&vk);
        assert!(!s.active, "改动过的许可文件不该仍是会员");
        assert_eq!(s.state, "invalid");

        std::env::remove_var("Z_MIND_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 换一把签发密钥（等价于「密钥轮换 / 内置公钥被换成别人家的」）后，
    /// 原先兑的码必须立刻不再有效，而不是继续放行。
    #[test]
    fn a_new_signing_key_invalidates_the_old_license() {
        let _g = crate::lock_config_env();
        let dir = isolated("rotate");
        let (sk1, vk1) = test_key(6);
        let code = make_code(&sk1, |_| {});
        assert!(redeem_with(&vk1, &code).unwrap().active);

        let (_sk2, vk2) = test_key(7);
        assert!(!status_with(&vk2).active, "换了内置公钥后旧许可必须失效");
        assert_eq!(status_with(&vk2).state, "invalid");

        std::env::remove_var("Z_MIND_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 验不过的码不落盘：一次手滑的粘贴不该覆盖掉用户原本有效的许可。
    #[test]
    fn a_failed_redeem_does_not_clobber_an_existing_license() {
        let _g = crate::lock_config_env();
        let dir = isolated("clobber");
        let (sk, vk) = test_key(8);
        let good = make_code(&sk, |_| {});
        assert!(redeem_with(&vk, &good).unwrap().active);

        let before = std::fs::read_to_string(license_path()).unwrap();
        let bogus = make_code(&sk, |p| p["tier"] = serde_json::json!("trial"));
        assert!(redeem_with(&vk, &bogus).is_err());
        let after = std::fs::read_to_string(license_path()).unwrap();
        assert_eq!(before, after, "兑换失败不该动到已有许可文件");
        assert!(status_with(&vk).active, "原有会员态应保持不变");

        std::env::remove_var("Z_MIND_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 损坏的许可文件（不是合法 JSON）不能让应用崩，也不能被当成会员。
    #[test]
    fn a_corrupt_license_file_is_not_fatal_and_not_a_membership() {
        let _g = crate::lock_config_env();
        let dir = isolated("corrupt");
        let (_sk, vk) = test_key(9);
        std::fs::write(license_path(), "{{{ 这不是 json").unwrap();
        let s = status_with(&vk);
        assert!(!s.active);
        assert_eq!(s.state, "invalid");
        std::env::remove_var("Z_MIND_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 端到端验收：真签发私钥 → 兑换 → 会员态生效。
    ///
    /// 默认**不跑**（`#[ignore]`）：CI 里不该有私钥，测试源码里更不该有一张
    /// 能直接兑换的真码。本地验收时：
    ///
    /// ```text
    /// cargo test --lib license::tests::e2e_real_key -- --ignored --nocapture
    /// ```
    fn real_signing_key() -> Option<SigningKey> {
        let path = dirs::home_dir()?.join(".zbiz").join("license-signing.key");
        let raw = std::fs::read_to_string(&path).ok()?;
        let raw = data_encoding::BASE64.decode(raw.trim().as_bytes()).ok()?;
        if raw.len() != 64 {
            return None;
        }
        let seed: [u8; 32] = raw[..32].try_into().ok()?;
        Some(SigningKey::from_bytes(&seed))
    }

    /// 本机私钥文件本身没被拼坏：seed 推出的公钥 == 文件里存的公钥段，
    /// 且 == 客户端内置的那把（不是一对的话，签出的码客户端全都不认，
    /// 表现为「发了码用户却兑换不了」—— 最难查的一类不一致）。
    #[test]
    #[ignore = "需要本机签发私钥 ~/.zbiz/license-signing.key"]
    fn e2e_private_key_file_is_self_consistent() {
        let Some(sk) = real_signing_key() else {
            panic!("读不到可用的私钥文件");
        };
        let derived = HEXLOWER.encode(&sk.verifying_key().to_bytes());
        assert_eq!(derived, PUBLIC_KEY_HEX, "本机私钥与客户端内置公钥不是一对");
    }

    #[test]
    #[ignore = "需要本机签发私钥 ~/.zbiz/license-signing.key"]
    fn e2e_real_key_redeem() {
        let _g = crate::lock_config_env();
        let dir = isolated("e2e");
        let Some(sk) = real_signing_key() else {
            panic!("读不到可用的私钥文件");
        };
        let code = make_code(&sk, |_| {});
        let s = redeem(&code).expect("真私钥签的码应当兑换成功");
        assert!(s.active, "端到端兑换后应是会员: {s:?}");
        assert_eq!(s.tier, "member");
        assert_eq!(s.issued, "2026-10-31");
        std::env::remove_var("Z_MIND_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **跨语言端到端**：Node 签发工具（lead 的 `scripts/issue-license.mjs`）产出的码，
    /// Rust 客户端认不认。
    ///
    /// 上面那条 `e2e_real_key_redeem` 是**用 Rust 签、Rust 验** —— 它证明密钥是一对、
    /// 编码自洽，但证明不了两个实现对齐：载荷的字段顺序、`base64url` 是否带补位、
    /// 签名是 64 字节裸签名还是 DER —— 这三样只要有一样不一致，
    /// 表现就是「工具签得出码、用户兑不上」，而且**两边各自的测试都是绿的**。
    ///
    /// 所以这条测试不吃 Rust 造的码，只吃从外面喂进来的真码：
    ///
    /// ```text
    /// cd z-biz-tool-lead && node scripts/issue-license.mjs --product mind --tier member --issued 2026-10-31
    /// cd z-biz-tool-mind/src-tauri
    /// ZBIZ_E2E_CODE='ZBIZ-MIND-…' cargo test --lib license::tests::e2e_external_code -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "需要环境变量 ZBIZ_E2E_CODE 里放一张由 issue-license.mjs 签出的码"]
    fn e2e_external_code_from_node_issuer_is_accepted() {
        let _g = crate::lock_config_env();
        let code = std::env::var("ZBIZ_E2E_CODE").unwrap_or_else(|_| {
            panic!("没给 ZBIZ_E2E_CODE —— 先用 lead 的 issue-license.mjs 签一张，再把码放进来")
        });
        let dir = isolated("e2e-ext");
        let s = redeem(code.trim()).expect("外部签发工具产出的码必须能兑换");
        assert!(s.active, "外部码兑换后应是会员: {s:?}");
        assert_eq!(s.tier, "member");
        std::env::remove_var("Z_MIND_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
