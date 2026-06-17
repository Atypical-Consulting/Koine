using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Docs;

/// <summary>
/// Narrative slice of <see cref="DocsEmitter"/>: per-context prose lifting the ubiquitous-language
/// terms (value objects, enums, events, invariants) and weaving the Mermaid diagrams (aggregate
/// class diagram, entity state machine) inline. Deterministic: declaration order throughout.
/// </summary>
public sealed partial class DocsEmitter
{
    /// <summary>Writes the full document for one bounded context.</summary>
    private static void WriteContextNarrative(StringBuilder sb, ContextNode ctx)
    {
        sb.Append("# ").Append(ctx.Name);
        if (ctx.Version is { } version)
        {
            sb.Append(" — version ").Append(version);
        }

        sb.Append('\n');

        if (!string.IsNullOrEmpty(ctx.Doc))
        {
            sb.Append('\n').Append(Prose(ctx.Doc)).Append('\n');
        }

        WriteAggregateNarratives(sb, ctx);
        WriteStandaloneTypes(sb, ctx);
        WriteBehavioralNarrative(sb, ctx);

        if (!HasRenderableContent(ctx))
        {
            // A context with no types or behavioral declarations would otherwise be a heading-only
            // page; leave a note so the generated doc reads intentionally, not truncated.
            sb.Append("\n_This bounded context has no declared types yet._\n");
        }
    }

    /// <summary>True when the context declares anything the narrative renders below its heading.</summary>
    private static bool HasRenderableContent(ContextNode ctx) =>
        ctx.Types.Count > 0 || ctx.Specs.Count > 0 || ctx.Services.Count > 0 || ctx.Policies.Count > 0;

    /// <summary>Writes one section per aggregate: structure diagram, nested-type glossary, lifecycle.</summary>
    private static void WriteAggregateNarratives(StringBuilder sb, ContextNode ctx)
    {
        var aggregates = ctx.Types.OfType<AggregateDecl>().ToList();
        if (aggregates.Count == 0)
        {
            return;
        }

        sb.Append("\n## Aggregates\n");

        foreach (AggregateDecl agg in aggregates)
        {
            sb.Append("\n### ").Append(agg.Name);
            if (agg.IsVersioned)
            {
                sb.Append(" _(versioned)_");
            }

            sb.Append(Tag(agg)).Append('\n');

            if (!string.IsNullOrEmpty(agg.Doc))
            {
                sb.Append('\n').Append(Prose(agg.Doc)).Append('\n');
            }

            EntityDecl? root = agg.RootEntity();
            if (root is not null)
            {
                sb.Append("\n**Root entity:** `").Append(root.Name)
                  .Append("` (identified by `").Append(root.IdentityName).Append("`)\n");
            }

            // Structure: a Mermaid class diagram of the root + nested types + repository surface.
            EmitAggregateClassDiagram(sb, agg);

            // Glossary of the nested value objects, enums, and domain events.
            WriteAggregateTypesGlossary(sb, agg);

            // Lifecycle: state machine diagram, commands, factories, invariants.
            if (root is not null)
            {
                WriteEntityLifecycle(sb, ctx, root);
            }

            if (agg.Specs.Count > 0)
            {
                sb.Append("\n#### Specifications\n");
                foreach (SpecDecl spec in agg.Specs)
                {
                    sb.Append("\n- `").Append(spec.Name).Append("` on `").Append(spec.TargetType)
                      .Append("` — `").Append(Describe(spec.Condition)).Append("`\n");
                }
            }
        }
    }

    /// <summary>Writes the glossary-style nested-types section for an aggregate.</summary>
    private static void WriteAggregateTypesGlossary(StringBuilder sb, AggregateDecl agg)
    {
        var valueObjects = agg.Types.OfType<ValueObjectDecl>().ToList();
        var enums = agg.Types.OfType<EnumDecl>().ToList();
        var events = agg.Types.OfType<EventDecl>().ToList();

        if (valueObjects.Count > 0)
        {
            sb.Append("\n#### Value Objects\n");
            foreach (ValueObjectDecl vo in valueObjects)
            {
                sb.Append("\n**`").Append(vo.Name).Append("`**")
                  .Append(vo.IsQuantity ? " _(quantity)_" : string.Empty)
                  .Append(Tag(vo)).Append('\n');
                if (!string.IsNullOrEmpty(vo.Doc))
                {
                    sb.Append('\n').Append(Prose(vo.Doc)).Append('\n');
                }

                WriteFields(sb, vo.Members);
                WriteRules(sb, vo.Invariants);
            }
        }

        if (enums.Count > 0)
        {
            sb.Append("\n#### Enumerations\n");
            foreach (EnumDecl en in enums)
            {
                sb.Append("\n**`").Append(en.Name).Append("`**").Append(Tag(en)).Append('\n');
                if (!string.IsNullOrEmpty(en.Doc))
                {
                    sb.Append('\n').Append(Prose(en.Doc)).Append('\n');
                }

                sb.Append("\nValues: ").Append(EnumValues(en)).Append('\n');
            }
        }

        if (events.Count > 0)
        {
            sb.Append("\n#### Domain Events\n");
            foreach (EventDecl ev in events)
            {
                sb.Append("\n**`").Append(ev.Name).Append("`**").Append(Tag(ev)).Append('\n');
                if (!string.IsNullOrEmpty(ev.Doc))
                {
                    sb.Append('\n').Append(Prose(ev.Doc)).Append('\n');
                }

                WriteFields(sb, ev.Members);
            }
        }
    }

