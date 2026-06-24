using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Rust;

/// <summary>
/// The entity slice of <see cref="RustEmitter"/>. A Koine <c>entity</c> emits as a struct with an
/// <c>id</c> field plus its members, identity-based equality (<c>PartialEq</c>/<c>Eq</c>/<c>Hash</c>
/// over the id only), a smart constructor running invariants, accessors, derived (computed) methods,
/// and one <c>&amp;mut self</c> method per command — each checking its preconditions, applying its
/// state transitions, re-checking the entity invariants, and returning <c>Result</c>. The branded ID
/// value object is emitted as a newtype next to the entity.
/// </summary>
public sealed partial class RustEmitter
{
    private void EmitEntity(StringBuilder body, RustEmitContext emit, EntityDecl entity, string context)
    {
        var typeMapper = new RustTypeMapper(emit.Index, context, _options);

        // The branded identity newtype.
        EmitIdType(body, entity.IdentityName, IdBacking(entity));

        var name = RustNaming.ToPascalCase(entity.Name);
        var idType = RustNaming.ToPascalCase(entity.IdentityName);
        var memberNames = new HashSet<string>(entity.Members.Select(m => m.Name), StringComparer.Ordinal);
        var stored = entity.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = entity.Members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var required = stored.Where(m => m.Initializer is null).ToList();
        var defaulted = stored.Where(m => m.Initializer is not null).ToList();

        var translator = new RustExpressionTranslator(emit.Index, entity.Members, emit.EnumMemberToType, typeMapper, context);

        // The struct (identity equality, so only Debug/Clone are derived).
        body.Append('\n');
        WriteDoc(body, entity.Doc, string.Empty);
        body.Append("#[derive(Debug, Clone)]\n");
        body.Append("pub struct ").Append(name).Append(" {\n");
        body.Append(Indent).Append("id: ").Append(idType).Append(",\n");
        foreach (Member m in stored)
        {
            WriteDoc(body, m.Doc, Indent);
            body.Append(Indent).Append(RustNaming.Field(m.Name)).Append(": ").Append(typeMapper.Map(m.Type)).Append(",\n");
        }
        body.Append("}\n\n");

        // Identity-based equality and hashing (an entity is its identity).
        body.Append("impl PartialEq for ").Append(name).Append(" {\n");
        body.Append(Indent).Append("fn eq(&self, other: &Self) -> bool { self.id == other.id }\n");
        body.Append("}\n");
        body.Append("impl Eq for ").Append(name).Append(" {}\n");
        body.Append("impl std::hash::Hash for ").Append(name).Append(" {\n");
        body.Append(Indent).Append("fn hash<H: std::hash::Hasher>(&self, state: &mut H) { self.id.hash(state); }\n");
        body.Append("}\n\n");

        // impl: smart constructor + accessors + derived + commands.
        body.Append("impl ").Append(name).Append(" {\n");

        var ctorParams = new List<string> { "id: " + idType };
        ctorParams.AddRange(required.Select(m => RustNaming.Field(m.Name) + ": " + typeMapper.Map(m.Type)));
        body.Append(Indent).Append("/// Creates a validated `").Append(name).Append("`, running its invariants.\n");
        body.Append(Indent).Append("pub fn new(").Append(string.Join(", ", ctorParams)).Append(") -> Result<Self, DomainError> {\n");

        // Defaulted members are bound as locals (so invariants can see them) before the checks.
        foreach (Member m in defaulted)
        {
            body.Append(Indent).Append(Indent).Append("let ").Append(RustNaming.Field(m.Name)).Append(" = ")
                .Append(translator.Translate(m.Initializer!, RustExpressionTranslator.NameMode.Parameter, EnumExpected(m, emit.Index)))
                .Append(";\n");
        }

        foreach (Invariant inv in entity.Invariants)
        {
            WriteInvariantGuard(body, name, inv, translator, Indent + Indent);
        }

        body.Append(Indent).Append(Indent).Append("Ok(Self {\n");
        body.Append(Indent).Append(Indent).Append(Indent).Append("id,\n");
        foreach (Member m in stored)
        {
            body.Append(Indent).Append(Indent).Append(Indent).Append(RustNaming.Field(m.Name)).Append(",\n");
        }
        body.Append(Indent).Append(Indent).Append("})\n");
        body.Append(Indent).Append("}\n");

        // The id accessor, then member accessors and derived methods.
        body.Append('\n');
        body.Append(Indent).Append("pub fn id(&self) -> &").Append(idType).Append(" { &self.id }\n");
        foreach (Member m in stored)
        {
            body.Append('\n');
            WriteAccessor(body, m, typeMapper);
        }
        foreach (Member m in derived)
        {
            body.Append('\n');
            WriteDerived(body, m, translator, typeMapper);
        }

        // Commands: mutating behaviors.
        foreach (CommandDecl cmd in entity.Commands)
        {
            body.Append('\n');
            WriteCommand(body, emit, name, entity, cmd, translator, typeMapper);
        }

        body.Append("}\n");
    }

