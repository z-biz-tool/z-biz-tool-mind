mod backup;
mod commands;
mod config;
mod crash;
mod log;
mod net;
mod openfile;
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
    // 这几件事必须在 Builder 之前：日志级别决定第一行记录写不写得出，
    // 代理参数只在 WebView2 核心创建那一刻读一次 —— 建好窗口再设就晚了，
    // panic hook 则要赶在第一批命令被调用前装上，不然头一次崩溃就没有记录。
    let cfg = config::read_config();
    let level = log::configure_from(&cfg);
    log::log("info", "config", &format!("日志级别 = {level}"));
    match net::install(&cfg) {
        Ok(st) => log::log("info", "net", &st.message),
        // 用户手改过的 config.json 里可能有非法代理地址：拦不住的话就退回跟随系统，
        // 并把这件事写进日志，而不是让整个应用起不来。
        Err(e) => log::log(
            "error",
            "net",
            &format!("代理设置无法应用，已按跟随系统启动: {e}"),
        ),
    }
    // 崩溃记录要在任何可能 panic 的代码之前就位：开关读配置，hook 只装一次。
    let crash_on = crash::configure_from(&cfg);
    crash::install_panic_hook();
    log::log(
        "debug",
        "config",
        &format!("崩溃记录 = {}", if crash_on { "开" } else { "关" }),
    );
    log::prune();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(openfile::Pending::default())
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
            commands::autosave_drop,
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
            openfile::open_take_pending,
            log::log_write,
            log::log_set_level,
            log::log_info,
            log::log_open_dir,
            net::proxy_status,
            crash::crash_report,
            crash::crash_info,
            crash::crash_open_dir,
        ])
        .setup(|app| {
            // 启动即保证配置目录存在：后续所有读写都假设它可用。
            let dir = config::get_config_dir();
            std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {}", e))?;
            let info = app.package_info();
            log::log(
                "info",
                "app",
                &format!(
                    "{} v{} 已启动（{}/{}），配置目录 {}",
                    info.name,
                    info.version,
                    std::env::consts::OS,
                    std::env::consts::ARCH,
                    dir.display()
                ),
            );
            // Windows / Linux 双击 .emmx：路径就在命令行里，趁前端开始渲染之前收进队列。
            openfile::seed_from_args(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("z-biz-tool-mind 启动失败");

    app.run(|app_handle, event| {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        {
            // macOS 上第二次双击不发新进程，只投这一条事件；转成本地路径后进同一条队列。
            // 这个变体在 Windows/ Linux 上根本不存在，所以判据也只能在那两个平台上编进去。
            if let tauri::RunEvent::Opened { urls } = event {
                openfile::push(
                    app_handle,
                    urls.iter()
                        .filter_map(|u| u.to_file_path().ok())
                        .map(|p| p.to_string_lossy().to_string()),
                );
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        {
            let _ = (app_handle, event);
        }
    });
}
