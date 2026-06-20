namespace Koine.Compiler.Diagnostics;

/// <summary>
/// The thematic grouping a diagnostic code belongs to. Mirrors the section comments in
/// <see cref="DiagnosticCodes"/> so tooling can present and filter codes by area.
/// </summary>
public enum DiagnosticCategory
{
    Syntax,
    Declarations,
    Expressions,
    Determinism,
    Invariants,
    Optionality,
    Commands,
    Events,
    StateMachines,
    Factories,
    ValueObjects,
    Specs,
    Services,
    Policies,
    Identity,
    Cqrs,
    MultiFile,
    ContextMaps,
    Versioning,
}

/// <summary>
/// Static, target-agnostic metadata for a diagnostic code: its stable <see cref="Id"/>
/// (<c>KOIxxxx</c>), a short <see cref="Title"/>, a <see cref="MessageFormat"/>, the
/// <see cref="Category"/> it belongs to, and the <see cref="DefaultSeverity"/> it is raised with.
/// </summary>
public sealed record DiagnosticDescriptor(
    string Id,
    string Title,
    string MessageFormat,
    DiagnosticCategory Category,
    DiagnosticSeverity DefaultSeverity);

/// <summary>
/// The single catalogue of stable diagnostic codes (<c>KOIxxxx</c>). Codes are
/// referenced in docs and tests and never reused; every diagnostic the compiler
/// emits carries one. <see cref="Catalogue"/> maps each code to a
/// <see cref="DiagnosticDescriptor"/> and is asserted (uniqueness + completeness) by a test.
/// </summary>
public static class DiagnosticCodes
{
    // ---- Syntax (KOI0001–0099) --------------------------------------------
    public const string SyntaxError = "KOI0001";
    public const string ReservedWordInDeclarationName = "KOI0002";

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
    public const string DuplicateLetBinding = "KOI0214";

    // ---- Determinism / value rules (KOI0300–0399) -------------------------
    public const string NowAsStoredDefault = "KOI0301";

    // ---- Invariant satisfiability (KOI0310–0319) --------------------------
    public const string ContradictoryInvariant = "KOI0310";
    public const string InvertedBound = "KOI0311";
    public const string BoundOutsideConstraint = "KOI0312";
    public const string UnsatisfiableInvariantPair = "KOI0313";

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
    public const string ResultWithoutReturnType = "KOI0506";
    public const string MissingCommandResult = "KOI0507";
    public const string CommandResultMismatch = "KOI0508";

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
    public const string ReservedEnumMember = "KOI0910";
    public const string EnumMemberCamelCaseCollision = "KOI0911";

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

    // ---- Context maps, shared kernel, ACL, integration events (KOI1400–1499) ----
    public const string ContextMapUnknownContext = "KOI1401";
    public const string DuplicateContextRelation = "KOI1402";
    public const string SelfRelation = "KOI1403";
    public const string AclDirectUpstreamReference = "KOI1404";
    public const string SharedTypesOnNonKernel = "KOI1405";
    public const string UnknownSharedKernelType = "KOI1406";
    public const string AclOnNonAclRole = "KOI1407";
    public const string AclMappingType = "KOI1408";
    public const string IntegrationEventLeaksInternals = "KOI1409";
    public const string UnknownPublishedEvent = "KOI1410";
    public const string DuplicatePublish = "KOI1411";
    public const string SubscribeUnknownContext = "KOI1412";
    public const string SubscribeNotPublished = "KOI1413";
    public const string SubscribeNoRelation = "KOI1414";
    public const string DuplicateSubscribe = "KOI1415";
    public const string SharedKernelTypeConflict = "KOI1416";
    public const string SubscribeHandlerNameCollision = "KOI1417";
    public const string SharedKernelNotShareable = "KOI1418";

    // ---- Model versioning & evolution (KOI1500–1599) ----------------------
    public const string AnnotationVersionAboveContext = "KOI1501";
    public const string PublishedTypeRemoved = "KOI1510";
    public const string PublishedFieldRemoved = "KOI1511";
    public const string PublishedFieldTypeChanged = "KOI1512";
    public const string PublishedFieldNowRequired = "KOI1513";
    public const string PublishedRequiredFieldAdded = "KOI1514";
    public const string PublishedMemberRenamed = "KOI1515";
    public const string PublishedEnumMemberRemoved = "KOI1516";
    public const string PublishedEventShapeChanged = "KOI1517";

