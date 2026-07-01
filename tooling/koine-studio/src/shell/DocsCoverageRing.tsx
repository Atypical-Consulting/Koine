import type { StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { AppState } from '@/store/index';

// The status-bar glossary-coverage ring (chrome v2, #923): a tiny SVG donut whose arc length is the
// documented fraction, beside a `Docs {documented}/{total}` label. It reads the store's docsCoverage
// mirror (published by the inspector controller from the shared coverage() helper), so it can't drift
// from the glossary. Empty model → an empty track and `Docs 0/0`. The arc is a static stroke-dasharray
// (no animation), so it's inherently reduced-motion safe.
const R = 15; // ring radius in the 0..36 viewBox (matches the handoff proto)
const CIRC = 2 * Math.PI * R;

export interface DocsCoverageRingProps {
  store: StoreApi<AppState>;
}

export function DocsCoverageRing({ store }: DocsCoverageRingProps) {
  const { documented, total } = useStore(store, (s) => s.docsCoverage);
  const pct = total === 0 ? 0 : documented / total;
  // Dash = covered length, gap = the remainder, so the arc fills clockwise from 12 o'clock (the group is
  // rotated -90° below). Round to avoid sub-pixel dasharray churn between renders.
  const dash = Math.round(CIRC * pct * 100) / 100;

  return (
    <span class="sb-seg sb-ring" title={`Glossary coverage — ${documented} of ${total} documented`}>
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <circle cx="18" cy="18" r={R} fill="none" stroke="var(--koi-line)" stroke-width="4" />
        <circle
          cx="18"
          cy="18"
          r={R}
          fill="none"
          stroke="var(--koi-cyan)"
          stroke-width="4"
          stroke-linecap="round"
          stroke-dasharray={`${dash} ${Math.round((CIRC - dash) * 100) / 100}`}
          transform="rotate(-90 18 18)"
        />
      </svg>
      <span class="sb-ring-label">Docs {documented}/{total}</span>
    </span>
  );
}
