// Sample DeckCardSurface data for DeckCard/DeckSpine stories and tests ONLY — never imported by
// src/index.ts, so it never reaches the published `dist/index.js` (tree-shaken out of the library
// build, same as every other `.stories.tsx`/`.test.tsx`). Mirrors the shape (and, for visual fidelity in
// Storybook, the icons/labels/accents) of Koine Studio's real `DECK_SURFACE_LIST` (issue #905, Task 4) —
// that registry itself stays in the app (it's Koine-Studio-specific domain data), so these are
// self-contained equivalents for design-system-side demos.
import type { JSX } from 'preact';
import type { DeckCardSurface } from './DeckCard';

function svg(children: JSX.Element) {
  return (props: { class?: string }) => (
    <svg class={props.class} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={1.7} aria-hidden="true">
      {children}
    </svg>
  );
}

const IconCanvas = svg(
  <>
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="18" cy="8" r="2.4" />
    <circle cx="9" cy="18" r="2.4" />
    <path d="M8 6.6 15.6 7.5M7.6 15.9 8.4 8.4M11.2 17 16 9.8" />
  </>,
);
const IconCode = svg(<path d="M8 7 3 12l5 5M16 7l5 5-5 5M14 4l-4 16" stroke-linecap="round" stroke-linejoin="round" />);
const IconOutput = svg(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 9l3 3-3 3M13.5 15H17" stroke-linecap="round" stroke-linejoin="round" />
  </>,
);
const IconDocs = svg(
  <>
    <path d="M5 4h10a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z" />
    <path d="M9 8h5M9 12h5" />
  </>,
);

/** Sample surfaces standing in for Koine Studio's Canvas/Code/Output/Docs deck, in filmstrip order. */
export const SAMPLE_SURFACES: DeckCardSurface[] = [
  { id: 'visual', label: 'Canvas', tag: 'Domain diagram', accent: 'var(--koi-ddd-aggregate)', icon: IconCanvas, facets: [] },
  {
    id: 'technical',
    label: 'Code',
    tag: 'ubiquitous.koi',
    accent: 'var(--koi-hl-keyword)',
    icon: IconCode,
    facets: [
      { value: 'editor', label: 'Editor' },
      { value: 'scenarios', label: 'Scenarios' },
    ],
  },
  {
    id: 'output',
    label: 'Output',
    tag: 'Compiler artifacts',
    accent: 'var(--koi-ddd-event)',
    icon: IconOutput,
    facets: [
      { value: 'generated', label: 'Generated' },
      { value: 'compatibility', label: 'Compatibility' },
      { value: 'contextmap', label: 'Context Map' },
    ],
  },
  {
    id: 'docs',
    label: 'Docs',
    tag: 'Glossary & ADRs',
    accent: 'var(--koi-ddd-entity)',
    icon: IconDocs,
    facets: [
      { value: 'glossary', label: 'Glossary' },
      { value: 'adr', label: 'Decisions' },
      { value: 'notes', label: 'Notes' },
    ],
  },
];

export const SAMPLE_SURFACES_BY_ID: Record<string, DeckCardSurface> = Object.fromEntries(
  SAMPLE_SURFACES.map((s) => [s.id, s]),
);
