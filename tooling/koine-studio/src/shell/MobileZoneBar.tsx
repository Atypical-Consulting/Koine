import type { StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { AppState } from '@/store/index';
import type { MobileZone } from '@/store/slices/uiChrome';

const ZONES: { zone: MobileZone; label: string }[] = [
  { zone: 'files', label: 'Files' },
  { zone: 'code', label: 'Code' },
  { zone: 'diagram', label: 'Diagram' },
  { zone: 'props', label: 'Props' },
];

// Bottom mode switcher shown only inside the narrow-viewport media query. Subscribes to the
// uiChrome slice's mobileZone for the active tab; clicks call onSelect (ide.tsx routes it to the
// store + the center tab). Imports no controller — mirrors HistoryControls' callback seam.
export function MobileZoneBar(props: { store: StoreApi<AppState>; onSelect: (z: MobileZone) => void }) {
  const active = useStore(props.store, (s) => s.mobileZone);
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const last = ZONES.length - 1;
    let next = i;
    if (e.key === 'ArrowRight') next = i === last ? 0 : i + 1;
    else if (e.key === 'ArrowLeft') next = i === 0 ? last : i - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else return;
    e.preventDefault();
    // Roving tabindex (WAI-ARIA tabs): arrow keys must move DOM focus too — selecting alone would
    // strand focus on the old tab, which the re-render demotes to tabIndex=-1.
    const tablist = (e.currentTarget as HTMLElement).closest('[role="tablist"]');
    tablist?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
    props.onSelect(ZONES[next].zone);
  };
  return (
    <div class="koi-mobile-zonebar" role="tablist" aria-label="Studio zone">
      {ZONES.map((z, i) => (
        <button
          type="button"
          class="koi-mzb-tab"
          role="tab"
          data-zone={z.zone}
          aria-selected={active === z.zone}
          tabIndex={active === z.zone ? 0 : -1}
          onClick={() => props.onSelect(z.zone)}
          onKeyDown={(e) => onKeyDown(e as unknown as KeyboardEvent, i)}
        >
          {z.label}
        </button>
      ))}
    </div>
  );
}
