using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The smart-enum slice of <see cref="PythonEmitter"/>. A Koine <c>enum</c> emits as a Python
/// <c>enum.Enum</c> whose <c>.value</c> is the declaration-order ordinal (0, 1, 2, …) — matching the
/// C# <c>Value</c> and the TypeScript <c>value</c> — so the three backends agree on the wire/ordinal
/// identity of every member.
/// <list type="bullet">
///   <item>
///     <b>Plain enum</b> (no associated data): one <c>MEMBER = ordinal</c> per member, names in
///     <c>UPPER_SNAKE</c>.
///   </item>
///   <item>
///     <b>Associated-data enum</b> (<see cref="EnumDecl.HasAssociatedData"/>): the tuple + custom
///     <c>__init__</c> idiom — each member value is a tuple whose first element is the ordinal and
///     whose remaining elements are the literal data; <c>__init__</c> unpacks the tuple, sets
///     <c>self._value_</c> to the ordinal (so <c>.value</c> stays the ordinal), and assigns the data
///     fields as typed instance attributes. Bare class-level annotations declare the attribute types
///     for <c>mypy --strict</c> without creating extra members.
///   </item>
/// </list>
/// Every enum carries the smart-enum surface that mirrors C#/TS: <c>from_name</c>/<c>from_value</c>
/// (raising on a miss), non-raising <c>try_from_name</c>/<c>try_from_value</c>, and exhaustive
/// <c>match</c>/<c>switch</c> that dispatch one zero-arg callable per member and raise on an
/// unhandled member (the closed-set safety a bare Python enum cannot give).
/// </summary>
public sealed partial class PythonEmitter
{
    private EmittedFile EmitEnum(PyEmitContext emit, EnumDecl @enum, string ns, PythonTypeMapper typeMapper)
    {
        var name = PythonNaming.ToPascalCase(@enum.Name);
        IReadOnlyList<Param> sig = @enum.Signature;
        var hasData = @enum.HasAssociatedData;

        // Associated-data args are literal expressions; reuse the translator so string escaping and
        // the Decimal-safe rendering match the rest of the emitted code. No members are in scope —
        // an enum's data values are constants.
        var translator = new PythonExpressionTranslator(emit.Index, Array.Empty<Member>(), emit.EnumMemberToType, typeMapper, ContextOf(ns), regexMatchTimeoutMs: _options.RegexMatchTimeoutMs);

        // The per-member callable parameters / dispatch arms (snake_case, keyword-escaped).
        var arms = @enum.Members.Select(m => PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(m.Name))).ToList();
        var memberConsts = @enum.Members.Select(m => PythonNaming.EscapeIdentifier(PythonNaming.ToUpperSnake(m.Name))).ToList();

        var sb = new StringBuilder();

        // A module-level TypeVar gives `match` a generic return without the 3.12 `def match[T]`
        // syntax (the floor is 3.11).
        sb.Append("_T = TypeVar(\"_T\")\n\n\n");

        sb.Append("class ").Append(name).Append("(enum.Enum):\n");
        WriteDoc(sb, @enum.Doc ?? "A type-safe smart enum: ordinal value, lookups, exhaustive match/switch.", Indent);