    /// <summary>Emits one command as a <c>&amp;mut self</c> method returning <c>Result</c>.</summary>
    private void WriteCommand(
        StringBuilder body, RustEmitContext emit, string typeName, EntityDecl entity, CommandDecl cmd,
        RustExpressionTranslator translator, RustTypeMapper typeMapper)
    {
        var method = RustNaming.Field(cmd.Name);
        var paramList = string.Join(", ", cmd.Parameters.Select(p => RustNaming.Field(p.Name) + ": " + typeMapper.Map(p.Type)));
        var sep = paramList.Length > 0 ? ", " : string.Empty;
        var returnType = cmd.ReturnType is { } rt ? typeMapper.Map(rt) : "()";

        // Command parameters are locals while the body is translated (members stay self.<field>).
        foreach (Param p in cmd.Parameters)
        {
            translator.PushLocal(p.Name, p.Type);
        }

        WriteDoc(body, null, Indent);
        body.Append(Indent).Append("pub fn ").Append(method).Append("(&mut self").Append(sep).Append(paramList)
            .Append(") -> Result<").Append(returnType).Append(", DomainError> {\n");

        // 1. Preconditions.
        foreach (RequiresClause stmt in cmd.Body.OfType<RequiresClause>())
        {
            WriteRequires(body, typeName, stmt, translator);
        }

        // 2. State transitions.
        foreach (Transition t in cmd.Body.OfType<Transition>())
        {
            var value = RustExpressionTranslator.StripOuterParens(
                translator.Translate(t.Value, RustExpressionTranslator.NameMode.Property, TransitionEnum(entity, t, emit.Index)));

            // Assigning a non-optional value into an `Option<T>` field (e.g. `started_at <- now`) wraps
            // it in `Some(...)`; an already-optional RHS flows through unchanged.
            Member? field = entity.Members.FirstOrDefault(m => m.Name == t.Field);
            if (field is { Type.IsOptional: true } && !translator.IsOptional(t.Value))
            {
                value = $"Some({value})";
            }

            body.Append(Indent).Append(Indent).Append("self.").Append(RustNaming.Field(t.Field)).Append(" = ")
                .Append(value).Append(";\n");
        }

        // 3. Re-check the entity invariants over the post-transition state.
        foreach (Invariant inv in entity.Invariants)
        {
            WriteInvariantGuard(body, typeName, inv, translator, Indent + Indent, RustExpressionTranslator.NameMode.Property);
        }

        // 4. Result (or unit).
        if (cmd.Body.OfType<ResultClause>().FirstOrDefault() is { } result)
        {
            body.Append(Indent).Append(Indent).Append("Ok(").Append(translator.Translate(result.Value)).Append(")\n");
        }
        else
        {
            body.Append(Indent).Append(Indent).Append("Ok(())\n");
        }

        body.Append(Indent).Append("}\n");

        foreach (Param p in cmd.Parameters)
        {
            translator.PopLocal(p.Name);
        }
    }

    /// <summary>Emits a precondition guard: <c>if !(cond) { return Err(...) }</c> (Property mode).</summary>
    private void WriteRequires(StringBuilder body, string typeName, RequiresClause req, RustExpressionTranslator translator)
    {
        var test = Negate(translator.Translate(req.Condition, RustExpressionTranslator.NameMode.Property));
        body.Append(Indent).Append(Indent).Append("if ").Append(test).Append(" {\n");
        body.Append(Indent).Append(Indent).Append(Indent)
            .Append("return Err(DomainError::InvariantViolation { type_name: \"").Append(typeName)
            .Append("\", rule: ").Append(RuleLiteral(req.Message ?? "precondition failed")).Append(" });\n");
        body.Append(Indent).Append(Indent).Append("}\n");
    }

    /// <summary>The enum type expected on the RHS of a transition (so a bare enum member qualifies).</summary>
    private static string? TransitionEnum(EntityDecl entity, Transition t, ModelIndex index)
    {
        Member? field = entity.Members.FirstOrDefault(m => m.Name == t.Field);
        return field is not null && index.Classify(field.Type.Name) == TypeKind.Enum ? field.Type.Name : null;
    }

    // ----------------------------------------------------------------------
    // Identity newtype
    // ----------------------------------------------------------------------

    /// <summary>Emits a branded identity newtype (e.g. <c>OrderId(String)</c>) with a constructor and accessor.</summary>
    private void EmitIdType(StringBuilder body, string idName, (string RustType, bool IsString) backing)
    {
        var name = RustNaming.ToPascalCase(idName);
        body.Append('\n');
        body.Append("/// A branded identity value.\n");
        body.Append("#[derive(Debug, Clone, PartialEq, Eq, Hash)]\n");
        body.Append("pub struct ").Append(name).Append('(').Append(backing.RustType).Append(");\n\n");
        body.Append("impl ").Append(name).Append(" {\n");
        if (backing.IsString)
        {
            body.Append(Indent).Append("pub fn new(value: impl Into<String>) -> Self { ").Append(name).Append("(value.into()) }\n");
            body.Append(Indent).Append("pub fn value(&self) -> &str { &self.0 }\n");
        }
        else
        {
            body.Append(Indent).Append("pub fn new(value: ").Append(backing.RustType).Append(") -> Self { ").Append(name).Append("(value) }\n");
            body.Append(Indent).Append("pub fn value(&self) -> ").Append(backing.RustType).Append(" { self.0 }\n");
        }
        body.Append("}\n");
    }

    /// <summary>The Rust backing type of an entity's identity, plus whether it is String-backed.</summary>
    private static (string RustType, bool IsString) IdBacking(EntityDecl entity) => entity.IdStrategy switch
    {
        IdentityStrategy.Sequence => ("i64", false),
        IdentityStrategy.Natural => entity.IdBackingType == "Int" ? ("i64", false) : ("String", true),
        _ => ("String", true), // Guid: a String-backed brand (dependency-light; no uuid crate).
    };

    /// <summary>Emits a standalone identity newtype for an id referenced in a context but not owned by a local entity.</summary>
    private void EmitUnownedIdType(StringBuilder body, string idName)
    {
        EmitIdType(body, idName, ("String", true));
    }

    /// <summary>
    /// The id types referenced in a context but not owned by any of its entities (e.g. a foreign
    /// <c>ProductId</c> used as a field type), in deterministic order — materialized as standalone
    /// branded newtypes so the references resolve.
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
                IntegrationEventDecl iev => iev.Members.Select(m => m.Type),
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
