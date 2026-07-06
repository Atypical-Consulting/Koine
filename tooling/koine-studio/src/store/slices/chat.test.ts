import { describe, expect, test } from 'vitest';
import { createAppStore } from '@/store/index';
import type { ChatMessage } from '@/ai/ai';

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
