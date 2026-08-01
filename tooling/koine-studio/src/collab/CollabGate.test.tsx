// Task 1 of issue #481: the UI half of the capability gate. `CollabGate` is the single place the
// collaboration affordance asks `Platform.canCollaborate` — mirroring how `terminalPanel` asks
// `canRunShell` and renders its "desktop only" placeholder instead of mounting xterm. A host that
// cannot broker a session must get a calm explanation, never a thrown error or a dead button.
import { describe, expect, test } from 'vitest';
import { axe } from 'vitest-axe';
import type { ComponentChildren } from 'preact';
import { createCollabGate } from '@/collab/CollabGate';
import type { Platform } from '@/host/types';

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

  test('dispose() unmounts, leaving the parent empty', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const gate = createCollabGate({ parent, platform: platformWith(false) });
    gate.dispose();
    expect(parent.innerHTML).toBe('');
    parent.remove();
  });
});
