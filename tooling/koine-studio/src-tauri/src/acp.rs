// Koine Studio — Agent Client Protocol (ACP) broker (#1970 Task 1, ADR 0022).
//
// Spawns a user-configured coding agent as a child process on `acp_start`, owns its stdin behind a
// Mutex in managed state, runs a reader thread that splits newline-delimited JSON-RPC off the child's
// stdout and re-emits each message as a Tauri event (`acp://message`, `acp://exit`), and exposes
// `acp_send` to write one message to the child. No async runtime — std::process + std::thread +
// std::io, the same shape as the `lsp_*` broker in `lib.rs`.
//
// TWO DELIBERATE DIFFERENCES FROM THE LSP BROKER, both load-bearing:
//
//   1. **Framing is newline-delimited, not `Content-Length`.** The ACP spec states that messages are
//      delimited by `\n` and MUST NOT contain embedded newlines. So `write_line` REFUSES a body
//      containing one rather than emitting a frame the peer would read as two — a serializer that
//      pretty-prints would otherwise corrupt the stream silently, and the failure would surface as an
//      unrelated parse error on the agent's side.
//
//   2. **There is no supervision, and that is not an oversight.** `lsp_*` relaunches its child on an
//      unexpected exit because a language server is stateless — a fresh one re-indexes and nothing is
//      lost. An ACP agent is the opposite: it owns conversation state, an authenticated session, and
//      possibly half-applied tool calls. Silently relaunching one would resurrect it with no session,
//      and a resumed prompt could re-run work the user already saw fail. An agent that dies is an
//      event the UI must show (`acp://exit` carries the child's real exit code), not something the
//      host papers over. This mirrors `PtyState`'s deliberate no-supervision note in `lib.rs`.
//
// The transport is stdio-only by construction. That is the protocol's own constraint, not ours: stdio
// is ACP's only stable transport (streamable HTTP is a draft proposal, and there is no WebSocket
// transport), which is exactly why ADR 0022 scopes agent hosting to the desktop host — a browser tab
// cannot spawn a child, so it cannot speak ACP at all.

use std::io::{self, BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, State};

// --- the agent's launch description -----------------------------------------

/// One `name`/`value` environment entry, matching ACP's own env shape (and the MCP server config it
/// mirrors) rather than a map — the protocol orders these, and a map would not round-trip duplicates.
#[derive(serde::Deserialize, serde::Serialize, Clone, Debug)]
pub struct EnvVar {
    pub name: String,
    pub value: String,
}

/// How the frontend describes the agent to launch. Deserialized straight off the `acp_start` command,
/// so every field the UI may omit carries `#[serde(default)]` — a registry entry for a keyless local
/// agent legitimately has no `env` and no `cwd`.
#[derive(serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpec {
    /// The executable to run (`npx`, `goose`, an absolute path…).
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<EnvVar>,
    /// Working directory for the child; the workspace root in practice. `None` inherits the host's.
    #[serde(default)]
    pub cwd: Option<String>,
}

impl AgentSpec {
    /// Refuse a spec that cannot name a program. Validated at the boundary because a blank command
    /// spawns nothing and fails several layers later with an error that no longer names the cause.
    pub fn validate(&self) -> Result<(), String> {
        if self.command.trim().is_empty() {
            return Err("agent command is empty".to_string());
        }
        Ok(())
    }
}

// --- managed state ----------------------------------------------------------

/// State for the ACP agent child. One agent at a time: `acp_start` is idempotent and a second call
/// while one runs is a no-op, so the frontend switches agents by stopping and starting.
#[derive(Default)]
pub struct AcpState {
    /// stdin handle of the running child; `None` until `acp_start` succeeds.
    pub stdin: Mutex<Option<ChildStdin>>,
    /// Keep the `Child` so it is not dropped, and so `acp_start` can guard against a double start.
    pub child: Mutex<Option<Child>>,
    /// Set once the user/app asks to stop; tells the reader thread the EOF was intentional so it
    /// reports a clean exit rather than a crash. Shared `Arc` — managed `State` is not `'static`.
    pub shutting_down: Arc<AtomicBool>,
}

// --- pure framing functions (the cargo test gate) ---------------------------

/// Write one ACP message: the body followed by a single `\n`. Flushes so the child sees it at once.
///
/// A body containing `\n` is REFUSED (`InvalidData`) and **nothing is written** — a partial write
/// would desynchronize the stream for every message after it, which is far worse than one failed send.
pub fn write_line<W: Write>(w: &mut W, body: &str) -> io::Result<()> {
    if body.contains('\n') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "ACP message contains an embedded newline",
        ));
    }
    w.write_all(body.as_bytes())?;
    w.write_all(b"\n")?;
    w.flush()
}

