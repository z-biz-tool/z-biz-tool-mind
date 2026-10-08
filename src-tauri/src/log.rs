//! 运行日志：级别取自「选项 → 高级」，按天一个文件落在配置目录的 `logs/` 里。
//!
//! 为什么不引 env_logger / tracing：这个 crate 要记的东西只有"一次 IPC 成了还是败了"，
//! 为它多拖两个依赖进安装包不值得。一条记录就是一行，一个文件就是一天，级别不够就什么都不写。
//!
//! 两条硬约束：
//! - **日志永远不能把用户的功能搞停**。写盘失败只从 `log_write` 命令返回错误给调用方，
//!   Rust 内部那些 `log(...)` 一律吞掉错误 —— 用户不该因为日志盘满了而看到"保存失败"。
//! - **凭据绝不进日志**。API Key 走 secret.rs，前端只往这里传事件描述；
//!   所以消息一律压成单行、截到 2000 字，避免有人把整段响应体贴进来把文件撑爆。

use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;

use crate::config;

/// 档位从低到高：`off` 什么都不记，`debug` 全记。UI 的下拉就是这四个能用的档 + off。
const RANKS: [(&str, u8); 5] = [
    ("off", 0),
    ("error", 1),
    ("warn", 2),
    ("info", 3),
    ("debug", 4),
];

/// 日志目录里最多留几天的文件。超了就在打开日志面板和启动时各裁一次。
const KEEP_FILES: usize = 14;
const MAX_LINE_CHARS: usize = 2000;

/// 当前阈值。默认 info，与 config.rs 的 defaults() 同源。
static THRESHOLD: AtomicU8 = AtomicU8::new(RANKS[2].1);

/// 一天一个文件，同一天的多行 append 要互相排队，否则半行会混进日志。
static WRITE_LOCK: Mutex<()> = Mutex::new(());

pub fn levels() -> Vec<&'static str> {
    RANKS.iter().map(|(n, _)| *n).collect()
}

/// 认不出的级别按 info 处理：配置文件是用户能改的，写坏了不该让日志整个消失。
fn rank(level: &str) -> u8 {
    RANKS
        .iter()
        .find(|(n, _)| *n == level)
        .map(|(_, r)| *r)
        .unwrap_or(RANKS[2].1)
}

pub fn current_level() -> &'static str {
    let r = THRESHOLD.load(Ordering::Relaxed);
    RANKS
        .iter()
        .find(|(_, v)| *v == r)
        .map(|(n, _)| *n)
        .unwrap_or("info")
}

/// 校验并返回规范名；认不出来时报错，供 `log_set_level` 命令拒绝脏值。
pub fn parse_level(level: &str) -> Result<&'static str, String> {
    let key = level.trim().to_ascii_lowercase();
    RANKS
        .iter()
        .find(|(n, _)| *n == key)
        .map(|(n, _)| *n)
        .ok_or_else(|| format!("未知的日志级别: {}（可选 {}）", level, levels().join(" / ")))
}

pub fn set_level(level: &str) -> Result<&'static str, String> {
    let name = parse_level(level)?;
    THRESHOLD.store(rank(name), Ordering::Relaxed);
    Ok(name)
}

/// 启动时从配置文件取级别，返回实际生效的那一档。
///
/// 这里只"应用"不"广播"：脏值由调用方决定怎么记，避免每次改高级设置都刷一行级别日志。
pub fn configure_from(cfg: &Value) -> &'static str {
    let raw = cfg
        .get("advanced")
        .and_then(|a| a.get("logLevel"))
        .and_then(|v| v.as_str())
        .unwrap_or("info");
    match parse_level(raw) {
        Ok(name) => {
            set_level(name).ok();
            name
        }
        Err(e) => {
            set_level("info").ok();
            log("warn", "config", &e);
            "info"
        }
    }
}

pub fn dir() -> PathBuf {
    config::get_config_dir().join("logs")
}

/// 今天这一份。文件名只带日期，级别和平台都写在行内。
pub fn current_file() -> PathBuf {
    let day = chrono::Local::now().format("%Y-%m-%d");
    dir().join(format!("z-mind-{day}.log"))
}

/// 单行化 + 截断。换行留着会让"一条记录一行"这个前提失效，grep 出来的东西没法看。
fn clean(message: &str) -> String {
    let flat: String = message
        .chars()
        .map(|c| match c {
            '\n' | '\r' | '\t' => ' ',
            c => c,
        })
        .collect();
    let flat = flat.trim();
    if flat.chars().count() <= MAX_LINE_CHARS {
        return flat.to_string();
    }
    let mut cut: String = flat.chars().take(MAX_LINE_CHARS).collect();
    cut.push('…');
    cut
}

