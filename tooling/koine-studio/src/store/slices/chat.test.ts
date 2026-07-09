import { describe, expect, test, vi } from 'vitest';
import { createAppStore } from '@/store/index';
import type { ChatMessage, ChatToolCall } from '@/ai/ai';
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

  test('clearChatTranscript also retires a pending change set (Clear conversation drops the review)', () => {
    const s = createAppStore();
    s.getState().appendChatMessage(user('a'));
    s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
    s.getState().clearChatTranscript();
    expect(s.getState().chat.messages).toEqual([]);
    // The review belongs to the cleared conversation — a pending set must not outlive its transcript
    // (the retired imperative panel's rebuild dropped it too; the slice is the one owner now).
    expect(s.getState().chat.changeSet).toBeNull();
  });
});

// The composer draft (#990 Task 5): the textarea's text as slice state, so the declarative Composer
// renders it controlled and the host's error-rollback restore (setChatDraft(prompt)) lands
// declaratively. EPHEMERAL — never persisted (persistence only ever saves `messages`).
describe('composer draft', () => {
  test('chat.draft starts empty; setChatDraft sets and clears it', () => {
    const s = createAppStore();
    expect(s.getState().chat.draft).toBe('');
    s.getState().setChatDraft('model a billing domain');
    expect(s.getState().chat.draft).toBe('model a billing domain');
    s.getState().setChatDraft('');
    expect(s.getState().chat.draft).toBe('');
  });

  test('the draft survives the turn lifecycle (start/finish and both abort variants)', () => {
    const s = createAppStore();
    s.getState().setChatDraft('typed but not sent');
    s.getState().startChatTurn();
    expect(s.getState().chat.draft).toBe('typed but not sent');
    s.getState().finishChatTurn();
    expect(s.getState().chat.draft).toBe('typed but not sent');

    s.getState().appendChatMessage(user('sent turn'));
    s.getState().startChatTurn();
    s.getState().abortChatTurn({ rollbackUserTurn: true });
    expect(s.getState().chat.draft).toBe('typed but not sent');

    s.getState().startChatTurn();
    s.getState().abortChatTurn({ rollbackUserTurn: false });
    expect(s.getState().chat.draft).toBe('typed but not sent');
  });

  test('the draft survives hydrateChat and clearChatTranscript (workspace swap keeps unsent text)', () => {
    const s = createAppStore();
    s.getState().setChatDraft('unsent draft');
    s.getState().hydrateChat('ws-1', [user('old')]);
    expect(s.getState().chat.draft).toBe('unsent draft');
    s.getState().clearChatTranscript();
    expect(s.getState().chat.draft).toBe('unsent draft');
  });
});

