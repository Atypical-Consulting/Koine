// The capability gate for Koine Studio's real-time collaboration UI (issue #481, Phase 2 of #259).
//
// Every collaboration affordance renders THROUGH this component, so exactly one place in the UI reads
// `Platform.canCollaborate` — the same discipline `terminalPanel` applies to `canRunShell`. A host that
// cannot broker a session gets a calm explanation of why and what would change it; it never gets a
// thrown error, and never a control that would fail if clicked.
//
// The gate itself owns no session state. Hand it a `session` and it renders the start/join/leave panel
// (#481 Task 4); `renderSession` stays available for a caller that wants to supply its own UI, and a
// capable host given neither still gets the interim note below rather than an empty box.
import { render, type ComponentChildren } from 'preact';
import type { Platform } from '@/host/types';
import { CollabSessionPanel } from '@/collab/SessionPanel';
import type { CollabSession } from '@/editor/collab/session';

/**
 * Why a host can't collaborate, in the user's terms — and what to do about it. A browser tab can neither
 * listen for peers nor dial one, so the remedy is the desktop shell; the relay is named because it is
 * what the desktop points at when the two participants can't reach each other directly (#481 Task 5).
 */
const PLACEHOLDER_TEXT =
  'Live collaboration needs a host that can broker a session, which a browser tab cannot do. Open this ' +
  'workspace in the Koine Studio desktop app to co-edit a model with someone else — it brokers the ' +
  'session itself, or through a relay you configure.';

/** Shown to a broker-capable host that was handed neither a session nor a custom `renderSession`. */
const NOT_WIRED_TEXT = 'This host can broker a session. Session controls are not wired up yet.';

export interface CollabGateOptions {
  /** The element to render into. */
  parent: Element;
  /** The host platform — the gate reads `canCollaborate` and nothing else. */
  platform: Platform;
  /** The session to drive the start/join/leave panel from, on a broker-capable host. */
  session?: CollabSession;
  /** A custom session UI, overriding the built-in panel. Takes precedence over `session`. */
  renderSession?: () => ComponentChildren;
}

/** Handle returned by {@link createCollabGate}. */
export interface CollabGate {
  /** Unmount the gate, leaving `parent` empty. */
  dispose(): void;
}

function sessionUi(session?: CollabSession, renderSession?: () => ComponentChildren): ComponentChildren {
  if (renderSession) return renderSession();
  if (session) return <CollabSessionPanel session={session} />;
  return <p class="koi-collab-note">{NOT_WIRED_TEXT}</p>;
}

function CollabGateView({ platform, session, renderSession }: Omit<CollabGateOptions, 'parent'>) {
  if (!platform.canCollaborate) {
    return (
      <div class="koi-collab koi-collab-placeholder">
        <p class="koi-collab-placeholder-text">{PLACEHOLDER_TEXT}</p>
      </div>
    );
  }
  return <div class="koi-collab">{sessionUi(session, renderSession)}</div>;
}

/**
 * Mount the collaboration affordance inside `parent`. On a host that {@link Platform.canCollaborate} it
 * renders `renderSession()`; otherwise it renders the graceful desktop-only/relay placeholder.
 */
export function createCollabGate(opts: CollabGateOptions): CollabGate {
  render(
    <CollabGateView platform={opts.platform} session={opts.session} renderSession={opts.renderSession} />,
    opts.parent,
  );
  return {
    dispose() {
      render(null, opts.parent);
    },
  };
}
