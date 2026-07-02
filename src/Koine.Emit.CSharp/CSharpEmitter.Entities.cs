using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.CSharp;

/// <summary>
/// The entity slice of <see cref="CSharpEmitter"/>: rendering an entity (identity,
/// properties, guarded constructor, commands/factories, state machine, domain-event
/// recording) together with its generated ID value object (R11.1). Split out as a
/// partial to keep the orchestrating emitter focused.
/// </summary>
public sealed partial class CSharpEmitter
{
    // ----------------------------------------------------------------------
    // Entities + generated ID
    // ----------------------------------------------------------------------

    private void EmitEntityAndId(
        EmitContext emit,
        List<EmittedFile> files,
        EntityDecl entity,
        string ns,
        bool isRoot,
        bool isVersioned,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        files.Add(EmitEntity(emit, entity, ns, isRoot, isVersioned, index, typeMapper, enumMemberToType));
        // The entity's ID value object lives in the context BASE namespace (R13.3) — not a
        // module sub-namespace — so any module's types can reference it via one `using`.
        // For a non-module entity the base namespace equals its own, so output is unchanged.
        files.Add(EmitIdValueObject(emit, entity.IdentityName, ContextOf(ns), entity.IdStrategy, entity.IdBackingType));
    }

    private EmittedFile EmitEntity(
        EmitContext emit,
        EntityDecl entity,
        string ns,
        bool isRoot,
        bool isVersioned,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        var memberNames = new HashSet<string>(entity.Members.Select(m => m.Name), StringComparer.Ordinal);
        // The translator also resolves the synthetic `id` (the entity's identity) so
        // command/emit expressions can reference it; it renders as the `Id` property.
        var scopeMembers = entity.Members
            .Append(new Member("id", new TypeRef(entity.IdentityName), null))
            .ToList();
        var translator = new CSharpExpressionTranslator(index, scopeMembers, enumMemberToType, SpecBodiesFor(entity.Name, index), context: ContextOf(ns), options: _options);
        // Entities DECLARE the [GeneratedRegex] methods + stamp the type `partial`, so they opt into the
        // source-generated `matches` form (issue #795); translators that don't (specs/services) keep inline.
        translator.EnableGeneratedRegexForm();

        var sb = new StringBuilder();

        WriteXmlDoc(sb, entity.Doc, "");
        WriteObsolete(sb, entity.Deprecated, "");
        // Capture the exact declaration text so the optional `partial` stamp (issue #795) keys on the same
        // string that was written, not a reconstruction that could silently drift out of sync.
        var declaration = "public sealed class " + entity.Name + (isRoot ? " : IAggregateRoot" : "");
        sb.Append(declaration);
        sb.Append('\n');
        sb.Append("{\n");

        // Identity property first.
        sb.Append(Indent).Append("public ").Append(entity.IdentityName).Append(" Id { get; }\n");

        // Optimistic-concurrency token on a versioned aggregate's root (R11.4). Get-only
        // but settable at construction by the persistence layer (init); excluded from
        // identity equality, which is by Id alone.
        if (isVersioned)
        {
            sb.Append(Indent).Append("/// <summary>Optimistic-concurrency token, assigned by the persistence layer.</summary>\n");
            sb.Append(Indent).Append("public int Version { get; init; }\n");
        }

        // Non-derived member properties. A field mutated by a command gains a
        // private setter; all others stay get-only.
        var ctorMembers = entity.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = entity.Members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var mutated = MutatedFields(entity);
        // Members backed by a mutable list (issue #171), classified once and shared by the property
        // declarations, the all-args assignments, and the parameterless-ctor gate so the three stay in
        // lockstep. A field reassigned by a command is excluded (the backing field has no replace path).
        var backedListMembers = BackedListMembers(ctorMembers, index, mutated);

        foreach (var m in ctorMembers)
        {
            var csType = typeMapper.Map(m.Type, out var comment);

            // A value-object collection is backed by a mutable private List<T> so the EF Core
            // infrastructure layer can materialize owned children into it (issue #171); the public
            // surface stays a read-only IReadOnlyList<T>.
            if (backedListMembers.Contains(m.Name))
            {
                var elem = typeMapper.Map(m.Type.Element ?? ObjectType);
                var field = BackingFieldName(m.Name);
                sb.Append(Indent).Append("private readonly List<").Append(elem)
                  .Append(m.Type.IsOptional ? ">? " : "> ").Append(field)
                  .Append(m.Type.IsOptional ? ";\n" : " = new();\n");
                WriteXmlDoc(sb, m.Doc, Indent);
                WriteObsolete(sb, m.Deprecated, Indent);
                sb.Append(Indent).Append("public ").Append(csType).Append(' ')
                  .Append(CSharpNaming.ToPascalCase(m.Name)).Append(" => ").Append(field).Append(';');
                AppendComment(sb, comment);
                sb.Append('\n');
                continue;
            }

            WriteXmlDoc(sb, m.Doc, Indent);
            WriteObsolete(sb, m.Deprecated, Indent);
            sb.Append(Indent).Append("public ").Append(csType).Append(' ')
              .Append(CSharpNaming.ToPascalCase(m.Name))
              .Append(mutated.Contains(m.Name) ? " { get; private set; }" : " { get; }");
            AppendComment(sb, comment);
            sb.Append('\n');
        }

        // Constructor: identity param first, then members.
        sb.Append('\n');
        WriteEntityConstructor(sb, entity, isRoot, ctorMembers, backedListMembers, translator, typeMapper, index);

        // Shared invariant-checking method (DRY: called by the constructor and each command).
        if (entity.Invariants.Count > 0)
        {
            WriteCheckInvariants(sb, entity, translator);
        }

        // Derived (computed) properties.
        foreach (var m in derived)
        {
            var csType = typeMapper.Map(m.Type);
            sb.Append('\n');
            WriteXmlDoc(sb, m.Doc, Indent);
            WriteObsolete(sb, m.Deprecated, Indent);
            sb.Append(Indent).Append("public ").Append(csType).Append(' ')
              .Append(CSharpNaming.ToPascalCase(m.Name)).Append('\n');
            if (RefOnly)
            {
                WriteRefStubExpressionBody(sb);
                continue;
            }

            var body = translator.TranslateTopLevel(m.Initializer!, CSharpExpressionTranslator.NameMode.Property, EnumExpected(m, index));
            sb.Append(Indent).Append(Indent).Append("=> ").Append(body).Append(";\n");
        }

        // Domain-event recording (when any command or factory emits events).
        var hasEmits = EmitsEvents(entity);
        if (hasEmits)
        {
            sb.Append('\n');
            sb.Append(Indent).Append("private readonly List<IDomainEvent> _domainEvents = new();\n");
            sb.Append(Indent).Append("public IReadOnlyList<IDomainEvent> DomainEvents\n");
            if (RefOnly)
            {
                WriteRefStubExpressionBody(sb);
                sb.Append(Indent).Append("public void ClearDomainEvents()\n");
                WriteRefStubExpressionBody(sb);
            }
            else
            {
                sb.Append(Indent).Append(Indent).Append("=> _domainEvents;\n");
                sb.Append(Indent).Append("public void ClearDomainEvents()\n");
                sb.Append(Indent).Append(Indent).Append("=> _domainEvents.Clear();\n");
            }
        }

        // Commands: intention-revealing state-changing methods.
        foreach (var cmd in entity.Commands)
        {
            WriteCommand(sb, entity, cmd, translator, typeMapper, index);
        }

        // Factories: intention-revealing creation through validated static methods.
        foreach (var factory in entity.Factories)
        {
            WriteFactory(sb, entity, factory, ctorMembers, translator, typeMapper, index);
        }

        // Identity-based equality.
        sb.Append('\n');
        sb.Append(Indent).Append("public bool Equals(").Append(entity.Name)
          .Append("? other)\n");
        if (RefOnly)
        {
            WriteRefStubExpressionBody(sb);
            sb.Append(Indent).Append("public override bool Equals(object? obj)\n");
            WriteRefStubExpressionBody(sb);
            sb.Append(Indent).Append("public override int GetHashCode()\n");
            WriteRefStubExpressionBody(sb);
            sb.Append(Indent).Append("public static bool operator ==(").Append(entity.Name).Append("? left, ")
              .Append(entity.Name).Append("? right)\n");
            WriteRefStubExpressionBody(sb);
            sb.Append(Indent).Append("public static bool operator !=(").Append(entity.Name).Append("? left, ")
              .Append(entity.Name).Append("? right)\n");
            WriteRefStubExpressionBody(sb);
        }
        else
        {
            sb.Append(Indent).Append(Indent).Append("=> other is not null && Id.Equals(other.Id);\n");
            sb.Append(Indent).Append("public override bool Equals(object? obj)\n");
            sb.Append(Indent).Append(Indent).Append("=> Equals(obj as ")
              .Append(entity.Name).Append(");\n");
            sb.Append(Indent).Append("public override int GetHashCode()\n");
            sb.Append(Indent).Append(Indent).Append("=> Id.GetHashCode();\n");
            // Operators so `==`/`!=` compare by identity too (else they'd fall back to
            // reference equality), matching enums and value objects.
            sb.Append(Indent).Append("public static bool operator ==(").Append(entity.Name).Append("? left, ")
              .Append(entity.Name).Append("? right)\n");
            sb.Append(Indent).Append(Indent).Append("=> left is null ? right is null : left.Equals(right);\n");
            sb.Append(Indent).Append("public static bool operator !=(").Append(entity.Name).Append("? left, ")
              .Append(entity.Name).Append("? right)\n");
            sb.Append(Indent).Append(Indent).Append("=> !(left == right);\n");
        }

        // Issue #795: when RegexMode.SourceGenerated collected [GeneratedRegex] methods while rendering this
        // entity's guards (invariants / command preconditions), append them inside the class body and stamp
        // `partial` on the declaration. Skipped entirely (byte-identical) under the default Inline mode. (The
        // generated identity value object is hand-emitted with no `matches` guard, so it never needs this.)
        if (translator.GeneratedRegexMethods.Count > 0)
        {
            WriteGeneratedRegexMethods(sb, translator);
            StampPartial(sb, declaration);
        }

        sb.Append("}\n");

        var contents = Assemble(emit, ns, sb.ToString(),
            EntityUsesLinq(entity) || SpecBodiesUseLinq(entity.Name, index), entity.Span, out var sourceMap);
        return new EmittedFile(PathFor(emit, ns, isRoot ? KindFolder.Root : KindFolder.Entities, $"{entity.Name}.cs"), contents, sourceMap);
    }

