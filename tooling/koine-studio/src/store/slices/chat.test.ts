import { describe, expect, test } from 'vitest';
import { createAppStore } from '@/store/index';
import type { ChatMessage } from '@/ai/ai';
import type { StagedEdit } from '@/ai/editSession';

const user = (content: string): ChatMessage => ({ role: 'user', content });
const assistant = (content: string): ChatMessage => ({ role: 'assistant', content });

describe('chat slice', () => {
  test('initial state: scratch workspace, empty transcript, idle, no change set', () => {
    const s = createAppStore();
    expect(s.getState().chat.workspaceKey).toBe('scratch');
    expect(s.getState().chat.messages).toEqual([]);
    expect(s.getState().chat.status).toBe('idle');
    expect(s.getState().chat.changeSet).toBeNull();
  });

  test('hydrateChat swaps the workspace key and transcript', () => {
    const s = createAppStore();
    const msgs = [user('hi'), assistant('hello')];
    s.getState().hydrateChat('ws-1', msgs);
    expect(s.getState().chat.workspaceKey).toBe('ws-1');
    expect(s.getState().chat.messages).toEqual(msgs);
  });

  test('hydrateChat is a no-op mid-stream (a workspace reassignment must not clobber a live turn)', () => {
    const s = createAppStore();
    s.getState().appendChatMessage(user('question'));
    s.getState().startChatTurn();
    s.getState().hydrateChat('other-ws', [assistant('stale transcript')]);
    expect(s.getState().chat.workspaceKey).toBe('scratch');
    expect(s.getState().chat.messages).toEqual([user('question')]);
    expect(s.getState().chat.status).toBe('streaming');
  });

  test('appendChatMessage appends immutably (new array identity, old array untouched)', () => {
    const s = createAppStore();
    const before = s.getState().chat.messages;
    s.getState().appendChatMessage(user('first'));
    const after = s.getState().chat.messages;
    expect(after).not.toBe(before);
    expect(before).toEqual([]);
    expect(after).toEqual([user('first')]);
    s.getState().appendChatMessage(assistant('second'));
    expect(after).toEqual([user('first')]); // prior snapshot unchanged
    expect(s.getState().chat.messages).toEqual([user('first'), assistant('second')]);
  });

  test('startChatTurn moves idle → streaming and finishChatTurn back to idle', () => {
    const s = createAppStore();
    s.getState().startChatTurn();
    expect(s.getState().chat.status).toBe('streaming');
    s.getState().finishChatTurn();
    expect(s.getState().chat.status).toBe('idle');
  });

  test('startChatTurn recovers from error back to streaming', () => {
    const s = createAppStore();
    s.getState().appendChatMessage(user('boom'));
    s.getState().startChatTurn();
    s.getState().abortChatTurn({ rollbackUserTurn: true });
    expect(s.getState().chat.status).toBe('error');
    s.getState().startChatTurn();
    expect(s.getState().chat.status).toBe('streaming');
  });

  test('startChatTurn while streaming is a no-op', () => {
    const s = createAppStore();
    s.getState().startChatTurn();
    const before = s.getState().chat;
    s.getState().startChatTurn();
    expect(s.getState().chat).toBe(before);
    expect(s.getState().chat.status).toBe('streaming');
  });

  test('abortChatTurn({ rollbackUserTurn: true }) pops exactly the trailing user turn and sets error', () => {
    const s = createAppStore();
    s.getState().appendChatMessage(user('earlier'));
    s.getState().appendChatMessage(assistant('earlier reply'));
    s.getState().appendChatMessage(user('just sent'));
    s.getState().startChatTurn();
    s.getState().abortChatTurn({ rollbackUserTurn: true });
    expect(s.getState().chat.status).toBe('error');
    expect(s.getState().chat.messages).toEqual([user('earlier'), assistant('earlier reply')]);
  });

  test('abortChatTurn({ rollbackUserTurn: true }) leaves a trailing assistant turn in place', () => {
    const s = createAppStore();
    s.getState().appendChatMessage(user('q'));
    s.getState().appendChatMessage(assistant('partial reply'));
    s.getState().startChatTurn();
    s.getState().abortChatTurn({ rollbackUserTurn: true });
    expect(s.getState().chat.status).toBe('error');
    expect(s.getState().chat.messages).toEqual([user('q'), assistant('partial reply')]);
  });

  test('abortChatTurn({ rollbackUserTurn: false }) keeps messages intact and returns to idle', () => {
    const s = createAppStore();
    s.getState().appendChatMessage(user('kept'));
    s.getState().startChatTurn();
    s.getState().abortChatTurn({ rollbackUserTurn: false });
    expect(s.getState().chat.status).toBe('idle');
    expect(s.getState().chat.messages).toEqual([user('kept')]);
  });

  test('clearChatTranscript empties the messages', () => {
    const s = createAppStore();
    s.getState().appendChatMessage(user('a'));
    s.getState().appendChatMessage(assistant('b'));
    s.getState().clearChatTranscript();
    expect(s.getState().chat.messages).toEqual([]);
  });
});