    // Helper: build a descriptor that carries the existing one-line description into both Title and
    // MessageFormat, so no information is lost while the richer shape is adopted incrementally.
    private static DiagnosticDescriptor D(
        string id, string description, DiagnosticCategory category, DiagnosticSeverity severity) =>
        new(id, description, description, category, severity);

    /// <summary>
    /// Every code with its descriptor (Id, Title, MessageFormat, Category, DefaultSeverity).
    /// Tested for uniqueness/coverage and for the severity each code is actually raised with.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, DiagnosticDescriptor> Catalogue =
        new Dictionary<string, DiagnosticDescriptor>
    {
        // ---- Syntax -------------------------------------------------------
        [SyntaxError] = D(SyntaxError, "Syntax error.", DiagnosticCategory.Syntax, DiagnosticSeverity.Error),
        [ReservedWordInDeclarationName] = D(ReservedWordInDeclarationName, "A Koine keyword was used where a plain identifier (a declaration name) is required.", DiagnosticCategory.Syntax, DiagnosticSeverity.Error),

        // ---- Declarations & names ----------------------------------------
        [UnknownType] = D(UnknownType, "Reference to a type that is not declared or built in.", DiagnosticCategory.Declarations, DiagnosticSeverity.Error),
        [DuplicateType] = D(DuplicateType, "Two emittable types share a name.", DiagnosticCategory.Declarations, DiagnosticSeverity.Error),
        [DuplicateMember] = D(DuplicateMember, "A member name is declared more than once on a type.", DiagnosticCategory.Declarations, DiagnosticSeverity.Error),
        [DuplicateEnumMember] = D(DuplicateEnumMember, "An enum declares the same member twice.", DiagnosticCategory.Declarations, DiagnosticSeverity.Error),
        [UnknownAggregateRoot] = D(UnknownAggregateRoot, "An aggregate's root does not name a type declared inside it.", DiagnosticCategory.Declarations, DiagnosticSeverity.Error),
        [UnknownEnumMemberForType] = D(UnknownEnumMemberForType, "An enum-typed default names a member not in that enum.", DiagnosticCategory.Declarations, DiagnosticSeverity.Error),
        [GenericArity] = D(GenericArity, "A collection type has the wrong number of type arguments.", DiagnosticCategory.Declarations, DiagnosticSeverity.Error),
        [ReservedGeneratedMember] = D(ReservedGeneratedMember, "A value-object/entity member collides with a generated member (Id, Equals, GetHashCode, GetEqualityComponents).", DiagnosticCategory.Declarations, DiagnosticSeverity.Error),

        // ---- Expressions & references ------------------------------------
        [UnknownField] = D(UnknownField, "An identifier resolves to no member, enum member, or built-in.", DiagnosticCategory.Expressions, DiagnosticSeverity.Error),
        [UnknownMember] = D(UnknownMember, "A member access names something the receiver type does not have.", DiagnosticCategory.Expressions, DiagnosticSeverity.Error),
        [UnknownStringOperation] = D(UnknownStringOperation, "An unknown operation was applied to a String.", DiagnosticCategory.Expressions, DiagnosticSeverity.Error),
        [UnknownCollectionOperation] = D(UnknownCollectionOperation, "An unknown operation was applied to a collection.", DiagnosticCategory.Expressions, DiagnosticSeverity.Error),
        [UnknownOperation] = D(UnknownOperation, "An unknown call operation was invoked.", DiagnosticCategory.Expressions, DiagnosticSeverity.Error),
        [StringOperationOnNonString] = D(StringOperationOnNonString, "A string operation was applied to a non-string receiver.", DiagnosticCategory.Expressions, DiagnosticSeverity.Error),
        [CollectionOperationOnNonCollection] = D(CollectionOperationOnNonCollection, "A collection operation was applied to a non-collection receiver.", DiagnosticCategory.Expressions, DiagnosticSeverity.Error),
        [OperationArgument] = D(OperationArgument, "An operation received the wrong number or type of arguments.", DiagnosticCategory.Expressions, DiagnosticSeverity.Error),
        [IncompatibleConditionalBranches] = D(IncompatibleConditionalBranches, "The two branches of a conditional have incompatible types.", DiagnosticCategory.Expressions, DiagnosticSeverity.Error),
        [IncomparableTypes] = D(IncomparableTypes, "Two operands of a comparison are not comparable.", DiagnosticCategory.Expressions, DiagnosticSeverity.Error),
        [RelationalOnNonOrderable] = D(RelationalOnNonOrderable, "A relational operator was applied to a non-orderable type.", DiagnosticCategory.Expressions, DiagnosticSeverity.Error),
        [AggregateSelector] = D(AggregateSelector, "A sum/min/max selector has an unsupported result type.", DiagnosticCategory.Expressions, DiagnosticSeverity.Error),
        [AmbiguousEnumMember] = D(AmbiguousEnumMember, "A bare enum member belongs to more than one enum; qualify it.", DiagnosticCategory.Expressions, DiagnosticSeverity.Error),
        [DuplicateLetBinding] = D(DuplicateLetBinding, "A let binding name is declared more than once in the same let.", DiagnosticCategory.Expressions, DiagnosticSeverity.Error),

        // ---- Determinism / value rules -----------------------------------
        [NowAsStoredDefault] = D(NowAsStoredDefault, "'now' cannot be used as a stored (constructor) default.", DiagnosticCategory.Determinism, DiagnosticSeverity.Error),

        // ---- Invariant satisfiability ------------------------------------
        [ContradictoryInvariant] = D(ContradictoryInvariant, "An invariant condition is a constant that can never hold (always false).", DiagnosticCategory.Invariants, DiagnosticSeverity.Warning),
        [InvertedBound] = D(InvertedBound, "A field's inclusive bounds are inverted: the lower bound exceeds the upper bound.", DiagnosticCategory.Invariants, DiagnosticSeverity.Warning),
        [BoundOutsideConstraint] = D(BoundOutsideConstraint, "A field's constant default lies outside the range its invariants require.", DiagnosticCategory.Invariants, DiagnosticSeverity.Warning),
        [UnsatisfiableInvariantPair] = D(UnsatisfiableInvariantPair, "Two bounds on the same field cannot both hold; their intersection is empty.", DiagnosticCategory.Invariants, DiagnosticSeverity.Warning),

        // ---- Optionality -------------------------------------------------
        [OptionalAssignedToNonOptional] = D(OptionalAssignedToNonOptional, "An optional value was assigned to a non-optional field.", DiagnosticCategory.Optionality, DiagnosticSeverity.Error),
        [OptionalDereference] = D(OptionalDereference, "An optional value may be null at the point it is used.", DiagnosticCategory.Optionality, DiagnosticSeverity.Error),
        [PresenceOnNonOptional] = D(PresenceOnNonOptional, "A presence check was applied to a non-optional value.", DiagnosticCategory.Optionality, DiagnosticSeverity.Error),

        // ---- Commands & transitions --------------------------------------
        [InvalidTransitionTarget] = D(InvalidTransitionTarget, "A state transition targets something that is not a mutable field.", DiagnosticCategory.Commands, DiagnosticSeverity.Error),
        [TransitionTypeMismatch] = D(TransitionTypeMismatch, "A state transition assigns a value of an incompatible type.", DiagnosticCategory.Commands, DiagnosticSeverity.Error),
        [DuplicateCommand] = D(DuplicateCommand, "An entity declares the same command name more than once.", DiagnosticCategory.Commands, DiagnosticSeverity.Error),
        [DuplicateParameter] = D(DuplicateParameter, "A command declares the same parameter name more than once.", DiagnosticCategory.Commands, DiagnosticSeverity.Error),
        [CommandNameCollision] = D(CommandNameCollision, "A command's name collides with a property of the entity.", DiagnosticCategory.Commands, DiagnosticSeverity.Error),
        [ResultWithoutReturnType] = D(ResultWithoutReturnType, "A command has a 'result' clause but declares no return type.", DiagnosticCategory.Commands, DiagnosticSeverity.Error),
        [MissingCommandResult] = D(MissingCommandResult, "A command that declares a return type must have exactly one 'result' clause.", DiagnosticCategory.Commands, DiagnosticSeverity.Error),
        [CommandResultMismatch] = D(CommandResultMismatch, "A command's 'result' expression is not assignable to its declared return type.", DiagnosticCategory.Commands, DiagnosticSeverity.Error),

        // ---- Domain events -----------------------------------------------
        [UnknownEvent] = D(UnknownEvent, "An emit references a type that is not a declared event.", DiagnosticCategory.Events, DiagnosticSeverity.Error),
        [EmitPayloadMismatch] = D(EmitPayloadMismatch, "An emit's payload does not match the event's declared fields.", DiagnosticCategory.Events, DiagnosticSeverity.Error),
        [ReservedEventField] = D(ReservedEventField, "An event field collides with the reserved 'OccurredOn' metadata property.", DiagnosticCategory.Events, DiagnosticSeverity.Error),
        [EmitOutsideRoot] = D(EmitOutsideRoot, "Events may only be emitted from the aggregate root.", DiagnosticCategory.Events, DiagnosticSeverity.Error),

        // ---- State machines ----------------------------------------------
        [InvalidStatesBinding] = D(InvalidStatesBinding, "A states block must bind to an enum-typed field of the entity.", DiagnosticCategory.StateMachines, DiagnosticSeverity.Error),
        [UnknownState] = D(UnknownState, "A state is not a member of the bound enum.", DiagnosticCategory.StateMachines, DiagnosticSeverity.Error),
        [UnreachableTransition] = D(UnreachableTransition, "A command transitions to a state no rule can reach.", DiagnosticCategory.StateMachines, DiagnosticSeverity.Error),
        [DuplicateStatesBlock] = D(DuplicateStatesBlock, "A field has more than one states block.", DiagnosticCategory.StateMachines, DiagnosticSeverity.Error),

        // ---- Factories ---------------------------------------------------
        [DuplicateFactory] = D(DuplicateFactory, "An entity declares the same factory name more than once.", DiagnosticCategory.Factories, DiagnosticSeverity.Error),
        [FactoryNameCollision] = D(FactoryNameCollision, "A factory's name collides with a property or command of the entity.", DiagnosticCategory.Factories, DiagnosticSeverity.Error),
        [InvalidInitializationTarget] = D(InvalidInitializationTarget, "A factory initialization targets something that is not a settable field.", DiagnosticCategory.Factories, DiagnosticSeverity.Error),
        [InitializationTypeMismatch] = D(InitializationTypeMismatch, "A factory initialization assigns a value of an incompatible type.", DiagnosticCategory.Factories, DiagnosticSeverity.Error),
        [DuplicateInitialization] = D(DuplicateInitialization, "A factory initializes the same field more than once.", DiagnosticCategory.Factories, DiagnosticSeverity.Error),
        [UninitializedFactoryField] = D(UninitializedFactoryField, "A factory leaves a required field uninitialized with no default.", DiagnosticCategory.Factories, DiagnosticSeverity.Warning),
        [ReservedFactoryParameter] = D(ReservedFactoryParameter, "A factory parameter uses the reserved name 'id' (the auto-generated identity).", DiagnosticCategory.Factories, DiagnosticSeverity.Error),

        // ---- Richer value objects ----------------------------------------
        [EnumMemberArity] = D(EnumMemberArity, "An enum member's associated-value count does not match the enum's signature.", DiagnosticCategory.ValueObjects, DiagnosticSeverity.Error),
        [EnumMemberArgType] = D(EnumMemberArgType, "An enum associated value is non-literal or has a type incompatible with its field.", DiagnosticCategory.ValueObjects, DiagnosticSeverity.Error),
        [EnumReservedAssociatedField] = D(EnumReservedAssociatedField, "An associated-data field name collides with a generated smart-enum member.", DiagnosticCategory.ValueObjects, DiagnosticSeverity.Error),
        [QuantityUnitCardinality] = D(QuantityUnitCardinality, "A quantity must declare exactly one enum-typed unit member.", DiagnosticCategory.ValueObjects, DiagnosticSeverity.Error),
        [QuantityAmountCardinality] = D(QuantityAmountCardinality, "A quantity must declare exactly one numeric amount member.", DiagnosticCategory.ValueObjects, DiagnosticSeverity.Error),
        [QuantityMemberNotAllowed] = D(QuantityMemberNotAllowed, "A quantity may declare only its amount and unit members.", DiagnosticCategory.ValueObjects, DiagnosticSeverity.Error),
        [RangeNotOrderable] = D(RangeNotOrderable, "A Range's element type is not orderable (requires Int, Decimal, or Instant).", DiagnosticCategory.ValueObjects, DiagnosticSeverity.Error),
        [ReservedTypeName] = D(ReservedTypeName, "A type uses a name reserved for a built-in generic (List/Set/Map/Range).", DiagnosticCategory.ValueObjects, DiagnosticSeverity.Error),
        [EnumAssociatedFieldType] = D(EnumAssociatedFieldType, "An enum associated-data field must be String, Int, Decimal, or Bool.", DiagnosticCategory.ValueObjects, DiagnosticSeverity.Error),
        [ReservedEnumMember] = D(ReservedEnumMember, "An enum member name collides with a generated smart-enum member (Name/Value/All/FromName/FromValue/TryFromName/TryFromValue/Match/Switch/ToString/Equals/GetHashCode).", DiagnosticCategory.ValueObjects, DiagnosticSeverity.Error),
        [EnumMemberCamelCaseCollision] = D(EnumMemberCamelCaseCollision, "Two enum members differ only by leading-character case and would collapse to one Match/Switch parameter.", DiagnosticCategory.ValueObjects, DiagnosticSeverity.Error),

        // ---- Specifications ----------------------------------------------
        [SpecUnknownTarget] = D(SpecUnknownTarget, "A spec's target is not a declared value or entity type.", DiagnosticCategory.Specs, DiagnosticSeverity.Error),
        [SpecTargetMismatch] = D(SpecTargetMismatch, "A spec is referenced on a type that is not its declared target.", DiagnosticCategory.Specs, DiagnosticSeverity.Error),
        [SpecCycle] = D(SpecCycle, "Specs form a reference cycle (or a spec references itself).", DiagnosticCategory.Specs, DiagnosticSeverity.Error),
        [SpecNotBoolean] = D(SpecNotBoolean, "A spec's condition is not a boolean expression.", DiagnosticCategory.Specs, DiagnosticSeverity.Error),
        [DuplicateSpec] = D(DuplicateSpec, "A spec name duplicates another spec or a member of its target type.", DiagnosticCategory.Specs, DiagnosticSeverity.Error),

        // ---- Domain services ---------------------------------------------
        [ServiceReturnMismatch] = D(ServiceReturnMismatch, "An operation's body type is not assignable to its declared return type.", DiagnosticCategory.Services, DiagnosticSeverity.Error),
        [DuplicateOperation] = D(DuplicateOperation, "A service declares the same operation name more than once.", DiagnosticCategory.Services, DiagnosticSeverity.Error),
        [DuplicateService] = D(DuplicateService, "A context declares the same service name more than once.", DiagnosticCategory.Services, DiagnosticSeverity.Error),

        // ---- Policies ----------------------------------------------------
        [PolicyUnknownEvent] = D(PolicyUnknownEvent, "A policy's 'when' clause names a type that is not a declared event.", DiagnosticCategory.Policies, DiagnosticSeverity.Error),
        [PolicyUnknownTarget] = D(PolicyUnknownTarget, "A policy's 'then' clause targets an aggregate/entity that is not declared.", DiagnosticCategory.Policies, DiagnosticSeverity.Error),
        [PolicyUnknownCommand] = D(PolicyUnknownCommand, "A policy's 'then' clause names a command the target's root does not declare.", DiagnosticCategory.Policies, DiagnosticSeverity.Error),
        [PolicyArgMismatch] = D(PolicyArgMismatch, "Policy reaction arguments do not match the target command's parameters.", DiagnosticCategory.Policies, DiagnosticSeverity.Error),
        [PolicyArgType] = D(PolicyArgType, "A policy reaction argument's value type is incompatible with the command parameter.", DiagnosticCategory.Policies, DiagnosticSeverity.Error),
        [DuplicatePolicy] = D(DuplicatePolicy, "Two policies in the same context share a name.", DiagnosticCategory.Policies, DiagnosticSeverity.Error),

        // ---- Identity, repositories, concurrency -------------------------
        [NaturalIdBackingType] = D(NaturalIdBackingType, "A natural identity's backing type must be String or Int.", DiagnosticCategory.Identity, DiagnosticSeverity.Error),
        [UnknownRepositoryOperation] = D(UnknownRepositoryOperation, "A repository 'operations' clause names an unknown operation keyword.", DiagnosticCategory.Identity, DiagnosticSeverity.Error),
        [FinderResultType] = D(FinderResultType, "A repository finder's result type must be the aggregate root or a list of it.", DiagnosticCategory.Identity, DiagnosticSeverity.Error),
        [DuplicateFinder] = D(DuplicateFinder, "A repository declares the same finder name more than once.", DiagnosticCategory.Identity, DiagnosticSeverity.Error),
        [ReservedVersionMember] = D(ReservedVersionMember, "A versioned aggregate's root declares a member that collides with the generated 'Version' token.", DiagnosticCategory.Identity, DiagnosticSeverity.Error),
        [FinderNameCollision] = D(FinderNameCollision, "A repository finder's name collides with a built-in operation method (getById/add/update/remove).", DiagnosticCategory.Identity, DiagnosticSeverity.Error),
        [ReservedFinderParameter] = D(ReservedFinderParameter, "A repository finder parameter uses the reserved name 'ct' (the generated CancellationToken).", DiagnosticCategory.Identity, DiagnosticSeverity.Error),

        // ---- Application services, read models, CQRS ---------------------
        [DuplicateUseCase] = D(DuplicateUseCase, "A service declares the same use-case name more than once.", DiagnosticCategory.Cqrs, DiagnosticSeverity.Error),
        [ReadModelUnknownSource] = D(ReadModelUnknownSource, "A read model's source is not a declared value or entity type.", DiagnosticCategory.Cqrs, DiagnosticSeverity.Error),
        [ReadModelUnknownField] = D(ReadModelUnknownField, "A read-model field names a member the source type does not have.", DiagnosticCategory.Cqrs, DiagnosticSeverity.Error),
        [ReadModelFieldTypeMismatch] = D(ReadModelFieldTypeMismatch, "A read-model projection's value type is incompatible with its declared field type.", DiagnosticCategory.Cqrs, DiagnosticSeverity.Error),
        [DuplicateReadModelField] = D(DuplicateReadModelField, "A read model declares the same field name more than once.", DiagnosticCategory.Cqrs, DiagnosticSeverity.Error),
        [QueryResultNotReadModel] = D(QueryResultNotReadModel, "A query's result type is not a declared read model (or a list of one).", DiagnosticCategory.Cqrs, DiagnosticSeverity.Error),
        [ReservedRecordMember] = D(ReservedRecordMember, "A read-model field, query criterion, or event field collides with a record-synthesized member (Equals/GetHashCode/…).", DiagnosticCategory.Cqrs, DiagnosticSeverity.Error),

        // ---- Multi-file, imports, modules --------------------------------
        [UnknownContext] = D(UnknownContext, "An import or qualified reference names a context that is not declared.", DiagnosticCategory.MultiFile, DiagnosticSeverity.Error),
        [NotExported] = D(NotExported, "An import or qualified reference names a type the target context does not declare.", DiagnosticCategory.MultiFile, DiagnosticSeverity.Error),
        [UnimportedReference] = D(UnimportedReference, "A type owned by another context is referenced without importing or qualifying it.", DiagnosticCategory.MultiFile, DiagnosticSeverity.Error),
        [AmbiguousReference] = D(AmbiguousReference, "An unqualified name is declared in more than one available context; qualify it.", DiagnosticCategory.MultiFile, DiagnosticSeverity.Error),
        [ModuleNameCollision] = D(ModuleNameCollision, "A module shares its name with a type in the same context.", DiagnosticCategory.MultiFile, DiagnosticSeverity.Error),

        // ---- Context maps, shared kernel, ACL, integration events --------
        [ContextMapUnknownContext] = D(ContextMapUnknownContext, "A context-map relation names a context that is not declared.", DiagnosticCategory.ContextMaps, DiagnosticSeverity.Error),
        [DuplicateContextRelation] = D(DuplicateContextRelation, "Two relations are declared for the same pair of contexts.", DiagnosticCategory.ContextMaps, DiagnosticSeverity.Error),
        [SelfRelation] = D(SelfRelation, "A context-map relation relates a context to itself.", DiagnosticCategory.ContextMaps, DiagnosticSeverity.Error),
        [AclDirectUpstreamReference] = D(AclDirectUpstreamReference, "An anti-corruption-layer downstream references an upstream type directly instead of via a translated local type.", DiagnosticCategory.ContextMaps, DiagnosticSeverity.Warning),
        [SharedTypesOnNonKernel] = D(SharedTypesOnNonKernel, "A 'shared-kernel { }' block appears on a relation whose role is not shared-kernel.", DiagnosticCategory.ContextMaps, DiagnosticSeverity.Error),
        [UnknownSharedKernelType] = D(UnknownSharedKernelType, "A shared-kernel type is declared by neither partner context of the relation.", DiagnosticCategory.ContextMaps, DiagnosticSeverity.Error),
        [AclOnNonAclRole] = D(AclOnNonAclRole, "An 'acl { }' block appears on a relation whose role is not anti-corruption-layer.", DiagnosticCategory.ContextMaps, DiagnosticSeverity.Error),
        [AclMappingType] = D(AclMappingType, "An ACL mapping references a context/type that does not match the relation's partners or does not exist.", DiagnosticCategory.ContextMaps, DiagnosticSeverity.Error),
        [IntegrationEventLeaksInternals] = D(IntegrationEventLeaksInternals, "An integration-event field type references an internal type (entity, value, aggregate, domain event, read model, query).", DiagnosticCategory.ContextMaps, DiagnosticSeverity.Error),
        [UnknownPublishedEvent] = D(UnknownPublishedEvent, "A 'publishes' declaration names something that is not a locally declared integration event.", DiagnosticCategory.ContextMaps, DiagnosticSeverity.Error),
        [DuplicatePublish] = D(DuplicatePublish, "A context publishes the same integration event more than once.", DiagnosticCategory.ContextMaps, DiagnosticSeverity.Error),
        [SubscribeUnknownContext] = D(SubscribeUnknownContext, "A 'subscribes' declaration names a context that is not declared.", DiagnosticCategory.ContextMaps, DiagnosticSeverity.Error),
        [SubscribeNotPublished] = D(SubscribeNotPublished, "A 'subscribes' declaration names an event the target context does not publish.", DiagnosticCategory.ContextMaps, DiagnosticSeverity.Error),
        [SubscribeNoRelation] = D(SubscribeNoRelation, "A subscribe is not authorized by any open-host, published-language, or customer-supplier relation.", DiagnosticCategory.ContextMaps, DiagnosticSeverity.Error),
        [DuplicateSubscribe] = D(DuplicateSubscribe, "A context subscribes to the same event more than once.", DiagnosticCategory.ContextMaps, DiagnosticSeverity.Error),
        [SharedKernelTypeConflict] = D(SharedKernelTypeConflict, "A type is declared as shared by more than one shared-kernel relation.", DiagnosticCategory.ContextMaps, DiagnosticSeverity.Error),
        [SubscribeHandlerNameCollision] = D(SubscribeHandlerNameCollision, "A context subscribes to two integration events with the same name from different publishers.", DiagnosticCategory.ContextMaps, DiagnosticSeverity.Error),
        [SharedKernelNotShareable] = D(SharedKernelNotShareable, "A shared-kernel type is an entity or aggregate; only value objects and enums may be shared.", DiagnosticCategory.ContextMaps, DiagnosticSeverity.Error),

        // ---- Model versioning & evolution --------------------------------
        [AnnotationVersionAboveContext] = D(AnnotationVersionAboveContext, "A @since annotation names a version higher than the context's declared version.", DiagnosticCategory.Versioning, DiagnosticSeverity.Warning),
        [PublishedTypeRemoved] = D(PublishedTypeRemoved, "A published type (integration event, shared-kernel, or open-host) present in the baseline was removed.", DiagnosticCategory.Versioning, DiagnosticSeverity.Error),
        [PublishedFieldRemoved] = D(PublishedFieldRemoved, "A field of a published type present in the baseline was removed.", DiagnosticCategory.Versioning, DiagnosticSeverity.Error),
        [PublishedFieldTypeChanged] = D(PublishedFieldTypeChanged, "A published field's type changed incompatibly from the baseline.", DiagnosticCategory.Versioning, DiagnosticSeverity.Error),
        [PublishedFieldNowRequired] = D(PublishedFieldNowRequired, "A published field that was optional in the baseline is now required.", DiagnosticCategory.Versioning, DiagnosticSeverity.Error),
        [PublishedRequiredFieldAdded] = D(PublishedRequiredFieldAdded, "A required field was added to a published type that exists in the baseline.", DiagnosticCategory.Versioning, DiagnosticSeverity.Error),
        [PublishedMemberRenamed] = D(PublishedMemberRenamed, "A published field was renamed (a same-shape field removed and re-added under a new name).", DiagnosticCategory.Versioning, DiagnosticSeverity.Error),
        [PublishedEnumMemberRemoved] = D(PublishedEnumMemberRemoved, "A value was removed from a published enum.", DiagnosticCategory.Versioning, DiagnosticSeverity.Error),
        [PublishedEventShapeChanged] = D(PublishedEventShapeChanged, "A published integration event's payload shape changed (a field added, removed, or retyped).", DiagnosticCategory.Versioning, DiagnosticSeverity.Error),
    };
}
