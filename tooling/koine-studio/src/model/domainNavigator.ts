// The DDD "Domain" navigator moved to Preact in issue #991 Task 1 — the implementation (the presenter
// component + the live `mountDomainNavigator` facade + the `renderStrategic` / `renderTactical` pure-DOM
// builders + every type) now lives in `DomainNavigator.tsx`. This module stays as a thin barrel so the
// stable import path `@/model/domainNavigator` (used by `inspectorController.tsx` and the characterization
// suites) never changes. The explicit `.tsx` specifier resolves the sibling unambiguously — the two files
// differ only by case, so a bare `./DomainNavigator` could self-resolve on a case-insensitive filesystem.
export * from './DomainNavigator.tsx';
