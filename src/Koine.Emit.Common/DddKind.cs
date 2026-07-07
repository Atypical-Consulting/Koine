namespace Koine.Compiler.Emit;

/// <summary>
/// The canonical DDD-stereotype slugs stamped on <see cref="EmittedFile.Kind"/> — the
/// <c>--koi-ddd-*</c> vocabulary a UI (e.g. Koine Studio's Output rail) tints generated files by
/// building block. This is the single source of truth for the slug strings, shared across every
/// code emitter (C#, TypeScript, Python, PHP) so a rename here propagates everywhere.
/// <para>
/// Each backend still owns its own <c>KindFolder</c> → slug routing, because the on-disk folder
/// names differ per language (<c>ValueObjects</c> vs <c>value-objects</c> vs <c>value_objects</c>);
/// only the resulting slug vocabulary is centralized. Folders with no stereotype of their own —
/// pure abstractions and the opt-in Application/Infrastructure/Endpoints layers — carry no kind
/// (<c>null</c>), so they are intentionally absent here.
/// </para>
/// </summary>
internal static class DddKind
{
    /// <summary>An aggregate root entity (emitted at the context root).</summary>
    public const string Aggregate = "aggregate";

    /// <summary>A non-root entity.</summary>
    public const string Entity = "entity";

    /// <summary>A value object (and generated branded ID types, which live alongside value objects).</summary>
    public const string Value = "value";

    /// <summary>A smart enum.</summary>
    public const string Enum = "enum";

    /// <summary>A domain event.</summary>
    public const string Event = "event";

    /// <summary>An integration event.</summary>
    public const string IntegrationEvent = "integration-event";

    /// <summary>A CQRS read model (query DTO projection).</summary>
    public const string ReadModel = "read-model";

    /// <summary>A CQRS query.</summary>
    public const string Query = "query";

    /// <summary>A domain service.</summary>
    public const string Service = "service";

    /// <summary>A specification.</summary>
    public const string Spec = "spec";

    /// <summary>A policy.</summary>
    public const string Policy = "policy";

    /// <summary>A repository interface.</summary>
    public const string Repository = "repository";
}
