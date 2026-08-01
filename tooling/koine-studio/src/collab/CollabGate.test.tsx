// Task 1 of issue #481: the UI half of the capability gate. `CollabGate` is the single place the
// collaboration affordance asks `Platform.canCollaborate` — mirroring how `terminalPanel` asks
// `canRunShell` and renders its "desktop only" placeholder instead of mounting xterm. A host that
// cannot broker a session must get a calm explanation, never a thrown error or a dead button.
import { describe, expect, test } from 'vitest';
import { axe } from 'vitest-axe';
import type { ComponentChildren } from 'preact';
import { createCollabGate } from '@/collab/CollabGate';
import type { Platform } from '@/host/types';
import type { CollabSessionState } from '@/editor/collab/session';

/** The state a freshly-built session reports, for the panel-slot test below (#481 Task 4). */
const IDLE_SESSION_STATE: CollabSessionState = {
  status: 'idle',
  sessionId: null,
  token: null,
  authority: false,
  canSave: false,
  participants: [],
  error: null,
};

/** A platform stub carrying only what the gate reads — it must not touch anything else. */
const platformWith = (canCollaborate: boolean): Platform => ({ canCollaborate }) as unknown as Platform;

function mount(canCollaborate: boolean, sessionUi?: () => ComponentChildren) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const gate = createCollabGate({ parent, platform: platformWith(canCollaborate), renderSession: sessionUi });
  return { parent, cleanup: () => { gate.dispose(); parent.remove(); } };
}

describe('CollabGate', () => {
  test('renders the graceful desktop-only placeholder when the host cannot broker a session', () => {
    const { parent, cleanup } = mount(false);
    const text = parent.textContent ?? '';
    expect(text).toMatch(/desktop/i);
    expect(text).toMatch(/relay/i);
    cleanup();
  });

  test('the placeholder is a static explanation — no dead controls to click', () => {
    const { parent, cleanup } = mount(false);
    expect(parent.querySelectorAll('button')).toHaveLength(0);
    cleanup();
  });

  test('renders the session UI instead when the host CAN broker a session', () => {
    const { parent, cleanup } = mount(true, () => <p>Session controls</p>);
    expect(parent.textContent).toContain('Session controls');
    expect(parent.textContent ?? '').not.toMatch(/desktop only/i);
    cleanup();
  });

  // Until the session lifecycle lands (#481 Task 4) a broker-capable host has no controls to show; the
  // gate must still render something coherent rather than an empty box.
  test('falls back to a "not wired yet" note when a capable host has no session UI to render', () => {
    const { parent, cleanup } = mount(true);
    expect(parent.textContent ?? '').not.toBe('');
    cleanup();
  });

  test('has no accessibility violations in the placeholder state', async () => {
    const { parent, cleanup } = mount(false);
    expect(await axe(parent)).toHaveNoViolations();
    cleanup();
  });

  // #481 Task 4: the gate now has a real panel to drop into that slot.
  test('renders the session panel for a capable host given a session', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const session = {
      getState: () => IDLE_SESSION_STATE,
      subscribe: () => () => undefined,
      create: () => Promise.resolve(IDLE_SESSION_STATE),
      join: () => Promise.resolve(IDLE_SESSION_STATE),
      reconnect: () => Promise.resolve(IDLE_SESSION_STATE),
      leave: () => Promise.resolve(),
    };
    const gate = createCollabGate({ parent, platform: platformWith(true), session });

    expect(parent.querySelector('.koi-collab-session')).not.toBeNull();
    expect(parent.textContent ?? '').toMatch(/start a session/i);

    gate.dispose();
    parent.remove();
  });

  test('a caller-supplied renderSession still wins over the built-in panel', () => {
    const { parent, cleanup } = mount(true, () => <p>Custom controls</p>);
    expect(parent.textContent).toContain('Custom controls');
    expect(parent.querySelector('.koi-collab-session')).toBeNull();
    cleanup();
  });

  test('dispose() unmounts, leaving the parent empty', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const gate = createCollabGate({ parent, platform: platformWith(false) });
    gate.dispose();
    expect(parent.innerHTML).toBe('');
    parent.remove();
  });
});
