using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit.CSharp;

namespace Koine.Compiler.Emit.TypeScript;

/// <summary>
/// The TypeScript backend (R16.2). Turns a validated <see cref="KoineModel"/> into idiomatic,
/// <c>tsc --strict</c>-clean TypeScript that preserves Koine's domain semantics:
/// <list type="bullet">
/// <item><b>Value objects</b> — immutable classes extending the runtime <c>ValueObject</c> base,
/// with structural <c>equals</c> and derived members.</item>
/// <item><b>Entities</b> — identity equality by a <b>branded</b> primitive id type.</item>
/// <item><b>Enums</b> — a string-literal union, a <c>const</c> member object, and smart-enum
/// helpers (<c>Match</c>/<c>Switch</c>/<c>TryFrom*</c>) matching the C# <c>Match</c>/<c>Switch</c>/<c>Try*</c> surface.</item>
/// <item><b>Invariants</b> — throw the runtime <c>DomainInvariantViolationError</c>.</item>
/// </list>
/// One <c>.ts</c> file per type; namespace → folder (the same <c>ns.Replace('.', '/')</c> logic
/// the C# emitter uses). All TS-specific decisions live in this folder; the AST stays agnostic.
/// </summary>
public sealed partial class TypeScriptEmitter : IEmitter
{
    private readonly TsEmitterOptions _options;

    /// <summary>The unconfigured emitter: source maps off, byte-identical to the historical output.</summary>
    public TypeScriptEmitter()
        : this(TsEmitterOptions.Default)
    {
    }

    /// <summary>
    /// Constructs the emitter with explicit <paramref name="options"/> (production-grade emit). The
    /// default-options path (and the parameterless ctor that defers to it) emits byte-for-byte
    /// identical TypeScript to the historical emitter.
    /// </summary>
    internal TypeScriptEmitter(TsEmitterOptions options)
    {
        _options = options;
    }

    public string TargetName => "typescript";

    /// <summary>
    /// Encodes every TypeScript option that changes emitted bytes (source maps, reference-only, and the
    /// sorted module remap pairs) into the cache fingerprint, so toggling any of them busts
    /// <see cref="Services.KoineCompiler"/>'s emit cache. The module pairs are ordered so equal maps
    /// always produce the same string regardless of insertion order.
    /// </summary>
    public string CacheDiscriminator
    {
        get
        {
            var map = string.Join(
                ",",
                _options.ModuleMap
                    .OrderBy(kv => kv.Key, StringComparer.Ordinal)
                    .Select(kv => kv.Key + "=" + kv.Value));
            return string.Join(
                "|",
                GetType().FullName,
                "sourceMaps=" + _options.EmitSourceMaps,
                "refOnly=" + _options.ReferenceOnly,
                "modules=" + map);
        }
    }

    /// <summary>
    /// The shipped <c>tsconfig.json</c>: a modern target/lib (so Set/Map/iterables/Array.find
    /// resolve), <c>strict</c>, and <c>noEmit</c> — type-check only, matching the conformance harness.
    /// </summary>
    private const string TsConfigJson =
        "{\n" +
        "  \"compilerOptions\": {\n" +
        "    \"target\": \"ES2022\",\n" +
        "    \"module\": \"ESNext\",\n" +
        "    \"moduleResolution\": \"bundler\",\n" +
        "    \"strict\": true,\n" +
        "    \"noEmit\": true,\n" +
        "    \"skipLibCheck\": true,\n" +
        "    \"forceConsistentCasingInFileNames\": true\n" +
        "  },\n" +
        "  \"include\": [\"**/*.ts\"]\n" +
        "}\n";

    private const string Indent = "  ";

