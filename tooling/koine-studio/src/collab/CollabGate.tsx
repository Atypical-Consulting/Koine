// The capability gate for Koine Studio's real-time collaboration UI (issue #481, Phase 2 of #259).
//
// Every collaboration affordance renders THROUGH this component, so exactly one place in the UI reads
// `Platform.canCollaborate` — the same discipline `terminalPanel` applies to `canRunShell`. A host that
// cannot broker a session gets a calm explanation of why and what would change it; it never gets a
// thrown error, and never a control that would fail if clicked.
//
// The gate itself owns no session state: `renderSession` supplies the start/join/leave UI once the
// session lifecycle lands (#481 Task 4), and until then a capable host sees the interim note below.
import { render, type ComponentChildren } from 'preact';
import type { Platform } from '@/host/types';

/**
 * Why a host can't collaborate, in the user's terms. Names both remedies the spec allows — the desktop
 * shell, or pointing Studio at a relay — so the placeholder is actionable rather than a dead end.
 */
const PLACEHOLDER_TEXT =
  'Live collaboration needs a host that can broker a session. Open this workspace in the Koine Studio ' +
  'desktop app, or configure a collaboration relay, to co-edit a model with someone else.';

/** Shown to a broker-capable host before the session controls exist (#481 Task 4). */
const NOT_WIRED_TEXT = 'This host can broker a session. Session controls are not wired up yet.';

export interface CollabGateOptions {
  /** The element to render into. */
  parent: Element;
  /** The host platform — the gate reads `canCollaborate` and nothing else. */
  platform: Platform;
  /** The session UI to render on a broker-capable host; omitted until #481 Task 4 supplies it. */
  renderSession?: () => ComponentChildren;
}

/** Handle returned by {@link createCollabGate}. */
export interface CollabGate {
  /** Unmount the gate, leaving `parent` empty. */
  dispose(): void;
}

function CollabGateView({ platform, renderSession }: Omit<CollabGateOptions, 'parent'>) {
  if (!platform.canCollaborate) {
    return (
      <div class="koi-collab koi-collab-placeholder">
        <p class="koi-collab-placeholder-text">{PLACEHOLDER_TEXT}</p>
      </div>
    );
  }
  return <div class="koi-collab">{renderSession ? renderSession() : <p class="koi-collab-note">{NOT_WIRED_TEXT}</p>}</div>;
}

/**
 * Mount the collaboration affordance inside `parent`. On a host that {@link Platform.canCollaborate} it
 * renders `renderSession()`; otherwise it renders the graceful desktop-only/relay placeholder.
 */
export function createCollabGate(opts: CollabGateOptions): CollabGate {
  render(<CollabGateView platform={opts.platform} renderSession={opts.renderSession} />, opts.parent);
  return {
    dispose() {
      render(null, opts.parent);
    },
  };
}
