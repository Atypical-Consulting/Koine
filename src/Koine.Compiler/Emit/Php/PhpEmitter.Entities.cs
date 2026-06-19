using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Php;

/// <summary>
/// The entity slice of <see cref="PhpEmitter"/>. A Koine <c>entity</c> emits as a PHP 8.1
/// <c>class</c> (mutable — later tasks' commands reassign properties) with typed properties, an
/// explicit constructor that assigns the fields then evaluates invariants (throwing
/// <c>\Koine\Runtime\DomainInvariantViolationException</c> on failure), derived members as getter
/// methods, and identity <c>equals(self $other): bool</c> that compares runtime type and
/// <c>id</c> alone.
/// <para>
/// Each entity also emits its branded identity value object (<c>&lt;XId&gt;</c>) as a
/// <c>final class</c> (immutable, value-object style) per the entity's
/// <see cref="IdentityStrategy"/>:
/// <list type="bullet">
///   <item><b>Guid</b> — wraps a <c>string</c> UUID and gets a <c>generate()</c> static factory
///   that mints a fresh UUID v4 via <c>bin2hex(random_bytes(16))</c>.</item>
///   <item><b>Natural(String)</b> — wraps a <c>string</c>; no factory (caller-supplied).</item>
///   <item><b>Natural(Int)</b> — wraps an <c>int</c>; no factory.</item>
///   <item><b>Sequence</b> — wraps a store-assigned <c>int</c>; no factory.</item>
/// </list>
/// </para>
/// <para>
/// Commands, factories, and state machines are NOT emitted here (later tasks): the entity is
/// data + identity + invariants + computed properties for now.
/// </para>
/// </summary>
public sealed partial class PhpEmitter
{
    // -------------------------------------------------------------------------
    // Entity (mutable class with identity equality)
    // -------------------------------------------------------------------------

    private void EmitEntity(
        PhpEmitContext emit,
        List<EmittedFile> files,
        EntityDecl entity,
        string contextName,
        PhpTypeMapper typeMapper)
    {
        // 1. Emit the branded identity value object.
        files.Add(EmitIdType(emit, entity.IdentityName, contextName, entity.IdStrategy, entity.IdBackingType));

        // 2. Emit the entity class itself.
        files.Add(EmitEntityClass(emit, entity, contextName, typeMapper));
    }

    private EmittedFile EmitEntityClass(
        PhpEmitContext emit,
        EntityDecl entity,
        string contextName,
        PhpTypeMapper typeMapper)
    {
        var name = PhpNaming.ClassName(entity.Name);
        var idTypeName = PhpNaming.ClassName(entity.IdentityName);
        var memberNames = new HashSet<string>(entity.Members.Select(m => m.Name), StringComparer.Ordinal);

        // Stored/defaulted members get constructor-promoted properties; derived members become getters.
        var fields = entity.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = entity.Members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();

        // Augment scope with the synthetic `id` property so invariants/derived members can reference it.
        var scopeMembers = entity.Members
            .Append(new Member("id", new TypeRef(entity.IdentityName), null))
            .ToList();

        var translator = new PhpExpressionTranslator(
            emit.Index,
            scopeMembers,
            emit.EnumMemberToType,
            typeMapper);

        var sb = new StringBuilder();

        WriteDoc(sb, entity.Doc, "");

        sb.Append("class ").Append(name).Append('\n');
        sb.Append("{\n");

        // Public typed properties (not promoted — entity is mutable, properties may be reassigned
        // by commands in later tasks). The identity property is declared separately.
        sb.Append(Indent).Append("public ").Append(idTypeName).Append(" $id;\n");

        foreach (Member m in fields)
        {
            WriteDoc(sb, m.Doc, Indent);
            var propName = PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(m.Name));
            var typeName = typeMapper.Map(m.Type);
            sb.Append(Indent).Append("public ").Append(typeName).Append(" $").Append(propName).Append(";\n");
        }

        sb.Append('\n');

        // Constructor: accepts id + all stored fields, assigns properties, checks invariants.
        WriteEntityConstructor(sb, name, idTypeName, fields, entity.Invariants, translator, typeMapper);

        // Derived (computed) members as public getter methods.
        foreach (Member m in derived)
        {
            sb.Append('\n');
            WriteDoc(sb, m.Doc, Indent);
            var methodName = PhpNaming.MethodName(m.Name);
            var returnType = typeMapper.Map(m.Type);
            sb.Append(Indent).Append("public function ").Append(methodName).Append("(): ").Append(returnType).Append('\n');
            sb.Append(Indent).Append("{\n");
            sb.Append(Indent).Append(Indent).Append("return ")
              .Append(translator.Translate(m.Initializer!)).Append(";\n");
            sb.Append(Indent).Append("}\n");
        }

        // Identity equality: compares runtime type (via instanceof) and id only.
        sb.Append('\n');
        WriteEntityEquals(sb, name);

        sb.Append("}\n");

