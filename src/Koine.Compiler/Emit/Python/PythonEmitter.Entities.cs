using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Python;

/// <summary>
/// The entity slice of <see cref="PythonEmitter"/>. A Koine <c>entity</c> emits as a mutable
/// <c>@dataclass(eq=False)</c> (Task 8's commands reassign its fields, so it must NOT be frozen),
/// with explicit <b>identity</b> equality: <c>__eq__</c> compares the runtime type and the
/// <c>id</c>, and <c>__hash__</c> hashes the <c>id</c> alone — so every non-id field (including any
/// <c>Mapping</c> field, which is unhashable) is naturally excluded from the hash. Stored members
/// are typed dataclass fields, constant defaults carry dataclass defaults, computed (derived)
/// members are <c>@property</c> getters, and invariants run in <c>__post_init__</c> raising
/// <see cref="PyRuntime"/>'s <c>DomainInvariantViolationError</c>.
/// <para>
/// Each entity also emits its branded identity value object (<c>&lt;XId&gt;</c>) as a
/// <c>@dataclass(frozen=True)</c> (immutable + hashable, so equality/hashing come free) per the
/// entity's <see cref="IdentityStrategy"/>: <c>Guid</c> wraps a <c>uuid.UUID</c> and gets a
/// <c>new()</c> factory; <c>Natural</c> wraps a <c>str</c>/<c>int</c> (caller-supplied, no
/// <c>new()</c>); <c>Sequence</c> wraps a store-assigned <c>int</c> (no <c>new()</c>).
/// </para>
/// <para>
/// Commands, factories, and state machines are NOT emitted here (Tasks 8/9): the entity is data +
/// identity + invariants + computed properties for now.
/// </para>
/// </summary>
public sealed partial class PythonEmitter
{
    // ----------------------------------------------------------------------
    // Entity (mutable @dataclass(eq=False) with identity equality)
    // ----------------------------------------------------------------------

    private EmittedFile EmitEntity(PyEmitContext emit, EntityDecl entity, string ns, PythonTypeMapper typeMapper)
    {
        var name = PythonNaming.ToPascalCase(entity.Name);
        var idName = PythonNaming.ToPascalCase(entity.IdentityName);
        var memberNames = new HashSet<string>(entity.Members.Select(m => m.Name), StringComparer.Ordinal);

        // Stored/default members become dataclass fields; derived members become @property getters.
        var fields = entity.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = entity.Members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();

        // The translator sees the members plus the synthetic `id` field (so an invariant or computed
        // member referencing the identity resolves), mirroring the TS emitter's scope augmentation.
        var scopeMembers = entity.Members.Append(new Member("id", new TypeRef(entity.IdentityName), null)).ToList();
        var translator = new PythonExpressionTranslator(emit.Index, scopeMembers, emit.EnumMemberToType, typeMapper, ContextOf(ns));

        var sb = new StringBuilder();
        sb.Append("@dataclass(eq=False)\n");
        sb.Append("class ").Append(name).Append(":\n");

        var classDoc = entity.Doc;
        if (!string.IsNullOrEmpty(classDoc))
        {
            WriteDoc(sb, classDoc, Indent);
        }

        // The identity field comes first and is non-defaulted, so it always precedes any defaulted
        // member — satisfying the dataclass "non-default before default" rule without reordering.
        sb.Append(Indent).Append("id: ").Append(idName).Append('\n');

        // Member fields: non-defaulted before defaulted (dataclass requirement). The id is already
        // non-defaulted and emitted first, so a member that carries no default still follows it
        // legally; a defaulted member is moved last.
        var ordered = fields.OrderBy(m => HasDefault(m) ? 1 : 0).ToList();
        foreach (Member m in ordered)
        {
            WriteDoc(sb, m.Doc, Indent);
            var field = PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(m.Name));
            sb.Append(Indent).Append(field).Append(": ").Append(typeMapper.Map(m.Type));
            if (DefaultExpr(m, translator) is { } def)
            {
                sb.Append(" = ").Append(def);
            }
            sb.Append('\n');
        }

