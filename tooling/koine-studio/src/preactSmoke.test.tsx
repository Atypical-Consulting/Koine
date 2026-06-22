import { describe, expect, test } from 'vitest';
import { render } from '@testing-library/preact';
import { PreactSmoke } from '@/preactSmoke';

describe('PreactSmoke', () => {
  test('renders its label into the DOM', () => {
    const { container } = render(<PreactSmoke label="hello" />);
    const span = container.querySelector('.smoke');
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe('hello');
  });
});