    /// <summary>
    /// True when reference-only emit is requested (<see cref="TsEmitterOptions.ReferenceOnly"/>):
    /// every executable body (constructor/method/getter/operation/factory) is replaced with a
    /// <c>throw new Error('reference-only');</c> stub while all signatures, classes, interfaces and
    /// fields stay intact. Off by default, so the full emit path is byte-identical to the historical
    /// TypeScript output.
    /// </summary>
    private bool RefOnly => _options.ReferenceOnly;

    /// <summary>The canonical reference-only body stub for a TypeScript method/getter/operation.</summary>
    private const string RefStubStatement = "throw new Error('reference-only');";

    /// <summary>
    /// Writes a complete reference-only member: the given <paramref name="signature"/> (already minus
    /// the body, e.g. <c>multiply(factor: number): Money</c>) followed by a single-statement
    /// <see cref="RefStubStatement"/> body. The signature is indented one level; the body two.
    /// </summary>
    private static void WriteRefStubMethod(StringBuilder sb, string signature)
    {
        sb.Append('\n');
        sb.Append(Indent).Append(signature).Append(" {\n");
        sb.Append(Indent).Append(Indent).Append(RefStubStatement).Append('\n');
        sb.Append(Indent).Append("}\n");
    }

    /// <summary>
    /// The definite-assignment assertion (<c>!</c>) appended to a class field name in reference-only
    /// emit, where the constructor body is stubbed and never assigns the field — without it TypeScript
    /// <c>strict</c> (<c>strictPropertyInitialization</c>) would reject the un-initialized field. Empty
    /// on the full-emit path, so output stays byte-identical.
    /// </summary>
    private string FieldBang => RefOnly ? "!" : "";

    public IReadOnlyList<EmittedFile> Emit(KoineModel model) => Emit(model, null);

    public IReadOnlyList<EmittedFile> Emit(KoineModel model, SemanticModel? semantic)
    {
        ModelIndex index = (semantic ?? new SemanticModel(model)).Index;
        var typeMapper = new TypeScriptTypeMapper(index);
        Dictionary<string, string> enumMemberToType = BuildEnumMemberMap(model);

        var emit = new TsEmitContext(
            index,
            OperatorNeedsAnalyzer.BuildAdditiveOperatorNeeds(model, index),
            OperatorNeedsAnalyzer.BuildScalarOperatorNeeds(model, index),
            model.Contexts.Select(c => c.Name).ToList(),
            BuildTypeNamespaces(model),
            enumMemberToType);

        var files = new List<EmittedFile>();

        // 1. Runtime support, emitted once at the output root.
        files.Add(new EmittedFile(TsRuntime.FileName, TsRuntime.Source + "\n"));

        // A tsconfig so the emitted tree type-checks AS SHIPPED: the runtime and enums use
        // Set/Map/iterables/Array.find, which need a modern lib/target — a bare `tsc` (ES5 default)
        // would reject them. `tsc -p <out>` (or `tsc` run in the output dir) now checks cleanly.
        files.Add(new EmittedFile("tsconfig.json", TsConfigJson));

        // 2. Per-context user types, one file each.
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (TypeDecl type in ctx.Types)
            {
                var ns = ModelIndex.NamespaceOf(ctx.Name, type.ModulePath);
                EmitType(emit, files, type, ns, root: null, typeMapper);
            }

            // ID types referenced but not owned by an entity in this context (e.g. a foreign *Id).
            foreach (var idName in OrderedUnownedIds(ctx, index))
            {
                files.Add(EmitIdType(emit, idName, ctx.Name, IdentityStrategy.Guid, null));
            }

            // R10 behavioral declarations: reusable specifications (gathered from the context and
            // its aggregates, mirroring the C# dispatch) emit as one <Context>Specifications module.
            var contextSpecs = ctx.Specs
                .Concat(ctx.Types.OfType<AggregateDecl>().SelectMany(a => a.Specs))
                .ToList();
            if (contextSpecs.Count > 0)
            {
                files.Add(EmitSpecifications(emit, contextSpecs, ctx.Name, typeMapper));
            }

            // Services: a stateless domain-service class for pure operations (R10.2) and/or an
            // I<Name> application-service interface for use cases (R12.2) — mirrors the C# dispatch.
            foreach (ServiceDecl svc in ctx.Services)
            {
                if (svc.Operations.Count > 0)
                {
                    files.Add(EmitService(emit, svc, ctx.Name, typeMapper));
                }

                if (svc.UseCases.Count > 0)
                {
                    files.Add(EmitApplicationService(emit, svc, ctx.Name, typeMapper));
                }
            }

            // R10.3 cross-aggregate policies: one handler-seam module per `policy` (deterministic
            // declaration order), mirroring the C# emitter's per-context policy dispatch.
            foreach (PolicyDecl policy in ctx.Policies)
            {
                files.Add(EmitPolicy(emit, policy, ctx.Name, typeMapper));
            }

            // Integration-event subscriber handler seams (R14.3, TS parity): one IHandle<Event>
            // interface per subscription, in deterministic declaration order. Mirrors the C#
            // emitter's per-context Subscribes dispatch; no handler for events only published.
            foreach (SubscribeDecl sub in ctx.Subscribes)
            {
                files.Add(EmitIntegrationEventHandler(emit, sub, ctx.Name));
            }

            // The context's Unit of Work (R12.1, TS parity): a transactional seam over its
            // aggregate repositories. Emitted only when the context has aggregates whose root is
            // an entity (only those produce a repository to expose). Mirrors the C# dispatch.
            var aggregates = ctx.Types.OfType<AggregateDecl>()
                .Where(a => a.RootEntity() is not null)
                .ToList();
            if (aggregates.Count > 0)
            {
                files.Add(EmitUnitOfWork(emit, ctx.Name, aggregates));
            }
        }

