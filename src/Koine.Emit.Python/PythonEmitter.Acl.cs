using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The anti-corruption-layer slice of <see cref="PythonEmitter"/> (R14.2), the Python analogue of the
/// C# <c>EmitAclTranslator</c> / TS <c>TypeScriptEmitter.Acl.cs</c>: for each context-map relation of
/// kind <see cref="ContextRelationKind.AntiCorruptionLayer"/> that carries an <c>acl { … }</c> mapping
/// block, this emits one translator <c>Protocol</c> seam into the downstream context, with one
/// <c>translate_&lt;local&gt;(source: &lt;Upstream&gt;) -&gt; &lt;Local&gt;</c> method per mapping
/// (upstream type → local type). A pure structural seam — no behavior, like the C#/TS interfaces and
/// the Python repository/service/policy Protocols. The upstream and local types resolve to qualified
/// cross-context imports through the shared <see cref="PyTypeLocation"/> table, so an upstream type
/// from another bounded context references its real module, never a guessed relative path.
/// </summary>
public sealed partial class PythonEmitter
{
    /// <summary>
    /// Emits the anti-corruption-layer translator <c>Protocol</c> for one ACL relation:
    /// <c>class &lt;Up&gt;To&lt;Down&gt;Translator(Protocol)</c> in the downstream context's
    /// <c>abstractions/</c> package, with one <c>translate_&lt;upstream&gt;_to_&lt;local&gt;</c> method
    /// per mapping. Python cannot overload, so each method name carries BOTH the upstream and local
    /// type — guaranteeing distinct names even when several mappings share a source or target type
    /// (where a local-only name would silently shadow one mapping). Each mapped type resolves to a
    /// QUALIFIED import against the context it was declared in (via <paramref name="emit"/>'s location
    /// table and an explicit per-symbol context hint), so an upstream type whose name collides with a
    /// same-named downstream type is never silently swapped for the downstream copy.
    /// </summary>
    private EmittedFile EmitAclTranslator(PyEmitContext emit, ContextRelation r)
    {
        var upstream = PythonNaming.ToPascalCase(r.Upstream);
        var downstream = PythonNaming.ToPascalCase(r.Downstream);
        var className = $"{upstream}To{downstream}Translator";
        var ns = r.Downstream;

        // Each mapped type is resolved against the context it was declared in (upstream vs local),
        // not this module's context — so a name collision across the two contexts can't mis-resolve.
        var symbolContext = new Dictionary<string, string>(StringComparer.Ordinal);

        var sb = new StringBuilder();
        sb.Append("class ").Append(className).Append("(Protocol):\n");
        sb.Append(Indent).Append("\"\"\"Anti-corruption translator from upstream context ")
          .Append(EscapeDoc(r.Upstream)).Append(" into ").Append(EscapeDoc(r.Downstream)).Append(".\"\"\"\n");

        foreach (AclMapping m in r.AclMappings)
        {
            var localType = PythonNaming.ToPascalCase(m.LocalType);
            var upstreamType = PythonNaming.ToPascalCase(m.UpstreamType);
            symbolContext[upstreamType] = m.UpstreamContext;
            symbolContext[localType] = m.LocalContext;

            var method = PythonNaming.EscapeIdentifier(
                "translate_" + PythonNaming.ToSnakeCase(m.UpstreamType) + "_to_" + PythonNaming.ToSnakeCase(m.LocalType));
            sb.Append('\n');
            sb.Append(Indent).Append("def ").Append(method).Append("(self, source: ").Append(upstreamType)
              .Append(") -> ").Append(localType).Append(": ...\n");
        }

        return new EmittedFile(
            PathFor(ns, KindFolder.Abstractions, className),
            Assemble(emit, ns, sb.ToString(), className, symbolContext));
    }
}