// The ephemeral streaming turn (#990 Task 4): the live text + tool-call cards the imperative panel
// kept as loose DOM (the streaming bubble, the toolCards Map) as SLICE STATE, so the declarative
// Transcript can render them. Never persisted — persistence only ever saves `messages`.
describe('streaming turn', () => {
  test('chat.turn starts null and startChatTurn seeds an empty streaming turn', () => {
    const s = createAppStore();
    expect(s.getState().chat.turn).toBeNull();
    s.getState().startChatTurn();
    expect(s.getState().chat.turn).toEqual({ text: '', toolCalls: [] });
  });

  test('startChatTurn while streaming does not reset the accumulated turn', () => {
    const s = createAppStore();
    s.getState().startChatTurn();
    s.getState().appendStreamingText('partial');
    s.getState().startChatTurn(); // no-op: must not clobber the live turn
    expect(s.getState().chat.turn).toEqual({ text: 'partial', toolCalls: [] });
  });

  test('appendStreamingText accumulates deltas in order', () => {
    const s = createAppStore();
    s.getState().startChatTurn();
    s.getState().appendStreamingText('Hello');
    s.getState().appendStreamingText(', ');
    s.getState().appendStreamingText('world');
    expect(s.getState().chat.turn?.text).toBe('Hello, world');
  });

  test('appendStreamingText is a no-op when no turn is streaming', () => {
    const s = createAppStore();
    s.getState().appendStreamingText('stray delta'); // idle: must not throw or invent a turn
    expect(s.getState().chat.turn).toBeNull();
    s.getState().startChatTurn();
    s.getState().finishChatTurn();
    s.getState().appendStreamingText('late delta'); // settled: still a no-op
    expect(s.getState().chat.turn).toBeNull();
  });

  test('startToolCall appends a pending call and clears the streamed preamble text', () => {
    const s = createAppStore();
    s.getState().startChatTurn();
    // Text streamed before a tool call is a "thinking" preamble (the imperative addToolCard cleared
    // it so the card and the eventual answer render in chronological order).
    s.getState().appendStreamingText('Let me check that…');
    s.getState().startToolCall({ id: 1, name: 'koine_validate', args: '{"source":"context A {}"}' });
    expect(s.getState().chat.turn).toEqual({
      text: '',
      toolCalls: [
        {
          id: 1,
          name: 'koine_validate',
          args: '{"source":"context A {}"}',
          state: 'pending',
          summary: null,
          result: null,
          durationMs: null,
        },
      ],
    });
  });

  test('completeToolCall settles the SAME entry keyed by id, order preserved', () => {
    const s = createAppStore();
    s.getState().startChatTurn();
    s.getState().startToolCall({ id: 1, name: 'koine_validate', args: '{}' });
    s.getState().startToolCall({ id: 2, name: 'koine_compile', args: '{"target":"csharp"}' });
    s.getState().completeToolCall({ id: 1, state: 'ok', summary: 'valid', result: 'ok: true', durationMs: 312 });

    const calls = s.getState().chat.turn!.toolCalls;
    expect(calls.map((c) => c.id)).toEqual([1, 2]); // order preserved
    expect(calls[0]).toEqual({
      id: 1,
      name: 'koine_validate',
      args: '{}',
      state: 'ok',
      summary: 'valid',
      result: 'ok: true',
      durationMs: 312,
    });
    expect(calls[1].state).toBe('pending'); // the later call is untouched

    // A failed call settles the same way, carrying the error text as its result body.
    s.getState().completeToolCall({ id: 2, state: 'error', summary: 'failed', result: 'boom', durationMs: 45 });
    expect(s.getState().chat.turn!.toolCalls[1]).toEqual({
      id: 2,
      name: 'koine_compile',
      args: '{"target":"csharp"}',
      state: 'error',
      summary: 'failed',
      result: 'boom',
      durationMs: 45,
    });
  });

  test('completeToolCall with an unknown id is a no-op', () => {
    const s = createAppStore();
    s.getState().startChatTurn();
    s.getState().startToolCall({ id: 1, name: 'koine_validate', args: '{}' });
    const before = s.getState().chat.turn;
    s.getState().completeToolCall({ id: 99, state: 'ok', summary: 'x', result: 'x', durationMs: 1 });
    expect(s.getState().chat.turn).toBe(before);
  });

  test('tool-call actions are no-ops when no turn is streaming', () => {
    const s = createAppStore();
    s.getState().startToolCall({ id: 1, name: 'koine_validate', args: '{}' }); // idle: must not throw
    expect(s.getState().chat.turn).toBeNull();
    s.getState().completeToolCall({ id: 1, state: 'ok', summary: 'x', result: 'x', durationMs: 1 });
    expect(s.getState().chat.turn).toBeNull();
  });

  test('finishChatTurn clears the turn', () => {
    const s = createAppStore();
    s.getState().startChatTurn();
    s.getState().appendStreamingText('done soon');
    s.getState().startToolCall({ id: 1, name: 'koine_validate', args: '{}' });
    s.getState().finishChatTurn();
    expect(s.getState().chat.turn).toBeNull();
  });

  test('abortChatTurn clears the turn on both rollback variants', () => {
    const s = createAppStore();
    s.getState().appendChatMessage(user('q'));
    s.getState().startChatTurn();
    s.getState().appendStreamingText('partial');
    s.getState().abortChatTurn({ rollbackUserTurn: true });
    expect(s.getState().chat.turn).toBeNull();

    s.getState().startChatTurn();
    s.getState().appendStreamingText('partial again');
    s.getState().abortChatTurn({ rollbackUserTurn: false });
    expect(s.getState().chat.turn).toBeNull();
  });

});

