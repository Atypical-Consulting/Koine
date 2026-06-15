namespace Koine.Compiler.Ast;

// ============================================================================
// Koine semantic model (AST). TARGET-AGNOSTIC: this namespace must contain no
// C#-specific concepts. All C# decisions live in Emit/CSharp/.
//
// Every node carries a 1-based SourceSpan so semantic diagnostics can point at
// the offending construct.
// ============================================================================

/// <summary>Base type for every node in the semantic model.</summary>
public abstract record KoineNode
{
    public SourceSpan Span { get; init; } = SourceSpan.None;

    /// <summary>
    /// The <c>///</c> doc comment attached to this declaration/member, with the
    /// leading <c>///</c> stripped and lines joined by <c>\n</c>; <c>null</c> when
    /// none. Target-agnostic: no markup. The emitter decides how to render it.
    /// </summary>
    public string? Doc { get; init; }
}

/// <summary>Root of the model: the set of bounded contexts in a compilation.</summary>
public sealed record KoineModel(IReadOnlyList<ContextNode> Contexts) : KoineNode;

/// <summary>
/// A bounded context — the top-level namespace for a group of types, plus its
/// behavioral declarations: specifications, domain services, and policies (R10).
/// </summary>
public sealed record ContextNode(
    string Name,
    IReadOnlyList<TypeDecl> Types,
    IReadOnlyList<SpecDecl> Specs,
    IReadOnlyList<ServiceDecl> Services,
    IReadOnlyList<PolicyDecl> Policies) : KoineNode;

/// <summary>Base type for the four declarable kinds: value, entity, aggregate, enum.</summary>
public abstract record TypeDecl(string Name) : KoineNode;

/// <summary>
/// A value object: immutable, value-equality, validated by invariants. When
/// <see cref="IsQuantity"/> is set it was declared with the <c>quantity</c> keyword:
/// a numeric amount plus an enum unit, emitted with unit-checked arithmetic.
/// </summary>
public sealed record ValueObjectDecl(
    string Name,
    IReadOnlyList<Member> Members,
    IReadOnlyList<Invariant> Invariants,
    bool IsQuantity = false) : TypeDecl(Name);

/// <summary>
/// How an entity's identity value object is generated and typed (R11.1).
/// TARGET-AGNOSTIC: the emitter, not the parser, maps each strategy to a concrete
/// representation (Guid wrapper, sequence-assigned long, or a natural key).
/// </summary>
public enum IdentityStrategy
{
    /// <summary>The default: a <c>Guid</c>-wrapping ID with a client-side <c>New()</c>.</summary>
    Guid,
    /// <summary>A store-assigned numeric key (no client-side <c>New()</c>).</summary>
    Sequence,
    /// <summary>A natural key over a primitive (<c>String</c>/<c>Int</c>), value-validated, no <c>New()</c>.</summary>
    Natural
}

/// <summary>
/// An entity: identity-based equality via a generated <c>IdentityName</c> ID type.
/// <see cref="IdStrategy"/> selects how that ID is generated (R11.1); for
/// <see cref="IdentityStrategy.Natural"/>, <see cref="IdBackingType"/> names the
/// primitive the key wraps (e.g. <c>String</c>).
/// </summary>
public sealed record EntityDecl(
    string Name,
    string IdentityName,
    IReadOnlyList<Member> Members,
    IReadOnlyList<Invariant> Invariants,
    IReadOnlyList<CommandDecl> Commands,
    IReadOnlyList<StatesDecl> States,
    IReadOnlyList<FactoryDecl> Factories,
    IdentityStrategy IdStrategy = IdentityStrategy.Guid,
    string? IdBackingType = null) : TypeDecl(Name);

/// <summary>
/// A state machine bound to an enum-typed lifecycle field, defining the legal
/// transitions between its states. TARGET-AGNOSTIC.
/// </summary>
public sealed record StatesDecl(string Field, IReadOnlyList<StateRule> Rules) : KoineNode;

/// <summary>
/// One line of a state machine: <c>From -&gt; To1, To2 [when Guard]</c>. A rule with
/// no targets declares a (possibly terminal) state; <see cref="Guard"/> is an
/// optional per-rule precondition.
/// </summary>
public sealed record StateRule(string From, IReadOnlyList<string> To, Expr? Guard) : KoineNode;

/// <summary>
/// An aggregate: a boundary owning nested types (one is the root) and specs. When
/// <see cref="IsVersioned"/> is set the root carries an optimistic-concurrency token
/// (R11.4). <see cref="Repository"/> declares the generated repository contract for
/// the root (R11.3); <c>null</c> means the default contract is emitted.
/// </summary>
public sealed record AggregateDecl(
    string Name,
    string RootName,
    IReadOnlyList<TypeDecl> Types,
    IReadOnlyList<SpecDecl> Specs,
    bool IsVersioned = false,
    RepositoryDecl? Repository = null) : TypeDecl(Name);

