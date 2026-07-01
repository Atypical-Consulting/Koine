import type { StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { AppState } from '@/store/index';
import { EMIT_TARGETS } from '@/shared/emitTargets';

// The status-bar emit echo (chrome v2, #923): a passive mirror of the top-bar emit selector's value —
// a language dot + `Emit: {language}`. It reads the SAME store field the selector commits to, so the two
// can never disagree; it is a readout, not a control (the #756 single-home contract: the selector owns
// the action, the echo just reflects the persistent state).
export interface EmitEchoProps {
  store: StoreApi<AppState>;
}

export function EmitEcho({ store }: EmitEchoProps) {
  const target = useStore(store, (s) => s.emitTarget);
  const label = EMIT_TARGETS.find((t) => t.id === target)?.displayName ?? target;
  return (
    <>
      <span class="lang-dot" data-lang={target} aria-hidden="true" />
      <span class="sb-emit-label">Emit: {label}</span>
    </>
  );
}
