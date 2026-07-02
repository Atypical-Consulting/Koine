import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import { DeckBar } from './DeckBar';
import { SAMPLE_SURFACES } from './deckFixtures';

const noop = { onOverview: () => {}, onFocus: () => {}, onOpenBeside: () => {} };

describe('DeckBar', () => {
  test('marks the shown surfaces (primary + secondary) as pressed', () => {
    const { container } = render(
      <DeckBar mode="focus" primary="technical" secondary="visual" surfaces={SAMPLE_SURFACES} {...noop} />,
    );
    const chips = container.querySelectorAll('.deck-chip');
    const pressed = Array.from(chips).filter((c) => c.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(2); // Code + Canvas
  });

  test('"open beside" appears only for surfaces not currently shown, in focus mode', () => {
    const { container } = render(
      <DeckBar mode="focus" primary="technical" secondary="visual" surfaces={SAMPLE_SURFACES} {...noop} />,
    );
    // Code + Canvas are shown → 2 chips, so only Output + Docs carry the ⊞.
    expect(container.querySelectorAll('.deck-cmp')).toHaveLength(2);
  });

  test('no "open beside" in overview', () => {
    const { container } = render(
      <DeckBar mode="overview" primary="visual" secondary="technical" surfaces={SAMPLE_SURFACES} {...noop} />,
    );
    expect(container.querySelectorAll('.deck-cmp')).toHaveLength(0);
  });

  test('clicking a chip focuses that surface; clicking ⊞ opens it beside', () => {
    const onFocus = vi.fn();
    const onOpenBeside = vi.fn();
    const { container } = render(
      <DeckBar
        mode="focus"
        primary="visual"
        secondary={null}
        surfaces={SAMPLE_SURFACES}
        onOverview={() => {}}
        onFocus={onFocus}
        onOpenBeside={onOpenBeside}
      />,
    );
    // The Code chip (second in order) — focus it.
    const codeChip = container.querySelectorAll('.deck-chip')[1] as HTMLButtonElement;
    fireEvent.click(codeChip);
    expect(onFocus).toHaveBeenCalledWith('technical');
    // Its ⊞ opens beside.
    const codeCmp = container.querySelectorAll('.deck-cmp')[0] as HTMLButtonElement;
    fireEvent.click(codeCmp);
    expect(onOpenBeside).toHaveBeenCalled();
  });

  test('overview toggle reflects mode and fires its callback', () => {
    const onOverview = vi.fn();
    const { container } = render(
      <DeckBar
        mode="overview"
        primary="visual"
        secondary={null}
        surfaces={SAMPLE_SURFACES}
        onOverview={onOverview}
        onFocus={() => {}}
        onOpenBeside={() => {}}
      />,
    );
    const over = container.querySelector('.deck-over') as HTMLButtonElement;
    expect(over.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(over);
    expect(onOverview).toHaveBeenCalled();
  });

  test('has no accessibility violations', async () => {
    const { container } = render(
      <DeckBar mode="focus" primary="technical" secondary="visual" surfaces={SAMPLE_SURFACES} {...noop} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
