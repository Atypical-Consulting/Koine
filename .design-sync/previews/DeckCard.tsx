// OWNED preview for DeckCard (no @ds-preview marker — owned files win over the generated twin).
//
// The generated preview recompiles DeckCard.stories.tsx, whose `frame()`/`mockBody()` helpers and the
// deck-surface `icon: (props) => JSX.Element` fixtures are PREACT JSX (string `style=`, Preact vnodes).
// The converter compiles previews with React's JSX runtime, so those become React elements the real
// (Preact) DeckCard can't consume — the card threw "style prop expects a mapping … not a string" and
// rendered empty. This owned preview mirrors the four stories in React idiom, but builds the surface
// icons with the bundle's own Preact `h` (re-exported by the adapter entry) so they are real Preact
// vnodes the component renders correctly. `children` (the mock body) stays React JSX — the adapter
// bridges React children into the Preact tree. Fixtures mirror src/components/deckFixtures.tsx.
import { DeckCard, h } from '@atypical/koine-ui';

const svgIcon = (children: any) => (props: { class?: string }) =>
  h('svg', { class: props.class, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'aria-hidden': 'true' }, children);

const IconCanvas = svgIcon([
  h('circle', { cx: 6, cy: 6, r: 2.4 }),
  h('circle', { cx: 18, cy: 8, r: 2.4 }),
  h('circle', { cx: 9, cy: 18, r: 2.4 }),
  h('path', { d: 'M8 6.6 15.6 7.5M7.6 15.9 8.4 8.4M11.2 17 16 9.8' }),
]);
const IconCode = svgIcon(h('path', { d: 'M8 7 3 12l5 5M16 7l5 5-5 5M14 4l-4 16', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
const IconOutput = svgIcon([
  h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }),
  h('path', { d: 'M7 9l3 3-3 3M13.5 15H17', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
]);

const SURFACES: Record<string, any> = {
  output: { id: 'output', label: 'Output', tag: 'Compiler artifacts', accent: 'var(--koi-ddd-event)', icon: IconOutput,
    facets: [{ value: 'generated', label: 'Generated' }, { value: 'compatibility', label: 'Compatibility' }, { value: 'contextmap', label: 'Context Map' }] },
  visual: { id: 'visual', label: 'Canvas', tag: 'Domain diagram', accent: 'var(--koi-ddd-aggregate)', icon: IconCanvas, facets: [] },
  technical: { id: 'technical', label: 'Code', tag: 'ubiquitous.koi', accent: 'var(--koi-hl-keyword)', icon: IconCode,
    facets: [{ value: 'editor', label: 'Editor' }, { value: 'scenarios', label: 'Scenarios' }] },
};

const noop = () => {};

// A sized mock body — mirrors the story's mockBody. React children; the adapter bridges them in.
const mockBody = (label: string) => (
  <div style={{ position: 'absolute', inset: 0, width: '600px', height: '300px', padding: '18px 20px', color: 'var(--koi-muted)', fontSize: '13px', lineHeight: 1.6 }}>
    <strong style={{ color: 'var(--koi-fg)' }}>{label}</strong> surface body — real content (editor, diagram,
    compiler output, docs) is hosted here by the consuming app.
  </div>
);

// The framed deck stage the card is absolutely positioned within (mirrors the story's frame()).
const frame = (children: any) => (
  <div className="deck-stage is-focus" style={{ position: 'relative', height: '360px', maxWidth: '680px' }}>{children}</div>
);

/** Solo (1-up): full header with the facet sub-strip; tag shown, close hidden. */
export const WithFacets = () =>
  frame(
    <DeckCard surface={SURFACES.output} activeFacet="generated" inPair={false} isSelected={false}
      onActivate={noop} onSelectFacet={noop} onClose={noop} rootRef={noop}>
      {mockBody('Output')}
    </DeckCard>,
  );

/** Canvas has a single view, so no facet sub-strip renders. */
export const NoFacets = () =>
  frame(
    <DeckCard surface={SURFACES.visual} activeFacet={null} inPair={false} isSelected={false}
      onActivate={noop} onSelectFacet={noop} onClose={noop} rootRef={noop}>
      {mockBody('Canvas')}
    </DeckCard>,
  );

/** The selected pane of a 2-up: accent-tinted header + cap, reachable close button. */
export const InPairSelected = () =>
  frame(
    <DeckCard surface={SURFACES.technical} activeFacet="editor" inPair isSelected
      onActivate={noop} onSelectFacet={noop} onClose={noop}
      rootRef={(el: HTMLElement | null) => el && el.classList.add('in-pair', 'is-selected')}>
      {mockBody('Code')}
    </DeckCard>,
  );

/** The non-selected pane of a 2-up: neutral header, clickable to take the selection. */
export const InPairUnselected = () =>
  frame(
    <DeckCard surface={SURFACES.visual} activeFacet={null} inPair isSelected={false}
      onActivate={noop} onSelectFacet={noop} onClose={noop}
      rootRef={(el: HTMLElement | null) => el && el.classList.add('in-pair')}>
      {mockBody('Canvas')}
    </DeckCard>,
  );