    /// <summary>
    /// Emits a strongly-typed identity value object per its strategy (R11.1):
    /// <list type="bullet">
    /// <item><b>Guid</b> (default): wraps a <c>Guid</c> with a client-side <c>New()</c>.</item>
    /// <item><b>Sequence</b>: wraps a store-assigned <c>long</c>; no <c>New()</c>.</item>
    /// <item><b>Natural(String)</b>: wraps a non-blank <c>string</c>, validated at
    /// construction; no <c>New()</c>. <b>Natural(Int)</b> wraps an <c>int</c>.</item>
    /// </list>
    /// All strategies have value equality on the wrapped <c>Value</c>.
    /// </summary>
    private EmittedFile EmitIdValueObject(
        EmitContext emit,
        string idName, string ns,
        IdentityStrategy strategy = IdentityStrategy.Guid, string? backing = null)
    {
        var backingType = strategy switch
        {
            IdentityStrategy.Sequence => "long",
            IdentityStrategy.Natural => backing == "Int" ? "int" : "string",
            _ => "Guid"
        };
        var validates = strategy == IdentityStrategy.Natural && backingType == "string";

        var sb = new StringBuilder();

        sb.Append("/// <summary>A strongly-typed identity value object.</summary>\n");
        sb.Append("public sealed class ").Append(idName).Append(" : ValueObject\n");
        sb.Append("{\n");
        sb.Append(Indent).Append("public ").Append(backingType).Append(" Value { get; }\n\n");

        if (RefOnly)
        {
            sb.Append(Indent).Append("public ").Append(idName).Append('(').Append(backingType)
              .Append(" value)\n");
            sb.Append(Indent).Append("{\n");
            WriteRefStubBlockBody(sb);
            sb.Append('\n');
            if (strategy == IdentityStrategy.Guid)
            {
                sb.Append(Indent).Append("public static ").Append(idName).Append(" New()\n");
                WriteRefStubExpressionBody(sb);
                sb.Append('\n');
            }

            sb.Append(Indent).Append("protected override IEnumerable<object?> GetEqualityComponents()\n");
            sb.Append(Indent).Append("{\n");
            WriteRefStubBlockBody(sb);
            sb.Append("}\n");
            return new EmittedFile(PathFor(emit, ns, KindFolder.ValueObjects, $"{idName}.cs"), Assemble(emit, ns, sb.ToString(), usesLinq: false));
        }

        if (validates)
        {
            // A natural string key cannot be blank — it is the aggregate's real-world identity.
            sb.Append(Indent).Append("public ").Append(idName).Append("(string value)\n");
            sb.Append(Indent).Append("{\n");
            sb.Append(Indent).Append(Indent).Append("if (string.IsNullOrWhiteSpace(value))\n");
            sb.Append(Indent).Append(Indent).Append("{\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append("throw new DomainInvariantViolationException(\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("type: nameof(").Append(idName).Append("),\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("rule: \"identity value cannot be blank\");\n");
            sb.Append(Indent).Append(Indent).Append("}\n");
            sb.Append(Indent).Append(Indent).Append("Value = value;\n");
            sb.Append(Indent).Append("}\n\n");
        }
        else
        {
            sb.Append(Indent).Append("public ").Append(idName).Append('(').Append(backingType)
              .Append(" value)\n");
            sb.Append(Indent).Append(Indent).Append("=> Value = value;\n\n");
        }

        // Only a Guid identity is generated client-side; sequence/natural keys are
        // supplied by the store or the caller respectively.
        if (strategy == IdentityStrategy.Guid)
        {
            sb.Append(Indent).Append("public static ").Append(idName).Append(" New()\n");
            sb.Append(Indent).Append(Indent).Append("=> new(Guid.NewGuid());\n\n");
        }

        sb.Append(Indent).Append("protected override IEnumerable<object?> GetEqualityComponents()\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("yield return Value;\n");
        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");

        return new EmittedFile(PathFor(emit, ns, KindFolder.ValueObjects, $"{idName}.cs"), Assemble(emit, ns, sb.ToString(), usesLinq: false));
    }
}
