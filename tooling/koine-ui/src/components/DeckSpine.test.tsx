import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import { DeckSpine } from './DeckSpine';
import { SAMPLE_SURFACES } from './deckFixtures';

const noop = {
  activeFacet: () => null,
  onOverview: () => {},
  onFocus: () => {},
  onOpenBeside: () => {},
  onSelectFacet: () => {},
  onClose: () => {},
  onSwap: () => {},
  onSelectPane: () => {},
};

const base = { flipped: false, ratio: 0.5, surfaces: SAMPLE_SURFACES } as const;

describe('DeckSpine', () => {
  test('1-up: the focused tab is active and carries no ⊞; the other three reveal one', () => {
    const { container } = render(<DeckSpine mode="focus" primary="visual" secondary={null} {...base} {...noop} />);
    expect(container.querySelectorAll('.fx-tab')).toHaveLength(4);
    expect(container.querySelectorAll('.fx-tab.on')).toHaveLength(1);
    // Canvas is focused → no ⊞ on it; the other three surfaces each carry an "open beside".
    expect(container.querySelectorAll('.fx-beside')).toHaveLength(3);
  });

  test('1-up: the focused surface with facets shows its inline facet strip', () => {
    const { container } = render(
      <DeckSpine mode="focus" primary="technical" secondary={null} {...base} {...noop} activeFacet={() => 'editor'} />,
    );
    const facets = container.querySelectorAll('.fx-facet');
    expect(facets).toHaveLength(2); // Editor / Scenarios
    expect(container.querySelectorAll('.fx-facet.on')).toHaveLength(1);
  });

  test('clicking a tab focuses that surface; clicking ⊞ opens it beside', () => {
    const onFocus = vi.fn();
    const onOpenBeside = vi.fn();
    const { container } = render(
      <DeckSpine mode="focus" primary="visual" secondary={null} {...base} {...noop} onFocus={onFocus} onOpenBeside={onOpenBeside} />,
    );
    fireEvent.click(container.querySelectorAll('.fx-tab')[1] as HTMLButtonElement); // Code
    expect(onFocus).toHaveBeenCalledWith('technical');
    fireEvent.click(container.querySelectorAll('.fx-beside')[0] as HTMLButtonElement);
    expect(onOpenBeside).toHaveBeenCalled();
  });

  test('overview: the toggle is active and there is no facet strip or ⊞', () => {
    const onOverview = vi.fn();
    const { container } = render(
      <DeckSpine mode="overview" primary="visual" secondary="technical" {...base} {...noop} onOverview={onOverview} />,
    );
    const over = container.querySelector('.fx-act') as HTMLButtonElement;
    expect(over.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelectorAll('.fx-facet')).toHaveLength(0);
    expect(container.querySelectorAll('.fx-beside')).toHaveLength(0);
    fireEvent.click(over);
    expect(onOverview).toHaveBeenCalled();
  });

  test('2-up: two pane-headers, a docked swap, and a compact Overview at the end', () => {
    const onSwap = vi.fn();
    const onClose = vi.fn();
    const onSelectPane = vi.fn();
    const { container } = render(
      <DeckSpine
        mode="focus"
        primary="technical"
        secondary="visual"
        {...base}
        {...noop}
        onSwap={onSwap}
        onClose={onClose}
        onSelectPane={onSelectPane}
      />,
    );
    expect(container.querySelectorAll('.fx-half')).toHaveLength(2);
    const swap = container.querySelector('.fx-swap') as HTMLButtonElement;
    fireEvent.click(swap);
    expect(onSwap).toHaveBeenCalled();
    // The primary (technical) is the selected pane.
    expect(container.querySelectorAll('.fx-half.sel')).toHaveLength(1);
    // Closing a pane routes its id.
    fireEvent.click(container.querySelectorAll('.fx-hclose')[0] as HTMLButtonElement);
    expect(onClose).toHaveBeenCalled();
    // A compact Overview affordance is present (icon-only, `.mini`).
    expect(container.querySelector('.fx-act.mini')).not.toBeNull();
  });

  test('clicking the non-selected pane selects it (without moving cards)', () => {
    const onSelectPane = vi.fn();
    const { container } = render(
      <DeckSpine mode="focus" primary="technical" secondary="visual" {...base} {...noop} onSelectPane={onSelectPane} />,
    );
    // The non-selected half is the one that is NOT `.sel`.
    const other = container.querySelector('.fx-half:not(.sel)') as HTMLElement;
    fireEvent.click(other);
    expect(onSelectPane).toHaveBeenCalledWith('visual');
  });

  test('has no accessibility violations', async () => {
    const { container } = render(
      <DeckSpine mode="focus" primary="technical" secondary="visual" {...base} {...noop} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
