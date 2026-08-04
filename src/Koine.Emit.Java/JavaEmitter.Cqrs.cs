using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The application / CQRS slice of <see cref="JavaEmitter"/> (Phase 2, issue #1090) — the Java analogue of
/// <c>PythonEmitter.Cqrs.cs</c> and <c>CSharpEmitter.Cqrs.cs</c>:
/// <list type="bullet">
///   <item>a <c>readmodel</c> (R12.3) as an immutable positional <c>record</c> of the projected fields plus
///   a static <c>from(&lt;Src&gt; src)</c> projection — the Java analogue of the C# value-equal
///   <c>record</c> + <c>To&lt;Name&gt;</c> extension and Python's <c>to_&lt;name&gt;(src)</c> function
///   (Java has no extension methods, so the mapper lives on the read model itself);</item>
///   <item>a <c>query</c> (R12.4) as a criteria <c>record</c> plus a <c>&lt;Q&gt;Handler</c> interface
///   specializing the shared <c>koine.runtime.QueryHandler&lt;Q, R&gt;</c> seam — one public type per
///   <c>.java</c> file, so the handler is its own file rather than a nested type;</item>
///   <item>a <c>service</c> (R10.2 / R12.2) as one <c>public interface</c> carrying both its pure domain
///   operations (a <c>default</c> method when the operation has a body, an abstract seam when it does not)
///   and its application use cases (<c>java.util.concurrent.CompletableFuture</c>-returning, the
///   dependency-free stdlib analogue of the C# emitter's <c>Task</c>-returning <c>I&lt;Name&gt;</c>).</item>
/// </list>
/// <para>
/// Unlike the Python backend — which emits a <em>separate</em> module per group — a Java service emits a
/// <b>single</b> interface: Java's one-public-type-per-file rule means two same-named types could not both
/// land in the context package, and a service that declares both operations and use cases is one boundary
/// anyway. Everything stays stdlib-only and fully qualified, so no <c>import</c> bookkeeping is owed.
/// </para>
/// </summary>
public sealed partial class JavaEmitter
{
    // ----------------------------------------------------------------------
    // Read models -> an immutable record + a static projection
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits a read model (R12.3): a positional <c>record</c> of the projected fields plus a static
    /// <c>from(&lt;Src&gt; src)</c> projection. A <em>direct</em> field copies the like-named source member
    /// through its accessor (<c>src.field()</c> — both an emitted entity and an emitted value object expose
    /// record-style accessors); a <em>derived</em> field translates its projection rooted at <c>src</c> (the
    /// <see cref="JavaExpressionTranslator"/>'s configurable receiver, in accessor mode).
    /// </summary>
    private EmittedFile EmitReadModel(JavaEmitContext emit, string context, ReadModelDecl rm)
    {
        var typeMapper = new JavaTypeMapper(emit.Index, context, PackageFor);
        IReadOnlyList<Member> sourceMembers = ReadModelSourceMembers(context, rm.SourceType, emit.Index);

        // membersAsAccessors:true — the source is read through its accessors (`src.total()`), which is how
        // BOTH an emitted value object (a record) and an emitted entity (explicit `name()` methods) expose
        // their state, so one mode covers either source kind.
        var translator = new JavaExpressionTranslator(
            emit.Index, sourceMembers, typeMapper, context: context,
            memberReceiver: "src", membersAsAccessors: true);

        // The source type (and thus a direct field's own declaration) may live in a DIFFERENT bounded
        // context than this read model (R12.3 cross-context projection) — resolve its owning context once so
        // a direct field's bare type name is qualified against ITS OWN home (#1702/#1638), not this read
        // model's, where a same-named sibling could otherwise win.
        var sourceContext = emit.Index.ResolveOwner(rm.SourceType, context).Owner ?? context;

        var name = JavaNaming.Type(rm.Name);
        var sourceName = typeMapper.QualifyTypeName(new TypeRef(rm.SourceType, Qualifier: sourceContext));

        // Each field carries its Java type, its record component name, and the projection expression
        // (rooted at `src`) the static mapper passes positionally.
        var fields = new List<(string JavaType, string Component, string Rhs)>();
        foreach (ReadModelField f in rm.Fields)
        {
            var component = JavaNaming.Member(f.Name);
            string javaType, rhs;
            if (f.Projection is null)
            {
                javaType = emit.Index.TryGetMemberType(context, rm.SourceType, f.Name, out TypeRef t)
                    ? typeMapper.Map(QualifyAgainstSource(t, emit.Index, sourceContext, context))
                    : "Object";
                rhs = "src." + component + "()";
            }
            else
            {
                javaType = typeMapper.Map(f.Type!);
                var expectedEnum = emit.Index.Classify(f.Type!.Qualifier ?? context, f.Type!.Name) == TypeKind.Enum
                    ? f.Type!.Name
                    : null;
                rhs = translator.Translate(f.Projection, JavaExpressionTranslator.NameMode.Property, expectedEnum);
                // A derived read-model field is reconciled against ITS OWN declared type (#1889),
                // through the same ReconcileAgainstDeclared every sibling call site in this family
                // already uses. An Int-projected value on a Decimal-declared field previously emitted
                // a bare `src.lines()` into a `java.math.BigDecimal` record component — a hard `javac`
                // "incompatible types". Rust closed this call site at #1378.
                rhs = ReconcileAgainstDeclared(InferReconcilableValueType(translator, f.Projection), f.Type!, rhs);
            }

            fields.Add((javaType, component, rhs));
        }

        var sb = new StringBuilder();
        WriteJavadoc(sb, rm.Doc, string.Empty);
        var components = string.Join(", ", fields.Select(f => f.JavaType + " " + f.Component));
        sb.Append("public record ").Append(name).Append('(').Append(components).Append(") {\n");
        sb.Append('\n');
        WriteJavadoc(sb, "Projects " + sourceName + " to " + name + ".", Indent);
        sb.Append(Indent).Append("public static ").Append(name).Append(" from(").Append(sourceName)
          .Append(" src) {\n");
        sb.Append(Indent).Append(Indent).Append("return new ").Append(name).Append('(')
          .Append(string.Join(", ", fields.Select(f => f.Rhs))).Append(");\n");
        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");

        return TypeFile(context, name, sb.ToString());
    }

    /// <summary>
    /// Rewrites a read-model direct field's <see cref="TypeRef"/> so any BARE (unqualified) simple name
    /// within it is force-qualified to <paramref name="sourceContext"/> — the field was read off the read
    /// model's SOURCE type (R12.3), which may live in a different bounded context than the read model
    /// itself (<paramref name="emittingContext"/>). Left bare, <see cref="JavaTypeMapper"/> resolves the
    /// owner from the EMITTING context, so a same-named type declared locally there would win and the
    /// component would silently bind to the wrong Java type. The direct port of the C# emitter's
    /// <c>QualifyAgainstSource</c> (#1702, mirroring #1638). An already-explicit
    /// <see cref="TypeRef.Qualifier"/> (a genuine R13.2 cross-context reference) is left untouched, and the
    /// rewrite recurses into List/Set/Map element/value types, where the same shadowing risk applies.
    /// </summary>
    private static TypeRef QualifyAgainstSource(TypeRef type, ModelIndex index, string sourceContext, string emittingContext)
    {
        TypeRef? element = type.Element is { } e ? QualifyAgainstSource(e, index, sourceContext, emittingContext) : null;
        TypeRef? value = type.Value is { } v ? QualifyAgainstSource(v, index, sourceContext, emittingContext) : null;
        TypeRef rewritten = ReferenceEquals(element, type.Element) && ReferenceEquals(value, type.Value)
            ? type
            : type with { Element = element, Value = value };

        if (rewritten.Qualifier is null
            && index.ResolveOwner(rewritten.Name, sourceContext) is { Owner: { } owner } && owner != emittingContext)
        {
            return rewritten with { Qualifier = owner };
        }

        return rewritten;
    }

    /// <summary>
    /// The members a read model projects from. An entity adds the synthetic <c>id</c> (unless it already
    /// declares one), mirroring the C#/Python <c>ReadModelSourceMembers</c> — so an <c>id</c> direct field
    /// resolves to the entity's branded identity.
    /// </summary>
    private static IReadOnlyList<Member> ReadModelSourceMembers(string context, string sourceType, ModelIndex index)
    {
        if (!index.TryGetDeclIn(context, sourceType, out TypeDecl decl) && !index.TryGetDecl(sourceType, out decl))
        {
            return Array.Empty<Member>();
        }

        return decl switch
        {
            ValueObjectDecl v => v.Members,
            EntityDecl e => e.Members.Any(m => string.Equals(m.Name, "id", StringComparison.OrdinalIgnoreCase))
                ? e.Members
                : e.Members.Append(new Member("id", new TypeRef(e.IdentityName), null)).ToList(),
            _ => Array.Empty<Member>()
        };
    }

    // ----------------------------------------------------------------------
    // Queries -> a criteria record + a named handler seam
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits a query object (R12.4) as a positional criteria <c>record</c>. The companion handler seam is a
    /// separate public type, so it gets its own file (<see cref="EmitQueryHandler"/>).
    /// </summary>
    private EmittedFile EmitQuery(JavaEmitContext emit, string context, QueryDecl q)
    {
        var typeMapper = new JavaTypeMapper(emit.Index, context, PackageFor);
        var name = JavaNaming.Type(q.Name);
        var resultType = typeMapper.MapBoxed(q.ResultType);

        var sb = new StringBuilder();
        // {@code …} around the rendered type: a generic result prints angle brackets, which raw Javadoc
        // would read as (malformed) HTML.
        WriteJavadoc(sb, q.Doc ?? $"Query returning {{@code {resultType}}}; handled by {name}Handler.", string.Empty);
        var criteria = string.Join(
            ", ",
            q.Criteria.Select(p => typeMapper.Map(p.Type) + " " + JavaNaming.Member(p.Name)));
        sb.Append("public record ").Append(name).Append('(').Append(criteria).Append(") {}\n");

        return TypeFile(context, name, sb.ToString());
    }

    /// <summary>
    /// Emits a query's <c>&lt;Q&gt;Handler</c> seam: an interface specializing the shared runtime
    /// <c>koine.runtime.QueryHandler&lt;Q, R&gt;</c> so the consumer implements one named contract per query
    /// (the Java analogue of Python's <c>QueryHandler[Q, R]</c> Protocol specialization). The result type
    /// maps through <see cref="JavaTypeMapper.MapBoxed"/> — Java generics cannot hold a primitive — so a
    /// <c>List&lt;M&gt;</c> result becomes <c>java.util.List&lt;M&gt;</c>, matching the repository finders'
    /// collection convention.
    /// </summary>
    private EmittedFile EmitQueryHandler(JavaEmitContext emit, string context, QueryDecl q)
    {
        var typeMapper = new JavaTypeMapper(emit.Index, context, PackageFor);
        var name = JavaNaming.Type(q.Name);
        var handlerName = name + "Handler";
        var resultType = typeMapper.MapBoxed(q.ResultType);

        var sb = new StringBuilder();
        WriteJavadoc(sb, "Handles " + name + ", returning {@code " + resultType + "}.", string.Empty);
        sb.Append("public interface ").Append(handlerName).Append(" extends ")
          .Append(JavaRuntime.Package).Append(".QueryHandler<").Append(name).Append(", ").Append(resultType)
          .Append("> {}\n");

        return TypeFile(context, handlerName, sb.ToString());
    }

    /// <summary>True when the model declares any query object — gates the shared <c>QueryHandler</c> runtime seam.</summary>
    private static bool HasQueries(KoineModel model) =>
        model.Contexts.SelectMany(c => c.AllTypeDecls()).OfType<QueryDecl>().Any();

    // ----------------------------------------------------------------------
    // Services -> one interface per service (operations + use cases)
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits a <c>service</c> as one <c>public interface</c>: its pure domain <c>operations</c> (R10.2)
    /// first — a bodied one as a <c>default</c> method carrying its translated result expression, a
    /// bodyless one as an abstract seam — then its application <c>use cases</c> (R12.2), each returning
    /// <c>java.util.concurrent.CompletableFuture&lt;T&gt;</c> (<c>&lt;Void&gt;</c> for a fire-and-forget use
    /// case), the stdlib analogue of the C# boundary's <c>Task</c>. Returns <c>null</c> for a service that
    /// declares neither, so no empty interface is emitted.
    /// </summary>
    private EmittedFile? EmitService(JavaEmitContext emit, string context, ServiceDecl svc)
    {
        if (svc.Operations.Count == 0 && svc.UseCases.Count == 0)
        {
            return null;
        }

        var typeMapper = new JavaTypeMapper(emit.Index, context, PackageFor);
        var name = JavaNaming.Type(svc.Name);

        var sb = new StringBuilder();
        WriteJavadoc(sb, svc.Doc ?? $"The {name} service boundary.", string.Empty);
        sb.Append("public interface ").Append(name).Append(" {\n");

        foreach (OperationDecl op in svc.Operations)
        {
            sb.Append('\n');
            WriteServiceOperation(sb, emit, context, op, typeMapper);
        }

        foreach (UseCaseDecl uc in svc.UseCases)
        {
            sb.Append('\n');
            WriteServiceUseCase(sb, uc, typeMapper);
        }

        sb.Append("}\n");
        return TypeFile(context, name, sb.ToString());
    }

    /// <summary>
    /// Writes one pure domain operation. With a body it is a <c>default</c> method returning the translated
    /// result expression; without one it is an abstract seam the consumer implements. Parameters are pushed
    /// as locals for the translation so a parameter reference renders as its bare Java name rather than
    /// being mistaken for a member.
    /// </summary>
    private static void WriteServiceOperation(
        StringBuilder sb, JavaEmitContext emit, string context, OperationDecl op, JavaTypeMapper typeMapper)
    {
        var method = JavaNaming.Member(op.Name);
        var returnType = typeMapper.Map(op.ReturnType);
        var paramList = string.Join(
            ", ",
            op.Parameters.Select(p => typeMapper.Map(p.Type) + " " + JavaNaming.Member(p.Name)));

        WriteJavadoc(sb, op.Doc, Indent);
        if (op.Body is null)
        {
            sb.Append(Indent).Append(returnType).Append(' ').Append(method).Append('(').Append(paramList)
              .Append(");\n");
            return;
        }

        // A service has no members of its own, so the identifier scope is exactly its parameters.
        var translator = new JavaExpressionTranslator(
            emit.Index, Array.Empty<Member>(), typeMapper, context: context);
        foreach (Param p in op.Parameters)
        {
            translator.PushLocal(p.Name, p.Type);
        }

        var expectedEnum =
            emit.Index.Classify(op.ReturnType.Qualifier ?? context, op.ReturnType.Name) == TypeKind.Enum
                ? op.ReturnType.Name
                : null;
        var body = translator.Translate(op.Body, JavaExpressionTranslator.NameMode.Parameter, expectedEnum);
        foreach (Param p in op.Parameters)
        {
            translator.PopLocal(p.Name);
        }

        sb.Append(Indent).Append("default ").Append(returnType).Append(' ').Append(method).Append('(')
          .Append(paramList).Append(") {\n");
        sb.Append(Indent).Append(Indent).Append("return ").Append(body).Append(";\n");
        sb.Append(Indent).Append("}\n");
    }

    /// <summary>
    /// Writes one application use case: a <c>CompletableFuture</c>-returning abstract method. A use case
    /// with no declared result is <c>CompletableFuture&lt;Void&gt;</c> (the Java idiom for "completes with
    /// nothing"), mirroring the C# emitter's bare <c>Task</c> and Python's <c>async def … -&gt; None</c>.
    /// </summary>
    private static void WriteServiceUseCase(StringBuilder sb, UseCaseDecl uc, JavaTypeMapper typeMapper)
    {
        var method = JavaNaming.Member(uc.Name);
        var payload = uc.ReturnType is null ? "Void" : typeMapper.MapBoxed(uc.ReturnType);
        var paramList = string.Join(
            ", ",
            uc.Parameters.Select(p => typeMapper.Map(p.Type) + " " + JavaNaming.Member(p.Name)));

        WriteJavadoc(sb, uc.Doc, Indent);
        sb.Append(Indent).Append("java.util.concurrent.CompletableFuture<").Append(payload).Append("> ")
          .Append(method).Append('(').Append(paramList).Append(");\n");
    }
}
