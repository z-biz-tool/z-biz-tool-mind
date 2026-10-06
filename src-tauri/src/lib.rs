mod backup;
mod commands;
mod config;
mod paths;
mod recent;
mod secret;

/// 测试用的进程级串行锁。
///
/// 配置目录靠环境变量 `Z_MIND_CONFIG_DIR` 指定，而环境变量是整个测试进程共享的。
/// 每个模块各留一把自己的 GUARD 只能保证模块内不打架：五个模块并行时，
/// 一个测试刚 set_var 指到自己的临时目录，另一个就把它改走了，
/// 于是一批测试报 "找不到路径"，报的还都是不相干的错。
#[cfg(test)]
static CONFIG_ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
fn lock_config_env() -> std::sync::MutexGuard<'static, ()> {
    // 某个测试 panic 会把锁毒化，后面每个测试都只能拿到 PoisonError ——
    // 那是第二条与真实缺陷无关的失败。锁里只有 ()，不携带需要保持一致的状态，恢复即可。
    CONFIG_ENV_GUARD.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::config_get,
            commands::config_set,
            commands::config_reset_page,
            commands::recent_list,
            commands::recent_touch,
            commands::recent_remove,
            commands::recent_clear,
            commands::recent_set_capacity,
            commands::recent_set_pinned,
            commands::file_read_bytes,
            commands::file_write_bytes,
            commands::file_exists,
            commands::file_size,
            commands::file_remove,
            commands::autosave_write,
            commands::autosave_list,
            commands::autosave_clear,
            commands::backup_now,
            commands::backup_list,
            commands::backup_restore,
            commands::backup_delete,
            commands::backup_purge,
            commands::trash_list,
            commands::trash_restore,
            commands::trash_purge,
            commands::trash_purge_older_than,
            commands::secret_store,
            commands::secret_reveal,
            commands::secret_drop,
            commands::secret_exists,
            commands::reveal_in_folder,
            commands::history_list,
        ])
        .setup(|_| {
            // 启动即保证配置目录存在：后续所有读写都假设它可用。
            let dir = config::get_config_dir();
            std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {}", e))?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("z-biz-tool-mind 启动失败");
}
