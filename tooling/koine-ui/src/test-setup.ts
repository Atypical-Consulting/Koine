// Vitest setup (test-only, never bundled into dist/). Mirrors koine-studio's src/test-setup.ts, trimmed
// to what the moved presentational components' tests actually need (issue #905, Task 4) — no
// localStorage/IndexedDB/crypto shims here, since none of these components touch those.
import { afterEach, expect } from 'vitest';
import { cleanup } from '@testing-library/preact';
import * as axeMatchers from 'vitest-axe/matchers';

// Accessibility matcher. Registering it here makes `expect(await axe(el)).toHaveNoViolations()`
// available to every test file.
expect.extend(axeMatchers);

// Unmount rendered Preact trees after every test. @testing-library/preact only auto-registers this when
// Vitest `globals` is on (it isn't here), so without it each render() leaks into document.body and the
// next test.
afterEach(() => cleanup());
