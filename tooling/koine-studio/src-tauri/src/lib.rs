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
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

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

/// The resolved MCP endpoint returned to the frontend (issue #735 follow-up): the loopback URL the
/// sidecar bound plus whether the host had to fall back to an OS-assigned port because the requested
/// one was busy. `requestedPort` is echoed for diagnostics; the TS `Platform` keeps only `url`+`fallback`
/// (it reads the requested port back from the `mcpPort` setting). Serialized camelCase for the frontend.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct McpEndpointInfo {
    /// The `http://HOST:PORT/mcp` URL an MCP client connects to.
    url: String,
    /// The port the frontend asked for (`0` = OS-assigned). Echoed for diagnostics.
    requested_port: u16,
    /// True when `requested_port` was a specific busy port and the server fell back to an OS-assigned one.
    fallback: bool,
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
    /// the resolved endpoint info, cached once the sidecar comes up so a later `mcp_endpoint` call is
    /// idempotent (returns the running server verbatim without re-spawning or re-waiting). Cleared by
    /// `mcp_stop`. Carries the `fallback` flag so the UI's busy-port warning survives a re-open.
    info: Mutex<Option<McpEndpointInfo>>,
    /// serializes endpoint resolution. The busy-port fallback reaps the dead child and respawns across
    /// two `spawn_and_wait_for_endpoint` calls; without this a second concurrent `mcp_endpoint` could
    /// interleave between the reap and the respawn and the two callers would kill each other's servers.
    /// Held for the whole of `mcp_endpoint`, so a second caller blocks then hits the cached-`info` path.
    resolving: Mutex<()>,
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
    /// Flow-control gate for the reader thread (#441). When the inner `bool` is `true` the reader parks
    /// on the `Condvar` before its next `read`, so it stops draining the PTY: the kernel buffer fills
    /// and the shell blocks on write — real backpressure. `pty_pause` sets it; `pty_resume` (and
    /// `pty_stop`) clear it and `notify` so the reader wakes. Shared `Arc` so the reader thread owns a
    /// clone (managed `State` is not `'static`).
    paused: Arc<(Mutex<bool>, Condvar)>,
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

/// How to launch the `koine` tooling backend that powers both the LSP sidecar and the
/// MCP server.
#[derive(Debug, PartialEq)]
enum KoineLauncher {
    /// A self-contained `koine` executable (env override or the bundled externalBin).
    Bin(PathBuf),
    /// Dev fallback: `dotnet <repo>/src/Koine.Cli/bin/Debug/net10.0/Koine.Cli.dll`.
    DevDll,
}

/// Choose how to launch `koine`, in priority order: an explicit env override, then the
/// binary the Tauri bundler dropped next to the app executable, then the dev Debug DLL.
fn pick_koine_launcher(env_bin: Option<String>, bundled: Option<PathBuf>) -> KoineLauncher {
    match (env_bin, bundled) {
        (Some(b), _) => KoineLauncher::Bin(PathBuf::from(b)),
        (None, Some(p)) => KoineLauncher::Bin(p),
        (None, None) => KoineLauncher::DevDll,
    }
}

/// The Tauri bundler drops `externalBin: ["binaries/koine"]` next to the app
/// executable as plain `koine[.exe]` — probe for it there.
fn bundled_koine_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let p = exe
        .parent()?
        .join(format!("koine{}", std::env::consts::EXE_SUFFIX));
    launchable_sidecar(p)
}

/// Whether a bundled-sidecar candidate is actually launchable. A dev checkout keeps a
/// gitignored ZERO-BYTE placeholder at `binaries/koine-<triple>` (tauri_build's externalBin
/// existence check requires the file), and the build copies it next to the dev executable as
/// `koine` — where it would shadow the Debug-DLL fallback and make every LSP/MCP spawn fail
/// with EACCES. An empty file can never be a real sidecar, so treat it as absent.
fn launchable_sidecar(p: PathBuf) -> Option<PathBuf> {
    match std::fs::metadata(&p) {
        Ok(m) if m.is_file() && m.len() > 0 => Some(p),
        _ => None,
    }
}

