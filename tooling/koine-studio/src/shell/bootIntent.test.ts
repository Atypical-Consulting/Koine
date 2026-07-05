import { describe, expect, it } from 'vitest';
import { peekStartIntent, setStartIntent, takeStartIntent } from '@/shell/bootIntent';

describe('bootIntent', () => {
  it('peekStartIntent reads the queued intent without consuming it', () => {
    setStartIntent({ kind: 'new' });

    expect(peekStartIntent()).toEqual({ kind: 'new' });
    // Peek did not consume it: take() still sees it.
    expect(takeStartIntent()).toEqual({ kind: 'new' });
    // take() is still read-and-clear: a second call returns null.
    expect(takeStartIntent()).toBeNull();
  });

  it('peekStartIntent returns null when nothing is queued', () => {
    takeStartIntent(); // drain any pending intent from a prior test
    expect(peekStartIntent()).toBeNull();
  });
});
