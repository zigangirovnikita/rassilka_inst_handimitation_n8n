use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const BACKEND_ADDRESS: &str = "127.0.0.1:8732";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub struct BackendRuntime(pub Mutex<Option<Child>>);

impl Drop for BackendRuntime {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(child) = guard.as_mut() {
                terminate_child(child);
            }
            *guard = None;
        }
    }
}

pub fn start(app: &AppHandle) -> Result<Option<Child>, String> {
    if backend_is_ready() {
        return Ok(None);
    }

    let resource_dir = app.path().resource_dir().map_err(|error| error.to_string())?;
    let app_root = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let runtime_dir = resource_dir.join("runtime");
    let node_path = node_executable(&runtime_dir);
    let backend_dir = runtime_dir.join("backend");
    let server_path = backend_dir.join("server.js");

    if !node_path.is_file() {
        return Err(format!("Bundled Node.js не найден: {}", node_path.display()));
    }
    if !server_path.is_file() {
        return Err(format!("Backend entrypoint не найден: {}", server_path.display()));
    }

    fs::create_dir_all(app_root.join("logs")).map_err(|error| error.to_string())?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(app_root.join("logs").join("backend.log"))
        .map_err(|error| error.to_string())?;
    let error_log = log.try_clone().map_err(|error| error.to_string())?;

    let mut command = backend_command(&node_path, &backend_dir, &app_root);
    command
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(error_log));

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
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

fn backend_command(
    node_path: &std::path::Path,
    backend_dir: &std::path::Path,
    app_root: &std::path::Path,
) -> Command {
    let mut command = Command::new(node_path);
    // Keep the Node entrypoint free of an absolute Windows path. The installed
    // resource directory contains spaces, and passing that path through the
    // packaged process boundary caused Node to receive only `C:` as argv[1].
    command
        .arg("server.js")
        .current_dir(backend_dir)
        .env("RASSILKA_APP_ROOT", app_root)
        .env("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", "1");
    command
}

fn node_executable(runtime_dir: &std::path::Path) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        return runtime_dir.join("node.exe");
    }
    #[cfg(not(windows))]
    {
        return runtime_dir.join("node");
    }
}

pub fn stop(runtime: &BackendRuntime) {
    if let Ok(mut guard) = runtime.0.lock() {
        if let Some(child) = guard.as_mut() {
            terminate_child(child);
        }
        *guard = None;
    }
}

fn terminate_child(child: &mut Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(child.id().to_string())
            .status();
        for _ in 0..50 {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
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

#[cfg(test)]
mod tests {
    use super::backend_command;
    use std::ffi::OsStr;
    use std::path::Path;

    #[test]
    fn backend_command_uses_relative_entrypoint_for_paths_with_spaces() {
        let node_path = Path::new(r"C:\Users\Test User\Instagram Agent n8n\runtime\node.exe");
        let backend_dir = Path::new(r"C:\Users\Test User\Instagram Agent n8n\runtime\backend");
        let app_root = Path::new(r"C:\Users\Test User\AppData\Roaming\ru.local.instagram-agent-n8n");

        let command = backend_command(node_path, backend_dir, app_root);
        let args: Vec<_> = command.get_args().collect();

        assert_eq!(args, [OsStr::new("server.js")]);
        assert_eq!(command.get_current_dir(), Some(backend_dir));
        assert_eq!(
            command
                .get_envs()
                .find(|(key, _)| *key == OsStr::new("RASSILKA_APP_ROOT"))
                .and_then(|(_, value)| value),
            Some(app_root.as_os_str())
        );
    }
}
