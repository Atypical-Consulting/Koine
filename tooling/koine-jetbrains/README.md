# Koine for JetBrains Rider

A thin JetBrains Rider plugin that brings Koine (`.koi`) language support — diagnostics,
navigation, rename, and refactoring code actions — by talking to the existing Koine
language server. It is the JetBrains counterpart of the VS Code extension in
[`../koine-textmate`](../koine-textmate) and reuses the **same** server (`koine lsp`).

## How it works

The plugin is an **LSP client**, not a re-implementation of the compiler. It uses
[LSP4IJ](https://plugins.jetbrains.com/plugin/23257-lsp4ij) to launch and speak to the
Koine server (`src/Koine.Cli`, the `lsp` verb). Everything intelligent — diagnostics,
go-to-definition, document symbols, semantic tokens, **rename**, and **refactoring code
actions** (extract value object, quick-fixes) — is computed by the .NET server and
surfaces in Rider automatically:

| Koine server (LSP)              | Rider UI (via LSP4IJ)                         |
| ------------------------------- | --------------------------------------------- |
| `publishDiagnostics`            | Inline warnings/errors                        |
| `textDocument/rename` + prepare | Shift+F6 inline-rename **bubble**             |
| `textDocument/codeAction`       | Alt+Enter **intentions** / lightbulb quick-fixes |
| `definition`, `hover`, symbols  | Go-to-definition, hover, structure view       |

Because all logic stays server-side, every new refactor added to `koine lsp` (e.g. the
extract-value-object code action) shows up here with no plugin change.

## Prerequisites

- **JDK 17+** (21 recommended) to build the plugin. The repo's default `java` may be 11;
  the Gradle toolchain pins 21 (`jvmToolchain(21)`), so install/point Gradle at a JDK 21.
- **Gradle 9+** (or run `gradle wrapper` once to generate a pinned wrapper — see below).
- The **Koine language server** on `PATH`. Install the `koine` dotnet tool, or override the
  path in settings (see *Configuration*):
  ```sh
  dotnet tool install --global koine   # provides `koine lsp`
  ```

## Build & run

```sh
# One-time: generate the Gradle wrapper pinned to a compatible version.
gradle wrapper --gradle-version 9.0

# Build the plugin distribution (build/distributions/*.zip).
./gradlew buildPlugin

# Launch a sandbox Rider with the plugin loaded; open a .koi file to verify.
./gradlew runIde

# Validate against the target platform.
./gradlew verifyPlugin
```

> **Verification status:** these Gradle files were authored but **not built in CI yet** —
> they require a JDK 17+/Rider SDK environment. Before the first release, confirm the pinned
> versions in [`gradle.properties`](gradle.properties) (IntelliJ Platform Gradle Plugin,
> Rider, and especially the **LSP4IJ** version) are current, then run `./gradlew buildPlugin`.

## Configuration

Mirrors the VS Code extension. The server launcher resolves in this order:

1. `KOINE_SERVER_PATH` environment variable (handy for pointing at a freshly built server),
2. the stored `serverPath` setting,
3. `koine` on `PATH` (default → `koine lsp`).

`serverArgs` are inserted **before** the `lsp` verb, so you can run from source, e.g.
`serverPath = dotnet`, `serverArgs = ["/abs/path/Koine.Cli.dll"]` → `dotnet … Koine.Cli.dll lsp`.

A Settings **UI panel** (Preferences → Languages → Koine) is the next step; for now the
state is editable via the env var or programmatically (`KoineServerSettings`).

## Layout

```
build.gradle.kts / settings.gradle.kts / gradle.properties   Gradle IntelliJ Platform v2 build
src/main/kotlin/com/atypical/koine/
  KoineLanguage.kt            the `Koine` Language
  KoineFileType.kt            binds `.koi`
  settings/KoineServerSettings.kt   server launch config (env / stored / PATH)
  lsp/KoineLspServerFactory.kt      LSP4IJ LanguageServerFactory
  lsp/KoineServerConnectionProvider.kt   spawns `koine [args] lsp` over stdio
src/main/resources/META-INF/plugin.xml   fileType + LSP4IJ server/languageMapping
```
