import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import { DeckCard } from './DeckCard';
import { SAMPLE_SURFACES_BY_ID } from './deckFixtures';

const base = {
  surface: SAMPLE_SURFACES_BY_ID.output,
  activeFacet: 'generated' as string | null,
  inPair: false,
  isSelected: false,
  onActivate: () => {},
  onSelectFacet: () => {},
  onClose: () => {},
  rootRef: () => {},
};

describe('DeckCard', () => {
  test('renders the surface facets and marks the active one', () => {
    const { container } = render(<DeckCard {...base}>body</DeckCard>);
    const subs = container.querySelectorAll('.deck-sub');
    expect(subs).toHaveLength(3); // Generated / Compatibility / Context Map
    const on = container.querySelector('.deck-sub.on');
    expect(on?.textContent).toBe('Generated');
    expect(on?.getAttribute('aria-pressed')).toBe('true');
  });

  test('a surface with a single view shows no facet strip', () => {
    const { container } = render(
      <DeckCard {...base} surface={SAMPLE_SURFACES_BY_ID.visual} activeFacet={null}>
        body
      </DeckCard>,
    );
    expect(container.querySelector('.deck-subs')).toBeNull();
  });

  test('facet click routes to onSelectFacet and does not bubble to onActivate', () => {
    const onSelectFacet = vi.fn();
    const onActivate = vi.fn();
    const { container } = render(
      <DeckCard {...base} onSelectFacet={onSelectFacet} onActivate={onActivate}>
        body
      </DeckCard>,
    );
    const compat = Array.from(container.querySelectorAll('.deck-sub')).find((b) => b.textContent === 'Compatibility')!;
    fireEvent.click(compat);
    expect(onSelectFacet).toHaveBeenCalledWith('compatibility');
    expect(onActivate).not.toHaveBeenCalled();
  });

  test('clicking the card body activates it (select-pane / focus routing lives in the parent)', () => {
    const onActivate = vi.fn();
    const { container } = render(
      <DeckCard {...base} onActivate={onActivate}>
        <div data-testid="body">body</div>
      </DeckCard>,
    );
    fireEvent.click(container.querySelector('.deck-body')!);
    expect(onActivate).toHaveBeenCalled();
  });

  test('close button is reachable in a pair and routes to onClose', () => {
    const onClose = vi.fn();
    const { container } = render(
      <DeckCard {...base} inPair onClose={onClose}>
        body
      </DeckCard>,
    );
    const close = container.querySelector('.hbtn.close') as HTMLButtonElement;
    expect(close.tabIndex).toBe(0);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalled();
  });

  test('host element is re-parented into the body (no mock children rendered)', () => {
    const host = document.createElement('section');
    host.id = 'fake-host';
    host.hidden = true;
    const { container } = render(
      <DeckCard {...base} hostEl={host}>
        should-not-render
      </DeckCard>,
    );
    const body = container.querySelector('.deck-body')!;
    expect(body.querySelector('#fake-host')).toBe(host);
    expect(host.hidden).toBe(false);
    expect(body.textContent).not.toContain('should-not-render');
  });

  test('has no accessibility violations', async () => {
    const { container } = render(
      <DeckCard {...base} inPair isSelected>
        body
      </DeckCard>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
