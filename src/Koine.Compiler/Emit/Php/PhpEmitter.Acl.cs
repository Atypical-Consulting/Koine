using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Php;

/// <summary>
/// The anti-corruption-layer slice of <see cref="PhpEmitter"/> (R14.2), the PHP analogue of the C#
/// <c>EmitAclTranslator</c> / <c>PythonEmitter.Acl.cs</c>: for each context-map relation of kind
/// <see cref="ContextRelationKind.AntiCorruptionLayer"/> that carries an <c>acl { … }</c> mapping
/// block, this emits one translator <c>interface</c> seam into the downstream context's
/// <c>Abstractions/</c> folder, with one <c>translate&lt;Upstream&gt;To&lt;Local&gt;</c> method per
/// mapping (upstream type → local type). A pure structural seam — no behavior, like the C#/Python/TS
/// interfaces. The upstream and local types resolve to qualified cross-namespace <c>use</c> imports
/// through the shared type catalog, so an upstream type from another bounded context references its
/// real namespace, never a guessed path.
/// </summary>
public sealed partial class PhpEmitter
{
    /// <summary>
    /// Emits the anti-corruption-layer translator <c>interface</c> for one ACL relation:
    /// <c>interface &lt;Up&gt;To&lt;Down&gt;Translator</c> in the downstream context's
    /// <c>Abstractions/</c> folder, with one <c>translate&lt;Upstream&gt;To&lt;Local&gt;</c> method per
    /// mapping. PHP cannot overload, so each method name carries BOTH the upstream and local type —
    /// guaranteeing distinct names even when several mappings share a source or target type. Each mapped
    /// type is imported via the shared type catalog (<see cref="CollectUses"/>), so an upstream type from
    /// another context resolves to its real fully-qualified name.
    /// </summary>
    private EmittedFile EmitAclTranslator(PhpEmitContext emit, ContextRelation r)
    {
        var upstream = PhpNaming.ClassName(r.Upstream);
        var downstream = PhpNaming.ClassName(r.Downstream);
        var className = $"{upstream}To{downstream}Translator";
        var ns = r.Downstream;

        var sb = new StringBuilder();
        sb.Append("/** Anti-corruption translator from upstream context ").Append(EscapeDoc(r.Upstream))
          .Append(" into ").Append(EscapeDoc(r.Downstream)).Append(". */\n");
        sb.Append("interface ").Append(className).Append('\n');
        sb.Append("{\n");

        bool first = true;
        foreach (AclMapping m in r.AclMappings)
        {
            var localType = PhpNaming.ClassName(m.LocalType);
            var upstreamType = PhpNaming.ClassName(m.UpstreamType);
            var method = "translate" + upstreamType + "To" + localType;
            if (!first)
            {
                sb.Append('\n');
            }

            first = false;
            sb.Append(Indent).Append("public function ").Append(method).Append('(')
              .Append(upstreamType).Append(" $source): ").Append(localType).Append(";\n");
        }

        sb.Append("}\n");

        return new EmittedFile(
            PathFor(ns, KindFolder.Abstractions, className),
            Assemble(ns, KindFolder.Abstractions, sb.ToString(), className));
    }
}
