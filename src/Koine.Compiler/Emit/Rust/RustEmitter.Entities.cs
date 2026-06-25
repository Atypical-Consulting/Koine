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

        // The branded identity newtype — with a UUID `generate()` when a factory needs to mint ids.
        EmitIdType(body, entity.IdentityName, IdBacking(entity), withGenerator: MintsUuidIdentity(entity));

        var name = RustNaming.ToPascalCase(entity.Name);
        var idType = RustNaming.ToPascalCase(entity.IdentityName);
        var memberNames = new HashSet<string>(entity.Members.Select(m => m.Name), StringComparer.Ordinal);
        var stored = entity.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = entity.Members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var required = stored.Where(m => m.Initializer is null).ToList();
        var defaulted = stored.Where(m => m.Initializer is not null).ToList();
        var hasEmits = EmitsEvents(entity);

        // The synthetic domain-event collector's field name, chosen to dodge a user member literally
        // named `events` (or a same-named command/factory) — a collision that would otherwise emit two
        // `events` fields and fail to compile (issue #314). Every reference below routes through it.
        var eventsField = SyntheticEventsFieldName(entity);

        // A synthetic `id` member (of the identity type) so an `id` reference in a command body —
        // `result id`, or an `emit` argument — resolves to the entity's identity field (`self.id`),
        // mirroring how the C#/TypeScript emitters surface the id to behavior bodies.
        var bodyMembers = entity.Members
            .Append(new Member("id", new TypeRef(entity.IdentityName), null))
            .ToList();
        var translator = new RustExpressionTranslator(emit.Index, bodyMembers, emit.EnumMemberToType, typeMapper, context);

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

        // Domain events recorded by this aggregate's commands/factories. Excluded from identity
        // equality (which is hand-written over the id) and drained by the application layer.
        if (hasEmits)
        {
            body.Append(Indent).Append(eventsField).Append(": Vec<DomainEvent>,\n");
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

        if (hasEmits)
        {
            body.Append(Indent).Append(Indent).Append(Indent).Append(eventsField).Append(": Vec::new(),\n");
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

        // Domain-event accessor + drain (when the entity records events).
        if (hasEmits)
        {
            body.Append('\n');
            body.Append(Indent).Append("/// The domain events recorded since the last drain.\n");
            body.Append(Indent).Append("pub fn ").Append(eventsField).Append("(&self) -> &[DomainEvent] { &self.")
                .Append(eventsField).Append(" }\n");
            body.Append('\n');
            body.Append(Indent).Append("/// Drains the recorded domain events, leaving the collection empty.\n");
            body.Append(Indent).Append("pub fn drain_").Append(eventsField).Append("(&mut self) -> Vec<DomainEvent> { std::mem::take(&mut self.")
                .Append(eventsField).Append(") }\n");
        }

        // Commands: mutating behaviors.
        foreach (CommandDecl cmd in entity.Commands)
        {
            body.Append('\n');
            WriteCommand(body, emit, name, entity, cmd, translator, typeMapper, eventsField);
        }

        // Factories: associated constructors that mint identity, check preconditions, build, and emit.
        foreach (FactoryDecl factory in entity.Factories)
        {
            body.Append('\n');
            WriteFactory(body, emit, name, entity, factory, translator, typeMapper, required, eventsField);
        }

        body.Append("}\n");
    }

    /// <summary>Emits one command as a <c>&amp;mut self</c> method returning <c>Result</c>.</summary>
    private void WriteCommand(
        StringBuilder body, RustEmitContext emit, string typeName, EntityDecl entity, CommandDecl cmd,
        RustExpressionTranslator translator, RustTypeMapper typeMapper, string eventsField)
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
            // Own the RHS so a non-Copy place (another field) or a String accessor/literal is moved
            // by value into the field rather than borrowed from `&mut self`.
            var value = RustExpressionTranslator.StripOuterParens(
                translator.TranslateOwned(t.Value, TransitionEnum(entity, t, emit.Index)));

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

        // 3b. Record the domain events the command raises (over the valid post-transition state).
        foreach (EmitClause emitClause in cmd.Body.OfType<EmitClause>())
        {
            WriteEmitStatement(body, emit, emitClause, translator, typeMapper, eventsField);
        }

        // 4. Result (or unit).
        if (cmd.Body.OfType<ResultClause>().FirstOrDefault() is { } result)
        {
            body.Append(Indent).Append(Indent).Append("Ok(").Append(translator.TranslateOwned(result.Value)).Append(")\n");
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

    /// <summary>
    /// The collision-free name for the entity's synthetic <c>Vec&lt;DomainEvent&gt;</c> collector. Built from
    /// every emitted member/command/factory field-or-method name (plus the fixed <c>id</c>), so the
    /// collector never duplicates a user member literally named <c>events</c> (issue #314).
    /// </summary>
    private static string SyntheticEventsFieldName(EntityDecl entity)
    {
        var used = new HashSet<string>(StringComparer.Ordinal) { "id" };
        foreach (Member m in entity.Members)
        {
            used.Add(RustNaming.Field(m.Name));
        }

        foreach (CommandDecl c in entity.Commands)
        {
            used.Add(RustNaming.Field(c.Name));
        }

        foreach (FactoryDecl f in entity.Factories)
        {
            used.Add(RustNaming.Field(f.Name));
        }

        return RustNaming.SyntheticEventsField(used);
    }

    /// <summary>True when any command or factory of the entity raises a domain event (so it records events).</summary>
    private static bool EmitsEvents(EntityDecl entity) =>
        entity.Commands.SelectMany(c => c.Body).OfType<EmitClause>().Any()
        || entity.Factories.SelectMany(f => f.Body).OfType<EmitClause>().Any();

    /// <summary>Lowers an <c>emit</c> clause in a command to <c>self.&lt;events&gt;.push(&lt;event&gt;);</c>.</summary>
    private void WriteEmitStatement(
        StringBuilder body, RustEmitContext emit, EmitClause emitClause,
        RustExpressionTranslator translator, RustTypeMapper typeMapper, string eventsField)
    {
        if (BuildEmitExpression(emit, emitClause, translator, typeMapper) is { } expr)
        {
            body.Append(Indent).Append(Indent).Append("self.").Append(eventsField).Append(".push(").Append(expr).Append(");\n");
        }
    }

    /// <summary>
    /// Builds the <c>DomainEvent::Ev(Ev::new(args…))</c> expression for an <c>emit Ev(field: value, …)</c>
    /// clause (null for an unknown event — the validator guarantees presence). Arguments bind by field
    /// name in the event constructor's declaration order; each is rendered as an owned value (the
    /// <c>id</c>/params and any non-Copy place cloned), with a bare enum member qualified.
    /// </summary>
    private static string? BuildEmitExpression(
        RustEmitContext emit, EmitClause emitClause,
        RustExpressionTranslator translator, RustTypeMapper typeMapper)
    {
        if (!emit.Index.TryGetDecl(emitClause.EventName, out TypeDecl decl))
        {
            return null;
        }

        IReadOnlyList<Member> members = decl switch
        {
            EventDecl e => e.Members,
            IntegrationEventDecl ie => ie.Members,
            _ => Array.Empty<Member>(),
        };

        var argByField = emitClause.Args.ToDictionary(a => a.Field, a => a.Value, StringComparer.Ordinal);
        var args = members.Select(m =>
        {
            if (!argByField.TryGetValue(m.Name, out Expr? value))
            {
                return "Default::default()"; // validator guarantees presence; defensive
            }

            var expectedEnum = emit.Index.Classify(m.Type.Name) == TypeKind.Enum ? m.Type.Name : null;
            return translator.TranslateOwned(value, expectedEnum);
        });

        return $"DomainEvent::{RustNaming.ToPascalCase(emitClause.EventName)}"
            + $"({typeMapper.QualifyTypeName(emitClause.EventName)}::new({string.Join(", ", args)}))";
    }

    /// <summary>
    /// Emits a factory as an associated <c>fn name(params…) -&gt; Result&lt;Self, DomainError&gt;</c> that
    /// mints a fresh identity, checks the factory preconditions, constructs via the smart constructor
    /// (which runs the entity invariants), and records creation events. Because Rust <em>moves</em> the
    /// parameters into the constructor, any <c>emit</c> payloads — which reference the same id/params —
    /// are built first (cloning the non-Copy ones) and assigned after construction.
    /// </summary>
    private void WriteFactory(
        StringBuilder body, RustEmitContext emit, string typeName, EntityDecl entity, FactoryDecl factory,
        RustExpressionTranslator translator, RustTypeMapper typeMapper, IReadOnlyList<Member> required, string eventsField)
    {
        var method = RustNaming.Field(factory.Name);
        var idType = RustNaming.ToPascalCase(entity.IdentityName);
        var paramList = string.Join(", ", factory.Parameters.Select(p => RustNaming.Field(p.Name) + ": " + typeMapper.Map(p.Type)));

        // Factory scope: the generated `id` and the factory parameters are locals (they shadow any
        // same-named entity members); the aggregate itself does not exist until construction.
        translator.PushLocal("id", new TypeRef(entity.IdentityName));
        foreach (Param p in factory.Parameters)
        {
            translator.PushLocal(p.Name, p.Type);
        }

        WriteDoc(body, factory.Doc, Indent);
        body.Append(Indent).Append("pub fn ").Append(method).Append('(').Append(paramList)
            .Append(") -> Result<Self, DomainError> {\n");

        // 1. Mint identity (a fresh v4 UUID), in scope for the preconditions and event payloads.
        body.Append(Indent).Append(Indent).Append("let id = ").Append(idType).Append("::generate();\n");

        // 2. Preconditions — checked before any state is constructed.
        foreach (RequiresClause req in factory.Body.OfType<RequiresClause>())
        {
            WriteRequires(body, typeName, req, translator);
        }

        // 3. Creation events, built from the id + params *before* they are moved into the constructor.
        // The collector *local* must not be named after a factory parameter (the entity-wide
        // `eventsField` dodges member/command/factory names but not parameter names): a `let
        // <eventsField>` that shadows a same-named parameter would make the subsequent `Self::new(…)`
        // and `instance.<eventsField> = …` read the Vec local instead of the parameter (issue #325).
        var emits = factory.Body.OfType<EmitClause>().ToList();
        var eventsLocal = emits.Count > 0
            ? RustNaming.FactoryEventsLocal(eventsField, factory.Parameters.Select(p => RustNaming.Field(p.Name)))
            : eventsField;
        if (emits.Count > 0)
        {
            body.Append(Indent).Append(Indent).Append("let ").Append(eventsLocal).Append(": Vec<DomainEvent> = vec![\n");
            foreach (EmitClause emitClause in emits)
            {
                if (BuildEmitExpression(emit, emitClause, translator, typeMapper) is { } expr)
                {
                    body.Append(Indent).Append(Indent).Append(Indent).Append(expr).Append(",\n");
                }
            }

            body.Append(Indent).Append(Indent).Append("];\n");
        }

        // 4. Construct through the smart constructor and attach the recorded events.
        var ctorArgs = string.Join(", ", BuildFactoryCtorArgs(factory, required, translator, emit.Index));
        if (emits.Count > 0)
        {
            body.Append(Indent).Append(Indent).Append("let mut instance = Self::new(").Append(ctorArgs).Append(")?;\n");
            body.Append(Indent).Append(Indent).Append("instance.").Append(eventsField).Append(" = ").Append(eventsLocal).Append(";\n");
            body.Append(Indent).Append(Indent).Append("Ok(instance)\n");
        }
        else
        {
            body.Append(Indent).Append(Indent).Append("Self::new(").Append(ctorArgs).Append(")\n");
        }

        body.Append(Indent).Append("}\n");

        foreach (Param p in factory.Parameters)
        {
            translator.PopLocal(p.Name);
        }

        translator.PopLocal("id");
    }

    /// <summary>
    /// The positional arguments for a factory's <c>Self::new(id, …)</c> call. Each required ctor member
    /// draws its value, in priority order, from an explicit <c>field &lt;- expr</c> initialization, a
    /// same-named auto-bound parameter, <c>None</c> for an unset optional, or a defensive
    /// <c>Default::default()</c> (a required+unset member is a validator-rejected case).
    /// </summary>
    private static List<string> BuildFactoryCtorArgs(
        FactoryDecl factory, IReadOnlyList<Member> required,
        RustExpressionTranslator translator, ModelIndex index)
    {
        var initByField = new Dictionary<string, Expr>(StringComparer.Ordinal);
        foreach (Initialization init in factory.Body.OfType<Initialization>())
        {
            initByField.TryAdd(init.Field, init.Value);
        }

        var args = new List<string> { "id" };
        foreach (Member m in required)
        {
            if (initByField.TryGetValue(m.Name, out Expr? value))
            {
                var expectedEnum = index.Classify(m.Type.Name) == TypeKind.Enum ? m.Type.Name : null;
                args.Add(translator.TranslateOwned(value, expectedEnum));
            }
            else if (factory.Parameters.Any(p => MemberAnalysis.AutoBinds(p, m)))
            {
                args.Add(RustNaming.Field(m.Name)); // auto-bound same-named parameter
            }
            else if (m.Type.IsOptional)
            {
                args.Add("None"); // an unset optional member defaults to None
            }
            else
            {
                // Required + unset (the model only warns, KOI0806). There is no universal Rust default
                // (a value object has no `Default`), so emit a `todo!()` that compiles and panics if the
                // under-specified factory is ever called — the Rust analogue of C#'s `default!`.
                args.Add($"todo!(\"factory must supply the required field `{RustNaming.Field(m.Name)}`\")");
            }
        }

        return args;
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

    /// <summary>
    /// Emits a branded identity newtype (e.g. <c>OrderId(String)</c>) with a constructor and accessor.
    /// When <paramref name="withGenerator"/> (a String-backed id whose entity has a factory) it also
    /// gains a <c>generate()</c> associated fn that mints a fresh v4 UUID — the factory's identity source.
    /// </summary>
    private void EmitIdType(StringBuilder body, string idName, (string RustType, bool IsString) backing, bool withGenerator = false)
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

        if (withGenerator && backing.IsString)
        {
            body.Append(Indent).Append("/// Mints a fresh, random identity (a v4 UUID) — the source of factory-created ids.\n");
            body.Append(Indent).Append("pub fn generate() -> Self { ").Append(name).Append("(uuid::Uuid::new_v4().to_string()) }\n");
        }

        body.Append("}\n");
    }

    /// <summary>
    /// True when an entity has a factory and a String-backed (Guid) identity — the case where the
    /// factory mints ids via <c>&lt;Id&gt;::generate()</c> (a v4 UUID), which both the <c>generate()</c>
    /// emission and the <c>uuid</c> Cargo dependency gate on. Keeping the two sites on one predicate
    /// stops them drifting (a generator without its dependency would not compile).
    /// </summary>
    private static bool MintsUuidIdentity(EntityDecl entity) =>
        entity.Factories.Count > 0 && IdBacking(entity).IsString;

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
