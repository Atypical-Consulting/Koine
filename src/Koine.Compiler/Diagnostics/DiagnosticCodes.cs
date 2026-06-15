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
    public const string ReservedGeneratedMember = "KOI0108";

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

    // ---- Factories (KOI0800–0899) -----------------------------------------
    public const string DuplicateFactory = "KOI0801";
    public const string FactoryNameCollision = "KOI0802";
    public const string InvalidInitializationTarget = "KOI0803";
    public const string InitializationTypeMismatch = "KOI0804";
    public const string DuplicateInitialization = "KOI0805";
    public const string UninitializedFactoryField = "KOI0806";
    public const string ReservedFactoryParameter = "KOI0807";

    // ---- Richer value objects (KOI0900–0999) ------------------------------
    public const string EnumMemberArity = "KOI0901";
    public const string EnumMemberArgType = "KOI0902";
    public const string EnumReservedAssociatedField = "KOI0903";
    public const string QuantityUnitCardinality = "KOI0904";
    public const string QuantityAmountCardinality = "KOI0905";
    public const string QuantityMemberNotAllowed = "KOI0906";
    public const string RangeNotOrderable = "KOI0907";
    public const string ReservedTypeName = "KOI0908";
    public const string EnumAssociatedFieldType = "KOI0909";

    // ---- Specifications (KOI1000–1009) ------------------------------------
    public const string SpecUnknownTarget = "KOI1001";
    public const string SpecTargetMismatch = "KOI1002";
    public const string SpecCycle = "KOI1003";
    public const string SpecNotBoolean = "KOI1004";
    public const string DuplicateSpec = "KOI1005";

    // ---- Domain services (KOI1020–1029) -----------------------------------
    public const string ServiceReturnMismatch = "KOI1020";
    public const string DuplicateOperation = "KOI1021";
    public const string DuplicateService = "KOI1022";

    // ---- Policies (KOI1030–1039) ------------------------------------------
    public const string PolicyUnknownEvent = "KOI1030";
    public const string PolicyUnknownTarget = "KOI1031";
    public const string PolicyUnknownCommand = "KOI1032";
    public const string PolicyArgMismatch = "KOI1033";
    public const string PolicyArgType = "KOI1034";
    public const string DuplicatePolicy = "KOI1035";

    // ---- Identity, repositories, concurrency (KOI1100–1199) ---------------
    public const string NaturalIdBackingType = "KOI1101";
    public const string UnknownRepositoryOperation = "KOI1102";
    public const string FinderResultType = "KOI1103";
    public const string DuplicateFinder = "KOI1104";
    public const string ReservedVersionMember = "KOI1105";
    public const string FinderNameCollision = "KOI1106";
    public const string ReservedFinderParameter = "KOI1107";

    // ---- Application services, read models, CQRS (KOI1200–1299) -----------
    public const string DuplicateUseCase = "KOI1201";
    public const string ReadModelUnknownSource = "KOI1202";
    public const string ReadModelUnknownField = "KOI1203";
    public const string ReadModelFieldTypeMismatch = "KOI1204";
    public const string DuplicateReadModelField = "KOI1205";
    public const string QueryResultNotReadModel = "KOI1206";
    public const string ReservedRecordMember = "KOI1207";

    // ---- Multi-file, imports, modules (KOI1300–1399) ----------------------
    public const string UnknownContext = "KOI1301";
    public const string NotExported = "KOI1302";
    public const string UnimportedReference = "KOI1303";
    public const string AmbiguousReference = "KOI1304";
    public const string ModuleNameCollision = "KOI1305";

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
        [ReservedGeneratedMember] = "A value-object/entity member collides with a generated member (Id, Equals, GetHashCode, GetEqualityComponents).",
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
        [DuplicateFactory] = "An entity declares the same factory name more than once.",
        [FactoryNameCollision] = "A factory's name collides with a property or command of the entity.",
        [InvalidInitializationTarget] = "A factory initialization targets something that is not a settable field.",
        [InitializationTypeMismatch] = "A factory initialization assigns a value of an incompatible type.",
        [DuplicateInitialization] = "A factory initializes the same field more than once.",
        [UninitializedFactoryField] = "A factory leaves a required field uninitialized with no default.",
        [ReservedFactoryParameter] = "A factory parameter uses the reserved name 'id' (the auto-generated identity).",
        [EnumMemberArity] = "An enum member's associated-value count does not match the enum's signature.",
        [EnumMemberArgType] = "An enum associated value is non-literal or has a type incompatible with its field.",
        [EnumReservedAssociatedField] = "An associated-data field name collides with a generated smart-enum member.",
        [QuantityUnitCardinality] = "A quantity must declare exactly one enum-typed unit member.",
        [QuantityAmountCardinality] = "A quantity must declare exactly one numeric amount member.",
        [QuantityMemberNotAllowed] = "A quantity may declare only its amount and unit members.",
        [RangeNotOrderable] = "A Range's element type is not orderable (requires Int, Decimal, or Instant).",
        [ReservedTypeName] = "A type uses a name reserved for a built-in generic (List/Set/Map/Range).",
        [EnumAssociatedFieldType] = "An enum associated-data field must be String, Int, Decimal, or Bool.",
        [SpecUnknownTarget] = "A spec's target is not a declared value or entity type.",
        [SpecTargetMismatch] = "A spec is referenced on a type that is not its declared target.",
        [SpecCycle] = "Specs form a reference cycle (or a spec references itself).",
        [SpecNotBoolean] = "A spec's condition is not a boolean expression.",
        [DuplicateSpec] = "A spec name duplicates another spec or a member of its target type.",
        [ServiceReturnMismatch] = "An operation's body type is not assignable to its declared return type.",
        [DuplicateOperation] = "A service declares the same operation name more than once.",
        [DuplicateService] = "A context declares the same service name more than once.",
        [PolicyUnknownEvent] = "A policy's 'when' clause names a type that is not a declared event.",
        [PolicyUnknownTarget] = "A policy's 'then' clause targets an aggregate/entity that is not declared.",
        [PolicyUnknownCommand] = "A policy's 'then' clause names a command the target's root does not declare.",
        [PolicyArgMismatch] = "Policy reaction arguments do not match the target command's parameters.",
        [PolicyArgType] = "A policy reaction argument's value type is incompatible with the command parameter.",
        [DuplicatePolicy] = "Two policies in the same context share a name.",
        [NaturalIdBackingType] = "A natural identity's backing type must be String or Int.",
        [UnknownRepositoryOperation] = "A repository 'operations' clause names an unknown operation keyword.",
        [FinderResultType] = "A repository finder's result type must be the aggregate root or a list of it.",
        [DuplicateFinder] = "A repository declares the same finder name more than once.",
        [ReservedVersionMember] = "A versioned aggregate's root declares a member that collides with the generated 'Version' token.",
        [FinderNameCollision] = "A repository finder's name collides with a built-in operation method (getById/add/update/remove).",
        [ReservedFinderParameter] = "A repository finder parameter uses the reserved name 'ct' (the generated CancellationToken).",
        [DuplicateUseCase] = "A service declares the same use-case name more than once.",
        [ReadModelUnknownSource] = "A read model's source is not a declared value or entity type.",
        [ReadModelUnknownField] = "A read-model field names a member the source type does not have.",
        [ReadModelFieldTypeMismatch] = "A read-model projection's value type is incompatible with its declared field type.",
        [DuplicateReadModelField] = "A read model declares the same field name more than once.",
        [QueryResultNotReadModel] = "A query's result type is not a declared read model (or a list of one).",
        [ReservedRecordMember] = "A read-model field, query criterion, or event field collides with a record-synthesized member (Equals/GetHashCode/…).",
        [UnknownContext] = "An import or qualified reference names a context that is not declared.",
        [NotExported] = "An import or qualified reference names a type the target context does not declare.",
        [UnimportedReference] = "A type owned by another context is referenced without importing or qualifying it.",
        [AmbiguousReference] = "An unqualified name is declared in more than one available context; qualify it.",
        [ModuleNameCollision] = "A module shares its name with a type in the same context.",
    };
}
