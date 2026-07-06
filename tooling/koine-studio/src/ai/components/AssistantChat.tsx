import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import type { ChangeSetFileState, ChatToolCall } from '@/store/slices/chat';
import { Transcript, type TranscriptNotice, type TurnMechanism } from '@/ai/components/Transcript';
import { ChangeSetPanel, type ChangeSetAttempt } from '@/ai/components/ChangeSetPanel';
import { Composer, type ComposerQuickAction } from '@/ai/components/Composer';

// The assembled assistant view (#990 Task 6): Transcript + ChangeSetPanel + Composer composed inside
// the imperative panel's chrome — the `koi-assistant-transcript` scroller first (with the change-set
// review mounted at its end, so a long per-file diff scrolls with the conversation exactly as the old
// in-bubble island did), then the `koi-assistant-controls` row. The host factory
// (`createAssistantChat` in src/ai/aiPanel.ts) owns everything effectful — the send effect and its
// AbortController, the grammar-constraint/repair loop, the apply-gate, the change-set apply flow —
// and re-renders this component with fresh ephemeral props (notice / stoppedPartial / mechanism /
// changeSetAttempt) as that work progresses; everything durable renders from the store's chat slice.

export interface AssistantChatProps {
  /** The app store carrying the chat slice (#984); tests and stories inject their own createAppStore(). */
  store: StoreApi<AppState>;
  /** "Apply to editor" clicked: the host replaces the active editor document with the candidate. */
  onApplyModel: (source: string) => void;
  /** "Open Settings" clicked (missing/rejected API key notice): the host opens Preferences. */
  onOpenPrefs: () => void;
  /** The host's apply-gate (#444/#561) — see {@link import('./Transcript').TranscriptProps}. */
  getApplyCandidate?: (markdown: string) => Promise<string | null>;
  /** The ephemeral trailing note/error bubble, or null for none. */
  notice?: TranscriptNotice | null;
  /** True when the trailing assistant turn is a Stop-committed partial. */
  stoppedPartial?: boolean;
  /** The trailing turn's grammar-constraint treatment (chip / repair counter / invalid notice). */
  mechanism?: TurnMechanism | null;
  /** The trailing turn's settled tool cards (they outlive the ephemeral chat.turn). */
  settledToolCalls?: readonly ChatToolCall[] | null;
  /** Apply clicked on the change-set review: the host's drift-check + apply flow (#473/#633). */
  onApplyChangeSet: (accepted: readonly ChangeSetFileState[]) => void;
  /** Discard clicked on the change-set review. */
  onDiscardChangeSet: () => void;
  /** The host's per-apply-attempt outcome for the change-set live region / terminal label. */
  changeSetAttempt?: ChangeSetAttempt | null;
  /** Send gesture (Send button or ⌘/Ctrl+Enter) with the current draft. */
  onSend: (draft: string) => void;
  /** Stop clicked while streaming; the host aborts its AbortController. */
  onStop: () => void;
  /** A canned quick action clicked; the host builds its prompt from fresh editor context. */
  onQuickAction: (action: ComposerQuickAction) => void;
  /** "Explain this construct" clicked: the host's explanatory turn (apply suppressed). */
  onExplain: () => void;
  /** "Clear conversation" clicked: the host empties the transcript and drops the stored blob. */
  onClear: () => void;
}

export function AssistantChat(p: AssistantChatProps) {
  return (
    <>
      <Transcript
        store={p.store}
        onApplyModel={p.onApplyModel}
        onOpenPrefs={p.onOpenPrefs}
        getApplyCandidate={p.getApplyCandidate}
        notice={p.notice}
        stoppedPartial={p.stoppedPartial}
        mechanism={p.mechanism}
        settledToolCalls={p.settledToolCalls}
      >
        <ChangeSetPanel
          store={p.store}
          onApply={p.onApplyChangeSet}
          onDiscard={p.onDiscardChangeSet}
          attempt={p.changeSetAttempt}
        />
      </Transcript>
      <Composer
        store={p.store}
        onSend={p.onSend}
        onStop={p.onStop}
        onQuickAction={p.onQuickAction}
        onExplain={p.onExplain}
        onClear={p.onClear}
      />
    </>
  );
}
