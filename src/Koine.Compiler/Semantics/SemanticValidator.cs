using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;

namespace Koine.Compiler.Semantics;

/// <summary>
/// Target-agnostic semantic validation over a <see cref="KoineModel"/>. Produces
/// <see cref="Diagnostic"/>s for unknown type references, duplicate members, and
/// unknown field/identifier references in invariant conditions and member
/// initializers.
/// </summary>
public sealed class SemanticValidator
{
    /// <summary>
    /// The ordered, immutable set of built-in analyzers (issue #69). The order is load-bearing:
    /// compiler diagnostics are emitted in raw append order (NOT position-sorted before output), so
    /// this exactly reproduces the pre-refactor <c>Validate</c> sequence — whole-model unique-type
    /// names, then the model-scoped context map, then the interleaved per-context pass, then the
    /// whole-model satisfiability check. External analyzers run AFTER these built-ins.
    /// </summary>
    internal static readonly IReadOnlyList<IModelAnalyzer> BuiltInAnalyzers = new IModelAnalyzer[]
    {
        new UniqueTypeNamesAnalyzer(),
        new UniqueSpecPredicateNamesAnalyzer(),
        new ContextMapAnalyzer(),
        new PerContextAnalyzer(),
        new ReferenceDisciplineAnalyzer(),
        new SatisfiabilityAnalyzer(),
    };

    private readonly IReadOnlyList<IModelAnalyzer> _externalAnalyzers;

    /// <summary>Creates a validator running only the built-in analyzers (today's behavior).</summary>
    public SemanticValidator()
        : this(externalAnalyzers: null)
    {
    }

    /// <summary>
    /// Creates a validator that runs the built-in analyzers first, then the supplied external
    /// analyzers (issue #69) in order. A null/empty list is identical to the default constructor.
    /// </summary>
    public SemanticValidator(IReadOnlyList<IModelAnalyzer>? externalAnalyzers)
    {
        _externalAnalyzers = externalAnalyzers is null || externalAnalyzers.Count == 0
            ? Array.Empty<IModelAnalyzer>()
            : externalAnalyzers;
    }

    /// <summary>Validates the model and returns all semantic diagnostics.</summary>
    public IReadOnlyList<Diagnostic> Validate(KoineModel model) => Validate(new SemanticModel(model));

    /// <summary>
    /// Validates the model using a shared <see cref="SemanticModel"/> (so the single
    /// <see cref="ModelIndex"/> is reused rather than rebuilt) and returns all semantic diagnostics.
    /// Runs each analyzer in order, accumulating its diagnostics through a shared
    /// <see cref="AnalyzerContext"/> (the diagnostic sink and derived artifacts are reused across
    /// analyzers). Built-in analyzers are trusted and run unguarded; external analyzers are isolated
    /// in a try/catch so a misbehaving plugin degrades to "no extra diagnostics" instead of crashing
    /// the host — the guarantee the <see cref="IModelAnalyzer"/> contract makes.
    /// </summary>
    public IReadOnlyList<Diagnostic> Validate(SemanticModel semantic) =>
        Validate(semantic, EmitTargetSet.All);

    /// <summary>
    /// Validates <paramref name="semantic"/> while telling target-aware analyzers which
    /// <paramref name="targets"/> the compile is building for (issue #495). Identical to
    /// <see cref="Validate(SemanticModel)"/> except the chosen targets are threaded into the shared
    /// <see cref="AnalyzerContext"/>; <see cref="EmitTargetSet.All"/> (what the other overload passes)
    /// reproduces the strict, all-targets behaviour exactly.
    /// </summary>
    internal IReadOnlyList<Diagnostic> Validate(SemanticModel semantic, EmitTargetSet targets)
    {
        var diagnostics = new List<Diagnostic>();
        var context = new AnalyzerContext(semantic, diagnostics, targets);

        foreach (IModelAnalyzer analyzer in BuiltInAnalyzers)
        {
            analyzer.Analyze(context);
        }

        foreach (IModelAnalyzer analyzer in _externalAnalyzers)
        {
            try
            {
                analyzer.Analyze(context);
            }
            catch (Exception)
            {
                // A throwing external analyzer is isolated (issue #69 platform contract): skip it and
                // keep the build / live editor diagnostics alive rather than failing the whole compile.
            }
        }

        return diagnostics;
    }

    /// <summary>
    /// R15.1: warns (KOI1501) when a <c>@since(n)</c> annotation on a type or field names a
    /// generation newer than the context's own declared <c>version</c> — an evolution mistake.
    /// No-op for an unversioned context (no ceiling to exceed).
    /// </summary>
    internal static void ValidateAnnotationVersions(ContextNode ctx, List<Diagnostic> diagnostics)
    {
        if (ctx.Version is not { } ceiling)
        {
            return;
        }

        foreach (TypeDecl type in ctx.Types)
        {
            ValidateAnnotationVersionsOfType(type, ctx.Name, ceiling, diagnostics);
        }
    }

    private static void ValidateAnnotationVersionsOfType(
        TypeDecl type, string contextName, int ceiling, List<Diagnostic> diagnostics)
    {
        if (type.Since is { } typeSince && typeSince > ceiling)
        {
            diagnostics.Add(Diagnostic.Warning(
                DiagnosticCodes.AnnotationVersionAboveContext,
                $"'{type.Name}' is annotated @since({typeSince}) but context '{contextName}' is only version {ceiling}.",
                type.Span));
        }

        foreach (Member m in AnnotatableMembers(type))
        {
            if (m.Since is { } memberSince && memberSince > ceiling)
            {
                diagnostics.Add(Diagnostic.Warning(
                    DiagnosticCodes.AnnotationVersionAboveContext,
                    $"Field '{m.Name}' is annotated @since({memberSince}) but context '{contextName}' is only version {ceiling}.",
                    m.Span));
            }
        }

        if (type is AggregateDecl agg)
        {
            foreach (TypeDecl nested in agg.Types)
            {
                ValidateAnnotationVersionsOfType(nested, contextName, ceiling, diagnostics);
            }
        }
    }

    /// <summary>The member-bearing fields of a type (value/entity/event/integration event); empty otherwise.</summary>
    private static IReadOnlyList<Member> AnnotatableMembers(TypeDecl type) => type switch
    {
        ValueObjectDecl v => v.Members,
        EntityDecl e => e.Members,
        EventDecl ev => ev.Members,
        IntegrationEventDecl ie => ie.Members,
        _ => Array.Empty<Member>()
    };