pub fn log(level: &str, target: &str, message: &str) {
    let r = rank(level);
    if r == 0 || r > THRESHOLD.load(Ordering::Relaxed) {
        return;
    }
    let line = format!(
        "[{}] [{:<5}] [{}] {}\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
        level.to_ascii_uppercase(),
        clean(target),
        clean(message)
    );
    let _ = append_line(&line);
    // 只在 debug 构建里往控制台复述一份：release 的 GUI 子系统没有控制台，
    // 而 `npm run tauri dev` 的终端正是查问题最快的地方。
    #[cfg(debug_assertions)]
    eprint!("{line}");
}

fn append_line(line: &str) -> Result<(), String> {
    let path = current_file();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建日志目录失败: {}", e))?;
    }
    let _g = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开日志文件失败: {} ({})", path.display(), e))?;
    f.write_all(line.as_bytes())
        .map_err(|e| format!("写日志失败: {}", e))
}

/// 只按数量裁（按文件名排序，字典序即日期序）。留着的是最新的 KEEP_FILES 份。
pub fn prune() -> usize {
    let d = dir();
    let entries = match std::fs::read_dir(&d) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    let mut names: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("z-mind-") && name.ends_with(".log") {
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
pub struct LogInfo {
    pub dir: String,
    pub file: String,
    pub level: String,
    pub levels: Vec<&'static str>,
    /// 目录里有几份日志文件（不是今天的行数）。
    pub files: usize,
    pub bytes: u64,
    pub today: bool,
}

pub fn info() -> LogInfo {
    let d = dir();
    let file = current_file();
    let mut files = 0usize;
    let mut bytes = 0u64;
    if let Ok(entries) = std::fs::read_dir(&d) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("z-mind-") && name.ends_with(".log") {
                files += 1;
                if let Ok(m) = entry.metadata() {
                    bytes += m.len();
                }
            }
        }
    }
    LogInfo {
        dir: d.to_string_lossy().to_string(),
        file: file.to_string_lossy().to_string(),
        level: current_level().to_string(),
        levels: levels(),
        files,
        bytes,
        today: file.exists(),
    }
}

/// 前端记一条日志。级别由这里判，够不够写不由调用方决定。
#[tauri::command]
pub fn log_write(level: String, target: Option<String>, message: String) -> Result<(), String> {
    let name = parse_level(&level)?;
    if rank(name) == 0 {
        return Ok(());
    }
    if rank(name) > THRESHOLD.load(Ordering::Relaxed) {
        return Ok(());
    }
    append_line(&format!(
        "[{}] [{:<5}] [{}] {}\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
        name.to_ascii_uppercase(),
        clean(target.as_deref().unwrap_or("web")),
        clean(&message)
    ))
}

/// 改级别并立即生效：不用重启，下一行的过滤就用新阈值。
///
/// 记这一条用 debug 档而不是 info：正常路径是「选项 → 高级」改完 config_set 已经认过一次，
/// 这里再刷一行 info 就等于每改一次设置留两条重复记录。
#[tauri::command]
pub fn log_set_level(level: String) -> Result<String, String> {
    let name = set_level(&level)?;
    log("debug", "config", &format!("日志级别设为 {name}"));
    Ok(name.to_string())
}

#[tauri::command]
pub fn log_info() -> Result<LogInfo, String> {
    prune();
    Ok(info())
}

