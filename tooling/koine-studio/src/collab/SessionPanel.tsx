// The session UI for Koine Studio's real-time collaboration (issue #481 Task 4, Phase 2 of #259) — the
// start / join / leave controls `CollabGate` renders once the host can broker a session (`renderSession`).
//
// The panel is a pure VIEW over `CollabSession`: it subscribes to the session's state and calls its
// methods, and holds no collaboration state of its own beyond the invitation currently being typed.
// Everything it shows comes from the broker's answer, which is why the save-authority line can be
// trusted — see the authority rule in `src/editor/collab/session.ts`.
//
// Two details are deliberate:
//   * **"Who can save" is stated explicitly, on both sides.** The spec calls for it, and a participant
//     who wrongly believes they own the canonical `.koi` will eventually lose someone's work.
//   * **The invitation is treated as a secret.** It is shown (you have to hand it over somehow) and
//     copyable, but it is never logged, and it disappears from the panel the moment the session ends,
//     because the session drops it from its state.
import { useEffect, useState } from 'preact/hooks';
import type { CollabSession, CollabSessionState } from '@/editor/collab/session';
import { safePresenceColor } from '@/editor/presence';

/** What the authority sees. Phrased as ownership because that is what it is. */
const AUTHORITY_SAVE_TEXT = 'You own the canonical save for this session — saving writes the model to disk.';
/** What everyone else sees: their edits are live and safe, the file write simply isn't theirs. */
const GUEST_SAVE_TEXT =
  'The participant who started this session owns the canonical save. Your edits sync live to everyone; ' +
  'writing the model to disk is theirs.';

export interface CollabSessionPanelProps {
  /** The session to drive. The panel never constructs one — the host wiring owns its lifetime. */
  session: CollabSession;
}

/** Subscribe to a session, re-rendering on every published state. */
function useSessionState(session: CollabSession): CollabSessionState {
  const [state, setState] = useState<CollabSessionState>(() => session.getState());
  useEffect(() => {
    // Re-read on (re)subscribe: the session may have moved between the initial render and this effect.
    setState(session.getState());
    return session.subscribe(setState);
  }, [session]);
  return state;
}

function ParticipantList({ participants }: { participants: CollabSessionState['participants'] }) {
  return (
    <ul class="koi-collab-participants">
      {participants.map((p) => (
        <li key={p.id} class="koi-collab-participant">
          {/* The colour is peer-supplied and lands in a style attribute, so it is bounded to an actual
              colour syntax first — see safePresenceColor. */}
          <span
            class="koi-collab-swatch"
            style={`--koi-presence-color: ${safePresenceColor(p.color)}`}
            aria-hidden="true"
          />
          {p.displayName}
        </li>
      ))}
    </ul>
  );
}

/** The live half: who is here, the invitation to hand out, who can save, and the way out. */
function LiveSession({ session, state }: { session: CollabSession; state: CollabSessionState }) {
  const [copied, setCopied] = useState(false);
  // A new session means a new invitation, and a stale "Copied" would claim the wrong one is on the
  // clipboard — the sort of small lie that ends with the wrong secret pasted into a chat window.
  useEffect(() => setCopied(false), [state.token]);

  const copy = () => {
    const token = state.token;
    if (!token) return;
    // `navigator.clipboard` is absent in some hosts (and in tests); the field stays selectable either way.
    void navigator.clipboard?.writeText(token).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <>
      <p class="koi-collab-status">{state.participants.length} in this session</p>
      <ParticipantList participants={state.participants} />

      <label class="koi-collab-field">
        <span class="koi-collab-label">Invitation</span>
        <input class="koi-collab-input" type="text" readOnly value={state.token ?? ''} />
      </label>
      <p class="koi-collab-note">
        Anyone with this invitation can edit the model. Share it the way you would a password.
      </p>
      <div class="koi-collab-actions">
        <button type="button" class="koi-collab-btn" onClick={copy}>
          {copied ? 'Copied' : 'Copy invitation'}
        </button>
        <button type="button" class="koi-collab-btn koi-collab-btn-danger" onClick={() => void session.leave()}>
          Leave session
        </button>
      </div>

      <p class={`koi-collab-authority ${state.canSave ? 'is-authority' : ''}`}>
        {state.canSave ? AUTHORITY_SAVE_TEXT : GUEST_SAVE_TEXT}
      </p>
    </>
  );
}

/** The idle half: open a session over this buffer, or join someone else's. */
function StartOrJoin({ session }: { session: CollabSession }) {
  const [token, setToken] = useState('');
  const trimmed = token.trim();

  return (
    <>
      <div class="koi-collab-actions">
        <button type="button" class="koi-collab-btn koi-collab-btn-primary" onClick={() => void session.create()}>
          Start a session
        </button>
      </div>
      <p class="koi-collab-note">Starting shares the model you have open, and makes this the saving copy.</p>

      <label class="koi-collab-field">
        <span class="koi-collab-label">Join with an invitation</span>
        <input
          class="koi-collab-input"
          type="text"
          value={token}
          placeholder="Paste the invitation you were given"
          onInput={(e) => setToken((e.currentTarget as HTMLInputElement).value)}
        />
      </label>
      <div class="koi-collab-actions">
        <button
          type="button"
          class="koi-collab-btn"
          disabled={trimmed.length === 0}
          onClick={() => {
            if (trimmed.length === 0) return;
            void session.join(trimmed);
          }}
        >
          Join session
        </button>
      </div>
    </>
  );
}

/**
 * The collaboration session panel. Render it from {@link CollabGate}'s `renderSession` so it is only
 * ever reachable on a host that {@link Platform.canCollaborate} — the panel itself assumes a usable
 * transport and does not re-check the capability.
 */
export function CollabSessionPanel({ session }: CollabSessionPanelProps) {
  const state = useSessionState(session);
  const live = state.status === 'live' || state.status === 'connecting';

  return (
    <div class="koi-collab-session">
      {state.error !== null && (
        <p class="koi-collab-error" role="alert">
          {state.error}
        </p>
      )}
      {state.status === 'connecting' && (
        <p class="koi-collab-status" aria-live="polite">
          Connecting…
        </p>
      )}
      {live && state.status === 'live' ? <LiveSession session={session} state={state} /> : null}
      {live ? null : <StartOrJoin session={session} />}
    </div>
  );
}
