using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// Emits an <a href="https://spec.openapis.org/oas/v3.1.0">OpenAPI 3.1</a> document per bounded context
/// from a validated <see cref="KoineModel"/>, selected via <c>--target openapi</c>. It consumes ONLY the
/// target-agnostic semantic model (no <c>Emit/CSharp</c> types, no OpenAPI concept in <c>Ast/</c>),
/// mirroring <see cref="Glossary.GlossaryEmitter"/> and <see cref="Docs.DocsEmitter"/>: read the model →
/// render text.
///
/// <para>The mapping is the API projection of the ubiquitous language: value objects / read models /
/// enums become <c>components/schemas</c> (this file's <c>.Schemas.cs</c> partial); entity commands
/// become <c>POST</c> operations and query objects become <c>GET</c> operations (<c>.Paths.cs</c>).
/// Static value-object invariants lower to JSON-Schema validation keywords where they can be derived.</para>
///
/// <para>Output is deterministic — stable declaration order, no timestamps — and rendered through the
/// hand-rolled <see cref="OpenApiYamlWriter"/> (no new compiler dependency), so re-running is
/// byte-identical and Verify snapshots are reproducible. One <c>&lt;Context&gt;/openapi.yaml</c> is emitted
/// per bounded context so multi-context models never collide on a single file name.</para>
/// </summary>
public sealed partial class OpenApiEmitter : IEmitter
{
    public string TargetName => "openapi";

    public IReadOnlyList<EmittedFile> Emit(KoineModel model)
    {
        var index = new ModelIndex(model);
        var files = new List<EmittedFile>();

        foreach (ContextNode ctx in model.Contexts)
        {
            YamlObject document = BuildDocument(ctx, index);
            files.Add(new EmittedFile($"{ctx.Name}/openapi.yaml", OpenApiYamlWriter.Render(document)));
        }

        return files;
    }

    /// <summary>Assembles the top-level OpenAPI document: the version header, <c>info</c>, <c>paths</c>, and <c>components</c>.</summary>
    private static YamlObject BuildDocument(ContextNode ctx, ModelIndex index)
    {
        var document = new YamlObject();
        document.Add("openapi", Yaml.Raw("3.1.0"));
        document.Add("info", BuildInfo(ctx));
        // `paths` is required by the spec even when empty; `components` is optional, so it is omitted
        // entirely when the context declares nothing schema-worthy rather than left as a bare `{}`.
        document.Add("paths", BuildPaths(ctx, index));
        YamlObject components = BuildComponents(ctx, index);
        if (!components.IsEmpty)
        {
            document.Add("components", components);
        }

        return document;
    }

    /// <summary>The <c>info</c> object: a title from the context name, the context doc (when present), and a version.</summary>
    private static YamlObject BuildInfo(ContextNode ctx)
    {
        var info = new YamlObject();
        info.Add("title", $"{ctx.Name} API");
        if (!string.IsNullOrWhiteSpace(ctx.Doc))
        {
            info.Add("description", OneLine(ctx.Doc!));
        }

        // A bounded context's declared evolution generation (R15.1) seeds the API's major version;
        // unstamped contexts default to 1.0.0.
        info.Add("version", Yaml.Raw($"{ctx.Version ?? 1}.0.0"));
        return info;
    }

    /// <summary>Collapses a multi-line doc comment to a single line for a YAML scalar.</summary>
    private static string OneLine(string text) =>
        string.Join(' ', text.Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries));

    // BuildPaths lives in the .Paths.cs partial; BuildComponents in the .Schemas.cs partial.
}
