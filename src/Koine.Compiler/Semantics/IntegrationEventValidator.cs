using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;

namespace Koine.Compiler.Semantics;

/// <summary>
/// R14.3 — integration events, publish &amp; subscribe. Split out of
/// <see cref="SemanticValidator"/>; the orchestrator calls <see cref="Validate"/>
/// once per context in the same position as before, preserving diagnostic codes,
/// messages, and emission order.
/// </summary>
internal static class IntegrationEventValidator
{
    /// <summary>
    /// Validates integration events (R14.3): field types may not leak internal types; a context may
    /// only publish a locally-declared integration event (no duplicates); a subscription must name a
    /// declared context that actually publishes the event, authorized by the context map.
    /// </summary>
    public static void Validate(
        ContextNode ctx, ModelIndex index, bool hasContextMap, List<Diagnostic> diagnostics)
    {
        // 1. Field-type leak check (KOI1409).
        foreach (TypeDecl decl in ctx.AllTypeDecls())
        {
            if (decl is IntegrationEventDecl ev)
            {
                foreach (Member m in ev.Members)
                {
                    CheckIntegrationEventFieldType(ctx.Name, m.Type, index, diagnostics);
                }
            }
        }

        // 2. publishes: must name a local integration event; no duplicates.
        var published = new HashSet<string>(StringComparer.Ordinal);
        foreach (PublishDecl p in ctx.Publishes)
        {
            if (!published.Add(p.EventName))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicatePublish,
                    $"context '{ctx.Name}' publishes '{p.EventName}' more than once", p.Span));
            }
            else if (!index.IsIntegrationEventIn(ctx.Name, p.EventName))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.UnknownPublishedEvent,
                    $"'{p.EventName}' is not an integration event declared in context '{ctx.Name}'", p.Span));
            }
        }

        // 3. subscribes: declared publisher context, actually published, map-authorized; no duplicates.
        //    The handler seam is named IHandle<Event> from the simple event name, so two events that
        //    share a name (from different publishers) would collide — reject that case (KOI1417).
        var subscribed = new HashSet<(string, string)>();
        var handlerNames = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (SubscribeDecl s in ctx.Subscribes)
        {
            if (!subscribed.Add((s.Context, s.EventName)))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.DuplicateSubscribe,
                    $"context '{ctx.Name}' subscribes to '{s.Context}.{s.EventName}' more than once", s.Span));
                continue;
            }
            if (handlerNames.TryGetValue(s.EventName, out var otherPublisher) && otherPublisher != s.Context)
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.SubscribeHandlerNameCollision,
                    $"context '{ctx.Name}' subscribes to '{s.EventName}' from both '{otherPublisher}' and '{s.Context}'; the generated IHandle{s.EventName} handler would collide", s.Span));
            }
            else
            {
                handlerNames[s.EventName] = s.Context;
            }

            if (!index.IsContext(s.Context))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.SubscribeUnknownContext,
                    $"subscribe to unknown context '{s.Context}'", s.Span));
                continue;
            }
            if (!index.PublishesEvent(s.Context, s.EventName))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.SubscribeNotPublished,
                    $"context '{s.Context}' does not publish an integration event '{s.EventName}'", s.Span));
                continue;
            }
            // A subscribe requires an authorizing relation — but only once a map is declared at all.
            if (hasContextMap && !index.MaySubscribe(s.Context, ctx.Name))
            {
                diagnostics.Add(Diagnostic.Error(DiagnosticCodes.SubscribeNoRelation,
                    $"context '{ctx.Name}' may not subscribe to '{s.Context}.{s.EventName}': no open-host, published-language, or customer-supplier relation from '{s.Context}' authorizes it", s.Span));
            }
        }
    }

    /// <summary>
    /// Reports an integration-event field whose (possibly nested) type references an internal type.
    /// Allowed: primitives, enums, ID value objects, other integration events, and collections of those.
    /// </summary>
    private static void CheckIntegrationEventFieldType(
        string context, TypeRef tr, ModelIndex index, List<Diagnostic> diagnostics)
    {
        TypeKind kind = index.Classify(tr.Name);
        var allowed = kind switch
        {
            TypeKind.Primitive or TypeKind.List or TypeKind.Set or TypeKind.Map or TypeKind.Range => true,
            TypeKind.Enum or TypeKind.IdValueObject or TypeKind.IntegrationEvent => true,
            // A qualified foreign integration event is allowed even if the local Classify can't see it.
            TypeKind.Unknown when tr.Qualifier is { } q && index.IsIntegrationEventIn(q, tr.Name) => true,
            TypeKind.Unknown => true,   // genuinely-unknown names are reported as KOI0101 elsewhere
            _ => false                  // Value, Entity, Aggregate, Event (domain), ReadModel, Query
        };
        if (!allowed)
        {
            diagnostics.Add(Diagnostic.Error(DiagnosticCodes.IntegrationEventLeaksInternals,
                $"integration-event field type '{tr.Name}' references an internal type; only primitives, enums, ID value objects, and other integration events may cross a boundary", tr.Span));
        }

        if (tr.Element is not null)
        {
            CheckIntegrationEventFieldType(context, tr.Element, index, diagnostics);
        }

        if (tr.Value is not null)
        {
            CheckIntegrationEventFieldType(context, tr.Value, index, diagnostics);
        }
    }
}
