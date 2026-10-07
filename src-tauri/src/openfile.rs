//! 文件关联打开：双击 .emmx 要真的把那份文件开出来。
//!
//! 两个平台给的东西根本不是一回事：
//! - Windows / Linux：每次双击新起一个进程，路径当成命令行参数塞进来（注册表里那条 `"%1"`）。
//! - macOS：系统只让一个实例活着，后续双击不发新进程，而是投递一条 `RunEvent::Opened`。
//! 所以只做 argv 的话，macOS 上"第一次双击能开、之后每次都当没看见"。
//!
//! 交付只走一条队列：命令 `open_take_pending` 取走即清空，`open-path` 事件只是"队列里有新东西"
//! 的信号。两条触发（启动时取一次 + 收到信号再取一次）共用同一次出队，同一路径不会被开两遍。
//! 至于为什么没引 single-instance 插件：Windows 上第二个进程会开自己的窗口并加载自己的文件，
//! 这是能接受的行为，代价是多一个进程；单实例转发要加依赖，这里不值得。

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

/// 前端监听的事件名：payload 无意义，只表示"队列里有新路径了"。
pub const EVENT: &str = "open-path";

#[derive(Default)]
pub struct Pending(Mutex<Vec<String>>);

impl Pending {
    /// 入队，返回真正被收下的一部分（判据见 [`pick`]）。重复路径只留一份。
    pub fn add(&self, raw: impl Iterator<Item = String>) -> Vec<String> {
        let picked: Vec<String> = raw.filter_map(|s| pick(&s)).collect();
        if picked.is_empty() {
            return picked;
        }
        let mut q = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for p in &picked {
            if !q.iter().any(|have| have == p) {
                q.push(p.clone());
            }
        }
        picked
    }

    /// 取走全部待发：出队即清空，所以两条触发不会把同一份文件开两遍。
    pub fn take(&self) -> Vec<String> {
        let mut q = self.0.lock().unwrap_or_else(|e| e.into_inner());
        q.drain(..).collect()
    }
}

/// 只收"真实存在的 .emmx 文件"。
///
/// `"%1"` 传进来的可能是带引号的、相对路径的、或者已经被移走的文件；
/// 这些一路走到前端的 openPath 只会剩一句"读取文件失败"，排查成本全留给用户。
fn pick(raw: &str) -> Option<String> {
    let path = PathBuf::from(raw.trim().trim_matches('"'));
    if !path.is_file() {
        return None;
    }
    let ext = path.extension().and_then(|e| e.to_str())?;
    if !ext.eq_ignore_ascii_case("emmx") {
        return None;
    }
    Some(path.to_string_lossy().to_string())
}

/// 启动时把命令行里的路径收进队列（Windows / Linux 的双击走这条）。
pub fn seed_from_args(app: &AppHandle) {
    push(app, std::env::args().skip(1));
}

/// 供 macOS 的 `RunEvent::Opened` 用：URL 已经在那边转成本地路径再进来。
pub fn push(app: &AppHandle, raw: impl Iterator<Item = String>) {
    let state = app.state::<Pending>();
    if !state.add(raw).is_empty() {
        // 冷启动时前端还没挂上监听，这条发不出去也没关系：启动那一次 take 会兜住。
        let _ = app.emit(EVENT, ());
    }
}

#[tauri::command]
pub fn open_take_pending(state: tauri::State<'_, Pending>) -> Vec<String> {
    let got = state.take();
    if !got.is_empty() {
        // 双击打不开时第一件要看的事就是"队列里到底有没有这条路径"。
        crate::log::log("info", "open", &format!("待打开路径交给前端: {}", got.join(" | ")));
    }
    got
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("z-mind-open-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(name);
        std::fs::write(&file, b"not really an emmx").unwrap();
        file
    }

    #[test]
    fn keeps_only_existing_emmx_files() {
        let f = tmp_file("a.emmx");
        assert_eq!(
            pick(&f.to_string_lossy()).as_deref(),
            Some(f.to_str().unwrap())
        );
        // 扩展名大小写不敏感：亿图导出的文件名见过 .EMMX
        let up = tmp_file("B.EMMX");
        assert!(pick(&up.to_string_lossy()).is_some());
        // 不是 emmx 的、不存在的、目录本身，一律不收
        let other = tmp_file("c.txt");
        assert_eq!(pick(&other.to_string_lossy()), None);
        assert_eq!(pick("/no/such/file.emmx"), None);
        assert_eq!(pick(std::env::temp_dir().to_str().unwrap()), None);
    }

    #[test]
    fn accepts_the_quoted_registry_form() {
        let f = tmp_file("quoted.emmx");
        let quoted = format!("\"{}\"", f.to_string_lossy());
        assert_eq!(pick(&quoted).as_deref(), Some(f.to_str().unwrap()));
        assert_eq!(
            pick(&format!("  {}", f.to_string_lossy())).as_deref(),
            f.to_str()
        );
    }

    #[test]
    fn taking_clears_so_nothing_opens_twice() {
        let q = Pending::default();
        let f = tmp_file("once.emmx");
        let s = f.to_string_lossy().to_string();
        assert_eq!(q.add(std::iter::once(s.clone())).len(), 1);
        assert_eq!(q.take(), vec![s]);
        assert!(q.take().is_empty());
    }

    #[test]
    fn same_path_queued_twice_stays_once() {
        let q = Pending::default();
        let f = tmp_file("dup.emmx");
        let s = f.to_string_lossy().to_string();
        q.add(std::iter::once(s.clone()));
        q.add(std::iter::once(s.clone()));
        assert_eq!(q.take(), vec![s]);
    }

    #[test]
    fn unrelated_argv_entries_do_not_block_the_real_one() {
        let q = Pending::default();
        let f = tmp_file("mixed.emmx");
        let args = vec![
            "C:\\zmind-tgt\\release".to_string(),
            "--flag=1".to_string(),
            f.to_string_lossy().to_string(),
        ];
        assert_eq!(q.add(args.into_iter()).len(), 1);
        assert_eq!(q.take(), vec![f.to_string_lossy().to_string()]);
    }
}
