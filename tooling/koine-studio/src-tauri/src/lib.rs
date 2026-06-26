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

use std::io::{self, BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

// `portable-pty` (WezTerm) abstracts Unix openpty + Windows ConPTY behind one API. Its `Child`
// trait collides by name with `std::process::Child`, so it is imported under an alias.
use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, MasterPty, PtySize};
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

/// State for the MCP HTTP sidecar (`koine mcp --http`). Unlike the LSP child this is a fire-and-
/// forget HTTP server: there is no stdin piping or framing — we just keep the child alive and read
/// its stderr to scrape the loopback URL it binds, so the UI can show a copy-paste `mcp.json`.
#[derive(Default)]
struct McpState {
    /// keep the Child so it is not dropped; lets `mcp_endpoint` guard against a double start.
    child: Mutex<Option<Child>>,
    /// the scraped `http://HOST:PORT/mcp` endpoint, once the sidecar announces it on stderr. An
    /// `Arc` so the stderr-reader thread can own a clone (managed `State` is not `'static`).
    endpoint: Arc<Mutex<Option<String>>>,
}

/// State for the integrated terminal's pseudo-terminal (PTY). Unlike the LSP child this is a raw
/// byte stream with no framing and — deliberately — no supervision: a shell that exits should just
/// close the terminal (`pty://exit`), never relaunch. We keep the master end (to resize and feed
/// keystrokes) plus the spawned child (to kill on stop and reap its exit code) behind Mutexes so the
/// Tauri commands and the reader thread can share them. `Box<dyn Trait + Send>` boxes erase the
/// platform-specific PTY backend; `Mutex<Option<_>>::default()` is `None` regardless of the inner
/// type, so `#[derive(Default)]` still applies.
#[derive(Default)]
struct PtyState {
    /// The master side of the PTY; `None` until `pty_start`. Held so `pty_resize` can resize it and
    /// so it is dropped (closing the PTY) on stop.
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    /// The writer onto the PTY master (taken once from `master.take_writer()`); `pty_write` feeds
    /// keystrokes through it. Kept separate so writing does not contend the master lock with resize.
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    /// The spawned shell child; kept so `pty_stop` can kill it and the reader thread can `wait()` it
    /// to recover the real exit code for `pty://exit`.
    child: Mutex<Option<Box<dyn PtyChild + Send + Sync>>>,
    /// Set once the user/app asks to stop; tells the reader thread the EOF was intentional so it
    /// reports a clean exit (0) rather than trying to reap a child `pty_stop` already took.
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

/// Resolve how to launch the MCP HTTP server. Mirrors [`resolve_sidecar_command`]: `KOINE_MCP`
/// then `KOINE_LSP` (the same self-contained `koine` binary) take precedence; otherwise fall back
/// to the Debug DLL via `dotnet`. The server is asked to bind a loopback OS-assigned port (`--port
/// 0`) and announce it on stderr, which `mcp_endpoint` scrapes.
fn resolve_mcp_command() -> Command {
    let mcp_args = ["mcp", "--http", "--port", "0"];
    if let Ok(bin) = std::env::var("KOINE_MCP").or_else(|_| std::env::var("KOINE_LSP")) {
        let mut c = Command::new(bin);
        c.args(mcp_args);
        c
    } else {
        let dll = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../src/Koine.Cli/bin/Debug/net10.0/Koine.Cli.dll"
        );
        let mut c = Command::new("dotnet");
        c.arg(dll).args(mcp_args);
        c
    }
}

/// Extract the announced MCP endpoint URL from one stderr line. `HttpHost` prints
/// `[koine-mcp] http://127.0.0.1:PORT/mcp`; any other line (Kestrel's own startup logs included)
/// yields `None`. Pure so the scrape policy is unit-tested without spawning a process.
fn parse_mcp_endpoint(line: &str) -> Option<String> {
    let rest = line.split_once("[koine-mcp]")?.1.trim();
    if rest.starts_with("http://") || rest.starts_with("https://") {
        Some(rest.to_string())
    } else {
        None
    }
}

// --- terminal shell resolution ----------------------------------------------

/// Decide which shell program (and args) the integrated terminal should spawn. Pure so the policy is
/// unit-tested without opening a PTY: a caller-supplied `os_shell` (e.g. the user's `$SHELL`) is used
/// verbatim; with `None` we fall back to a platform default — `$SHELL` (then `/bin/sh`) on Unix, and
/// `cmd` on Windows. We launch the bare interactive shell with no synthetic args, so the program
/// is returned alongside an (currently always empty) arg vector that keeps the call site uniform and
/// leaves room for future per-shell flags.
fn resolve_shell_command(os_shell: Option<&str>) -> (String, Vec<String>) {
    if let Some(shell) = os_shell {
        return (shell.to_string(), Vec::new());
    }
    // No shell named: pick a sensible platform default. `cfg!(windows)` is a const so the unused
    // branch is dead-code-eliminated rather than a warning.
    if cfg!(windows) {
        ("cmd".to_string(), Vec::new())
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        (shell, Vec::new())
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

// --- terminal PTY reader thread ---------------------------------------------

/// Pull the longest immediately-decodable UTF-8 prefix out of `carry`, returning it as a `String` and
/// leaving behind only a trailing *incomplete* multibyte sequence (at most 3 bytes) for the next read
/// to complete. This is what keeps a multibyte code point that straddles a 4 KB read boundary from
/// being corrupted: a naive per-read `from_utf8_lossy` would replace the split halves with U+FFFD,
/// but here the partial tail is retained until its continuation bytes arrive. Genuinely *invalid*
/// bytes (not a boundary split) are emitted lossily and drained, so `carry` can never grow unbounded
/// on malformed input. Returns `None` when nothing is emittable yet (empty, or only an incomplete
/// tail). Pure, so the boundary policy is unit-tested without opening a PTY.
fn take_decodable(carry: &mut Vec<u8>) -> Option<String> {
    let end = match std::str::from_utf8(carry) {
        Ok(s) => s.len(),
        Err(e) => match e.error_len() {
            None => e.valid_up_to(),            // incomplete trailing sequence — keep it for next read
            Some(bad) => e.valid_up_to() + bad, // genuinely invalid bytes — emit lossily, don't retain
        },
    };
    if end == 0 {
        return None;
    }
    let chunk = String::from_utf8_lossy(&carry[..end]).into_owned();
    carry.drain(..end);
    Some(chunk)
}

/// Spawn the reader thread that drains the PTY master and relays it to the frontend. It reads raw
/// bytes (terminal output is not line- or frame-delimited) into a carry buffer and emits the longest
/// valid-UTF-8 prefix as `pty://data`, holding back any partial multibyte tail until its continuation
/// bytes arrive (see [`take_decodable`]) so non-ASCII output (TUIs, emoji/CJK filenames) is not
/// mojibake'd at read boundaries. When the read hits EOF the shell has gone: we flush any trailing
/// bytes, reap the child to recover its exit code, and emit `pty://exit` exactly once. Unlike the LSP
/// sidecar there is **no** supervision/relaunch — an exited shell simply closes the terminal.
/// `std::thread` + `std::io` only; no async runtime.
fn spawn_pty_reader_thread(
    app: AppHandle,
    mut reader: Box<dyn Read + Send>,
    shutting_down: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF: the shell closed its end of the PTY
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    while let Some(chunk) = take_decodable(&mut carry) {
                        let _ = app.emit("pty://data", chunk);
                    }
                }
                Err(_) => break, // a read error means the PTY is gone; treat it as EOF
            }
        }
        // Flush any trailing bytes (an incomplete sequence at the very end) lossily so nothing the
        // shell wrote before closing is silently dropped.
        if !carry.is_empty() {
            let _ = app.emit("pty://data", String::from_utf8_lossy(&carry).into_owned());
        }

        // The PTY reached EOF. Recover the exit code and announce it once, then clear the managed
        // handles so a later `pty_start` is a clean fresh start.
        let state = app.state::<PtyState>();
        let reaped = state.child.lock().ok().and_then(|mut g| g.take());
        let code = if shutting_down.load(Ordering::SeqCst) {
            // Intentional stop: `pty_stop` already took and killed the child, so there is nothing to
            // reap — report a clean exit.
            0i32
        } else {
            // Natural exit: wait the child for its real status (defaulting to 0 if it was already
            // reaped or the wait fails).
            reaped
                .and_then(|mut child| child.wait().ok())
                .map(|status| status.exit_code() as i32)
                .unwrap_or(0)
        };
        if let Ok(mut g) = state.writer.lock() {
            *g = None;
        }
        if let Ok(mut g) = state.master.lock() {
            *g = None;
        }
        let _ = app.emit("pty://exit", code);
    });
}

