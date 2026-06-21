namespace Koine.Compiler.Ast;

/// <summary>The category of a resolved <see cref="Symbol"/>.</summary>
public enum SymbolKind
{
    Type,
    Member,
    EnumMember,
    Spec,
    IdValueObject,
    // Additive (Commit 3): binding-scope symbols that string resolution handled implicitly but never named.
    Context,
    Parameter,
    Local,
    LambdaParameter,
    Error
}

/// <summary>
/// A resolved declaration that a name refers to — the navigation/hover target for editor tooling.
/// Carries the declaration's <see cref="DeclSpan"/> (for go-to-definition) and its doc comment.
/// Produced by <see cref="SemanticModel.GetSymbol(string)"/>, the single resolution path the LSP services
/// share (replacing per-service string matching).
/// </summary>
public abstract class Symbol
{
    public string Name { get; }

    /// <summary>The source span of the declaration this symbol points at (go-to-definition target).</summary>
    public SourceSpan DeclSpan { get; }

    /// <summary>The declaration's doc comment, if any.</summary>
    public string? Doc { get; }

    public abstract SymbolKind Kind { get; }

    /// <summary>
    /// The Roslyn containment spine: the symbol that lexically encloses this one (a member's
    /// declaring type, a type's bounded context, a local's enclosing behavior), or <c>null</c> for a
    /// top-level <see cref="ContextSymbol"/> / the <see cref="ErrorSymbol"/>. Set by the
    /// <see cref="SymbolTable"/> builder during interning (an <c>init</c>-only auto-property), so
    /// every existing constructor and construction site stays source-compatible. Identity is by
    /// reference (interning); equality is never overridden.
    /// </summary>
    public Symbol? ContainingSymbol { get; init; }

    protected Symbol(string name, SourceSpan declSpan, string? doc)
    {
        Name = name;
        DeclSpan = declSpan;
        Doc = doc;
    }
}

/// <summary>A declared type (value object, entity, aggregate, enum, event, read model, query, …).</summary>
public sealed class TypeSymbol : Symbol
{
    /// <summary>The resolved classification of the declared type.</summary>
    public TypeKind TypeKind { get; }

    /// <summary>The declaration node.</summary>
    public TypeDecl Declaration { get; }

    public TypeSymbol(string name, SourceSpan declSpan, TypeKind typeKind, TypeDecl declaration)
        : base(name, declSpan, declaration.Doc)
    {
        TypeKind = typeKind;
        Declaration = declaration;
    }

    /// <summary>
    /// Downward navigation: the symbols this type declares — its fields (<see cref="MemberSymbol"/>)
    /// or enum members (<see cref="EnumMemberSymbol"/>) in declaration order, plus the behavior
    /// <see cref="ParameterSymbol"/>s interned for it. The inverse of a member's
    /// <see cref="Symbol.ContainingSymbol"/>; populated by the <see cref="SymbolTable"/> builder (an
    /// <c>init</c>-only list, source-compatible like <see cref="Symbol.ContainingSymbol"/>). Empty for
    /// types with no members.
    /// </summary>
    public IReadOnlyList<Symbol> Members { get; init; } = Array.Empty<Symbol>();

    public override SymbolKind Kind => SymbolKind.Type;
}

/// <summary>
/// A field of a value object / entity / event, referenced from within that type's expressions
/// (an invariant, command, or factory body). The navigation target for a member reference.
/// </summary>
public sealed class MemberSymbol : Symbol
{
    /// <summary>The simple name of the type that declares the member.</summary>
    public string OwnerType { get; }
    public Member Member { get; }

    public MemberSymbol(string name, SourceSpan declSpan, string ownerType, Member member)
        : base(name, declSpan, member.Doc)
    {
        OwnerType = ownerType;
        Member = member;
    }

    /// <summary>The declaring type symbol — the typed view of <see cref="Symbol.ContainingSymbol"/>.</summary>
    public TypeSymbol? ContainingType => ContainingSymbol as TypeSymbol;

    public override SymbolKind Kind => SymbolKind.Member;
}

/// <summary>An (unambiguous) enum member, owned by <see cref="EnumName"/>.</summary>
public sealed class EnumMemberSymbol : Symbol
{
    public string EnumName { get; }
    public EnumMember Member { get; }

    public EnumMemberSymbol(string name, SourceSpan declSpan, string enumName, EnumMember member)
        : base(name, declSpan, member.Doc)
    {
        EnumName = enumName;
        Member = member;
    }

    public override SymbolKind Kind => SymbolKind.EnumMember;
}

/// <summary>A named specification (R10.1) over a target type.</summary>
public sealed class SpecSymbol : Symbol
{
    public SpecDecl Declaration { get; }
    public string TargetType => Declaration.TargetType;

    public SpecSymbol(string name, SourceSpan declSpan, SpecDecl declaration)
        : base(name, declSpan, declaration.Doc)
    {
        Declaration = declaration;
    }

    public override SymbolKind Kind => SymbolKind.Spec;
}