/// Read one ACP message. `Ok(Some(body))` on a message, `Ok(None)` on EOF.
///
/// Blank and whitespace-only lines are skipped rather than surfaced: they are not messages, and an
/// agent that emits one between frames should not produce a JSON parse error upstream. A trailing
/// `\r` is stripped so a Windows agent writing CRLF interoperates. A final line with no terminator is
/// still a message — a child killed mid-flush can leave one, and dropping it would lose the last
/// thing the agent said.
pub fn read_line_frame<R: BufRead>(r: &mut R) -> io::Result<Option<String>> {
    loop {
        let mut line = String::new();
        if r.read_line(&mut line)? == 0 {
            return Ok(None); // EOF
        }
        let body = line.trim_end_matches(['\r', '\n']);
        if body.trim().is_empty() {
            continue; // not a message
        }
        return Ok(Some(body.to_string()));
    }
}

// --- spawning ---------------------------------------------------------------

/// Spawn the agent with the broker's stdio wiring and detach its stdin/stdout. stderr is inherited so
/// an agent's own diagnostics reach the host's console instead of filling an unread pipe and blocking
/// the child once the OS buffer is full.
fn spawn_agent(spec: &AgentSpec) -> Result<(Child, ChildStdin, ChildStdout), String> {
    spec.validate()?;

    let mut cmd = Command::new(spec.command.trim());
    cmd.args(&spec.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    for entry in &spec.env {
        cmd.env(&entry.name, &entry.value);
    }
    if let Some(cwd) = spec.cwd.as_deref() {
        cmd.current_dir(cwd);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn ACP agent `{}`: {e}", spec.command))?;
    let stdin = child.stdin.take().ok_or("no stdin on agent child")?;
    let stdout = child.stdout.take().ok_or("no stdout on agent child")?;
    Ok((child, stdin, stdout))
}

/// Spawn the reader thread: split messages off `stdout`, re-emit each as `acp://message`, and when the
/// stream ends reap the child and emit `acp://exit` with its real exit code. It never relaunches —
/// see the module header for why that is the point rather than a gap.
fn spawn_reader_thread(app: AppHandle, stdout: ChildStdout, shutting_down: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_line_frame(&mut reader) {
                Ok(Some(body)) => {
                    let _ = app.emit("acp://message", body);
                }
                Ok(None) => break, // clean EOF
                Err(_) => break,   // malformed / IO error — the child is gone either way
            }
        }

        // Reap the child so the exit code we report is the real one, not a guess. An intentional stop
        // has already taken and killed it, in which case there is nothing to wait on and 0 is correct.
        let code = if shutting_down.load(Ordering::SeqCst) {
            0
        } else {
            app.state::<AcpState>()
                .child
                .lock()
                .ok()
                .and_then(|mut g| g.take())
                .and_then(|mut c| c.wait().ok())
                .and_then(|status| status.code())
                .unwrap_or(-1)
        };
        let _ = app.emit("acp://exit", code);
    });
}

// --- tauri commands ---------------------------------------------------------

/// Start the configured agent. Idempotent: the `child` lock is held across the whole
/// check-spawn-store, so two concurrent calls cannot both pass the guard and spawn duplicate agents.
#[tauri::command]
pub fn acp_start(
    app: AppHandle,
    state: State<'_, AcpState>,
    spec: AgentSpec,
) -> Result<(), String> {
    let mut child_guard = state.child.lock().map_err(|e| e.to_string())?;
    if child_guard.is_some() {
        return Ok(());
    }

    state.shutting_down.store(false, Ordering::SeqCst);

    let (child, stdin, stdout) = spawn_agent(&spec)?;
    *state.stdin.lock().map_err(|e| e.to_string())? = Some(stdin);
    *child_guard = Some(child); // stored while still holding the guard => atomic

    spawn_reader_thread(app.clone(), stdout, state.shutting_down.clone());
    Ok(())
}

/// Write one JSON-RPC message to the running agent.
#[tauri::command]
pub fn acp_send(state: State<'_, AcpState>, message: String) -> Result<(), String> {
    let mut guard = state.stdin.lock().map_err(|e| e.to_string())?;
    let stdin = guard.as_mut().ok_or("ACP agent not started")?;
    write_line(stdin, &message).map_err(|e| e.to_string())
}