// --- workspace filesystem (open-folder directory mode) ----------------------

/// One `.koi` file discovered under a user-picked workspace folder. JSON keys are
/// camelCased (`path` / `name` / `relPath`) for the frontend tree.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct KoiFile {
    /// Absolute path to the file.
    path: String,
    /// File name (last path component).
    name: String,
    /// Path relative to the picked folder, forward-slashed for stable tree keys.
    rel_path: String,
}

/// True if `path` lies under a directory the workspace scan must skip: a build
/// output (`bin`/`obj`), a git dir, or `node_modules`. Only segments BELOW the
/// opened `root` are considered — so a workspace whose own path happens to sit
/// under e.g. a `bin/` ancestor is still scanned (matching the browser backend
/// and the server's relative-path `ScanWorkspace` filter). `node_modules` is
/// skipped to stay consistent with the browser explorer.
fn is_skipped_path(path: &std::path::Path, root: &std::path::Path) -> bool {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.components().any(|c| {
        matches!(
            c.as_os_str().to_str(),
            Some("bin") | Some("obj") | Some(".git") | Some("node_modules")
        )
    })
}

/// Recursively collect every `.koi` file (case-insensitive extension) under `dir`,
/// skipping `bin`/`obj`/`.git` subtrees. Results are sorted by `rel_path` for a
/// stable tree order. Returns `Err` if the root directory cannot be read.
#[tauri::command]
fn list_koi_files(dir: String) -> Result<Vec<KoiFile>, String> {
    let root = std::path::Path::new(&dir);
    let mut out: Vec<KoiFile> = Vec::new();
    // Explicit stack to avoid recursion-depth limits and a walkdir dependency.
    let mut stack: Vec<std::path::PathBuf> = vec![root.to_path_buf()];

    while let Some(current) = stack.pop() {
        let entries = std::fs::read_dir(&current)
            .map_err(|e| format!("failed to read directory {}: {e}", current.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let file_type = entry.file_type().map_err(|e| e.to_string())?;
            if is_skipped_path(&path, root) {
                continue;
            }
            if file_type.is_dir() {
                stack.push(path);
            } else if file_type.is_file() && is_koi_file(&path) {
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default()
                    .to_string();
                let rel = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push(KoiFile {
                    path: path.to_string_lossy().into_owned(),
                    name,
                    rel_path: rel,
                });
            }
        }
    }

    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(out)
}

/// Read a file's contents as UTF-8 text. Errors are surfaced as strings.
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("failed to read {path}: {e}"))
}

/// Write `contents` to `path`, replacing any existing file. Errors as strings.
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("failed to write {path}: {e}"))
}