/// <summary>
/// The repository contract for an aggregate root (R11.3): which mutating
/// <see cref="Operations"/> it exposes (<c>null</c> => the default set) and its
/// declarative <see cref="Finders"/>. TARGET-AGNOSTIC.
/// </summary>
public sealed record RepositoryDecl(
    IReadOnlyList<string>? Operations,
    IReadOnlyList<FinderDecl> Finders) : KoineNode;

/// <summary>
/// A declarative repository finder: <c>find byCustomer(customer: CustomerId): List&lt;Order&gt;</c>.
/// <see cref="ResultType"/> is the aggregate root (single result) or a
/// <c>List&lt;Root&gt;</c> (collection result).
/// </summary>
public sealed record FinderDecl(
    string Name,
    IReadOnlyList<Param> Parameters,
    TypeRef ResultType) : KoineNode;

/// <summary>
/// An enumeration of named members. When <see cref="Signature"/> is non-empty the
/// members carry associated constant data (e.g. <c>EUR("€", 2)</c>); otherwise it
/// is a bare-name enum. <see cref="EnumMember.Args"/> are target-agnostic literal
/// expressions, not C# values.
/// </summary>
public sealed record EnumDecl(
    string Name,
    IReadOnlyList<EnumMember> Members,
    IReadOnlyList<Param> Signature) : TypeDecl(Name)
{
    /// <summary>Member names in declaration order (back-compat for name-only call sites).</summary>
    public IReadOnlyList<string> MemberNames => Members.Select(m => m.Name).ToArray();

    /// <summary>True when members carry associated constant data.</summary>
    public bool HasAssociatedData => Signature.Count > 0;
}

/// <summary>
/// One enum member. <see cref="Args"/> are the associated-data values (literal
/// expressions, positional, matching the owning enum's signature); empty for a
/// bare-name member.
/// </summary>
public sealed record EnumMember(string Name, IReadOnlyList<Expr> Args) : KoineNode;

/// <summary>
/// A domain event: an immutable, value-equal record of a significant occurrence,
/// with typed fields (and generated occurrence metadata). TARGET-AGNOSTIC.
/// </summary>
public sealed record EventDecl(
    string Name,
    IReadOnlyList<Member> Members) : TypeDecl(Name);

/// <summary>
/// A field of a value/entity. <see cref="Initializer"/> is set when the field
/// is written as <c>name: Type = expr</c>; it represents either a constant
/// default (e.g. <c>status = Draft</c>) or a derived/computed value
/// (e.g. <c>subtotal = unitPrice * quantity</c>). Use
/// <see cref="MemberAnalysis.IsDerived"/> to distinguish the two.
/// </summary>
public sealed record Member(string Name, TypeRef Type, Expr? Initializer) : KoineNode;

/// <summary>
/// A reference to a type. <see cref="Element"/> is the (first) type argument for a
/// generic (e.g. <c>List&lt;OrderLine&gt;</c>, or the key of a <c>Map&lt;K,V&gt;</c>);
/// <see cref="Value"/> is the second type argument (a <c>Map</c>'s value type).
/// <see cref="IsOptional"/> marks a nullable field (<c>String?</c>). Resolution and
/// classification are done by <see cref="ModelIndex"/>.
/// </summary>
public sealed record TypeRef(
    string Name,
    TypeRef? Element = null,
    TypeRef? Value = null,
    bool IsOptional = false) : KoineNode;

/// <summary>
/// An invariant: a boolean <see cref="Expr"/> that must hold, with an optional
/// human-readable <see cref="Message"/>. A <c>when</c>-guard is represented as a
/// <see cref="GuardExpr"/> in <see cref="Condition"/>.
/// </summary>
public sealed record Invariant(Expr Condition, string? Message) : KoineNode;

/// <summary>
/// A state-changing operation on an entity: named, with typed parameters,
/// preconditions, and state transitions. TARGET-AGNOSTIC.
/// </summary>
public sealed record CommandDecl(
    string Name,
    IReadOnlyList<Param> Parameters,
    IReadOnlyList<CommandStmt> Body) : KoineNode;

/// <summary>A typed command parameter.</summary>
public sealed record Param(string Name, TypeRef Type) : KoineNode;

/// <summary>
/// A factory: an intention-revealing creation operation on an aggregate root.
/// Named, with typed parameters, preconditions (<c>requires</c>), field
/// initializations (<c>field &lt;- expr</c>), and creation events (<c>emit</c>).
/// Identity is generated automatically. TARGET-AGNOSTIC.
/// </summary>
public sealed record FactoryDecl(
    string Name,
    IReadOnlyList<Param> Parameters,
    IReadOnlyList<CommandStmt> Body) : KoineNode;

/// <summary>Base type for the statements that make up a command body.</summary>
public abstract record CommandStmt : KoineNode;

