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
  act(() => {
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

  test('typing text then Add calls onSubmit with the trimmed text', () => {
    const { textarea, addBtn, onSubmit, onCancel, cleanup } = mount();
    textarea.value = '  needs an invariant  ';
    fireEvent.input(textarea);
    act(() => {
      fireEvent.click(addBtn);
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('needs an invariant');
    expect(onCancel).not.toHaveBeenCalled();
    cleanup();
  });

  test('Add with empty or whitespace-only text adds nothing', () => {
    const { textarea, addBtn, onSubmit, cleanup } = mount();
    act(() => {
      fireEvent.click(addBtn); // empty
    });
    textarea.value = '   ';
    fireEvent.input(textarea);
    act(() => {
      fireEvent.click(addBtn); // whitespace only
    });
    expect(onSubmit).not.toHaveBeenCalled();
    cleanup();
  });

  test('Cancel calls onCancel and never onSubmit', () => {
    const { textarea, cancelBtn, onSubmit, onCancel, cleanup } = mount();
    textarea.value = 'discard me';
    fireEvent.input(textarea);
    act(() => {
      fireEvent.click(cancelBtn);
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    cleanup();
  });

  test('Escape dismisses via onCancel and never submits', () => {
    const { textarea, onSubmit, onCancel, cleanup } = mount();
    textarea.value = 'discard me';
    fireEvent.input(textarea);
    act(() => {
      fireEvent.keyDown(textarea, { key: 'Escape' });
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    cleanup();
  });

  test('Cmd/Ctrl+Enter submits the trimmed text', () => {
    const { textarea, onSubmit, cleanup } = mount();
    textarea.value = 'quick add';
    fireEvent.input(textarea);
    act(() => {
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
