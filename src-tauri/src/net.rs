//! 代理设置 → WebView2 启动参数。
//!
//! 为什么只能这么接：AI 生成、模板库这些在线能力的请求是渲染端 `fetch` 出去的，
//! 走的是 WebView2 自己的网络栈，**不经过我们这一层的任何 HTTP 客户端**。
//! 所以「选项 → 网络」里的代理要么交给 WebView2，要么就只是一份永远不生效的装饰。
//!
//! WebView2 的入口是环境变量 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`，它只在
//! **核心创建那一刻**读一次，因此这里必须在 `Builder` 之前调用 `install()`。
//! 改完设置要重启应用才生效，这件事由界面直说，不做"看起来立刻生效"的假动作。
//!
//! macOS 上 Tauri 用的是 WKWebView（走 URLSession/系统代理设置），没有这个环境变量，
//! 手动代理在那里**不生效** —— `active=false` 如实报出去，不假装成功。

use serde::Serialize;
use serde_json::Value;

pub const PROXY_ENV: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";

const SCHEMES: [&str; 4] = ["http", "https", "socks4", "socks5"];

/// 一条 Chromium 开关。`None` = 跟随系统（不注入任何参数）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatus {
    /// 真正要附加给 WebView2 的参数串（可能为空）。
    pub arg: Option<String>,
    /// 这个设置在当前平台上是否真的会起作用。
    pub active: bool,
    /// 给用户看的那句话：生效就说生效，不起作用/没填完都直说。
    pub message: String,
}

/// Chromium 会把这串按空格拆成多个开关，地址里出现空格或引号等于让用户能往
/// 启动参数里塞别的东西（比如 `--disable-web-security`），所以白名单之外一律拒。
fn host_is_safe(host: &str) -> bool {
    !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':'))
}

fn split_scheme(host: &str) -> (Option<&'static str>, String) {
    if let Some(ix) = host.find("://") {
        let name = &host[..ix];
        let tail = host[ix + 3..].to_string();
        return (SCHEMES.iter().find(|s| **s == name).copied(), tail);
    }
    (None, host.to_string())
}

fn mode_of(cfg: &Value) -> String {
    cfg.get("network")
        .and_then(|x| x.get("proxyMode"))
        .and_then(|v| v.as_str())
        .unwrap_or("system")
        .to_string()
}