    /// <summary>Writes the lifecycle: state-machine diagram (if any), commands, factories, invariants.</summary>
    private static void WriteEntityLifecycle(StringBuilder sb, ContextNode ctx, EntityDecl entity)
    {
        if (entity.States.Count > 0)
        {
            sb.Append("\n#### Lifecycle\n");
            EmitStateMachines(sb, entity);
        }

        if (entity.Commands.Count > 0)
        {
            sb.Append("\n#### Commands\n");
            foreach (CommandDecl cmd in entity.Commands)
            {
                WriteBehavior(sb, cmd.Name, cmd.Parameters, cmd.Doc, cmd.Body, cmd.ReturnType);
            }
        }

        if (entity.Factories.Count > 0)
        {
            sb.Append("\n#### Factory Operations\n");
            foreach (FactoryDecl factory in entity.Factories)
            {
                WriteBehavior(sb, factory.Name, factory.Parameters, factory.Doc, factory.Body, returnType: null);
            }
        }

        if (entity.Invariants.Count > 0)
        {
            sb.Append("\n#### Invariants\n");
            WriteRules(sb, entity.Invariants);
        }
    }

    /// <summary>Writes a command/factory: signature, doc, preconditions, effects, and emitted events.</summary>
    private static void WriteBehavior(
        StringBuilder sb,
        string name,
        IReadOnlyList<Param> parameters,
        string? doc,
        IReadOnlyList<CommandStmt> body,
        TypeRef? returnType)
    {
        sb.Append("\n##### `").Append(name).Append('(')
          .Append(string.Join(", ", parameters.Select(p => $"{p.Name}: {KoineType(p.Type)}")))
          .Append(')');
        if (returnType is not null)
        {
            sb.Append(": ").Append(KoineType(returnType));
        }

        sb.Append("`\n");

        if (!string.IsNullOrEmpty(doc))
        {
            sb.Append('\n').Append(Prose(doc)).Append('\n');
        }

        var requires = body.OfType<RequiresClause>().ToList();
        if (requires.Count > 0)
        {
            sb.Append("\n**Preconditions:**\n");
            foreach (RequiresClause req in requires)
            {
                sb.Append("- ").Append(Prose(req.Message ?? Describe(req.Condition))).Append('\n');
            }
        }

        var transitions = body.OfType<Transition>().ToList();
        var inits = body.OfType<Initialization>().ToList();
        if (transitions.Count > 0 || inits.Count > 0)
        {
            sb.Append("\n**Effects:**\n");
            foreach (Transition t in transitions)
            {
                sb.Append("- `").Append(t.Field).Append(" -> ").Append(Describe(t.Value)).Append("`\n");
            }

            foreach (Initialization init in inits)
            {
                sb.Append("- `").Append(init.Field).Append(" <- ").Append(Describe(init.Value)).Append("`\n");
            }
        }

        var emits = body.OfType<EmitClause>().ToList();
        if (emits.Count > 0)
        {
            sb.Append("\n**Events:**\n");
            foreach (EmitClause emit in emits)
            {
                sb.Append("- `").Append(emit.EventName).Append('(')
                  .Append(string.Join(", ", emit.Args.Select(a => $"{a.Field}: {Describe(a.Value)}")))
                  .Append(")`\n");
            }
        }
    }