        // 3. Anti-corruption-layer translator interfaces (R14.2, TS parity): one per ACL relation
        //    that carries a mapping block. Emitted at MODEL level (after the per-context loop),
        //    into the downstream context, mirroring the C# emitter's placement and order.
        if (model.ContextMap is { } map)
        {
            foreach (ContextRelation r in map.Relations)
            {
                if (r.Kind == ContextRelationKind.AntiCorruptionLayer && r.AclMappings.Count > 0)
                {
                    files.Add(EmitAclTranslator(emit, r));
                }
            }
        }

        // 4. Source maps (gated): attach the per-module declaration segments to the module's
        // EmittedFile and emit a Source Map v3 sidecar alongside it. No-op when the flag is off
        // (SourceMaps stays empty), so the default path is byte-identical.
        if (emit.SourceMaps.Count > 0)
        {
            AttachSourceMaps(files, emit.SourceMaps);
        }

        return files;
    }

    /// <summary>
    /// Materializes the pending Source Map v3 sidecars: for each emitted module that produced a map,
    /// stamps the declaration <see cref="SourceMapSegment"/>s onto the module's <see cref="EmittedFile"/>
    /// and appends a sibling <c>&lt;module&gt;.ts.map</c> file holding the v3 JSON.
    /// </summary>
    private static void AttachSourceMaps(List<EmittedFile> files, IReadOnlyList<PendingSourceMap> pending)
    {
        foreach (PendingSourceMap map in pending)
        {
            var index = files.FindIndex(f => string.Equals(f.RelativePath, map.ModulePath, StringComparison.Ordinal));
            if (index >= 0)
            {
                files[index] = files[index] with { SourceMap = map.Segments };
            }

            var json = SourceMapV3.Build(map.FileName, map.SourceName, map.Mappings);
            files.Add(new EmittedFile(map.SidecarPath, json));
        }
    }

    private void EmitType(
        TsEmitContext emit, List<EmittedFile> files, TypeDecl type, string ns,
        EntityDecl? root, TypeScriptTypeMapper typeMapper)
    {
        switch (type)
        {
            case ValueObjectDecl vo:
                files.Add(EmitValueObject(emit, vo, ns, typeMapper));
                break;
            case EnumDecl @enum:
                files.Add(EmitEnum(emit, @enum, ns, typeMapper));
                break;
            case EntityDecl entity:
                files.Add(EmitEntity(emit, entity, ns, ReferenceEquals(entity, root), typeMapper));
                files.Add(EmitIdType(emit, entity.IdentityName, ns, entity.IdStrategy, entity.IdBackingType));
                break;
            case EventDecl ev:
                files.Add(EmitEvent(emit, ev, ns, typeMapper));
                break;
            case IntegrationEventDecl ie:
                files.Add(EmitIntegrationEvent(emit, ie, ns, typeMapper));
                break;
            case ReadModelDecl rm:
                files.Add(EmitReadModel(emit, rm, ns, typeMapper));
                break;
            case QueryDecl q:
                files.Add(EmitQuery(emit, q, ns, typeMapper));
                break;
            case AggregateDecl agg:
                EntityDecl? aggRoot = agg.RootEntity();
                foreach (TypeDecl nested in agg.Types)
                {
                    EmitType(emit, files, nested, ns, aggRoot, typeMapper);
                }
                // The aggregate root's persistence-ignorant repository contract (mirrors the C#
                // I<Root>Repository): getById/add/update/remove plus the model's declarative finders.
                if (EmitRepository(emit, agg, aggRoot, ns, typeMapper) is { } repo)
                {
                    files.Add(repo);
                }
                break;
        }
    }

    // ----------------------------------------------------------------------
    // Repositories — the aggregate root's persistence seam (mirrors the C# emitter).
    // ----------------------------------------------------------------------

    /// <summary>The mutating + query operations a repository exposes when none are listed.</summary>
    private static readonly IReadOnlyList<string> DefaultRepositoryOps =
        new[] { "getById", "add", "update", "remove" };

    /// <summary>
    /// Emits the <c>I&lt;Root&gt;Repository</c> interface for an aggregate: the fundamental
    /// <c>getById</c> lookup (keyed on the root's branded ID), the configured mutating operations
    /// (default add/update/remove), and any declarative finders. Every member returns a
    /// <c>Promise</c> — the TS analogue of the C# emitter's <c>Task</c>-returning contract — and a
    /// single-result lookup widens to <c>| undefined</c> (the TS analogue of C#'s nullable
    /// <c>Root?</c>). Interface only, no concrete implementation, matching C#. Returns <c>null</c>
    /// when the root cannot be resolved (already a validation error).
    /// </summary>
    private EmittedFile? EmitRepository(
        TsEmitContext emit, AggregateDecl agg, EntityDecl? root, string ns, TypeScriptTypeMapper typeMapper)
    {
        if (root is null)
        {
            return null;
        }

        var rootName = TypeScriptNaming.ToPascalCase(root.Name);
        var idType = TypeScriptNaming.ToPascalCase(root.IdentityName);
        IReadOnlyList<string> ops = agg.Repository?.Operations ?? DefaultRepositoryOps;
        IReadOnlyList<FinderDecl> finders = agg.Repository?.Finders ?? Array.Empty<FinderDecl>();
        var iface = $"I{rootName}Repository";

        var sb = new StringBuilder();
        WriteDoc(sb, $"Persistence-ignorant repository contract for the {rootName} aggregate root.", "");
        sb.Append("export interface ").Append(iface).Append(" {\n");

        var first = true;
        void Gap()
        {
            if (!first)
            {
                sb.Append('\n');
            }

            first = false;
        }

        if (ops.Contains("getById"))
        {
            Gap();
            sb.Append(Indent).Append("getById(id: ").Append(idType).Append("): Promise<")
              .Append(rootName).Append(" | undefined>;\n");
        }

        foreach (var op in new[] { "add", "update", "remove" })
        {
            if (ops.Contains(op))
            {
                Gap();
                sb.Append(Indent).Append(op).Append("(aggregate: ").Append(rootName).Append("): Promise<void>;\n");
            }
        }

        foreach (FinderDecl finder in finders)
        {
            Gap();
            var isList = finder.ResultType.Name == ModelIndex.ListTypeName;
            var ret = isList ? $"Promise<readonly {rootName}[]>" : $"Promise<{rootName} | undefined>";
            var paramList = string.Join(", ", finder.Parameters.Select(p =>
                $"{TypeScriptNaming.ToCamelCase(p.Name)}: {typeMapper.Map(p.Type)}"));
            sb.Append(Indent).Append(TypeScriptNaming.ToCamelCase(finder.Name)).Append('(')
              .Append(paramList).Append("): ").Append(ret).Append(";\n");
        }

        sb.Append("}\n");
        return new EmittedFile(
            PathFor(ns, KindFolder.Repositories, iface),
            Assemble(emit, ns, KindFolder.Repositories, sb.ToString(), iface, agg.Span));
    }

    // ----------------------------------------------------------------------
    // Enums — string-literal union + const member object + smart-enum helpers.
    // ----------------------------------------------------------------------

    private EmittedFile EmitEnum(TsEmitContext emit, EnumDecl @enum, string ns, TypeScriptTypeMapper typeMapper)
    {
        var name = TypeScriptNaming.ToPascalCase(@enum.Name);
        IReadOnlyList<Param> sig = @enum.Signature;
        var hasData = @enum.HasAssociatedData;
        var sb = new StringBuilder();

        WriteDoc(sb, @enum.Doc ?? "A type-safe smart enum: members, value equality, exhaustive Match/Switch.", "");

        // The union of member name string literals — the public, structural enum name type.
        sb.Append("export type ").Append(name).Append("Name =\n");
        for (var i = 0; i < @enum.Members.Count; i++)
        {
            sb.Append(Indent).Append("| '").Append(@enum.Members[i].Name).Append('\'')
              .Append(i < @enum.Members.Count - 1 ? "\n" : ";\n");
        }
        sb.Append('\n');

        // The member instance shape: name + ordinal value + associated data.
        sb.Append("export interface ").Append(name).Append("Member {\n");
        sb.Append(Indent).Append("readonly name: ").Append(name).Append("Name;\n");
        sb.Append(Indent).Append("readonly value: number;\n");
        foreach (Param p in sig)
        {
            sb.Append(Indent).Append("readonly ").Append(TypeScriptNaming.ToCamelCase(p.Name)).Append(": ")
              .Append(typeMapper.Map(p.Type)).Append(";\n");
        }
        sb.Append("}\n\n");

        // The const object: one frozen member per declaration, plus the helpers.
        var translator = new TypeScriptExpressionTranslator(emit.Index, Array.Empty<Member>(), emit.EnumMemberToType, typeMapper, ContextOf(ns));
        sb.Append("export const ").Append(name).Append(" = {\n");
        for (var i = 0; i < @enum.Members.Count; i++)
        {
            EnumMember member = @enum.Members[i];
            sb.Append(Indent).Append(TypeScriptNaming.ToPascalCase(member.Name)).Append(": { name: '")
              .Append(member.Name).Append("', value: ").Append(i);
            if (hasData)
            {
                for (var j = 0; j < sig.Count && j < member.Args.Count; j++)
                {
                    sb.Append(", ").Append(TypeScriptNaming.ToCamelCase(sig[j].Name)).Append(": ")
                      .Append(translator.Translate(member.Args[j]));
                }
            }
            sb.Append(" } as ").Append(name).Append("Member,\n");
        }
        sb.Append("} as const;\n\n");

        var memberNames = @enum.Members.Select(m => TypeScriptNaming.ToPascalCase(m.Name)).ToList();
        var allList = string.Join(", ", memberNames.Select(m => $"{name}.{m}"));

        // All members, lookups, and non-throwing TryFrom* lookups.
        sb.Append("export const ").Append(name).Append("All: readonly ").Append(name).Append("Member[] = [")
          .Append(allList).Append("];\n\n");

        sb.Append("export function ").Append(name).Append("FromName(name: string): ").Append(name).Append("Member {\n");
        sb.Append(Indent).Append("const found = ").Append(name).Append("All.find((e) => e.name === name);\n");
        sb.Append(Indent).Append("if (found === undefined) {\n");
        sb.Append(Indent).Append(Indent).Append("throw new RangeError(`No ").Append(name).Append(" with name '${name}'.`);\n");
        sb.Append(Indent).Append("}\n");
        sb.Append(Indent).Append("return found;\n");
        sb.Append("}\n\n");

        sb.Append("export function ").Append(name).Append("FromValue(value: number): ").Append(name).Append("Member {\n");
        sb.Append(Indent).Append("const found = ").Append(name).Append("All.find((e) => e.value === value);\n");
        sb.Append(Indent).Append("if (found === undefined) {\n");
        sb.Append(Indent).Append(Indent).Append("throw new RangeError(`No ").Append(name).Append(" with value ${value}.`);\n");
        sb.Append(Indent).Append("}\n");
        sb.Append(Indent).Append("return found;\n");
        sb.Append("}\n\n");

        sb.Append("export function ").Append(name).Append("TryFromName(name: string): ").Append(name).Append("Member | undefined {\n");
        sb.Append(Indent).Append("return ").Append(name).Append("All.find((e) => e.name === name);\n");
        sb.Append("}\n\n");

        sb.Append("export function ").Append(name).Append("TryFromValue(value: number): ").Append(name).Append("Member | undefined {\n");
        sb.Append(Indent).Append("return ").Append(name).Append("All.find((e) => e.value === value);\n");
        sb.Append("}\n\n");

        // Exhaustive Match: one handler per member, dispatched on the name.
        sb.Append("export function ").Append(name).Append("Match<TResult>(\n");
        sb.Append(Indent).Append("self: ").Append(name).Append("Member,\n");
        sb.Append(Indent).Append("cases: {\n");
        foreach (var m in memberNames)
        {
            sb.Append(Indent).Append(Indent).Append(TypeScriptNaming.ToCamelCase(m)).Append(": () => TResult;\n");
        }
        sb.Append(Indent).Append("},\n");
        sb.Append("): TResult {\n");
        sb.Append(Indent).Append("switch (self.name) {\n");
        for (var i = 0; i < @enum.Members.Count; i++)
        {
            sb.Append(Indent).Append(Indent).Append("case '").Append(@enum.Members[i].Name).Append("':\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append("return cases.")
              .Append(TypeScriptNaming.ToCamelCase(memberNames[i])).Append("();\n");
        }
        sb.Append(Indent).Append(Indent).Append("default:\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("throw new Error(`Unhandled ").Append(name).Append(" '${(self as ").Append(name).Append("Member).name}'.`);\n");
        sb.Append(Indent).Append("}\n");
        sb.Append("}\n\n");

        // Switch: like Match but for side effects (returns void).
        sb.Append("export function ").Append(name).Append("Switch(\n");
        sb.Append(Indent).Append("self: ").Append(name).Append("Member,\n");
        sb.Append(Indent).Append("cases: {\n");
        foreach (var m in memberNames)
        {
            sb.Append(Indent).Append(Indent).Append(TypeScriptNaming.ToCamelCase(m)).Append(": () => void;\n");
        }
        sb.Append(Indent).Append("},\n");
        sb.Append("): void {\n");
        sb.Append(Indent).Append(name).Append("Match(self, cases);\n");
        sb.Append("}\n");

        return new EmittedFile(PathFor(ns, KindFolder.Enums, name), Assemble(emit, ns, KindFolder.Enums, sb.ToString(), name, @enum.Span));
    }
}