const edit = (relPath: string, body: string, isNew = false): StagedEdit => ({
  relPath,
  body,
  isNew,
});

describe('change-set state machine', () => {
  test('stageChangeSet yields a reviewing set: all accepted, none drifted, before per relPath', () => {
    const s = createAppStore();
    s.getState().stageChangeSet(
      [edit('billing.koi', 'context Billing {}'), edit('shipping.koi', 'context Shipping {}', true)],
      { 'billing.koi': 'context Old {}' },
      '2 errors',
    );
    const cs = s.getState().chat.changeSet;
    expect(cs).not.toBeNull();
    expect(cs?.phase).toEqual({ kind: 'reviewing' });
    expect(cs?.diagnostics).toBe('2 errors');
    expect(cs?.files).toEqual([
      {
        relPath: 'billing.koi',
        body: 'context Billing {}',
        isNew: false,
        before: 'context Old {}',
        accepted: true,
        drifted: false,
      },
      {
        relPath: 'shipping.koi',
        body: 'context Shipping {}',
        isNew: true,
        before: '', // a new file has no send-time text
        accepted: true,
        drifted: false,
      },
    ]);
  });

  test('a second stage replaces the set with a strictly larger id, even across discard', () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'one')], {}, null);
    const first = s.getState().chat.changeSet!.id;
    s.getState().stageChangeSet([edit('b.koi', 'two')], {}, null);
    const second = s.getState().chat.changeSet!.id;
    expect(second).toBeGreaterThan(first);
    expect(s.getState().chat.changeSet?.files.map((f) => f.relPath)).toEqual(['b.koi']);
    s.getState().discardChangeSet();
    s.getState().stageChangeSet([edit('c.koi', 'three')], {}, null);
    expect(s.getState().chat.changeSet!.id).toBeGreaterThan(second);
  });

  test('setChangeSetFileAccepted toggles a file in reviewing, leaving the others alone', () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'x'), edit('b.koi', 'y')], {}, null);
    s.getState().setChangeSetFileAccepted('a.koi', false);
    const files = s.getState().chat.changeSet!.files;
    expect(files.find((f) => f.relPath === 'a.koi')?.accepted).toBe(false);
    expect(files.find((f) => f.relPath === 'b.koi')?.accepted).toBe(true);
    s.getState().setChangeSetFileAccepted('a.koi', true);
    expect(s.getState().chat.changeSet!.files.find((f) => f.relPath === 'a.koi')?.accepted).toBe(true);
  });

  test('setChangeSetFileAccepted also works while applying', () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
    s.getState().beginChangeSetApply();
    expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'applying' });
    s.getState().setChangeSetFileAccepted('a.koi', false);
    expect(s.getState().chat.changeSet?.files[0]?.accepted).toBe(false);
  });

  test('setChangeSetFileAccepted is a no-op once applied or invalidated, and on null', () => {
    const s = createAppStore();
    s.getState().setChangeSetFileAccepted('a.koi', false); // null change set: must not throw
    expect(s.getState().chat.changeSet).toBeNull();

    s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
    s.getState().beginChangeSetApply();
    s.getState().resolveChangeSetApply({ failed: [] });
    s.getState().setChangeSetFileAccepted('a.koi', false);
    expect(s.getState().chat.changeSet?.files[0]?.accepted).toBe(true); // applied: untouched

    s.getState().stageChangeSet([edit('b.koi', 'y')], {}, null);
    s.getState().invalidateChangeSet('superseded');
    s.getState().setChangeSetFileAccepted('b.koi', false);
    expect(s.getState().chat.changeSet?.files[0]?.accepted).toBe(true); // invalidated: untouched
  });

  test('beginChangeSetApply moves reviewing → applying', () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
    s.getState().beginChangeSetApply();
    expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'applying' });
  });

  test('beginChangeSetApply is a no-op with zero accepted files', () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
    s.getState().setChangeSetFileAccepted('a.koi', false);
    s.getState().beginChangeSetApply();
    expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'reviewing' });
  });

  test('beginChangeSetApply is a no-op outside reviewing and on null', () => {
    const s = createAppStore();
    s.getState().beginChangeSetApply(); // null: must not throw
    expect(s.getState().chat.changeSet).toBeNull();

    s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
    s.getState().beginChangeSetApply();
    s.getState().beginChangeSetApply(); // already applying
    expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'applying' });
    s.getState().resolveChangeSetApply({ failed: [] });
    s.getState().beginChangeSetApply(); // applied is terminal
    expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'applied', appliedCount: 1 });
  });

  test('resolveChangeSetApply with no failures is terminal applied, counting the accepted files', () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'x'), edit('b.koi', 'y'), edit('c.koi', 'z')], {}, null);
    s.getState().setChangeSetFileAccepted('b.koi', false);
    s.getState().beginChangeSetApply();
    s.getState().resolveChangeSetApply({ failed: [] });
    expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'applied', appliedCount: 2 });
  });

  test('resolveChangeSetApply with failures returns to reviewing with a note naming them (no false Applied)', () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'x'), edit('b.koi', 'y')], {}, null);
    s.getState().beginChangeSetApply();
    s.getState().resolveChangeSetApply({ failed: ['a.koi', 'b.koi'] });
    const phase = s.getState().chat.changeSet!.phase;
    expect(phase.kind).toBe('reviewing');
    expect(phase.kind === 'reviewing' && phase.note).toContain('a.koi');
    expect(phase.kind === 'reviewing' && phase.note).toContain('b.koi');
  });

  test('resolveChangeSetApply is a no-op unless applying', () => {
    const s = createAppStore();
    s.getState().resolveChangeSetApply({ failed: [] }); // null: must not throw
    expect(s.getState().chat.changeSet).toBeNull();

    s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
    s.getState().resolveChangeSetApply({ failed: [] }); // still reviewing
    expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'reviewing' });
  });

  test('#633: rejectChangeSetApply releases the in-flight lock back to reviewing with the error note', () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
    s.getState().beginChangeSetApply();
    s.getState().rejectChangeSetApply('workspace write failed');
    expect(s.getState().chat.changeSet?.phase).toEqual({
      kind: 'reviewing',
      note: 'workspace write failed',
    });
    // Retry stays open: the set can be applied again.
    s.getState().beginChangeSetApply();
    expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'applying' });
  });

  test('rejectChangeSetApply is a no-op unless applying', () => {
    const s = createAppStore();
    s.getState().rejectChangeSetApply('boom'); // null: must not throw
    expect(s.getState().chat.changeSet).toBeNull();

    s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
    s.getState().rejectChangeSetApply('boom'); // reviewing
    expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'reviewing' });
  });

  test('#473: invalidateChangeSet moves reviewing → invalidated with the reason', () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
    s.getState().invalidateChangeSet('superseded');
    expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'invalidated', reason: 'superseded' });
  });

  test('invalidateChangeSet also cuts off an in-flight apply', () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
    s.getState().beginChangeSetApply();
    s.getState().invalidateChangeSet('workspace switched');
    expect(s.getState().chat.changeSet?.phase).toEqual({
      kind: 'invalidated',
      reason: 'workspace switched',
    });
  });

  test('invalidateChangeSet is a no-op on applied (the terminal Applied survives) and on null', () => {
    const s = createAppStore();
    s.getState().invalidateChangeSet('nothing there'); // null: must not throw
    expect(s.getState().chat.changeSet).toBeNull();

    s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
    s.getState().beginChangeSetApply();
    s.getState().resolveChangeSetApply({ failed: [] });
    s.getState().invalidateChangeSet('too late');
    expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'applied', appliedCount: 1 });
  });

  test('#684: resolve and reject after invalidation are no-ops (a stale apply must not resurrect the set)', () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
    s.getState().beginChangeSetApply();
    s.getState().invalidateChangeSet('superseded');
    s.getState().resolveChangeSetApply({ failed: [] });
    expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'invalidated', reason: 'superseded' });
    s.getState().rejectChangeSetApply('late failure');
    expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'invalidated', reason: 'superseded' });
  });

  test('markChangeSetDrift is sticky and idempotent, leaving unrelated files untouched', () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'x'), edit('b.koi', 'y')], {}, null);
    s.getState().markChangeSetDrift(['a.koi']);
    expect(s.getState().chat.changeSet?.files.map((f) => f.drifted)).toEqual([true, false]);
    s.getState().markChangeSetDrift(['a.koi']); // idempotent
    expect(s.getState().chat.changeSet?.files.map((f) => f.drifted)).toEqual([true, false]);
    // Sticky across later transitions: a failed apply round-trip never clears the flag.
    s.getState().beginChangeSetApply();
    s.getState().rejectChangeSetApply('apply failed');
    expect(s.getState().chat.changeSet?.files.map((f) => f.drifted)).toEqual([true, false]);
    s.getState().markChangeSetDrift(['b.koi']);
    expect(s.getState().chat.changeSet?.files.map((f) => f.drifted)).toEqual([true, true]);
  });

  test('markChangeSetDrift on a null change set must not throw', () => {
    const s = createAppStore();
    s.getState().markChangeSetDrift(['a.koi']);
    expect(s.getState().chat.changeSet).toBeNull();
  });

  test('discardChangeSet clears to null from any phase', () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
    s.getState().discardChangeSet();
    expect(s.getState().chat.changeSet).toBeNull();
    s.getState().discardChangeSet(); // already null: harmless
    expect(s.getState().chat.changeSet).toBeNull();
  });
});
