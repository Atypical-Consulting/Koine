// Koine Studio — Rust LSP-sidecar broker.
//
// Spawns the Koine language server (`koine lsp`) lazily on `lsp_start`, owns its
// stdin behind a Mutex in managed state, runs a dedicated reader thread that parses
// Content-Length framed JSON-RPC off the child's stdout and re-emits each body as a
// Tauri event (`lsp://message`, `lsp://exit`), and exposes `lsp_send` to write framed
// JSON-RPC to the child. No async runtime — just std::process + std::thread + std::io.
//
// The sidecar is supervised: if the child exits unexpectedly the reader thread
// relaunches it (bounded retries with a short backoff), swaps in the fresh stdin,
// starts a new reader thread, and emits `lsp://restart` so the frontend can re-run
// `initialize` and re-open its document. An intentional shutdown (the `lsp_stop`
// command, or `shutdown`/`exit` flowing through `lsp_send`) sets a flag that
// suppresses the restart so teardown stays clean. `lsp://exit` is emitted only once
// the retry budget is exhausted (or after a clean stop).

use std::io::{self, BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

/// Maximum number of relaunch attempts after an unexpected sidecar exit.
const MAX_RESTART_RETRIES: u32 = 3;
/// Backoff between relaunch attempts.
const RESTART_BACKOFF: Duration = Duration::from_millis(500);

// --- managed state ----------------------------------------------------------

#[derive(Default)]
struct LspState {
    /// stdin handle of the running child; None until `lsp_start` succeeds.
    stdin: Mutex<Option<ChildStdin>>,
    /// keep the Child so it is not dropped; lets us guard against a double start.
    child: Mutex<Option<Child>>,
    /// set once the user/app asks to stop; suppresses auto-restart on child exit.
    shutting_down: Arc<AtomicBool>,
}

// --- pure framing functions (the cargo test gate) ---------------------------

/// Write one LSP frame: `Content-Length: N\r\n\r\n<body>` where N is the BYTE length.
/// Flushes so the child sees the message immediately.
fn write_frame<W: Write>(w: &mut W, body: &str) -> io::Result<()> {
    let bytes = body.as_bytes();
    write!(w, "Content-Length: {}\r\n\r\n", bytes.len())?;
    w.write_all(bytes)?;
    w.flush()
}

/// Read one LSP frame. Returns `Ok(Some(body))` on a full message, `Ok(None)` on a
/// clean EOF (no bytes before a header), and `Err` on malformed input / IO error.
/// Header lines may be split across reads (handled by `read_line`); the body is read
/// with `read_exact`, which loops over split reads internally.
fn read_frame<R: BufRead>(r: &mut R) -> io::Result<Option<String>> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = r.read_line(&mut line)?;
        if n == 0 {
            // EOF. If we already saw a header this frame is truncated; otherwise clean EOF.
            return if content_length.is_some() {
                Err(io::Error::new(io::ErrorKind::UnexpectedEof, "EOF mid-header"))
            } else {
                Ok(None)
            };
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            // blank line => end of headers
            break;
        }
        // Header is `Key: Value`. Match the key case-insensitively per the LSP/HTTP
        // convention; ignore any other header (e.g. Content-Type).
        if let Some((key, value)) = trimmed.split_once(':') {
            if key.trim().eq_ignore_ascii_case("content-length") {
                let v: usize = value
                    .trim()
                    .parse()
                    .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad Content-Length"))?;
                content_length = Some(v);
            }
        }
    }

    let len = content_length
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing Content-Length"))?;
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    String::from_utf8(buf)
        .map(Some)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

// --- supervision decision (pure, unit-tested) -------------------------------

/// Decide whether the supervisor should relaunch the sidecar after it exited.
/// Pure so the policy is testable without spawning a real process:
/// - never restart during an intentional shutdown,
/// - otherwise restart while attempts already made is below the retry budget.
/// `attempts_made` is the number of relaunches already tried this supervision
/// session (0 on the first unexpected exit).
fn should_restart(shutting_down: bool, attempts_made: u32, max_retries: u32) -> bool {
    if shutting_down {
        return false;
    }
    attempts_made < max_retries
}

// --- sidecar resolution -----------------------------------------------------

/// Resolve how to launch the language server.
/// `KOINE_LSP` (a self-contained sidecar binary) takes precedence; otherwise fall
/// back to the Debug DLL via `dotnet`, resolved relative to this crate.
fn resolve_sidecar_command() -> Command {
    if let Ok(bin) = std::env::var("KOINE_LSP") {
        let mut c = Command::new(bin);
        c.arg("lsp");
        c
    } else {
        // CARGO_MANIFEST_DIR = .../tooling/koine-studio/src-tauri
        // -> ../../../src/Koine.Cli/bin/Debug/net10.0/Koine.Cli.dll
        let dll = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../src/Koine.Cli/bin/Debug/net10.0/Koine.Cli.dll"
        );
        let mut c = Command::new("dotnet");
        c.arg(dll).arg("lsp");
        c
    }
}