        return new EmittedFile(
            PathFor(contextName, KindFolder.Entities, entity.Name),
            Assemble(contextName, KindFolder.Entities, sb.ToString(), name));
    }

    // -------------------------------------------------------------------------
    // Entity constructor
    // -------------------------------------------------------------------------

    private static void WriteEntityConstructor(
        StringBuilder sb,
        string className,
        string idTypeName,
        IReadOnlyList<Member> fields,
        IReadOnlyList<Invariant> invariants,
        PhpExpressionTranslator translator,
        PhpTypeMapper typeMapper)
    {
        sb.Append(Indent).Append("public function __construct(\n");

        // The identity parameter comes first.
        sb.Append(Indent).Append(Indent).Append(idTypeName).Append(" $id");
        if (fields.Count > 0)
        {
            sb.Append(",\n");
        }

        // All stored fields as plain parameters (not constructor-promoted because the entity
        // must be mutable — promoted readonly would prevent reassignment in commands).
        for (int i = 0; i < fields.Count; i++)
        {
            Member m = fields[i];
            var paramName = PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(m.Name));
            var typeName = typeMapper.Map(m.Type);
            sb.Append(Indent).Append(Indent).Append(typeName).Append(" $").Append(paramName);

            // Default value for constant-initializer fields.
            if (m.Initializer is not null
                && !MemberAnalysis.IsDerived(m, fields.Select(f => f.Name).ToHashSet()))
            {
                var defaultVal = translator.Translate(m.Initializer, PhpExpressionTranslator.NameMode.Parameter);
                sb.Append(" = ").Append(defaultVal);
            }
            else if (m.Type.IsOptional)
            {
                sb.Append(" = null");
            }

            var sep = i < fields.Count - 1 ? "," : "";
            sb.Append(sep).Append('\n');
        }

        sb.Append(Indent).Append(") {\n");

        // Assign all properties.
        sb.Append(Indent).Append(Indent).Append("$this->id = $id;\n");
        foreach (Member m in fields)
        {
            var propName = PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(m.Name));
            sb.Append(Indent).Append(Indent).Append("$this->").Append(propName).Append(" = $").Append(propName).Append(";\n");
        }

        // Invariant checks.
        foreach (Invariant inv in invariants)
        {
            WriteInvariantGuard(sb, className, inv, translator);
        }

        sb.Append(Indent).Append("}\n");
    }

    // -------------------------------------------------------------------------
    // Identity equals
    // -------------------------------------------------------------------------

    private static void WriteEntityEquals(StringBuilder sb, string className)
    {
        sb.Append(Indent).Append("public function equals(self $other): bool\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("return $other instanceof ").Append(className)
          .Append(" && $this->id === $other->id;\n");
        sb.Append(Indent).Append("}\n");
    }

    // -------------------------------------------------------------------------
    // Branded identity value object (per IdentityStrategy)
    // -------------------------------------------------------------------------

    /// <summary>
    /// Emits an entity's branded <c>&lt;XId&gt;</c> as a <c>final class</c> (immutable,
    /// value-object style). The backing field and the optional <c>generate()</c> factory follow
    /// the identity strategy:
    /// <list type="bullet">
    ///   <item><b>Guid</b> — <c>string $value</c> + a <c>generate()</c> static factory minting
    ///   a fresh UUID v4 via <c>bin2hex(random_bytes(16))</c> formatted as a UUID string.</item>
    ///   <item><b>Natural(String)</b> — <c>string $value</c>; no <c>generate()</c>.</item>
    ///   <item><b>Natural(Int)</b> — <c>int $value</c>; no <c>generate()</c>.</item>
    ///   <item><b>Sequence</b> — <c>int $value</c> (store-assigned); no <c>generate()</c>.</item>
    /// </list>
    /// </summary>
    private EmittedFile EmitIdType(
        PhpEmitContext emit,
        string idRaw,
        string contextName,
        IdentityStrategy strategy,
        string? backing)
    {
        var idName = PhpNaming.ClassName(idRaw);
        var backingType = strategy switch
        {
            IdentityStrategy.Sequence => "int",
            IdentityStrategy.Natural => backing == "Int" ? "int" : "string",
            _ => "string"   // Guid wraps a UUID string
        };

        var sb = new StringBuilder();

        sb.Append("/** A strongly-typed, branded identity value object. */\n");
        sb.Append("final class ").Append(idName).Append('\n');
        sb.Append("{\n");

        // Constructor-promoted readonly property (the id is immutable once created).
        sb.Append(Indent).Append("public function __construct(\n");
        sb.Append(Indent).Append(Indent).Append("public readonly ").Append(backingType)
          .Append(" $value\n");
        sb.Append(Indent).Append(") {}\n");

        // A Guid identity gets a generate() factory; sequence/natural keys are supplied externally.
        if (strategy == IdentityStrategy.Guid)
        {
            sb.Append('\n');
            sb.Append(Indent).Append("/** Mints a fresh ").Append(idName).Append(" (a random UUID v4). */\n");
            sb.Append(Indent).Append("public static function generate(): self\n");
            sb.Append(Indent).Append("{\n");
            // PHP 8.1 UUID v4 generation via random_bytes, formatted as xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx.
            sb.Append(Indent).Append(Indent).Append("$bytes = random_bytes(16);\n");
            sb.Append(Indent).Append(Indent).Append("$bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);\n");
            sb.Append(Indent).Append(Indent).Append("$bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);\n");
            sb.Append(Indent).Append(Indent).Append("$hex = bin2hex($bytes);\n");
            sb.Append(Indent).Append(Indent).Append("$uuid = sprintf(\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append("'%s-%s-%s-%s-%s',\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append("substr($hex, 0, 8),\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append("substr($hex, 8, 4),\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append("substr($hex, 12, 4),\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append("substr($hex, 16, 4),\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append("substr($hex, 20)\n");
            sb.Append(Indent).Append(Indent).Append(");\n");
            sb.Append(Indent).Append(Indent).Append("return new self($uuid);\n");
            sb.Append(Indent).Append("}\n");
        }

        // Value equality.
        sb.Append('\n');
        sb.Append(Indent).Append("public function equals(self $other): bool\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("return $this->value === $other->value;\n");
        sb.Append(Indent).Append("}\n");

        sb.Append("}\n");

        return new EmittedFile(
            PathFor(contextName, KindFolder.ValueObjects, idRaw),
            Assemble(contextName, KindFolder.ValueObjects, sb.ToString(), idName));
    }
}
