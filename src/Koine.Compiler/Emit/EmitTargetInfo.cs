namespace Koine.Compiler.Emit;

/// <summary>
/// The display metadata for one emit target (issue #282): its <paramref name="Id"/> (the target
/// name the compiler resolves, e.g. <c>"csharp"</c>), a human-facing <paramref name="DisplayName"/>
/// (e.g. <c>"C#"</c>), and the <paramref name="FileExtension"/> the target emits (e.g. <c>".cs"</c>).
///
/// <para>This is the shape the <see cref="EmitterRegistry.SupportedTargetInfos"/> capability query
/// returns over <c>koine lsp</c> and the WASM bridge, so Koine Studio can render its target picker,
/// generate-project wizard, Generated-tab labels and assistant compile-tool enum straight from the
/// registry instead of re-declaring the list in the front-end.</para>
/// </summary>
public record EmitTargetInfo(string Id, string DisplayName, string FileExtension);
