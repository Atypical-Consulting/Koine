// The Playground's built-in sample models. Each .koi file is imported as a raw string
// (Vite `?raw`) and is verified to compile (see the CLI check in the build pipeline).
import billing from './billing.koi?raw';
import ordering from './ordering.koi?raw';
import values from './values.koi?raw';

export interface Sample {
  id: string;
  label: string;
  blurb: string;
  code: string;
}

export const SAMPLES: Sample[] = [
  {
    id: 'billing',
    label: 'Billing — the 5-minute tour',
    blurb: 'Value object + invariant, regex-validated email, smart enum, entity & aggregate.',
    code: billing,
  },
  {
    id: 'ordering',
    label: 'Ordering — behavior',
    blurb: 'Commands, domain events, a state machine, and a factory.',
    code: ordering,
  },
  {
    id: 'values',
    label: 'Value objects & invariants',
    blurb: 'Smart enums with data, quantities, ranges, derived fields.',
    code: values,
  },
];

export const DEFAULT_SAMPLE = SAMPLES[0];

export function sampleById(id: string | null | undefined): Sample | undefined {
  return SAMPLES.find((s) => s.id === id);
}
