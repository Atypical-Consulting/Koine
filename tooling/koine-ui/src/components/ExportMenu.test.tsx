import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/preact';
import { axe } from 'vitest-axe';
import { ExportMenu } from './ExportMenu';

afterEach(() => {
  document.body.innerHTML = '';
});

const item = (c: Element, format: string) => c.querySelector(`[data-export="${format}"]`) as HTMLButtonElement;

describe('ExportMenu', () => {
  test('renders the native <details> disclosure with one item per export format + Copy Mermaid', () => {
    const { container } = render(<ExportMenu onExport={() => {}} onCopyMermaid={() => {}} />);
    expect(container.querySelector('details.koi-export')).not.toBeNull();
    for (const format of ['svg', 'png', 'plantuml', 'mermaid']) {
      expect(item(container, format)).not.toBeNull();
    }
  });

  test('clicking an export format fires onExport and closes the disclosure (#534)', () => {
    const onExport = vi.fn();
    const { container } = render(<ExportMenu onExport={onExport} onCopyMermaid={() => {}} defaultOpen />);
    const details = container.querySelector('details.koi-export') as HTMLDetailsElement;
    expect(details.open).toBe(true);

    fireEvent.click(item(container, 'svg'));

    expect(onExport).toHaveBeenCalledWith('svg');
    expect(details.hasAttribute('open')).toBe(false);
  });

  test('clicking Copy Mermaid fires onCopyMermaid and closes the disclosure (#534)', () => {
    const onCopyMermaid = vi.fn();
    const { container } = render(<ExportMenu onExport={() => {}} onCopyMermaid={onCopyMermaid} defaultOpen />);
    const details = container.querySelector('details.koi-export') as HTMLDetailsElement;

    fireEvent.click(item(container, 'mermaid'));

    expect(onCopyMermaid).toHaveBeenCalledTimes(1);
    expect(details.hasAttribute('open')).toBe(false);
  });

  test('defaultOpen omitted leaves the disclosure closed (compact toolbar default)', () => {
    const { container } = render(<ExportMenu onExport={() => {}} onCopyMermaid={() => {}} />);
    expect((container.querySelector('details.koi-export') as HTMLDetailsElement).open).toBe(false);
  });

  test('has no axe violations when open', async () => {
    const { container } = render(<ExportMenu onExport={() => {}} onCopyMermaid={() => {}} defaultOpen />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