// commitChatTurn (#1133): the settled tool cards move from the host's ephemeral snapshot closure
// into the chat slice, attached to the committed ChatMessage — so a card the user expanded survives
// the commit remount, and a failed follow-up's rollback (which pops only the trailing USER message)
// leaves the previous assistant message's cards untouched.
describe('commitChatTurn (#1133)', () => {
  const toolCall = (id: number): ChatToolCall => ({
    id,
    name: 'koine_compile',
    args: '{}',
    state: 'ok',
    summary: 'ok',
    result: 'compiled',
    durationMs: 10,
  });

  test('appends the message carrying the live turn toolCalls and clears the turn in ONE dispatch', () => {
    const s = createAppStore();
    s.getState().startChatTurn();
    s.getState().startToolCall({ id: 1, name: 'koine_compile', args: '{}' });
    s.getState().completeToolCall({ id: 1, state: 'ok', summary: 'ok', result: 'compiled', durationMs: 10 });

    const fn = vi.fn();
    s.subscribe((state) => fn(state.chat));
    s.getState().commitChatTurn({ role: 'assistant', content: 'done' });

    // Exactly one notification: a subscriber can never observe the committed message without its
    // cards, nor the cards without the message — the two changes land in the same store transition.
    expect(fn).toHaveBeenCalledTimes(1);
    const chat = fn.mock.calls[0][0];
    expect(chat.messages).toEqual([{ role: 'assistant', content: 'done', toolCalls: [toolCall(1)] }]);
    expect(chat.turn).toBeNull();
  });

  test('a message committed with no tool calls gets no toolCalls field', () => {
    const s = createAppStore();
    s.getState().startChatTurn();
    s.getState().commitChatTurn({ role: 'assistant', content: 'plain reply' });
    expect(s.getState().chat.messages).toEqual([{ role: 'assistant', content: 'plain reply' }]);
    expect('toolCalls' in s.getState().chat.messages[0]).toBe(false);
  });

  test('abortChatTurn({rollbackUserTurn:true}) after a committed tool-call turn pops only the user message', () => {
    const s = createAppStore();
    s.getState().appendChatMessage(user('earlier question'));
    s.getState().startChatTurn();
    s.getState().startToolCall({ id: 1, name: 'koine_compile', args: '{}' });
    s.getState().completeToolCall({ id: 1, state: 'ok', summary: 'ok', result: 'compiled', durationMs: 10 });
    s.getState().commitChatTurn({ role: 'assistant', content: 'earlier reply' });

    // A follow-up send: append the new user turn, then roll it back (simulating a failed request).
    s.getState().appendChatMessage(user('follow-up that fails'));
    s.getState().startChatTurn();
    s.getState().abortChatTurn({ rollbackUserTurn: true });

    expect(s.getState().chat.messages).toEqual([
      user('earlier question'),
      { role: 'assistant', content: 'earlier reply', toolCalls: [toolCall(1)] },
    ]);
  });

  test('commitChatTurn KEEPS the streaming status (#990 Task 6): the busy window stays open for the post-turn repair loop', () => {
    const s = createAppStore();
    s.getState().startChatTurn();
    s.getState().commitChatTurn({ role: 'assistant', content: 'done' });
    expect(s.getState().chat.turn).toBeNull();
    expect(s.getState().chat.status).toBe('streaming');
    // hydrateChat stays a no-op mid-window, same invariant as before commitChatTurn replaced the
    // appendChatMessage + clearStreamingTurn pair.
    s.getState().hydrateChat('elsewhere', []);
    expect(s.getState().chat.workspaceKey).not.toBe('elsewhere');
  });
});

