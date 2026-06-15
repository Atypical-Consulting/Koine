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

/// <summary>A bounded context — the top-level namespace for a group of types.</summary>
public sealed record ContextNode(string Name, IReadOnlyList<TypeDecl> Types) : KoineNode;

/// <summary>Base type for the four declarable kinds: value, entity, aggregate, enum.</summary>
public abstract record TypeDecl(string Name) : KoineNode;

/// <summary>A value object: immutable, value-equality, validated by invariants.</summary>
public sealed record ValueObjectDecl(
    string Name,
    IReadOnlyList<Member> Members,
    IReadOnlyList<Invariant> Invariants) : TypeDecl(Name);

/// <summary>An entity: identity-based equality via a generated <c>IdentityName</c> ID type.</summary>
public sealed record EntityDecl(
    string Name,
    string IdentityName,
    IReadOnlyList<Member> Members,
    IReadOnlyList<Invariant> Invariants,
    IReadOnlyList<CommandDecl> Commands,
    IReadOnlyList<StatesDecl> States,
    IReadOnlyList<FactoryDecl> Factories) : TypeDecl(Name);

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

/// <summary>An aggregate: a boundary owning nested types, one of which is the root.</summary>
public sealed record AggregateDecl(
    string Name,
    string RootName,
    IReadOnlyList<TypeDecl> Types) : TypeDecl(Name);

/// <summary>An enumeration of named members.</summary>
public sealed record EnumDecl(
    string Name,
    IReadOnlyList<string> Members) : TypeDecl(Name);

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
