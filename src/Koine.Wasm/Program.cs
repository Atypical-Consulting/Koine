// Entry point for the browser-wasm app. The Playground boots the runtime with
// `dotnet.create()` and calls the [JSExport] methods in CompilerInterop directly via
// getAssemblyExports — Main is never used, but a browser-wasm OutputType=Exe needs one.
return;
