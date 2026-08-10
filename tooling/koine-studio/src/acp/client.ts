// The Agent Client Protocol client core (#1970 Task 3, ADR 0022).
//
// Adapts Studio's callback-shaped {@link AcpTransport} onto the ACP SDK's `Stream` and exposes the
// four calls the assistant panel needs: `initialize`, `newSession`, `prompt`, `cancel`.
//
// WHY NOT `ndJsonStream`. The SDK ships a helper that frames newline-delimited JSON over byte
// streams — but our Rust broker ALREADY owns that framing (`acp.rs`: `write_line` appends the `\n`,
// `read_line_frame` strips it). Using it here would encode the newline twice and hand the agent a
// stream neither side could parse. So the adapter below moves whole JSON-RPC envelopes and leaves
// framing where it belongs: at the process boundary.
//
// WHAT THIS DELIBERATELY DOES NOT DO YET. It advertises `fs` and `terminal` client capabilities as
// FALSE, because Tasks 6 and 10 are what implement them. That is not a placeholder — capability
// negotiation is a promise, and an agent told we can `fs/write_text_file` would call a method that
// does not exist yet. Under-promising degrades; over-promising breaks the turn.
import { client, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type {
  AgentRequestParamsByMethod,
  AgentRequestResponsesByMethod,
  AnyMessage,
  ClientConnection,
  Stream,
} from '@agentclientprotocol/sdk';
import type { AcpTransport, AgentSpec } from '@/host/types';

type InitializeResponse = AgentRequestResponsesByMethod['initialize'];
type NewSessionParams = AgentRequestParamsByMethod['session/new'];
/** The agent's negotiated capabilities — what the caller gates optional methods on. */
export type AgentCapabilities = InitializeResponse['agentCapabilities'];

export interface AcpPromptOptions {
  /** Called with each `agent_message_chunk` text delta, in arrival order. */
  onText?: (delta: string) => void;
  /** Called with each `agent_thought_chunk` delta — the agent's reasoning, rendered distinctly. */
  onThought?: (delta: string) => void;
  /** Aborting cancels the turn agent-side (`session/cancel`), not just locally. */
  signal?: AbortSignal;
}

export interface AcpClientOptions {
  /** Name announced to the agent at `initialize`. */
  clientName?: string;
}

export interface AcpClient {
  /** The agent's capabilities once `initialize` has resolved; null before that. */
  readonly capabilities: AgentCapabilities | null;
  /** The live session id, or null before `newSession`. */
  readonly sessionId: string | null;
  /** Spawn the agent and negotiate versions/capabilities. */
  initialize(spec: AgentSpec): Promise<InitializeResponse>;
  /** Open a session and remember its id. Returns the id. */
  newSession(params: NewSessionParams): Promise<string>;
  /** Send a prompt turn; resolves with the agent's stop reason. */
  prompt(text: string, options?: AcpPromptOptions): Promise<string>;
  /** Cancel the turn in flight. A no-op when no session is open. */
  cancel(): Promise<void>;
  /** Close the connection and stop the agent. */
  close(): Promise<void>;
}

/**
 * Bridge the callback transport to the SDK's message stream. The readable side is wired in
 * `start(controller)`, which runs synchronously at construction — so the handler is attached before
 * anything can arrive, and the agent's very first message cannot be dropped.
 */
function streamOver(transport: AcpTransport): Stream {
  let controller: ReadableStreamDefaultController<AnyMessage> | null = null;
  const readable = new ReadableStream<AnyMessage>({
    start(c) {
      controller = c;
      transport.onMessage((json) => {
        let message: AnyMessage;
        try {
          message = JSON.parse(json) as AnyMessage;
        } catch {
          // NOT a protocol message, and not an error either. A third-party agent shares its stdout
          // with whatever it feels like printing — `npx` announces a cold-cache install, agents emit
          // banners and progress lines — and the broker only filters blank ones. Dropping the line
          // keeps the connection alive; throwing would escape into Tauri's event dispatch, where
          // nothing catches it, and the in-flight request would hang forever instead of failing.
          return;
        }
        controller?.enqueue(message);
      });
      transport.onExit((code) => {
        // The child is gone. Error the readable so the SDK rejects every pending request: a dead
        // agent must surface as a failed turn, not as a promise that can no longer settle.
        try {
          controller?.error(new Error(`ACP agent exited with code ${code}`));
        } catch {
          // already closed or errored — nothing to report twice
        }
        controller = null;
      });
    },
  });
  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      await transport.send(JSON.stringify(message));
    },
  });
  return { readable, writable };
}

/** The turn currently in flight, and the session it belongs to. */
interface ActiveTurn {
  readonly sessionId: string;
  readonly options: AcpPromptOptions;
}

