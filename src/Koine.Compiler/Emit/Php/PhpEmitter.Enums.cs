using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Php;

/// <summary>
/// The smart-enum slice of <see cref="PhpEmitter"/>. A Koine <c>enum</c> emits as a PHP 8.1
/// <c>int</c>-backed enum (<c>enum E: int</c>) whose case values are declaration-order ordinals
/// (0, 1, 2, …) — matching the C#, TypeScript, and Python backends so all four agree on the
/// wire/ordinal identity of every member.
/// <list type="bullet">
///   <item>
///     <b>Plain enum</b> (no associated data): one <c>case MEMBER = ordinal;</c> per member,
///     names in UPPER_SNAKE to match the expression translator's
///     <see cref="PhpNaming.ConstName"/> references.
///   </item>
///   <item>
///     <b>Associated-data enum</b> (<see cref="EnumDecl.HasAssociatedData"/>): PHP backed-enum
///     cases cannot carry per-case instance state, so each associated field is emitted as a
///     public method that dispatches via <c>match($this)</c> and returns the per-member literal.
///   </item>
/// </list>
/// Every enum carries the smart-enum surface that mirrors C#/TS/Python:
/// <list type="bullet">
///   <item><c>fromName(string $name): self</c> — raises <see cref="\ValueError"/> on miss.</item>
///   <item><c>tryFromName(string $name): ?self</c> — returns null on miss.</item>
///   <item><c>fromValue(int $value): self</c> — thin alias for the built-in <c>from()</c>.</item>
///   <item><c>tryFromValue(int $value): ?self</c> — thin alias for <c>tryFrom()</c>.</item>
///   <item>
///     Exhaustive <c>match</c> (value-returning) and <c>switch_</c> (side-effecting): one
///     zero-arg callable per member, dispatched via <c>match($this)</c>, throwing
///     <see cref="\Koine\Runtime\DomainInvariantViolationException"/> on an unhandled member.
///   </item>
/// </list>
/// </summary>
public sealed partial class PhpEmitter
{
    private EmittedFile EmitEnum(PhpEmitContext emit, EnumDecl @enum, string contextName, PhpTypeMapper typeMapper)
    {
        var name = PhpNaming.ClassName(@enum.Name);
        IReadOnlyList<Param> sig = @enum.Signature;
        var hasData = @enum.HasAssociatedData;

        // For associated-data arms: translate literal args (no members in scope for an enum).
        var translator = new PhpExpressionTranslator(
            emit.Index,
            Array.Empty<Member>(),
            emit.EnumMemberToType,
            typeMapper);

        // PHP enum case names: UPPER_SNAKE, so they align with the expression translator's
        // PhpNaming.ConstName references (e.g. `OrderStatus::CANCELLED`).
        var caseNames = @enum.Members
            .Select(m => PhpNaming.ConstName(m.Name))
            .ToList();

        var sb = new StringBuilder();

        WriteDoc(sb, @enum.Doc, "");

        // PHP 8.1 backed enum with int backing (ordinal identity).
        sb.Append("enum ").Append(name).Append(": int\n");
        sb.Append("{\n");

        // Cases with ordinal values.
        for (var i = 0; i < @enum.Members.Count; i++)
        {
            EnumMember member = @enum.Members[i];
            WriteDoc(sb, member.Doc, Indent);
            sb.Append(Indent).Append("case ").Append(caseNames[i]).Append(" = ").Append(i).Append(";\n");
        }

        // Associated-data fields as match-based methods.
        if (hasData)
        {
            foreach (Param p in sig)
            {
                sb.Append('\n');
                var methodName = PhpNaming.EscapeIdentifier(PhpNaming.MethodName(p.Name));
                var returnType = typeMapper.Map(p.Type);
                sb.Append(Indent).Append("public function ").Append(methodName).Append("(): ").Append(returnType).Append('\n');
                sb.Append(Indent).Append("{\n");
                sb.Append(Indent).Append(Indent).Append("return match($this) {\n");
                for (var i = 0; i < @enum.Members.Count; i++)
                {
                    EnumMember member = @enum.Members[i];
                    var paramIdx = sig.TakeWhile(pp => pp.Name != p.Name).Count();
                    var argExpr = paramIdx < member.Args.Count
                        ? translator.Translate(member.Args[paramIdx])
                        : "null";
                    sb.Append(Indent).Append(Indent).Append(Indent)
                      .Append("self::").Append(caseNames[i]).Append(" => ").Append(argExpr).Append(",\n");
                }
                sb.Append(Indent).Append(Indent).Append("};\n");
                sb.Append(Indent).Append("}\n");
            }
        }

        // Smart-enum surface: fromName / tryFromName.
        sb.Append('\n');
        sb.Append(Indent).Append("/** The member with this name, or throws \\ValueError if none matches. */\n");
        sb.Append(Indent).Append("public static function fromName(string $name): self\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("foreach (self::cases() as $case) {\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("if ($case->name === $name) {\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("return $case;\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append(Indent).Append("throw new \\ValueError(\"No ").Append(name)
          .Append(" with name '$name'\");\n");
        sb.Append(Indent).Append("}\n");

        sb.Append('\n');
        sb.Append(Indent).Append("/** The member with this name, or null if none matches. */\n");
        sb.Append(Indent).Append("public static function tryFromName(string $name): ?self\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("foreach (self::cases() as $case) {\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("if ($case->name === $name) {\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("return $case;\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append(Indent).Append("return null;\n");
        sb.Append(Indent).Append("}\n");

        // fromValue / tryFromValue: thin aliases over the built-in from()/tryFrom().
        sb.Append('\n');
        sb.Append(Indent).Append("/** The member with this ordinal value (alias for from()), or throws \\ValueError on miss. */\n");
        sb.Append(Indent).Append("public static function fromValue(int $value): self\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("return self::from($value);\n");
        sb.Append(Indent).Append("}\n");

        sb.Append('\n');
        sb.Append(Indent).Append("/** The member with this ordinal value (alias for tryFrom()), or null on miss. */\n");
        sb.Append(Indent).Append("public static function tryFromValue(int $value): ?self\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("return self::tryFrom($value);\n");
        sb.Append(Indent).Append("}\n");

        // Exhaustive match (value-returning) and switch_ (side-effecting).
        WriteEnumMatch(sb, name, @enum.Members, caseNames);
        WriteEnumSwitch(sb, name, @enum.Members, caseNames);

        sb.Append("}\n");

        return new EmittedFile(
            PathFor(contextName, KindFolder.Enums, @enum.Name),
            Assemble(contextName, KindFolder.Enums, sb.ToString(), name));
    }

    /// <summary>
    /// Emits the exhaustive value-returning <c>match</c> method: one zero-arg callable per member,
    /// dispatched via PHP's <c>match($this)</c>, throwing on an unhandled member.
    /// </summary>
    private static void WriteEnumMatch(
        StringBuilder sb, string name,
        IReadOnlyList<EnumMember> members, IReadOnlyList<string> caseNames)
    {
        sb.Append('\n');
        // Build the parameter list: one Closure per member in camelCase.
        var paramNames = members.Select((m, i) =>
            "$" + PhpNaming.EscapeIdentifier(PhpNaming.MethodName(m.Name))).ToList();
        var paramList = string.Join(", ", paramNames.Select(p => "\\Closure " + p));
        sb.Append(Indent).Append("/** Dispatch to the handler for this member; throws if unhandled. */\n");
        sb.Append(Indent).Append("public function match(").Append(paramList).Append("): mixed\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("return match($this) {\n");
        for (var i = 0; i < members.Count; i++)
        {
            sb.Append(Indent).Append(Indent).Append(Indent)
              .Append("self::").Append(caseNames[i]).Append(" => (").Append(paramNames[i]).Append(")(),\n");
        }
        // Default arm throws for safety (future members).
        sb.Append(Indent).Append(Indent).Append(Indent)
          .Append("default => throw new \\Koine\\Runtime\\DomainInvariantViolationException(\"")
          .Append(name).Append("\", \"unhandled ").Append(name).Append(" {$this->name}\"),\n");
        sb.Append(Indent).Append(Indent).Append("};\n");
        sb.Append(Indent).Append("}\n");
    }

    /// <summary>
    /// Emits the exhaustive side-effecting <c>switch_</c> method (named <c>switch_</c> because
    /// <c>switch</c> is a PHP reserved word): one zero-arg <see cref="\Closure"/> per member,
    /// dispatched via <c>match($this)</c>.
    /// </summary>
    private static void WriteEnumSwitch(
        StringBuilder sb, string name,
        IReadOnlyList<EnumMember> members, IReadOnlyList<string> caseNames)
    {
        sb.Append('\n');
        var paramNames = members.Select(m =>
            "$" + PhpNaming.EscapeIdentifier(PhpNaming.MethodName(m.Name))).ToList();
        var paramList = string.Join(", ", paramNames.Select(p => "\\Closure " + p));
        sb.Append(Indent).Append("/** Dispatch to the side-effecting handler for this member; throws if unhandled. */\n");
        sb.Append(Indent).Append("public function switch_(").Append(paramList).Append("): void\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("match($this) {\n");
        for (var i = 0; i < members.Count; i++)
        {
            sb.Append(Indent).Append(Indent).Append(Indent)
              .Append("self::").Append(caseNames[i]).Append(" => (").Append(paramNames[i]).Append(")(),\n");
        }
        sb.Append(Indent).Append(Indent).Append(Indent)
          .Append("default => throw new \\Koine\\Runtime\\DomainInvariantViolationException(\"")
          .Append(name).Append("\", \"unhandled ").Append(name).Append(" {$this->name}\"),\n");
        sb.Append(Indent).Append(Indent).Append("};\n");
        sb.Append(Indent).Append("}\n");
    }
}