/// Run `git -C <dir> <args...>` and return its stdout, for the inspector's per-element change
/// history (issue #150). The frontend builds the full `log -L <start>,<end>:<file>` argument vector
/// (see `gitHistory.ts`), so this command is a thin, read-only exec wrapper — it refuses anything but
/// `git log`. Failures (git not installed, `dir` is not a repository, the file is untracked) surface
/// as `Err(String)`; the caller turns any error into a hidden "Change history" section.
#[tauri::command]
fn git_log_for_range(dir: String, args: Vec<String>) -> Result<String, String> {
    // Defence in depth: only the read-only `git log` invocation the UI builds is ever permitted.
    if args.first().map(String::as_str) != Some("log") {
        return Err("unsupported git operation".to_string());
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(&dir)
        .args(&args)
        .output()
        .map_err(|e| format!("git-unavailable: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

// --- source control (git) ---------------------------------------------------
//
// The Source Control panel (issue #272) drives these from the Tauri `Platform`. Each is a thin,
// per-invocation `git -C <dir> …` shell-out (no long-lived state), mirroring `git_log_for_range`'s
// exec pattern: a spawn failure (git missing) becomes `Err("git-unavailable: …")`, and a non-zero
// exit (dir not a work tree, bad ref, nothing to commit) returns the trimmed stderr. The structs
// serialize to the exact camelCase the TS `Platform` git types expect.

/// One path reported by `git status`, modeled per (file, area): a file changed in BOTH the index
/// and the working tree is emitted TWICE — once `staged: true`, once `staged: false` — so the panel
/// groups Staged Changes / Changes by the flag alone. `status` is one of the TS literals
/// (`modified`/`added`/`deleted`/`renamed`/`copied`/`untracked`/`conflicted`).
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct GitFile {
    /// Path relative to the repo, forward-slashed (git already reports it that way).
    rel_path: String,
    /// True for an index (staged) entry; false for a worktree change or an untracked file.
    staged: bool,
    /// The kind of change for this (file, area).
    status: String,
}

/// A snapshot of `git status` for a workspace folder: the current branch plus its changed paths.
/// `branch` and `files` are already camelCase, so no field rename is needed.
#[derive(serde::Serialize)]
struct GitStatus {
    /// The current branch name, or `(detached)` for a detached HEAD (git's own header value).
    branch: String,
    /// Every changed path — staged, unstaged, and untracked entries (see [`GitFile`]).
    files: Vec<GitFile>,
}

/// One commit in `git log`, newest first. Fields are single words, already the camelCase the TS
/// `GitLogEntry` expects.
#[derive(serde::Serialize)]
struct GitLogEntry {
    /// The full 40-char commit SHA.
    sha: String,
    /// The author name.
    author: String,
    /// The author date as a strict ISO-8601 string (`%aI`).
    date: String,
    /// The commit subject line (`%s`).
    message: String,
}

/// Run `git -C <dir> <args…>` and return its stdout, or an `Err` shaped like `git_log_for_range`:
/// a spawn failure (git not installed) → `git-unavailable: …`; a non-zero exit → the trimmed
/// stderr. The thin core every source-control command shares.
fn run_git(dir: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("git-unavailable: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Map a porcelain-v2 status letter to the TS `GitFile.status` literal. Unknown/typechange (`T`)
/// degrades to `modified` so the value always stays within the TS union.
fn git_status_letter(c: char) -> String {
    match c {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        _ => "modified", // 'M', 'T' (typechange) and any future letter
    }
    .to_string()
}

/// Expand a porcelain-v2 `<XY>` field for `path` into GitFiles: an index (staged) entry when X is
/// not `.`, and a worktree (unstaged) entry when Y is not `.` — so a both-areas file yields two.
fn push_xy_files(files: &mut Vec<GitFile>, xy: &str, path: &str) {
    let mut chars = xy.chars();
    let x = chars.next().unwrap_or('.');
    let y = chars.next().unwrap_or('.');
    if x != '.' {
        files.push(GitFile {
            rel_path: path.to_string(),
            staged: true,
            status: git_status_letter(x),
        });
    }
    if y != '.' {
        files.push(GitFile {
            rel_path: path.to_string(),
            staged: false,
            status: git_status_letter(y),
        });
    }
}

/// `git status` for the open folder: the current branch plus every changed path. Parses
/// `--porcelain=v2 -b` — the branch from the `# branch.head` header; `1 <XY> …` ordinary entries
/// (staged when X≠`.`, unstaged when Y≠`.`, so a both-areas file appears twice); `2 …` renames/
/// copies (new path before the tab); `? …` untracked; `u …` unmerged → `conflicted`. `Err` when
/// `dir` is not a work tree.
#[tauri::command]
fn git_status(dir: String) -> Result<GitStatus, String> {
    let out = run_git(&dir, &["status", "--porcelain=v2", "-b"])?;
    let mut branch = String::new();
    let mut files: Vec<GitFile> = Vec::new();

    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            branch = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("? ") {
            files.push(GitFile {
                rel_path: rest.to_string(),
                staged: false,
                status: "untracked".to_string(),
            });
        } else if let Some(rest) = line.strip_prefix("1 ") {
            // <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>  (8 fields; path may contain spaces).
            let mut fields = rest.splitn(8, ' ');
            let xy = fields.next().unwrap_or("..");
            if let Some(path) = fields.nth(6) {
                push_xy_files(&mut files, xy, path);
            }
        } else if let Some(rest) = line.strip_prefix("2 ") {
            // <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\t<origPath>  (9 fields).
            let mut fields = rest.splitn(9, ' ');
            let xy = fields.next().unwrap_or("..");
            if let Some(path_and_orig) = fields.nth(7) {
                // The new path precedes the tab; the original path follows it.
                let path = path_and_orig.split('\t').next().unwrap_or(path_and_orig);
                push_xy_files(&mut files, xy, path);
            }
        } else if let Some(rest) = line.strip_prefix("u ") {
            // Unmerged: <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>  (10 fields).
            let mut fields = rest.splitn(10, ' ');
            if let Some(path) = fields.nth(9) {
                files.push(GitFile {
                    rel_path: path.to_string(),
                    staged: false,
                    status: "conflicted".to_string(),
                });
            }
        }
    }

    Ok(GitStatus { branch, files })
}

/// The unified diff for one path: the worktree diff, or the staged (`--cached`) diff when `staged`.
/// Returns git's stdout verbatim — empty when there is no change in the requested area.
#[tauri::command]
fn git_diff(dir: String, rel_path: String, staged: bool) -> Result<String, String> {
    let mut args: Vec<&str> = vec!["diff"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(&rel_path);
    run_git(&dir, &args)
}

/// Stage paths (`git add -- <paths…>`): move worktree/untracked changes into the index.
#[tauri::command]
fn git_stage(dir: String, rel_paths: Vec<String>) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(rel_paths.iter().map(String::as_str));
    run_git(&dir, &args).map(|_| ())
}

/// Unstage paths (`git reset -- <paths…>`): reset the index entries back to HEAD, leaving the
/// worktree untouched — the inverse of [`git_stage`].
#[tauri::command]
fn git_unstage(dir: String, rel_paths: Vec<String>) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["reset", "--quiet", "--"];
    args.extend(rel_paths.iter().map(String::as_str));
    run_git(&dir, &args).map(|_| ())
}

/// Commit the staged area with `message` (`git commit -m`). `Err` (with git's stderr) when there is
/// nothing staged or the identity is unset.
#[tauri::command]
fn git_commit(dir: String, message: String) -> Result<(), String> {
    run_git(&dir, &["commit", "-m", &message]).map(|_| ())
}

/// The local branch names (`git branch --format=%(refname:short)`), one per entry.
#[tauri::command]
fn git_branches(dir: String) -> Result<Vec<String>, String> {
    let out = run_git(&dir, &["branch", "--format=%(refname:short)"])?;
    Ok(out
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect())
}

/// Switch the working tree to `branch` (`git checkout`). `Err` (git's stderr) when the branch is
/// unknown or the switch is blocked by local changes.
#[tauri::command]
fn git_checkout(dir: String, branch: String) -> Result<(), String> {
    run_git(&dir, &["checkout", &branch]).map(|_| ())
}

/// `git log` newest first, optionally scoped to `rel_path`. Uses a US-delimited
/// (`%H\x1f%an\x1f%aI\x1f%s`) one-record-per-line format so an author name or subject containing
/// spaces/colons can't corrupt the split. `Err` on a non-repo dir or an unborn branch (no commits).
#[tauri::command]
fn git_log(dir: String, rel_path: Option<String>) -> Result<Vec<GitLogEntry>, String> {
    let mut args: Vec<&str> = vec!["log", "--pretty=format:%H%x1f%an%x1f%aI%x1f%s"];
    if let Some(ref p) = rel_path {
        args.push("--");
        args.push(p.as_str());
    }
    let out = run_git(&dir, &args)?;

    let mut entries: Vec<GitLogEntry> = Vec::new();
    for line in out.lines() {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split('\u{1f}');
        entries.push(GitLogEntry {
            sha: parts.next().unwrap_or("").to_string(),
            author: parts.next().unwrap_or("").to_string(),
            date: parts.next().unwrap_or("").to_string(),
            message: parts.next().unwrap_or("").to_string(),
        });
    }
    Ok(entries)
}

// --- workspace explorer tree + mutations ------------------------------------

/// One node in the workspace explorer tree under an opened folder — every
/// non-skipped directory (even empty) plus every `.koi` file. JSON keys are
/// camelCased (`token` / `name` / `relPath` / `kind` / `children`) for the
/// frontend; `token` is the absolute path, the same read/write token scheme as
/// `KoiFile.path`. `children` is `Some` for directories (the eager subtree) and
/// `None` for files.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FsEntry {
    /// Absolute path to the entry (its opaque token).
    token: String,
    /// Last path segment (file or directory name).
    name: String,
    /// Path relative to the opened folder, forward-slashed for stable tree keys.
    rel_path: String,
    /// `"file"` for a `.koi` file, `"dir"` for a directory.
    kind: &'static str,
    /// The eager child subtree for a directory; `None` for a file.
    children: Option<Vec<FsEntry>>,
}

/// True if a `.koi` file (case-insensitive extension).
fn is_koi_file(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("koi"))
}

/// A caller-supplied relative path is safe only if it is non-empty, not absolute, and made entirely
/// of normal components (no `.`, `..`, root or drive prefix) — defence in depth so a name typed in
/// the UI can never write outside the opened workspace folder.
fn is_safe_relpath(rel: &str) -> bool {
    !rel.is_empty()
        && !std::path::Path::new(rel).is_absolute()
        && std::path::Path::new(rel)
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
}

/// A single entry name (for rename) is safe only if non-empty, separator-free, and not `.`/`..`.
fn is_safe_name(name: &str) -> bool {
    !name.is_empty() && !name.contains('/') && !name.contains('\\') && name != "." && name != ".."
}

/// Build the explorer subtree for `dir`: every non-skipped child directory
/// (recursively, even when empty) plus every `.koi` file, sorted folders-first
/// then by name at each level. `root` anchors the forward-slashed `rel_path`.
fn build_entries(
    dir: &std::path::Path,
    root: &std::path::Path,
) -> Result<Vec<FsEntry>, String> {
    let mut dirs: Vec<FsEntry> = Vec::new();
    let mut files: Vec<FsEntry> = Vec::new();

    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("failed to read directory {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if is_skipped_path(&path, root) {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        if file_type.is_dir() {
            dirs.push(FsEntry {
                token: path.to_string_lossy().into_owned(),
                name,
                rel_path: rel,
                kind: "dir",
                children: Some(build_entries(&path, root)?),
            });
        } else if file_type.is_file() && is_koi_file(&path) {
            files.push(FsEntry {
                token: path.to_string_lossy().into_owned(),
                name,
                rel_path: rel,
                kind: "file",
                children: None,
            });
        }
    }

    // Folders first, then files; alphabetical by name within each group.
    dirs.sort_by(|a, b| a.name.cmp(&b.name));
    files.sort_by(|a, b| a.name.cmp(&b.name));
    dirs.append(&mut files);
    Ok(dirs)
}

/// The full explorer tree (directories AND `.koi` files) under an opened folder.
/// Directories are included even when empty; `bin`/`obj`/`.git` subtrees are
/// skipped. Sorted folders-first then alphabetically at every level. Returns
/// `Err` if the root directory cannot be read.
#[tauri::command]
fn list_entries(dir: String) -> Result<Vec<FsEntry>, String> {
    let root = std::path::Path::new(&dir);
    build_entries(root, root)
}

/// List the IMMEDIATE children (files AND directories, regardless of extension) of `rel_path`
/// under the opened `dir` folder. A flat, single-level listing for non-`.koi` workspace docs (the
/// ADR/Notes surface, `docs/adr/*.md` etc.) — the counterpart to the recursive, `.koi`-only
/// `list_entries` tree. `children` is always `None` (no recursion). `rel_path` is forward-slashed
/// and relative to the opened folder, and is validated so it can never escape it. Sorted
/// folders-first then by name; `Err` when the directory cannot be read (callers treat that as "no
/// docs yet").
#[tauri::command]
fn list_dir(dir: String, rel_path: String) -> Result<Vec<FsEntry>, String> {
    if !is_safe_relpath(&rel_path) {
        return Err(format!("invalid path: {rel_path}"));
    }
    let root = std::path::Path::new(&dir);
    let target = root.join(&rel_path);
    let mut dirs: Vec<FsEntry> = Vec::new();
    let mut files: Vec<FsEntry> = Vec::new();

    let entries = std::fs::read_dir(&target)
        .map_err(|e| format!("failed to read directory {}: {e}", target.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if is_skipped_path(&path, root) {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let token = path.to_string_lossy().into_owned();
        if file_type.is_dir() {
            dirs.push(FsEntry {
                token,
                name,
                rel_path: rel,
                kind: "dir",
                children: None,
            });
        } else if file_type.is_file() {
            files.push(FsEntry {
                token,
                name,
                rel_path: rel,
                kind: "file",
                children: None,
            });
        }
    }

    // Folders first, then files; alphabetical by name within each group.
    dirs.sort_by(|a, b| a.name.cmp(&b.name));
    files.sort_by(|a, b| a.name.cmp(&b.name));
    dirs.append(&mut files);
    Ok(dirs)
}

/// Create a file at `rel_path` under `folder`, creating intermediate dirs, and
/// return its absolute path. Errors if the file already exists.
#[tauri::command]
fn create_file(folder: String, rel_path: String, contents: String) -> Result<String, String> {
    if !is_safe_relpath(&rel_path) {
        return Err(format!("invalid path: {rel_path}"));
    }
    let target = std::path::Path::new(&folder).join(&rel_path);
    if target.exists() {
        return Err(format!("already exists: {}", target.display()));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    }
    std::fs::write(&target, contents)
        .map_err(|e| format!("failed to write {}: {e}", target.display()))?;
    Ok(target.to_string_lossy().into_owned())
}

/// Create a (possibly nested) directory at `rel_path` under `folder` and return
/// its absolute path.
#[tauri::command]
fn create_folder(folder: String, rel_path: String) -> Result<String, String> {
    if !is_safe_relpath(&rel_path) {
        return Err(format!("invalid path: {rel_path}"));
    }
    let target = std::path::Path::new(&folder).join(&rel_path);
    std::fs::create_dir_all(&target)
        .map_err(|e| format!("failed to create {}: {e}", target.display()))?;
    Ok(target.to_string_lossy().into_owned())
}

/// Rename the entry at `token` (a file or directory) in place to `new_name` and
/// return the new absolute path. Errors if the target name already exists.
#[tauri::command]
fn rename_entry(token: String, new_name: String) -> Result<String, String> {
    if !is_safe_name(&new_name) {
        return Err(format!("invalid name: {new_name}"));
    }
    let src = std::path::Path::new(&token);
    let parent = src
        .parent()
        .ok_or_else(|| format!("no parent for {token}"))?;
    let target = parent.join(&new_name);
    if target.exists() {
        return Err(format!("already exists: {}", target.display()));
    }
    std::fs::rename(src, &target)
        .map_err(|e| format!("failed to rename {token}: {e}"))?;
    Ok(target.to_string_lossy().into_owned())
}

/// Delete the entry at `token`: a directory and everything under it, or a file.
#[tauri::command]
fn delete_entry(token: String) -> Result<(), String> {
    let path = std::path::Path::new(&token);
    let result = if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    result.map_err(|e| format!("failed to delete {token}: {e}"))
}

/// Recursively copy `src` to `dst`. `src` may be a file or a directory tree;
/// intermediate destination directories are created as needed.
fn copy_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    if src.is_dir() {
        std::fs::create_dir_all(dst)
            .map_err(|e| format!("failed to create {}: {e}", dst.display()))?;
        let entries = std::fs::read_dir(src)
            .map_err(|e| format!("failed to read directory {}: {e}", src.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(src, dst)
            .map(|_| ())
            .map_err(|e| format!("failed to copy {} -> {}: {e}", src.display(), dst.display()))
    }
}

/// Move (or, when `copy` is true, duplicate) the entry at `token` to
/// `new_rel_path` under `dest_folder`, creating intermediate dirs, and return
/// the destination absolute path. A move uses `fs::rename`; a copy walks the
/// file or directory tree (leaving the source intact).
#[tauri::command]
fn move_entry(
    token: String,
    dest_folder: String,
    new_rel_path: String,
    copy: bool,
) -> Result<String, String> {
    if !is_safe_relpath(&new_rel_path) {
        return Err(format!("invalid path: {new_rel_path}"));
    }
    let src = std::path::Path::new(&token);
    let dest = std::path::Path::new(&dest_folder).join(&new_rel_path);
    // Never clobber an existing destination — mirrors create_file/rename_entry and the browser
    // backend (fs::rename would silently overwrite a file / merge a dir, diverging from them).
    if dest.exists() {
        return Err(format!("already exists: {}", dest.display()));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    }
    if copy {
        copy_recursive(src, &dest)?;
    } else if std::fs::rename(src, &dest).is_err() {
        // fs::rename fails across filesystems (EXDEV); fall back to copy + delete so a move still
        // works across volumes, matching the browser backend's copy-based move semantics.
        copy_recursive(src, &dest)?;
        let removed = if src.is_dir() {
            std::fs::remove_dir_all(src)
        } else {
            std::fs::remove_file(src)
        };
        removed.map_err(|e| format!("failed to remove source {token} after move: {e}"))?;
    }
    Ok(dest.to_string_lossy().into_owned())
}

/// Write raw bytes to `path`, replacing any existing file. Used to save a generated-project zip
/// picked via the dialog plugin; `write_text_file` can't carry binary. Errors as strings.
#[tauri::command]
fn write_bytes(path: String, contents: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("failed to write {path}: {e}"))
}

// --- macOS Dock icon --------------------------------------------------------

/// Set the application's Dock icon at runtime from the bundled PNG (macOS only).
///
/// A packaged `.app` gets its Dock icon from `Info.plist` / `icon.icns`, but
/// `tauri dev` runs the bare `target/debug` executable with no bundle, so the
/// Dock shows a generic placeholder. Calling `NSApplication.setApplicationIconImage`
/// makes the Koine logo appear in BOTH dev and bundled runs. Must run on the main
/// thread (Tauri's `setup` hook does), and after AppKit is initialised (it is by
/// then). A no-op on every other platform.
#[cfg(target_os = "macos")]
fn set_macos_dock_icon() {
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;
    use std::ffi::c_void;

    // The PNG is baked into the binary so it is available with or without a bundle.
    const ICON_PNG: &[u8] = include_bytes!("../icons/icon.png");

    // `setup` runs on the main thread; bail rather than panic if that ever changes.
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };

    // SAFETY: ICON_PNG is a 'static, valid byte buffer; `dataWithBytes:length:`
    // copies it, so the NSData does not alias our slice past the call.
    let data =
        unsafe { NSData::dataWithBytes_length(ICON_PNG.as_ptr() as *const c_void, ICON_PNG.len()) };

    if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
        let app = NSApplication::sharedApplication(mtm);
        // SAFETY: `image` is a valid NSImage; this is the standard AppKit call to
        // replace the running app's Dock/Cmd-Tab icon.
        unsafe { app.setApplicationIconImage(Some(&image)) };
    }
}

// --- application menu -------------------------------------------------------

/// Build and install the native macOS menu bar.
///
/// Beyond looking native, the **Edit** submenu is functionally important: macOS
/// routes Cmd-X/C/V/A and Cmd-Z through the menu, so without these predefined
/// roles the CodeMirror editor (and any web `<input>`) would not receive the
/// clipboard/undo shortcuts. The Window and Help submenus use Tauri's reserved
/// IDs so macOS treats them as the system Window/Help menus (window list, Help
/// search field). The two Help items are dispatched in the `on_menu_event`
/// handler registered on the builder. macOS-only — other platforms keep Tauri's
/// default menu, and their web views handle clipboard shortcuts natively.
#[cfg(target_os = "macos")]
fn build_app_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{
        AboutMetadataBuilder, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
        WINDOW_SUBMENU_ID,
    };

    const APP_NAME: &str = "Koine Studio";

    let about = AboutMetadataBuilder::new()
        .version(Some(env!("CARGO_PKG_VERSION")))
        .authors(Some(vec!["Atypical Consulting".to_string()]))
        .comments(Some("The desktop IDE for the Koine DDD language."))
        .copyright(Some("Copyright © 2026 Atypical Consulting"))
        .license(Some("Apache-2.0"))
        .website(Some("https://github.com/Atypical-Consulting/Koine"))
        .website_label(Some("Koine on GitHub"))
        .build();

    // App menu — becomes the bold application menu on macOS.
    let app_menu = Submenu::with_items(
        app,
        APP_NAME,
        true,
        &[
            &PredefinedMenuItem::about(app, Some(&format!("About {APP_NAME}")), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(&format!("Hide {APP_NAME}")))?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some(&format!("Quit {APP_NAME}")))?,
        ],
    )?;

    // Edit menu — predefined roles wire native clipboard/undo into the editor.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    // View menu.
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;

    // Window menu — the reserved ID lets macOS add its standard window commands.
    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    // Help menu — the reserved ID gives macOS its Help search field.
    let help_menu = Submenu::with_id_and_items(
        app,
        HELP_SUBMENU_ID,
        "Help",
        true,
        &[
            &MenuItem::with_id(app, "help-docs", "Koine Documentation", true, None::<&str>)?,
            &MenuItem::with_id(app, "help-repo", "GitHub Repository", true, None::<&str>)?,
        ],
    )?;

    let menu = Menu::with_items(
        app,
        &[&app_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )?;
    app.set_menu(menu)?;
    Ok(())
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

/// Lazily start the `koine mcp --http` sidecar (idempotent) and return the loopback endpoint URL it
/// announces on stderr, or `None` if it does not appear within the wait budget. The browser backend
/// never calls this (its `Platform.mcpEndpoint` returns null without touching IPC), so a desktop-only
/// affordance can gate purely on the resolved value.
#[tauri::command]
fn mcp_endpoint(state: State<'_, McpState>) -> Result<Option<String>, String> {
    // Spawn once. Hold the child lock across check-spawn-store so two concurrent calls can't both
    // pass the guard and launch duplicate servers.
    {
        let mut child_guard = state.child.lock().map_err(|e| e.to_string())?;
        if child_guard.is_none() {
            let mut cmd = resolve_mcp_command();
            cmd.env("DOTNET_NOLOGO", "1")
                .env("DOTNET_CLI_TELEMETRY_OPTOUT", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped());

            let mut child = cmd
                .spawn()
                .map_err(|e| format!("failed to spawn MCP server: {e}"))?;
            let stderr = child.stderr.take().ok_or("no stderr on MCP child")?;
            *child_guard = Some(child);

            // Reader thread: scrape the endpoint into shared state, then keep draining stderr so the
            // pipe never fills and blocks the server. Owns a clone of the Arc (State isn't 'static).
            let endpoint = state.endpoint.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => break, // EOF or read error: the child is gone
                        Ok(_) => {
                            if let Some(url) = parse_mcp_endpoint(&line) {
                                if let Ok(mut g) = endpoint.lock() {
                                    *g = Some(url);
                                }
                            }
                        }
                    }
                }
            });
        }
    }

    // Wait (bounded) for the announce line; the server binds in well under a second, so this returns
    // promptly on the first call and instantly on later ones (the URL is cached in state).
    for _ in 0..100 {
        if let Ok(g) = state.endpoint.lock() {
            if let Some(url) = g.as_ref() {
                return Ok(Some(url.clone()));
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    Ok(None)
}

/// Stop the MCP sidecar and forget its endpoint. Idempotent and safe when nothing is running.
#[tauri::command]
fn mcp_stop(state: State<'_, McpState>) -> Result<(), String> {
    if let Ok(mut g) = state.child.lock() {
        if let Some(mut child) = g.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    if let Ok(mut g) = state.endpoint.lock() {
        *g = None;
    }
    Ok(())
}

// --- terminal PTY commands --------------------------------------------------

/// Open a PTY, spawn the user's shell into it (rooted at `cwd` when given), and start the reader
/// thread that relays output as `pty://data`. Idempotent: holding the `child` lock across the whole
/// check-spawn-store means two concurrent calls cannot both pass the guard and open duplicate
/// terminals (the second blocks until the first stores `Some`, then returns early).
#[tauri::command]
fn pty_start(
    app: AppHandle,
    state: State<'_, PtyState>,
    cwd: Option<String>,
) -> Result<(), String> {
    let mut child_guard = state.child.lock().map_err(|e| e.to_string())?;
    if child_guard.is_some() {
        return Ok(());
    }

    // A fresh start clears any prior shutdown intent so the reader reports a real exit code.
    state.shutting_down.store(false, Ordering::SeqCst);

    // Open the PTY pair at a conventional default size; the frontend re-syncs it via `pty_resize`
    // as soon as the terminal element is measured.
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("failed to open pty: {e}"))?;

    // Resolve the shell from `$SHELL` (Unix) — `resolve_shell_command` falls back to a platform
    // default when it is unset (and on Windows, where `$SHELL` is absent, that yields `cmd`).
    let (program, args) = resolve_shell_command(std::env::var("SHELL").ok().as_deref());
    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to spawn shell: {e}"))?;
    // Drop the slave now the child holds it: otherwise our retained slave handle would keep the PTY
    // open and the reader would never see EOF when the shell exits.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("failed to clone pty reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("failed to take pty writer: {e}"))?;

    // Store the handles, then store the child while still holding its guard => the start is atomic.
    *state.writer.lock().map_err(|e| e.to_string())? = Some(writer);
    *state.master.lock().map_err(|e| e.to_string())? = Some(pair.master);
    *child_guard = Some(child);

    spawn_pty_reader_thread(app.clone(), reader, state.shutting_down.clone());

    Ok(())
}

/// Feed keystrokes (or pasted text) to the shell by writing the bytes to the PTY master. Errors if
/// the terminal has not been started.
#[tauri::command]
fn pty_write(state: State<'_, PtyState>, data: String) -> Result<(), String> {
    let mut guard = state.writer.lock().map_err(|e| e.to_string())?;
    let writer = guard.as_mut().ok_or("PTY not started")?;
    writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Resize the PTY so the shell (and full-screen TUIs) re-flow to the new viewport. Errors if the
/// terminal has not been started.
#[tauri::command]
fn pty_resize(state: State<'_, PtyState>, cols: u16, rows: u16) -> Result<(), String> {
    let guard = state.master.lock().map_err(|e| e.to_string())?;
    let master = guard.as_ref().ok_or("PTY not started")?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("failed to resize pty: {e}"))?;
    Ok(())
}

/// Intentional shutdown: arm the no-reap flag, drop the writer (so the shell sees stdin EOF), kill
/// the child to be certain it exits, and drop the master. The reader thread then emits `pty://exit`
/// (code 0). Idempotent and safe to call when nothing is running.
#[tauri::command]
fn pty_stop(state: State<'_, PtyState>) -> Result<(), String> {
    state.shutting_down.store(true, Ordering::SeqCst);
    if let Ok(mut g) = state.writer.lock() {
        *g = None;
    }
    if let Ok(mut g) = state.child.lock() {
        if let Some(mut child) = g.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    if let Ok(mut g) = state.master.lock() {
        *g = None;
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
        .manage(McpState::default())
        .manage(PtyState::default())
        .setup(|app| {
            // Make the Koine logo show in the macOS Dock even under `tauri dev`
            // (an unbundled run has no Info.plist/icns to source it from).
            #[cfg(target_os = "macos")]
            {
                set_macos_dock_icon();
                build_app_menu(app)?;
            }
            let _ = app;
            Ok(())
        })
        // Open the Help-menu links in the user's browser. Other menu items use
        // predefined native roles and need no handling here.
        .on_menu_event(|_app, event| match event.id().as_ref() {
            "help-docs" => {
                let _ = tauri_plugin_opener::open_url(
                    "https://atypical-consulting.github.io/Koine/",
                    None::<&str>,
                );
            }
            "help-repo" => {
                let _ = tauri_plugin_opener::open_url(
                    "https://github.com/Atypical-Consulting/Koine",
                    None::<&str>,
                );
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            lsp_start,
            lsp_send,
            lsp_stop,
            mcp_endpoint,
            mcp_stop,
            pty_start,
            pty_write,
            pty_resize,
            pty_stop,
            app_version,
            list_koi_files,
            read_text_file,
            write_text_file,
            git_log_for_range,
            write_bytes,
            list_entries,
            list_dir,
            create_file,
            create_folder,
            rename_entry,
            delete_entry,
            move_entry,
            git_status,
            git_diff,
            git_stage,
            git_unstage,
            git_commit,
            git_branches,
            git_checkout,
            git_log
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // On a clean exit, kill the MCP HTTP sidecar. The LSP child self-terminates (its piped
            // stdin hits EOF when this process goes away), but the MCP server is spawned with null
            // stdin and only watches for SIGTERM/Ctrl+C, so without this it would be orphaned and
            // keep holding its loopback port across Studio restarts. (A SIGKILL/crash can't be
            // intercepted here — the OS reaps it instead.)
            if let tauri::RunEvent::Exit = event {
                // Take the child out in one statement so the lock guard (which borrows `state`) is
                // released before `state` is dropped, then kill the now-owned process.
                let taken = app_handle
                    .state::<McpState>()
                    .child
                    .lock()
                    .ok()
                    .and_then(|mut g| g.take());
                if let Some(mut c) = taken {
                    let _ = c.kill();
                    let _ = c.wait();
                }
            }
        });
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

    // --- MCP endpoint scrape (pure) -----------------------------------------

    #[test]
    fn parse_mcp_endpoint_extracts_the_announced_url() {
        assert_eq!(
            parse_mcp_endpoint("[koine-mcp] http://127.0.0.1:50286/mcp").as_deref(),
            Some("http://127.0.0.1:50286/mcp")
        );
        // Tolerates a logger prefix before the tag and surrounding whitespace.
        assert_eq!(
            parse_mcp_endpoint("  warn: [koine-mcp]   http://127.0.0.1:1/mcp  ").as_deref(),
            Some("http://127.0.0.1:1/mcp")
        );
    }

    #[test]
    fn parse_mcp_endpoint_ignores_unrelated_lines() {
        // Kestrel's own startup log carries a URL but not the koine-mcp tag.
        assert_eq!(
            parse_mcp_endpoint("info: Now listening on: http://127.0.0.1:5000"),
            None
        );
        // The tag without a URL (e.g. a future status line) is not an endpoint.
        assert_eq!(parse_mcp_endpoint("[koine-mcp] starting"), None);
        assert_eq!(parse_mcp_endpoint(""), None);
    }

    // --- workspace filesystem tests -----------------------------------------

    #[test]
    fn list_koi_files_recurses_sorts_and_skips_bin() {
        // Unique-ish temp root derived from the pid (no Instant/SystemTime).
        let root = std::env::temp_dir().join(format!("koine_studio_fs_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root); // clean any stale leftover
        let nested = root.join("contexts");
        let bin = root.join("bin");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::create_dir_all(&bin).unwrap();

        std::fs::write(root.join("billing.koi"), "context Billing {}").unwrap();
        std::fs::write(nested.join("orders.KOI"), "context Orders {}").unwrap();
        std::fs::write(bin.join("skip.koi"), "context Skip {}").unwrap();
        std::fs::write(root.join("notes.txt"), "not a koi file").unwrap();

        let files = list_koi_files(root.to_string_lossy().into_owned()).unwrap();

        // Sorted by rel_path; forward-slashed; bin/ excluded; .txt excluded.
        let rels: Vec<&str> = files.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(rels, vec!["billing.koi", "contexts/orders.KOI"]);

        // Names and absolute paths are populated.
        assert_eq!(files[0].name, "billing.koi");
        assert_eq!(files[1].name, "orders.KOI");
        assert!(files[0].path.ends_with("billing.koi"));
        assert!(std::path::Path::new(&files[1].path).is_absolute());

        // No skipped file leaked through.
        assert!(!files.iter().any(|f| f.rel_path.contains("bin/")));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_koi_files_errors_on_missing_dir() {
        let missing = std::env::temp_dir()
            .join(format!("koine_studio_missing_{}", std::process::id()))
            .to_string_lossy()
            .into_owned();
        assert!(list_koi_files(missing).is_err());
    }

    #[test]
    fn read_and_write_text_file_round_trip() {
        let path = std::env::temp_dir()
            .join(format!("koine_studio_rw_{}.koi", std::process::id()));
        let body = "context Demo {\n  value Money\n}\n";
        write_text_file(path.to_string_lossy().into_owned(), body.to_string()).unwrap();
        let got = read_text_file(path.to_string_lossy().into_owned()).unwrap();
        assert_eq!(got, body);
        let _ = std::fs::remove_file(&path);
    }

    // --- explorer-tree + mutation tests -------------------------------------

    #[test]
    fn list_entries_nests_dirs_and_koi_skips_bin_and_sorts_folders_first() {
        let root = std::env::temp_dir()
            .join(format!("koine_studio_entries_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root); // clean any stale leftover
        let contexts = root.join("contexts");
        let empty = root.join("empty");
        let bin = root.join("bin");
        std::fs::create_dir_all(&contexts).unwrap();
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::create_dir_all(&bin).unwrap();

        std::fs::write(root.join("billing.koi"), "context Billing {}").unwrap();
        std::fs::write(contexts.join("orders.KOI"), "context Orders {}").unwrap();
        std::fs::write(bin.join("skip.koi"), "context Skip {}").unwrap();
        std::fs::write(root.join("notes.txt"), "not a koi file").unwrap();

        let tree = list_entries(root.to_string_lossy().into_owned()).unwrap();

        // Folders first (alpha), then files: contexts/, empty/, billing.koi.
        // bin/ skipped entirely; notes.txt (non-.koi) excluded.
        let names: Vec<&str> = tree.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["contexts", "empty", "billing.koi"]);

        // Directories carry Some(children); files carry None.
        assert_eq!(tree[0].kind, "dir");
        assert!(tree[0].children.is_some());
        assert_eq!(tree[2].kind, "file");
        assert!(tree[2].children.is_none());

        // The empty directory is still present, with an empty child list.
        assert_eq!(tree[1].name, "empty");
        assert_eq!(tree[1].children.as_ref().unwrap().len(), 0);

        // The nested .koi is reachable, with a forward-slashed rel_path and an
        // absolute token.
        let nested = &tree[0].children.as_ref().unwrap()[0];
        assert_eq!(nested.name, "orders.KOI");
        assert_eq!(nested.rel_path, "contexts/orders.KOI");
        assert!(std::path::Path::new(&nested.token).is_absolute());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_dir_lists_immediate_children_of_any_extension_folders_first() {
        let root = std::env::temp_dir()
            .join(format!("koine_studio_listdir_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let adr = root.join("docs").join("adr");
        std::fs::create_dir_all(&adr).unwrap();
        std::fs::create_dir_all(adr.join("archive")).unwrap();
        std::fs::write(adr.join("0002-second.md"), "# 2. Second").unwrap();
        std::fs::write(adr.join("0001-first.md"), "# 1. First").unwrap();
        std::fs::write(adr.join("README.txt"), "not markdown, still listed").unwrap();

        let entries = list_dir(root.to_string_lossy().into_owned(), "docs/adr".to_string()).unwrap();

        // Flat, single-level listing: folder first (alpha), then files (alpha) — of ANY extension.
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["archive", "0001-first.md", "0002-second.md", "README.txt"]);

        // No recursion: every node carries children: None (even the directory).
        assert!(entries.iter().all(|e| e.children.is_none()));
        assert_eq!(entries[0].kind, "dir");
        assert_eq!(entries[1].kind, "file");

        // rel_path is forward-slashed and rooted at the opened folder; token is absolute.
        assert_eq!(entries[1].rel_path, "docs/adr/0001-first.md");
        assert!(std::path::Path::new(&entries[1].token).is_absolute());

        // A missing directory is an Err (the frontend treats it as "no docs yet").
        assert!(list_dir(root.to_string_lossy().into_owned(), "docs/nope".to_string()).is_err());
        // A traversal rel_path is rejected up front.
        assert!(list_dir(root.to_string_lossy().into_owned(), "../escape".to_string()).is_err());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn create_file_and_folder_write_to_disk_and_return_absolute_paths() {
        let root = std::env::temp_dir()
            .join(format!("koine_studio_create_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let folder = root.to_string_lossy().into_owned();

        // create_file makes intermediate dirs and returns the absolute path.
        let file_token = create_file(
            folder.clone(),
            "contexts/billing.koi".to_string(),
            "context Billing {}".to_string(),
        )
        .unwrap();
        assert!(std::path::Path::new(&file_token).is_absolute());
        assert!(file_token.ends_with("billing.koi"));
        assert_eq!(
            std::fs::read_to_string(&file_token).unwrap(),
            "context Billing {}"
        );

        // create_file errors if the target already exists.
        assert!(create_file(
            folder.clone(),
            "contexts/billing.koi".to_string(),
            String::new()
        )
        .is_err());

        // create_folder makes a (nested) directory and returns the absolute path.
        let folder_token =
            create_folder(folder, "contexts/nested/deep".to_string()).unwrap();
        assert!(std::path::Path::new(&folder_token).is_absolute());
        assert!(std::path::Path::new(&folder_token).is_dir());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_entry_renames_on_disk() {
        let root = std::env::temp_dir()
            .join(format!("koine_studio_rename_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let src = root.join("old.koi");
        std::fs::write(&src, "context Old {}").unwrap();

        let new_token = rename_entry(
            src.to_string_lossy().into_owned(),
            "new.koi".to_string(),
        )
        .unwrap();

        assert!(new_token.ends_with("new.koi"));
        assert!(std::path::Path::new(&new_token).exists());
        assert!(!src.exists());
        assert_eq!(
            std::fs::read_to_string(&new_token).unwrap(),
            "context Old {}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_entry_removes_a_directory_recursively() {
        let root = std::env::temp_dir()
            .join(format!("koine_studio_delete_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let nested = root.join("contexts");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("orders.koi"), "context Orders {}").unwrap();

        delete_entry(nested.to_string_lossy().into_owned()).unwrap();
        assert!(!nested.exists());
        // The parent (root) is untouched.
        assert!(root.exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn move_entry_with_copy_leaves_the_source() {
        let root = std::env::temp_dir()
            .join(format!("koine_studio_move_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let src = root.join("billing.koi");
        std::fs::write(&src, "context Billing {}").unwrap();
        let dest_folder = root.to_string_lossy().into_owned();

        // copy = true duplicates: both source and destination exist afterwards.
        let dest_token = move_entry(
            src.to_string_lossy().into_owned(),
            dest_folder,
            "contexts/billing.koi".to_string(),
            true,
        )
        .unwrap();

        assert!(dest_token.ends_with("billing.koi"));
        assert!(std::path::Path::new(&dest_token).exists());
        assert!(src.exists()); // source left intact on a copy
        assert_eq!(
            std::fs::read_to_string(&dest_token).unwrap(),
            "context Billing {}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn move_entry_without_copy_relocates_the_entry() {
        let root = std::env::temp_dir()
            .join(format!("koine_studio_move_rel_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let src = root.join("orders.koi");
        std::fs::write(&src, "context Orders {}").unwrap();

        // copy = false MOVES: the source is gone, the destination has the bytes.
        let dest_token = move_entry(
            src.to_string_lossy().into_owned(),
            root.to_string_lossy().into_owned(),
            "contexts/orders.koi".to_string(),
            false,
        )
        .unwrap();

        assert!(!src.exists()); // source removed on a move
        assert!(std::path::Path::new(&dest_token).exists());
        assert_eq!(std::fs::read_to_string(&dest_token).unwrap(), "context Orders {}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn move_entry_rejects_an_existing_destination() {
        let root = std::env::temp_dir()
            .join(format!("koine_studio_move_clash_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let src = root.join("a.koi");
        let occupied = root.join("b.koi");
        std::fs::write(&src, "AAA").unwrap();
        std::fs::write(&occupied, "BBB").unwrap();

        let err = move_entry(
            src.to_string_lossy().into_owned(),
            root.to_string_lossy().into_owned(),
            "b.koi".to_string(),
            false,
        )
        .unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
        // Both files untouched by the rejected move.
        assert_eq!(std::fs::read_to_string(&occupied).unwrap(), "BBB");
        assert_eq!(std::fs::read_to_string(&src).unwrap(), "AAA");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_skips_only_below_root_not_an_ancestor_named_bin() {
        // A workspace whose own path sits under a `bin/` ancestor must still be scanned: the
        // skip filter only applies to segments BELOW the opened root.
        let outer = std::env::temp_dir().join(format!("koine_bin_anc_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outer);
        let root = outer.join("bin").join("models"); // 'bin' is an ANCESTOR of the opened root
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("orders.koi"), "context Orders {}").unwrap();

        let files = list_koi_files(root.to_string_lossy().into_owned()).unwrap();
        assert_eq!(files.iter().map(|f| f.rel_path.as_str()).collect::<Vec<_>>(), vec!["orders.koi"]);
        let tree = list_entries(root.to_string_lossy().into_owned()).unwrap();
        assert_eq!(tree.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["orders.koi"]);

        let _ = std::fs::remove_dir_all(&outer);
    }

    #[test]
    fn scan_skips_node_modules_subtree() {
        let root = std::env::temp_dir().join(format!("koine_nm_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let nm = root.join("node_modules").join("pkg");
        std::fs::create_dir_all(&nm).unwrap();
        std::fs::write(root.join("keep.koi"), "context Keep {}").unwrap();
        std::fs::write(nm.join("skip.koi"), "context Skip {}").unwrap();

        let files = list_koi_files(root.to_string_lossy().into_owned()).unwrap();
        assert_eq!(files.iter().map(|f| f.rel_path.as_str()).collect::<Vec<_>>(), vec!["keep.koi"]);
        assert!(!list_entries(root.to_string_lossy().into_owned())
            .unwrap()
            .iter()
            .any(|e| e.name == "node_modules"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn mutations_reject_path_traversal() {
        let root = std::env::temp_dir().join(format!("koine_trav_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let folder = root.to_string_lossy().into_owned();
        let f = root.join("a.koi");
        std::fs::write(&f, "x").unwrap();

        assert!(create_file(folder.clone(), "../escape.koi".into(), "x".into()).is_err());
        assert!(create_folder(folder.clone(), "../escape".into()).is_err());
        assert!(rename_entry(f.to_string_lossy().into_owned(), "..".into()).is_err());
        assert!(move_entry(f.to_string_lossy().into_owned(), folder, "../escape.koi".into(), true).is_err());
        // The escaping target was never created in the parent of the workspace.
        assert!(!root.parent().unwrap().join("escape.koi").exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_bytes_round_trips_binary() {
        let path = std::env::temp_dir()
            .join(format!("koine_studio_bytes_{}.zip", std::process::id()));
        // Bytes that are not valid UTF-8 (a zip's local-file-header magic + a stray 0xFF) must
        // survive write_bytes intact, which write_text_file could not carry.
        let body: Vec<u8> = vec![0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe];
        write_bytes(path.to_string_lossy().into_owned(), body.clone()).unwrap();
        let got = std::fs::read(&path).unwrap();
        assert_eq!(got, body);
        let _ = std::fs::remove_file(&path);
    }

    // --- PTY shell resolution (pure) ----------------------------------------

    #[test]
    fn resolve_shell_command_honours_an_explicit_shell() {
        // An explicit shell path is used verbatim as the program, with no extra args — the
        // terminal launches exactly what the caller (or `$SHELL`) named.
        let (program, args) = resolve_shell_command(Some("/bin/zsh"));
        assert_eq!(program, "/bin/zsh");
        assert!(args.is_empty(), "an explicit shell takes no synthetic args");
    }

    #[test]
    fn resolve_shell_command_falls_back_to_a_platform_default() {
        // With no shell named, a non-empty platform default must be chosen ($SHELL/`/bin/sh`
        // on Unix, `cmd` on Windows) so `pty_start` always has something to spawn.
        let (program, _args) = resolve_shell_command(None);
        assert!(!program.is_empty(), "a platform default shell must be chosen");
    }

    // --- PTY chunk decoding (pure) ------------------------------------------

    #[test]
    fn take_decodable_passes_ascii_whole() {
        let mut carry = b"git status\r\n".to_vec();
        assert_eq!(take_decodable(&mut carry).as_deref(), Some("git status\r\n"));
        assert!(carry.is_empty(), "a fully-valid buffer is drained entirely");
    }

    #[test]
    fn take_decodable_holds_back_a_split_multibyte_tail() {
        // '€' is the 3 bytes E2 82 AC. A read boundary that splits it after E2 must NOT corrupt it:
        // nothing is emittable yet, and the partial byte is retained for the next read.
        let mut carry = vec![0xE2];
        assert_eq!(take_decodable(&mut carry), None);
        assert_eq!(carry, vec![0xE2], "the incomplete sequence is kept, not lossily emitted");

        // The continuation bytes arrive on the next read → the whole code point decodes.
        carry.extend_from_slice(&[0x82, 0xAC]);
        assert_eq!(take_decodable(&mut carry).as_deref(), Some("€"));
        assert!(carry.is_empty());
    }

    #[test]
    fn take_decodable_emits_valid_prefix_and_keeps_tail() {
        // "ab" + the first byte of '€': the ASCII prefix is emitted now, the partial tail held back.
        let mut carry = vec![b'a', b'b', 0xE2];
        assert_eq!(take_decodable(&mut carry).as_deref(), Some("ab"));
        assert_eq!(carry, vec![0xE2]);
    }

    #[test]
    fn take_decodable_drains_genuinely_invalid_bytes() {
        // A lone 0xFF is invalid (not an incomplete sequence): it is emitted lossily and drained
        // rather than retained, so the buffer can't grow unbounded waiting for a continuation that
        // will never come. The valid byte that follows is then emitted on the next pull.
        let mut carry = vec![0xFF, b'x'];
        assert_eq!(take_decodable(&mut carry).as_deref(), Some("\u{FFFD}"));
        assert_eq!(take_decodable(&mut carry).as_deref(), Some("x"));
        assert!(carry.is_empty());
    }

    // --- source control (git) -----------------------------------------------
    //
    // These exercise the real `git` binary against a throwaway repo built under the system temp
    // dir (no `tempfile` crate — see CRITICAL constraints). `TempRepo` removes its directory on
    // Drop so a panicking assertion still cleans up, and seeds a LOCAL identity + a pinned `main`
    // branch so every assertion is deterministic regardless of the host's global git config.

    /// A throwaway directory under `temp_dir()`, unique per (pid, counter), removed on Drop.
    struct TempRepo {
        dir: std::path::PathBuf,
    }

    impl TempRepo {
        /// Create (and clean any stale leftover at) a unique empty directory.
        fn new() -> Self {
            static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir()
                .join(format!("koine_git_test_{}_{}", std::process::id(), n));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            TempRepo { dir }
        }

        /// The directory as the `String` the git commands take.
        fn path(&self) -> String {
            self.dir.to_string_lossy().into_owned()
        }

        /// Run a raw `git -C <dir> <args...>`, asserting success (test setup, not under test).
        fn git(&self, args: &[&str]) {
            let out = Command::new("git")
                .arg("-C")
                .arg(&self.dir)
                .args(args)
                .output()
                .expect("git should be installed");
            assert!(
                out.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }

        /// Write `contents` to `rel` under the repo, creating any intermediate dirs.
        fn write(&self, rel: &str, contents: &str) {
            let p = self.dir.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(p, contents).unwrap();
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// A repo with a pinned `main` branch and a local test identity, ready to commit.
    fn init_repo() -> TempRepo {
        let repo = TempRepo::new();
        repo.git(&["init", "-b", "main"]);
        repo.git(&["config", "user.email", "t@e.st"]);
        repo.git(&["config", "user.name", "Tester"]);
        // A host global config may force commit signing; disable it locally so commits succeed
        // in the sandbox without a key.
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo
    }

    /// True if `files` has exactly one entry with this (relPath, staged, status) triple.
    fn has_file(files: &[GitFile], rel: &str, staged: bool, status: &str) -> bool {
        files
            .iter()
            .filter(|f| f.rel_path == rel && f.staged == staged && f.status == status)
            .count()
            == 1
    }

    #[test]
    fn git_status_reports_branch_staged_unstaged_and_untracked() {
        let repo = init_repo();
        repo.write("base.txt", "one\n");
        repo.git(&["add", "base.txt"]);
        repo.git(&["commit", "-m", "base"]);

        // An unstaged modification, a staged addition, and an untracked file.
        repo.write("base.txt", "two\n");
        repo.write("staged.txt", "x\n");
        repo.git(&["add", "staged.txt"]);
        repo.write("untracked.txt", "y\n");

        let status = git_status(repo.path()).unwrap();

        assert_eq!(status.branch, "main");
        assert!(has_file(&status.files, "base.txt", false, "modified"), "{:?}", status.files);
        assert!(has_file(&status.files, "staged.txt", true, "added"), "{:?}", status.files);
        assert!(
            has_file(&status.files, "untracked.txt", false, "untracked"),
            "{:?}",
            status.files
        );
    }

    #[test]
    fn git_status_reports_a_both_areas_file_twice() {
        let repo = init_repo();
        repo.write("b.txt", "1\n");
        repo.git(&["add", "b.txt"]);
        repo.git(&["commit", "-m", "base"]);

        // Stage a change, then change it again in the worktree → modified in BOTH areas.
        repo.write("b.txt", "2\n");
        repo.git(&["add", "b.txt"]);
        repo.write("b.txt", "3\n");

        let status = git_status(repo.path()).unwrap();

        // The single porcelain `1 MM ... b.txt` row expands to two GitFiles so the panel can group
        // them into Staged Changes / Changes by the flag alone.
        assert!(has_file(&status.files, "b.txt", true, "modified"), "{:?}", status.files);
        assert!(has_file(&status.files, "b.txt", false, "modified"), "{:?}", status.files);
    }

    #[test]
    fn git_log_returns_commits_newest_first_and_scopes_to_a_path() {
        let repo = init_repo();
        repo.write("a.txt", "a1\n");
        repo.git(&["add", "a.txt"]);
        repo.git(&["commit", "-m", "first"]);
        repo.write("b.txt", "b1\n");
        repo.git(&["add", "b.txt"]);
        repo.git(&["commit", "-m", "second"]);

        let all = git_log(repo.path(), None).unwrap();
        assert_eq!(all.len(), 2);
        // Newest first.
        assert_eq!(all[0].message, "second");
        assert_eq!(all[1].message, "first");
        assert_eq!(all[0].author, "Tester");
        assert_eq!(all[0].sha.len(), 40);
        assert!(all[0].date.starts_with("20"), "ISO date: {}", all[0].date);

        // Scoped to a single path → only the commit that touched it.
        let only_a = git_log(repo.path(), Some("a.txt".to_string())).unwrap();
        assert_eq!(only_a.len(), 1);
        assert_eq!(only_a[0].message, "first");
    }

    #[test]
    fn git_commit_creates_a_commit_from_the_staged_area() {
        let repo = init_repo();
        repo.write("c.txt", "hello\n");
        git_stage(repo.path(), vec!["c.txt".to_string()]).unwrap();

        git_commit(repo.path(), "add c".to_string()).unwrap();

        let log = git_log(repo.path(), None).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].message, "add c");
        // Nothing left to commit afterwards.
        assert!(git_status(repo.path()).unwrap().files.is_empty());
    }

    #[test]
    fn git_stage_and_unstage_move_a_file_between_areas() {
        let repo = init_repo();
        repo.write("e.txt", "1\n");
        repo.git(&["add", "e.txt"]);
        repo.git(&["commit", "-m", "base"]);

        // Modify, then stage it → it shows as a staged modification.
        repo.write("e.txt", "2\n");
        git_stage(repo.path(), vec!["e.txt".to_string()]).unwrap();
        let staged = git_status(repo.path()).unwrap();
        assert!(has_file(&staged.files, "e.txt", true, "modified"), "{:?}", staged.files);
        assert!(!has_file(&staged.files, "e.txt", false, "modified"));

        // Unstage it → it moves back to the worktree (unstaged) area.
        git_unstage(repo.path(), vec!["e.txt".to_string()]).unwrap();
        let unstaged = git_status(repo.path()).unwrap();
        assert!(has_file(&unstaged.files, "e.txt", false, "modified"), "{:?}", unstaged.files);
        assert!(!has_file(&unstaged.files, "e.txt", true, "modified"));
    }

    #[test]
    fn git_branches_lists_local_branches() {
        let repo = init_repo();
        repo.write("f.txt", "x\n");
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "-m", "base"]);
        repo.git(&["branch", "feature"]);

        let branches = git_branches(repo.path()).unwrap();
        assert!(branches.contains(&"main".to_string()), "{branches:?}");
        assert!(branches.contains(&"feature".to_string()), "{branches:?}");
    }

    #[test]
    fn git_checkout_switches_the_current_branch() {
        let repo = init_repo();
        repo.write("g.txt", "x\n");
        repo.git(&["add", "g.txt"]);
        repo.git(&["commit", "-m", "base"]);
        repo.git(&["branch", "feature"]);

        git_checkout(repo.path(), "feature".to_string()).unwrap();
        assert_eq!(git_status(repo.path()).unwrap().branch, "feature");
    }

    #[test]
    fn git_diff_returns_a_unified_diff_for_a_modified_file() {
        let repo = init_repo();
        repo.write("h.txt", "line1\n");
        repo.git(&["add", "h.txt"]);
        repo.git(&["commit", "-m", "base"]);
        repo.write("h.txt", "line1\nline2\n");

        // Worktree diff is non-empty and shows the added line.
        let worktree = git_diff(repo.path(), "h.txt".to_string(), false).unwrap();
        assert!(worktree.contains("@@"), "expected a hunk header: {worktree}");
        assert!(worktree.contains("+line2"), "{worktree}");

        // Once staged, the change shows under --cached and the worktree diff goes empty.
        git_stage(repo.path(), vec!["h.txt".to_string()]).unwrap();
        let cached = git_diff(repo.path(), "h.txt".to_string(), true).unwrap();
        assert!(cached.contains("+line2"), "{cached}");
        assert!(git_diff(repo.path(), "h.txt".to_string(), false).unwrap().is_empty());
    }

    #[test]
    fn git_commands_error_on_a_non_git_dir() {
        // A directory that was never `git init`-ed yields Err from every read command.
        let plain = TempRepo::new();
        assert!(git_status(plain.path()).is_err());
        assert!(git_log(plain.path(), None).is_err());
        assert!(git_branches(plain.path()).is_err());
        assert!(git_diff(plain.path(), "anything.txt".to_string(), false).is_err());
    }
}
