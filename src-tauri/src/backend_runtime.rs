use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const BACKEND_ADDRESS: &str = "127.0.0.1:8732";

pub struct BackendRuntime(pub Mutex<Option<Child>>);

pub fn start(app: &AppHandle) -> Result<Option<Child>, String> {
    if backend_is_ready() {
        return Ok(None);
    }

    let resource_dir = app.path().resource_dir().map_err(|error| error.to_string())?;
    let app_root = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let runtime_dir = resource_dir.join("runtime");
    let node_path = runtime_dir.join("node");
    let server_path = runtime_dir.join("backend").join("server.js");

    fs::create_dir_all(app_root.join("logs")).map_err(|error| error.to_string())?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(app_root.join("logs").join("backend.log"))
        .map_err(|error| error.to_string())?;
    let error_log = log.try_clone().map_err(|error| error.to_string())?;

    let mut child = Command::new(node_path)
        .arg(server_path)
        .current_dir(&app_root)
        .env("RASSILKA_APP_ROOT", &app_root)
        .env("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", "1")
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(error_log))
        .spawn()
        .map_err(|error| format!("Не удалось запустить локальный backend: {error}"))?;

    for _ in 0..80 {
        if backend_is_ready() {
            return Ok(Some(child));
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("Локальный backend завершился при запуске: {status}"));
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    Err("Локальный backend не запустился за 8 секунд".to_string())
}

pub fn stop(runtime: &BackendRuntime) {
    if let Ok(mut guard) = runtime.0.lock() {
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *guard = None;
    }
}

fn backend_is_ready() -> bool {
    let address: SocketAddr = BACKEND_ADDRESS.parse().expect("valid backend address");
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(150)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut body = String::new();
    stream.read_to_string(&mut body).is_ok() && body.contains("instagram-agent-backend")
}