    /// <summary>
    /// Validates a context's imports, module names, and cross-context references (R13.2/R13.3):
    /// imports must name a declared context and an exported type; module names must not collide
    /// with a type; and every type reference must resolve in this context's scope (local, the
    /// <c>*Id</c> convention, an import, or a qualifier) — an un-imported or ambiguous foreign
    /// reference is a coded error.
    /// </summary>
    internal static void ValidateContextScoping(ContextNode ctx, ModelIndex index, List<Diagnostic> diagnostics)
    {
        // 1. Imports resolve to a declared context and (for named imports) exported types.
        foreach (ImportDecl imp in ctx.Imports)
        {
            if (!index.IsContext(imp.Context))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownContext,
                    $"import of unknown context '{imp.Context}'", imp.Span));
                continue;
            }
            foreach (var name in imp.Names)
            {
                if (!index.DeclaresType(imp.Context, name))
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.NotExported,
                        $"context '{imp.Context}' does not declare '{name}'", imp.Span));
                }
            }
        }

        // 2. A module name must not collide with a type name in the same context.
        if (ctx.ModuleNames.Count > 0)
        {
            var typeNames = new HashSet<string>(StringComparer.Ordinal);
            foreach (TypeDecl t in ctx.AllTypeDecls())
            {
                typeNames.Add(t.Name);
            }

            foreach (var module in ctx.ModuleNames)
            {
                if (typeNames.Contains(module))
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ModuleNameCollision,
                        $"module '{module}' collides with a type of the same name in context '{ctx.Name}'",
                        ctx.Span));
                }
            }
        }

        // 3. Every referenced type resolves in this context's scope.
        foreach (TypeRef tr in ModelIndex.AllTypeRefsIn(ctx))
        {
            ValidateReference(ctx.Name, tr, index, diagnostics);
        }
    }

    /// <summary>Resolves a type reference (and its generic arguments) against a context's scope.</summary>
    private static void ValidateReference(string fromContext, TypeRef tr, ModelIndex index, List<Diagnostic> diagnostics)
    {
        ModelIndex.RefResolution r = index.ResolveReference(fromContext, tr);
        switch (r.Kind)
        {
            case ModelIndex.RefKind.UnimportedCrossContext:
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnimportedReference,
                    $"'{tr.Name}' is owned by context '{string.Join("', '", r.Candidates)}'; import it ('import {r.Candidates[0]}.{{ {tr.Name} }}') or qualify it ('{r.Candidates[0]}.{tr.Name}')",
                    tr.Span));
                break;
            case ModelIndex.RefKind.Ambiguous:
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.AmbiguousReference,
                    $"'{tr.Name}' is ambiguous between contexts '{string.Join("', '", r.Candidates)}'; qualify it (e.g. '{r.Candidates[0]}.{tr.Name}')",
                    tr.Span));
                break;
            case ModelIndex.RefKind.UnknownContext:
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownContext,
                    $"qualified reference to unknown context '{r.Candidates[0]}'", tr.Span));
                break;
            case ModelIndex.RefKind.NotExported:
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.NotExported,
                    $"context '{r.Candidates[0]}' does not declare '{tr.Name}'", tr.Span));
                break;
        }

        // An anti-corruption-layer downstream should translate upstream types, not reference them
        // directly. A direct, unqualified reference that actually binds to an ACL upstream type is a
        // code-smell warning (R14.1). It only fires when the reference truly resolves to the ACL
        // upstream — not when a same-named type is imported from, or shared with, a different context.
        if (tr.Qualifier is null
            && !index.DeclaresType(fromContext, tr.Name)
            && !index.IsKernelVisibleFrom(fromContext, tr.Name))
        {
            IReadOnlyList<string> importOwners = index.ImportOwnersOf(fromContext, tr.Name);
            // Owners of this name other than the referencing context. Built directly (no Where iterator
            // / list) so a genuinely-unknown name — the common case reaching here — allocates nothing.
            List<string>? owners = null;
            foreach (var c in index.DeclaringContextsOf(tr.Name))
            {
                if (c != fromContext)
                {
                    (owners ??= new List<string>()).Add(c);
                }
            }

            if (owners is not null)
            {
                // If a NON-ACL permit relation (open-host/conformist/…) makes a same-named type visible,
                // the reference binds there, not to the ACL upstream — no direct-reference warning.
                var permittedElsewhere = false;
                foreach (var o in owners)
                {
                    if (!index.HasAclRelation(o, fromContext) && index.MapPermitsReference(fromContext, o))
                    {
                        permittedElsewhere = true;
                        break;
                    }
                }

                foreach (var up in owners)
                {
                    // If the name is imported from a single owner that is not this upstream, it binds there.
                    if (importOwners.Count == 1 && importOwners[0] != up)
                    {
                        continue;
                    }

                    if (permittedElsewhere)
                    {
                        continue;
                    }

                    if (index.HasAclRelation(up, fromContext))
                    {
                        diagnostics.Add(Diagnostic.Warning(DiagnosticCodes.AclDirectUpstreamReference,
                            $"'{tr.Name}' is an upstream type of anti-corruption-layer '{up}' -> '{fromContext}'; translate it via the generated I{up}To{fromContext}Translator instead of referencing it directly",
                            tr.Span));
                        break;
                    }
                }
            }
        }

        if (tr.Element is not null)
        {
            ValidateReference(fromContext, tr.Element, index, diagnostics);
        }

        if (tr.Value is not null)
        {
            ValidateReference(fromContext, tr.Value, index, diagnostics);
        }
    }

    /// <summary>
    /// Reports duplicate emittable type names across the whole model (a duplicate
    /// silently shadows the first). Aggregate declarations are excluded: an
    /// aggregate is a namespace/boundary, not an emitted type, so it never collides
    /// with a same-named root entity here. (Sharing that name is still a code smell —
    /// the <see cref="DiagnosticCodes.AggregateNameMatchesRoot"/> warning, raised per
    /// aggregate in <see cref="ValidateType"/>, flags it without making it an error.)
    /// </summary>
    internal static void ValidateUniqueTypeNames(KoineModel model, List<Diagnostic> diagnostics)
    {
        // Names reserved for built-in generics; a user type with one of these would be
        // shadowed by the built-in at resolution and silently mis-emit.
        var reserved = new HashSet<string>(StringComparer.Ordinal)
        {
            ModelIndex.ListTypeName, ModelIndex.SetTypeName, ModelIndex.MapTypeName, ModelIndex.RangeTypeName
        };

        // Uniqueness is now PER CONTEXT (R13.2): two bounded contexts may each declare a
        // `Money`; only a name duplicated within one context is a collision.
        foreach (ContextNode ctx in model.Contexts)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (TypeDecl type in ctx.AllTypeDecls())
            {
                if (reserved.Contains(type.Name))
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedTypeName,
                        $"'{type.Name}' is a reserved built-in generic name and cannot name a type", type.Span));
                }

                if (type is not AggregateDecl && !seen.Add(type.Name))
                {
                    diagnostics.Add(Diagnostic.FromSpan(DiagnosticCodes.DuplicateType, $"duplicate type '{type.Name}'", type.Span));
                }
            }

            // A service emits a class into the context namespace, so its name shares the
            // type namespace — a collision with a type (or another service) is a duplicate.
            foreach (ServiceDecl svc in ctx.Services)
            {
                if (!seen.Add(svc.Name))
                {
                    diagnostics.Add(Diagnostic.FromSpan(DiagnosticCodes.DuplicateType,
                        $"service '{svc.Name}' collides with a type or service of the same name", svc.Span));
                }
            }
        }
    }

    /// <summary>
    /// Issue #419: reports two specs in the same bounded context whose names normalize to the same
    /// emitted predicate. The spec emitters generate one boolean predicate per spec into a single
    /// per-context <c>&lt;Context&gt;Specifications</c> class (PHP/TS prepend <c>is</c> → <c>isFreeOrder</c>;
    /// C# uses the spec name directly), with no dedup guard — so two distinct spec names that fold to
    /// the same identifier silently emit a duplicate function (a PHP fatal or a TS compile error,
    /// depending on the emitter and the pair). This target-agnostic check catches that once, at
    /// validation time, before any emitter runs.
    ///
    /// <para>Issue #539: detection is <b>per emitted-target keyspace</b>, not a single strict fold. A
    /// genuine per-target duplicate can occur between two names the conservative strict fold sorts into
    /// <i>different</i> groups (it collapses underscores <i>before</i> stripping a leading <c>Is</c> word,
    /// so <c>IsIs_active</c> → <c>isactive</c> and <c>Is_active</c> → <c>active</c> never get compared —
    /// yet both emit the same TypeScript predicate <c>isIs_active</c>). Each shipped predicate-emitting
    /// target therefore gets its own keyspace: <b>PHP</b> = the strict, case- and separator-folding key
    /// (its method names are case-insensitive and its PascalCase folds underscores — identical to the
    /// historical KOI1007 key); <b>TypeScript</b> = the case- and separator-sensitive <c>is</c>+subject
    /// key with a leading <c>Is</c> word stripped (<see cref="TypeScriptPredicateKey"/>); <b>C#</b> needs
    /// no keyspace of its own — its predicates are extension methods keyed by name <i>and</i> receiver
    /// type, so a folded pair only collides when it is already an exact same-target duplicate, which
    /// KOI1005 owns. A pair collides iff it duplicates an earlier spec under <i>some</i> target's key.</para>
    ///
    /// <para>Issue #495 makes the <i>severity</i> target-aware via <paramref name="targets"/>: a pair
    /// that collides under some target's keyspace but breaks no <i>enabled</i> target's own identifier
    /// rule is downgraded from an error to a warning, so a C#-only build is not blocked by a PHP-only
    /// collision, nor a PHP-only build by a TypeScript-only one. A pair that genuinely breaks an enabled
    /// target (PHP on any strict collision; TypeScript on the Is-strip axis) keeps the hard error, and
    /// the default <see cref="EmitTargetSet.All"/> (no target context) enables every target, so it is a
    /// strict superset of the pre-#539 behaviour — it catches <i>more</i>, never fewer.</para>
    ///
    /// <para>The spec surface gathered per context mirrors the emitters exactly: context-level
    /// <see cref="ContextNode.Specs"/> plus aggregate-nested <see cref="AggregateDecl.Specs"/>. The
    /// predicate is per-context (not per-target), so two specs on different target types still collide.
    /// On the first colliding pair the diagnostic carries the second spec's span.</para>
    /// </summary>
    internal static void ValidateUniqueSpecPredicateNames(
        KoineModel model, List<Diagnostic> diagnostics, EmitTargetSet targets)
    {
        // Issue #495 severity: which enabled targets would a per-target collision actually break?
        //  • PHP folds case AND separators — its predicate key IS the strict key, so a strict-key
        //    collision genuinely duplicates a PHP method → hard error whenever PHP is enabled.
        //  • TypeScript keeps case and separators but strips a leading `Is` word, so it duplicates on
        //    the Is-strip axis (IsActive+Active → isActive twice; IsIs_active+Is_active → isIs_active
        //    twice) → hard error whenever TypeScript is enabled and the TS keys repeat.
        //  • C# predicates are extension methods keyed by name AND receiver type, so a folded pair only
        //    duplicates when it is already an exact same-target duplicate — which KOI1005 owns. C#
        //    therefore never contributes a hard collision here, and needs no keyspace of its own.
        // When no enabled target breaks, the pair is valid for the chosen build (e.g. C#-only, or a
        // PHP-only build hitting a TypeScript-only collision) and the diagnostic is advisory — a
        // warning, not a hard block. The default EmitTargetSet.All enables every target, so any
        // per-target duplicate is a hard error — a strict superset of the pre-#539 behaviour.
        var phpEnabled = (targets & EmitTargetSet.Php) != 0;
        var typeScriptEnabled = (targets & EmitTargetSet.TypeScript) != 0;

        foreach (ContextNode ctx in model.Contexts)
        {
            // Same spec surface the emitters gather: context-level specs + aggregate-nested specs.
            IEnumerable<SpecDecl> specs =
                ctx.Specs.Concat(ctx.Types.OfType<AggregateDecl>().SelectMany(a => a.Specs));

            // Issue #539: one `seen` map per emitted-target keyspace — PHP's strict, case/separator
            // folding key, and TypeScript's case/separator-sensitive Is-strip key. A spec collides iff
            // it duplicates an earlier spec under *either* (C# never collides except on KOI1005's exact
            // duplicates, so it carries no keyspace). Each map keeps the first-seen spec for the message.
            var seenPhp = new Dictionary<string, SpecDecl>(StringComparer.Ordinal);
            var seenTypeScript = new Dictionary<string, SpecDecl>(StringComparer.Ordinal);

            // Issue #494: KOI1005 (DuplicateSpec, in ValidateSpecs) already reports — with the clearer
            // "duplicates another spec or a member" message — every spec whose name exactly/case-
            // insensitively duplicates an *earlier* spec on the same target. KOI1007's folds are a strict
            // superset of that, so it would double-report the very same span. Mirror KOI1005's detection
            // here (specs grouped by TargetType under Ordinal; names compared under OrdinalIgnoreCase)
            // and stay silent on exactly the spans it owns — order-independently, so a duplicate buried
            // mid-chain (e.g. IsActive, Active, active) is suppressed too. Genuinely distinct names that
            // merely fold together (IsActive+Active), or an exact name on a *different* target, still fire.
            var namesByTarget = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);

            foreach (SpecDecl spec in specs)
            {
                // The strict PascalCase subject (with a leading `Is` word stripped) drives both the PHP
                // collision key and the displayed predicate; the TypeScript key keeps case/separators.
                var subject = SpecPredicateSubject(spec.Name);
                var phpKey = CanonicalKey(subject);
                if (phpKey.Length == 0)
                {
                    continue; // a name with no alphanumeric content emits no usable predicate
                }

                var typeScriptKey = TypeScriptPredicateKey(spec.Name);

                if (!namesByTarget.TryGetValue(spec.TargetType, out HashSet<string>? targetNames))
                {
                    namesByTarget[spec.TargetType] = targetNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                }

                // True when this spec exactly/case-insensitively duplicates an earlier same-target spec —
                // precisely the case KOI1005 owns, so KOI1007 must stay silent for it (on every axis).
                var koi1005AlreadyReports = !targetNames.Add(spec.Name);

                // Does this spec duplicate an earlier one under PHP's key? under TypeScript's?
                var phpDuplicate = seenPhp.TryGetValue(phpKey, out SpecDecl? phpFirst);
                var typeScriptDuplicate = seenTypeScript.TryGetValue(typeScriptKey, out SpecDecl? typeScriptFirst);

                if ((phpDuplicate || typeScriptDuplicate) && !koi1005AlreadyReports)
                {
                    // Severity (#495): a hard error iff an *enabled* target genuinely duplicates; else the
                    // collision survives only under a non-enabled target's fold → advisory warning.
                    var enabledTargetBreaks = (phpDuplicate && phpEnabled) || (typeScriptDuplicate && typeScriptEnabled);

                    // Describe the predicate/sibling for the axis that actually collides — prefer PHP's
                    // strict subject (`isFreeOrder`) when it collides, else the TypeScript identity
                    // (`isIs_active`) so the message names the predicate that genuinely duplicates.
                    SpecDecl first = phpDuplicate ? phpFirst! : typeScriptFirst!;
                    var predicate = phpDuplicate ? subject : typeScriptKey;

                    diagnostics.Add(enabledTargetBreaks
                        ? Diagnostic.FromSpan(DiagnosticCodes.DuplicateSpecPredicate,
                            $"spec '{spec.Name}' emits the same predicate ('is{predicate}') as spec '{first.Name}'",
                            spec.Span)
                        : Diagnostic.FromSpan(DiagnosticSeverity.Warning, DiagnosticCodes.DuplicateSpecPredicate,
                            $"spec '{spec.Name}' would emit the same predicate ('is{predicate}') as spec " +
                            $"'{first.Name}' for another shipped target's identifier rule (PHP's case/separator " +
                            "fold, or TypeScript's Is-strip fold), but not for the enabled target(s); relaxed to " +
                            "a warning (issue #495)",
                            spec.Span));
                }

                // Record the first spec seen under each key so a later collider reports against it.
                if (!phpDuplicate)
                {
                    seenPhp[phpKey] = spec;
                }

                if (!typeScriptDuplicate)
                {
                    seenTypeScript[typeScriptKey] = spec;
                }
            }
        }
    }

    /// <summary>
    /// The canonical, case- and separator-insensitive collision key for a spec predicate
    /// <paramref name="subject"/>: lowercase every letter/digit and drop everything else. Two specs
    /// collide iff their keys are equal (e.g. <c>Active</c> → <c>active</c>; <c>FreeOrder</c> →
    /// <c>freeorder</c>). This is the strictest (PHP-equivalent) fold — see
    /// <see cref="ValidateUniqueSpecPredicateNames"/> for why that is the intended conservative choice.
    /// </summary>
    private static string CanonicalKey(string subject) =>
        new(subject.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());

    /// <summary>
    /// The PascalCase spec subject with a redundant leading <c>Is</c> word stripped — mirrors the
    /// emitters' <c>SpecPredicateSubject</c> (#396): <c>IsFreeOrder</c> → <c>FreeOrder</c>, but a name
    /// that merely starts with "Is" (e.g. <c>Island</c>) is left intact because the char after "Is"
    /// must be uppercase to count as a word prefix. Uses the strict (underscore-folding)
    /// <see cref="CanonicalPascalCase"/>, so it is the PHP/all-targets subject.
    /// </summary>
    private static string SpecPredicateSubject(string name) => StripLeadingIsWord(CanonicalPascalCase(name));

    /// <summary>
    /// Issue #495: the TypeScript predicate identity for <paramref name="name"/> (sans the constant
    /// <c>is</c> prefix that every TS predicate shares): first-char-upper, separators <b>kept</b>,
    /// case preserved, then the leading <c>Is</c> word stripped — exactly what
    /// <c>TypeScriptEmitter.SpecPredicateSubject(TypeScriptNaming.ToPascalCase(name))</c> emits. Two
    /// specs collide in TypeScript iff these keys are ordinally equal (so <c>IsActive</c>+<c>Active</c>
    /// collide on the Is-strip axis, but <c>FreeOrder</c>+<c>free_order</c> stay distinct). Mirrored
    /// here rather than reused from <c>Emit/</c> so the check stays layer-clean.
    /// </summary>
    private static string TypeScriptPredicateKey(string name) => StripLeadingIsWord(FirstCharUpper(name));

    /// <summary>
    /// Strips a redundant leading <c>Is</c> word from an already-PascalCased <paramref name="pascal"/>:
    /// <c>IsFreeOrder</c> → <c>FreeOrder</c>, but <c>Island</c> is left intact (the char after "Is" must
    /// be uppercase to count as a word prefix). Shared by the strict (<see cref="SpecPredicateSubject"/>)
    /// and TypeScript (<see cref="TypeScriptPredicateKey"/>) folds.
    /// </summary>
    private static string StripLeadingIsWord(string pascal) =>
        pascal.Length > 2 && pascal[0] == 'I' && pascal[1] == 's' && char.IsUpper(pascal[2])
            ? pascal[2..]
            : pascal;

    /// <summary>
    /// Upper-cases only the first character (separators and the rest of the casing left untouched) —
    /// the case-sensitive PascalCase that the C# and TypeScript emitters apply (and, unlike
    /// <see cref="CanonicalPascalCase"/>, does <i>not</i> fold underscores): <c>free_order</c> →
    /// <c>Free_order</c>, <c>freeOrder</c> → <c>FreeOrder</c>.
    /// </summary>
    private static string FirstCharUpper(string name) =>
        string.IsNullOrEmpty(name) || char.IsUpper(name[0]) ? name : char.ToUpperInvariant(name[0]) + name[1..];

    /// <summary>
    /// Target-agnostic PascalCase canonicalization. It intentionally matches PHP's
    /// <c>ToPascalCase</c> — the strictest of the shipped emitters — collapsing underscores
    /// (<c>free_order</c> → <c>FreeOrder</c>) and upper-casing the first char (<c>freeOrder</c> →
    /// <c>FreeOrder</c>). Note C#/TS only upper-case the first char (so <c>free_order</c> →
    /// <c>Free_order</c> there); folding underscores here is what makes the key the conservative
    /// least-common-denominator described on <see cref="ValidateUniqueSpecPredicateNames"/>. Kept in
    /// <c>Semantics/</c> rather than reused from any <c>Emit/</c> naming helper so the check stays
    /// layer-clean and target-agnostic.
    /// </summary>
    private static string CanonicalPascalCase(string name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return name;
        }

        // Fast-path: already PascalCase (starts uppercase, no underscores).
        if (char.IsUpper(name[0]) && !name.Contains('_'))
        {
            return name;
        }

        var sb = new StringBuilder(name.Length);
        var capitalizeNext = true;
        foreach (char c in name)
        {
            if (c == '_')
            {
                capitalizeNext = true;
            }
            else if (capitalizeNext)
            {
                sb.Append(char.ToUpperInvariant(c));
                capitalizeNext = false;
            }
            else
            {
                sb.Append(c);
            }
        }

        return sb.ToString();
    }

    internal static void ValidateType(
        TypeDecl type,
        ModelIndex index,
        TypeResolver resolver,
        IReadOnlySet<string> enumMembers,
        List<Diagnostic> diagnostics,
        string? aggregateRoot = null)
    {
        switch (type)
        {
            case ValueObjectDecl v:
                ReportGeneratedMemberCollisions(v.Members, ValueObjectGeneratedMembers, "value object", diagnostics);
                ValidateMembersAndInvariants(v.Members, v.Invariants, index, resolver, enumMembers, diagnostics, SpecNames(index, v.Name));
                if (v.IsQuantity)
                {
                    ValidateQuantity(v, index, diagnostics);
                }

                break;
            case EntityDecl e:
                EntityBehaviorValidator.ValidateIdentityStrategy(e, diagnostics);
                ReportGeneratedMemberCollisions(e.Members, EntityGeneratedMembers, "entity", diagnostics);
                IReadOnlySet<string> entitySpecs = SpecNames(index, e.Name);
                ValidateMembersAndInvariants(e.Members, e.Invariants, index, resolver, enumMembers, diagnostics, entitySpecs);
                EntityBehaviorValidator.ValidateStates(e, index, resolver, enumMembers, diagnostics);
                // Events may be emitted only from a standalone entity or the aggregate root.
                var emitAllowed = aggregateRoot is null || aggregateRoot == e.Name;
                EntityBehaviorValidator.ValidateCommands(e, index, resolver, enumMembers, diagnostics, emitAllowed, entitySpecs);
                EntityBehaviorValidator.ValidateFactories(e, index, resolver, enumMembers, diagnostics, emitAllowed);
                break;
            case AggregateDecl agg:
                // The root must name an ENTITY declared inside the aggregate: a non-entity
                // root has no identity/repository, and would leave the Unit of Work
                // referencing an I<Root>Repository that is never emitted.
                TypeDecl? rootDecl = agg.Types.FirstOrDefault(t => t.Name == agg.RootName);
                if (rootDecl is null)
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownAggregateRoot,
                        $"unknown aggregate root '{agg.RootName}'", agg.Span));
                }
                else if (rootDecl is not EntityDecl)
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownAggregateRoot,
                        $"aggregate root '{agg.RootName}' must be an entity", agg.Span));
                }
                else if (string.Equals(agg.Name, agg.RootName, StringComparison.Ordinal))
                {
                    // The aggregate boundary and its root entity carry the same name: legal, but a
                    // code smell. The boundary is a different concept from its root — a cluster the
                    // root presides over — and reads as more than its root when named for the
                    // activity it groups (e.g. `aggregate Sales root Order`). Warning, not error.
                    diagnostics.Add(Diagnostic.Warning(DiagnosticCodes.AggregateNameMatchesRoot,
                        $"aggregate '{agg.Name}' shares its name with its root entity; give the boundary a distinct name (e.g. the activity it groups) so it reads as more than its root",
                        agg.Span));
                }

                foreach (TypeDecl nested in agg.Types)
                {
                    ValidateType(nested, index, resolver, enumMembers, diagnostics, agg.RootName);
                }

                EntityBehaviorValidator.ValidateVersioning(agg, diagnostics);
                EntityBehaviorValidator.ValidateRepository(agg, index, diagnostics);
                break;
            case EnumDecl en:
                // Duplicate enum members produce uncompilable C#.
                var seenMembers = new HashSet<string>(StringComparer.Ordinal);
                // Each member also becomes a camelCase delegate parameter on the generated
                // Match/Switch; two members differing only by leading-char case (Foo/foo)
                // collapse to one parameter, so guard that collision here too.
                var seenCamel = new HashSet<string>(StringComparer.Ordinal);
                foreach (var member in en.MemberNames)
                {
                    if (!seenMembers.Add(member))
                    {
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateEnumMember,
                            $"duplicate enum member '{member}'", en.Span));
                    }
                    else if (GeneratedEnumMembers.Contains(member))
                    {
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedEnumMember,
                            $"enum member '{member}' collides with a generated smart-enum member", en.Span));
                    }

                    if (member.Length > 0 && !seenCamel.Add(char.ToLowerInvariant(member[0]) + member[1..]))
                    {
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EnumMemberCamelCaseCollision,
                            $"enum member '{member}' differs from another only by leading-character case and would collapse to one Match/Switch parameter", en.Span));
                    }
                }
                ValidateEnumAssociatedData(en, index, diagnostics);
                break;
            case EventDecl ev:
                // Events are validated like value objects but carry no invariants.
                ValidateMembersAndInvariants(ev.Members, Array.Empty<Invariant>(), index, resolver, enumMembers, diagnostics);
                // An event is a record: the always-present `OccurredOn` metadata and the
                // record-synthesized members (Equals/GetHashCode/ToString/…) are reserved.
                foreach (Member m in ev.Members)
                {
                    if (string.Equals(m.Name, "OccurredOn", StringComparison.OrdinalIgnoreCase))
                    {
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedEventField,
                            $"event field '{m.Name}' collides with the reserved 'OccurredOn' metadata property",
                            m.Span));
                    }
                    else if (IsReservedRecordMember(m.Name))
                    {
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedRecordMember,
                            $"event field '{m.Name}' collides with a record-synthesized member",
                            m.Span));
                    }
                }
                break;
            case ReadModelDecl rm:
                CqrsValidator.ValidateReadModel(rm, index, resolver, enumMembers, diagnostics);
                break;
            case QueryDecl q:
                CqrsValidator.ValidateQuery(q, index, diagnostics);
                break;
        }
    }

    /// <summary>
    /// An ordinal name set over a member list, presized to the member count and populated by a direct
    /// loop (no <c>Select</c> iterator / delegate, and no rehashing). Used by the duplicate/derived
    /// checks that only need membership tests.
    /// </summary>
    internal static HashSet<string> MemberNameSet(IReadOnlyList<Member> members)
    {
        var set = new HashSet<string>(members.Count, StringComparer.Ordinal);
        foreach (Member m in members)
        {
            set.Add(m.Name);
        }

        return set;
    }

    /// <summary>The C# property identifier a member name maps to (first char upper-cased), for collision checks.</summary>
    internal static string PropertyKey(string name) =>
        name.Length == 0 ? name : char.ToUpperInvariant(name[0]) + name[1..];

    /// <summary>
    /// Identifiers generated on every smart-enum class. A member named exactly one of these
    /// would clash with the generated property/method of the same name (C# is case-sensitive,
    /// so the collision is on the exact identifier).
    /// </summary>
    private static readonly IReadOnlySet<string> GeneratedEnumMembers =
        new HashSet<string>(StringComparer.Ordinal)
        {
            "Name", "Value", "All", "FromName", "FromValue", "TryFromName", "TryFromValue",
            "Match", "Switch", "ToString", "Equals", "GetHashCode"
        };

    /// <summary>Members a positional <c>record</c> synthesizes; a field/criterion mapping to one fails to compile.</summary>
    private static readonly IReadOnlySet<string> RecordReservedMembers =
        new HashSet<string>(StringComparer.Ordinal)
        {
            "Equals", "GetHashCode", "ToString", "GetType", "EqualityContract", "PrintMembers", "Deconstruct"
        };

    internal static bool IsReservedRecordMember(string name) => RecordReservedMembers.Contains(PropertyKey(name));

    /// <summary>The spec names declared over <paramref name="typeName"/> (R10.1), or empty.</summary>
    private static IReadOnlySet<string> SpecNames(ModelIndex index, string typeName)
    {
        IReadOnlyDictionary<string, SpecDecl> specs = index.SpecsFor(typeName);
        return specs.Count == 0 ? EmptyNames : new HashSet<string>(specs.Keys, StringComparer.Ordinal);
    }

    private static readonly IReadOnlySet<string> EmptyNames = new HashSet<string>();

    private static void ValidateMembersAndInvariants(
        IReadOnlyList<Member> members,
        IReadOnlyList<Invariant> invariants,
        ModelIndex index,
        TypeResolver resolver,
        IReadOnlySet<string> enumMembers,
        List<Diagnostic> diagnostics,
        IReadOnlySet<string>? specNames = null)
    {
        // Built lazily: only a stored (non-derived) default initializer — uncommon — needs the
        // sibling-name set, so most member lists never allocate it.
        HashSet<string>? memberNames = null;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var scope = TypeScope.FromMembers(members, index);
        var checker = new ExpressionChecker(index, resolver, enumMembers, diagnostics, specNames);

        foreach (Member m in members)
        {
            // Resilient syntax: a placeholder member (empty name, or an error/missing recovery
            // node) is a syntax-recovery artifact, not a real declaration — skip it entirely so it
            // produces no spurious duplicate/unknown-type/initializer diagnostics off the error region.
            if (IsErrorOrMissing(m) || IsPlaceholder(m.Name))
            {
                continue;
            }

            // 1. Unknown type reference (and its element for List<T>).
            ValidateTypeRef(m.Type, index, diagnostics);

            // 2. Duplicate member, reported at the second occurrence's span.
            if (!seen.Add(m.Name))
            {
                diagnostics.Add(Diagnostic.FromSpan(DiagnosticCodes.DuplicateMember, $"duplicate member '{m.Name}'", m.Span));
            }

            // 3. The member initializer.
            if (m.Initializer is not null)
            {
                // A constant default for an enum-typed field must name a member of
                // THAT enum (not just any enum in the model).
                if (m.Initializer is IdentifierExpr enumDefault
                    && index.Classify(m.Type.Name) == TypeKind.Enum
                    && index.TryGetDecl(m.Type.Name, out TypeDecl decl)
                    && decl is EnumDecl en)
                {
                    if (!en.MemberNames.Contains(enumDefault.Name))
                    {
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownEnumMemberForType,
                            $"unknown enum member '{enumDefault.Name}' for type '{m.Type.Name}'{Suggestions.For(enumDefault.Name, en.MemberNames)}",
                            enumDefault.Span) with
                        { Suggestion = Suggestions.Best(enumDefault.Name, en.MemberNames) });
                    }
                }
                else
                {
                    checker.Check(m.Initializer, scope, m.Type);

                    // A nullary builtin like `now` is non-deterministic, so it cannot be a
                    // STORED default (a derived/computed field re-evaluating it is fine).
                    if (!MemberAnalysis.IsDerived(m, memberNames ??= MemberNameSet(members)))
                    {
                        var referenced = new HashSet<string>(
                            MemberAnalysis.ReferencedIdentifiers(m.Initializer), StringComparer.Ordinal);
                        var nondeterministic = BuiltinOps.NullaryValueOps.Keys.FirstOrDefault(referenced.Contains);
                        if (nondeterministic is not null)
                        {
                            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.NowAsStoredDefault,
                                $"'{nondeterministic}' cannot be used as a stored default for '{m.Name}'",
                                m.Span));
                        }
                    }

                    // An optional value can't initialize a non-optional field without a fallback.
                    TypeRef? initType = resolver.Infer(m.Initializer, scope);
                    if (initType is { IsOptional: true } && !m.Type.IsOptional)
                    {
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.OptionalAssignedToNonOptional,
                            $"optional value assigned to non-optional field '{m.Name}'; provide a fallback with '??'",
                            m.Span));
                    }

                    // A member initializer (derived/computed, or a stored constant default) whose body
                    // infers to a WIDER numeric type than its declared type (Decimal → Int) is an illegal
                    // implicit narrowing — C#'s CS0266. Reuse the canonical directional-assignability rule
                    // (Int → Decimal widening and same-type allowed, narrowing not) rather than hand-coding
                    // a third copy, so this stays in lockstep with the sibling assignment positions. Reject
                    // the model here, uniformly for every emitter, rather than letting one emit
                    // non-compiling code — whether the member is derived (issue #961) or a stored default
                    // (issue #974).
                    if (TypeResolver.IsNumeric(initType) && TypeResolver.IsNumeric(m.Type)
                        && !MemberAnalysis.IsAssignable(initType!, m.Type))
                    {
                        var isDerived = MemberAnalysis.IsDerived(m, memberNames ??= MemberNameSet(members));
                        var (where, fix) = isDerived
                            ? ("derived member", "keep its expression integral")
                            : ("default for", "use an integral default");
                        diagnostics.Add(Diagnostic.FromSpan(DiagnosticCodes.NumericNarrowingConversion,
                            $"cannot implicitly convert Decimal to Int in {where} '{m.Name}'; declare the member 'Decimal', or {fix}",
                            m.Initializer.Span));
                    }

                    // A member initializer — derived (computed) or a stored constant default — that
                    // provably divides by a literal zero has no representable quotient in ANY target:
                    // C# rejects it at Roslyn-compile time (CS0020), TypeScript silently narrows it to
                    // `Infinity`, Python raises ZeroDivisionError the moment the module is imported, and
                    // PHP silently throws DivisionByZeroError at construction (issue #1031). Reject the
                    // model here, uniformly for every emitter, rather than letting each one independently
                    // (and differently) mishandle an expression that was never representable to begin with.
                    if (LiteralZeroDivisorAnalysis.HasDivisionByLiteralZero(m.Initializer))
                    {
                        var isDerived = MemberAnalysis.IsDerived(m, memberNames ??= MemberNameSet(members));
                        var where = isDerived ? "derived member" : "constant default for";
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DivisionByZeroInConstantDefault,
                            $"division by zero in the {where} '{m.Name}'",
                            m.Initializer.Span));
                    }
                }
            }
        }

        foreach (Invariant inv in invariants)
        {
            checker.Check(inv.Condition, scope);
        }
    }

    /// <summary>Members every generated entity carries; a member mapping to one fails to compile (CS0102).</summary>
    private static readonly IReadOnlySet<string> EntityGeneratedMembers =
        new HashSet<string>(StringComparer.Ordinal) { "Id", "Equals", "GetHashCode" };

    /// <summary>
    /// Members every generated value object carries: the identity-equality
    /// <c>Equals</c>/<c>GetHashCode</c> (from the <c>ValueObject</c> base) and the
    /// overridden <c>GetEqualityComponents</c>.
    /// </summary>
    private static readonly IReadOnlySet<string> ValueObjectGeneratedMembers =
        new HashSet<string>(StringComparer.Ordinal) { "Equals", "GetHashCode", "GetEqualityComponents" };

    /// <summary>
    /// Rejects a member whose emitted property name collides with a member the emitted
    /// class always generates (e.g. an entity's <c>id</c> field becoming a second
    /// <c>Id</c> property, CS0102; a value object's <c>equals</c> field shadowing
    /// <c>ValueObject.Equals</c>). The conditional <c>Version</c> token is covered by
    /// <see cref="EntityBehaviorValidator.ValidateVersioning(AggregateDecl, List{Diagnostic})"/>.
    /// </summary>
    private static void ReportGeneratedMemberCollisions(
        IReadOnlyList<Member> members, IReadOnlySet<string> generated, string kind, List<Diagnostic> diagnostics)
    {
        foreach (Member m in members)
        {
            if (generated.Contains(PropertyKey(m.Name)))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.ReservedGeneratedMember,
                    $"{kind} member '{m.Name}' collides with the generated '{PropertyKey(m.Name)}' member",
                    m.Span));
            }
        }
    }

    // ------------------------------------------------------------------------
    // R10 — specifications, services, policies
    // ------------------------------------------------------------------------

    /// <summary>
    /// Validates specifications (R10.1): each target must be a value/entity; the
    /// condition must be boolean and reference only the target's members + sibling
    /// specs; names are unique and don't collide with a member; and specs must not
    /// form a reference cycle.
    /// </summary>
    internal static void ValidateSpecs(
        ContextNode ctx, ModelIndex index, TypeResolver resolver, IReadOnlySet<string> enumMembers, List<Diagnostic> diagnostics)
    {
        var specs = ctx.Specs.Concat(ctx.Types.OfType<AggregateDecl>().SelectMany(a => a.Specs)).ToList();
        if (specs.Count == 0)
        {
            return;
        }

        foreach (IGrouping<string, SpecDecl> group in specs.GroupBy(s => s.TargetType, StringComparer.Ordinal))
        {
            var target = group.Key;
            var specList = group.ToList();
            var specNames = new HashSet<string>(specList.Count, StringComparer.Ordinal);
            foreach (SpecDecl s in specList)
            {
                specNames.Add(s.Name);
            }

            // Resolve the spec's target in its own context first (R13.2).
            TypeDecl? decl = index.TryGetDeclIn(ctx.Name, target, out TypeDecl localDecl) ? localDecl
                : index.TryGetDecl(target, out TypeDecl globalDecl) ? globalDecl : null;
            IReadOnlyList<Member>? members =
                decl switch { ValueObjectDecl v => v.Members, EntityDecl e => e.Members, _ => null };

            if (members is null)
            {
                foreach (SpecDecl spec in specList)
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.SpecUnknownTarget,
                        $"spec '{spec.Name}' targets '{target}', which is not a declared value or entity type", spec.Span));
                }

                continue;
            }

            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var memberNames = new HashSet<string>(members.Count, StringComparer.OrdinalIgnoreCase);
            foreach (Member m in members)
            {
                memberNames.Add(m.Name);
            }

            // The scope and checker depend only on the group's shared target members and sibling spec
            // names, so build them once and reuse across the group's specs (matching how
            // ValidateMembersAndInvariants drives a single checker over many expressions).
            var scope = TypeScope.FromMembers(members, index);
            var checker = new ExpressionChecker(index, resolver, enumMembers, diagnostics, specNames);

            foreach (SpecDecl spec in specList)
            {
                if (!seen.Add(spec.Name) || memberNames.Contains(spec.Name))
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateSpec,
                        $"spec '{spec.Name}' duplicates another spec or a member of '{target}'", spec.Span));
                }

                checker.Check(spec.Condition, scope);

                TypeRef? inferred = resolver.Infer(spec.Condition, scope);
                if (inferred is not null && inferred.Name != "Bool")
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.SpecNotBoolean,
                        $"spec '{spec.Name}' condition must be boolean, but is '{inferred.Name}'", spec.Span));
                }
            }

            DetectSpecCycles(specList, specNames, diagnostics);
        }
    }

    /// <summary>Reports every spec that participates in a reference cycle (incl. self-reference).</summary>
    private static void DetectSpecCycles(IReadOnlyList<SpecDecl> specs, IReadOnlySet<string> specNames, List<Diagnostic> diagnostics)
    {
        var deps = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (SpecDecl s in specs)
        {
            deps[s.Name] = MemberAnalysis.ReferencedIdentifiers(s.Condition)
                .Where(specNames.Contains).Distinct(StringComparer.Ordinal).ToList();
        }

        var state = new Dictionary<string, int>(StringComparer.Ordinal); // 0 unvisited, 1 visiting, 2 done
        var stack = new List<string>();
        var onCycle = new HashSet<string>(StringComparer.Ordinal);

        void Dfs(string node)
        {
            state[node] = 1;
            stack.Add(node);
            foreach (var dep in deps.GetValueOrDefault(node, new List<string>()))
            {
                var st = state.GetValueOrDefault(dep, 0);
                if (st == 0)
                {
                    Dfs(dep);
                }
                else if (st == 1)
                {
                    for (var i = stack.IndexOf(dep); i >= 0 && i < stack.Count; i++)
                    {
                        onCycle.Add(stack[i]);
                    }
                }
            }
            stack.RemoveAt(stack.Count - 1);
            state[node] = 2;
        }

        foreach (SpecDecl s in specs)
        {
            if (!state.ContainsKey(s.Name))
            {
                Dfs(s.Name);
            }
        }

        foreach (SpecDecl s in specs)
        {
            if (onCycle.Contains(s.Name))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.SpecCycle,
                    $"spec '{s.Name}' is part of a reference cycle", s.Span));
            }
        }
    }

    /// <summary>
    /// Validates domain services (R10.2): unique service/operation names, valid
    /// parameter and return type refs, and that a pure operation body is assignable
    /// to its declared return type. A bodyless operation is a seam (no body check).
    /// </summary>
    internal static void ValidateServices(
        ContextNode ctx, ModelIndex index, TypeResolver resolver, IReadOnlySet<string> enumMembers, List<Diagnostic> diagnostics)
    {
        var seenServices = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var checker = new ExpressionChecker(index, resolver, enumMembers, diagnostics);

        foreach (ServiceDecl svc in ctx.Services)
        {
            if (!seenServices.Add(svc.Name))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateService,
                    $"service '{svc.Name}' is declared more than once", svc.Span));
            }

            var seenOps = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (OperationDecl op in svc.Operations)
            {
                if (!seenOps.Add(op.Name))
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateOperation,
                        $"operation '{op.Name}' is declared more than once in service '{svc.Name}'", op.Span));
                }
                // A method cannot share its enclosing class's name (CS0542).
                else if (string.Equals(op.Name, svc.Name, StringComparison.OrdinalIgnoreCase))
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateOperation,
                        $"operation '{op.Name}' collides with its service's name '{svc.Name}'", op.Span));
                }

                ValidateTypeRef(op.ReturnType, index, diagnostics);

                var seenParams = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (Param p in op.Parameters)
                {
                    ValidateTypeRef(p.Type, index, diagnostics);
                    if (!seenParams.Add(p.Name))
                    {
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateParameter,
                            $"duplicate parameter '{p.Name}' in operation '{op.Name}'", p.Span));
                    }
                }

                if (op.Body is not null)
                {
                    var scope = TypeScope.FromParams(op.Parameters, index);
                    checker.CheckOperationReturn(op.Body, op.ReturnType, scope);
                }
            }

            // Application use cases (R12.2): unique names (they emit interface methods),
            // valid parameter and return type refs.
            var seenUseCases = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (UseCaseDecl uc in svc.UseCases)
            {
                if (!seenUseCases.Add(uc.Name))
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateUseCase,
                        $"use case '{uc.Name}' is declared more than once in service '{svc.Name}'", uc.Span));
                }

                if (uc.ReturnType is not null)
                {
                    ValidateTypeRef(uc.ReturnType, index, diagnostics);
                }

                var seenParams = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (Param p in uc.Parameters)
                {
                    ValidateTypeRef(p.Type, index, diagnostics);
                    if (!seenParams.Add(p.Name))
                    {
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateParameter,
                            $"duplicate parameter '{p.Name}' in use case '{uc.Name}'", p.Span));
                    }
                }
            }
        }
    }

    /// <summary>
    /// Validates policies (R10.3): the <c>when</c> event and the <c>then</c> target
    /// command must resolve, and the reaction arguments must match the command's
    /// parameters with values drawn from the event's fields.
    /// </summary>
    internal static void ValidatePolicies(
        ContextNode ctx, ModelIndex index, TypeResolver resolver, IReadOnlySet<string> enumMembers, List<Diagnostic> diagnostics)
    {
        var seenPolicies = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (PolicyDecl policy in ctx.Policies)
        {
            if (!seenPolicies.Add(policy.Name))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicatePolicy,
                    $"policy '{policy.Name}' is declared more than once", policy.Span));
            }

            EventDecl? ev = index.TryGetDecl(policy.EventName, out TypeDecl ed) && ed is EventDecl e ? e : null;
            if (ev is null)
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.PolicyUnknownEvent,
                    $"policy '{policy.Name}' reacts to '{policy.EventName}', which is not a declared event", policy.Span));
            }

            PolicyReaction reaction = policy.Reaction;
            EntityDecl? targetRoot = ResolveTargetRoot(reaction.TargetType, index);
            if (targetRoot is null)
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.PolicyUnknownTarget,
                    $"policy '{policy.Name}' targets '{reaction.TargetType}', which is not a declared aggregate or entity", reaction.Span));
            }

            CommandDecl? cmd = targetRoot?.Commands.FirstOrDefault(c => string.Equals(c.Name, reaction.CommandName, StringComparison.OrdinalIgnoreCase));
            if (targetRoot is not null && cmd is null)
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.PolicyUnknownCommand,
                    $"'{reaction.TargetType}' has no command '{reaction.CommandName}'", reaction.Span));
            }

            // Reaction argument values resolve against the event's fields.
            TypeScope eventScope = ev is not null ? TypeScope.FromMembers(ev.Members, index) : new TypeScope(Array.Empty<KeyValuePair<string, KoineType>>());
            var checker = new ExpressionChecker(index, resolver, enumMembers, diagnostics);
            // A command may declare duplicate parameter names (already flagged KOI0504); build the
            // lookup duplicate-tolerantly (first-wins) so the policy validator does not throw on the
            // duplicate key and the real diagnostic — and the rest of the built-in pass — survive (#604).
            var cmdParams = cmd?.Parameters
                .GroupBy(p => p.Name, StringComparer.Ordinal)
                .ToDictionary(g => g.Key, g => g.First().Type, StringComparer.Ordinal);
            var provided = new HashSet<string>(StringComparer.Ordinal);

            foreach (PolicyArg arg in reaction.Args)
            {
                if (ev is not null)
                {
                    checker.Check(arg.Value, eventScope);
                }

                if (cmdParams is null)
                {
                    continue;
                }

                if (!provided.Add(arg.Parameter))
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.PolicyArgMismatch,
                        $"duplicate argument '{arg.Parameter}' in policy '{policy.Name}'", arg.Span));
                }

                if (!cmdParams.TryGetValue(arg.Parameter, out TypeRef? paramType))
                {
                    diagnostics.Add(Diagnostic.Error(DiagnosticCodes.PolicyArgMismatch,
                        $"command '{reaction.CommandName}' has no parameter '{arg.Parameter}'", arg.Span));
                }
                else if (ev is not null)
                {
                    TypeRef? valueType = resolver.Infer(arg.Value, eventScope);
                    if (valueType is not null && !MemberAnalysis.IsAssignable(valueType, paramType))
                    {
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.PolicyArgType,
                            $"argument '{arg.Parameter}' expects '{paramType.Name}', but the value is '{valueType.Name}'", arg.Span));
                    }
                }
            }

            if (cmdParams is not null)
            {
                foreach (Param p in cmd!.Parameters)
                {
                    if (!provided.Contains(p.Name))
                    {
                        diagnostics.Add(Diagnostic.Error(DiagnosticCodes.PolicyArgMismatch,
                            $"policy '{policy.Name}' is missing argument '{p.Name}'", reaction.Span));
                    }
                }
            }
        }
    }

    /// <summary>The root entity of a policy target (an aggregate's root, or the entity itself).</summary>
    private static EntityDecl? ResolveTargetRoot(string targetType, ModelIndex index)
    {
        if (!index.TryGetDecl(targetType, out TypeDecl decl))
        {
            return null;
        }

        return decl switch
        {
            EntityDecl e => e,
            AggregateDecl agg => agg.RootEntity(),
            _ => null
        };
    }

    /// <summary>
    /// Validates a quantity (R9.2): it must declare exactly one non-derived numeric
    /// amount member and exactly one enum-typed unit member, and nothing else, so the
    /// generated unit-checked arithmetic is well-defined.
    /// </summary>
    private static void ValidateQuantity(ValueObjectDecl q, ModelIndex index, List<Diagnostic> diagnostics)
    {
        var memberNames = MemberNameSet(q.Members);

        // The amount is a non-optional Decimal: this keeps scalar */÷ exact (an Int amount
        // would silently integer-divide / truncate when scaled by a fraction).
        bool IsAmount(Member m) => m.Type.Name == "Decimal" && !m.Type.IsOptional
            && !MemberAnalysis.IsDerived(m, memberNames);
        bool IsUnit(Member m) => index.Classify(m.Type.Name) == TypeKind.Enum && !m.Type.IsOptional
            && !MemberAnalysis.IsDerived(m, memberNames);

        // One pass, calling the local predicates directly (no Count(delegate) closures).
        var amountCount = 0;
        var unitCount = 0;
        foreach (Member m in q.Members)
        {
            if (IsAmount(m))
            {
                amountCount++;
            }

            if (IsUnit(m))
            {
                unitCount++;
            }
        }

        if (unitCount != 1)
        {
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.QuantityUnitCardinality,
                $"quantity '{q.Name}' must declare exactly one enum-typed unit member, found {unitCount}", q.Span));
        }

        if (amountCount != 1)
        {
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.QuantityAmountCardinality,
                $"quantity '{q.Name}' must declare exactly one Decimal amount member, found {amountCount}", q.Span));
        }

        // Only the amount and unit are restricted; derived/computed projections are fine.
        foreach (Member m in q.Members)
        {
            if (!MemberAnalysis.IsDerived(m, memberNames) && !IsAmount(m) && !IsUnit(m))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.QuantityMemberNotAllowed,
                    $"quantity '{q.Name}' may declare only its amount and unit members (plus derived projections); '{m.Name}' is not allowed",
                    m.Span));
            }
        }
    }

    /// <summary>
    /// Validates an enum's associated-data signature (R9.1): signature field types
    /// and uniqueness, reserved-name collisions with generated smart-enum members,
    /// per-member arity against the signature, and that each member value is a literal
    /// of a compatible type.
    /// </summary>
    private static void ValidateEnumAssociatedData(EnumDecl en, ModelIndex index, List<Diagnostic> diagnostics)
    {
        IReadOnlyList<Param> sig = en.Signature;

        var seenFields = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        // Names generated on every smart enum; an associated field of these would clash.
        var reserved = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Name", "Value", "All", "FromName", "FromValue", "TryFromName", "TryFromValue",
            "Match", "Switch", "ToString", "Equals", "GetHashCode"
        };
        // A field generates a PascalCase property; a member is emitted as a static field of
        // its (verbatim) name. If the two identifiers coincide the class declares one name
        // twice, so an associated field whose property name equals a member name also clashes.
        var memberNames = new HashSet<string>(en.MemberNames, StringComparer.Ordinal);
        foreach (Param p in sig)
        {
            ValidateTypeRef(p.Type, index, diagnostics);
            if (!seenFields.Add(p.Name))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateParameter,
                    $"duplicate associated-data field '{p.Name}' in enum '{en.Name}'", p.Span));
            }

            if (reserved.Contains(p.Name) || memberNames.Contains(PropertyKey(p.Name)))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EnumReservedAssociatedField,
                    $"associated-data field '{p.Name}' collides with a generated smart-enum member", p.Span));
            }

            // Associated values are literals, so the field must be a literal-expressible
            // primitive (v0: String/Int/Decimal/Bool) — not a collection, value, or enum.
            if (!IsLiteralFieldType(p.Type))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EnumAssociatedFieldType,
                    $"enum '{en.Name}' associated-data field '{p.Name}' must be String, Int, Decimal, or Bool", p.Span));
            }
        }

        foreach (EnumMember member in en.Members)
        {
            if (member.Args.Count != sig.Count)
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EnumMemberArity,
                    sig.Count == 0
                        ? $"enum '{en.Name}' has no associated-data signature but member '{member.Name}' supplies {member.Args.Count} value(s)"
                        : $"enum member '{member.Name}' supplies {member.Args.Count} value(s) but '{en.Name}' declares {sig.Count} field(s)",
                    member.Span));
                continue; // arity mismatch: per-arg type checks would be noise
            }

            // Only check values for fields with a valid literal type (an invalid field
            // type is already reported above; per-member checks would just be noise).
            for (var i = 0; i < sig.Count; i++)
            {
                if (IsLiteralFieldType(sig[i].Type))
                {
                    CheckEnumArg(member.Args[i], sig[i].Type, en.Name, sig[i].Name, diagnostics);
                }
            }
        }
    }

    /// <summary>The primitive types that can carry a literal associated value (R9.1).</summary>
    private static bool IsLiteralFieldType(TypeRef t) =>
        !t.IsOptional && t.Element is null && t.Name is "String" or "Bool" or "Int" or "Decimal";

    /// <summary>Checks a single enum associated value is a (possibly negated) literal of a compatible type.</summary>
    private static void CheckEnumArg(Expr arg, TypeRef expected, string enumName, string field, List<Diagnostic> diagnostics)
    {
        // A negative number parses as `-` applied to a numeric literal; accept it.
        (LiteralExpr? lit, var negated) = arg switch
        {
            LiteralExpr l => (l, false),
            UnaryExpr { Op: UnaryOp.Negate, Operand: LiteralExpr l } => (l, true),
            _ => (null, false)
        };

        if (lit is null || (negated && lit.Kind is not (LiteralKind.Int or LiteralKind.Decimal)))
        {
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EnumMemberArgType,
                $"enum '{enumName}' associated value for '{field}' must be a literal", arg.Span));
            return;
        }

        var ok = expected.Name switch
        {
            "String" => lit.Kind == LiteralKind.String,
            "Bool" => lit.Kind == LiteralKind.Bool,
            "Int" => lit.Kind == LiteralKind.Int,
            "Decimal" => lit.Kind is LiteralKind.Int or LiteralKind.Decimal, // Int widens to Decimal
            _ => false
        };
        if (!ok)
        {
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.EnumMemberArgType,
                $"enum '{enumName}' field '{field}' expects '{expected.Name}', but got a {lit.Kind.ToString().ToLowerInvariant()} literal",
                arg.Span));
        }
    }

    internal static void ValidateTypeRef(TypeRef type, ModelIndex index, List<Diagnostic> diagnostics)
    {
        // Resilient syntax: an empty-named TypeRef is the placeholder the builder fills in for a
        // type reference the parser couldn't recover (e.g. `amount:` with no type). Reporting
        // "unknown type ''" would be a spurious cascade off a syntax error already diagnosed
        // upstream, so skip it (and don't recurse into its — likewise placeholder — arguments).
        if (IsPlaceholder(type))
        {
            return;
        }

        // Classify once: the unknown-type, arity, and Range-orderable checks below all consult it.
        TypeKind kind = index.Classify(type.Name);

        // A qualified `Context.T` is validated by the context-scoping pass (UnknownContext /
        // NotExported); skip the global unknown-type check here to avoid a double report.
        if (type.Qualifier is null && kind == TypeKind.Unknown)
        {
            // Keep the message prose EXACTLY as-is (snapshots depend on it); additionally surface the
            // bare candidate as the structured Suggestion the code-fix providers read (no prose scraping).
            var best = Suggestions.Best(type.Name, index.CandidateTypeNames);
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownType,
                $"unknown type '{type.Name}'{Suggestions.For(type.Name, index.CandidateTypeNames)}",
                type.Span) with
            { Suggestion = best });
        }

        // Generic arity: List/Set/Range take one type argument; Map takes two.
        switch (kind)
        {
            case TypeKind.List or TypeKind.Set or TypeKind.Range:
                if (type.Element is null)
                {
                    diagnostics.Add(Diagnostic.FromSpan(DiagnosticCodes.GenericArity, $"'{type.Name}' requires a type argument", type.Span));
                }

                if (type.Value is not null)
                {
                    diagnostics.Add(Diagnostic.FromSpan(DiagnosticCodes.GenericArity, $"'{type.Name}' takes a single type argument", type.Span));
                }

                break;
            case TypeKind.Map:
                if (type.Element is null || type.Value is null)
                {
                    diagnostics.Add(Diagnostic.FromSpan(DiagnosticCodes.GenericArity, "'Map' requires two type arguments <Key, Value>", type.Span));
                }

                break;
        }

        // A Range is ordered, so its element must be an orderable type (Int/Decimal/Instant).
        // Only flag a KNOWN non-orderable element; an unknown element is already KOI0101.
        if (kind == TypeKind.Range && type.Element is not null
            && index.IsKnownType(type.Element.Name) && !BuiltinOps.IsOrderable(type.Element.Name))
        {
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.RangeNotOrderable,
                $"range element type '{type.Element.Name}' is not orderable; ranges require Int, Decimal, or Instant",
                type.Element.Span));
        }

        if (type.Element is not null)
        {
            ValidateTypeRef(type.Element, index, diagnostics);
        }

        if (type.Value is not null)
        {
            ValidateTypeRef(type.Value, index, diagnostics);
        }
    }

    /// <summary>
    /// Finds the root identifier of an expression by following
    /// <see cref="MemberAccessExpr.Target"/> chains down to an
    /// <see cref="IdentifierExpr"/>. Returns <c>null</c> when the chain does not
    /// bottom out in a bare identifier.
    /// </summary>
    public static IdentifierExpr? RootIdentifier(Expr expr) => expr switch
    {
        IdentifierExpr id => id,
        MemberAccessExpr ma => RootIdentifier(ma.Target),
        _ => null
    };

    // ------------------------------------------------------------------------
    // Resilient-syntax guards (#R: error-tolerant parsing)
    // ------------------------------------------------------------------------

    /// <summary>
    /// <c>true</c> for a node that is a syntax-recovery artifact rather than a real construct: an
    /// <see cref="ErrorNode"/> recovery marker or an ANTLR-synthesized <see cref="KoineNode.IsMissing"/>
    /// phantom. Validators skip such nodes so a partial (recovered) model produces no spurious
    /// semantic cascade off the error region — the syntax error itself is already diagnosed upstream.
    /// </summary>
    internal static bool IsErrorOrMissing(KoineNode node) => node is ErrorNode || node.IsMissing;

    /// <summary>
    /// <c>true</c> when a name is the empty-named placeholder the builder fills in for a required
    /// declaration/identifier the parser could not recover (e.g. <c>TypeRef("")</c>,
    /// <c>IdentifierExpr("")</c>, an empty-named member). Used to suppress diagnostics that would
    /// otherwise report on the empty name (e.g. "unknown type ''").
    /// </summary>
    internal static bool IsPlaceholder(string? name) => string.IsNullOrEmpty(name);

    /// <summary>A <see cref="TypeRef"/> is a placeholder when it is an error/missing node or empty-named.</summary>
    internal static bool IsPlaceholder(TypeRef type) => IsErrorOrMissing(type) || IsPlaceholder(type.Name);
}
