// Stub for `@storybook/react-dom-shim`, aliased in `vitest.config.ts`'s `storybook` project.
// `@storybook/preact`'s own framework preset unconditionally lists this React-only package in its
// `optimizeViteDeps` hint (see node_modules/@storybook/preact/dist/preset.js), even though this
// project uses Preact and never installs or imports the real package. Without an alias, Vite's dep
// optimizer tries and fails to resolve it on every run (issue #1686). Nothing in the Preact story
// render path imports this module for real, so an empty stub is a safe, no-op resolution target.
export {};
