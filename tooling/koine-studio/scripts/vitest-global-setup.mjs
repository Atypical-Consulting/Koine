// Vitest global setup: generate the (git-ignored) src/templates.generated.ts before any test
// file is imported. welcome.ts / templates.ts import TEMPLATES from it at module load, so it must
// exist first. This covers EVERY vitest entry point — `npm test`, `npm run test:watch`, and a bare
// `vitest` — which is why it lives here rather than in a per-script npm pre-hook.
import { generate } from './generate-templates.mjs';

export default function setup() {
  generate();
}
