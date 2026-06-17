// Default entry the .NET wasm SDK wires up. The Astro Playground does NOT use this file —
// it imports ./_framework/dotnet.js directly (see website/src/playground/koine.ts). This
// exists so a standalone `dotnet run` / static open of the published output also works for
// smoke-testing: it boots the runtime and exposes the compiler as globalThis.koine.
import { dotnet } from './_framework/dotnet.js';

const { getAssemblyExports, getConfig } = await dotnet.create();
const config = getConfig();
const exports = await getAssemblyExports(config.mainAssemblyName);

globalThis.koine = exports.Koine.Wasm.CompilerInterop;
console.log('Koine wasm compiler ready — try koine.Compile(source, "csharp")');