// --- sidecar spawning + supervision -----------------------------------------

/// Spawn the sidecar process with the broker's standard stdio wiring and detach
/// its stdin/stdout. Returns the live `Child` plus its piped stdin and stdout.
fn spawn_sidecar() -> Result<(Child, ChildStdin, std::process::ChildStdout), String> {
    let mut cmd = resolve_sidecar_command();
    cmd.env("DOTNET_NOLOGO", "1")
        .env("DOTNET_CLI_TELEMETRY_OPTOUT", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());

    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn LSP: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin on child")?;
    let stdout = child.stdout.take().ok_or("no stdout on child")?;
    Ok((child, stdin, stdout))
}

/// Spawn the reader/supervisor thread. It frames JSON-RPC off `stdout`, re-emits
/// each body as `lsp://message`, and on an unexpected child exit relaunches the
/// sidecar (bounded retries, short backoff), swaps the managed stdin, emits
/// `lsp://restart`, and continues reading the new child's stdout. `lsp://exit` is
/// emitted only when the retry budget is exhausted or a clean stop is in effect.
fn spawn_reader_thread(
    app: AppHandle,
    mut stdout: std::process::ChildStdout,
    shutting_down: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        // attempts_made counts relaunches performed in this supervision session.
        let mut attempts_made: u32 = 0;
        loop {
            let mut reader = BufReader::new(stdout);
            let clean_eof = loop {
                match read_frame(&mut reader) {
                    Ok(Some(body)) => {
                        let _ = app.emit("lsp://message", body);
                    }
                    Ok(None) => break true, // clean EOF
                    Err(_) => break false,  // malformed / IO error
                }
            };

            // The child's stdout is gone; decide whether to relaunch.
            if !should_restart(
                shutting_down.load(Ordering::SeqCst),
                attempts_made,
                MAX_RESTART_RETRIES,
            ) {
                let code = if shutting_down.load(Ordering::SeqCst) || clean_eof {
                    0i32
                } else {
                    -1i32
                };
                let _ = app.emit("lsp://exit", code);
                return;
            }

            // Try to relaunch, consuming one attempt per spawn try and honouring the
            // retry budget and a shutdown that may race in during the backoff.
            let state = app.state::<LspState>();
            let new_stdout = loop {
                std::thread::sleep(RESTART_BACKOFF);
                attempts_made += 1;

                if shutting_down.load(Ordering::SeqCst) {
                    let _ = app.emit("lsp://exit", 0i32);
                    return;
                }

                match spawn_sidecar() {
                    Ok((child, stdin, new_stdout)) => {
                        // Swap in fresh handles under the same locks used by lsp_start.
                        if let Ok(mut g) = state.stdin.lock() {
                            *g = Some(stdin);
                        }
                        if let Ok(mut g) = state.child.lock() {
                            *g = Some(child);
                        }
                        break new_stdout;
                    }
                    Err(_) => {
                        // Spawn itself failed; retry until the budget is exhausted.
                        if !should_restart(
                            shutting_down.load(Ordering::SeqCst),
                            attempts_made,
                            MAX_RESTART_RETRIES,
                        ) {
                            let _ = app.emit("lsp://exit", -1i32);
                            return;
                        }
                    }
                }
            };

            stdout = new_stdout;
            let _ = app.emit("lsp://restart", ());
            // loop continues, reading the relaunched child's stdout.
        }
    });
}

// --- tauri commands ---------------------------------------------------------

#[tauri::command]
fn lsp_start(app: AppHandle, state: State<'_, LspState>) -> Result<(), String> {
    // Idempotent: hold the `child` lock across the whole check-spawn-store so two
    // concurrent calls can't both pass the guard and spawn duplicate children
    // (the second would block here until the first stores Some, then return early).
    let mut child_guard = state.child.lock().map_err(|e| e.to_string())?;
    if child_guard.is_some() {
        return Ok(());
    }

    // A fresh start clears any prior shutdown intent so the supervisor is armed.
    state.shutting_down.store(false, Ordering::SeqCst);

    let (child, stdin, stdout) = spawn_sidecar()?;

    *state.stdin.lock().map_err(|e| e.to_string())? = Some(stdin);
    *child_guard = Some(child); // stored while still holding the guard => atomic

    spawn_reader_thread(app.clone(), stdout, state.shutting_down.clone());

    Ok(())
}

#[tauri::command]
fn lsp_send(state: State<'_, LspState>, message: String) -> Result<(), String> {
    let mut guard = state.stdin.lock().map_err(|e| e.to_string())?;
    let stdin = guard.as_mut().ok_or("LSP not started")?;
    write_frame(stdin, &message).map_err(|e| e.to_string())?;
    Ok(())
}