const edit = (relPath: string, body: string, isNew = false): StagedEdit => ({
  key: relPath, // key === relPath for these single-root fixtures (#472)
  relPath,
  body,
  isNew,
});

describe('change-set state machine', () => {
  test('stageChangeSet yields a reviewing set: all accepted, none drifted, before per key', () => {
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
        key: 'billing.koi',
        relPath: 'billing.koi',
        display: 'billing.koi', // no display map → the bare relPath
        body: 'context Billing {}',
        isNew: false,
        before: 'context Old {}',
        accepted: true,
        drifted: false,
      },
      {
        key: 'shipping.koi',
        relPath: 'shipping.koi',
        display: 'shipping.koi',
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
    s.getState().beginChangeSetApply(1);
    expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'applying', cleanCount: 1 });
    s.getState().setChangeSetFileAccepted('a.koi', false);
    expect(s.getState().chat.changeSet?.files[0]?.accepted).toBe(false);
  });

  test('setChangeSetFileAccepted is a no-op once applied or invalidated, and on null', () => {
    const s = createAppStore();
    s.getState().setChangeSetFileAccepted('a.koi', false); // null change set: must not throw
    expect(s.getState().chat.changeSet).toBeNull();

    s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
    s.getState().beginChangeSetApply(1);
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
    s.getState().beginChangeSetApply(1);
    expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'applying', cleanCount: 1 });
  });

  test('beginChangeSetApply is a no-op with zero accepted files', () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
    s.getState().setChangeSetFileAccepted('a.koi', false);
    s.getState().beginChangeSetApply(0);
    expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'reviewing' });
  });

  test('beginChangeSetApply is a no-op outside reviewing and on null', () => {
    const s = createAppStore();
    s.getState().beginChangeSetApply(0); // null: must not throw
    expect(s.getState().chat.changeSet).toBeNull();

    s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
    s.getState().beginChangeSetApply(1);
    s.getState().beginChangeSetApply(1); // already applying
    expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'applying', cleanCount: 1 });
    s.getState().resolveChangeSetApply({ failed: [] });
    s.getState().beginChangeSetApply(1); // applied is terminal
    expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'applied', appliedCount: 1 });
  });

  test('resolveChangeSetApply with no failures is terminal applied, counting the accepted files', () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'x'), edit('b.koi', 'y'), edit('c.koi', 'z')], {}, null);
    s.getState().setChangeSetFileAccepted('b.koi', false);
    s.getState().beginChangeSetApply(2);
    s.getState().resolveChangeSetApply({ failed: [] });
    expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'applied', appliedCount: 2 });
  });

  test('resolveChangeSetApply excludes drift-skipped rows from appliedCount (truthful count)', () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'x'), edit('b.koi', 'y'), edit('c.koi', 'z')], {}, null);
    // The host marks drift BEFORE beginChangeSetApply (#473) and never writes a drifted row — an
    // accepted-but-drifted file was NOT applied, so the terminal count must not include it. The host
    // computes its own fresh clean count (#1225) — here that's b and c, excluding drifted a.
    s.getState().markChangeSetDrift(['a.koi']);
    s.getState().beginChangeSetApply(2);
    s.getState().resolveChangeSetApply({ failed: [] });
    expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'applied', appliedCount: 2 });
  });

  test('resolveChangeSetApply with failures returns to reviewing with a note naming them (no false Applied)', () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'x'), edit('b.koi', 'y')], {}, null);
    s.getState().beginChangeSetApply(2);
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
    s.getState().beginChangeSetApply(1);
    s.getState().rejectChangeSetApply('workspace write failed');
    expect(s.getState().chat.changeSet?.phase).toEqual({
      kind: 'reviewing',
      note: 'workspace write failed',
    });
    // Retry stays open: the set can be applied again.
    s.getState().beginChangeSetApply(1);
    expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'applying', cleanCount: 1 });
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
    s.getState().beginChangeSetApply(1);
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
    s.getState().beginChangeSetApply(1);
    s.getState().resolveChangeSetApply({ failed: [] });
    s.getState().invalidateChangeSet('too late');
    expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'applied', appliedCount: 1 });
  });

  test('#684: resolve and reject after invalidation are no-ops (a stale apply must not resurrect the set)', () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
    s.getState().beginChangeSetApply(1);
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
    s.getState().beginChangeSetApply(1); // b is the only clean (accepted, undrifted) file at this point
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

  // #1225: a file can drift on one Apply attempt (nothing written, but `markChangeSetDrift` sticks
  // `drifted: true` on its row per #473) and then revert to its pre-drift text before the next Apply
  // attempt — at which point the host's fresh `isDrifted()` re-check says it's clean again, but the
  // change set's own stored `drifted` flag is still sticky-true. `beginChangeSetApply` must trust the
  // host's fresh, explicit count for THIS attempt rather than re-deriving a stale one from the sticky
  // flag, or the terminal "Applied N" label contradicts the live-region announcement.
  test("beginChangeSetApply(cleanCount, note) honors the host-supplied count even when the file's stored drifted flag is stale", () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
    s.getState().markChangeSetDrift(['a.koi']); // simulates an earlier all-drifted attempt: sticky drifted: true
    // This attempt's fresh isDrifted() re-check (host-side) found the file clean again — explicit
    // cleanCount of 1, NOT re-derived as 0 from the still-sticky `drifted` flag.
    s.getState().beginChangeSetApply(1, 'Applying 1 clean file.');
    expect(s.getState().chat.changeSet?.phase).toEqual({
      kind: 'applying',
      cleanCount: 1,
      note: 'Applying 1 clean file.',
    });
    s.getState().resolveChangeSetApply({ failed: [], note: 'Applied 1 file.' });
    expect(s.getState().chat.changeSet?.phase).toEqual({
      kind: 'applied',
      appliedCount: 1,
      note: 'Applied 1 file.',
    });
  });

  // #1136: the apply-attempt wording used to ride a host-owned `ChangeSetAttempt` side-channel keyed
  // by `forId`; it now lives entirely in `ChangeSetPhase` so the panel can derive it from the slice
  // alone. #1225: `beginChangeSetApply` no longer re-derives `cleanCount` from the change set's own
  // (sticky) `files[].drifted` flag — it takes the host's already-computed, fresh-per-attempt count
  // verbatim, so a mid-apply checkbox toggle still can't skew the terminal "Applied N" label (the
  // count is fixed the instant `beginChangeSetApply` runs, same guarantee as before).
  test('beginChangeSetApply(cleanCount, note) stores the host-supplied count and note verbatim', () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'x'), edit('b.koi', 'y'), edit('c.koi', 'z')], {}, null);
    s.getState().beginChangeSetApply(2, 'Applying 2 clean files. Skipped 1 that changed since it was proposed.');
    expect(s.getState().chat.changeSet?.phase).toEqual({
      kind: 'applying',
      cleanCount: 2,
      note: 'Applying 2 clean files. Skipped 1 that changed since it was proposed.',
    });
  });

  test('resolveChangeSetApply success reports appliedCount from the begin-time cleanCount snapshot even after a mid-apply toggle, and carries the note', () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'x'), edit('b.koi', 'y')], {}, null);
    s.getState().beginChangeSetApply(2);
    // A checkbox toggled mid-apply must not skew the terminal count — the clean set was already
    // snapshotted at begin time.
    s.getState().setChangeSetFileAccepted('b.koi', false);
    s.getState().resolveChangeSetApply({ failed: [], note: 'Applied 2 files.' });
    expect(s.getState().chat.changeSet?.phase).toEqual({
      kind: 'applied',
      appliedCount: 2,
      note: 'Applied 2 files.',
    });
  });

  test('resolveChangeSetApply failure prefers the passed note over the default "Failed to apply" fallback', () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
    s.getState().beginChangeSetApply(1);
    s.getState().resolveChangeSetApply({
      failed: ['a.koi'],
      note: "Applied 0 files; couldn't write 1: a.koi. Re-apply to retry.",
    });
    expect(s.getState().chat.changeSet?.phase).toEqual({
      kind: 'reviewing',
      note: "Applied 0 files; couldn't write 1: a.koi. Re-apply to retry.",
    });
  });

  test('resolveChangeSetApply failure falls back to "Failed to apply: …" when no note is passed', () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'x'), edit('b.koi', 'y')], {}, null);
    s.getState().beginChangeSetApply(2);
    s.getState().resolveChangeSetApply({ failed: ['a.koi', 'b.koi'] });
    expect(s.getState().chat.changeSet?.phase).toEqual({
      kind: 'reviewing',
      note: 'Failed to apply: a.koi, b.koi',
    });
  });

  describe('noteChangeSetReview (#1136)', () => {
    test('sets the note on a reviewing phase', () => {
      const s = createAppStore();
      s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
      s.getState().noteChangeSetReview('2 files changed since they were proposed; nothing was applied.');
      expect(s.getState().chat.changeSet?.phase).toEqual({
        kind: 'reviewing',
        note: '2 files changed since they were proposed; nothing was applied.',
      });
    });

    test('no-ops outside reviewing (applying, applied) and on a null change set', () => {
      const s = createAppStore();
      s.getState().noteChangeSetReview('x'); // null: must not throw
      expect(s.getState().chat.changeSet).toBeNull();

      s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
      s.getState().beginChangeSetApply(1);
      s.getState().noteChangeSetReview('should not land');
      expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'applying', cleanCount: 1 });

      s.getState().resolveChangeSetApply({ failed: [] });
      s.getState().noteChangeSetReview('should not land either');
      expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'applied', appliedCount: 1 });
    });
  });
});

