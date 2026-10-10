//! 免费档「已保存文件数」的账本（01 A-13）。
//!
//! 为什么不复用 recent.json 当账本：那张表是一条 capped LRU —— 上限能在选项里调到 1，
//! 工作台的"清空最近文件"更是把它整张清掉。名额记在那儿，等于把付费闸门交给用户随手一下点击。
//! 这份账本没有上限、不被清空列表影响，只在真的落盘时加一格，在文档被删进回收站时还一格。

use std::path::PathBuf;

use serde_json::Value;

use crate::config::{get_config_dir, read_json_file, write_private};

fn store_path() -> PathBuf {
    get_config_dir().join("saved.json")
}

fn load() -> Vec<String> {
    read_json_file(&store_path(), Value::Array(Vec::new()))
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect()
}

fn save(items: &[String]) -> Result<(), String> {
    let arr: Vec<Value> = items.iter().map(|p| Value::String(p.clone())).collect();
    let text = serde_json::to_string_pretty(&Value::Array(arr))
        .map_err(|e| format!("序列化已保存列表失败: {}", e))?;
    write_private(&store_path(), text.as_bytes())
}

/// Windows 的文件系统大小写不敏感：同一个文件用两种写法进账本，名额就被占了两格，
/// 用户会在一份都没存满时被闸门拦下。unix 上大小写是文件名的一部分，照原样比。
fn same(a: &str, b: &str) -> bool {
    #[cfg(windows)]
    {
        a.to_lowercase() == b.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

/// 账本记的是"这台机器上确实存在的一份已存盘文档"，所以读的时候要把已经不存在的剔掉：
/// 用户在资源管理器里删文件不经过我们的 file_remove，那一格必须自己还回来。
/// 只增不减的账本最后又会变成 A-13 那种"一份都存不了"。
/// 浏览器模式（src/services/native.ts 的 localStorage 分支）没有文件系统可读，不做这层过滤。
fn alive(path: &str) -> bool {
    std::path::Path::new(path).exists()
}

pub fn list() -> Vec<String> {
    load().into_iter().filter(|p| alive(p)).collect()
}

/// 记一笔「这个路径确实落盘了」。重复记同一路径不涨名额。
/// 顺带把死条目 compact 掉，让 saved.json 不无限堆积。
pub fn mark_saved(path: &str) -> Result<usize, String> {
    let raw = load();
    let mut items: Vec<String> = raw
        .iter()
        .filter(|p| alive(p) || same(p, path))
        .cloned()
        .collect();
    if !items.iter().any(|p| same(p, path)) {
        items.push(path.to_string());
    }
    if items != raw {
        save(&items)?;
    }
    Ok(items.len())
}

/// 还一笔：文档被删掉就还回一个名额。闸门的文案让用户"删除不需要的文件"，
/// 删了却不还名额的话那句话就是假的。账本里没有这条时按幂等处理，不报错。
pub fn release(path: &str) -> Result<usize, String> {
    let mut items = load();
    let before = items.len();
    items.retain(|p| !same(p, path));
    if items.len() != before {
        save(&items)?;
    }
    Ok(items.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn isolated(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("z-mind-quota-{}-{}", tag, uuid::Uuid::new_v4()));
        std::env::set_var("Z_MIND_CONFIG_DIR", &dir);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 读的时候会过滤磁盘上已不存在的路径，所以测试里的"已保存文件"必须真的落盘。
    fn real(dir: &std::path::Path, name: &str) -> String {
        let p = dir.join(name);
        std::fs::write(&p, b"x").unwrap();
        p.to_string_lossy().to_string()
    }

    /// 这条就是 A-13 本体：旧写法拿最近列表去重当已保存数，于是"打开过 10 份"=「存不了任何文件」。
    #[test]
    fn opening_is_not_saving() {
        let _g = crate::lock_config_env();
        let dir = isolated("open");
        let a = real(&dir, "a.emmx");
        let b = real(&dir, "b.emmx");
        crate::recent::touch("D:/docs/open-only-1.emmx", "A", "local").unwrap();
        crate::recent::touch("D:/docs/open-only-2.emmx", "B", "local").unwrap();
        assert_eq!(list().len(), 0, "只打开过的文件不该占保存名额");
        assert_eq!(mark_saved(&a).unwrap(), 1);
        assert_eq!(mark_saved(&a).unwrap(), 1, "重复保存同一份不涨名额");
        assert_eq!(mark_saved(&b).unwrap(), 2);
        std::env::remove_var("Z_MIND_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 账本必须独立于最近列表：清空列表、收紧容量都不该把已花掉的名额洗白 ——
    /// 那等于"每次保存前先点一下清空"就能无限保存。
    #[test]
    fn clearing_the_recent_list_does_not_reset_the_quota() {
        let _g = crate::lock_config_env();
        let dir = isolated("clear");
        let c = real(&dir, "c.emmx");
        let d = real(&dir, "d.emmx");
        mark_saved(&c).unwrap();
        mark_saved(&d).unwrap();
        crate::recent::clear().unwrap();
        assert_eq!(list().len(), 2, "清空最近文件列表不该重置配额");
        crate::recent::set_capacity(1).unwrap();
        for i in 0..5 {
            crate::recent::touch(&format!("D:/docs/r{}.emmx", i), "R", "local").unwrap();
        }
        assert_eq!(crate::recent::list().len(), 1, "容量调到 1 时列表只剩一条");
        assert_eq!(list().len(), 2, "列表容量不该影响账本");
        std::env::remove_var("Z_MIND_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn release_returns_the_slot() {
        let _g = crate::lock_config_env();
        let dir = isolated("release");
        let e = real(&dir, "e.emmx");
        mark_saved(&e).unwrap();
        assert_eq!(list().len(), 1);
        assert_eq!(release(&e).unwrap(), 0);
        assert_eq!(
            release("D:/docs/never.emmx").unwrap(),
            0,
            "还一笔不存在的不该报错"
        );
        assert_eq!(mark_saved(&e).unwrap(), 1, "还掉之后能重新占");
        std::env::remove_var("Z_MIND_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 在程序外面（资源管理器）删掉的文档也要把名额还回来，不然删光了文件却存不动新文件。
    #[test]
    fn a_file_deleted_outside_the_app_gives_back_its_slot() {
        let _g = crate::lock_config_env();
        let dir = isolated("prune");
        let a = real(&dir, "a.emmx");
        let b = real(&dir, "b.emmx");
        mark_saved(&a).unwrap();
        mark_saved(&b).unwrap();
        assert_eq!(list().len(), 2);
        std::fs::remove_file(&b).unwrap();
        assert_eq!(list().len(), 1, "外部删掉的文件该自动还名额");
        assert_eq!(list(), vec![a.clone()]);
        let c = real(&dir, "c.emmx");
        assert_eq!(mark_saved(&c).unwrap(), 2);
        // 按内容比而不是按条数比：只比条数的话，"账本里留着已删除的 b、却漏了新记的 c"
        // 这种同样错的写法也能过关。
        assert_eq!(
            load(),
            vec![a.clone(), c.clone()],
            "下次记账要把已经不存在的条目从账本里清掉"
        );
        std::env::remove_var("Z_MIND_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn same_file_in_another_case_counts_once() {
        let _g = crate::lock_config_env();
        let dir = isolated("case");
        let p = real(&dir, "Mixed.emmx");
        mark_saved(&p).unwrap();
        assert_eq!(
            mark_saved(&p.replace("Mixed.emmx", "mixed.EMMX")).unwrap(),
            1,
            "大小写不同的同一份文件不该占两格"
        );
        assert_eq!(release(&p.replace("Mixed.emmx", "MIXED.EMMX")).unwrap(), 0);
        std::env::remove_var("Z_MIND_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
