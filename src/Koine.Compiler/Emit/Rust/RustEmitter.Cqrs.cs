using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Rust;

/// <summary>
/// The events/CQRS slice of <see cref="RustEmitter"/>. A Koine <c>event</c> (and cross-boundary
/// <c>integration event</c>) emits as a plain data struct with public fields plus a <c>new</c>
/// constructor — events carry no invariants, so public fields are the idiomatic shape. All of a
/// context's events are additionally collected into a single <c>DomainEvent</c> enum (one variant per
/// event) so a handler can hold a <c>Vec&lt;DomainEvent&gt;</c> and <c>match</c> them exhaustively.
/// <para>
/// Smart enums (Task 4) already emit as data-free Rust <c>enum</c>s whose associated-data accessors are
/// exhaustive <c>match</c>es with no <c>_</c> catch-all, so adding a variant is a downstream compile
/// error — the idiomatic <c>Match</c>/<c>Switch</c>/<c>Try*</c> shape. Event <c>emit</c> wiring,
/// factories, queries, and read models are a later phase (this is the tactical core).
/// </para>
/// </summary>
public sealed partial class RustEmitter
{
    private void EmitEvent(StringBuilder body, RustEmitContext emit, string name, string? doc, IReadOnlyList<Member> members)
    {
        var typeMapper = new RustTypeMapper(emit.Index);
        var typeName = RustNaming.ToPascalCase(name);

        WriteDoc(body, doc, string.Empty);
        body.Append("#[derive(Debug, Clone, PartialEq)]\n");
        body.Append("pub struct ").Append(typeName).Append(" {\n");
        foreach (Member m in members)
        {
            WriteDoc(body, m.Doc, Indent);
            body.Append(Indent).Append("pub ").Append(RustNaming.Field(m.Name)).Append(": ").Append(typeMapper.Map(m.Type)).Append(",\n");
        }
        body.Append("}\n\n");

        var ctorParams = string.Join(", ", members.Select(m => RustNaming.Field(m.Name) + ": " + typeMapper.Map(m.Type)));
        body.Append("impl ").Append(typeName).Append(" {\n");
        body.Append(Indent).Append("pub fn new(").Append(ctorParams).Append(") -> Self {\n");
        body.Append(Indent).Append(Indent).Append(typeName).Append(" {\n");
        foreach (Member m in members)
        {
            body.Append(Indent).Append(Indent).Append(Indent).Append(RustNaming.Field(m.Name)).Append(",\n");
        }
        body.Append(Indent).Append(Indent).Append("}\n");
        body.Append(Indent).Append("}\n");
        body.Append("}\n");
    }

    /// <summary>
    /// Emits the context-wide <c>DomainEvent</c> enum collecting every event/integration-event of the
    /// context as a variant, so a handler can hold and exhaustively <c>match</c> a
    /// <c>Vec&lt;DomainEvent&gt;</c>. Emits nothing when the context declares no events.
    /// </summary>
    private void EmitDomainEventEnum(StringBuilder body, ContextNode ctx)
    {
        var events = ctx.AllTypeDecls()
            .Where(t => t is EventDecl or IntegrationEventDecl)
            .Select(t => RustNaming.ToPascalCase(t.Name))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
        if (events.Count == 0)
        {
            return;
        }

        body.Append('\n');
        body.Append("/// Every domain event this context can raise — a `Vec`-friendly, exhaustively matchable enum.\n");
        body.Append("#[derive(Debug, Clone, PartialEq)]\n");
        body.Append("pub enum DomainEvent {\n");
        foreach (var ev in events)
        {
            body.Append(Indent).Append(ev).Append('(').Append(ev).Append("),\n");
        }
        body.Append("}\n");
    }
}