/// Intentional shutdown: arm the clean-exit flag, drop stdin so the agent sees EOF, then kill to be
/// certain it exits. Idempotent and safe to call when nothing is running.
#[tauri::command]
pub fn acp_stop(state: State<'_, AcpState>) -> Result<(), String> {
    state.shutting_down.store(true, Ordering::SeqCst);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};

    // --- write_line -----------------------------------------------------------

    #[test]
    fn write_line_appends_exactly_one_newline() {
        let mut out: Vec<u8> = Vec::new();
        write_line(&mut out, r#"{"jsonrpc":"2.0","id":1}"#).unwrap();
        assert_eq!(out, b"{\"jsonrpc\":\"2.0\",\"id\":1}\n".to_vec());
    }

    #[test]
    fn write_line_rejects_an_embedded_newline() {
        let mut out: Vec<u8> = Vec::new();
        let err = write_line(&mut out, "{\"a\":1}\n{\"b\":2}").unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
        assert!(
            out.is_empty(),
            "nothing may be written when the body is rejected"
        );
    }

    // --- read_line_frame ------------------------------------------------------

    #[test]
    fn read_line_frame_splits_a_two_message_buffer_on_newline() {
        let mut r = BufReader::new(Cursor::new("{\"a\":1}\n{\"b\":2}\n"));
        assert_eq!(
            read_line_frame(&mut r).unwrap(),
            Some(r#"{"a":1}"#.to_string())
        );
        assert_eq!(
            read_line_frame(&mut r).unwrap(),
            Some(r#"{"b":2}"#.to_string())
        );
        assert_eq!(read_line_frame(&mut r).unwrap(), None, "clean EOF");
    }

    #[test]
    fn read_line_frame_tolerates_crlf_and_blank_lines() {
        let mut r = BufReader::new(Cursor::new("{\"a\":1}\r\n\n   \n{\"b\":2}\n"));
        assert_eq!(
            read_line_frame(&mut r).unwrap(),
            Some(r#"{"a":1}"#.to_string())
        );
        assert_eq!(
            read_line_frame(&mut r).unwrap(),
            Some(r#"{"b":2}"#.to_string())
        );
    }

    #[test]
    fn read_line_frame_returns_none_on_an_empty_stream() {
        let mut r = BufReader::new(Cursor::new(""));
        assert_eq!(read_line_frame(&mut r).unwrap(), None);
    }

    #[test]
    fn read_line_frame_yields_a_final_message_without_a_trailing_newline() {
        // A child that dies mid-flush can leave the last line unterminated; it is still a message.
        let mut r = BufReader::new(Cursor::new("{\"a\":1}"));
        assert_eq!(
            read_line_frame(&mut r).unwrap(),
            Some(r#"{"a":1}"#.to_string())
        );
        assert_eq!(read_line_frame(&mut r).unwrap(), None);
    }

    #[test]
    fn write_then_read_round_trips() {
        let mut buf: Vec<u8> = Vec::new();
        write_line(&mut buf, r#"{"method":"initialize"}"#).unwrap();
        write_line(&mut buf, r#"{"method":"session/new"}"#).unwrap();
        let mut r = BufReader::new(Cursor::new(buf));
        assert_eq!(
            read_line_frame(&mut r).unwrap().as_deref(),
            Some(r#"{"method":"initialize"}"#)
        );
        assert_eq!(
            read_line_frame(&mut r).unwrap().as_deref(),
            Some(r#"{"method":"session/new"}"#)
        );
        assert_eq!(read_line_frame(&mut r).unwrap(), None);
    }

    // --- AgentSpec ------------------------------------------------------------

    #[test]
    fn agent_spec_deserializes_the_frontend_shape() {
        let spec: AgentSpec = serde_json::from_str(
            r#"{"command":"npx","args":["@zed-industries/claude-code-acp"],
                "env":[{"name":"ANTHROPIC_API_KEY","value":"sk-x"}],"cwd":"/tmp/w"}"#,
        )
        .unwrap();
        assert_eq!(spec.command, "npx");
        assert_eq!(spec.args, vec!["@zed-industries/claude-code-acp"]);
        assert_eq!(spec.env.len(), 1);
        assert_eq!(spec.env[0].name, "ANTHROPIC_API_KEY");
        assert_eq!(spec.cwd.as_deref(), Some("/tmp/w"));
    }

    #[test]
    fn agent_spec_defaults_every_optional_field() {
        let spec: AgentSpec = serde_json::from_str(r#"{"command":"goose"}"#).unwrap();
        assert!(spec.args.is_empty());
        assert!(spec.env.is_empty());
        assert_eq!(spec.cwd, None);
    }

    #[test]
    fn agent_spec_rejects_a_blank_command() {
        // An empty command would spawn the shell's idea of "nothing" and fail opaquely later;
        // refuse it at the boundary where the error can still name the cause.
        assert!(AgentSpec {
            command: "   ".to_string(),
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(AgentSpec {
            command: "goose".to_string(),
            ..Default::default()
        }
        .validate()
        .is_ok());
    }
}
