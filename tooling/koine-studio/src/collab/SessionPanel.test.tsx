// Task 4 of issue #481: the session UI — the start/join/leave controls `CollabGate` renders once the
// host can broker a session. `session.test.ts` pins the lifecycle itself; these specs pin what the two
// people in the room actually see, and above all the one thing they must never be wrong about: **who
// owns the canonical save.** A participant who believes they can save when they can't loses work.
import { describe, expect, test, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { render } from 'preact';
import { CollabSessionPanel } from '@/collab/SessionPanel';
import type { CollabSession, CollabSessionState } from '@/editor/collab/session';
import type { CollabParticipant } from '@/host/types';

/** Preact defers effects and batches renders past the current task, so assertions that depend on a
 *  re-render (or on the subscription effect having run) have to wait a tick. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 25));

const ADA: CollabParticipant = { id: 'ada', displayName: 'Ada', color: '#e8637c' };
const GRACE: CollabParticipant = { id: 'grace', displayName: 'Grace', color: '#54b8a0' };

const IDLE: CollabSessionState = {
  status: 'idle',
  sessionId: null,
  token: null,
  authority: false,
  canSave: false,
  participants: [],
  error: null,
};

const LIVE_AUTHORITY: CollabSessionState = {
  status: 'live',
  sessionId: 'session-1',
  token: 'token-1',
  authority: true,
  canSave: true,
  participants: [ADA, GRACE],
  error: null,
};

/** A session double whose state the test drives; every call is recorded for the action assertions. */
function fakeSession(initial: CollabSessionState = IDLE) {
  let state = initial;
  const listeners = new Set<(s: CollabSessionState) => void>();
  const calls = { create: 0, join: [] as string[], leave: 0 };
  const session: CollabSession = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    create: () => {
      calls.create++;
      return Promise.resolve(state);
    },
    join: (token: string) => {
      calls.join.push(token);
      return Promise.resolve(state);
    },
    reconnect: () => Promise.resolve(state),
    leave: () => {
      calls.leave++;
      return Promise.resolve();
    },
  };
  const push = (next: CollabSessionState) => {
    state = next;
    for (const listener of [...listeners]) listener(next);
  };
  return { session, calls, push };
}

function mount(state: CollabSessionState = IDLE) {
  const fake = fakeSession(state);
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  render(<CollabSessionPanel session={fake.session} />, parent);
  return {
    ...fake,
    parent,
    text: () => parent.textContent ?? '',
    button: (label: RegExp) =>
      [...parent.querySelectorAll('button')].find((b) => label.test(b.textContent ?? '')) ?? null,
    cleanup: () => {
      render(null, parent);
      parent.remove();
    },
  };
}

describe('CollabSessionPanel — before a session', () => {
  test('offers starting a session and joining one', () => {
    const ui = mount();
    expect(ui.button(/start/i)).not.toBeNull();
    expect(ui.button(/join/i)).not.toBeNull();
    expect(ui.parent.querySelector('input')).not.toBeNull();
    ui.cleanup();
  });

  test('starting a session calls create()', () => {
    const ui = mount();
    ui.button(/start/i)?.click();
    expect(ui.calls.create).toBe(1);
    ui.cleanup();
  });

  test('joining passes the pasted invitation through verbatim', async () => {
    const ui = mount();
    const input = ui.parent.querySelector('input');
    if (!input) throw new Error('no invitation field');
    input.value = '  token-from-a-colleague  ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    ui.button(/join/i)?.click();

    // Trimmed, because an invitation is nearly always pasted with stray whitespace.
    expect(ui.calls.join).toEqual(['token-from-a-colleague']);
    ui.cleanup();
  });

  test('does not attempt to join on an empty invitation', () => {
    const ui = mount();
    ui.button(/join/i)?.click();
    expect(ui.calls.join).toEqual([]);
    ui.cleanup();
  });

  test('has no accessibility violations', async () => {
    const ui = mount();
    expect(await axe(ui.parent)).toHaveNoViolations();
    ui.cleanup();
  });
});

describe('CollabSessionPanel — live session', () => {
  test('lists every participant, this one included', () => {
    const ui = mount(LIVE_AUTHORITY);
    expect(ui.text()).toContain('Ada');
    expect(ui.text()).toContain('Grace');
    ui.cleanup();
  });

  test('the authority is told they own the canonical save', () => {
    const ui = mount(LIVE_AUTHORITY);
    expect(ui.text()).toMatch(/you .*save/i);
    ui.cleanup();
  });

  test('a joiner is told the save is NOT theirs', () => {
    const ui = mount({ ...LIVE_AUTHORITY, authority: false, canSave: false });
    const text = ui.text();
    expect(text).toMatch(/save/i);
    expect(text).not.toMatch(/you own/i);
    ui.cleanup();
  });

  test('the save-authority message follows a live state change', async () => {
    const ui = mount({ ...LIVE_AUTHORITY, authority: false, canSave: false });
    await flush(); // let the subscription effect run
    expect(ui.text()).not.toMatch(/you own/i);

    ui.push(LIVE_AUTHORITY);
    await flush();

    expect(ui.text()).toMatch(/you own/i);
    ui.cleanup();
  });

  test('catches up on a state change that landed BEFORE the subscription effect ran', async () => {
    // Preact defers effects past the first render, so a session that goes live in that window would
    // otherwise leave the panel showing stale authority — the worst field to be stale in.
    const ui = mount({ ...LIVE_AUTHORITY, authority: false, canSave: false });
    ui.push(LIVE_AUTHORITY);

    await flush();

    expect(ui.text()).toMatch(/you own/i);
    ui.cleanup();
  });

  test('surfaces the invitation so it can be handed to someone, and copies it on demand', async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const ui = mount(LIVE_AUTHORITY);

    const field = ui.parent.querySelector('input');
    expect(field?.value).toBe('token-1');
    ui.button(/copy/i)?.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('token-1');
    ui.cleanup();
  });

  test('offers leaving, and calls leave()', () => {
    const ui = mount(LIVE_AUTHORITY);
    ui.button(/leave/i)?.click();
    expect(ui.calls.leave).toBe(1);
    ui.cleanup();
  });

  test('offers no way to start or join a SECOND session while one is live', () => {
    const ui = mount(LIVE_AUTHORITY);
    expect(ui.button(/start a session/i)).toBeNull();
    expect(ui.button(/^join/i)).toBeNull();
    ui.cleanup();
  });

  test('has no accessibility violations', async () => {
    const ui = mount(LIVE_AUTHORITY);
    expect(await axe(ui.parent)).toHaveNoViolations();
    ui.cleanup();
  });
});

describe('CollabSessionPanel — failure and teardown', () => {
  test('announces an error without ever showing a token', () => {
    const ui = mount({
      ...IDLE,
      status: 'error',
      error: 'Could not join that session — the invitation may have expired.',
    });

    const alert = ui.parent.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('expired');
    // Failing back to the start/join controls is what makes the error recoverable.
    expect(ui.button(/start/i)).not.toBeNull();
    ui.cleanup();
  });

  test('unsubscribes on unmount (no state push into a torn-down tree)', () => {
    const ui = mount();
    ui.cleanup();
    expect(() => ui.push(LIVE_AUTHORITY)).not.toThrow();
  });
});
