namespace Koine.Compiler.Diagnostics;

/// <summary>
/// The single catalogue of stable diagnostic codes (<c>KOIxxxx</c>). Codes are
/// referenced in docs and tests and never reused; every diagnostic the compiler
/// emits carries one. <see cref="Catalogue"/> maps each code to a one-line
/// description and is asserted (uniqueness + completeness) by a test.
/// </summary>
public static class DiagnosticCodes
{
    // ---- Syntax (KOI0001–0099) --------------------------------------------
    public const string SyntaxError = "KOI0001";

    // ---- Declarations & names (KOI0100–0199) ------------------------------
    public const string UnknownType = "KOI0101";
    public const string DuplicateType = "KOI0102";
    public const string DuplicateMember = "KOI0103";
    public const string DuplicateEnumMember = "KOI0104";
    public const string UnknownAggregateRoot = "KOI0105";
    public const string UnknownEnumMemberForType = "KOI0106";
    public const string GenericArity = "KOI0107";

    // ---- Expressions & references (KOI0200–0299) --------------------------
    public const string UnknownField = "KOI0201";
    public const string UnknownMember = "KOI0202";
    public const string UnknownStringOperation = "KOI0203";
    public const string UnknownCollectionOperation = "KOI0204";
    public const string UnknownOperation = "KOI0205";
    public const string StringOperationOnNonString = "KOI0206";
    public const string CollectionOperationOnNonCollection = "KOI0207";
    public const string OperationArgument = "KOI0208";
    public const string IncompatibleConditionalBranches = "KOI0209";
    public const string IncomparableTypes = "KOI0210";
    public const string RelationalOnNonOrderable = "KOI0211";
    public const string AggregateSelector = "KOI0212";
    public const string AmbiguousEnumMember = "KOI0213";

    // ---- Determinism / value rules (KOI0300–0399) -------------------------
    public const string NowAsStoredDefault = "KOI0301";

    // ---- Optionality (KOI0400–0499) ---------------------------------------
    public const string OptionalAssignedToNonOptional = "KOI0401";
    public const string OptionalDereference = "KOI0402";
    public const string PresenceOnNonOptional = "KOI0403";

    // ---- Commands & transitions (KOI0500–0599) ----------------------------
    public const string InvalidTransitionTarget = "KOI0501";
    public const string TransitionTypeMismatch = "KOI0502";
    public const string DuplicateCommand = "KOI0503";
    public const string DuplicateParameter = "KOI0504";
    public const string CommandNameCollision = "KOI0505";

    // ---- Domain events (KOI0600–0699) -------------------------------------
    public const string UnknownEvent = "KOI0601";
    public const string EmitPayloadMismatch = "KOI0602";
    public const string ReservedEventField = "KOI0603";
    public const string EmitOutsideRoot = "KOI0604";

    // ---- State machines (KOI0700–0799) ------------------------------------
    public const string InvalidStatesBinding = "KOI0701";
    public const string UnknownState = "KOI0702";
    public const string UnreachableTransition = "KOI0703";
    public const string DuplicateStatesBlock = "KOI0704";

    /// <summary>Every code with a one-line description. Tested for uniqueness/coverage.</summary>
    public static readonly IReadOnlyDictionary<string, string> Catalogue = new Dictionary<string, string>
    {
        [SyntaxError] = "Syntax error.",
        [UnknownType] = "Reference to a type that is not declared or built in.",
        [DuplicateType] = "Two emittable types share a name.",
        [DuplicateMember] = "A member name is declared more than once on a type.",
        [DuplicateEnumMember] = "An enum declares the same member twice.",
        [UnknownAggregateRoot] = "An aggregate's root does not name a type declared inside it.",
        [UnknownEnumMemberForType] = "An enum-typed default names a member not in that enum.",
        [GenericArity] = "A collection type has the wrong number of type arguments.",
        [UnknownField] = "An identifier resolves to no member, enum member, or built-in.",
        [UnknownMember] = "A member access names something the receiver type does not have.",
        [UnknownStringOperation] = "An unknown operation was applied to a String.",
        [UnknownCollectionOperation] = "An unknown operation was applied to a collection.",
        [UnknownOperation] = "An unknown call operation was invoked.",
        [StringOperationOnNonString] = "A string operation was applied to a non-string receiver.",
        [CollectionOperationOnNonCollection] = "A collection operation was applied to a non-collection receiver.",
        [OperationArgument] = "An operation received the wrong number or type of arguments.",
        [IncompatibleConditionalBranches] = "The two branches of a conditional have incompatible types.",
        [IncomparableTypes] = "Two operands of a comparison are not comparable.",
        [RelationalOnNonOrderable] = "A relational operator was applied to a non-orderable type.",
        [AggregateSelector] = "A sum/min/max selector has an unsupported result type.",
        [AmbiguousEnumMember] = "A bare enum member belongs to more than one enum; qualify it.",
        [NowAsStoredDefault] = "'now' cannot be used as a stored (constructor) default.",
        [OptionalAssignedToNonOptional] = "An optional value was assigned to a non-optional field.",
        [OptionalDereference] = "An optional value may be null at the point it is used.",
        [PresenceOnNonOptional] = "A presence check was applied to a non-optional value.",
        [InvalidTransitionTarget] = "A state transition targets something that is not a mutable field.",
        [TransitionTypeMismatch] = "A state transition assigns a value of an incompatible type.",
        [DuplicateCommand] = "An entity declares the same command name more than once.",
        [DuplicateParameter] = "A command declares the same parameter name more than once.",
        [CommandNameCollision] = "A command's name collides with a property of the entity.",
        [UnknownEvent] = "An emit references a type that is not a declared event.",
        [EmitPayloadMismatch] = "An emit's payload does not match the event's declared fields.",
        [ReservedEventField] = "An event field collides with the reserved 'OccurredOn' metadata property.",
        [EmitOutsideRoot] = "Events may only be emitted from the aggregate root.",
        [InvalidStatesBinding] = "A states block must bind to an enum-typed field of the entity.",
        [UnknownState] = "A state is not a member of the bound enum.",
        [UnreachableTransition] = "A command transitions to a state no rule can reach.",
        [DuplicateStatesBlock] = "A field has more than one states block.",
    };
}
