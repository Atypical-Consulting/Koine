import type { StoreApi } from 'zustand/vanilla';
import { useAppStore } from '@/store/hooks';
import type { AppState } from '@/store/index';
import type { ChangeSetFileState } from '@/store/slices/chat';

// The assistant's change-set review as a declarative Preact panel (#990 Task 3). This replaces the
// imperative `renderChangeSet` island in aiPanel.ts (retired by Task 6) while reproducing its exact
// DOM contract: the `koi-changeset*` classes, the labelled role="group", the polite role="status"
// live region, per-file rows (accept checkbox / new-modified badge / relPath / inline line-diff),
// sticky drift warnings (#473), the staged-workspace diagnostics block (#474), the reviewing-note
// retry shape (#633), and the two terminal treatments ("Applied ✓", superseded). Rows are keyed —
// state and gestures alike — by the staged edit's opaque session key (#472), with a relPath shared
// across roots displayed disambiguated (`relPath@1`, `relPath@2`, … in row order, the tool layer's
// marker scheme).
//
// It is a PURE consumer of the chat slice's change-set state machine (#984): every control state —
// Apply label + disabled, checkbox checked/disabled, the live-region text, the superseded class —
// derives from `chat.changeSet` alone (no local state, no async). Gestures either dispatch a slice
// action directly (the accept checkboxes → `setChangeSetFileAccepted`) or delegate to the host
// callbacks (Apply/Discard), because the async apply against the workspace — drift detection,
// `beginChangeSetApply`, the write, `resolveChangeSetApply`/`rejectChangeSetApply` — belongs to the
// host (Task 6), never to this component.

/**
 * The host's per-apply-attempt outcome (#473/#633), which the slice's phase deliberately doesn't
 * carry: the live-region wording counts the files actually WRITTEN this attempt (the clean subset,
 * minus drift skips — `phase.appliedCount` counts the accepted files at settle time instead), and the
 * drift/partial/reject messages name the exact skips/failures. Keyed by the set id so a stale attempt
 * from a replaced set is ignored without the host having to clear it.
 */
export interface ChangeSetAttempt {
  /** The id of the set this attempt belongs to; ignored unless it matches the rendered set. */
  readonly forId: number;
  /** The live-region message for this attempt, or null to fall back to the phase wording. */
  readonly note: string | null;
  /** The clean-count actually written, overriding `phase.appliedCount` in the terminal label. */
  readonly appliedCount: number | null;
}

export interface ChangeSetPanelProps {
  /** The app store carrying the chat slice (#984); tests and stories inject their own createAppStore(). */
  store: StoreApi<AppState>;
  /**
   * Apply clicked while reviewing: the host runs the async drift-check + apply (#473/#633) and settles
   * the slice phase. Receives the files accepted at click time (the subset the user left checked).
   */
  onApply: (accepted: readonly ChangeSetFileState[]) => void;
  /** Discard clicked: the host dispatches `discardChangeSet` plus any teardown it owns. */
  onDiscard: () => void;
  /** The host's per-attempt outcome for the CURRENT set, or null/absent for the phase-derived wording. */
  attempt?: ChangeSetAttempt | null;
}

/**
 * A minimal line-level diff for the change-set preview: an LCS walk marks lines only in the new body
 * with `+`, lines only in the old with `-`, and shared lines with a leading space. Presentation only.
 * Moved here from the imperative panel when #990 Task 6 retired its island.
 */
function lineDiff(oldText: string, newText: string): string {
  const a = oldText.length ? oldText.split('\n') : [];
  const b = newText.length ? newText.split('\n') : [];
  const m = a.length;
  const n = b.length;
  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`- ${a[i]}`);
      i++;
    } else {
      out.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < m) out.push(`- ${a[i++]}`);
  while (j < n) out.push(`+ ${b[j++]}`);
  return out.join('\n');
}

/** Pluralize the panel's file counts exactly as the imperative panel did. */
const files = (n: number): string => `file${n === 1 ? '' : 's'}`;

/**
 * Per-row display labels, in row order (#472): a relPath held by exactly one row displays as itself;
 * rows sharing a relPath (the same path under two roots of a multi-root workspace) are disambiguated
 * with the tool layer's marker scheme — `relPath@1`, `relPath@2`, … in row order — so the label the
 * user reviews matches the one the model addressed through the edit tools.
 */
function displayLabels(rows: readonly ChangeSetFileState[]): string[] {
  const counts = new Map<string, number>();
  for (const f of rows) counts.set(f.relPath, (counts.get(f.relPath) ?? 0) + 1);
  const seen = new Map<string, number>();
  return rows.map((f) => {
    if ((counts.get(f.relPath) ?? 0) < 2) return f.relPath;
    const n = (seen.get(f.relPath) ?? 0) + 1;
    seen.set(f.relPath, n);
    return `${f.relPath}@${n}`;
  });
}

