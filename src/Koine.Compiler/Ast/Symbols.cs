namespace Koine.Compiler.Ast;

/// <summary>The category of a resolved <see cref="Symbol"/>.</summary>
public enum SymbolKind
{
    Type,
    Member,
    EnumMember,
    Spec,
    IdValueObject
}

/// <summary>
/// A resolved declaration that a name refers to — the navigation/hover target for editor tooling.
/// Carries the declaration's <see cref="DeclSpan"/> (for go-to-definition) and its doc comment.
/// Produced by <see cref="SemanticModel.GetSymbol"/>, the single resolution path the LSP services
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
/// </summary>
public sealed class IdValueObjectSymbol : Symbol
{
    public EntityDecl Owner { get; }

    public IdValueObjectSymbol(string name, SourceSpan declSpan, EntityDecl owner)
        : base(name, declSpan, owner.Doc)
    {
        Owner = owner;
    }

    public override SymbolKind Kind => SymbolKind.IdValueObject;
}
