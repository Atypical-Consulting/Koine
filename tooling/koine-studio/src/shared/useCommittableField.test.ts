import { describe, expect, test, vi } from 'vitest';
import { act, renderHook } from '@testing-library/preact';
import { useCommittableField } from '@/shared/useCommittableField';

function setup(initial = 'old') {
  const onCommit = vi.fn();
  const utils = renderHook(
    (props: { committedValue: string }) => useCommittableField({ committedValue: props.committedValue, onCommit }),
    { initialProps: { committedValue: initial } },
  );
  return { ...utils, onCommit };
}

describe('useCommittableField', () => {
  test('starts closed, with the committed value as the draft', () => {
    const { result } = setup('A monetary amount.');
    expect(result.current.editing).toBe(false);
    expect(result.current.draft).toBe('A monetary amount.');
  });

  test('openEditor enters edit mode without touching the current draft', () => {
    const { result } = setup('A monetary amount.');
    act(() => result.current.openEditor());
    expect(result.current.editing).toBe(true);
    expect(result.current.draft).toBe('A monetary amount.');
  });

  test('setDraft updates the draft while editing', () => {
    const { result } = setup();
    act(() => result.current.openEditor());
    act(() => result.current.setDraft('in progress'));
    expect(result.current.draft).toBe('in progress');
  });

  test('commit calls onCommit with the (untrimmed) draft, keeps the trimmed text, and exits edit mode', () => {
    const { result, onCommit } = setup();
    act(() => result.current.openEditor());
    act(() => result.current.setDraft('  padded with whitespace  '));
    act(() => result.current.commit());

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('  padded with whitespace  '); // the caller decides how to persist
    expect(result.current.editing).toBe(false);
    expect(result.current.draft).toBe('padded with whitespace'); // read-view display semantics: trimmed
  });

  test('cancel reverts the draft to the value captured on open and exits edit mode without committing', () => {
    const { result, onCommit } = setup('committed');
    act(() => result.current.openEditor());
    act(() => result.current.setDraft('a discarded draft'));
    act(() => result.current.cancel());

    expect(onCommit).not.toHaveBeenCalled();
    expect(result.current.editing).toBe(false);
    expect(result.current.draft).toBe('committed');
  });

  // The NoteRow shape: the committed content arrives asynchronously AFTER the hook mounted (a lazy
  // onReadNote resolve), so openEditor must work from the committedValue current at CALL time — never
  // a value frozen at mount.
  test('openEditor works from the committedValue current at call time, not at mount time', () => {
    const { result, rerender, onCommit } = setup(''); // mounts before the async body has loaded
    rerender({ committedValue: '# Release process\n\nStep one.\n' }); // the load resolves

    expect(result.current.draft).toBe('# Release process\n\nStep one.\n'); // idle draft refreshed

    act(() => result.current.openEditor());
    act(() => result.current.setDraft('junk'));
    act(() => result.current.cancel());
    expect(result.current.draft).toBe('# Release process\n\nStep one.\n'); // reverts to the loaded value
    expect(onCommit).not.toHaveBeenCalled();
  });

  // The GlossaryPanel stale-prop-revert regression (#992 review, `fix(studio): revert glossary
  // edit-cancel to the last committed value`): the committedValue prop only refreshes on a debounced
  // reload, so right after a commit it still holds the PRE-save text. Re-opening the editor and
  // cancelling inside that window must revert to what THIS hook last committed — reading the prop
  // would silently undo the just-completed save.
  test('cancel after a commit reverts to the just-committed value, never the stale committedValue prop', () => {
    const { result, onCommit } = setup('A monetary amount.');

    act(() => result.current.openEditor());
    act(() => result.current.setDraft('A freshly saved amount.'));
    act(() => result.current.commit());
    expect(onCommit).toHaveBeenCalledWith('A freshly saved amount.');
    expect(result.current.draft).toBe('A freshly saved amount.');

    // Re-open while the prop is still stale ('A monetary amount.' — no rerender happened at all).
    act(() => result.current.openEditor());
    expect(result.current.draft).toBe('A freshly saved amount.'); // seeded from the commit, not the prop
    act(() => result.current.setDraft('a discarded second draft'));
    act(() => result.current.cancel());
    expect(result.current.draft).toBe('A freshly saved amount.');
  });

  test('an external committedValue change while EDITING clobbers neither the draft nor the revert target', () => {
    const { result, rerender, onCommit } = setup('open-time value');

    act(() => result.current.openEditor());
    act(() => result.current.setDraft('mid-edit typing'));
    rerender({ committedValue: 'externally changed' }); // arrives mid-edit

    expect(result.current.draft).toBe('mid-edit typing'); // the in-progress edit survives
    act(() => result.current.cancel());
    expect(result.current.draft).toBe('open-time value'); // reverts to the open-time capture, not the prop
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('an external committedValue change while idle refreshes the draft (fresh content, not a clobber)', () => {
    const { result, rerender } = setup('first load');
    rerender({ committedValue: 'second load' });
    expect(result.current.draft).toBe('second load');
    expect(result.current.editing).toBe(false);
  });
});
