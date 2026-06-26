// The inline review-comment composer (#479): a compact, non-blocking popover that replaces the Phase-1
// `window.prompt` in ide.tsx's addReviewComment. It is a self-contained Preact widget — a multi-line
// textarea plus Add/Cancel — that reports its result through `onSubmit`/`onCancel` and never touches the
// review store itself (the caller owns that). Add submits the trimmed, non-empty text; Cancel, Escape,
// and an empty/whitespace Add dismiss without adding anything. A Studio-only VIEW concern that never
// round-trips into the `.koi` model. Styling lives in styles.css (.koi-comment-composer*).
import { render } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

export interface CommentComposerOptions {
  /** The element the composer mounts into (ide.tsx appends a positioned host to document.body). */
  parent: HTMLElement;
  /** Called with the trimmed, non-empty comment text when the user confirms (Add or ⌘/Ctrl+Enter). */
  onSubmit: (text: string) => void;
  /** Called when the user dismisses without adding (Cancel, Escape). */
  onCancel: () => void;
}

export interface CommentComposer {
  /** Unmount the composer's Preact tree (the caller removes its host element). */
  dispose(): void;
}

function ComposerView({ onSubmit, onCancel }: { onSubmit: (text: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Focus the textarea on mount so the reviewer can type immediately (the prompt did this for free).
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const submit = (): void => {
    const text = ref.current?.value.trim() ?? '';
    if (!text) return; // empty/whitespace: nothing to add — same guard as the old window.prompt path
    onSubmit(text);
  };

  // Keyboard: Escape cancels; ⌘/Ctrl+Enter submits. A bare Enter inserts a newline (multi-line notes),
  // so submission is explicit via Add or the chord. The handler sits on the container so it catches
  // keys from the textarea and the buttons alike.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div class="koi-comment-composer" onKeyDown={onKeyDown}>
      <textarea
        ref={ref}
        class="koi-comment-composer-input"
        rows={3}
        spellcheck={true}
        aria-label="Add a review comment"
        placeholder="Add a review comment…  (⌘↵ to add · Esc to cancel)"
      />
      <div class="koi-comment-composer-actions">
        <button type="button" class="koi-comment-composer-cancel" onClick={() => onCancel()}>
          Cancel
        </button>
        <button type="button" class="koi-comment-composer-add" onClick={() => submit()}>
          Add
        </button>
      </div>
    </div>
  );
}

/**
 * Mount an inline comment composer inside `parent`. Returns a handle whose `dispose()` unmounts the
 * Preact tree. The composer reports the user's intent through `onSubmit` (trimmed, non-empty text) and
 * `onCancel`; it owns no review state of its own.
 */
export function createCommentComposer(opts: CommentComposerOptions): CommentComposer {
  render(<ComposerView onSubmit={opts.onSubmit} onCancel={opts.onCancel} />, opts.parent);
  return {
    dispose() {
      render(null, opts.parent);
    },
  };
}
