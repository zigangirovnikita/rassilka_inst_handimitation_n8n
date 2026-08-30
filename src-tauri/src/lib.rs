mod backend_runtime;

use backend_runtime::BackendRuntime;
use std::sync::Mutex;
use tauri::Manager;

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let child = backend_runtime::start(&app.handle())?;
            app.manage(BackendRuntime(Mutex::new(child)));
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Some(runtime) = window.try_state::<BackendRuntime>() {
                    backend_runtime::stop(&runtime);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
            if let Some(runtime) = app_handle.try_state::<BackendRuntime>() {
                backend_runtime::stop(&runtime);
            }
        }
    });
}
