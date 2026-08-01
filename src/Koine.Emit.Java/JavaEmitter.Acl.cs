using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The anti-corruption-layer slice of <see cref="JavaEmitter"/> (R14.2, Phase 2 / issue #1090) — the Java
/// analogue of <c>PythonEmitter.Acl.cs</c> / <c>TypeScriptEmitter.Acl.cs</c> and the C# emitter's
/// <c>I&lt;Up&gt;To&lt;Down&gt;Translator</c>. For each context-map relation of kind
/// <see cref="ContextRelationKind.AntiCorruptionLayer"/> carrying an <c>acl { … }</c> mapping block, one
/// translator <c>interface</c> is emitted into the <b>downstream</b> context's package — that is the side
/// defending its model — with one
/// <c>&lt;Local&gt; translate&lt;Upstream&gt;To&lt;Local&gt;(&lt;Upstream&gt; source)</c> method per
/// mapping. A pure structural seam with no behavior, exactly like the emitted repository interfaces.
/// </summary>
public sealed partial class JavaEmitter
{
    /// <summary>
    /// Emits every ACL translator the model's context map declares. A relation of another kind, or an ACL
    /// relation with no mapping block, contributes nothing — so an ordinary context map gains no stray
    /// empty interface.
    /// </summary>
    private void EmitAclTranslators(JavaEmitContext emit, KoineModel model, List<EmittedFile> files)
    {
        if (model.ContextMap is not { } map)
        {
            return;
        }

        foreach (ContextRelation r in map.Relations)
        {
            if (r.Kind == ContextRelationKind.AntiCorruptionLayer && r.AclMappings.Count > 0)
            {
                files.Add(EmitAclTranslator(emit, r));
            }
        }
    }

    /// <summary>
    /// Emits one relation's <c>&lt;Up&gt;To&lt;Down&gt;Translator</c> interface into the downstream
    /// context's package. Each mapped type is resolved against the context it was DECLARED in (the
    /// mapping's own <see cref="AclMapping.UpstreamContext"/> / <see cref="AclMapping.LocalContext"/>,
    /// threaded through as an explicit <see cref="TypeRef.Qualifier"/>) rather than the emitting one — so
    /// an upstream type whose simple name collides with a same-named downstream type is never silently
    /// swapped for the downstream copy, and a foreign type comes out package-qualified as the downstream
    /// package requires.
    /// <para>
    /// The method name carries BOTH ends. The validator already forbids two mappings with the same
    /// upstream type (KOI1408), but two mappings may legally share a DOWNSTREAM type
    /// (<c>Legacy.Account -&gt; Billing.Customer</c> alongside <c>Legacy.Charge -&gt; Billing.Customer</c>) —
    /// a local-only method name would then collide, surviving only as an overload distinguished by
    /// parameter type. Naming both ends keeps every method distinct by construction and reads the mapping
    /// off the call site, matching the Python emitter's scheme.
    /// </para>
    /// </summary>
    private EmittedFile EmitAclTranslator(JavaEmitContext emit, ContextRelation r)
    {
        var typeMapper = new JavaTypeMapper(emit.Index, r.Downstream, PackageFor);
        var iface = $"{JavaNaming.Type(r.Upstream)}To{JavaNaming.Type(r.Downstream)}Translator";

        var sb = new StringBuilder();
        WriteJavadoc(
            sb,
            $"Anti-corruption translator from upstream context {r.Upstream} into {r.Downstream}. "
            + "Implement it so this context only ever sees its own types.",
            string.Empty);
        sb.Append("public interface ").Append(iface).Append(" {\n");

        foreach (AclMapping m in r.AclMappings)
        {
            var upstreamType = typeMapper.QualifyTypeName(new TypeRef(m.UpstreamType, Qualifier: m.UpstreamContext));
            var localType = typeMapper.QualifyTypeName(new TypeRef(m.LocalType, Qualifier: m.LocalContext));
            var method = JavaNaming.Member(
                "translate" + JavaNaming.Type(m.UpstreamType) + "To" + JavaNaming.Type(m.LocalType));

            sb.Append('\n');
            WriteJavadoc(sb, $"Translates the upstream {m.UpstreamType} into the local {m.LocalType}.", Indent);
            sb.Append(Indent).Append(localType).Append(' ').Append(method).Append('(')
              .Append(upstreamType).Append(" source);\n");
        }

        sb.Append("}\n");
        return TypeFile(r.Downstream, iface, sb.ToString());
    }
}
