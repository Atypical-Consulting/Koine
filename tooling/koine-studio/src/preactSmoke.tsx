// Toolchain smoke component: proves Preact JSX compiles and @testing-library/preact mounts under
// happy-dom. Not wired into the app; delete-able once a real panel exists, but harmless to keep.
export function PreactSmoke(props: { label: string }) {
  return <span class="smoke">{props.label}</span>;
}
