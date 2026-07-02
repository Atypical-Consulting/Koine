using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit;

/// <summary>
/// How a <c>create</c> factory obtains the new aggregate's identity (#324). The default is to mint a
/// fresh id; when the factory supplies it as an explicit identity-typed parameter, the synthetic
/// <c>id</c> binds to that parameter instead — either directly (the parameter is already spelled
/// <c>id</c>) or via an alias.
/// </summary>
public enum FactoryIdSource
{
    /// <summary>No explicit-id parameter: mint a fresh id with the target's generator
    /// (<c>OrderId.New()</c> / <c>::generate()</c> / …). The Guid / auto-generate case.</summary>
    Generate,

    /// <summary>The explicit-id parameter already emits as <c>id</c>, so it provides the local
    /// directly — the factory emits no identity statement.</summary>
    ParamProvidesIdDirectly,

    /// <summary>The explicit-id parameter emits under a different name, so the synthetic <c>id</c> is
    /// aliased to it (<c>id = &lt;AliasFrom&gt;</c>, with each target's own statement syntax).</summary>
    Alias,
}

/// <summary>
/// The generate-vs-omit-vs-alias decision the five emitters' <c>WriteFactory</c> share (#324, #477).
/// This is an <b>emit-side</b> concern, not a model query, so it lives in <c>Emit/</c> rather than
/// <c>Ast/</c>: the choice depends on the <em>emitted</em> parameter name (target-specific casing /
/// escaping), which the resolver receives as a delegate — it embeds no target syntax. Each emitter
/// switches on the result and renders its own generator literal and alias statement.
/// </summary>
/// <param name="Source">Which way the factory obtains its identity.</param>
/// <param name="AliasFrom">The emitted parameter name to alias <c>id</c> to; non-null only when
/// <see cref="Source"/> is <see cref="FactoryIdSource.Alias"/>.</param>
public readonly record struct FactoryIdBinding(FactoryIdSource Source, string? AliasFrom)
{
    /// <summary>
    /// Resolves how <paramref name="factory"/> binds the new <paramref name="entity"/> aggregate's
    /// identity. <paramref name="emitParamName"/> must be the SAME naming function the emitter uses to
    /// render the parameter in the method signature — the binding's correctness depends on the two
    /// agreeing, which is exactly the coupling this single call site centralises.
    /// </summary>
    public static FactoryIdBinding ResolveFactoryId(
        EntityDecl entity, FactoryDecl factory, Func<string, string> emitParamName)
    {
        Param? explicitId = MemberAnalysis.ExplicitIdParameter(entity, factory);
        if (explicitId is null)
        {
            return new FactoryIdBinding(FactoryIdSource.Generate, null);
        }

        var name = emitParamName(explicitId.Name);
        return name == "id"
            ? new FactoryIdBinding(FactoryIdSource.ParamProvidesIdDirectly, null)
            : new FactoryIdBinding(FactoryIdSource.Alias, name);
    }
}