/// Intentional shutdown: arm the no-restart flag and tear the child down. After
/// this the reader thread will emit `lsp://exit` (code 0) rather than relaunch.
/// Idempotent and safe to call when nothing is running.
#[tauri::command]
fn lsp_stop(state: State<'_, LspState>) -> Result<(), String> {
    state.shutting_down.store(true, Ordering::SeqCst);
    // Drop stdin so the child sees EOF, then kill to be certain it exits.
    if let Ok(mut g) = state.stdin.lock() {
        *g = None;
    }
    if let Ok(mut g) = state.child.lock() {
        if let Some(mut child) = g.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    Ok(())
}

/// Return the application version (from Cargo metadata) so the About panel can
/// display it.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(LspState::default())
        .invoke_handler(tauri::generate_handler![
            lsp_start, lsp_send, lsp_stop, app_version
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// --- tests ------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn round_trip_ascii() {
        let payload = r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#;
        let mut buf: Vec<u8> = Vec::new();
        write_frame(&mut buf, payload).unwrap();

        let as_str = String::from_utf8(buf.clone()).unwrap();
        assert!(as_str.starts_with(&format!("Content-Length: {}\r\n\r\n", payload.len())));

        let mut cur = Cursor::new(buf);
        let got = read_frame(&mut cur).unwrap();
        assert_eq!(got.as_deref(), Some(payload));
    }

    #[test]
    fn round_trip_utf8_byte_length() {
        let payload = "{\"msg\":\"caf\u{00e9} \u{2603}\"}"; // é + snowman
        assert!(payload.as_bytes().len() > payload.chars().count());
        let mut buf = Vec::new();
        write_frame(&mut buf, payload).unwrap();
        let header = format!("Content-Length: {}\r\n\r\n", payload.as_bytes().len());
        assert!(String::from_utf8(buf.clone()).unwrap().starts_with(&header));
        let mut cur = Cursor::new(buf);
        assert_eq!(read_frame(&mut cur).unwrap().as_deref(), Some(payload));
    }

    #[test]
    fn read_handles_split_reads() {
        // A reader that yields 1 byte at a time still reassembles.
        struct OneByteAtATime(Vec<u8>, usize);
        impl std::io::Read for OneByteAtATime {
            fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
                if self.1 >= self.0.len() || out.is_empty() {
                    return Ok(0);
                }
                out[0] = self.0[self.1];
                self.1 += 1;
                Ok(1)
            }
        }
        let payload = r#"{"a":1,"b":[1,2,3]}"#;
        let mut framed = Vec::new();
        write_frame(&mut framed, payload).unwrap();
        let mut reader = BufReader::new(OneByteAtATime(framed, 0));
        assert_eq!(read_frame(&mut reader).unwrap().as_deref(), Some(payload));
    }

    #[test]
    fn two_frames_back_to_back() {
        let a = r#"{"id":1}"#;
        let b = r#"{"id":2}"#;
        let mut buf = Vec::new();
        write_frame(&mut buf, a).unwrap();
        write_frame(&mut buf, b).unwrap();
        let mut cur = Cursor::new(buf);
        assert_eq!(read_frame(&mut cur).unwrap().as_deref(), Some(a));
        assert_eq!(read_frame(&mut cur).unwrap().as_deref(), Some(b));
        assert_eq!(read_frame(&mut cur).unwrap(), None); // clean EOF after last
    }

    #[test]
    fn clean_eof_returns_none() {
        let mut cur = Cursor::new(Vec::<u8>::new());
        assert_eq!(read_frame(&mut cur).unwrap(), None);
    }

    #[test]
    fn header_key_is_case_insensitive() {
        // A non-canonical casing (and an ignored extra header) must still parse.
        let body = r#"{"id":9}"#;
        let framed = format!(
            "CONTENT-LENGTH: {}\r\nContent-Type: application/vscode-jsonrpc\r\n\r\n{}",
            body.len(),
            body
        );
        let mut cur = Cursor::new(framed.into_bytes());
        assert_eq!(read_frame(&mut cur).unwrap().as_deref(), Some(body));
    }

    // --- supervision-decision tests -----------------------------------------

    #[test]
    fn restart_allowed_within_budget() {
        // First unexpected exit (0 attempts made) with a budget of 3 => restart.
        assert!(should_restart(false, 0, 3));
        assert!(should_restart(false, 1, 3));
        assert!(should_restart(false, 2, 3));
    }

    #[test]
    fn restart_denied_once_budget_exhausted() {
        // After 3 relaunches with a budget of 3, stop restarting.
        assert!(!should_restart(false, 3, 3));
        assert!(!should_restart(false, 4, 3));
    }

    #[test]
    fn shutdown_suppresses_restart_even_with_budget_left() {
        // An intentional shutdown must never restart, regardless of attempts left.
        assert!(!should_restart(true, 0, 3));
        assert!(!should_restart(true, 2, 3));
    }

    #[test]
    fn zero_budget_never_restarts() {
        // A retry budget of 0 disables auto-restart entirely.
        assert!(!should_restart(false, 0, 0));
    }

    #[test]
    fn app_version_matches_cargo_pkg_version() {
        assert_eq!(app_version(), env!("CARGO_PKG_VERSION"));
        assert!(!app_version().is_empty());
    }
}
