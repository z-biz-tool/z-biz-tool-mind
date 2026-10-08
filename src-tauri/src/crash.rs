//! 崩溃记录：只写本机，不上传。
//!
//! 为什么单独一个目录而不是走 `log.rs`：崩溃要**按次**留证据（一次一个文件，带栈），
//! 而运行日志是按天追加、还会按级别静音。两件事的保留策略和读者都不一样，
//! 混在一起就会出现"日志级别设成 off 之后崩溃也没记录"这种最坏的组合。
//!
//! 三条硬约束：
//! - **开关说了算**：`advanced.crashReport` 关着的时候，一个字节都不写（这是它对用户的承诺）。
//! - **记崩溃不能制造新的崩溃**：Rust 侧的 panic hook 吞掉所有写盘错误；
//!   前端那条路本来就在 `catch` 里，再失败只会在控制台多一行。
//! - **不上传**：亿图那条叫"崩溃上报"，我们只做本地留痕，界面里也照这个说。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use serde_json::Value;

use crate::config;

/// 目录里最多留几份。一份几十 KB，20 份上限等于最多多占 1 MB 磁盘。
const KEEP_FILES: usize = 20;
/// 栈文本截断：WebView 的 stack 能到几千行，全落盘只是把目录撑大。
const MAX_DETAIL_CHARS: usize = 8000;

static ENABLED: AtomicBool = AtomicBool::new(false);

pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// 启动与改设置时同步开关，返回实际生效值。
pub fn configure_from(cfg: &Value) -> bool {
    let on = cfg
        .get("advanced")
        .and_then(|a| a.get("crashReport"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    ENABLED.store(on, Ordering::Relaxed);
    on
}

pub fn dir() -> PathBuf {
    config::get_config_dir().join("crashes")
}

fn stamp() -> String {
    chrono::Local::now().format("%Y%m%d_%H%M%S_%3f").to_string()
}

/// 把消息压成一行并截断，理由同 `log.rs`：一条记录一行，grep 出来才看得下去。
fn one_line(text: &str, max: usize) -> String {
    let flat: String = text
        .chars()
        .map(|c| match c {
            '\n' | '\r' | '\t' => ' ',
            c => c,
        })
        .collect();
    let flat = flat.trim();
    if flat.chars().count() <= max {
        return flat.to_string();
    }
    let mut cut: String = flat.chars().take(max).collect();
    cut.push_str(" …(截断)");
    cut
}

/// 写一份崩溃记录，返回文件路径；开关关着返回 `Ok(None)`（不是错误 —— 那是用户要的行为）。
pub fn write_report(kind: &str, message: &str, detail: &str) -> Result<Option<PathBuf>, String> {
    if !enabled() {
        return Ok(None);
    }
    let name = format!("crash-{}-{}.txt", stamp(), one_line(kind, 20));
    let path = dir().join(name);
    let body = format!(
        "时间: {}\n应用: z-biz-tool-mind v{} ({}/{})\n类型: {}\n消息: {}\n\n详情:\n{}\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        one_line(kind, 40),
        one_line(message, 500),
        if detail.trim().is_empty() {
            "(无)".to_string()
        } else {
            detail.chars().take(MAX_DETAIL_CHARS).collect::<String>()
        }
    );
    config::write_private(&path, body.as_bytes())?;
    prune();
    crate::log::log(
        "error",
        "crash",
        &format!(
            "{}: {} → {}",
            one_line(kind, 40),
            one_line(message, 200),
            path.display()
        ),
    );
    Ok(Some(path))
}

/// 只留最新 KEEP_FILES 份。文件名以时间戳开头，字典序即时间序。
fn prune() -> usize {
    let d = dir();
    let entries = match std::fs::read_dir(&d) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    let mut names: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("crash-") && name.ends_with(".txt") {
            names.push(name);
        }
    }
    names.sort();
    let mut removed = 0;
    while names.len() > KEEP_FILES {
        let old = names.remove(0);
        if std::fs::remove_file(d.join(old)).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashInfo {
    pub dir: String,
    pub files: usize,
    pub bytes: u64,
    pub enabled: bool,
    /// 最近一份的文件名，供界面显示"上一次崩在什么时候"。
    pub latest: String,
}

pub fn info() -> CrashInfo {
    let d = dir();
    let mut files = 0usize;
    let mut bytes = 0u64;
    let mut names: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&d) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("crash-") && name.ends_with(".txt") {
                files += 1;
                if let Ok(m) = entry.metadata() {
                    bytes += m.len();
                }
                names.push(name);
            }
        }
    }
    names.sort();
    CrashInfo {
        dir: d.to_string_lossy().to_string(),
        files,
        bytes,
        enabled: enabled(),
        latest: names.last().cloned().unwrap_or_default(),
    }
}

