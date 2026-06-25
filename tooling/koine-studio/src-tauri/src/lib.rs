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
            move_entry
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
}