    /// <summary>
    /// Writes context-level (standalone) types not nested in an aggregate: value objects, enums,
    /// entities, domain events, and integration events (with publish/subscribe status).
    /// </summary>
    private static void WriteStandaloneTypes(StringBuilder sb, ContextNode ctx)
    {
        var valueObjects = ctx.Types.OfType<ValueObjectDecl>().ToList();
        var enums = ctx.Types.OfType<EnumDecl>().ToList();
        var entities = ctx.Types.OfType<EntityDecl>().ToList();
        var events = ctx.Types.OfType<EventDecl>().ToList();
        var integrationEvents = ctx.Types.OfType<IntegrationEventDecl>().ToList();

        if (valueObjects.Count > 0 || enums.Count > 0 || entities.Count > 0)
        {
            sb.Append("\n## Domain Types\n");

            foreach (ValueObjectDecl vo in valueObjects)
            {
                sb.Append("\n### ").Append(vo.Name).Append(vo.IsQuantity ? " — quantity" : " — value object")
                  .Append(Tag(vo)).Append('\n');
                if (!string.IsNullOrEmpty(vo.Doc))
                {
                    sb.Append('\n').Append(Prose(vo.Doc)).Append('\n');
                }

                WriteFields(sb, vo.Members);
                WriteRules(sb, vo.Invariants);
            }

            foreach (EnumDecl en in enums)
            {
                sb.Append("\n### ").Append(en.Name).Append(" — enum").Append(Tag(en)).Append('\n');
                if (!string.IsNullOrEmpty(en.Doc))
                {
                    sb.Append('\n').Append(Prose(en.Doc)).Append('\n');
                }

                sb.Append("\nValues: ").Append(EnumValues(en)).Append('\n');
            }

            foreach (EntityDecl e in entities)
            {
                sb.Append("\n### ").Append(e.Name).Append(" — entity").Append(Tag(e)).Append('\n');
                if (!string.IsNullOrEmpty(e.Doc))
                {
                    sb.Append('\n').Append(Prose(e.Doc)).Append('\n');
                }

                sb.Append("\nIdentified by `").Append(e.IdentityName).Append("`.\n");
                WriteFields(sb, e.Members);

                // A standalone (non-aggregate) entity still carries behavior: render its full lifecycle
                // (state machine, commands, factories, invariants) the same way an aggregate root does.
                WriteEntityLifecycle(sb, ctx, e);
            }
        }

        if (events.Count > 0 || integrationEvents.Count > 0)
        {
            sb.Append("\n## Events\n");

            if (events.Count > 0)
            {
                sb.Append("\n### Domain Events\n");
                foreach (EventDecl ev in events)
                {
                    sb.Append("\n#### `").Append(ev.Name).Append('`').Append(Tag(ev)).Append('\n');
                    if (!string.IsNullOrEmpty(ev.Doc))
                    {
                        sb.Append('\n').Append(Prose(ev.Doc)).Append('\n');
                    }

                    WriteFields(sb, ev.Members);
                }
            }

            if (integrationEvents.Count > 0)
            {
                sb.Append("\n### Integration Events\n");
                foreach (IntegrationEventDecl ie in integrationEvents)
                {
                    sb.Append("\n#### `").Append(ie.Name).Append('`').Append(Tag(ie)).Append('\n');
                    if (!string.IsNullOrEmpty(ie.Doc))
                    {
                        sb.Append('\n').Append(Prose(ie.Doc)).Append('\n');
                    }

                    WriteFields(sb, ie.Members);

                    if (ctx.Publishes.Any(p => p.EventName == ie.Name))
                    {
                        sb.Append("\n_Published by this context._\n");
                    }
                }
            }
        }
    }

    /// <summary>Writes the R10 behavioral declarations: specifications, domain services, policies.</summary>
    private static void WriteBehavioralNarrative(StringBuilder sb, ContextNode ctx)
    {
        if (ctx.Specs.Count > 0)
        {
            sb.Append("\n## Specifications\n");
            foreach (SpecDecl spec in ctx.Specs)
            {
                sb.Append("\n### `").Append(spec.Name).Append("` on `").Append(spec.TargetType).Append("`\n");
                sb.Append("\nCondition: `").Append(Describe(spec.Condition)).Append("`\n");
            }
        }

        if (ctx.Services.Count > 0)
        {
            sb.Append("\n## Services\n");
            foreach (ServiceDecl svc in ctx.Services)
            {
                sb.Append("\n### `").Append(svc.Name).Append("`\n");
                if (!string.IsNullOrEmpty(svc.Doc))
                {
                    sb.Append('\n').Append(Prose(svc.Doc)).Append('\n');
                }

                if (svc.Operations.Count > 0)
                {
                    sb.Append("\n#### Operations\n");
                    foreach (OperationDecl op in svc.Operations)
                    {
                        sb.Append("\n- `").Append(op.Name).Append('(')
                          .Append(string.Join(", ", op.Parameters.Select(p => $"{p.Name}: {KoineType(p.Type)}")))
                          .Append("): ").Append(KoineType(op.ReturnType)).Append('`')
                          .Append(op.Body is null ? " _(seam)_" : string.Empty).Append('\n');
                    }
                }

                if (svc.UseCases.Count > 0)
                {
                    sb.Append("\n#### Use Cases\n");
                    foreach (UseCaseDecl uc in svc.UseCases)
                    {
                        sb.Append("\n- `").Append(uc.Name).Append('(')
                          .Append(string.Join(", ", uc.Parameters.Select(p => $"{p.Name}: {KoineType(p.Type)}")))
                          .Append(')')
                          .Append(uc.ReturnType is not null ? $": {KoineType(uc.ReturnType)}" : string.Empty)
                          .Append("`\n");
                    }
                }
            }
        }

        if (ctx.Policies.Count > 0)
        {
            sb.Append("\n## Policies\n");
            sb.Append("\n_When a domain event occurs, trigger a reaction on another aggregate._\n");
            foreach (PolicyDecl p in ctx.Policies)
            {
                sb.Append("\n### `").Append(p.Name).Append("` — when `").Append(p.EventName).Append("`\n");
                sb.Append("\nReaction: `").Append(p.Reaction.TargetType).Append('.')
                  .Append(p.Reaction.CommandName).Append('(')
                  .Append(string.Join(", ", p.Reaction.Args.Select(a => $"{a.Parameter}: {Describe(a.Value)}")))
                  .Append(")`\n");
            }
        }
    }
}