/// <summary>A precondition: <c>requires &lt;Condition&gt; "Message"</c>, checked before any mutation.</summary>
public sealed record RequiresClause(Expr Condition, string? Message) : CommandStmt;

/// <summary>A state transition: <c>Field -&gt; Value</c>, assigning a new value to a mutable field.</summary>
public sealed record Transition(string Field, Expr Value) : CommandStmt;

/// <summary>
/// A factory field initialization: <c>Field &lt;- Value</c>, supplying a member's
/// value at construction time (used inside a <see cref="FactoryDecl"/> body).
/// </summary>
public sealed record Initialization(string Field, Expr Value) : CommandStmt;

/// <summary>Records a domain event: <c>emit EventName(field: value, ...)</c>.</summary>
public sealed record EmitClause(string EventName, IReadOnlyList<EmitArg> Args) : CommandStmt;

/// <summary>A named payload argument of an <see cref="EmitClause"/>: <c>field: value</c>.</summary>
public sealed record EmitArg(string Field, Expr Value) : KoineNode;

// ----------------------------------------------------------------------------
// R10 — Specifications, domain services, policies. All TARGET-AGNOSTIC.
// ----------------------------------------------------------------------------

/// <summary>
/// A named, reusable specification: a boolean <see cref="Condition"/> over the
/// members of <see cref="TargetType"/>. Referenceable by name inside that type's
/// invariants, command preconditions, derived members, and other specs.
/// </summary>
public sealed record SpecDecl(string Name, string TargetType, Expr Condition) : KoineNode;

/// <summary>
/// A service: a named group of pure domain <see cref="Operations"/> (R10.2, emitted as a
/// stateless class) and/or application <see cref="UseCases"/> (R12.2, emitted as an
/// <c>I&lt;Name&gt;</c> interface). Either list may be empty.
/// </summary>
public sealed record ServiceDecl(
    string Name,
    IReadOnlyList<OperationDecl> Operations,
    IReadOnlyList<UseCaseDecl> UseCases) : KoineNode;

/// <summary>
/// An application use case: a named operation with typed inputs and an optional
/// output (<c>null</c> = a command-style use case returning <c>Task</c>). TARGET-AGNOSTIC.
/// </summary>
public sealed record UseCaseDecl(
    string Name,
    IReadOnlyList<Param> Parameters,
    TypeRef? ReturnType) : KoineNode;

/// <summary>
/// A read model (R12.3): a flat DTO projected from <see cref="SourceType"/>. Emitted as a
/// value-equal record plus a static projection mapper. TARGET-AGNOSTIC.
/// </summary>
public sealed record ReadModelDecl(
    string Name,
    string SourceType,
    IReadOnlyList<ReadModelField> Fields) : TypeDecl(Name);

/// <summary>
/// One read-model field. A <em>direct</em> field (<see cref="Type"/> and
/// <see cref="Projection"/> both <c>null</c>) maps to the source member of the same name;
/// a <em>derived</em> field (both set) projects <see cref="Projection"/> as <see cref="Type"/>.
/// </summary>
public sealed record ReadModelField(
    string Name,
    TypeRef? Type,
    Expr? Projection) : KoineNode;

/// <summary>
/// A query object (R12.4): typed <see cref="Criteria"/> over a read model, with a single
/// or list <see cref="ResultType"/>. Emitted as a DTO record handled via the generic
/// <c>IQueryHandler&lt;TQuery,TResult&gt;</c>. TARGET-AGNOSTIC.
/// </summary>
public sealed record QueryDecl(
    string Name,
    IReadOnlyList<Param> Criteria,
    TypeRef ResultType) : TypeDecl(Name);

/// <summary>
/// A domain-service operation. <see cref="Body"/> is the pure result expression when
/// declared as <c>op(...): R = expr</c>; <c>null</c> marks a seam (an abstract operation
/// whose implementation is supplied by hand).
/// </summary>
public sealed record OperationDecl(
    string Name,
    IReadOnlyList<Param> Parameters,
    TypeRef ReturnType,
    Expr? Body) : KoineNode;

/// <summary>
/// A policy: when <see cref="EventName"/> occurs, the intended <see cref="Reaction"/>
/// (a command on another aggregate) should run. Koine emits a handler seam, not the
/// imperative call.
/// </summary>
public sealed record PolicyDecl(string Name, string EventName, PolicyReaction Reaction) : KoineNode;

/// <summary>The reaction of a <see cref="PolicyDecl"/>: <c>Target.command(args)</c>.</summary>
public sealed record PolicyReaction(string TargetType, string CommandName, IReadOnlyList<PolicyArg> Args) : KoineNode;

/// <summary>A named argument of a <see cref="PolicyReaction"/>, drawn from the event's fields.</summary>
public sealed record PolicyArg(string Parameter, Expr Value) : KoineNode;