/// <summary>
/// A generated ID value object (e.g. <c>OrderId</c>). There is no standalone declaration node, so the
/// symbol points at the entity that declares <c>identified by &lt;name&gt;</c> (navigation lands there).
/// <see cref="Owner"/> is <c>null</c> only for a <em>convention-only</em> <c>*Id</c> (a name matching
/// <c>^[A-Z]\w*Id$</c> referenced as a field type with no declaring entity); the legacy
/// <see cref="SemanticModel.GetSymbol(string)"/> never produces that case (it returns <c>null</c>),
/// but the binder interns it so a <c>product: ProductId</c> reference still has a stable symbol.
/// </summary>
public sealed class IdValueObjectSymbol : Symbol
{
    public EntityDecl? Owner { get; }

    public IdValueObjectSymbol(string name, SourceSpan declSpan, EntityDecl owner)
        : base(name, declSpan, owner.Doc)
    {
        Owner = owner;
    }

    /// <summary>Interns a convention-only <c>*Id</c> with no owning entity (binder-only).</summary>
    internal IdValueObjectSymbol(string name)
        : base(name, SourceSpan.None, doc: null)
    {
        Owner = null;
    }

    public override SymbolKind Kind => SymbolKind.IdValueObject;
}

/// <summary>
/// A bounded context (e.g. <c>Billing</c>) — the container for the types it declares. Resolves R13.2
/// name sharing structurally: two same-named <see cref="TypeSymbol"/>s differ by their
/// <see cref="Symbol.ContainingSymbol"/>. Deliberately named <c>ContextSymbol</c>, not
/// <c>NamespaceSymbol</c>: it models the Koine bounded context only — the unit R13.2 disambiguates on
/// — never a C#/TS module path (which <see cref="ModelIndex.NamespaceOf"/> computes separately).
/// </summary>
public sealed class ContextSymbol : Symbol
{
    public ContextNode Declaration { get; }

    public ContextSymbol(string name, SourceSpan declSpan, ContextNode declaration)
        : base(name, declSpan, declaration.Doc)
    {
        Declaration = declaration;
    }

    /// <summary>
    /// Downward navigation: the <see cref="TypeSymbol"/>s declared in this bounded context (the inverse
    /// of a type's <see cref="Symbol.ContainingSymbol"/>). Populated by the <see cref="SymbolTable"/>
    /// builder (an <c>init</c>-only list, source-compatible like <see cref="Symbol.ContainingSymbol"/>).
    /// </summary>
    public IReadOnlyList<TypeSymbol> Types { get; init; } = Array.Empty<TypeSymbol>();

    public override SymbolKind Kind => SymbolKind.Context;
}

/// <summary>A command/factory/operation/finder/query parameter; container is the behavior's owning type symbol.</summary>
public sealed class ParameterSymbol : Symbol
{
    public Param Declaration { get; }

    public ParameterSymbol(string name, SourceSpan declSpan, Param declaration)
        : base(name, declSpan, declaration.Doc)
    {
        Declaration = declaration;
    }

    /// <summary>The behavior's owning type symbol — the typed view of <see cref="Symbol.ContainingSymbol"/>.</summary>
    public TypeSymbol? ContainingType => ContainingSymbol as TypeSymbol;

    public override SymbolKind Kind => SymbolKind.Parameter;
}

/// <summary>A <c>let</c>-binding name; container is the enclosing behavior/spec symbol.</summary>
public sealed class LocalSymbol : Symbol
{
    public LetBinding Declaration { get; }

    public LocalSymbol(string name, SourceSpan declSpan, LetBinding declaration)
        : base(name, declSpan, declaration.Doc)
    {
        Declaration = declaration;
    }

    public override SymbolKind Kind => SymbolKind.Local;
}

/// <summary>A collection-aggregate lambda parameter; container is the enclosing expression's symbol.</summary>
public sealed class LambdaParameterSymbol : Symbol
{
    public LambdaExpr Declaration { get; }

    public LambdaParameterSymbol(string name, SourceSpan declSpan, LambdaExpr declaration)
        : base(name, declSpan, declaration.Doc)
    {
        Declaration = declaration;
    }

    public override SymbolKind Kind => SymbolKind.LambdaParameter;
}

/// <summary>
/// Identity equality over interned <see cref="Symbol"/>s. Because the <see cref="SymbolTable"/> interns
/// exactly one instance per declaration, reference identity <em>is</em> symbol identity — so this keys
/// the binder's reverse reference index (<c>Symbol → references</c>) without depending on any structural
/// equality the <see cref="Symbol"/> hierarchy never defines. Mirrors Roslyn's <c>SymbolEqualityComparer</c>.
/// TARGET-AGNOSTIC.
/// </summary>
public sealed class SymbolEqualityComparer : IEqualityComparer<Symbol>
{
    /// <summary>The shared identity comparer.</summary>
    public static readonly SymbolEqualityComparer Default = new();

    private SymbolEqualityComparer()
    {
    }

    public bool Equals(Symbol? x, Symbol? y) => ReferenceEquals(x, y);

    public int GetHashCode(Symbol obj) => System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(obj);
}

/// <summary>
/// A singleton sentinel for an unresolved reference, mirroring <see cref="ErrorType.Instance"/>.
/// <see cref="SemanticModel.GetSymbolInfo"/> returns it (never <c>null</c>) so the "never-null,
/// explicit error" discipline matches the type side.
/// </summary>
public sealed class ErrorSymbol : Symbol
{
    public static readonly ErrorSymbol Instance = new();

    private ErrorSymbol() : base(string.Empty, SourceSpan.None, doc: null)
    {
    }

    public override SymbolKind Kind => SymbolKind.Error;
}
