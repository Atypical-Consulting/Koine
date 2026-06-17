// Headless smoke test: boots the published wasm AppBundle under Node and calls the
// compiler's [JSExport] surface, so we can verify the wasm module actually works (and that
// trimming, if enabled, didn't break reflection) without opening a browser.
//
//   node src/Koine.Wasm/smoke-test.mjs
import { dotnet } from './bin/Release/net10.0/browser-wasm/AppBundle/_framework/dotnet.js';

const SOURCE = `context Billing {
  enum Currency { EUR, USD, GBP }
  value Money {
    amount: Decimal
    currency: Currency
    invariant amount >= 0 "a monetary amount cannot be negative"
  }
}`;

const runtime = await dotnet.create();
const config = runtime.getConfig();
const exports = await runtime.getAssemblyExports(config.mainAssemblyName);
const api = exports.Koine.Wasm.CompilerInterop;

// 1. Diagnose a clean source → expect zero diagnostics.
const diags = JSON.parse(api.Diagnose(SOURCE));
console.log('diagnostics (clean):', JSON.stringify(diags));

// 2. Compile to C# → expect ok + at least one file.
const csharp = JSON.parse(api.Compile(SOURCE, 'csharp'));
console.log('csharp ok:', csharp.ok, 'files:', csharp.files.length, csharp.files.map((f) => f.path));

// 3. Compile to TypeScript and glossary.
const ts = JSON.parse(api.Compile(SOURCE, 'typescript'));
console.log('typescript ok:', ts.ok, 'files:', ts.files.length);
const glossary = JSON.parse(api.Compile(SOURCE, 'glossary'));
console.log('glossary ok:', glossary.ok, 'files:', glossary.files.length);

// 4. Diagnose a broken source → expect an error with a code + position.
const bad = JSON.parse(api.Diagnose('context X { value M { amount: Decimal invariant amount >= 0 } }'));
console.log('diagnostics (broken):', JSON.stringify(bad));

// Assert the happy path.
const ok = diags.length === 0 && csharp.ok && csharp.files.length > 0 && ts.ok && glossary.ok;
console.log(ok ? '\nSMOKE TEST PASSED' : '\nSMOKE TEST FAILED');
process.exit(ok ? 0 : 1);
