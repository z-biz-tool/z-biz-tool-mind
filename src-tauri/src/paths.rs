//! 前端可访问路径的判据。
//!
//! 为什么要这一层：.emmx 的读写完全由前端决定文件名（另存为、导出、自动备份），
//! 一旦把路径直接交给 `std::fs`，`../../` 之类的拼接就能越界。
//!
//! 判据是"拦住遍历与系统目录"，不是"只准写三个目录"。理由有两条：
//! - 用户的文档本来就放在他自己的位置。这台机器上系统盘是 C:，稿子在 D:，NAS 挂在 Z:；
//!   只认 home 前缀的话，另存为与导出在真机上统一报"路径超出允许范围"，产品不能用。
//!   （映射盘符经 canonicalize 会变成 \\server\share\... 的 UNC，前缀判据同样拦它。）
//! - 渲染端是这个项目自己的代码，没有远端内容（CSP 已配、没放开 shell 权限）。
//!   真正的攻击面是拼出来的相对路径和系统目录，这两样都单独拦住了。

use std::path::{Component, Path, PathBuf};

use crate::config::get_config_dir;

/// 应用自己管的目录：配置目录与临时目录永远可用，即使它们恰好落在被拦的位置里。
fn allowed_roots() -> Vec<PathBuf> {
    let mut roots = vec![get_config_dir(), std::env::temp_dir()];
    if let Some(home) = dirs::home_dir() {
        roots.push(home);
    }
    roots
}

/// 系统目录：写进去要么把系统搞坏，要么被 UAC / SIP 挡下来变成一个看不懂的错误。
/// Windows 上按环境变量取（系统盘不一定是 C:），unix 上按固定前缀取。
fn denied_roots() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    for key in ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"] {
        if let Ok(v) = std::env::var(key) {
            out.push(PathBuf::from(v));
        }
    }
    #[cfg(not(windows))]
    for p in [
        "/System",
        "/Library",
        "/usr",
        "/bin",
        "/sbin",
        "/lib",
        "/etc",
        "/proc",
        "/sys",
        "/dev",
        "/boot",
        "/root",
    ] {
        out.push(PathBuf::from(p));
    }
    out
}

fn is_denied(path: &Path) -> bool {
    denied_roots()
        .iter()
        .map(normalize_root)
        .any(|root| !root.as_os_str().is_empty() && path.starts_with(root))
}

fn normalize_root(root: &Path) -> PathBuf {
    // 根目录本身可能还不存在（首次运行时配置目录由 lib.rs 创建），
    // canonicalize 失败时退化为绝对化的原路径，否则第一次保存会被误判越界。
    root.canonicalize().unwrap_or_else(|_| root.to_path_buf())
}

/// 校验路径是否可读写；返回规范化后的绝对路径。
///
/// 未存在的目标（新建文件）无法 canonicalize，因此规范化的是它的父目录，
/// 再把文件名接回去 —— 这样既能拦住 `..`，又不会拒绝"尚不存在但合法"的写入。
pub fn validate(path: &str, write: bool) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("路径为空".to_string());
    }
    let p = Path::new(path);
    // 逐个成分判 ..：整串 find 会把 a..b.emmx 这种合法文件名一起拒掉。
    if p.components().any(|c| c == Component::ParentDir) {
        return Err("路径不允许包含 ..".to_string());
    }
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("无法取得当前目录: {}", e))?
            .join(p)
    };

    let (probe, tail) = split_existing(&abs);
    let canonical = probe
        .canonicalize()
        .map_err(|e| format!("路径不存在或不可访问: {} ({})", abs.display(), e))?;
    let final_path = match tail {
        Some(name) => canonical.join(name),
        None => canonical,
    };

    // 软链接在这里已经被 canonicalize 解开了：指向系统目录的链子也照样拦。
    let in_app_root = allowed_roots()
        .iter()
        .map(normalize_root)
        .any(|r| canonical.starts_with(r));
    if is_denied(&canonical) && !in_app_root {
        return Err(format!("系统目录不允许读写: {}", path));
    }
    if write {
        ensure_parent(&final_path)?;
    }
    Ok(final_path)
}

/// 读出 (已存在的最深祖先, 尚未存在的第一级名字)。
fn split_existing(abs: &PathBuf) -> (PathBuf, Option<std::ffi::OsString>) {
    let mut cur = abs.clone();
    let mut tail: Option<std::ffi::OsString> = None;
    loop {
        if cur.exists() {
            return (cur, tail);
        }
        if let Some(name) = cur.file_name() {
            if tail.is_none() {
                tail = Some(name.to_os_string());
            }
            if !cur.pop() {
                return (abs.clone(), None);
            }
        } else {
            return (abs.clone(), None);
        }
    }
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
        }
    }
    Ok(())
}

/// 写入前占用目标位：已存在的同名文件先送进备份，再由调用方落盘。
/// 返回 (可写路径, 是否覆盖了一个已存在的文件)。
pub fn prepare_write(path: &str) -> Result<(PathBuf, bool), String> {
    let target = validate(path, true)?;
    let existed = target.exists();
    Ok((target, existed))
}

/// 把任意字符串压成安全文件名片段（自动备份按文档名分目录）。
pub fn sanitize_name(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => out.push('_'),
            c if char::is_control(c) => out.push('_'),
            c => out.push(c),
        }
    }
    let trimmed: String = out.chars().take(80).collect();
    let trimmed = trimmed.trim_matches(|c| c == ' ' || c == '.').to_string();
    if trimmed.is_empty() {
        "untitled".to_string()
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_dotdot_traversal() {
        let r = validate("~/../etc/passwd", false);
        assert!(r.is_err(), ".. 必须被拒绝");
    }

    #[test]
    fn allows_config_dir_and_blocks_system_dir() {
        let dir = get_config_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let inside = dir.join("ok.emmx");
        std::fs::write(&inside, b"x").unwrap();
        let ok = validate(inside.to_str().unwrap(), false);
        assert!(ok.is_ok(), "配置目录内的文件应通过，实际 {:?}", ok.err());
        let bad = validate("/proc/self/environ", false);
        assert!(bad.is_err(), "系统路径应被拒绝");
        std::fs::remove_file(&inside).ok();
    }

    #[test]
    #[cfg(windows)]
    fn blocks_windows_system_dirs() {
        // 系统盘不一定是 C:，判据取环境变量；这里直接拿 SystemRoot 拼一个一定存在的文件。
        let root = std::env::var("SystemRoot").expect("测试机应有 SystemRoot");
        let hosts = Path::new(&root).join("System32").join("drivers").join("etc").join("hosts");
        assert!(
            validate(hosts.to_str().unwrap(), true).is_err(),
            "SystemRoot 之下必须拒绝：{}",
            hosts.display()
        );
    }

    #[test]
    fn allows_two_dots_inside_a_filename() {
        // 老判据是整串 find("..")，把 a..b.emmx 这种合法文件名一起拒了。
        let dir = get_config_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let inside = dir.join("a..b.emmx");
        std::fs::write(&inside, b"x").unwrap();
        let r = validate(inside.to_str().unwrap(), false);
        assert!(r.is_ok(), "文件名里两个点不是遍历，实际 {:?}", r.err());
        std::fs::remove_file(&inside).ok();
    }

    #[test]
    fn sanitizes_illegal_filename_chars() {
        assert_eq!(sanitize_name("a/b\\c:d*"), "a_b_c_d_");
        assert_eq!(sanitize_name("   "), "untitled");
        assert_eq!(sanitize_name(""), "untitled");
    }
}
