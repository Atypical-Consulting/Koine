// The Playground's built-in sample models. Sourced from the shared `templates/` manifest
// (the single validated source of truth, issue #101) via the generated module produced by
// scripts/build-samples.mjs on predev/prebuild. Only single-file templates are included
// because the playground editor compiles exactly one .koi source string at a time.
import { GENERATED_SAMPLES } from './samples.generated';

export interface Sample {
  id: string;
  label: string;
  blurb: string;
  code: string;
}

export const SAMPLES: Sample[] = GENERATED_SAMPLES;

export const DEFAULT_SAMPLE = SAMPLES[0];

export function sampleById(id: string | null | undefined): Sample | undefined {
  return SAMPLES.find((s) => s.id === id);
}
