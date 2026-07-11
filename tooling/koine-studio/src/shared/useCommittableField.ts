// useCommittableField moved into the shared design-system package (@atypical/koine-ui, issue #1408 —
// fourth-tranche host-adapter migration). This one-line re-export keeps existing Studio call sites
// (`@/shared/useCommittableField` — DocsPanels.tsx, and the migrated GlossaryPanel until it imports the
// panel from koine-ui) compiling unchanged. The hook has no store/Tauri coupling, so it moved verbatim.
export { useCommittableField, type CommittableField } from '@atypical/koine-ui';
