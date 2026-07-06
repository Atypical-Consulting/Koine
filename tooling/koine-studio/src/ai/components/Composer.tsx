import type { StoreApi } from 'zustand/vanilla';
import { useAppStore } from '@/store/hooks';
import type { AppState } from '@/store/index';

// The assistant's input row + quick actions as a declarative Preact component (#990 Task 5). It
// replaces the imperative panel's controls half (the quick/action buttons, the textarea, the
// Send/Stop pair and `setBusy` in aiPanel.ts, retired by Task 6) while reproducing its exact DOM
// contract: the `koi-assistant-controls` / `koi-assistant-quick` / `koi-assistant-inputrow`
// containers, the `koi-assistant-input` textarea (aria-label "Assistant prompt", ⌘/Ctrl+Enter to
// send), the `koi-assistant-send` / `koi-assistant-stop` busy swap, the `koi-assistant-action`
// quick actions and the `koi-assistant-clear` button.
//
// It is a PURE consumer of the chat slice: the textarea renders CONTROLLED over `chat.draft`
// (every keystroke dispatches `setChatDraft`, so the host's error-rollback restore is a plain
// dispatch that renders declaratively), and the busy treatment — Send↔Stop, everything disabled —
// derives from `chat.status === 'streaming'`. Every gesture delegates to a host callback: the send
// effect (guards, clearing the draft on a started turn, the AbortController behind Stop), the
// quick-action prompt building (which needs fresh editor context), the explanatory turn, and the
// transcript clear all belong to the host (Task 6), never to this component. All controls are
// refused while busy, belt-and-braces past their disabled attributes, exactly like the imperative
// panel's `if (busy()) return` guards.

/**
 * The four canned quick actions, by identity. The Composer owns their LABELS (the DOM contract);
 * the host maps the identity to its prompt builder, which needs the fresh editor context.
 */
export type ComposerQuickAction =
  | 'explain-diagnostics'
  | 'suggest-invariants'
  | 'review-model'
  | 'add-aggregate';

/** Label ↔ identity for the canned quick actions, in the imperative panel's button order. */
const QUICK_ACTIONS: readonly { id: ComposerQuickAction; label: string }[] = [
  { id: 'explain-diagnostics', label: 'Explain diagnostics' },
  { id: 'suggest-invariants', label: 'Suggest invariants' },
  { id: 'review-model', label: 'Review model' },
  { id: 'add-aggregate', label: 'Add an aggregate' },
];

export interface ComposerProps {
  /** The app store carrying the chat slice (#984); tests and stories inject their own createAppStore(). */
  store: StoreApi<AppState>;
  /**
   * Send gesture (the Send button or ⌘/Ctrl+Enter) with the CURRENT draft. The host owns the send
   * effect: the empty-prompt and API-key guards, clearing the draft once the turn actually starts,
   * and restoring it (`setChatDraft(prompt)`) on an error rollback — matching the imperative
   * panel's fromInput-only restore, since quick-action turns never came from the draft.
   */
  onSend: (draft: string) => void;
  /** Stop clicked while streaming; the host aborts its AbortController (it never lives here). */
  onStop: () => void;
  /** A canned quick action clicked; the host builds its prompt from fresh editor context. */
  onQuickAction: (action: ComposerQuickAction) => void;
  /** "Explain this construct" clicked: the host's explanatory turn (selection-or-model, apply suppressed). */
  onExplain: () => void;
  /** "Clear conversation" clicked: the host empties the transcript and drops the stored blob. */
  onClear: () => void;
}

export function Composer({ store, onSend, onStop, onQuickAction, onExplain, onClear }: ComposerProps) {
  const draft = useAppStore(store, (s) => s.chat.draft);
  const busy = useAppStore(store, (s) => s.chat.status) === 'streaming';

  return (
    <div class="koi-assistant-controls">
      <div class="koi-assistant-quick">
        {QUICK_ACTIONS.map((a) => (
          <button
            key={a.id}
            type="button"
            class="koi-assistant-action"
            disabled={busy}
            onClick={() => {
              if (!busy) onQuickAction(a.id);
            }}
          >
            {a.label}
          </button>
        ))}
        <button
          type="button"
          class="koi-assistant-action"
          disabled={busy}
          onClick={() => {
            if (!busy) onExplain();
          }}
        >
          Explain this construct
        </button>
        {/* Refused while busy so a clear can't race the streaming reply (which would re-persist
            the half-finished turn after the clear). */}
        <button
          type="button"
          class="koi-assistant-clear"
          disabled={busy}
          onClick={() => {
            if (!busy) onClear();
          }}
        >
          Clear conversation
        </button>
      </div>
      <div class="koi-assistant-inputrow">
        <textarea
          class="koi-assistant-input"
          rows={3}
          placeholder="Describe a domain to model, or ask about this one…  (⌘/Ctrl+Enter to send)"
          aria-label="Assistant prompt"
          value={draft}
          disabled={busy}
          onInput={(e) => store.getState().setChatDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              if (!busy) onSend(draft);
            }
          }}
        />
        <button
          type="button"
          class="koi-assistant-send"
          disabled={busy}
          onClick={() => {
            if (!busy) onSend(draft);
          }}
        >
          Send
        </button>
        <button type="button" class="koi-assistant-stop" hidden={!busy} onClick={() => onStop()}>
          Stop
        </button>
      </div>
    </div>
  );
}