export function createAcpClient(
  transport: AcpTransport,
  options: AcpClientOptions = {},
): AcpClient {
  // The turn currently in flight. `session/update` is a connection-level notification, so this is
  // what routes a chunk to the caller that asked for it; null between turns means chunks from a
  // cancelled-but-still-draining turn are dropped rather than appended to the next one.
  let active: ActiveTurn | null = null;
  let sessionId: string | null = null;
  let capabilities: AgentCapabilities | null = null;
  let connection: ClientConnection | null = null;

  const app = client({ name: options.clientName ?? 'koine-studio' });

  app.onNotification('session/update', ({ params }) => {
    // Match the session as well as the turn: `session/update` is connection-scoped, so after a second
    // `newSession` a late notification from the previous one would otherwise be appended to the
    // current turn's text.
    if (!active || params.sessionId !== active.sessionId) return;
    const update = params.update;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      active.options.onText?.(update.content.text);
    } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
      active.options.onThought?.(update.content.text);
    }
    // Every other update kind (tool_call, plan, available_commands_update, current_mode_update…) is
    // Task 4 and Task 9. Ignored here rather than half-rendered.
  });

  // `session/request_permission` is a BASELINE client method — unlike `fs/*` and `terminal/*` there is
  // no client capability that can decline to offer it, so an unregistered handler makes the SDK answer
  // `-32601 Method not found` and the agent aborts the turn. Every real agent asks before its first
  // tool call, so without this the spike can only ever complete a pure-text answer.
  //
  // Answering `cancelled` is the honest degraded behaviour until Task 5 builds the dialog: the spike
  // genuinely cannot ask the user, so it must not pretend consent. The agent gets a valid protocol
  // response and can stop cleanly, which is a different outcome from the connection breaking.
  app.onRequest('session/request_permission', () => ({ outcome: { outcome: 'cancelled' as const } }));

  /** The live connection, or a clear error — never an implicit re-`initialize`. */
  function requireConnection(): ClientConnection {
    if (!connection) throw new Error('ACP client is not initialized');
    return connection;
  }

  function requireSession(): string {
    if (!sessionId) throw new Error('no ACP session is open — call newSession first');
    return sessionId;
  }

  return {
    get capabilities() {
      return capabilities;
    },
    get sessionId() {
      return sessionId;
    },

    async initialize(spec: AgentSpec): Promise<InitializeResponse> {
      // A second `initialize` would re-register the transport's single `onMessage`, silently orphaning
      // the previous connection with its pending requests unresolvable. Refuse instead.
      if (connection) throw new Error('ACP client is already initialized — call close() first');
      // Wire the stream first (so the agent cannot out-run our reader), spawn second, and only then
      // publish `connection` — a spawn that fails must leave the client uninitialized rather than
      // holding a live-looking connection with no process behind it.
      const stream = streamOver(transport);
      await transport.start(spec);
      const connected = app.connect(stream);
      connection = connected;
      const response = await connected.agent.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          // See the module header: false because Tasks 6/10 implement these, not because we forgot.
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });
      capabilities = response.agentCapabilities;
      return response;
    },

    async newSession(params: NewSessionParams): Promise<string> {
      const response = await requireConnection().agent.request('session/new', params);
      sessionId = response.sessionId;
      return response.sessionId;
    },

    async prompt(text: string, promptOptions: AcpPromptOptions = {}): Promise<string> {
      const connected = requireConnection();
      const session = requireSession();
      // An ALREADY-aborted signal never fires `abort`, so registering a listener would silently do
      // nothing and the turn would be sent anyway — the exact outcome the listener exists to prevent.
      if (promptOptions.signal?.aborted) throw new Error('prompt aborted before it was sent');

      const turn: ActiveTurn = { sessionId: session, options: promptOptions };
      active = turn;
      // An abort must reach the AGENT — cancelling only locally would leave it working (and billing)
      // on a turn nobody is reading. The rejection is swallowed because the connection may already be
      // closed (an agent that crashed mid-turn), and cancelling a dead turn is moot, not an error.
      const onAbort = () => {
        void connected.agent.notify('session/cancel', { sessionId: session }).catch(() => {});
      };
      promptOptions.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const response = await connected.agent.request('session/prompt', {
          sessionId: session,
          prompt: [{ type: 'text', text }],
        });
        return response.stopReason;
      } finally {
        promptOptions.signal?.removeEventListener('abort', onAbort);
        // Only clear OUR turn: if an overlapping prompt has since taken the slot, blanking it here
        // would mute every remaining chunk of a turn that is still running.
        if (active === turn) active = null;
      }
    },

    async cancel(): Promise<void> {
      // Deliberately a no-op rather than a throw: "stop" is a UI affordance that can legitimately be
      // hit when nothing is running, and making the caller guard would just push this check upward.
      if (!connection || !sessionId) return;
      await connection.agent.notify('session/cancel', { sessionId });
    },

    async close(): Promise<void> {
      connection?.close();
      connection = null;
      sessionId = null;
      active = null;
      // Cleared too: `capabilities` is what callers gate optional affordances on, so leaving the dead
      // agent's capabilities behind would keep offering session-resume or image attachment against a
      // connection that no longer exists.
      capabilities = null;
      await transport.stop();
    },
  };
}