        // Domain-event recording buffer (when any command or factory emits events). A non-constructor
        // `_domain_events` field plus a read-only `domain_events` snapshot and a `clear_domain_events`
        // drain — the Python analogue of the C# aggregate's `DomainEvents`/`ClearDomainEvents`.
        var hasEmits = EmitsEvents(entity);
        if (hasEmits)
        {
            WriteDomainEventsBuffer(sb);
        }

        // Invariants run in __post_init__ once all fields are bound (self.<field> reads).
        if (entity.Invariants.Count > 0)
        {
            sb.Append('\n');
            sb.Append(Indent).Append("def __post_init__(self) -> None:\n");
            foreach (Invariant inv in entity.Invariants)
            {
                WriteInvariantGuard(sb, name, inv, translator);
            }
        }

        // Computed (derived) members as read-only @property getters.
        foreach (Member m in derived)
        {
            sb.Append('\n');
            sb.Append(Indent).Append("@property\n");
            sb.Append(Indent).Append("def ").Append(PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(m.Name)))
              .Append("(self) -> ").Append(typeMapper.Map(m.Type)).Append(":\n");
            WriteDoc(sb, m.Doc, Indent + Indent);
            sb.Append(Indent).Append(Indent).Append("return ")
              .Append(translator.Translate(m.Initializer!, EnumExpected(m, emit.Index))).Append('\n');
        }

        // Commands: mutating instance methods (guards -> transitions -> re-check -> emit -> return).
        foreach (CommandDecl cmd in entity.Commands)
        {
            WriteCommand(sb, entity, cmd, translator, typeMapper, emit.Index);
        }

        // Factories: `create` rendered as a @classmethod minting the identity and constructing.
        foreach (FactoryDecl factory in entity.Factories)
        {
            WriteFactory(sb, entity, name, idName, factory, fields, translator, typeMapper, emit.Index);
        }

        // Identity equality/hashing. `eq=False` keeps the dataclass mutable AND lets us define these
        // explicitly: equality is by runtime type + id; the hash is the id alone (so every non-id
        // field — including any unhashable Mapping — is excluded from the hash).
        sb.Append('\n');
        sb.Append(Indent).Append("def __eq__(self, other: object) -> bool:\n");
        sb.Append(Indent).Append(Indent).Append("return isinstance(other, ").Append(name)
          .Append(") and self.id == other.id\n");
        sb.Append('\n');
        sb.Append(Indent).Append("def __hash__(self) -> int:\n");
        sb.Append(Indent).Append(Indent).Append("return hash(self.id)\n");

        return new EmittedFile(
            PathFor(ns, KindFolder.Entities, entity.Name),
            Assemble(emit, ns, KindFolder.Entities, sb.ToString(), name));
    }

    // ----------------------------------------------------------------------
    // Branded identity value object (per IdentityStrategy)
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits an entity's branded <c>&lt;XId&gt;</c> as a <c>@dataclass(frozen=True)</c> — immutable
    /// and hashable, so equality/hashing come free. The backing field and the optional <c>new()</c>
    /// factory follow the identity strategy:
    /// <list type="bullet">
    ///   <item><b>Guid</b> — <c>value: uuid.UUID</c> + a <c>new()</c> staticmethod minting a fresh
    ///   <c>uuid.uuid4()</c>.</item>
    ///   <item><b>Natural(String)</b> — <c>value: str</c>; no <c>new()</c> (caller supplies the key).</item>
    ///   <item><b>Natural(Int)</b> — <c>value: int</c>; no <c>new()</c>.</item>
    ///   <item><b>Sequence</b> — <c>value: int</c> (store-assigned); no <c>new()</c>.</item>
    /// </list>
    /// The ID module lands alongside the value objects (<c>value_objects/</c>), mirroring the TS
    /// emitter's placement.
    /// </summary>
    private EmittedFile EmitIdType(PyEmitContext emit, string idRaw, string ns, IdentityStrategy strategy, string? backing)
    {
        var idName = PythonNaming.ToPascalCase(idRaw);
        var backingType = strategy switch
        {
            IdentityStrategy.Sequence => "int",
            IdentityStrategy.Natural => backing == "Int" ? "int" : "str",
            _ => "uuid.UUID"
        };

        var sb = new StringBuilder();
        sb.Append("@dataclass(frozen=True)\n");
        sb.Append("class ").Append(idName).Append(":\n");
        sb.Append(Indent).Append("\"\"\"A strongly-typed, branded identity value object.\"\"\"\n\n");
        sb.Append(Indent).Append("value: ").Append(backingType).Append('\n');

        // A Guid identity is minted client-side; sequence/natural keys are supplied externally.
        if (strategy == IdentityStrategy.Guid)
        {
            sb.Append('\n');
            sb.Append(Indent).Append("@staticmethod\n");
            sb.Append(Indent).Append("def new() -> ").Append(idName).Append(":\n");
            sb.Append(Indent).Append(Indent).Append("\"\"\"Mints a fresh ").Append(idName).Append(" (a random UUID).\"\"\"\n");
            sb.Append(Indent).Append(Indent).Append("return ").Append(idName).Append("(uuid.uuid4())\n");
        }

        return new EmittedFile(
            PathFor(ns, KindFolder.ValueObjects, idName),
            Assemble(emit, ns, KindFolder.ValueObjects, sb.ToString(), idName));
    }

    // ----------------------------------------------------------------------
    // Unowned foreign *Id types
    // ----------------------------------------------------------------------

    /// <summary>
    /// The deterministically-sorted set of foreign <c>*Id</c> names referenced within
    /// <paramref name="ctx"/> whose owning entity does NOT live in this context. These have no local
    /// entity to mint them, so the emitter materializes a standalone branded-<c>guid</c> ID for each
    /// (at the context package root's <c>value_objects/</c>) — the Python analogue of the TS
    /// <c>OrderedUnownedIds</c>. For a single-context model this set is typically empty; Task 9's
    /// cross-context relationships rely on it.
    /// </summary>
    private static IEnumerable<string> OrderedUnownedIds(ContextNode ctx, ModelIndex index)
    {
        var owned = new HashSet<string>(ctx.AllEntities().Select(e => e.IdentityName), StringComparer.Ordinal);
        var seen = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var idName in index.IdTypeNames)
        {
            if (!owned.Contains(idName) && IsReferencedInContext(ctx, idName))
            {
                seen.Add(idName);
            }
        }
        return seen;
    }

    /// <summary>True when any type in <paramref name="ctx"/> mentions <paramref name="idName"/> in a field, command, or factory signature.</summary>
    private static bool IsReferencedInContext(ContextNode ctx, string idName)
    {
        foreach (TypeDecl t in ctx.AllTypeDecls())
        {
            IEnumerable<TypeRef> types = t switch
            {
                ValueObjectDecl v => v.Members.Select(m => m.Type),
                EntityDecl e => e.Members.Select(m => m.Type)
                    .Concat(e.Commands.SelectMany(c => c.Parameters.Select(p => p.Type)))
                    .Concat(e.Factories.SelectMany(f => f.Parameters.Select(p => p.Type))),
                EventDecl ev => ev.Members.Select(m => m.Type),
                _ => Array.Empty<TypeRef>()
            };
            if (types.Any(tr => TypeRefMentions(tr, idName)))
            {
                return true;
            }
        }
        return false;
    }

    private static bool TypeRefMentions(TypeRef type, string name) =>
        type.Name == name
        || (type.Element is not null && TypeRefMentions(type.Element, name))
        || (type.Value is not null && TypeRefMentions(type.Value, name));
}