/// 打开日志目录（复用 reveal_in_folder 的路径校验）。
#[tauri::command]
pub fn log_open_dir() -> Result<String, String> {
    let d = dir();
    std::fs::create_dir_all(&d).map_err(|e| format!("创建日志目录失败: {}", e))?;
    let target = d.to_string_lossy().to_string();
    let spawned = if cfg!(target_os = "windows") {
        std::process::Command::new("explorer").arg(&target).spawn()
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(&target).spawn()
    } else {
        std::process::Command::new("xdg-open").arg(&target).spawn()
    };
    spawned.map_err(|e| format!("打开日志目录失败: {}", e))?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn isolated(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "z-mind-log-{}-{}-{}",
            tag,
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::env::set_var("Z_MIND_CONFIG_DIR", &dir);
        dir
    }

    fn body() -> String {
        std::fs::read_to_string(current_file()).unwrap_or_default()
    }

    #[test]
    fn level_threshold_filters_what_reaches_disk() {
        let _g = crate::lock_config_env();
        let root = isolated("threshold");
        let _ = std::fs::remove_dir_all(&root);

        set_level("warn").ok();
        log("debug", "t", "不该出现");
        log("info", "t", "也不该出现");
        log("warn", "t", "警告在");
        log("error", "t", "错误也在");
        let text = body();
        assert!(!text.contains("不该出现"), "debug 不该写进 warn 档");
        assert!(!text.contains("也不该出现"), "info 不该写进 warn 档");
        assert!(
            text.contains("[WARN ] [t] 警告在"),
            "warn 应在，实际 {text:?}"
        );
        assert!(
            text.contains("[ERROR] [t] 错误也在"),
            "error 应在，实际 {text:?}"
        );

        set_level("off").ok();
        log("error", "t", "off 档什么都不写");
        assert!(!body().contains("off 档什么都不写"), "off 必须完全静默");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unknown_level_is_refused_but_still_defaults_to_info() {
        let _g = crate::lock_config_env();
        let root = isolated("unknown");
        let _ = std::fs::remove_dir_all(&root);
        assert!(set_level("verbose").is_err(), "脏级别应被拒绝");
        assert_eq!(parse_level(" DEBUG"), Ok("debug"), "大小写和空格不该影响");
        // 拒绝之后阈值不动，调用方拿到的是错误而不是一个静默生效的脏值。
        set_level("info").ok();
        assert_eq!(current_level(), "info");
        let cfg: Value = serde_json::from_str(r#"{"advanced":{"logLevel":"噪声"}}"#).unwrap();
        configure_from(&cfg);
        assert_eq!(current_level(), "info", "配置里写坏了要回落 info");
        assert!(body().contains("未知的日志级别"), "回落这件事本身要留痕");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn multiline_messages_are_flattened_to_one_record() {
        let _g = crate::lock_config_env();
        let root = isolated("flat");
        let _ = std::fs::remove_dir_all(&root);
        set_level("debug").ok();
        log("info", "t", "第一行\n第二行\t带制表符");
        let text = body();
        let lines: Vec<&str> = text.lines().filter(|l| !l.is_empty()).collect();
        assert_eq!(lines.len(), 1, "一条记录必须正好一行，实际 {lines:?}");
        assert!(lines[0].contains("第一行 第二行 带制表符"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn long_messages_are_capped() {
        let _g = crate::lock_config_env();
        let root = isolated("cap");
        let _ = std::fs::remove_dir_all(&root);
        set_level("debug").ok();
        log("debug", "t", &"字".repeat(MAX_LINE_CHARS + 500));
        let line = body().lines().next().unwrap_or_default().to_string();
        assert!(
            line.chars().count() < MAX_LINE_CHARS + 80,
            "超长消息应截断，实际 {} 字",
            line.chars().count()
        );
        assert!(line.ends_with('…'), "截断要留记号");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn prune_keeps_the_newest_files_only() {
        let _g = crate::lock_config_env();
        let root = isolated("prune");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(dir()).unwrap();
        for i in 0..(KEEP_FILES + 6) {
            std::fs::write(
                dir().join(format!("z-mind-2026-{:02}-01.log", i + 1)),
                b"x\n",
            )
            .unwrap();
        }
        // 无关文件不能被顺手删掉。
        std::fs::write(dir().join("notes.txt"), b"keep").unwrap();
        let removed = prune();
        assert_eq!(removed, 6, "多出的 6 份应被裁掉");
        assert_eq!(std::fs::read_dir(dir()).unwrap().count(), KEEP_FILES + 1);
        assert!(dir().join("z-mind-2026-14-01.log").exists(), "最新的要留着");
        assert!(
            !dir().join("z-mind-2026-01-01.log").exists(),
            "最旧的应先删"
        );
        assert!(dir().join("notes.txt").exists(), "不该动别的文件");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn info_reports_level_and_size() {
        let _g = crate::lock_config_env();
        let root = isolated("info");
        let _ = std::fs::remove_dir_all(&root);
        set_level("debug").ok();
        log("info", "t", "一行");
        let got = info();
        assert_eq!(got.level, "debug");
        assert_eq!(got.files, 1);
        assert_eq!(got.bytes, std::fs::metadata(current_file()).unwrap().len());
        assert!(got.today, "今天的文件存在就该报 true");
        assert!(got.dir.ends_with("logs") || got.dir.ends_with("logs\\"));
        assert!(got.file.ends_with(".log"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