/// Rust 侧兜底：panic 之前先把这一份落盘。
///
/// hook 里不能再 panic（`write_report` 的错误一律吞掉），否则默认 hook 被我们顶掉之后
/// 用户连"应用退出了"都看不到。所以这里只 best-effort，并且**不**用 `unwrap`。
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "（panic 载荷不是字符串）".to_string());
        let loc = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "位置未知".to_string());
        let _ = write_report("panic", &msg, &loc);
        eprintln!("[crash] panic: {} @ {}", msg, loc);
    }));
}

#[tauri::command]
pub fn crash_report(
    kind: String,
    message: String,
    detail: Option<String>,
) -> Result<Option<String>, String> {
    let path = write_report(
        &one_line(&kind, 40),
        &message,
        detail.as_deref().unwrap_or(""),
    )?;
    Ok(path.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn crash_info() -> Result<CrashInfo, String> {
    Ok(info())
}

#[tauri::command]
pub fn crash_open_dir() -> Result<String, String> {
    let d = dir();
    std::fs::create_dir_all(&d).map_err(|e| format!("创建崩溃记录目录失败: {}", e))?;
    let target = d.to_string_lossy().to_string();
    let spawned = if cfg!(target_os = "windows") {
        std::process::Command::new("explorer").arg(&target).spawn()
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(&target).spawn()
    } else {
        std::process::Command::new("xdg-open").arg(&target).spawn()
    };
    spawned.map_err(|e| format!("打开崩溃记录目录失败: {}", e))?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn isolated(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "z-mind-crash-{}-{}-{}",
            tag,
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::env::set_var("Z_MIND_CONFIG_DIR", &root);
        root
    }

    fn cfg(on: bool) -> Value {
        serde_json::json!({ "advanced": { "crashReport": on } })
    }

    #[test]
    fn switch_off_writes_nothing_at_all() {
        let _g = crate::lock_config_env();
        let root = isolated("off");
        let _ = std::fs::remove_dir_all(&root);
        configure_from(&cfg(false));
        assert!(!enabled());
        assert_eq!(write_report("render", "炸了", "stack").unwrap(), None);
        assert!(!dir().exists(), "关着的时候连目录都不该建出来");
        configure_from(&cfg(true));
        assert!(enabled());
        assert!(write_report("render", "炸了", "stack").unwrap().is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn report_carries_kind_message_and_location() {
        let _g = crate::lock_config_env();
        let root = isolated("body");
        let _ = std::fs::remove_dir_all(&root);
        configure_from(&cfg(true));
        let path = write_report("panic", "index out of bounds", "src/x.rs:12:3")
            .unwrap()
            .unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("类型: panic"), "实际 {text:?}");
        assert!(text.contains("消息: index out of bounds"));
        assert!(text.contains("src/x.rs:12:3"));
        assert!(text.contains("z-biz-tool-mind v"));
        assert!(path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("crash-"));
        assert_eq!(info().files, 1);
        assert!(info().latest.ends_with(".txt"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn multiline_detail_is_kept_but_message_is_flat() {
        let _g = crate::lock_config_env();
        let root = isolated("flat");
        let _ = std::fs::remove_dir_all(&root);
        configure_from(&cfg(true));
        let path = write_report("window", "第一行\n第二行\t带制表", "at a\nat b\nat c")
            .unwrap()
            .unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let 消息行 = text
            .lines()
            .find(|l| l.starts_with("消息:"))
            .unwrap_or_default();
        assert!(
            消息行.contains("第一行 第二行 带制表") && !消息行.contains('\n'),
            "消息必须压成一行，实际 {消息行:?}"
        );
        assert!(text.contains("at a\nat b"), "详情里的栈要留着换行");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_the_newest_twenty_reports_survive() {
        let _g = crate::lock_config_env();
        let root = isolated("prune");
        let _ = std::fs::remove_dir_all(&root);
        configure_from(&cfg(true));
        std::fs::create_dir_all(dir()).unwrap();
        for i in 0..(KEEP_FILES + 5) {
            std::fs::write(dir().join(format!("crash-2026{i:05}-render.txt")), b"x").unwrap();
        }
        std::fs::write(dir().join("notes.txt"), b"keep").unwrap();
        write_report("render", "又崩了一次", "").unwrap().unwrap();
        let left: Vec<String> = std::fs::read_dir(dir())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(
            left.iter()
                .filter(|n| n.starts_with("crash-") && n.ends_with(".txt"))
                .count(),
            KEEP_FILES,
            "实际 {left:?}"
        );
        assert!(left.contains(&"notes.txt".to_string()), "不该动别的文件");
        assert!(!left.contains(&"crash-202600000-render.txt".to_string()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unknown_config_falls_back_to_off() {
        let _g = crate::lock_config_env();
        let root = isolated("default");
        let _ = std::fs::remove_dir_all(&root);
        assert!(!configure_from(&serde_json::json!({})), "缺键就是关");
        assert!(!configure_from(
            &serde_json::json!({"advanced":{"crashReport":"yes"}})
        ));
        assert!(configure_from(&cfg(true)));
        let _ = std::fs::remove_dir_all(&root);
    }
}