/// Resolve how to launch the language server, tried in order: the `KOINE_LSP` env override (a
/// self-contained `koine` binary), then the bundled `koine` binary dropped next to the app
/// executable by the Tauri bundler, then the Debug DLL via `dotnet` resolved relative to this crate.
fn resolve_sidecar_command() -> Command {
    match pick_koine_launcher(std::env::var("KOINE_LSP").ok(), bundled_koine_path()) {
        KoineLauncher::Bin(bin) => {
            let mut c = Command::new(bin);
            c.arg("lsp");
            c
        }
        KoineLauncher::DevDll => {
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
}

/// The CLI args that launch the MCP HTTP server on `port` (`0` = OS-assigned loopback port). Pure, so
/// the arg vector is unit-tested without spawning a process (the existing `cargo test` gate convention).
fn mcp_launch_args(port: u16) -> [String; 4] {
    [
        "mcp".to_string(),
        "--http".to_string(),
        "--port".to_string(),
        port.to_string(),
    ]
}

/// Resolve how to launch the MCP HTTP server on `port`. Mirrors [`resolve_sidecar_command`], tried in
/// order: the `KOINE_MCP` (then `KOINE_LSP`) env override (the same self-contained `koine` binary), then
/// the bundled `koine` binary dropped next to the app executable by the Tauri bundler, then the
/// Debug DLL via `dotnet`. The server is asked to bind the requested loopback `port` (`0` = OS-assigned)
/// and announce it on stderr, which `mcp_endpoint` scrapes.
fn resolve_mcp_command(port: u16) -> Command {
    let mcp_args = mcp_launch_args(port);
    let env_bin = std::env::var("KOINE_MCP")
        .or_else(|_| std::env::var("KOINE_LSP"))
        .ok();
    match pick_koine_launcher(env_bin, bundled_koine_path()) {
        KoineLauncher::Bin(bin) => {
            let mut c = Command::new(bin);
            c.args(&mcp_args);
            c
        }
        KoineLauncher::DevDll => {
            let dll = concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../src/Koine.Cli/bin/Debug/net10.0/Koine.Cli.dll"
            );
            let mut c = Command::new("dotnet");
            c.arg(dll).args(&mcp_args);
            c
        }
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
/// unit-tested without opening a PTY: both the user's `$SHELL` and the password-database shell
/// (recovered from `getpwuid` by the caller) are passed in.
///
/// On **Unix** the program is chosen `$SHELL` → `passwd_shell` → `/bin/sh`, and it is spawned as a
/// **login** shell (`-l`). This is the fix for a bundled `.app` launched from Finder/Dock: macOS hands
/// GUI processes a stripped `launchd` environment with no `$SHELL` and a `PATH` that lacks Homebrew
/// (`/opt/homebrew/bin`, `/usr/local/bin`). Recovering the user's real shell from the password database
/// and running it as a login shell makes it source `~/.zprofile`/`~/.bash_profile`, so `PATH` is
/// populated and `git`/`dotnet` resolve — matching how VS Code/iTerm behave.
///
/// On **Windows** the path is unchanged: an explicit `$SHELL` (rare) is used verbatim, else `cmd`, and
/// no login flag is added. (Empty strings are treated as "unset" so a stray `SHELL=` doesn't win.)
///
/// `args_override` lets the caller (the Studio `terminal.shellArgs` setting, #467) supply the shell's
/// arguments: when it is `Some` and non-empty it is used verbatim on Unix in place of `-l`, so a bash
/// user who keeps `PATH`/aliases only in `~/.bashrc` can opt into `["-l", "-i"]`. An absent or empty
/// override keeps the default `["-l"]` login shell, so #462's fix is unchanged by default. Windows
/// ignores the override (its spawn path adds no args regardless).
fn resolve_shell_command(
    os_shell: Option<&str>,
    passwd_shell: Option<&str>,
    args_override: Option<&[String]>,
) -> (String, Vec<String>) {
    // Treat a blank entry as "unset" so a stray `SHELL=` doesn't win over the recovered shell.
    let os_shell = os_shell.filter(|s| !s.is_empty());
    let passwd_shell = passwd_shell.filter(|s| !s.is_empty());

    // `cfg!(windows)` is a const, so the dead branch is eliminated rather than warned on.
    if cfg!(windows) {
        let program = os_shell.unwrap_or("cmd").to_string();
        return (program, Vec::new());
    }

    // Unix: prefer `$SHELL`, then the passwd-recovered shell (the GUI-launch case), then `/bin/sh`.
    let program = os_shell.or(passwd_shell).unwrap_or("/bin/sh").to_string();
    // A caller-supplied override replaces the args verbatim when non-empty (#467); otherwise `-l` makes
    // it a login shell so the user's profile runs and `PATH` is populated (#462) — the safe default.
    let args = match args_override {
        Some(over) if !over.is_empty() => over.to_vec(),
        _ => vec!["-l".to_string()],
    };
    (program, args)
}

/// Recover the user's login shell from the password database (`getpwuid(getuid())->pw_shell`). Used
/// when the GUI-stripped launch environment has no `$SHELL`. Returns `None` on any lookup failure, a
/// blank entry, or a non-UTF-8 path, so the caller falls through to its own `/bin/sh` default. Non-Unix
/// targets have no password database, so this is always `None` there.
///
/// Uses `nix::unistd::User::from_uid`, which wraps the reentrant `getpwuid_r` — thread-safe and free of
/// the static-buffer data race that raw `getpwuid` carries, with no `unsafe`.
#[cfg(unix)]
fn passwd_login_shell() -> Option<String> {
    use nix::unistd::{Uid, User};
    let user = User::from_uid(Uid::current()).ok().flatten()?;
    let shell = user.shell.into_os_string().into_string().ok()?;
    if shell.is_empty() {
        None
    } else {
        Some(shell)
    }
}

#[cfg(not(unix))]
fn passwd_login_shell() -> Option<String> {
    None
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

/// Size window: flush the coalescer once this many bytes of decodable output have accumulated. ~16 KB
/// lets one IPC event carry ~four 4 KB reads' worth of output under flood, so a flooding command emits
/// roughly `bytes / 16 KB` `pty://data` events instead of one per read.
const PTY_FLUSH_BYTES: usize = 16 * 1024;
/// Time window: if no read arrives for this long, flush whatever is buffered so tiny interactive output
/// (a shell prompt, a short command's result) reaches the renderer at once instead of waiting for the
/// size window to fill. ~16 ms ≈ one frame, so the latency is imperceptible.
const PTY_FLUSH_WINDOW: Duration = Duration::from_millis(16);
/// Bound on the reader→coalescer channel (#441). A *bounded* channel makes the reader block on `send`
/// once the coalescer falls behind, so it stops draining the PTY and the kernel buffer fills — i.e. it
/// restores the automatic producer backpressure the old inline-emit reader had, and caps Rust-side
/// memory (≤ `cap × 4 KB`) under a flood even before the frontend's flow control kicks in.
const PTY_CHANNEL_CAPACITY: usize = 64;
/// Upper bound on how long the reader will stay parked for flow control (#441). The frontend resumes
/// within a frame or two in normal use (xterm drains its backlog in well under this), so the cap only
/// matters when the frontend vanishes mid-pause — a webview reload/crash during a flood. After it the
/// reader resumes reading so the shell's eventual EOF is still observed and the child reaped, rather
/// than leaking the shell + threads until the app exits.
const PTY_MAX_PAUSE: Duration = Duration::from_secs(10);

/// Coalesces decodable PTY text to bound the `pty://data` event rate under a high-throughput flood
/// (#441). The reader feeds each decodable chunk (from [`take_decodable`]); [`Coalescer::push`] buffers
/// it and returns a flush only once the buffer reaches [`PTY_FLUSH_BYTES`] — so one IPC event carries
/// many reads instead of one-per-4 KB. Between size flushes the reader flushes on the
/// [`PTY_FLUSH_WINDOW`] time window and on EOF via [`Coalescer::take`]; nothing is ever dropped. Pure,
/// so the size policy is unit-tested without opening a PTY.
struct Coalescer {
    buf: String,
    flush_threshold: usize,
}

impl Coalescer {
    fn new(flush_threshold: usize) -> Self {
        Self {
            buf: String::new(),
            flush_threshold,
        }
    }

    /// Append a decodable chunk; return the buffered text to emit once it reaches the size window, else
    /// `None` (held back for a later size/time/EOF flush).
    fn push(&mut self, chunk: &str) -> Option<String> {
        self.buf.push_str(chunk);
        if self.buf.len() >= self.flush_threshold {
            self.take()
        } else {
            None
        }
    }

    /// Take whatever is currently buffered (the time-window or EOF flush), or `None` when empty.
    fn take(&mut self) -> Option<String> {
        if self.buf.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.buf))
        }
    }

    /// Whether anything is buffered. Lets the coalescer loop arm the time-window deadline only while it
    /// holds output, and otherwise block indefinitely — no idle wakeups when the shell is quiet.
    fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}

/// End a PTY session: take the dead child out (returned so the caller can reap it for its exit code)
/// and clear the session's `writer`/`master`. Production entry point — see
/// [`take_pty_child_and_clear_handles_with_race_hook`] for the locking rationale.
fn take_pty_child_and_clear_handles<C, W, M>(
    child: &Mutex<Option<C>>,
    writer: &Mutex<Option<W>>,
    master: &Mutex<Option<M>>,
) -> Option<C> {
    take_pty_child_and_clear_handles_with_race_hook(child, writer, master, || {})
}

/// Take the dead child and clear `writer`/`master` while holding the `child` lock across the whole
/// teardown, so a concurrent `pty_start` (which takes the `child` lock first, then installs
/// `writer`/`master`) is fully serialized and can never have its freshly installed handles clobbered
/// here (#810). Lock order is `child` → `writer` → `master`, matching `pty_start`, so there is no
/// lock-order inversion; nothing on this path re-locks `child`, so no self-deadlock. The child is
/// reaped by the caller AFTER this returns (outside the lock), keeping the held critical section tight
/// so a new shell isn't delayed by the reap's `wait()`. Poisoned locks are recovered (the inner value
/// is just an `Option`, never left torn) so the handles are always cleared.
///
/// `on_race_window` runs while the `child` lock is held, after the child is taken and before the
/// handles are cleared — the exact window a racing `pty_start` would exploit. Production calls the
/// no-op wrapper [`take_pty_child_and_clear_handles`]; the unit tests pass a closure that drives a
/// concurrent start and asserts mutual exclusion. Generic over the handle types so the lock-ordering
/// is unit-tested without opening a real PTY (the existing test convention).
fn take_pty_child_and_clear_handles_with_race_hook<C, W, M>(
    child: &Mutex<Option<C>>,
    writer: &Mutex<Option<W>>,
    master: &Mutex<Option<M>>,
    on_race_window: impl FnOnce(),
) -> Option<C> {
    let mut child_guard = child.lock().unwrap_or_else(|e| e.into_inner());
    let reaped = child_guard.take();
    on_race_window();
    *writer.lock().unwrap_or_else(|e| e.into_inner()) = None;
    *master.lock().unwrap_or_else(|e| e.into_inner()) = None;
    drop(child_guard);
    reaped
}

/// Spawn the reader that drains the PTY master and relays it to the frontend, coalescing reads so a
/// flooding command (`yes`, `cat bigfile`) can't fire thousands of Tauri IPC events per second (#441).
///
/// Two threads, because a blocking `read` cannot also honour a flush timer:
/// - **Reader** — blocks on `read`, forwarding each 4 KB read to the coalescer over a *bounded* channel
///   ([`PTY_CHANNEL_CAPACITY`]); dropping the sender on EOF (or a read error) signals "no more output".
///   The bound means a reader outrunning the coalescer blocks on `send`, stops draining the PTY, and
///   lets the kernel buffer fill — automatic producer backpressure, capping Rust-side memory.
/// - **Coalescer** — drains the channel into a carry buffer, holds back any partial multibyte tail
///   until its continuation arrives (see [`take_decodable`]) so non-ASCII output isn't mojibake'd at
///   read boundaries, and emits one `pty://data` per flush: on the [`Coalescer`] size window, on the
///   [`PTY_FLUSH_WINDOW`] time window (armed only while it holds buffered output, so an idle shell costs
///   no wakeups), and on EOF. It also owns the exit handling: flush the remainder, reap the child to
///   recover its exit code, and emit `pty://exit` exactly once. Unlike the LSP sidecar there is **no**
///   supervision/relaunch — an exited shell simply closes the terminal. `std::thread` + `std::io` +
///   `std::sync::mpsc` only; no async runtime.
///
/// `paused` is the flow-control gate (#441): the reader parks on it before each read while the consumer
/// has asked the PTY to pause, so the kernel buffer fills and the shell blocks rather than the renderer
/// being swamped. The park is capped at [`PTY_MAX_PAUSE`] so a frontend that vanishes mid-pause can't
/// wedge the reader (and leak the shell) forever.
fn spawn_pty_reader_thread(
    app: AppHandle,
    mut reader: Box<dyn Read + Send>,
    shutting_down: Arc<AtomicBool>,
    paused: Arc<(Mutex<bool>, Condvar)>,
) {
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(PTY_CHANNEL_CAPACITY);

    // Reader thread: raw bytes off the PTY → channel. Kept minimal so the only blocking calls are the
    // pause gate, the `read`, and a full-channel `send`; all coalescing/timing lives in the consumer.
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            // Flow control (#441): park here while paused so we stop draining the PTY. The kernel PTY
            // buffer then fills and the shell blocks on write — real OS backpressure — until
            // `pty_resume`/`pty_stop` clears the flag and notifies. The `while` reblocks on a spurious
            // wakeup; the [`PTY_MAX_PAUSE`] deadline bounds the park so a vanished frontend (webview
            // reload/crash mid-pause) can't wedge the reader forever — after it we resume reading so the
            // shell's eventual EOF is still observed. Poison can't occur (the lock is only ever held to
            // flip a bool), but recover the inner guard rather than panicking the reader if it ever did.
            {
                let (lock, cv) = &*paused;
                let mut is_paused = lock.lock().unwrap_or_else(|e| e.into_inner());
                let deadline = Instant::now() + PTY_MAX_PAUSE;
                while *is_paused {
                    let now = Instant::now();
                    if now >= deadline {
                        // Paused too long — assume the frontend is gone and give up pausing entirely so
                        // the reader drains at full speed to EOF (a later resume/pause still works).
                        *is_paused = false;
                        break;
                    }
                    let (guard, _timed_out) = cv
                        .wait_timeout(is_paused, deadline - now)
                        .unwrap_or_else(|e| e.into_inner());
                    is_paused = guard;
                }
            }
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF: the shell closed its end of the PTY
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break; // the coalescer is gone — nothing left to feed
                    }
                }
                Err(_) => break, // a read error means the PTY is gone; treat it as EOF
            }
        }
        // Dropping `tx` here disconnects the channel, ending the coalescer's loop.
    });

    // Coalescer thread: channel → coalesced `pty://data`, then the one-shot exit handling.
    std::thread::spawn(move || {
        let mut carry: Vec<u8> = Vec::new();
        let mut coalescer = Coalescer::new(PTY_FLUSH_BYTES);
        loop {
            // Block indefinitely while nothing is buffered (no idle spin), but arm the time-window
            // deadline once we hold output so a quiet producer still gets flushed within
            // [`PTY_FLUSH_WINDOW`]. An incomplete multibyte tail in `carry` isn't decodable yet, so it
            // never counts as "buffered" here — it waits in `carry` for its continuation or EOF.
            let received = if coalescer.is_empty() {
                rx.recv().map_err(|_| ()) // Err(()) == the reader dropped its sender (EOF)
            } else {
                match rx.recv_timeout(PTY_FLUSH_WINDOW) {
                    Ok(bytes) => Ok(bytes),
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if let Some(flush) = coalescer.take() {
                            let _ = app.emit("pty://data", flush);
                        }
                        continue;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => Err(()),
                }
            };
            match received {
                Ok(bytes) => {
                    carry.extend_from_slice(&bytes);
                    while let Some(chunk) = take_decodable(&mut carry) {
                        if let Some(flush) = coalescer.push(&chunk) {
                            let _ = app.emit("pty://data", flush);
                        }
                    }
                }
                Err(()) => break, // the reader hit EOF
            }
        }

        // EOF: flush the coalesced remainder, then any trailing undecodable bytes (lossily) so nothing
        // the shell wrote before closing is dropped. Order matters — the coalescer holds text that
        // precedes the partial tail in `carry`.
        if let Some(flush) = coalescer.take() {
            let _ = app.emit("pty://data", flush);
        }
        if !carry.is_empty() {
            let _ = app.emit("pty://data", String::from_utf8_lossy(&carry).into_owned());
        }

        // Recover the exit code and announce it once. Take the dead child and clear the managed
        // handles so a later `pty_start` is a clean fresh start — atomically, so a `pty_start` that
        // raced this teardown can't have its fresh handles clobbered (#810). The child is reaped
        // after the handles are cleared (outside the lock) to keep the critical section tight.
        let state = app.state::<PtyState>();
        let reaped = take_pty_child_and_clear_handles(&state.child, &state.writer, &state.master);
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

/// Upstream-tracking state for the current branch: the tracked ref plus how far local has diverged —
/// the TS `GitUpstream`. `ref` is a Rust keyword, so the field is `r#ref` renamed on serialization.
#[derive(serde::Serialize, Debug)]
struct GitUpstream {
    /// The upstream ref name, e.g. `origin/main` (git's `# branch.upstream` header value).
    #[serde(rename = "ref")]
    r#ref: String,
    /// Commits the local branch is AHEAD of its upstream (unpushed).
    ahead: i64,
    /// Commits the local branch is BEHIND its upstream (unpulled).
    behind: i64,
}

/// A snapshot of `git status` for a workspace folder: the current branch plus its changed paths.
/// `branch` and `files` are already camelCase, so no field rename is needed.
#[derive(serde::Serialize)]
struct GitStatus {
    /// The current branch name, or `(detached)` for a detached HEAD (git's own header value).
    branch: String,
    /// Every changed path — staged, unstaged, and untracked entries (see [`GitFile`]).
    files: Vec<GitFile>,
    /// Upstream-tracking counts for `branch`, or `None` (TS `null`) when it has no upstream —
    /// a detached HEAD, a fresh local branch, or a repo with no remote.
    upstream: Option<GitUpstream>,
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

/// Per-(file, area) line churn from `git diff --numstat`, keyed like [`GitFile`] by (relPath, staged).
/// `added`/`removed` are `None` for a binary file (git prints `-`), serializing to TS `null` so the
/// panel shows the neutral placeholder instead of a bogus number.
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct GitNumstatEntry {
    /// Path relative to the repo, forward-slashed (git already reports it that way); for a rename this
    /// is the NEW path, so it joins the entry `git_status` reports.
    rel_path: String,
    /// True for a staged (`--cached`, index vs HEAD) count; false for a worktree (vs index) count.
    staged: bool,
    /// Added line count, or `None` for a binary file.
    added: Option<u64>,
    /// Removed line count, or `None` for a binary file.
    removed: Option<u64>,
}

/// Run `git -C <dir> <args…>` and return its stdout, or an `Err` shaped like `git_log_for_range`:
/// a spawn failure (git not installed) → `git-unavailable: …`; a non-zero exit → the trimmed
/// stderr. The thin core every source-control command shares. `GIT_TERMINAL_PROMPT=0` makes a
/// network command that would ask for credentials (push/clone against an authed remote) FAIL FAST
/// with a surfaced `Err` instead of hanging forever on a prompt no terminal will ever answer.
fn run_git(dir: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
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

/// Parse the porcelain-v2 `# branch.ab` payload (`+<ahead> -<behind>`) into `(ahead, behind)` counts.
/// `None` on any unexpected shape so a malformed header degrades to "no upstream data" rather than a
/// bogus 0/0 readout.
fn parse_branch_ab(rest: &str) -> Option<(i64, i64)> {
    let mut parts = rest.split_whitespace();
    let ahead = parts.next()?.strip_prefix('+')?.parse().ok()?;
    let behind = parts.next()?.strip_prefix('-')?.parse().ok()?;
    Some((ahead, behind))
}

/// `git status` for the open folder: the current branch plus every changed path. Parses
/// `--porcelain=v2 -b -z` — NUL-terminated records, so every path is printed **verbatim** (never
/// C-quoted, regardless of `core.quotePath` or non-ASCII/quote/backslash bytes in the name) and the
/// output tokenizes with a plain `split('\0')`. The branch comes from the `# branch.head` header; the
/// upstream ref + ahead/behind counts from `# branch.upstream` / `# branch.ab` (both emitted only when
/// the branch tracks an upstream — `upstream` needs BOTH, so a gone upstream ref with no computable
/// counts stays `None`); `1 <XY> …` ordinary entries (staged when X≠`.`, unstaged when Y≠`.`, so a
/// both-areas file appears twice); `2 …` renames/copies (the entry token's last field is the new path,
/// verbatim; with `-z` there is no tab — the original path has its own following NUL token, which is
/// consumed and discarded here); `? …` untracked; `u …` unmerged → `conflicted`. `Err` when `dir` is not
/// a work tree.
#[tauri::command]
fn git_status(dir: String) -> Result<GitStatus, String> {
    let out = run_git(&dir, &["status", "--porcelain=v2", "-b", "-z"])?;
    let mut branch = String::new();
    let mut upstream_ref: Option<String> = None;
    let mut ahead_behind: Option<(i64, i64)> = None;
    let mut files: Vec<GitFile> = Vec::new();

    let mut tokens = out.split('\0').filter(|t| !t.is_empty());
    while let Some(token) = tokens.next() {
        if let Some(rest) = token.strip_prefix("# branch.head ") {
            branch = rest.trim().to_string();
        } else if let Some(rest) = token.strip_prefix("# branch.upstream ") {
            upstream_ref = Some(rest.trim().to_string());
        } else if let Some(rest) = token.strip_prefix("# branch.ab ") {
            ahead_behind = parse_branch_ab(rest);
        } else if let Some(rest) = token.strip_prefix("? ") {
            files.push(GitFile {
                rel_path: rest.to_string(),
                staged: false,
                status: "untracked".to_string(),
            });
        } else if let Some(rest) = token.strip_prefix("1 ") {
            // <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>  (8 fields; -z prints the path verbatim,
            // spaces included, with no trailing separator to strip).
            let mut fields = rest.splitn(8, ' ');
            let xy = fields.next().unwrap_or("..");
            if let Some(path) = fields.nth(6) {
                push_xy_files(&mut files, xy, path);
            }
        } else if let Some(rest) = token.strip_prefix("2 ") {
            // <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>  (9 fields). The original path is
            // NOT part of this token under -z — it is the next NUL-separated token, consumed below so
            // it isn't misparsed as its own record.
            let mut fields = rest.splitn(9, ' ');
            let xy = fields.next().unwrap_or("..");
            if let Some(path) = fields.nth(7) {
                push_xy_files(&mut files, xy, path);
            }
            tokens.next(); // discard the orig-path token
        } else if let Some(rest) = token.strip_prefix("u ") {
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

    // Surface upstream data only when git reported BOTH the ref and computable counts, so a gone
    // upstream (ref present, no `# branch.ab`) reads as "no upstream" rather than a fake 0/0.
    let upstream = upstream_ref.zip(ahead_behind).map(|(r, (ahead, behind))| GitUpstream {
        r#ref: r,
        ahead,
        behind,
    });

    Ok(GitStatus { branch, files, upstream })
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

/// Resolve a `--numstat` path column to the changed file's path. A rename is printed as
/// `old => new` — or the brace form `pre{old => new}post` when the paths share a prefix/suffix —
/// so map it to the NEW path (what `git_status` reports); a plain path passes through unchanged.
fn numstat_new_path(raw: &str) -> String {
    // Brace rename form: `pre{old => new}post` → `pre` + `new` + `post`. Only when the braces actually
    // wrap a ` => ` rename — a filename that merely CONTAINS braces must pass through untouched.
    if let Some(open) = raw.find('{') {
        if let Some(close) = raw[open..].find('}').map(|i| open + i) {
            if let Some((_, new)) = raw[open + 1..close].split_once(" => ") {
                let pre = &raw[..open];
                let post = &raw[close + 1..];
                // An empty new segment can leave a doubled slash (e.g. `dir/{old => }file`); collapse it.
                return format!("{pre}{new}{post}").replace("//", "/");
            }
        }
    }
    // Simple form: `old => new` → `new`; a plain path passes through unchanged.
    match raw.split_once(" => ") {
        Some((_, new)) => new.to_string(),
        None => raw.to_string(),
    }
}

/// Parse one area's `git diff --numstat` output (`<added>\t<removed>\t<path>` per line; `-`/`-` for a
/// binary file) into [`GitNumstatEntry`]s tagged with `staged`, appending to `entries`.
fn parse_numstat(out: &str, staged: bool, entries: &mut Vec<GitNumstatEntry>) {
    for line in out.lines() {
        // splitn(3) keeps a path with embedded tabs intact in the third field.
        let mut fields = line.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        entries.push(GitNumstatEntry {
            rel_path: numstat_new_path(path),
            staged,
            // A non-numeric field is git's binary `-`, which parses to `None`.
            added: added.parse::<u64>().ok(),
            removed: removed.parse::<u64>().ok(),
        });
    }
}

/// Per-file `+n/−n` line counts for the whole working tree: the worktree area (`git diff --numstat`)
/// plus the staged area (`git diff --cached --numstat`) in ONE bounded pair of runs — independent of
/// file count. One entry per (path, area); binary files carry `None` counts. `Err` when `dir` is not
/// a work tree (same as the other read commands).
#[tauri::command]
fn git_numstat(dir: String) -> Result<Vec<GitNumstatEntry>, String> {
    let mut entries: Vec<GitNumstatEntry> = Vec::new();
    parse_numstat(&run_git(&dir, &["diff", "--numstat"])?, false, &mut entries);
    parse_numstat(&run_git(&dir, &["diff", "--cached", "--numstat"])?, true, &mut entries);
    Ok(entries)
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

/// Discard the working-tree changes of the given paths — DESTRUCTIVE and unrecoverable, which is why
/// the TS caller (the Source Control panel) always confirms with the user first. Each `tracked_paths`
/// entry is REVERTED to its index state (`git restore --worktree -- <paths…>` — so a partially-staged
/// file keeps its staged copy) and each `untracked_paths` entry is DELETED from disk
/// (`git clean -f -- <paths…>`). The CALLER supplies the tracked/untracked split — the panel already
/// knows each row's status, and deriving the split here via `git ls-files` both wasted a subprocess
/// and SILENTLY no-opped on a C-quoted (non-ASCII) filename: ls-files quotes such a path, the quoted
/// output never matches the raw pathspec, the file lands in the clean bucket, and `clean -f` skips
/// tracked files while exiting 0 — so the discard did nothing and reported success. Both commands are
/// always scoped by an explicit `--` pathspec and an empty call is a no-op up front — so a discard
/// can never touch a file the caller didn't name. `Err` (git's trimmed stderr) when any step fails.
#[tauri::command]
fn git_discard(dir: String, tracked_paths: Vec<String>, untracked_paths: Vec<String>) -> Result<(), String> {
    if tracked_paths.is_empty() && untracked_paths.is_empty() {
        return Ok(()); // never run an unscoped restore/clean
    }

    if !tracked_paths.is_empty() {
        let mut args: Vec<&str> = vec!["restore", "--worktree", "--"];
        args.extend(tracked_paths.iter().map(String::as_str));
        run_git(&dir, &args)?;
    }
    if !untracked_paths.is_empty() {
        let mut args: Vec<&str> = vec!["clean", "-f", "--"];
        args.extend(untracked_paths.iter().map(String::as_str));
        run_git(&dir, &args)?;
    }
    Ok(())
}

/// Commit the staged area with `message` (`git commit -m`). `Err` (with git's stderr) when there is
/// nothing staged or the identity is unset.
///
/// `amend` (defaulting to `false` when omitted, so every existing caller behaves identically)
/// rewrites the tip commit instead of creating a new one (`git commit --amend`): a non-empty
/// `message` replaces the tip's message (`-m <message>`), while an EMPTY `message` reuses the
/// previous one unchanged (`--no-edit`) — the amend still picks up whatever is newly staged.
#[tauri::command]
fn git_commit(dir: String, message: String, amend: Option<bool>) -> Result<(), String> {
    if amend.unwrap_or(false) {
        if message.is_empty() {
            run_git(&dir, &["commit", "--amend", "--no-edit"]).map(|_| ())
        } else {
            run_git(&dir, &["commit", "--amend", "-m", &message]).map(|_| ())
        }
    } else {
        run_git(&dir, &["commit", "-m", &message]).map(|_| ())
    }
}

/// Push the current branch to its configured upstream (a bare `git push`). The panel offers push
/// only when [`git_status`] reported an upstream, which is exactly what a bare push targets. `Err`
/// (git's trimmed stderr) when there is no upstream or git refuses — non-fast-forward, auth, offline.
/// `(async)` moves this network-bound command onto a background thread (Tauri's sync thread pool),
/// so a slow or unreachable remote can never freeze the webview's main thread.
///
/// `set_upstream` (defaulting to `false` when omitted, so every existing caller behaves
/// identically) is the "publish branch" case: instead of a bare push, it runs `git push -u origin
/// <current-branch>`, which succeeds even when the branch has no upstream yet and sets the
/// tracking ref so subsequent status/push calls see it.
#[tauri::command(async)]
fn git_push(dir: String, set_upstream: Option<bool>) -> Result<(), String> {
    if set_upstream.unwrap_or(false) {
        let branch = run_git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"])?
            .trim()
            .to_string();
        run_git(&dir, &["push", "-u", "origin", &branch]).map(|_| ())
    } else {
        run_git(&dir, &["push"]).map(|_| ())
    }
}

/// Fetch updates from the default remote (a bare `git fetch`) — refreshes the remote-tracking
/// refs (e.g. `origin/main`) so [`git_status`]'s ahead/behind counts stay current, WITHOUT ever
/// touching the checked-out branch or worktree. `Err` (git's trimmed stderr) when there is no
/// remote configured or git refuses — auth, offline. `(async)` moves this network-bound command
/// onto a background thread (Tauri's sync thread pool), so a slow or unreachable remote can never
/// freeze the webview's main thread.
#[tauri::command(async)]
fn git_fetch(dir: String) -> Result<(), String> {
    run_git(&dir, &["fetch"]).map(|_| ())
}

/// Pull the current branch's upstream with a fast-forward-only merge (`git pull --ff-only`):
/// fetches, then advances the checked-out branch only when it can be done without fabricating a
/// merge commit. `Err` (git's trimmed stderr) when there is no upstream, the histories have
/// diverged (a real merge/rebase would be needed), or git refuses — auth, offline — so the panel
/// surfaces the message instead of silently attempting a merge the user never asked for.
/// `(async)` moves this network-bound command onto a background thread (Tauri's sync thread
/// pool), so a slow or unreachable remote can never freeze the webview's main thread.
#[tauri::command(async)]
fn git_pull(dir: String) -> Result<(), String> {
    run_git(&dir, &["pull", "--ff-only"]).map(|_| ())
}

/// Revert the commit `sha` (`git revert --no-edit <sha>`), recording a new commit that undoes it.
/// A revert is a FORWARD commit — it never rewrites history — so it is safe on a shared branch.
/// `--no-edit` keeps it non-interactive (git's default `Revert "<subject>"` message). `Err` (git's
/// stderr) on a dirty working tree, a revert conflict, or a merge commit that needs an explicit `-m`
/// parent — surfaced to the caller (the launcher shows the message), never swallowed.
#[tauri::command]
fn git_revert(dir: String, sha: String) -> Result<(), String> {
    run_git(&dir, &["revert", "--no-edit", &sha]).map(|_| ())
}

/// Initialize a new git repository in `dir` (`git init`). Resolves once `dir` is a work tree;
/// idempotent — re-running on an existing repo still succeeds (git's own behavior). `Err` (git's
/// stderr) when git is missing or the path can't be initialized.
#[tauri::command]
fn git_init(dir: String) -> Result<(), String> {
    run_git(&dir, &["init"]).map(|_| ())
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
/// spaces/colons can't corrupt the split. Capped at the most recent `LOG_MAX_COUNT` commits: the
/// Source Control panel renders only a short recent-commit list, so streaming a long history over IPC
/// on every status refresh would be pure waste. `Err` on a non-repo dir or an unborn branch (no commits).
#[tauri::command]
fn git_log(dir: String, rel_path: Option<String>) -> Result<Vec<GitLogEntry>, String> {
    /// Comfortably above what the panel shows, while bounding the IPC payload on a long-history repo.
    const LOG_MAX_COUNT: &str = "--max-count=50";
    let mut args: Vec<&str> = vec!["log", LOG_MAX_COUNT, "--pretty=format:%H%x1f%an%x1f%aI%x1f%s"];
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

/// Clone the repository at `url` into `parent_dir` (`git clone <url> <dest>` run inside
/// `parent_dir`), returning the absolute path of the created directory. `dir_name` names the
/// destination folder when given — it must be a single path segment (non-empty, no `/`, `\`, or
/// `..`) so the clone can never escape `parent_dir`; otherwise the name is derived from the url's
/// last path segment with a trailing `.git` stripped (`…/repo.git` and `git@h:o/repo.git` → `repo`).
/// `Err` (git's stderr) when the url is unreachable, and `Err` up front when `dir_name` — or the
/// derived name — is unusable. `(async)` moves this network-bound command onto a background thread
/// (Tauri's sync thread pool), so a slow clone can never freeze the webview's main thread.
#[tauri::command(async)]
fn git_clone(url: String, parent_dir: String, dir_name: Option<String>) -> Result<String, String> {
    let dest_name = clone_dest_name(&url, dir_name.as_deref())?;

    // `--` terminates option parsing so a url or dest whose first char is `-` (e.g. a repo named `-x`)
    // is treated as a positional argument, not a git flag.
    run_git(&parent_dir, &["clone", "--", &url, &dest_name])?;

    Ok(std::path::Path::new(&parent_dir)
        .join(&dest_name)
        .to_string_lossy()
        .into_owned())
}

/// Resolve the destination folder name for a clone: the caller-supplied `dir_name`, else the url's last
/// path segment — split on `/` (paths/URLs), `\` (a Windows local-path clone SOURCE, e.g.
/// `C:\repos\app`) and `:` (scp-like `git@host:owner/repo.git`) — with a trailing `.git` stripped.
/// Validated to a single non-empty segment with no separators and no `..`, so a clone can never escape
/// `parent_dir` (a url ending in `/..` would otherwise derive `".."` and target the grandparent).
fn clone_dest_name(url: &str, dir_name: Option<&str>) -> Result<String, String> {
    let dest = match dir_name {
        Some(name) => name.to_string(),
        None => {
            let last = url
                .trim_end_matches(|c: char| c == '/' || c == '\\')
                .rsplit(|c: char| c == '/' || c == '\\' || c == ':')
                .next()
                .unwrap_or("");
            last.strip_suffix(".git").unwrap_or(last).to_string()
        }
    };
    if dest.is_empty() || dest.contains('/') || dest.contains('\\') || dest.contains("..") {
        return Err(format!("invalid clone directory name: {dest:?}"));
    }
    Ok(dest)
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

/// Kill the running MCP sidecar child (if any) and forget its scraped URL. Shared by the busy-port
/// fallback (to reap the dead/failed child between spawn attempts) and by `mcp_stop`. Does NOT touch the
/// cached `info` — the caller decides whether that survives (the fallback re-resolves it; `mcp_stop` clears it).
fn kill_mcp_child(state: &McpState) {
    if let Ok(mut g) = state.child.lock() {
        if let Some(mut child) = g.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    if let Ok(mut g) = state.endpoint.lock() {
        *g = None;
    }
}

/// Fully tear down the running MCP sidecar: reap the child, forget its scraped URL, AND drop the
/// cached endpoint `info`. Unlike [`kill_mcp_child`] (which leaves `info` intact for the busy-port
/// fallback's re-resolve), this clears the cache so the next `mcp_endpoint` resolves from a clean
/// slate. Shared by `mcp_stop` and by `mcp_endpoint`'s port-change branch (#947). Does NOT take
/// `state.resolving` — a caller that already holds it (`mcp_endpoint`, held for its whole body) must
/// not re-enter that non-reentrant lock; `mcp_stop` takes the lock itself before calling in.
fn teardown_sidecar(state: &McpState) {
    kill_mcp_child(state);
    if let Ok(mut g) = state.info.lock() {
        *g = None;
    }
}

/// Spawn the `koine mcp --http` sidecar on `port` (only if one isn't already running) and wait up to ~10s
/// for it to announce its loopback endpoint on stderr. Returns the announced URL, `Ok(None)` if the child
/// exited early or the wait elapsed with no announce line, or `Err` on a spawn failure. Holds the child
/// lock ONLY across the check-spawn-store so two concurrent callers can't both launch a server (the
/// pre-existing double-start guard is preserved), then polls the scraped endpoint AND the child's exit
/// status so a server that dies on a busy port ends the wait immediately rather than burning the full budget.
fn spawn_and_wait_for_endpoint(state: &McpState, port: u16) -> Result<Option<String>, String> {
    // Spawn once. Hold the child lock across check-spawn-store so two concurrent calls can't both
    // pass the guard and launch duplicate servers.
    {
        let mut child_guard = state.child.lock().map_err(|e| e.to_string())?;
        if child_guard.is_none() {
            let mut cmd = resolve_mcp_command(port);
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
    // promptly. Bail out early if the child has already exited (e.g. it couldn't bind a busy port) —
    // it will never announce, so waiting the full budget would just delay the fallback.
    for _ in 0..100 {
        if let Ok(g) = state.endpoint.lock() {
            if let Some(url) = g.as_ref() {
                return Ok(Some(url.clone()));
            }
        }
        if let Ok(mut g) = state.child.lock() {
            let exited = matches!(g.as_mut().map(|c| c.try_wait()), Some(Ok(Some(_))));
            if exited {
                // The child exited before announcing (e.g. it couldn't bind a busy port). Reap it and
                // clear the slot so a stale dead child can't poison the next attempt — which would see
                // `child.is_some()`, skip the respawn, and wedge (notably for port 0, whose caller has
                // no fallback retry to reap it).
                if let Some(mut dead) = g.take() {
                    let _ = dead.wait();
                }
                drop(g);
                if let Ok(mut e) = state.endpoint.lock() {
                    *e = None;
                }
                return Ok(None); // the child exited before announcing — stop waiting
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    // Timed out with no announce line: the child is alive but wedged. Reap it (and clear the scraped
    // endpoint) so the next attempt respawns from a clean slot instead of skipping on a stale child.
    kill_mcp_child(state);
    Ok(None)
}

/// Whether a cached endpoint (resolved for `info.requested_port`) may be reused verbatim for a fresh
/// request for `port`, or whether the sidecar must be moved (torn down + respawned). Reuse only on an
/// exact, non-fallback match: a different `port` — the JSON-apply path (#947) — must move the server,
/// and a lingering busy-port `fallback` must re-attempt the originally-requested port (self-heal once
/// it frees up). Port `0` (OS-assigned) is a wildcard: a caller asking for "whatever's running" reuses
/// a live non-fallback endpoint. The port is the sidecar's identity, so it belongs in the cache key.
fn can_reuse_cached_endpoint(info: &McpEndpointInfo, port: u16) -> bool {
    !info.fallback && (port == 0 || info.requested_port == port)
}

/// Lazily start the `koine mcp --http` sidecar (idempotent) on `port` and return the endpoint it bound
/// (`0` = OS-assigned). If a specific (non-zero) `port` never comes up — the child exits, or the wait
/// times out, with no announce line — it is most likely busy: the dead child is reaped and the server is
/// respawned ONCE on an OS-assigned port (`0`), flagged as a `fallback` so the UI can warn that copied
/// client configs are stale. A resolved endpoint is cached in `McpState`, **keyed on the requested
/// port** ([`can_reuse_cached_endpoint`]): a repeat call for the SAME port reuses the running server
/// verbatim (no re-spawn, no re-wait), but a call for a DIFFERENT port — the JSON-settings apply path,
/// which changes `mcp.port` without an `mcp_stop` (#947) — tears the sidecar down and moves it to the
/// new port; a lingering `fallback` likewise re-attempts the originally-requested port so it self-heals
/// once that port frees up. The browser backend never calls this (its `Platform.mcpEndpoint` returns
/// null without touching IPC), so a desktop-only affordance can gate purely on the resolved value.
#[tauri::command]
fn mcp_endpoint(port: u16, state: State<'_, McpState>) -> Result<Option<McpEndpointInfo>, String> {
    // Serialize resolution: the busy-port fallback reaps the child and respawns across two spawn/wait
    // calls, so two concurrent callers must not interleave (they would kill each other's servers). The
    // second caller blocks here, then falls through to the cached-`info` fast path below.
    let _resolving = state.resolving.lock().map_err(|e| e.to_string())?;

    // Idempotent fast path — reuse the running server verbatim ONLY when the cached endpoint still
    // matches what's being asked for (same requested port, not a lingering busy-port fallback; port `0`
    // is a wildcard). A port change — the JSON-apply path (#947) — or a stale fallback must MOVE the
    // server: tear the sidecar down (via the non-reentrant `teardown_sidecar`, safe under the held
    // `resolving` lock) and fall through to a fresh spawn on `port`.
    let mut needs_teardown = false;
    if let Ok(g) = state.info.lock() {
        if let Some(info) = g.as_ref() {
            if can_reuse_cached_endpoint(info, port) {
                return Ok(Some(info.clone()));
            }
            needs_teardown = true;
        }
    }
    if needs_teardown {
        teardown_sidecar(&state);
    }

    // First attempt: the requested port.
    if let Some(url) = spawn_and_wait_for_endpoint(&state, port)? {
        let info = McpEndpointInfo {
            url,
            requested_port: port,
            fallback: false,
        };
        if let Ok(mut g) = state.info.lock() {
            *g = Some(info.clone());
        }
        return Ok(Some(info));
    }

    // The requested port didn't come up — `spawn_and_wait_for_endpoint` already reaped the dead child,
    // so the slot is clean. A specific (non-zero) port is most likely busy, so retry ONCE on an
    // OS-assigned port, flagged as a fallback.
    if port != 0 {
        if let Some(url) = spawn_and_wait_for_endpoint(&state, 0)? {
            let info = McpEndpointInfo {
                url,
                requested_port: port,
                fallback: true,
            };
            if let Ok(mut g) = state.info.lock() {
                *g = Some(info.clone());
            }
            return Ok(Some(info));
        }
    }

    Ok(None)
}

/// Stop the MCP sidecar, forget its scraped URL, and drop the cached endpoint info so the next
/// `mcp_endpoint` re-spawns a fresh server. Idempotent and safe when nothing is running. Takes
/// `state.resolving` so a stop can't interleave with an in-flight `mcp_endpoint` resolve, then routes
/// the teardown through the shared [`teardown_sidecar`] helper. Best-effort: it always reaps the child
/// and returns `Ok(())`.
#[tauri::command]
fn mcp_stop(state: State<'_, McpState>) -> Result<(), String> {
    // `resolving` guards a `()` — no data invariant to corrupt — so recover from a poisoned lock and
    // proceed rather than bail: a Stop must ALWAYS tear the sidecar down (reap the child, clear the
    // cache), even after an unrelated panic. Mirrors the `unwrap_or_else(|e| e.into_inner())` recovery
    // used elsewhere in this file, and preserves the pre-#947 guarantee that `mcp_stop` never fails.
    let _resolving = state.resolving.lock().unwrap_or_else(|e| e.into_inner());
    teardown_sidecar(&state);
    Ok(())
}

// --- terminal PTY commands --------------------------------------------------

/// Open a PTY, spawn the user's shell into it (rooted at `cwd` when given), and start the reader
/// thread that relays output as `pty://data`. Idempotent: holding the `child` lock across the whole
/// check-spawn-store means two concurrent calls cannot both pass the guard and open duplicate
/// terminals (the second blocks until the first stores `Some`, then returns early).
///
/// `shell_args` is the optional caller-supplied shell-args override (the Studio `terminal.shellArgs`
/// setting, #467); the frontend sends it only when the user configured one, so `None`/empty keeps the
/// default `["-l"]` login shell (#462). It is threaded into {@link resolve_shell_command} verbatim.
#[tauri::command]
fn pty_start(
    app: AppHandle,
    state: State<'_, PtyState>,
    cwd: Option<String>,
    shell_args: Option<Vec<String>>,
) -> Result<(), String> {
    let mut child_guard = state.child.lock().map_err(|e| e.to_string())?;
    if child_guard.is_some() {
        return Ok(());
    }

    // A fresh start clears any prior shutdown intent so the reader reports a real exit code, and any
    // leftover pause from a previous session (#441) so the new reader isn't born parked.
    state.shutting_down.store(false, Ordering::SeqCst);
    set_pty_paused(&state.paused, false);

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

    // Resolve the shell: `$SHELL` first, then — for a Finder/Dock launch whose stripped GUI env has
    // no `$SHELL` — the user's shell recovered from the password database, then `/bin/sh`. On Unix the
    // chosen shell is spawned as a login shell (`-l`) unless the caller overrode the args (#467); on
    // Windows this yields `cmd` with no extra args.
    let passwd_shell = passwd_login_shell();
    let (program, args) = resolve_shell_command(
        std::env::var("SHELL").ok().as_deref(),
        passwd_shell.as_deref(),
        shell_args.as_deref(),
    );
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

    spawn_pty_reader_thread(
        app.clone(),
        reader,
        state.shutting_down.clone(),
        state.paused.clone(),
    );

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

/// Flip the reader's flow-control gate (#441) and wake it if it is parked: `true` makes the reader park
/// before its next read (`pty_pause`); `false` lets it drain again (`pty_resume`/`pty_start`/`pty_stop`).
/// Always `notify`s so a parked reader is released even when clearing the flag.
fn set_pty_paused(paused: &(Mutex<bool>, Condvar), value: bool) {
    let (lock, cv) = paused;
    if let Ok(mut g) = lock.lock() {
        *g = value;
    }
    cv.notify_all();
}

/// Flow control (#441): pause draining the PTY. The reader parks before its next read, so the kernel
/// PTY buffer fills and the shell blocks on write — backpressure when the renderer falls behind. A
/// no-op when nothing is running (the flag is simply read by the next reader thread).
#[tauri::command]
fn pty_pause(state: State<'_, PtyState>) -> Result<(), String> {
    set_pty_paused(&state.paused, true);
    Ok(())
}

/// Flow control (#441): resume draining the PTY once the renderer has caught up. Wakes a parked reader.
/// Idempotent and safe to call when not paused.
#[tauri::command]
fn pty_resume(state: State<'_, PtyState>) -> Result<(), String> {
    set_pty_paused(&state.paused, false);
    Ok(())
}

/// Intentional shutdown: arm the no-reap flag, drop the writer (so the shell sees stdin EOF), kill
/// the child to be certain it exits, and drop the master. The reader thread then emits `pty://exit`
/// (code 0). Idempotent and safe to call when nothing is running.
///
/// All three handles are cleared via [`take_pty_child_and_clear_handles`], which holds the `child`
/// lock across the entire teardown so a concurrent [`pty_start`] (which takes `child` first) can
/// never install fresh `writer`/`master` handles that this function then clobbers (#829). The
/// returned child is reaped (kill + wait) **outside** the lock so a new shell isn't delayed.
#[tauri::command]
fn pty_stop(state: State<'_, PtyState>) -> Result<(), String> {
    state.shutting_down.store(true, Ordering::SeqCst);
    // Release a paused reader (#441) so it wakes, sees the killed child's EOF, and exits cleanly
    // instead of staying parked forever.
    set_pty_paused(&state.paused, false);
    // Route teardown through the serialized helper so the `child` lock is held continuously
    // while `writer`/`master` are cleared (#829, #830).  This serializes against `pty_start`
    // (which takes the `child` lock first), preventing a racing start from having its freshly
    // installed child reaped or its handles clobbered.  Reap the returned child outside the lock.
    if let Some(mut child) =
        take_pty_child_and_clear_handles(&state.child, &state.writer, &state.master)
    {
        let _ = child.kill();
        let _ = child.wait();
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
            pty_pause,
            pty_resume,
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
            git_numstat,
            git_stage,
            git_unstage,
            git_discard,
            git_commit,
            git_push,
            git_fetch,
            git_pull,
            git_revert,
            git_init,
            git_branches,
            git_checkout,
            git_log,
            git_clone
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
    use std::path::PathBuf;

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

    /// The desktop About dialog (`app_version` -> `CARGO_PKG_VERSION`), the packaged app
    /// (`tauri.conf.json` `version`), and the browser/status-bar chip must all show the SAME
    /// Koine release version, whose single source of truth is the repo-root
    /// `Directory.Build.props` `<Version>` (bumped by release-please). These drifted once —
    /// the crate sat at 0.17.7 while the release was 0.244.0, so the Settings/About chip on
    /// desktop silently reported the stale value. Guard against that regression here (runs in
    /// CI's `cargo test --locked`).
    #[test]
    fn studio_version_is_locked_to_the_koine_release_version() {
        let manifest = env!("CARGO_MANIFEST_DIR");

        let props = std::fs::read_to_string(format!("{manifest}/../../../Directory.Build.props"))
            .expect("read repo-root Directory.Build.props");
        // Match the real <Version>x.y.z</Version> element, not the `<Version>` mentioned in the
        // comment above it: the true value contains no `<` between the tags (mirrors the
        // `<Version>([^<]+)</Version>` regex vite.config.ts uses on the same file).
        let release = props
            .split("<Version>")
            .filter_map(|seg| seg.split_once("</Version>").map(|(v, _)| v.trim()))
            .find(|v| !v.contains('<'))
            .map(str::to_string)
            .expect("find <Version> in Directory.Build.props");

        let tauri_conf = std::fs::read_to_string(format!("{manifest}/tauri.conf.json"))
            .expect("read tauri.conf.json");
        let tauri_version = tauri_conf
            .split_once("\"version\"")
            .and_then(|(_, rest)| rest.split_once(':'))
            .and_then(|(_, rest)| rest.split_once('"'))
            .and_then(|(_, rest)| rest.split_once('"'))
            .map(|(v, _)| v.to_string())
            .expect("find \"version\" in tauri.conf.json");

        assert_eq!(
            env!("CARGO_PKG_VERSION"),
            release,
            "Cargo.toml version must equal the Koine release version in Directory.Build.props \
             (both are bumped by release-please)"
        );
        assert_eq!(
            tauri_version, release,
            "tauri.conf.json version must equal the Koine release version in Directory.Build.props"
        );
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

    #[test]
    fn mcp_launch_args_uses_the_requested_port() {
        // The configured default port is passed through verbatim as the last arg.
        assert_eq!(
            mcp_launch_args(56463),
            ["mcp", "--http", "--port", "56463"].map(String::from)
        );
        // Port 0 asks the OS to assign a free loopback port (the busy-port fallback path).
        assert_eq!(
            mcp_launch_args(0),
            ["mcp", "--http", "--port", "0"].map(String::from)
        );
    }

    // --- MCP sidecar teardown + cache reuse (#947) --------------------------
    //
    // `mcp_endpoint` caches the resolved endpoint so a repeat call reuses the running server without
    // re-spawning. `teardown_sidecar` is the shared teardown both `mcp_stop` and `mcp_endpoint`'s
    // port-change branch route through: it reaps the child, forgets the scraped URL, AND drops the
    // cached `info` — WITHOUT taking `state.resolving` (its callers already hold that lock). The tests
    // drive the helper against a bare `McpState::default()` (no real `Child` is needed to prove the
    // cache clears), matching the codebase convention of testing the `&McpState`/pure seams rather than
    // the Tauri-`State` command wrappers.

    #[test]
    fn teardown_sidecar_clears_cached_info_and_endpoint() {
        let state = McpState::default();
        // Simulate a resolved + cached sidecar (the fields `mcp_endpoint` populates on a live server).
        *state.info.lock().unwrap() = Some(McpEndpointInfo {
            url: "http://127.0.0.1:7900/mcp".into(),
            requested_port: 7900,
            fallback: false,
        });
        *state.endpoint.lock().unwrap() = Some("http://127.0.0.1:7900/mcp".into());

        teardown_sidecar(&state);

        assert!(
            state.info.lock().unwrap().is_none(),
            "teardown must drop the cached endpoint info so the next resolve starts clean"
        );
        assert!(
            state.endpoint.lock().unwrap().is_none(),
            "teardown must forget the scraped URL"
        );
        assert!(
            state.child.lock().unwrap().is_none(),
            "teardown must leave no child running"
        );
    }

    #[test]
    fn cached_endpoint_reused_only_on_exact_nonfallback_match() {
        // A resolved, non-fallback server on port 7900.
        let info = McpEndpointInfo {
            url: "http://127.0.0.1:7900/mcp".into(),
            requested_port: 7900,
            fallback: false,
        };
        // Same port asked again ⇒ reuse the running server verbatim (the happy path — no regression).
        assert!(can_reuse_cached_endpoint(&info, 7900));
        // A DIFFERENT port (the JSON-apply path, #947) ⇒ must NOT reuse; the sidecar has to move.
        assert!(!can_reuse_cached_endpoint(&info, 7901));
    }

    #[test]
    fn cached_fallback_endpoint_is_never_reused() {
        // A busy-port fallback: requested 7900 but the sidecar bound an OS-assigned port instead.
        let fb = McpEndpointInfo {
            url: "http://127.0.0.1:50123/mcp".into(),
            requested_port: 7900,
            fallback: true,
        };
        // Even when asked for the SAME requested port, a lingering fallback must re-attempt
        // (teardown + respawn) so it self-heals once the original port frees up — never returned stale.
        assert!(!can_reuse_cached_endpoint(&fb, 7900));
        assert!(!can_reuse_cached_endpoint(&fb, 7901));
    }

    #[test]
    fn port_zero_wildcard_reuses_a_running_nonfallback_server() {
        // A `0` (OS-assigned) request means "reuse whatever concrete port is already running", so a
        // live non-fallback server matches (the wildcard guard from the spec's port-0 note).
        let info = McpEndpointInfo {
            url: "http://127.0.0.1:7900/mcp".into(),
            requested_port: 7900,
            fallback: false,
        };
        assert!(can_reuse_cached_endpoint(&info, 0));
    }

    // --- sidecar launcher selection (pure) ----------------------------------

    #[test]
    fn pick_koine_launcher_prefers_env_override() {
        let l = pick_koine_launcher(Some("/opt/koine".into()), Some(PathBuf::from("/app/koine")));
        assert_eq!(l, KoineLauncher::Bin(PathBuf::from("/opt/koine")));
    }

    #[test]
    fn pick_koine_launcher_uses_bundled_when_no_env() {
        let l = pick_koine_launcher(None, Some(PathBuf::from("/app/koine")));
        assert_eq!(l, KoineLauncher::Bin(PathBuf::from("/app/koine")));
    }

    #[test]
    fn pick_koine_launcher_falls_back_to_dev_dll() {
        assert_eq!(pick_koine_launcher(None, None), KoineLauncher::DevDll);
    }

    // Regression (#955 follow-up, the real desktop "LSP not started"): the gitignored zero-byte
    // `binaries/koine-<triple>` placeholder (required by tauri_build's externalBin existence check)
    // is copied next to the dev executable as `koine`, where the old `is_file()` probe picked it as
    // the bundled sidecar — shadowing the Debug-DLL fallback and making every spawn fail EACCES.
    #[test]
    fn launchable_sidecar_rejects_the_zero_byte_placeholder() {
        let dir = std::env::temp_dir().join(format!("koine_studio_sidecar_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let stub = dir.join("koine");
        std::fs::write(&stub, b"").unwrap();

        assert_eq!(launchable_sidecar(stub), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn launchable_sidecar_accepts_a_nonempty_binary() {
        let dir = std::env::temp_dir().join(format!("koine_studio_sidecar_real_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("koine");
        std::fs::write(&bin, b"#!/bin/sh\n").unwrap();

        assert_eq!(launchable_sidecar(bin.clone()), Some(bin));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn launchable_sidecar_rejects_a_missing_file() {
        let p = std::env::temp_dir().join(format!("koine_studio_sidecar_missing_{}", std::process::id()));
        let _ = std::fs::remove_file(&p);
        assert_eq!(launchable_sidecar(p), None);
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
    fn resolve_shell_command_prefers_an_explicit_shell_and_logs_in_on_unix() {
        // `$SHELL` (the first arg) wins over the passwd-recovered shell. On Unix the interactive
        // shell is spawned as a *login* shell (`-l`) so a Finder/Dock launch — whose stripped GUI
        // env never sourced `~/.zprofile` — still gets a real `PATH` (Homebrew/user dirs).
        let (program, args) = resolve_shell_command(Some("/bin/zsh"), Some("/bin/bash"), None);
        assert_eq!(program, "/bin/zsh", "an explicit $SHELL is honoured verbatim");
        #[cfg(unix)]
        assert!(
            args.iter().any(|a| a == "-l"),
            "the Unix terminal must be a login shell so the user's profile runs"
        );
        #[cfg(windows)]
        assert!(args.is_empty(), "the Windows spawn path is unchanged — no login flag");
    }

    #[test]
    #[cfg(unix)]
    fn resolve_shell_command_recovers_the_passwd_shell_when_shell_is_unset() {
        // The GUI-launch case: no `$SHELL`, so fall through to the user's shell recovered from
        // `getpwuid` (passed as the second arg) rather than defaulting straight to `/bin/sh` —
        // still as a login shell.
        let (program, args) = resolve_shell_command(None, Some("/opt/homebrew/bin/fish"), None);
        assert_eq!(program, "/opt/homebrew/bin/fish", "the passwd shell is the next preference");
        assert!(args.iter().any(|a| a == "-l"), "the recovered shell is still a login shell");
    }

    #[test]
    #[cfg(unix)]
    fn resolve_shell_command_falls_back_to_bin_sh_as_a_last_resort() {
        // Neither `$SHELL` nor a passwd shell available: `/bin/sh` keeps `pty_start` able to spawn
        // *something*, still logged-in.
        let (program, args) = resolve_shell_command(None, None, None);
        assert_eq!(program, "/bin/sh", "/bin/sh is the final fallback");
        assert!(args.iter().any(|a| a == "-l"));
    }

    #[test]
    #[cfg(windows)]
    fn resolve_shell_command_defaults_to_cmd_on_windows() {
        // The Windows spawn path is unchanged: with nothing named, `cmd` is the default and no login
        // flag is added. (Guards the `os_shell.unwrap_or("cmd")` branch, which the Unix-gated tests
        // above never exercise.)
        let (program, args) = resolve_shell_command(None, None, None);
        assert_eq!(program, "cmd", "Windows defaults to cmd when no shell is named");
        assert!(args.is_empty(), "the Windows spawn path adds no login flag");
    }

    #[test]
    fn resolve_shell_command_honours_a_non_empty_args_override() {
        // The #467 opt-in: a caller-supplied (Studio setting) args override replaces the default `-l`
        // verbatim on Unix, so a bash user who keeps PATH/aliases only in ~/.bashrc can pass
        // ["-l", "-i"] to get an interactive shell that sources it. Program resolution is unchanged.
        let override_args = vec!["-l".to_string(), "-i".to_string()];
        let (program, args) = resolve_shell_command(Some("/bin/bash"), None, Some(&override_args));
        assert_eq!(program, "/bin/bash", "the override changes only the args, not the program");
        #[cfg(unix)]
        assert_eq!(args, override_args, "a non-empty override replaces the default -l args verbatim");
        #[cfg(windows)]
        assert!(args.is_empty(), "Windows ignores the override — its spawn path is unchanged");
    }

    #[test]
    #[cfg(unix)]
    fn resolve_shell_command_falls_back_to_login_when_the_override_is_empty() {
        // An *empty* override is treated as "unset", so the built-in default ["-l"] still applies —
        // #462's login-shell fix is unchanged when the user configured nothing.
        let empty: Vec<String> = Vec::new();
        let (_program, args) = resolve_shell_command(Some("/bin/zsh"), None, Some(&empty));
        assert_eq!(args, vec!["-l".to_string()], "an empty override falls back to the default login flag");
    }

    #[test]
    #[cfg(unix)]
    fn resolve_shell_command_defaults_to_login_when_no_override_is_given() {
        // No override (None) ⇒ the default ["-l"] login shell — today's behaviour, the safe default.
        let (_program, args) = resolve_shell_command(Some("/bin/zsh"), None, None);
        assert_eq!(args, vec!["-l".to_string()], "no override keeps the default login flag");
    }

    #[test]
    #[cfg(windows)]
    fn resolve_shell_command_ignores_the_args_override_on_windows() {
        // The Windows spawn path is untouched: even a non-empty override yields no args.
        let override_args = vec!["-l".to_string(), "-i".to_string()];
        let (program, args) = resolve_shell_command(None, None, Some(&override_args));
        assert_eq!(program, "cmd", "Windows still defaults to cmd");
        assert!(args.is_empty(), "Windows ignores the override and adds no args");
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

    // --- PTY read coalescing (backpressure, #441) ---------------------------
    //
    // The reader feeds each decodable chunk (from `take_decodable`) into a `Coalescer`, which buffers
    // text and only emits a `pty://data` flush once it crosses `PTY_FLUSH_BYTES`. Under a flooding
    // command this bounds the IPC event rate to ~bytes/PTY_FLUSH_BYTES instead of one event per 4 KB
    // read, while losing nothing (the remainder is flushed on the time window and on EOF).

    #[test]
    fn coalescer_bounds_flush_count_far_below_one_event_per_4kb() {
        // Simulate a flooding command (`yes`, `cat bigfile`): 1 MiB arriving as 4 KB reads, exactly the
        // shape the reader sees today as `READS` separate `pty://data` events.
        const READ: usize = 4096;
        const READS: usize = 256; // 1 MiB total
        let total_bytes = READ * READS;
        let read_chunk = "a".repeat(READ); // a fully-decodable 4 KB read

        let mut coalescer = Coalescer::new(PTY_FLUSH_BYTES);
        let mut flushes = 0usize;
        let mut emitted = 0usize;
        for _ in 0..READS {
            if let Some(chunk) = coalescer.push(&read_chunk) {
                flushes += 1;
                emitted += chunk.len();
            }
        }
        if let Some(tail) = coalescer.take() {
            // The EOF / time-window flush drains whatever is still buffered.
            flushes += 1;
            emitted += tail.len();
        }

        // No data loss: every byte read is eventually emitted.
        assert_eq!(emitted, total_bytes, "coalescing must not drop or duplicate output");

        // The event rate is bounded by the size window, not the 4 KB read size: at most one flush per
        // PTY_FLUSH_BYTES (+1 for the trailing remainder).
        let max_flushes = total_bytes / PTY_FLUSH_BYTES + 1;
        assert!(
            flushes <= max_flushes,
            "flush count {flushes} exceeded the size-window bound {max_flushes}"
        );
        // ...and that is far below the legacy one-event-per-4-KB-read rate (a ≥4× reduction at a 16 KB
        // window) — the whole point of coalescing.
        assert!(
            flushes * 4 <= READS,
            "expected ≥4× fewer events than one-per-4-KB ({READS}); got {flushes}"
        );
    }

    #[test]
    fn pty_pause_gate_parks_a_reader_until_resumed() {
        // The flow-control gate (#441): a reader using the production park pattern must block while the
        // flag is set and proceed only once `set_pty_paused(.., false)` clears it and notifies. Models
        // the gate without opening a PTY.
        let gate = Arc::new((Mutex::new(true), Condvar::new())); // start paused
        let (tx, rx) = mpsc::channel::<()>();
        let worker_gate = gate.clone();
        let handle = std::thread::spawn(move || {
            let (lock, cv) = &*worker_gate;
            let mut is_paused = lock.lock().unwrap_or_else(|e| e.into_inner());
            while *is_paused {
                is_paused = cv.wait(is_paused).unwrap_or_else(|e| e.into_inner());
            }
            drop(is_paused);
            let _ = tx.send(()); // only reached after the gate opens
        });

        // While paused the worker must not pass the gate.
        assert!(
            rx.recv_timeout(Duration::from_millis(50)).is_err(),
            "reader passed the gate while paused"
        );

        // Resume → the worker wakes and proceeds.
        set_pty_paused(&gate, false);
        assert!(
            rx.recv_timeout(Duration::from_secs(2)).is_ok(),
            "reader did not wake after resume"
        );
        handle.join().unwrap();
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
        // Pin line endings so a host `core.autocrlf=true` (the Windows-runner default) can't rewrite
        // checked-out content to CRLF and break the byte-exact content assertions below (e.g. the
        // revert test reads f.txt and expects "base\n", not "base\r\n").
        repo.git(&["config", "core.autocrlf", "false"]);
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
        // No upstream is configured, so the porcelain emits no `# branch.upstream`/`# branch.ab`
        // headers and the snapshot carries no upstream — the panel shows no counts, never a fake 0/0.
        assert!(status.upstream.is_none(), "no upstream configured");
    }

    #[test]
    fn git_status_reports_upstream_ref_and_ahead_behind_counts_when_tracking() {
        let repo = init_repo();
        repo.write("f.txt", "1\n");
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "-m", "c1"]);

        // A local branch `up` diverges by one commit (main will be BEHIND it by 1)…
        repo.git(&["checkout", "-b", "up"]);
        repo.write("up.txt", "u\n");
        repo.git(&["add", "up.txt"]);
        repo.git(&["commit", "-m", "up-only"]);

        // …while main gains two of its own commits (AHEAD of `up` by 2).
        repo.git(&["checkout", "main"]);
        repo.write("f.txt", "2\n");
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "-m", "c2"]);
        repo.write("f.txt", "3\n");
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "-m", "c3"]);

        // Track `up` — porcelain now emits `# branch.upstream up` and `# branch.ab +2 -1`, which
        // git_status surfaces as the upstream field (a local branch works exactly like a remote ref).
        repo.git(&["branch", "--set-upstream-to=up", "main"]);

        let status = git_status(repo.path()).unwrap();
        let up = status.upstream.expect("branch tracks an upstream");
        assert_eq!(up.r#ref, "up");
        assert_eq!(up.ahead, 2);
        assert_eq!(up.behind, 1);
    }

    #[test]
    fn git_push_pushes_the_current_branch_to_its_upstream_and_clears_ahead() {
        // A bare local "remote" plus a work repo whose main tracks it — no network involved.
        let remote = TempRepo::new();
        remote.git(&["init", "--bare", "-b", "main"]);
        let remote_path = remote.path();

        let repo = init_repo();
        repo.write("f.txt", "1\n");
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "-m", "c1"]);
        repo.git(&["remote", "add", "origin", &remote_path]);
        repo.git(&["push", "-u", "origin", "main"]);

        // A new local commit → 1 ahead of origin/main.
        repo.write("f.txt", "2\n");
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "-m", "c2"]);
        let before = git_status(repo.path()).unwrap().upstream.expect("tracks origin/main");
        assert_eq!(before.r#ref, "origin/main");
        assert_eq!(before.ahead, 1);

        // Push → the upstream has the commit and the next status reads a truthful 0/0.
        git_push(repo.path(), None).unwrap();
        let after = git_status(repo.path()).unwrap().upstream.expect("still tracking");
        assert_eq!(after.ahead, 0);
        assert_eq!(after.behind, 0);
    }

    #[test]
    fn git_push_errors_when_the_branch_has_no_upstream() {
        // No upstream configured → git refuses and the trimmed stderr surfaces as the Err the panel
        // shows (the UI never offers push here — status.upstream is None — but the command stays honest).
        let repo = init_repo();
        repo.write("f.txt", "1\n");
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "-m", "c1"]);

        assert!(git_push(repo.path(), None).is_err());
    }

    #[test]
    fn git_push_with_set_upstream_publishes_a_branch_with_no_upstream() {
        // A bare local "remote" — the work repo has no upstream configured yet, the "publish
        // branch" case (mirrors git_push_errors_when_the_branch_has_no_upstream's setup, but this
        // time set_upstream should make the push succeed AND set the tracking ref).
        let remote = TempRepo::new();
        remote.git(&["init", "--bare", "-b", "main"]);
        let remote_path = remote.path();

        let repo = init_repo();
        repo.write("f.txt", "1\n");
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "-m", "c1"]);
        repo.git(&["remote", "add", "origin", &remote_path]);

        assert!(
            git_status(repo.path()).unwrap().upstream.is_none(),
            "starts with no upstream configured"
        );

        // A bare push would fail here (no upstream); `set_upstream` publishes the current branch
        // instead (`git push -u origin <branch>`).
        git_push(repo.path(), Some(true)).unwrap();

        let after = git_status(repo.path()).unwrap().upstream.expect("push -u sets the tracking ref");
        assert_eq!(after.r#ref, "origin/main");
        assert_eq!(after.ahead, 0);
        assert_eq!(after.behind, 0);

        // The remote actually received the commit.
        let remote_head = run_git(&remote_path, &["rev-parse", "main"]).unwrap().trim().to_string();
        let local_head = run_git(&repo.path(), &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        assert_eq!(remote_head, local_head);
    }

    #[test]
    fn git_fetch_updates_the_remote_tracking_ref_without_touching_the_worktree() {
        // A bare "remote" plus a work repo that pushes the first commit to it.
        let remote = TempRepo::new();
        remote.git(&["init", "--bare", "-b", "main"]);
        let remote_path = remote.path();

        let origin = init_repo();
        origin.write("f.txt", "1\n");
        origin.git(&["add", "f.txt"]);
        origin.git(&["commit", "-m", "c1"]);
        origin.git(&["remote", "add", "origin", &remote_path]);
        origin.git(&["push", "-u", "origin", "main"]);

        // Clone the remote — this is the repo under test, currently in sync with origin/main.
        let parent = TempRepo::new();
        let clone_dir = git_clone(remote_path.clone(), parent.path(), Some("clone".to_string())).unwrap();

        // Advance the remote past the clone with a second commit pushed from `origin`.
        origin.write("f.txt", "2\n");
        origin.git(&["add", "f.txt"]);
        origin.git(&["commit", "-m", "c2"]);
        origin.git(&["push", "origin", "main"]);
        let remote_head = run_git(&remote_path, &["rev-parse", "main"]).unwrap().trim().to_string();

        // Before fetching, the clone's remote-tracking ref is still the stale first commit.
        let stale = run_git(&clone_dir, &["rev-parse", "origin/main"]).unwrap().trim().to_string();
        assert_ne!(stale, remote_head, "remote-tracking ref starts stale");

        git_fetch(clone_dir.clone()).unwrap();

        // Fetch catches the remote-tracking ref up to the remote's tip...
        let fresh = run_git(&clone_dir, &["rev-parse", "origin/main"]).unwrap().trim().to_string();
        assert_eq!(fresh, remote_head, "fetch updates the remote-tracking ref");

        // ...but never touches the checked-out branch or worktree: same content, same local HEAD.
        let contents = std::fs::read_to_string(std::path::Path::new(&clone_dir).join("f.txt")).unwrap();
        assert_eq!(contents, "1\n", "fetch never touches the worktree");
        let local_head = run_git(&clone_dir, &["rev-parse", "main"]).unwrap().trim().to_string();
        assert_ne!(local_head, remote_head, "local branch stays exactly where it was");
    }

    #[test]
    fn git_pull_fast_forwards_a_behind_clone() {
        // A bare "remote" plus a work repo that pushes the first commit to it.
        let remote = TempRepo::new();
        remote.git(&["init", "--bare", "-b", "main"]);
        let remote_path = remote.path();

        let origin = init_repo();
        origin.write("f.txt", "1\n");
        origin.git(&["add", "f.txt"]);
        origin.git(&["commit", "-m", "c1"]);
        origin.git(&["remote", "add", "origin", &remote_path]);
        origin.git(&["push", "-u", "origin", "main"]);

        // Clone the remote — this is the repo under test, currently in sync with origin/main.
        let parent = TempRepo::new();
        let clone_dir = git_clone(remote_path.clone(), parent.path(), Some("clone".to_string())).unwrap();

        // Advance the remote past the clone with a second commit pushed from `origin`.
        origin.write("f.txt", "2\n");
        origin.git(&["add", "f.txt"]);
        origin.git(&["commit", "-m", "c2"]);
        origin.git(&["push", "origin", "main"]);

        git_pull(clone_dir.clone()).unwrap();

        let contents = std::fs::read_to_string(std::path::Path::new(&clone_dir).join("f.txt")).unwrap();
        assert_eq!(contents, "2\n", "pull fast-forwards the worktree to the remote's tip");
    }

    #[test]
    fn git_pull_errors_on_divergent_histories() {
        // A bare "remote" plus a work repo that pushes the first commit to it.
        let remote = TempRepo::new();
        remote.git(&["init", "--bare", "-b", "main"]);
        let remote_path = remote.path();

        let origin = init_repo();
        origin.write("f.txt", "1\n");
        origin.git(&["add", "f.txt"]);
        origin.git(&["commit", "-m", "c1"]);
        origin.git(&["remote", "add", "origin", &remote_path]);
        origin.git(&["push", "-u", "origin", "main"]);

        // Clone the remote — this is the repo under test.
        let parent = TempRepo::new();
        let clone_dir = git_clone(remote_path.clone(), parent.path(), Some("clone".to_string())).unwrap();
        // `git clone` doesn't carry over a local identity, and the clone needs to make its own
        // commit below — give it the same throwaway identity `init_repo` seeds.
        let clone = TempRepo { dir: std::path::PathBuf::from(&clone_dir) };
        clone.git(&["config", "user.email", "t@e.st"]);
        clone.git(&["config", "user.name", "Tester"]);
        clone.git(&["config", "commit.gpgsign", "false"]);

        // The remote gains a commit the clone doesn't have...
        origin.write("f.txt", "2\n");
        origin.git(&["add", "f.txt"]);
        origin.git(&["commit", "-m", "c2"]);
        origin.git(&["push", "origin", "main"]);

        // ...while the clone independently gains a DIFFERENT commit of its own: the histories
        // diverge, so a `--ff-only` pull can't reconcile them without a merge/rebase.
        clone.write("g.txt", "local\n");
        clone.git(&["add", "g.txt"]);
        clone.git(&["commit", "-m", "local-only"]);

        assert!(git_pull(clone_dir).is_err());
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
    fn git_status_reports_non_ascii_paths_verbatim_and_pathspecs_round_trip() {
        let repo = init_repo();
        repo.write("crème.koi", "one\n");
        repo.git(&["add", "crème.koi"]);
        repo.git(&["commit", "-m", "base"]);

        // Modify the tracked non-ASCII file and add an untracked one, both with non-ASCII names —
        // porcelain v2 without `-z` would C-quote both (`core.quotePath` defaults to true).
        repo.write("crème.koi", "two\n");
        repo.write("naïve café.txt", "y\n");

        let status = git_status(repo.path()).unwrap();

        assert!(has_file(&status.files, "crème.koi", false, "modified"), "{:?}", status.files);
        assert!(
            has_file(&status.files, "naïve café.txt", false, "untracked"),
            "{:?}",
            status.files
        );
        for f in &status.files {
            assert!(!f.rel_path.starts_with('"'), "relPath still C-quoted: {:?}", f.rel_path);
        }

        // Feed git_status's OWN returned relPath back into git as a pathspec — the actual round
        // trip the panel performs — rather than a hardcoded literal, so a future regression that
        // quotes only the relPath (leaving the literal correct) would still be caught here.
        let modified = status
            .files
            .iter()
            .find(|f| f.rel_path == "crème.koi" && !f.staged)
            .expect("crème.koi is present as an unstaged modification")
            .rel_path
            .clone();
        let untracked = status
            .files
            .iter()
            .find(|f| f.rel_path == "naïve café.txt")
            .expect("naïve café.txt is present as untracked")
            .rel_path
            .clone();
        assert!(git_stage(repo.path(), vec![modified.clone()]).is_ok());
        assert!(git_diff(repo.path(), modified, true).is_ok());
        assert!(git_discard(repo.path(), Vec::new(), vec![untracked]).is_ok());
    }

    #[test]
    fn git_status_parses_a_rename_entry_with_z_and_consumes_the_orig_path() {
        let repo = init_repo();
        repo.write("crème.koi", "one\n");
        repo.write("other.txt", "x\n");
        repo.git(&["add", "crème.koi", "other.txt"]);
        repo.git(&["commit", "-m", "base"]);

        // Stage a rename of the non-ASCII file, and leave another file untracked so the record
        // FOLLOWING the rename in the porcelain output also has to parse correctly — proving the
        // orig-path token (with `-z`, its own NUL-separated field) is consumed and not misread as
        // the start of the next record.
        repo.git(&["mv", "crème.koi", "brûlée.koi"]);
        repo.write("zz-untracked.txt", "z\n");

        let status = git_status(repo.path()).unwrap();

        assert!(has_file(&status.files, "brûlée.koi", true, "renamed"), "{:?}", status.files);
        assert!(
            !status.files.iter().any(|f| f.rel_path == "crème.koi"),
            "original path leaked as its own entry: {:?}",
            status.files
        );
        assert!(
            has_file(&status.files, "zz-untracked.txt", false, "untracked"),
            "record after rename mis-parsed: {:?}",
            status.files
        );
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

        git_commit(repo.path(), "add c".to_string(), None).unwrap();

        let log = git_log(repo.path(), None).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].message, "add c");
        // Nothing left to commit afterwards.
        assert!(git_status(repo.path()).unwrap().files.is_empty());
    }

    #[test]
    fn git_commit_amend_rewrites_the_tip_message_keeping_the_same_parent() {
        let repo = init_repo();
        repo.write("a.txt", "base\n");
        repo.git(&["add", "a.txt"]);
        repo.git(&["commit", "-m", "base"]);
        let base_sha = git_log(repo.path(), None).unwrap()[0].sha.clone();

        repo.write("b.txt", "tip\n");
        repo.git(&["add", "b.txt"]);
        repo.git(&["commit", "-m", "tip original"]);

        git_commit(repo.path(), "tip amended".to_string(), Some(true)).unwrap();

        let log = git_log(repo.path(), None).unwrap();
        assert_eq!(log.len(), 2, "amend replaces the tip commit, it doesn't add a new one");
        assert_eq!(log[0].message, "tip amended");
        let parent = run_git(&repo.path(), &["rev-parse", "HEAD^"]).unwrap().trim().to_string();
        assert_eq!(parent, base_sha, "amend keeps the same parent commit");
    }

    #[test]
    fn git_commit_amend_with_an_empty_message_reuses_the_previous_message() {
        let repo = init_repo();
        repo.write("a.txt", "one\n");
        repo.git(&["add", "a.txt"]);
        repo.git(&["commit", "-m", "original message"]);

        // Stage an additional change, then amend with an EMPTY message: `--no-edit` reuses the
        // previous message while the new staged content joins the tip commit.
        repo.write("b.txt", "two\n");
        git_stage(repo.path(), vec!["b.txt".to_string()]).unwrap();
        git_commit(repo.path(), String::new(), Some(true)).unwrap();

        let log = git_log(repo.path(), None).unwrap();
        assert_eq!(log.len(), 1, "amend still replaces the tip, not a new commit");
        assert_eq!(log[0].message, "original message");
        assert!(
            git_status(repo.path()).unwrap().files.is_empty(),
            "the staged content joined the amended commit"
        );
    }

    #[test]
    fn git_revert_records_a_forward_commit_that_undoes_the_target() {
        let repo = init_repo();
        // Base commit, then a commit that adds a line we will revert.
        repo.write("f.txt", "base\n");
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "-m", "base"]);
        repo.write("f.txt", "base\nadded\n");
        repo.git(&["add", "f.txt"]);
        repo.git(&["commit", "-m", "add a line"]);

        let head = git_log(repo.path(), None).unwrap()[0].sha.clone();
        git_revert(repo.path(), head).unwrap();

        // A revert is a FORWARD commit (not a history rewrite): a third commit lands on top…
        let log = git_log(repo.path(), None).unwrap();
        assert_eq!(log.len(), 3);
        assert!(log[0].message.starts_with("Revert"), "revert message: {}", log[0].message);
        // …the working file is back to the base content…
        let content = std::fs::read_to_string(repo.dir.join("f.txt")).unwrap();
        assert_eq!(content, "base\n");
        // …and the tree is clean afterwards (the revert committed, nothing left pending).
        assert!(git_status(repo.path()).unwrap().files.is_empty());
    }

    #[test]
    fn git_revert_errors_on_a_non_git_dir() {
        let plain = TempRepo::new();
        assert!(git_revert(plain.path(), "deadbeef".to_string()).is_err());
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
    fn git_discard_reverts_a_tracked_file_and_removes_an_untracked_one() {
        let repo = init_repo();
        repo.write("t.txt", "base\n");
        repo.write("keep.txt", "keep-base\n");
        repo.git(&["add", "t.txt", "keep.txt"]);
        repo.git(&["commit", "-m", "base"]);

        // A worktree edit on a tracked file, a brand-new untracked file, and an UNLISTED edit that
        // the discard must leave alone (deleting too much is the worst failure mode here).
        repo.write("t.txt", "edited\n");
        repo.write("u.txt", "scratch\n");
        repo.write("keep.txt", "keep-edited\n");
        let before = git_status(repo.path()).unwrap();
        assert!(has_file(&before.files, "t.txt", false, "modified"), "{:?}", before.files);
        assert!(has_file(&before.files, "u.txt", false, "untracked"), "{:?}", before.files);

        // One mixed call handles both kinds — exactly what a group Discard-all sends: the caller
        // supplies the tracked/untracked split (the panel knows each row's status).
        git_discard(repo.path(), vec!["t.txt".to_string()], vec!["u.txt".to_string()]).unwrap();

        // The tracked file is reverted to its committed content…
        assert_eq!(std::fs::read_to_string(repo.dir.join("t.txt")).unwrap(), "base\n");
        // …the untracked file is deleted from disk…
        assert!(!repo.dir.join("u.txt").exists());
        // …and the unlisted file keeps its edit (still modified on the next status).
        assert_eq!(std::fs::read_to_string(repo.dir.join("keep.txt")).unwrap(), "keep-edited\n");
        let after = git_status(repo.path()).unwrap();
        assert!(has_file(&after.files, "keep.txt", false, "modified"), "{:?}", after.files);
        assert!(!has_file(&after.files, "t.txt", false, "modified"));
        assert!(!has_file(&after.files, "u.txt", false, "untracked"));
    }

    #[test]
    fn git_discard_reverts_only_the_worktree_delta_of_a_partially_staged_file() {
        let repo = init_repo();
        repo.write("p.txt", "1\n");
        repo.git(&["add", "p.txt"]);
        repo.git(&["commit", "-m", "base"]);

        // Stage one change, then edit again → modified in BOTH areas.
        repo.write("p.txt", "2\n");
        repo.git(&["add", "p.txt"]);
        repo.write("p.txt", "3\n");

        // The partially-staged file is TRACKED, so the panel sends it in the tracked bucket.
        git_discard(repo.path(), vec!["p.txt".to_string()], vec![]).unwrap();

        // The worktree reverts to the INDEX content (the staged "2"), never all the way to HEAD's "1"…
        assert_eq!(std::fs::read_to_string(repo.dir.join("p.txt")).unwrap(), "2\n");
        // …so the staged copy survives, and only the worktree row is gone.
        let status = git_status(repo.path()).unwrap();
        assert!(has_file(&status.files, "p.txt", true, "modified"), "{:?}", status.files);
        assert!(!has_file(&status.files, "p.txt", false, "modified"), "{:?}", status.files);
    }

    #[test]
    fn git_discard_with_no_paths_is_a_no_op_and_errors_on_a_non_git_dir() {
        // An empty-total call is a defensive no-op — it must not shell out to a bare `git clean`/
        // `restore` (unscoped, those would touch the whole tree), so it succeeds even outside a repo.
        let plain = TempRepo::new();
        assert!(git_discard(plain.path(), vec![], vec![]).is_ok());
        // With paths in EITHER bucket, a non-repo dir surfaces git's error like every other git_* command.
        assert!(git_discard(plain.path(), vec!["x.txt".to_string()], vec![]).is_err());
        assert!(git_discard(plain.path(), vec![], vec!["x.txt".to_string()]).is_err());
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
    fn git_numstat_reports_worktree_and_staged_counts_with_null_for_binary() {
        let repo = init_repo();
        // Base: a text file and a binary blob (a NUL byte makes git treat it as binary).
        repo.write("text.txt", "l1\nl2\n");
        std::fs::write(repo.dir.join("blob.bin"), [0u8, 1, 2, 3, 0, 9]).unwrap();
        repo.git(&["add", "text.txt", "blob.bin"]);
        repo.git(&["commit", "-m", "base"]);

        // An UNSTAGED text edit (+2/−0), an UNSTAGED binary edit (numstat prints `-`/`-`), and a
        // STAGED new file (+3/−0) — one entry per (path, area).
        repo.write("text.txt", "l1\nl2\nl3\nl4\n");
        std::fs::write(repo.dir.join("blob.bin"), [0u8, 1, 2, 3, 0, 9, 42, 7]).unwrap();
        repo.write("staged.txt", "a\nb\nc\n");
        repo.git(&["add", "staged.txt"]);

        let entries = git_numstat(repo.path()).unwrap();

        // Worktree text change → non-null counts, staged=false.
        let text = entries
            .iter()
            .find(|e| e.rel_path == "text.txt" && !e.staged)
            .unwrap_or_else(|| panic!("expected a text.txt worktree entry: {entries:?}"));
        assert_eq!(text.added, Some(2));
        assert_eq!(text.removed, Some(0));

        // Worktree binary change → null counts (never a bogus number), staged=false.
        let blob = entries
            .iter()
            .find(|e| e.rel_path == "blob.bin" && !e.staged)
            .unwrap_or_else(|| panic!("expected a blob.bin worktree entry: {entries:?}"));
        assert_eq!(blob.added, None);
        assert_eq!(blob.removed, None);

        // Staged addition → real counts, staged=true.
        let staged = entries
            .iter()
            .find(|e| e.rel_path == "staged.txt" && e.staged)
            .unwrap_or_else(|| panic!("expected a staged.txt staged entry: {entries:?}"));
        assert_eq!(staged.added, Some(3));
        assert_eq!(staged.removed, Some(0));
    }

    #[test]
    fn git_numstat_maps_a_staged_rename_to_the_new_path() {
        let repo = init_repo();
        repo.write("old-name.txt", "one\ntwo\nthree\n");
        repo.git(&["add", "old-name.txt"]);
        repo.git(&["commit", "-m", "base"]);

        // A pure staged rename: `git diff --cached --numstat` reports the path as `old => new`
        // (or the `{old => new}` brace form) — the entry must be keyed by the NEW path so it joins
        // git_status, which reports the new path.
        repo.git(&["mv", "old-name.txt", "new-name.txt"]);

        let entries = git_numstat(repo.path()).unwrap();

        let renamed = entries
            .iter()
            .find(|e| e.rel_path == "new-name.txt" && e.staged)
            .unwrap_or_else(|| panic!("expected a new-name.txt staged entry: {entries:?}"));
        // A content-preserving rename is 0/0 churn.
        assert_eq!(renamed.added, Some(0));
        assert_eq!(renamed.removed, Some(0));
        // The raw `old => new` arrow must never leak into a key.
        assert!(!entries.iter().any(|e| e.rel_path.contains("=>")), "{entries:?}");
    }

    #[test]
    fn git_commands_error_on_a_non_git_dir() {
        // A directory that was never `git init`-ed yields Err from every read command.
        let plain = TempRepo::new();
        assert!(git_status(plain.path()).is_err());
        assert!(git_log(plain.path(), None).is_err());
        assert!(git_branches(plain.path()).is_err());
        assert!(git_diff(plain.path(), "anything.txt".to_string(), false).is_err());
        assert!(git_numstat(plain.path()).is_err());
    }

    #[test]
    fn git_init_turns_a_plain_folder_into_a_work_tree() {
        // A plain (never `git init`-ed) folder isn't a work tree yet...
        let plain = TempRepo::new();
        assert!(git_status(plain.path()).is_err(), "plain folder must not be a work tree");

        // ...but is, once `git_init` has run against it.
        git_init(plain.path()).unwrap();
        assert!(!git_status(plain.path()).unwrap().branch.is_empty(), "status now reports a branch");
    }

    #[test]
    fn git_clone_copies_a_source_repo_into_a_fresh_parent() {
        // A source repo with one commit (cloning an unborn/empty repo warns but still succeeds;
        // a commit makes the assertion meaningful and matches the real "clone a project" flow).
        let source = init_repo();
        source.write("readme.txt", "hello\n");
        source.git(&["add", "readme.txt"]);
        source.git(&["commit", "-m", "init"]);

        // Clone by an explicit name into a fresh parent dir (local path url — offline, no network).
        let parent = TempRepo::new();
        let dest = git_clone(source.path(), parent.path(), Some("cloned".to_string())).unwrap();

        let dest_path = std::path::Path::new(&dest);
        assert!(dest_path.ends_with("cloned"), "returns the clone path: {dest}");
        assert!(dest_path.exists(), "the clone dir exists: {dest}");
        assert!(dest_path.join(".git").exists(), "and is a work tree: {dest}");

        // With no explicit name, the dir is derived from the url's last path segment.
        let parent2 = TempRepo::new();
        let derived = git_clone(source.path(), parent2.path(), None).unwrap();
        let expected = std::path::Path::new(&source.path())
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let derived_path = std::path::Path::new(&derived);
        assert!(derived_path.ends_with(&expected), "derived name is the source's last segment: {derived}");
        assert!(derived_path.join(".git").exists(), "derived clone is a work tree: {derived}");
    }

    #[test]
    fn git_clone_rejects_a_traversing_dir_name_and_a_bogus_url() {
        let source = init_repo();
        source.write("r.txt", "x\n");
        source.git(&["add", "r.txt"]);
        source.git(&["commit", "-m", "init"]);
        let parent = TempRepo::new();

        // A dir name that could escape the parent is rejected before git runs (offline, fast).
        assert!(git_clone(source.path(), parent.path(), Some("a/b".to_string())).is_err());
        assert!(git_clone(source.path(), parent.path(), Some("..".to_string())).is_err());
        assert!(git_clone(source.path(), parent.path(), Some(String::new())).is_err());

        // The SAME validation applies to a url-DERIVED name: a url ending in `/..` derives dest `".."`,
        // which must be rejected too (not just the explicit-dir-name branch).
        assert!(git_clone("https://example.com/owner/..".to_string(), parent.path(), None).is_err());

        // clone_dest_name derives the repo name across url styles AND platform separators (a Windows
        // local-path clone source uses `\` — this was the windows-latest CI failure) and rejects any
        // name that could escape parent_dir. Pure + platform-independent, so it runs on every OS.
        assert_eq!(clone_dest_name("https://example.com/owner/repo.git", None).unwrap(), "repo");
        assert_eq!(clone_dest_name("git@host:owner/repo.git", None).unwrap(), "repo");
        assert_eq!(clone_dest_name("https://h/o/repo/", None).unwrap(), "repo"); // trailing slash trimmed
        assert_eq!(clone_dest_name("/tmp/koine_git_test_1", None).unwrap(), "koine_git_test_1");
        assert_eq!(clone_dest_name(r"C:\Users\RUNNER~1\Temp\koine_git_test_2", None).unwrap(), "koine_git_test_2");
        assert_eq!(clone_dest_name("ignored", Some("myclone")).unwrap(), "myclone");
        assert!(clone_dest_name("https://h/o/..", None).is_err());
        assert!(clone_dest_name("x", Some("a/b")).is_err());
        assert!(clone_dest_name("x", Some(r"a\b")).is_err());
        assert!(clone_dest_name("x", Some("..")).is_err());
        assert!(clone_dest_name("x", Some("")).is_err());

        // A non-existent local url fails fast (git rejects the missing path — no network).
        assert!(git_clone(
            "/no/such/path/repo.git".to_string(),
            parent.path(),
            None
        )
        .is_err());
    }

    // --- PTY teardown / pty_start race (#810) --------------------------------
    //
    // On shell exit the coalescer takes the dead child and clears the session's `writer`/`master`;
    // `pty_start` installs a new session by taking the `child` lock FIRST and then storing fresh
    // `writer`/`master`. If teardown clears the handles without holding the `child` lock, a
    // `pty_start` that interleaves between the child-take and the clears installs handles that
    // teardown then wipes. `take_pty_child_and_clear_handles` must therefore hold the `child` lock
    // across the clears so the two are mutually exclusive; the tests drive that path via its
    // `_with_race_hook` variant, with sentinel handles so the lock-ordering is exercised without
    // opening a real PTY (the existing test convention). `teardown_holds_child_lock_while_clearing_handles`
    // is the deterministic regression guard (it probes the lock at the exact clear window);
    // `pty_start_racing_teardown_keeps_its_fresh_handles` documents the realistic end-to-end scenario.

    #[test]
    fn teardown_holds_child_lock_while_clearing_handles() {
        let child = Mutex::new(Some("child-N"));
        let writer = Mutex::new(Some("writer-N"));
        let master = Mutex::new(Some("master-N"));

        let mut child_lock_was_held = false;
        let reaped = take_pty_child_and_clear_handles_with_race_hook(&child, &writer, &master, || {
            // Teardown has taken the dead child and is about to clear writer/master — the exact
            // window a concurrent `pty_start` exploits. Probe the lock from another thread (so the
            // result is the genuine cross-thread state): teardown must still hold it here.
            std::thread::scope(|s| {
                child_lock_was_held = s.spawn(|| child.try_lock().is_err()).join().unwrap();
            });
        });

        assert_eq!(reaped, Some("child-N"), "teardown should hand back the reaped child");
        assert!(
            child_lock_was_held,
            "#810: teardown must hold the child lock while clearing writer/master, else a racing \
             pty_start interleaves and its fresh handles are clobbered"
        );
        assert!(writer.lock().unwrap().is_none(), "writer should be cleared by teardown");
        assert!(master.lock().unwrap().is_none(), "master should be cleared by teardown");
    }

    #[test]
    fn pty_start_racing_teardown_keeps_its_fresh_handles() {
        let child = Mutex::new(Some("child-N"));
        let writer = Mutex::new(Some("writer-N"));
        let master = Mutex::new(Some("master-N"));

        std::thread::scope(|s| {
            let mut start = None;
            take_pty_child_and_clear_handles_with_race_hook(&child, &writer, &master, || {
                // Mid-teardown (old child taken, handles about to clear), session N+1 starts.
                // `pty_start` takes the child lock first, so while teardown holds it this thread
                // parks until teardown completes, then installs its handles uncontended.
                start = Some(s.spawn(|| {
                    let mut cg = child.lock().unwrap_or_else(|e| e.into_inner());
                    *writer.lock().unwrap() = Some("writer-N+1");
                    *master.lock().unwrap() = Some("master-N+1");
                    *cg = Some("child-N+1");
                }));
                // Give the racing start a chance to contend for the child lock before we clear.
                std::thread::yield_now();
            });
            start.expect("start thread spawned").join().expect("start thread");
        });

        assert_eq!(
            *writer.lock().unwrap(),
            Some("writer-N+1"),
            "#810: the new session's writer was clobbered by the previous session's teardown"
        );
        assert_eq!(
            *master.lock().unwrap(),
            Some("master-N+1"),
            "#810: the new session's master was clobbered by the previous session's teardown"
        );
        assert_eq!(*child.lock().unwrap(), Some("child-N+1"));
    }

    // --- pty_stop / pty_start race (#829, #830) ------------------------------------
    //
    // Before this fix `pty_stop` cleared `writer`, took+reaped `child`, and cleared `master`
    // in three *separate* lock blocks — none of them serialized against `pty_start`.  A
    // `pty_start` racing in the gap installed a fresh `child`; the stop then `take()`d it,
    // `wait()`ed on a live shell (hang), and/or cleared the new session's `master` (#829).
    //
    // The fix routes `pty_stop` through `take_pty_child_and_clear_handles` so the only
    // `child.take()` lives inside the helper's held-`child`-lock critical section — the same
    // invariant #810 established for the coalescer-exit path.
    //
    // Testing strategy mirrors #810:
    //   • `pty_stop_teardown_with_race_hook` (non-Tauri, testable) mirrors `pty_stop`'s teardown
    //     body and accepts an `on_race_window` hook; post-fix it delegates to
    //     `take_pty_child_and_clear_handles_with_race_hook`.
    //   • `pty_stop_racing_start_does_not_take_new_child` drives it with a concurrent start
    //     installing session N+1 in the race window, asserting the new handles survive and stop
    //     reaps only the OLD child.

    /// Testable mirror of `pty_stop`'s teardown body (post-fix).
    ///
    /// Delegates to `take_pty_child_and_clear_handles_with_race_hook` so the `child` lock is
    /// held continuously while `writer`/`master` are cleared — the same serialized path used by
    /// the coalescer-exit teardown (#810).  Accepts an `on_race_window` hook (fired while the
    /// `child` lock is held) so the test can drive a concurrent `pty_start` at the exact point
    /// the old out-of-band code was vulnerable, and assert the new session's handles survive.
    #[cfg(test)]
    fn pty_stop_teardown_with_race_hook<C, W, M>(
        child: &Mutex<Option<C>>,
        writer: &Mutex<Option<W>>,
        master: &Mutex<Option<M>>,
        on_race_window: impl FnOnce(),
    ) -> Option<C> {
        // Delegate to the serialized helper: child lock held across both clears, racing start
        // must wait — its handles are never stolen or clobbered.
        take_pty_child_and_clear_handles_with_race_hook(child, writer, master, on_race_window)
    }

    /// Regression guard for #829/#830: a start racing `pty_stop` must never have its handles
    /// stolen or clobbered and `pty_stop` must reap only the OLD child.
    ///
    /// A concurrent `pty_start` installs session N+1 while the helper holds the child lock;
    /// it must park until teardown completes — the new session's child/writer/master are intact
    /// after the stop completes and stop reaps only the OLD child (session N).
    #[test]
    fn pty_stop_racing_start_does_not_take_new_child() {
        let child: Mutex<Option<&str>> = Mutex::new(Some("child-N"));
        let writer: Mutex<Option<&str>> = Mutex::new(Some("writer-N"));
        let master: Mutex<Option<&str>> = Mutex::new(Some("master-N"));

        let reaped = std::thread::scope(|s| {
            let mut start_handle = None;
            let reaped = pty_stop_teardown_with_race_hook(&child, &writer, &master, || {
                // Race window (fired while the child lock is held by the serialized helper):
                // a concurrent `pty_start` tries to install session N+1's handles but must
                // wait for the lock — its handles are never stolen or clobbered.
                start_handle = Some(s.spawn(|| {
                    let mut cg = child.lock().unwrap_or_else(|e| e.into_inner());
                    *writer.lock().unwrap_or_else(|e| e.into_inner()) = Some("writer-N+1");
                    *master.lock().unwrap_or_else(|e| e.into_inner()) = Some("master-N+1");
                    *cg = Some("child-N+1");
                }));
                // Give the racing start a chance to contend before we clear and release.
                std::thread::yield_now();
            });
            start_handle
                .expect("start thread spawned")
                .join()
                .expect("start thread panicked");
            reaped
        });

        assert_eq!(
            reaped,
            Some("child-N"),
            "#830: pty_stop must reap only the old session's child, not the new one"
        );
        assert_eq!(
            *child.lock().unwrap(),
            Some("child-N+1"),
            "#829/#830: pty_stop must not null the new session's child"
        );
        assert_eq!(
            *writer.lock().unwrap(),
            Some("writer-N+1"),
            "#829/#830: pty_stop must not clobber the new session's writer"
        );
        assert_eq!(
            *master.lock().unwrap(),
            Some("master-N+1"),
            "#829/#830: pty_stop must not clobber the new session's master"
        );
    }
}