        // Associated-data fields: bare class-level annotations declare the instance-attribute types
        // for mypy (these do NOT create enum members — only the assigned names below do).
        if (hasData)
        {
            foreach (Param p in sig)
            {
                sb.Append(Indent).Append(PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(p.Name)))
                  .Append(": ").Append(typeMapper.Map(p.Type)).Append('\n');
            }
        }

        // Members, declaration order. Plain: `MEMBER = ordinal`. Associated: `MEMBER = (ordinal, …data)`.
        for (var i = 0; i < @enum.Members.Count; i++)
        {
            EnumMember member = @enum.Members[i];
            WriteDoc(sb, member.Doc, Indent);
            sb.Append(Indent).Append(memberConsts[i]).Append(" = ");
            if (hasData)
            {
                sb.Append('(').Append(i);
                for (var j = 0; j < sig.Count && j < member.Args.Count; j++)
                {
                    sb.Append(", ").Append(translator.Translate(member.Args[j], PythonExpressionTranslator.NameMode.Property));
                }
                sb.Append(')');
            }
            else
            {
                sb.Append(i);
            }
            sb.Append('\n');
        }

        // The custom __init__ for associated data: unpack (ordinal, …data), pin `.value` to the
        // ordinal, and assign each data field as a typed instance attribute.
        if (hasData)
        {
            var initParams = new List<string> { "ordinal: int" };
            initParams.AddRange(sig.Select(p =>
                PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(p.Name)) + ": " + typeMapper.Map(p.Type)));

            sb.Append('\n');
            sb.Append(Indent).Append("def __init__(self, ").Append(string.Join(", ", initParams)).Append(") -> None:\n");
            sb.Append(Indent).Append(Indent).Append("self._value_ = ordinal\n");
            foreach (Param p in sig)
            {
                var field = PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(p.Name));
                sb.Append(Indent).Append(Indent).Append("self.").Append(field).Append(" = ").Append(field).Append('\n');
            }
        }

        // Lookups. from_name/from_value raise on a miss; try_from_* return Optional.
        sb.Append('\n');
        sb.Append(Indent).Append("@classmethod\n");
        sb.Append(Indent).Append("def from_name(cls, name: str) -> ").Append(name).Append(":\n");
        sb.Append(Indent).Append(Indent).Append("\"\"\"The member with this name, raising if none matches.\"\"\"\n");
        sb.Append(Indent).Append(Indent).Append("for member in cls:\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("if member.name == name:\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("return member\n");
        sb.Append(Indent).Append(Indent).Append("raise DomainInvariantViolationError(\"").Append(name)
          .Append("\", f\"no ").Append(name).Append(" with name {name!r}\")\n\n");

        sb.Append(Indent).Append("@classmethod\n");
        sb.Append(Indent).Append("def from_value(cls, value: int) -> ").Append(name).Append(":\n");
        sb.Append(Indent).Append(Indent).Append("\"\"\"The member with this ordinal value, raising if none matches.\"\"\"\n");
        sb.Append(Indent).Append(Indent).Append("for member in cls:\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("if member.value == value:\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("return member\n");
        sb.Append(Indent).Append(Indent).Append("raise DomainInvariantViolationError(\"").Append(name)
          .Append("\", f\"no ").Append(name).Append(" with value {value}\")\n\n");

        sb.Append(Indent).Append("@classmethod\n");
        sb.Append(Indent).Append("def try_from_name(cls, name: str) -> ").Append(name).Append(" | None:\n");
        sb.Append(Indent).Append(Indent).Append("\"\"\"The member with this name, or None if none matches.\"\"\"\n");
        sb.Append(Indent).Append(Indent).Append("for member in cls:\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("if member.name == name:\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("return member\n");
        sb.Append(Indent).Append(Indent).Append("return None\n\n");

        sb.Append(Indent).Append("@classmethod\n");
        sb.Append(Indent).Append("def try_from_value(cls, value: int) -> ").Append(name).Append(" | None:\n");
        sb.Append(Indent).Append(Indent).Append("\"\"\"The member with this ordinal value, or None if none matches.\"\"\"\n");
        sb.Append(Indent).Append(Indent).Append("for member in cls:\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("if member.value == value:\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("return member\n");
        sb.Append(Indent).Append(Indent).Append("return None\n");

        // Exhaustive match: one zero-arg callable per member, dispatched on identity. A trailing
        // raise keeps it exhaustive (adding a member without handling it fails at runtime, the
        // closed-set analogue of the C# compile error).
        WriteMatch(sb, name, @enum.Members, arms, memberConsts);
        WriteSwitch(sb, name, @enum.Members, arms, memberConsts);

        return new EmittedFile(
            PathFor(ns, KindFolder.Enums, @enum.Name),
            Assemble(emit, ns, sb.ToString(), name));
    }

    /// <summary>The exhaustive, value-returning <c>match</c> (mirrors C# <c>Match&lt;TResult&gt;</c>).</summary>
    private void WriteMatch(StringBuilder sb, string name, IReadOnlyList<EnumMember> members, IReadOnlyList<string> arms, IReadOnlyList<string> consts)
    {
        sb.Append('\n');
        var kwParams = string.Join(", ", arms.Select(a => a + ": Callable[[], _T]"));
        sb.Append(Indent).Append("def match(self, *, ").Append(kwParams).Append(") -> _T:\n");
        sb.Append(Indent).Append(Indent).Append("\"\"\"Dispatch to the handler for this member, raising if unhandled.\"\"\"\n");
        for (var i = 0; i < members.Count; i++)
        {
            sb.Append(Indent).Append(Indent).Append("if self is ").Append(name).Append('.').Append(consts[i]).Append(":\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append("return ").Append(arms[i]).Append("()\n");
        }
        sb.Append(Indent).Append(Indent).Append("raise DomainInvariantViolationError(\"").Append(name)
          .Append("\", f\"unhandled ").Append(name).Append(" {self.name}\")\n");
    }

    /// <summary>The exhaustive, side-effecting <c>switch</c> (mirrors C# <c>Switch</c>).</summary>
    private void WriteSwitch(StringBuilder sb, string name, IReadOnlyList<EnumMember> members, IReadOnlyList<string> arms, IReadOnlyList<string> consts)
    {
        sb.Append('\n');
        var kwParams = string.Join(", ", arms.Select(a => a + ": Callable[[], None]"));
        sb.Append(Indent).Append("def switch(self, *, ").Append(kwParams).Append(") -> None:\n");
        sb.Append(Indent).Append(Indent).Append("\"\"\"Dispatch to the side-effecting handler for this member, raising if unhandled.\"\"\"\n");
        for (var i = 0; i < members.Count; i++)
        {
            sb.Append(Indent).Append(Indent).Append("if self is ").Append(name).Append('.').Append(consts[i]).Append(":\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append(arms[i]).Append("()\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append("return\n");
        }
        sb.Append(Indent).Append(Indent).Append("raise DomainInvariantViolationError(\"").Append(name)
          .Append("\", f\"unhandled ").Append(name).Append(" {self.name}\")\n");
    }
}
