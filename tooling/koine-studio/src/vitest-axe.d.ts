// Type augmentation for the vitest-axe `toHaveNoViolations` matcher (registered in test-setup.ts).
// vitest-axe ships a declaration against the legacy global `Vi` namespace; Vitest 4 resolves custom
// matchers through the `vitest` module's `Assertion`/`AsymmetricMatchersContaining`, so we augment those.
import 'vitest';
import type { AxeMatchers } from 'vitest-axe/matchers';

declare module 'vitest' {
  interface Assertion<T = any> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}
