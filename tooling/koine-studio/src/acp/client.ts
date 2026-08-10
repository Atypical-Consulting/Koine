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
  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      transport.onMessage((json) => {
        controller.enqueue(JSON.parse(json) as AnyMessage);
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

export function createAcpClient(
  transport: AcpTransport,
  options: AcpClientOptions = {},
): AcpClient {
  // The turn currently in flight. `session/update` is a connection-level notification, so this is
  // what routes a chunk to the caller that asked for it; null between turns means chunks from a
  // cancelled-but-still-draining turn are dropped rather than appended to the next one.
  let active: AcpPromptOptions | null = null;
  let sessionId: string | null = null;
  let capabilities: AgentCapabilities | null = null;
  let connection: ClientConnection | null = null;

  const app = client({ name: options.clientName ?? 'koine-studio' });

  app.onNotification('session/update', ({ params }) => {
    const update = params.update;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      active?.onText?.(update.content.text);
    } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
      active?.onThought?.(update.content.text);
    }
    // Every other update kind (tool_call, plan, available_commands_update, current_mode_update…) is
    // Task 4 and Task 9. Ignored here rather than half-rendered.
  });

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
      connection = app.connect(streamOver(transport));
      // Spawn only after the stream is wired, so the agent cannot out-run our reader.
      await transport.start(spec);
      const response = await connection.agent.request('initialize', {
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
      active = promptOptions;
      // An abort must reach the AGENT — cancelling only locally would leave it working (and billing)
      // on a turn nobody is reading.
      const onAbort = () => {
        void connected.agent.notify('session/cancel', { sessionId: session });
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
        active = null;
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
      await transport.stop();
    },
  };
}