// A staged change set must not survive a workspace SWITCH — its staged bodies were computed against
// the old workspace's buffers, so applying it into another folder would clobber unrelated files. A
// same-key re-hydrate (the panel re-shown over the same folder) must keep a pending review alive.
describe('hydrateChat × change set (workspace swap)', () => {
  test('a different-key hydrate drops a reviewing change set (and the ephemeral turn)', () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
    s.getState().hydrateChat('other-ws', [user('other history')]);
    expect(s.getState().chat.workspaceKey).toBe('other-ws');
    expect(s.getState().chat.messages).toEqual([user('other history')]);
    expect(s.getState().chat.changeSet).toBeNull();
    expect(s.getState().chat.turn).toBeNull(); // belt-and-braces: already null when not streaming
  });

  test('a same-key hydrate preserves the pending change set (panel re-show must not kill a review)', () => {
    const s = createAppStore();
    s.getState().hydrateChat('ws-1', []);
    s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
    s.getState().hydrateChat('ws-1', [user('restored')]);
    expect(s.getState().chat.messages).toEqual([user('restored')]);
    expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'reviewing' });
  });

  test('a mid-stream hydrate still no-ops ENTIRELY: the change set survives untouched', () => {
    const s = createAppStore();
    s.getState().stageChangeSet([edit('a.koi', 'x')], {}, null);
    s.getState().startChatTurn();
    s.getState().hydrateChat('other-ws', [assistant('stale')]);
    expect(s.getState().chat.workspaceKey).toBe('scratch');
    expect(s.getState().chat.changeSet?.phase).toEqual({ kind: 'reviewing' });
    expect(s.getState().chat.turn).not.toBeNull(); // the live turn is untouched too
  });
});