export function ChangeSetPanel({ store, onApply, onDiscard, attempt }: ChangeSetPanelProps) {
  const changeSet = useAppStore(store, (s) => s.chat.changeSet);
  if (!changeSet) return null;

  const { phase, diagnostics } = changeSet;
  // Honor the host's per-attempt outcome only for the set it was made against — a stale attempt from
  // a replaced set must not word the fresh review.
  const at = attempt && attempt.forId === changeSet.id ? attempt : null;
  // Terminal phases lock the review: a checkbox toggle after "Applied ✓" must not re-enable Apply and
  // let the same change set be written to disk a second time; a superseded set can never be applied.
  const terminal = phase.kind === 'applied' || phase.kind === 'invalidated';
  const accepted = changeSet.files.filter((f) => f.accepted);
  const n = accepted.length;
  // Row-order display labels, disambiguating a relPath shared across roots (#472).
  const labels = displayLabels(changeSet.files);

  // The terminal label counts the files actually WRITTEN this attempt (drift skips excluded) when the
  // host reported it, falling back to the slice's accepted-at-settle count.
  const appliedN = phase.kind === 'applied' ? (at?.appliedCount ?? phase.appliedCount) : 0;
  const applyLabel = phase.kind === 'applied' ? `Applied ${appliedN} ${files(appliedN)} ✓` : `Apply ${n} ${files(n)}`;
  // Reviewing: openable whenever at least one file is accepted (a reviewing note — an apply failure,
  // #633 — leaves Apply RE-ENABLED for retry). Applying keeps the in-flight lock; terminal stays shut.
  const applyDisabled = phase.kind !== 'reviewing' || n === 0;

  // The polite live region (WCAG 2.1 AA 4.1.3). The superseded notice always wins (#684: a late apply
  // settle on a retired set must not overwrite it); otherwise the host's per-attempt wording (drift
  // skips, partial failures, the clean-count "Applied N.") takes precedence over the phase-derived
  // fallbacks — the apply-failure note while reviewing (#633) and the settled count once applied.
  const statusText =
    phase.kind === 'invalidated'
      ? `This change set was ${phase.reason} by a newer turn and can no longer be applied.`
      : (at?.note ??
        (phase.kind === 'reviewing'
          ? (phase.note ?? '')
          : phase.kind === 'applied'
            ? `Applied ${appliedN} ${files(appliedN)}.`
            : ''));

  return (
    <div
      class={`koi-changeset${phase.kind === 'invalidated' ? ' koi-changeset-superseded' : ''}`}
      // A labelled group so assistive tech announces the scope of the review (WCAG 2.1 AA 1.3.1 / 4.1.2).
      role="group"
      aria-label={`${changeSet.files.length} proposed file change${changeSet.files.length === 1 ? '' : 's'}`}
    >
      {changeSet.files.map((f, i) => (
        // Rows key by the staged edit's opaque session key (#472): unique even when two roots of a
        // multi-root workspace stage the SAME relPath, so a toggle can never hit the wrong root.
        <div class="koi-changeset-file" key={f.key}>
          <input
            type="checkbox"
            class="koi-changeset-accept"
            checked={f.accepted}
            disabled={terminal}
            aria-label={`Accept changes to ${labels[i]}`}
            onChange={(e) => store.getState().setChangeSetFileAccepted(f.key, e.currentTarget.checked)}
          />
          <span class={`koi-changeset-badge ${f.isNew ? 'koi-changeset-badge-new' : 'koi-changeset-badge-modified'}`}>
            {f.isNew ? 'new' : 'modified'}
          </span>
          <span class="koi-changeset-path">{labels[i]}</span>
          <pre class="koi-changeset-diff">{lineDiff(f.before, f.body)}</pre>
          {f.drifted && (
            // Sticky per-file drift (#473): the file changed since it was proposed, so apply skips it.
            <span class="koi-changeset-drift">Changed since this was proposed — skipped to protect your edits.</span>
          )}
        </div>
      ))}
      {/* End-of-turn whole-staged-workspace validation (#474): anything other than a CLEAN compile
          (`ok: true …`) — errors, warnings, or a "could not validate" note — is reviewable BEFORE apply. */}
      {diagnostics != null && !diagnostics.startsWith('ok: true') && (
        <pre class="koi-changeset-diagnostics" aria-label="Validation diagnostics for the staged changes">
          {diagnostics}
        </pre>
      )}
      <button type="button" class="koi-changeset-apply" disabled={applyDisabled} onClick={() => onApply(accepted)}>
        {applyLabel}
      </button>
      {/* Applied is terminal: the set is on disk, so there is nothing left to discard. */}
      {phase.kind !== 'applied' && (
        <button type="button" class="koi-changeset-discard" onClick={() => onDiscard()}>
          Discard
        </button>
      )}
      <div class="koi-changeset-status" role="status" aria-live="polite">
        {statusText}
      </div>
    </div>
  );
}
