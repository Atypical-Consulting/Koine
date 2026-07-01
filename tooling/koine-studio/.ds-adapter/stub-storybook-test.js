// No-op stub for `storybook/test`. Stories import { expect, waitFor, fn, userEvent } for their `play`
// interaction functions, which never run at static render time — we only need the import bindings to
// resolve so the module compiles. Keeps the heavy test runtime (vitest/chai) out of the preview bundles.
const chain = new Proxy(() => chain, { get: () => chain });
export const expect = () => chain;
export const waitFor = async (fn) => { try { return fn && fn(); } catch { return undefined; } };
export const fn = () => () => {};
export const userEvent = new Proxy({}, { get: () => async () => {} });
export const within = () => ({});
export const screen = {};
export default { expect, waitFor, fn, userEvent, within, screen };