fn host_of(cfg: &Value) -> String {
    cfg.get("network")
        .and_then(|x| x.get("proxyHost"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// 端口夹到 0–65535：InputNumber 会给出 null / 浮点 / 越界值，这里统一成一个数。
/// `0` 专门留给"没填"，因为 proxy_arg 把它当未完成处理。
fn port_of(cfg: &Value) -> u16 {
    cfg.get("network")
        .and_then(|x| x.get("proxyPort"))
        .and_then(|v| v.as_f64())
        .map(|v| v.clamp(0.0, 65535.0) as u16)
        .unwrap_or(0)
}

/// 纯函数：设置三项 → 参数串或错误。写盘前也用它挡脏值。
///
/// "手动但还没填完"返回 `Ok(None)` 而不是错误：这一屏是改一下就落盘的，
/// 用户刚把档位切到手动、地址一个字都还没打，这时候存不下就是界面卡住。
pub fn proxy_arg(mode: &str, host: &str, port: u16) -> Result<Option<String>, String> {
    match mode.trim().to_ascii_lowercase().as_str() {
        "none" => Ok(Some("--no-proxy-server".to_string())),
        "manual" => {
            let bare_host = host.trim();
            if bare_host.is_empty() || port == 0 {
                return Ok(None);
            }
            let (scheme, bare) = split_scheme(&bare_host);
            if !host_is_safe(&bare) {
                return Err(format!(
                    "代理地址不合法: {bare_host}（只允许字母、数字、. - _ :，不能有空格或引号）"
                ));
            }
            let value = match scheme {
                Some(s) => format!("{s}://{bare}:{port}"),
                None => format!("{bare}:{port}"),
            };
            Ok(Some(format!("--proxy-server={value}")))
        }
        // system / 认不出的值都按"跟随系统"处理：这一档什么都不注入就是 WebView2 的默认行为。
        _ => Ok(None),
    }
}

/// 只描述，不碰环境变量 —— 界面每次打开网络分页都可以问一遍。
pub fn status(cfg: &Value) -> Result<ProxyStatus, String> {
    let mode = mode_of(cfg);
    let host = host_of(cfg);
    let port = port_of(cfg);
    let arg = proxy_arg(&mode, &host, port)?;
    let on_windows = cfg!(target_os = "windows");
    let incomplete = mode.eq_ignore_ascii_case("manual") && (host.is_empty() || port == 0);
    let message = if incomplete {
        format!(
            "代理：选了手动，但{}还没填，现在按跟随系统走。",
            if host.is_empty() {
                "地址"
            } else {
                "端口"
            }
        )
    } else {
        match arg.as_deref() {
            None => "代理：跟随系统设置。".to_string(),
            Some(_) if !on_windows => {
                "代理：macOS / Linux 的上网引擎只认系统代理，这里的手动设置不会生效；请在系统的网络设置里配置代理。".to_string()
            }
            Some(_) if mode.eq_ignore_ascii_case("none") => {
                "代理：已设为不使用代理（下次启动生效）。".to_string()
            }
            Some(a) => format!("代理：手动 {a}（下次启动生效）。"),
        }
    };
    Ok(ProxyStatus {
        active: arg.is_some() && on_windows,
        arg,
        message,
    })
}

/// 启动前安装：写环境变量，返回实际发生了什么。非 Windows 上不写（写了也没人读）。
pub fn install(cfg: &Value) -> Result<ProxyStatus, String> {
    let st = status(cfg)?;
    if let (true, Some(arg)) = (st.active, st.arg.as_ref()) {
        let merged = match std::env::var(PROXY_ENV) {
            Ok(prev) if !prev.trim().is_empty() => format!("{prev} {arg}"),
            _ => arg.clone(),
        };
        std::env::set_var(PROXY_ENV, merged);
    }
    Ok(st)
}

/// 落盘前的归一：只有手动档才需要地址与端口，切走就把它们清空。
///
/// 为什么不能只靠 `validate`：它按档位调用 `proxy_arg`，而 `proxy_arg` 对非手动档直接
/// 返回 `Ok(None)`，压根不看地址。于是「手动 → 填一个带空格的坏地址 → 切回跟随系统」
/// 这条路上，坏值会被原样写进 config.json（实测发生过）。它今天不生效，但用户哪天
/// 再切回手动，界面就会带着这个脏值报"代理地址不合法"，而那一步他什么都没改。
/// 清空比拒绝好：拒绝会让"切走"这个动作本身卡住。
pub fn sanitize(cfg: &mut Value) -> bool {
    if mode_of(cfg).trim().eq_ignore_ascii_case("manual") {
        return false;
    }
    if host_of(cfg).is_empty() && port_of(cfg) == 0 {
        return false;
    }
    if let Some(net) = cfg.get_mut("network").and_then(|n| n.as_object_mut()) {
        net.insert("proxyHost".into(), Value::String(String::new()));
        net.insert("proxyPort".into(), serde_json::json!(0));
    }
    crate::log::log(
        "debug",
        "config",
        "非手动档，代理地址与端口已清空（只有手动这一档会用它们）",
    );
    true
}

/// 校验一份配置里的网络设置（config_set 在落盘前调用，脏值不进文件）。
pub fn validate(cfg: &Value) -> Result<(), String> {
    proxy_arg(&mode_of(cfg), &host_of(cfg), port_of(cfg)).map(|_| ())
}

#[tauri::command]
pub fn proxy_status() -> Result<ProxyStatus, String> {
    status(&crate::config::read_config())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(mode: &str, host: &str, port: u16) -> Value {
        serde_json::json!({ "network": { "proxyMode": mode, "proxyHost": host, "proxyPort": port } })
    }

    #[test]
    fn three_modes_map_to_three_different_outcomes() {
        assert_eq!(proxy_arg("system", "", 0).unwrap(), None);
        assert_eq!(
            proxy_arg("none", "1.2.3.4", 8080).unwrap().as_deref(),
            Some("--no-proxy-server"),
            "选了不用代理时，填着的地址也不能被当成代理用"
        );
        assert_eq!(
            proxy_arg("manual", "127.0.0.1", 7890).unwrap().as_deref(),
            Some("--proxy-server=127.0.0.1:7890")
        );
        // 认不出的值按跟随系统，不注入垃圾参数
        assert_eq!(proxy_arg("自动", "x", 1).unwrap(), None);
    }

    #[test]
    fn half_typed_manual_proxy_is_storable_but_injects_nothing() {
        // 这一屏是逐键落盘的：刚切到手动、地址或端口还空着，必须存得下。
        assert_eq!(proxy_arg("manual", "", 8080).unwrap(), None);
        assert_eq!(proxy_arg("manual", "   ", 8080).unwrap(), None);
        assert_eq!(proxy_arg("manual", "127.0.0.1", 0).unwrap(), None);
        let st = status(&cfg("manual", "127.0.0.1", 0)).unwrap();
        assert!(!st.active);
        assert!(
            st.message.contains("端口还没填") && st.message.contains("按跟随系统走"),
            "要说清楚缺哪一项，实际 {:?}",
            st.message
        );
        assert!(validate(&cfg("manual", "", 0)).is_ok(), "没填完不是错误");
    }

    #[test]
    fn scheme_prefix_is_preserved() {
        assert_eq!(
            proxy_arg("manual", "socks5://10.0.0.1", 1080).unwrap().as_deref(),
            Some("--proxy-server=socks5://10.0.0.1:1080")
        );
        // 认不出的协议名不当成 scheme，也别把前缀留在地址里
        assert_eq!(
            proxy_arg("manual", "ftp://a.b", 21).unwrap().as_deref(),
            Some("--proxy-server=a.b:21")
        );
    }

    #[test]
    fn hostile_hosts_cannot_smuggle_extra_switches() {
        // 这串会被 WebView2 按空格拆成两个开关，等于往启动参数里注入。
        for bad in [
            "127.0.0.1 --disable-web-security",
            "a.b:8080 --user-data-dir=C:\\x",
            "evil\".com",
            "127.0.0.1:8;127.0.0.1:9",
            "a b",
        ] {
            assert!(
                proxy_arg("manual", bad, 8080).is_err(),
                "应拒绝: {bad:?}"
            );
            assert!(
                validate(&cfg("manual", bad, 8080)).is_err(),
                "落盘前也要拦住: {bad:?}"
            );
        }
    }

    #[test]
    fn leaving_manual_clears_the_stored_address() {
        // 这是实测出来的回归：坏地址在手动档被 validate 拦住，切回跟随系统时却整个存进了文件。
        let mut v = cfg("manual", "127.0.0.1 --disable-web-security", 7890);
        v["network"]["proxyMode"] = Value::String("system".into());
        assert!(validate(&v).is_ok(), "非手动档 validate 不看地址，所以拦不住");
        assert!(sanitize(&mut v), "切走档位要把地址端口清掉");
        assert_eq!(v["network"]["proxyHost"], Value::String(String::new()));
        assert_eq!(port_of(&v), 0);
        // 清完再切回手动，不会再顶着上一个档位没来得及校验的脏值
        v["network"]["proxyMode"] = Value::String("manual".into());
        assert!(validate(&v).is_ok());
        assert!(!sanitize(&mut v), "手动档不能动用户填的东西");
    }

    #[test]
    fn sanitize_is_idempotent_and_ignores_other_pages() {
        let mut v: Value = serde_json::from_str(r#"{"general":{"theme":"dark"},"network":{"proxyMode":"none","proxyHost":"","proxyPort":0}}"#).unwrap();
        assert!(!sanitize(&mut v), "本来就干净，不该报成改动过");
        assert_eq!(v["general"]["theme"], Value::String("dark".into()));
        let mut manual = cfg("manual", "socks5://10.0.0.1", 1080);
        assert!(!sanitize(&mut manual));
        assert_eq!(host_of(&manual), "socks5://10.0.0.1");
        // 缺 network 一节不能panic
        let mut bare: Value = serde_json::json!({});
        assert!(!sanitize(&mut bare));
    }

    #[test]
    fn status_reports_only_windows_as_active() {
        let manual = status(&cfg("manual", "127.0.0.1", 7890)).unwrap();
        assert_eq!(manual.active, cfg!(target_os = "windows"));
        assert!(manual.arg.is_some());
        assert!(manual.message.contains("下次启动生效") || manual.message.contains("系统代理"));

        let sys = status(&cfg("system", "", 0)).unwrap();
        assert_eq!(sys.arg, None);
        assert!(!sys.active, "跟随系统不需要注入，也就谈不上生效");
        assert_eq!(sys.message, "代理：跟随系统设置。");
    }

    #[test]
    fn port_from_json_is_clamped_and_never_illegal() {
        let float: Value =
            serde_json::from_str(r#"{"network":{"proxyMode":"manual","proxyHost":"a.b","proxyPort":7890.0}}"#)
                .unwrap();
        assert_eq!(
            status(&float).unwrap().arg.as_deref(),
            Some("--proxy-server=a.b:7890")
        );
        let over: Value =
            serde_json::from_str(r#"{"network":{"proxyMode":"manual","proxyHost":"a.b","proxyPort":99999}}"#)
                .unwrap();
        // 越界的输入夹回边界，产出的仍然是一条合法开关
        assert_eq!(
            status(&over).unwrap().arg.as_deref(),
            Some("--proxy-server=a.b:65535")
        );
        let neg: Value =
            serde_json::from_str(r#"{"network":{"proxyMode":"manual","proxyHost":"a.b","proxyPort":-5}}"#)
                .unwrap();
        assert_eq!(port_of(&neg), 0, "负数端口当没填");
        assert_eq!(status(&neg).unwrap().arg, None);
    }

    #[test]
    fn missing_network_section_falls_back_to_system() {
        let v: Value = serde_json::json!({});
        let st = status(&v).unwrap();
        assert_eq!(st.arg, None);
        assert!(validate(&v).is_ok());
    }

    /// 装好的应用在本机验证时靠这条环境变量开 CDP 调试口；覆盖掉它就是自己把后门关了。
    #[cfg(windows)]
    #[test]
    fn install_keeps_existing_browser_arguments() {
        let _g = crate::lock_config_env();
        std::env::set_var(PROXY_ENV, "--remote-debugging-port=9223");
        let st = install(&cfg("manual", "127.0.0.1", 7890)).unwrap();
        assert!(st.active, "Windows 上手动代理就是要起作用");
        let got = std::env::var(PROXY_ENV).unwrap();
        assert!(
            got.starts_with("--remote-debugging-port=9223 "),
            "原有的启动参数必须留着，实际 {got}"
        );
        assert!(got.contains("--proxy-server=127.0.0.1:7890"), "实际 {got}");

        // 跟随系统 = 什么都不注入，也就一个字都不改
        std::env::set_var(PROXY_ENV, "--only-debug");
        install(&cfg("system", "", 0)).unwrap();
        assert_eq!(std::env::var(PROXY_ENV).unwrap(), "--only-debug");

        // 没填完的手动档同样不能污染环境变量
        std::env::set_var(PROXY_ENV, "--only-debug");
        install(&cfg("manual", "127.0.0.1", 0)).unwrap();
        assert_eq!(std::env::var(PROXY_ENV).unwrap(), "--only-debug");
        std::env::remove_var(PROXY_ENV);
    }
}
