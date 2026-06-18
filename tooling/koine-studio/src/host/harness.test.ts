import { describe, it, expect } from 'vitest';

// Smoke test: confirms the vitest + jsdom harness runs and the DOM environment is wired up.
describe('test harness', () => {
  it('runs under jsdom', () => {
    const div = document.createElement('div');
    div.textContent = 'koine';
    expect(div.textContent).toBe('koine');
  });
});