// #472 Task 4: the rows are keyed by the staged edit's OPAQUE key (buffer uri / new-file key), not by
// relPath — two roots of a multi-root workspace can stage the SAME relPath, and each row must keep its
// own send-time text and answer only its own accept/drift dispatches.
describe('change-set keying by staged-edit key (#472)', () => {
  const wsA = 'file:///wsA/model.koi';
  const wsB = 'file:///wsB/model.koi';
  const colliding: StagedEdit[] = [
    { key: wsA, relPath: 'model.koi', body: 'context A { v2 }', isNew: false },
    { key: wsB, relPath: 'model.koi', body: 'context B { v2 }', isNew: false },
  ];
  const before = { [wsA]: 'context A {}', [wsB]: 'context B {}' };

  test('stageChangeSet keeps BOTH colliding-relPath rows, each with its own KEY-keyed before', () => {
    const s = createAppStore();
    s.getState().stageChangeSet(colliding, before, null);
    const files = s.getState().chat.changeSet!.files;
    expect(files.map((f) => f.key)).toEqual([wsA, wsB]);
    expect(files.map((f) => f.relPath)).toEqual(['model.koi', 'model.koi']);
    expect(files.map((f) => f.before)).toEqual(['context A {}', 'context B {}']);
  });

  test('setChangeSetFileAccepted keys by KEY: toggling one colliding row leaves its twin untouched', () => {
    const s = createAppStore();
    s.getState().stageChangeSet(colliding, before, null);
    s.getState().setChangeSetFileAccepted(wsB, false);
    const files = s.getState().chat.changeSet!.files;
    expect(files.find((f) => f.key === wsB)?.accepted).toBe(false);
    expect(files.find((f) => f.key === wsA)?.accepted).toBe(true);
    s.getState().setChangeSetFileAccepted(wsB, true);
    expect(s.getState().chat.changeSet!.files.every((f) => f.accepted)).toBe(true);
  });

  test('markChangeSetDrift keys by KEY: only the named row is marked', () => {
    const s = createAppStore();
    s.getState().stageChangeSet(colliding, before, null);
    s.getState().markChangeSetDrift([wsA]);
    const files = s.getState().chat.changeSet!.files;
    expect(files.find((f) => f.key === wsA)?.drifted).toBe(true);
    expect(files.find((f) => f.key === wsB)?.drifted).toBe(false);
  });

  // The review label is the TOOL LAYER's disambiguated display path, carried onto the staged row at
  // stage time (single source): re-deriving markers from row order would swap the twins whenever the
  // model staged them in the opposite order to the session index.
  test('stageChangeSet stores each row display from the display map, keyed by KEY', () => {
    const s = createAppStore();
    s.getState().stageChangeSet(colliding, before, null, { [wsA]: 'model.koi@1', [wsB]: 'model.koi@2' });
    expect(s.getState().chat.changeSet!.files.map((f) => f.display)).toEqual(['model.koi@1', 'model.koi@2']);
  });

  test('stageChangeSet display defaults to the relPath: absent map entry, and absent map entirely', () => {
    const s = createAppStore();
    // Only wsB carries a label — wsA falls back to its relPath.
    s.getState().stageChangeSet(colliding, before, null, { [wsB]: 'model.koi@2' });
    expect(s.getState().chat.changeSet!.files.map((f) => f.display)).toEqual(['model.koi', 'model.koi@2']);
    // No map at all (single-root/legacy callers): every display is the bare relPath.
    s.getState().stageChangeSet(colliding, before, null);
    expect(s.getState().chat.changeSet!.files.map((f) => f.display)).toEqual(['model.koi', 'model.koi']);
  });

  test('display is order-independent: staging the twins in reverse order keeps each row its OWN label', () => {
    const s = createAppStore();
    const display = { [wsA]: 'model.koi@1', [wsB]: 'model.koi@2' };
    s.getState().stageChangeSet([colliding[1], colliding[0]], before, null, display);
    const files = s.getState().chat.changeSet!.files;
    expect(files.map((f) => f.key)).toEqual([wsB, wsA]); // row order = stage order
    expect(files.map((f) => f.display)).toEqual(['model.koi@2', 'model.koi@1']); // labels follow the KEY
  });
});
