import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import { createCommentComposer, type CommentComposer } from '@/review/CommentComposer';

// Mount the composer into a detached host (as ide.tsx does), driving it through testing-library. The
// composer is a self-contained popover: a multi-line textarea + Add/Cancel, Add submits the trimmed
// non-empty text, Cancel and Escape dismiss without ever submitting (#479).
function mount(onSubmit = vi.fn(), onCancel = vi.fn()) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  let composer!: CommentComposer;
  // `mount` is a synchronous helper shared by every test below; `act`'s own docs guarantee a
  // synchronous callback is fully flushed before `act` returns, so the composer is already mounted
  // by the time we query for it a few lines down regardless of whether we await the call here —
  // `void` keeps this helper synchronous rather than forcing every call site to become async.
  void act(() => {
    composer = createCommentComposer({ parent, onSubmit, onCancel });
  });
  const textarea = parent.querySelector<HTMLTextAreaElement>('.koi-comment-composer-input')!;
  const addBtn = parent.querySelector<HTMLButtonElement>('.koi-comment-composer-add')!;
  const cancelBtn = parent.querySelector<HTMLButtonElement>('.koi-comment-composer-cancel')!;
  return {
    parent,
    composer,
    onSubmit,
    onCancel,
    textarea,
    addBtn,
    cancelBtn,
    cleanup: () => {
      composer.dispose();
      parent.remove();
    },
  };
}

describe('CommentComposer (#479)', () => {
  test('renders a multi-line textarea and Add/Cancel controls with an accessible label', () => {
    const { textarea, addBtn, cancelBtn, cleanup } = mount();
    expect(textarea).not.toBeNull();
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea.getAttribute('aria-label')).toBeTruthy();
    expect(addBtn.textContent).toBe('Add');
    expect(cancelBtn.textContent).toBe('Cancel');
    cleanup();
  });

  test('typing text then Add calls onSubmit with the trimmed text', async () => {
    const { textarea, addBtn, onSubmit, onCancel, cleanup } = mount();
    textarea.value = '  needs an invariant  ';
    fireEvent.input(textarea);
    await act(() => {
      fireEvent.click(addBtn);
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('needs an invariant');
    expect(onCancel).not.toHaveBeenCalled();
    cleanup();
  });

  test('Add with empty or whitespace-only text adds nothing', async () => {
    const { textarea, addBtn, onSubmit, cleanup } = mount();
    await act(() => {
      fireEvent.click(addBtn); // empty
    });
    textarea.value = '   ';
    fireEvent.input(textarea);
    await act(() => {
      fireEvent.click(addBtn); // whitespace only
    });
    expect(onSubmit).not.toHaveBeenCalled();
    cleanup();
  });

  test('Cancel calls onCancel and never onSubmit', async () => {
    const { textarea, cancelBtn, onSubmit, onCancel, cleanup } = mount();
    textarea.value = 'discard me';
    fireEvent.input(textarea);
    await act(() => {
      fireEvent.click(cancelBtn);
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    cleanup();
  });

  test('Escape dismisses via onCancel and never submits', async () => {
    const { textarea, onSubmit, onCancel, cleanup } = mount();
    textarea.value = 'discard me';
    fireEvent.input(textarea);
    await act(() => {
      fireEvent.keyDown(textarea, { key: 'Escape' });
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    cleanup();
  });

  test('Cmd/Ctrl+Enter submits the trimmed text', async () => {
    const { textarea, onSubmit, cleanup } = mount();
    textarea.value = 'quick add';
    fireEvent.input(textarea);
    await act(() => {
      fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    });
    expect(onSubmit).toHaveBeenCalledWith('quick add');
    cleanup();
  });

  test('has no accessibility violations', async () => {
    const { parent, cleanup } = mount();
    expect(await axe(parent)).toHaveNoViolations();
    cleanup();
  });
});
