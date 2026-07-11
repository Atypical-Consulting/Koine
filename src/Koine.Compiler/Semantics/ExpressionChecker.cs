using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;

namespace Koine.Compiler.Semantics;

/// <summary>
/// Scope- and type-aware validation of a single expression. Reports unknown
/// identifiers (honouring lambda-bound parameters), unknown/misapplied built-in
/// operations, conditional branch type mismatches, and Instant comparison
/// mismatches. Type knowledge is best-effort: when a sub-expression's type can't
/// be inferred, no type diagnostic is raised (avoiding false positives).
/// </summary>
internal sealed class ExpressionChecker
{
    private readonly ModelIndex _index;
    private readonly TypeResolver _resolver;
    private readonly IReadOnlySet<string> _enumMembers;
    private readonly List<Diagnostic> _diagnostics;
    // Names of specs valid in the current expression's target type (R10.1); a bare
    // reference to one resolves (as a boolean) rather than being an unknown field.
    private readonly IReadOnlySet<string> _specNames;

    // Optional field names currently known to be non-null via a guard/condition
    // (flow narrowing). Saved/restored around guarded sub-expressions.
    private HashSet<string> _present = new(StringComparer.Ordinal);

    public ExpressionChecker(
        ModelIndex index,
        TypeResolver resolver,
        IReadOnlySet<string> enumMembers,
        List<Diagnostic> diagnostics,
        IReadOnlySet<string>? specNames = null)
    {
        _index = index;
        _resolver = resolver;
        _enumMembers = enumMembers;
        _diagnostics = diagnostics;
        _specNames = specNames ?? EmptySet;
    }

    private static readonly IReadOnlySet<string> EmptySet = new HashSet<string>();

    public void Check(Expr expr, TypeScope scope, TypeRef? expected = null)
    {
        switch (expr)
        {
            case IdentifierExpr id:
                // Resilient syntax: an empty-named identifier is the placeholder the builder fills
                // in for an expression the parser couldn't recover; reporting "unknown field ''"
                // would be a spurious cascade off an already-diagnosed syntax error.
                if (SemanticValidator.IsPlaceholder(id.Name))
                {
                    break;
                }

                if (!scope.Contains(id.Name) && !_enumMembers.Contains(id.Name) && !BuiltinOps.IsNullaryValueOp(id.Name)
                    && !_specNames.Contains(id.Name))
                {
                    // A name that is a spec — just not one valid here — gets a clearer message.
                    if (_index.IsAnySpec(id.Name))
                    {
                        Report(DiagnosticCodes.SpecTargetMismatch,
                            $"spec '{id.Name}' is not defined on the enclosing type", id);
                    }
                    else
                    {
                        var fieldCandidates = scope.Names.Concat(_enumMembers).Concat(_specNames).ToList();
                        Report(DiagnosticCodes.UnknownField,
                            $"unknown field '{id.Name}'{Suggestions.For(id.Name, fieldCandidates)}", id,
                            Suggestions.Best(id.Name, fieldCandidates));
                    }
                }
                break;

            case LiteralExpr:
                break;

            case UnaryExpr u:
                Check(u.Operand, scope);
                break;

            case MatchExpr m:
                Check(m.Target, scope);
                break;

            case GuardExpr g:
                // `body when cond`: the body is only evaluated when cond holds, so a
                // presence check in cond narrows the body's optional fields.
                Check(g.Condition, scope);
                CheckNarrowed(g.Body, scope, g.Condition, positive: true, expected);
                break;

            case BinaryExpr b:
                Check(b.Left, scope);
                Check(b.Right, scope);
                CheckComparison(b, scope, expected);
                CheckArithmeticNullSafety(b, scope);
                CheckValueObjectScalarArithmetic(b, scope);
                CheckValueObjectTypeMismatch(b, scope);
                CheckValueObjectMulDivMismatch(b, scope);
                CheckEntityOperandArithmetic(b, scope);
                break;

            case CoalesceExpr co:
                Check(co.Left, scope, expected);
                Check(co.Right, scope, expected);
                // Resolve a bare shared enum member against the other side / expected type.
                CheckEnumMemberResolvable(co.Left, ConcreteEnumType(co.Right, scope) ?? expected, scope);
                CheckEnumMemberResolvable(co.Right, ConcreteEnumType(co.Left, scope) ?? expected, scope);
                break;

            case ConditionalExpr c:
                Check(c.Condition, scope);
                // `if cond then a else b`: cond narrows a (true) / b (false).
                CheckNarrowed(c.Then, scope, c.Condition, positive: true, expected);
                CheckNarrowed(c.Else, scope, c.Condition, positive: false, expected);

                // Resolve each branch against the other branch's concrete enum type
                // (or the expected type) so a shared enum member doesn't depend on
                // declaration order; flag genuinely unresolvable members (KOI0213).
                TypeRef? thenCtx = ConcreteEnumType(c.Else, scope) ?? expected;
                TypeRef? elseCtx = ConcreteEnumType(c.Then, scope) ?? expected;
                CheckEnumMemberResolvable(c.Then, thenCtx, scope);
                CheckEnumMemberResolvable(c.Else, elseCtx, scope);
                TypeRef? thenType = ResolveEnumOperand(c.Then, thenCtx, scope) ?? _resolver.Infer(c.Then, scope);
                TypeRef? elseType = ResolveEnumOperand(c.Else, elseCtx, scope) ?? _resolver.Infer(c.Else, scope);
                if (thenType is not null && elseType is not null && !Compatible(thenType, elseType))
                {
                    Report(DiagnosticCodes.IncompatibleConditionalBranches,
                        $"conditional branches have incompatible types '{thenType.Name}' and '{elseType.Name}'", c);
                }

                break;

            case MemberAccessExpr ma:
                CheckMember(ma, scope);
                break;

            case CallExpr call:
                CheckCall(call, scope);
                break;

            case LetExpr let:
                CheckLet(let, scope, expected);
                break;
        }
    }

    /// <summary>
    /// Checks a <c>let x = e (, y = e)* in body</c>: each binding's value is checked
    /// in the accumulating scope (so it sees earlier bindings but not itself or later
    /// ones), then the body is checked in the fully-extended scope. A binding name that
    /// repeats within the same <c>let</c> is reported as a duplicate.
    /// </summary>
    private void CheckLet(LetExpr let, TypeScope scope, TypeRef? expected)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        TypeScope bound = scope;
        foreach (LetBinding binding in let.Bindings)
        {
            Check(binding.Value, bound);
            if (!seen.Add(binding.Name))
            {
                Report(DiagnosticCodes.DuplicateLetBinding,
                    $"duplicate let binding '{binding.Name}'", let);
            }

            // The binding's value is in scope for the bindings that follow and the body
            // (an undeterminable value resolves to ErrorType).
            bound = bound.With(binding.Name, _resolver.TypeOf(binding.Value, bound));
        }
        Check(let.Body, bound, expected);
    }

    private void CheckComparison(BinaryExpr b, TypeScope scope, TypeRef? expected = null)
    {
        var isRelational = b.Op is BinaryOp.Lt or BinaryOp.Le or BinaryOp.Gt or BinaryOp.Ge;
        if (!isRelational && b.Op is not (BinaryOp.Eq or BinaryOp.Neq))
        {
            return;
        }

        TypeRef? rawLeft = _resolver.Infer(b.Left, scope);
        TypeRef? rawRight = _resolver.Infer(b.Right, scope);

        // Disambiguating context must come from a CONCRETE enum source (a field, a
        // qualified ref, or an unambiguous member) — not another ambiguous member.
        TypeRef? concreteLeft = ConcreteEnumType(b.Left, scope);
        TypeRef? concreteRight = ConcreteEnumType(b.Right, scope);

        // A bare enum member shared by ≥2 enums must be resolvable from the other
        // operand's concrete type or, failing that, the expected type flowing in
        // (the enclosing default/return/transition enum). This matches the
        // conditional/coalesce paths and the emitter; KOI0213 fires only when
        // neither context selects exactly one declaring enum.
        CheckEnumMemberResolvable(b.Left, concreteRight ?? expected, scope);
        CheckEnumMemberResolvable(b.Right, concreteLeft ?? expected, scope);

        // Resolve a bare enum member against the other operand's enum type (or the
        // expected type) so a shared member name (e.g. two enums with `Cancelled`)
        // compares correctly.
        TypeRef? left = ResolveEnumOperand(b.Left, concreteRight ?? expected, scope) ?? rawLeft;
        TypeRef? right = ResolveEnumOperand(b.Right, concreteLeft ?? expected, scope) ?? rawRight;

        // Operands must be comparable to each other: same type, or both numeric.
        // (Subsumes the Instant rule: Instant is only comparable to Instant.)
        if (left is not null && right is not null && !Compatible(left, right))
        {
            Report(DiagnosticCodes.IncomparableTypes, $"cannot compare '{left.Name}' with '{right.Name}'", b);
            return;
        }

        // Relational (< <= > >=) additionally requires an ordered operand type;
        // value objects, strings and bools have no relational operators in C#.
        if (isRelational)
        {
            // A lifted relational op on a null operand is silently false — a trap.
            if (IsUnguardedOptional(b.Left, left) || IsUnguardedOptional(b.Right, right))
            {
                Report(DiagnosticCodes.OptionalDereference,
                    "optional value may be null; guard with isPresent or use '??' before comparing", b);
                return;
            }

            TypeRef? operand = !IsOrderable(left) ? left : !IsOrderable(right) ? right : null;
            if (operand is not null)
            {
                Report(DiagnosticCodes.RelationalOnNonOrderable, $"relational operator cannot be applied to '{operand.Name}'", b);
            }
        }
    }

    /// <summary>
    /// Rejects scalar add/subtract against a value object (e.g. <c>5.0 + money</c>, <c>money - 1</c>),
    /// and a scalar divided BY a value object (e.g. <c>2 / fee</c>). A value object SCALES by a scalar
    /// (<c>money * 2</c>, <c>money / 2</c> — handled by the multiply/divide paths), but there is no
    /// <c>operator +/-(value-object, scalar)</c> in any target — the C# emitter would produce
    /// <c>5.0m + money</c> (CS0019) and the TypeScript emitter <c>new Decimal('5.0').add(money)</c>
    /// (a <c>tsc</c> type error). Division is additionally non-commutative: #832 demand-generates only
    /// <c>operator /(value-object, scalar)</c>, so the reversed <c>scalar / value-object</c> has no
    /// operator to lower to either. <see cref="TypeResolver.Infer"/> infers such expressions as the
    /// value-object type, so without this check they slip through to the emitters as non-compiling
    /// code. Rejecting them here keeps the reversed-additive path (#804, follow-up to the
    /// reversed-multiply fixes #788/#797) and the reversed-division path (#878) unreachable across
    /// every emitter. Scalar multiply/divide of a value object is a first-class, supported operation
    /// (multiply is commutative; <c>vo / scalar</c> scales down) — EXCEPT when the value object has no
    /// numeric stored field to scale: every emitter demand-generates the scalar operator only for a
    /// value object with a numeric field, so scaling a purely non-numeric value object references an
    /// operator no target emits (CS0019). Those supported scaling forms are therefore rejected with
    /// <see cref="DiagnosticCodes.ValueObjectScalarArithmeticNoNumericField"/> (KOI0216, #939) when the
    /// value object declares zero stored numeric fields. (Direct same-type <c>+</c>/<c>-</c> that no
    /// <c>sum</c> fold generated an operator for is tracked separately, not here — #833.)
    /// </summary>
    private void CheckValueObjectScalarArithmetic(BinaryExpr b, TypeScope scope)
    {
        if (b.Op is not (BinaryOp.Add or BinaryOp.Sub or BinaryOp.Mul or BinaryOp.Div))
        {
            return;
        }

        TypeRef? left = _resolver.Infer(b.Left, scope);
        TypeRef? right = _resolver.Infer(b.Right, scope);

        // Exactly one side is a value object and the other a bare numeric scalar (Int/Decimal).
        var voOnLeft = _resolver.IsValueLike(left) && TypeResolver.IsNumeric(right);
        var voOnRight = _resolver.IsValueLike(right) && TypeResolver.IsNumeric(left);
        if (!voOnLeft && !voOnRight)
        {
            return;
        }

        TypeRef vo = voOnLeft ? left! : right!;

        // Supported SCALING forms: `vo * scalar` / `scalar * vo` (multiply is commutative) and
        // `vo / scalar` (division scales down; the reversed `scalar / vo` is an unsupported form
        // handled by the KOI0215 path below). Every emitter demand-generates the scalar operator
        // ONLY when the value object has a numeric field to scale (CSharpEmitter.NumericFields =
        // bound.StoredFields where Int/Decimal); with none it silently no-ops and the emitted
        // `vo * / scalar` references an operator that was never generated (C# CS0019). Reject here.
        var isScaling = b.Op == BinaryOp.Mul || (b.Op == BinaryOp.Div && voOnLeft);
        if (isScaling)
        {
            if (!HasNumericStoredField(vo))
            {
                Report(DiagnosticCodes.ValueObjectScalarArithmeticNoNumericField,
                    $"cannot scale value object '{vo.Name}' by a scalar; it has no numeric field to multiply or divide", b);
            }

            return;
        }

        // Unsupported forms: additive `vo +/- scalar` (either direction) and reversed `scalar / vo`.
        var verb = b.Op switch
        {
            BinaryOp.Add => "add a scalar to",
            BinaryOp.Sub => "subtract a scalar from",
            _ => "divide a scalar by",
        };
        var tail = b.Op == BinaryOp.Div
            ? "a value object scales by a scalar with '*'/'/', not the reverse"
            : "a value object scales by a scalar with '*', not '+'/'-'";
        Report(DiagnosticCodes.ValueObjectScalarArithmetic,
            $"cannot {verb} value object '{vo.Name}'; {tail}", b);
    }

    /// <summary>
    /// True when <paramref name="vo"/> is a value object declaring at least one STORED numeric
    /// (Int/Decimal) field — the same set the emitters scale (CSharpEmitter.NumericFields over
    /// bound.StoredFields). Derived/computed members are excluded via MemberAnalysis.IsDerived so the
    /// validator and every emitter classify members identically.
    /// </summary>
    /// <remarks>
    /// #1285: resolves <paramref name="vo"/> via <see cref="ResolveValueObject"/> — the same
    /// context-aware lookup (<c>vo.Qualifier ?? _resolver.Context</c>, R13.2) already used elsewhere in
    /// this file — NOT the flat <see cref="ModelIndex.TryGetDecl"/> alone, which is keyed by bare name
    /// across the whole model. Two different contexts may legally declare their own same-named value
    /// object; resolving without the reference site's context can silently pick the WRONG declaration.
    /// </remarks>
    private bool HasNumericStoredField(TypeRef vo)
    {
        if (ResolveValueObject(vo) is not { } v)
        {
            return false;
        }

        var names = v.Members.Select(m => m.Name).ToList();
        return v.Members.Any(m => !MemberAnalysis.IsDerived(m, names) && TypeResolver.IsNumeric(m.Type));
    }

    /// <summary>
    /// #1266/#1284: a value-object's <c>+</c>/<c>-</c> lowers to an operator/method that only ever
    /// accepts another instance of its OWN declared type (a <c>quantity</c>'s unit-checked
    /// <c>add</c>/<c>sub</c>, #1068; a plain value object's generated same-type operator, #833/#600).
    /// Nothing previously checked that both operands of a binary <c>+</c>/<c>-</c> declare the SAME
    /// type, so e.g. <c>Weight + Volume</c> or <c>Weight + Money</c> compiled with zero diagnostics and
    /// only failed downstream in a target's own toolchain (a real C# CS0019 / Rust E0308). Reject it
    /// here, target-agnostically, before any emitter ever sees the expression. #1266 introduced this
    /// scoped to quantity-vs-quantity only (<see cref="DiagnosticCodes.QuantityTypeMismatch"/>,
    /// KOI0218); #1284 generalizes it to any two value-like operands (quantity-vs-quantity,
    /// quantity-vs-plain-VO, or plain-VO-vs-plain-VO), keeping KOI0218's quantity-specific message for
    /// the quantity-vs-quantity case and a new <see cref="DiagnosticCodes.ValueObjectTypeMismatch"/>
    /// (KOI0219) for the general case.
    ///
    /// Both operands are resolved via <see cref="ResolveValueObject"/> — the SAME context-aware
    /// resolution #1266's review pass established for the (now-folded-in) former <c>IsQuantity</c>
    /// helper (<c>t.Qualifier ?? _resolver.Context</c> + <see cref="ModelIndex.TryGetDeclIn"/>, falling
    /// back to the global <see cref="ModelIndex.TryGetDecl"/>) — and type identity is compared by the
    /// resolved <see cref="ValueObjectDecl"/> reference, not by bare name. A bare-name/flat-classify
    /// comparison (the original, narrower <c>IsQuantity</c> shape this replaces) is wrong on two counts
    /// R13.2 explicitly allows: (1) two operands can share a bare name while naming DIFFERENT declared
    /// types in different contexts (e.g. qualified references <c>A.Money</c> vs <c>B.Money</c>), which a
    /// bare-name equality check would wrongly treat as "the same type" and skip; (2) an unrelated
    /// context can declare its own, differently-kinded type under the SAME bare name as an in-scope
    /// value object, which <see cref="TypeResolver.IsValueLike"/>'s flat, context-blind
    /// <see cref="ModelIndex.Classify"/> lookup can resolve instead — wrongly classifying a genuinely
    /// value-like operand as not value-like and skipping the check entirely (a regression of #1266's own
    /// guarantee, not just an #1284 gap).
    /// </summary>
    private void CheckValueObjectTypeMismatch(BinaryExpr b, TypeScope scope)
    {
        if (b.Op is not (BinaryOp.Add or BinaryOp.Sub))
        {
            return;
        }

        if (!TryResolveValueLikeOperands(b, scope, out TypeRef? left, out TypeRef? right, out ValueObjectDecl? leftDecl, out ValueObjectDecl? rightDecl))
        {
            return;
        }

        if (ReferenceEquals(leftDecl, rightDecl) || (leftDecl is null && rightDecl is null && left.Name == right.Name))
        {
            return; // same declared type
        }

        var verb = b.Op.Verb();
        if (leftDecl is { IsQuantity: true } && rightDecl is { IsQuantity: true })
        {
            Report(DiagnosticCodes.QuantityTypeMismatch,
                $"cannot {verb} quantities '{left.Name}' and '{right.Name}'; quantities must be the same type", b);
        }
        else
        {
            Report(DiagnosticCodes.ValueObjectTypeMismatch,
                $"cannot {verb} value objects '{left.Name}' and '{right.Name}'; a value object's '+'/'-' only combines two instances of the SAME declared type", b);
        }
    }

    /// <summary>
    /// Resolves <paramref name="t"/> to its declared <see cref="ValueObjectDecl"/> the same
    /// context-aware way member/operation lookups do elsewhere in this file (<c>t.Qualifier ??
    /// _resolver.Context</c>, R13.2) — NOT the flat <see cref="ModelIndex.TryGetDecl"/> alone, which is
    /// keyed by bare name across the whole model. Two different contexts may legally declare their own
    /// same-named type (one a value object, one not); resolving without the reference site's context can
    /// silently pick the WRONG declaration. Returns <c>null</c> when <paramref name="t"/> doesn't resolve
    /// to a value object in scope (including when it doesn't resolve to any declared type at all).
    /// </summary>
    private ValueObjectDecl? ResolveValueObject(TypeRef t) => ResolveDecl(t) as ValueObjectDecl;

    /// <summary>
    /// Resolves <paramref name="t"/> to its declaration the same context-aware way
    /// <see cref="ResolveValueObject"/> and every other lookup in this file do (<c>t.Qualifier ??
    /// _resolver.Context</c> + <see cref="ModelIndex.TryGetDeclIn"/>, falling back to the global
    /// <see cref="ModelIndex.TryGetDecl"/>, R13.2). Returns <c>null</c> when <paramref name="t"/>
    /// doesn't resolve to any declared type at all (e.g. an Id-convention synthetic type).
    /// </summary>
    private TypeDecl? ResolveDecl(TypeRef t)
    {
        var context = t.Qualifier ?? _resolver.Context;
        if (context is not null && _index.TryGetDeclIn(context, t.Name, out TypeDecl decl))
        {
            return decl;
        }

        return _index.TryGetDecl(t.Name, out decl) ? decl : null;
    }

    /// <summary>
    /// Shared resolve-and-classify prefix for <see cref="CheckValueObjectTypeMismatch"/> and
    /// <see cref="CheckValueObjectMulDivMismatch"/>: infers both operands, resolves each to its declared
    /// <see cref="ValueObjectDecl"/> via <see cref="ResolveValueObject"/> (the context-aware R13.2
    /// resolution #1266/#1284/#1285 established), and — for a side with no declared type at all (e.g. an
    /// Id-convention synthetic type) — falls back to the flat <see cref="TypeResolver.IsValueLike"/>
    /// classification so ID-typed operands stay covered. Returns <c>false</c> (bailing the caller out)
    /// when either operand can't be inferred, or when a side resolves to no declared type AND isn't
    /// value-like by the flat classification either — i.e. it isn't value-like at all.
    /// </summary>
    private bool TryResolveValueLikeOperands(
        BinaryExpr b, TypeScope scope,
        [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out TypeRef? left,
        [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out TypeRef? right,
        out ValueObjectDecl? leftDecl, out ValueObjectDecl? rightDecl)
    {
        left = _resolver.Infer(b.Left, scope);
        right = _resolver.Infer(b.Right, scope);
        if (left is null || right is null)
        {
            leftDecl = null;
            rightDecl = null;
            return false;
        }

        leftDecl = ResolveValueObject(left);
        rightDecl = ResolveValueObject(right);

        // A resolved declaration is authoritative for its side; a side that resolves to no declared
        // type at all (e.g. an Id-convention synthetic type, which has no TypeDecl to resolve) falls
        // back to the flat IsValueLike classification so ID-typed operands stay covered.
        if (leftDecl is null && !_resolver.IsValueLike(left))
        {
            return false;
        }

        if (rightDecl is null && !_resolver.IsValueLike(right))
        {
            return false;
        }

        return true;
    }

    /// <summary>
    /// #1291: the <c>*</c>/<c>/</c> sibling gap #1284's own code-review pass found but explicitly left
    /// out of its own scope (a <c>+</c>/<c>-</c>-only fix) — a binary <c>*</c>/<c>/</c> where BOTH
    /// operands are value-like (two quantities, a quantity and a plain value object, or two plain value
    /// objects) also compiles with zero diagnostics today and fails downstream with a real C# CS0019
    /// (this issue's own repro: <c>value Mix { m: Money; w: Weight; bad: Money = m * w }</c>).
    /// <see cref="CheckValueObjectScalarArithmetic"/> only fires when EXACTLY one side is value-like and
    /// the OTHER is a bare numeric scalar (Int/Decimal) — its <c>voOnLeft</c>/<c>voOnRight</c> both stay
    /// <c>false</c> when BOTH sides are value-like, so it silently no-ops for this case.
    /// <see cref="CheckValueObjectTypeMismatch"/> only guards <see cref="BinaryOp.Add"/>/
    /// <see cref="BinaryOp.Sub"/>. No existing check covers two value-like operands combined via
    /// <c>*</c>/<c>/</c>.
    ///
    /// UNLIKE <see cref="CheckValueObjectTypeMismatch"/>, this check has NO same-declared-type
    /// exception: no emitter ever generates a value-object-vs-value-object <c>*</c>/<c>/</c> operator,
    /// even for the SAME type (<c>Money * Money</c> is as meaningless dimensionally as
    /// <c>Money * Weight</c> and has no generated operator either — unlike same-type <c>+</c>/<c>-</c>,
    /// which some value objects/quantities DO support).
    ///
    /// Both operands are resolved via the shared <see cref="TryResolveValueLikeOperands"/> prefix — the
    /// same context-aware resolution <see cref="CheckValueObjectTypeMismatch"/> uses.
    /// </summary>
    private void CheckValueObjectMulDivMismatch(BinaryExpr b, TypeScope scope)
    {
        if (b.Op is not (BinaryOp.Mul or BinaryOp.Div))
        {
            return;
        }

        if (!TryResolveValueLikeOperands(b, scope, out TypeRef? left, out TypeRef? right, out _, out _))
        {
            return;
        }

        var verb = b.Op.Verb();
        Report(DiagnosticCodes.ValueObjectMulDivMismatch,
            $"cannot {verb} value objects '{left.Name}' and '{right.Name}'; no target ever generates a "
            + "'*'/'/' operator between two value-like operands, even of the SAME declared type", b);
    }

    /// <summary>
    /// #1290/#1300: an entity's (or aggregate's) <c>+</c>/<c>-</c>/<c>*</c>/<c>/</c> has no lowering in
    /// ANY target — unlike a value object/quantity, which at least supports same-declared-type
    /// addition/subtraction (<see cref="CheckValueObjectTypeMismatch"/>) or scalar scaling
    /// (<see cref="CheckValueObjectScalarArithmetic"/>) in some cases, an entity NEVER has a generated
    /// arithmetic operator for ANY binary operator, regardless of what the other operand is.
    /// <see cref="TypeResolver.IsValueLike"/> returns <c>false</c> for
    /// <see cref="TypeKind.Entity"/>/<see cref="TypeKind.Aggregate"/>, so
    /// <see cref="CheckValueObjectTypeMismatch"/> and <see cref="CheckValueObjectScalarArithmetic"/> both
    /// bail out entirely as soon as either operand is an entity — entity-typed fields are legal Koine
    /// syntax (an entity may own value objects, enums, primitives, and child entities of its own
    /// aggregate as fields, per <c>ReferenceDisciplineAnalyzer.CheckEntityReferences</c>), so a
    /// <c>derived</c> member referencing such a field via any of <c>+</c>/<c>-</c>/<c>*</c>/<c>/</c>
    /// previously compiled with zero diagnostics and failed downstream with a real C# CS0019 (#1290's and
    /// this issue's own repros) or a Rust E0308. Reject it here, target-agnostically, before any emitter
    /// ever sees the expression — unconditionally of the other operand's type: unlike
    /// <see cref="CheckValueObjectTypeMismatch"/>'s same-declared-type early return, entity-vs-entity of
    /// the SAME type is ALSO rejected, since entities have no arithmetic operator regardless of a type
    /// match. <c>==</c>/<c>!=</c> (identity comparison) is untouched — this check only looks at
    /// <see cref="BinaryOp.Add"/>/<see cref="BinaryOp.Sub"/>/<see cref="BinaryOp.Mul"/>/
    /// <see cref="BinaryOp.Div"/>.
    ///
    /// Both operands are resolved via <see cref="ResolveDecl"/> — the SAME context-aware resolution
    /// <see cref="ResolveValueObject"/> and #1266/#1284 already established.
    ///
    /// The <c>or AggregateDecl</c> disjunct is NOT defensive/dead code: a field can legally be typed
    /// with an aggregate's own bare name (e.g. a cross-aggregate reference, separately also flagged by
    /// <c>ReferenceDisciplineAnalyzer</c>'s KOI1602 — see <c>DddReferenceDisciplineTests
    /// .An_entity_field_typed_as_an_aggregate_is_reported</c>), and a domain-service <c>operation</c>
    /// parameter typed with an aggregate's name is NOT covered by <c>ReferenceDisciplineAnalyzer</c> at
    /// all (it only guards entity fields, value-object members, domain-event fields, and
    /// command/factory parameters) — so this disjunct is this check's ONLY guard against an
    /// aggregate-typed <c>operation</c> parameter reaching any of these operators.
    ///
    /// #1300 widened this from Add/Sub-only to also cover Mul/Div, reusing KOI0220 rather than a new
    /// code — it's one semantic concept ("entities/aggregates never have a generated arithmetic
    /// operator"), not four.
    /// </summary>
    private void CheckEntityOperandArithmetic(BinaryExpr b, TypeScope scope)
    {
        if (b.Op is not (BinaryOp.Add or BinaryOp.Sub or BinaryOp.Mul or BinaryOp.Div))
        {
            return;
        }

        TypeRef? left = _resolver.Infer(b.Left, scope);
        TypeRef? right = _resolver.Infer(b.Right, scope);
        if (left is null || right is null)
        {
            return;
        }

        string? leftKind = EntityOrAggregateKind(ResolveDecl(left));
        string? rightKind = EntityOrAggregateKind(ResolveDecl(right));
        if (leftKind is null && rightKind is null)
        {
            return;
        }

        (string verb, string symbol) = (b.Op.Verb(), b.Op.Symbol());
        var culprit = leftKind is not null && rightKind is not null
            ? $"'{left.Name}' ({leftKind}) and '{right.Name}' ({rightKind})"
            : leftKind is not null
                ? $"'{left.Name}' ({leftKind})"
                : $"'{right.Name}' ({rightKind})";
        Report(DiagnosticCodes.EntityOperandArithmetic,
            $"cannot {verb} '{left.Name}' and '{right.Name}'; {culprit} — entities and aggregates never "
            + $"have a generated '{symbol}' operator, regardless of the other operand", b);
    }

    /// <summary>"entity"/"aggregate" for <see cref="DiagnosticCodes.EntityOperandArithmetic"/>'s
    /// message, naming which side is the offending operand and its exact kind; <c>null</c> when
    /// <paramref name="decl"/> is neither (the caller's early-return signal).</summary>
    private static string? EntityOrAggregateKind(TypeDecl? decl) => decl switch
    {
        EntityDecl => "entity",
        AggregateDecl => "aggregate",
        _ => null
    };

    private void CheckArithmeticNullSafety(BinaryExpr b, TypeScope scope)
    {
        if (b.Op is not (BinaryOp.Add or BinaryOp.Sub or BinaryOp.Mul or BinaryOp.Div))
        {
            return;
        }

        TypeRef? left = _resolver.Infer(b.Left, scope);
        TypeRef? right = _resolver.Infer(b.Right, scope);
        if (IsUnguardedOptional(b.Left, left) || IsUnguardedOptional(b.Right, right))
        {
            Report(DiagnosticCodes.OptionalDereference,
                "optional value may be null; guard with isPresent or use '??' before arithmetic", b);
        }
    }

    /// <summary>
    /// Flags a bare enum member that belongs to more than one enum and cannot be
    /// resolved from the comparison's other operand type.
    /// </summary>
    private void CheckEnumMemberResolvable(Expr operand, TypeRef? otherType, TypeScope scope)
    {
        if (operand is not IdentifierExpr id || scope.Contains(id.Name))
        {
            return; // a field reference, not a bare enum member
        }

        IReadOnlyList<string> owners = _index.EnumsDeclaring(id.Name);
        if (owners.Count <= 1)
        {
            return; // unambiguous (or not an enum member)
        }

        if (otherType is not null && owners.Contains(otherType.Name))
        {
            return; // resolved by the other operand's enum type
        }

        Report(DiagnosticCodes.AmbiguousEnumMember,
            $"ambiguous enum member '{id.Name}' (declared by {string.Join(", ", owners)}); qualify as Enum.{id.Name}", operand);
    }

    /// <summary>
    /// If <paramref name="operand"/> is a bare enum member that the other operand's
    /// enum type declares, resolves it to that enum type; otherwise <c>null</c>.
    /// </summary>
    private TypeRef? ResolveEnumOperand(Expr operand, TypeRef? otherType, TypeScope scope)
    {
        if (operand is IdentifierExpr id && !scope.Contains(id.Name)
            && otherType is not null && _index.EnumsDeclaring(id.Name).Contains(otherType.Name))
        {
            return otherType;
        }

        return null;
    }

    /// <summary>
    /// The enum type an operand concretely denotes for disambiguation purposes: a
    /// field's enum type, a qualified <c>Enum.Member</c>, or an UNAMBIGUOUS bare
    /// member. An ambiguous bare member denotes no concrete type (returns null).
    /// </summary>
    private TypeRef? ConcreteEnumType(Expr operand, TypeScope scope)
    {
        if (operand is IdentifierExpr id)
        {
            if (scope.Contains(id.Name))
            {
                TypeRef? t = _resolver.Infer(operand, scope);
                return t is not null && _index.IsEnumType(t.Name) ? t : null;
            }
            IReadOnlyList<string> owners = _index.EnumsDeclaring(id.Name);
            return owners.Count == 1 ? new TypeRef(owners[0]) : null;
        }

        if (operand is MemberAccessExpr { Target: IdentifierExpr typeId } && _index.IsEnumType(typeId.Name))
        {
            return new TypeRef(typeId.Name);
        }

        TypeRef? inferred = _resolver.Infer(operand, scope);
        return inferred is not null && _index.IsEnumType(inferred.Name) ? inferred : null;
    }

    /// <summary>True when a type supports the C# relational operators (or is unknown).</summary>
    private static bool IsOrderable(TypeRef? t) =>
        t is null || TypeResolver.IsNumeric(t) || t.Name == "Instant";

    /// <summary>An optional operand that has not been narrowed to present by a guard.</summary>
    private bool IsUnguardedOptional(Expr expr, TypeRef? type) =>
        type is { IsOptional: true } && !IsNarrowed(expr);

    /// <summary>True when the expression is a field already proven present in this scope.</summary>
    private bool IsNarrowed(Expr expr) => expr is IdentifierExpr id && _present.Contains(id.Name);

    /// <summary>Checks <paramref name="body"/> with the fields proven present by <paramref name="cond"/> narrowed.</summary>
    private void CheckNarrowed(Expr body, TypeScope scope, Expr cond, bool positive, TypeRef? expected = null)
    {
        HashSet<string> saved = _present;
        _present = new HashSet<string>(saved, StringComparer.Ordinal);
        foreach (var name in CollectPresent(cond, positive))
        {
            _present.Add(name);
        }

        Check(body, scope, expected);
        _present = saved;
    }

    /// <summary>
    /// The optional field names proven non-null when <paramref name="cond"/> evaluates
    /// to <paramref name="positive"/>, from <c>isPresent</c>/<c>isNone</c> guards
    /// (and their <c>&amp;&amp;</c>/<c>||</c>/<c>!</c> combinations).
    /// </summary>
    private static IEnumerable<string> CollectPresent(Expr cond, bool positive)
    {
        switch (cond)
        {
            case MemberAccessExpr { Target: IdentifierExpr id, MemberName: "isPresent" } when positive:
                yield return id.Name;
                break;
            case MemberAccessExpr { Target: IdentifierExpr id, MemberName: "isNone" } when !positive:
                yield return id.Name;
                break;
            case UnaryExpr { Op: UnaryOp.Not } u:
                foreach (var n in CollectPresent(u.Operand, !positive))
                {
                    yield return n;
                }

                break;
            case BinaryExpr { Op: BinaryOp.And } b when positive:
                foreach (var n in CollectPresent(b.Left, true))
                {
                    yield return n;
                }

                foreach (var n in CollectPresent(b.Right, true))
                {
                    yield return n;
                }

                break;
            case BinaryExpr { Op: BinaryOp.Or } b when !positive:
                foreach (var n in CollectPresent(b.Left, false))
                {
                    yield return n;
                }

                foreach (var n in CollectPresent(b.Right, false))
                {
                    yield return n;
                }

                break;
        }
    }

    private void CheckMember(MemberAccessExpr ma, TypeScope scope)
    {
        // Qualified enum reference `EnumType.Member`: validate the member, don't
        // treat the enum type name as a field.
        if (ma.Target is IdentifierExpr typeId && _index.IsEnumType(typeId.Name))
        {
            if (!_index.EnumsDeclaring(ma.MemberName).Contains(typeId.Name))
            {
                Report(DiagnosticCodes.UnknownEnumMemberForType,
                    $"unknown enum member '{ma.MemberName}' for type '{typeId.Name}'", ma);
            }

            return;
        }

        Check(ma.Target, scope);
        var op = ma.MemberName;
        TypeRef? target = _resolver.Infer(ma.Target, scope);

        // Presence checks require an optional receiver (else they are meaningless,
        // and `is null` on a non-nullable value type does not even compile).
        if (BuiltinOps.OptionalMemberOps.Contains(op))
        {
            if (target is not null && !target.IsOptional)
            {
                Report(DiagnosticCodes.PresenceOnNonOptional,
                    $"'{op}' can only be applied to an optional value; '{target.Name}' is not optional", ma);
            }

            return;
        }

        // Any other access on an optional value (not narrowed to present) risks null.
        if (IsUnguardedOptional(ma.Target, target))
        {
            Report(DiagnosticCodes.OptionalDereference,
                $"optional value may be null; guard with isPresent or use '??' before '.{op}'", ma);
            return;
        }

        // A user-declared member named after a built-in member-op (count/length/…) shadows
        // the op: resolve it as an ordinary field access — no string/collection-op diagnostic
        // (#605). Mirrors the plain-field branch below and TypeResolver.VisitMemberAccess.
        if (target is not null && _resolver.IsUserType(target)
            && _index.TryGetMemberType(target.Qualifier ?? _resolver.Context, target.Name, op, out _))
        {
            return;
        }

        if (BuiltinOps.StringMemberOps.Contains(op))
        {
            if (target is not null && target.Name != "String")
            {
                Report(DiagnosticCodes.StringOperationOnNonString, $"string operation '{op}' cannot be applied to '{target.Name}'", ma);
            }
        }
        else if (BuiltinOps.CollectionMemberOps.Contains(op))
        {
            if (target is not null && !IsCollection(target))
            {
                Report(DiagnosticCodes.CollectionOperationOnNonCollection, $"collection operation '{op}' cannot be applied to '{target.Name}'", ma);
            }
        }
        else
        {
            // A plain field access. If the receiver is known we can be strict.
            if (target is null)
            {
                return;
            }

            if (target.Name == "String")
            {
                Report(DiagnosticCodes.UnknownStringOperation, $"unknown string operation '{op}'", ma);
            }
            else if (IsCollection(target))
            {
                Report(DiagnosticCodes.UnknownCollectionOperation, $"unknown collection operation '{op}'", ma);
            }
            else if (_resolver.IsUserType(target) && !_index.TryGetMemberType(target.Qualifier ?? _resolver.Context, target.Name, op, out _))
            {
                Report(DiagnosticCodes.UnknownMember,
                    $"unknown member '{op}' on type '{target.Name}'{Suggestions.For(op, _index.MemberNames(target.Name))}", ma);
            }
            else if (_index.Classify(target.Name) == TypeKind.Primitive)
            // A primitive (Int/Decimal/Bool/Instant) has no accessible members.
            {
                Report(DiagnosticCodes.UnknownMember, $"unknown member '{op}' on type '{target.Name}'", ma);
            }
        }
    }

    /// <summary>List/Set/Map — types that expose count/isEmpty/isNotEmpty.</summary>
    private bool IsCollection(TypeRef t) =>
        _index.Classify(t.Name) is TypeKind.List or TypeKind.Set or TypeKind.Map;

    /// <summary>List/Set — iterable collections that support lambda ops and <c>contains</c>.</summary>
    private bool IsIterable(TypeRef t) =>
        _index.Classify(t.Name) is TypeKind.List or TypeKind.Set;

    private void CheckCall(CallExpr call, TypeScope scope)
    {
        Check(call.Target, scope);
        var op = call.Method;
        TypeRef? target = _resolver.Infer(call.Target, scope);

        // A call op on an optional receiver (not narrowed to present) risks null.
        if (IsUnguardedOptional(call.Target, target))
        {
            Report(DiagnosticCodes.OptionalDereference,
                $"optional value may be null; guard with isPresent or use '??' before '.{op}'", call);
        }

        if (BuiltinOps.TakesLambda(op))
        {
            if (target is not null && !IsIterable(target))
            {
                Report(DiagnosticCodes.CollectionOperationOnNonCollection, $"collection operation '{op}' cannot be applied to '{target.Name}'", call);
            }

            if (call.Args is [LambdaExpr lambda])
            {
                TypeRef? element = TypeResolver.ElementOf(target);
                // A null element resolves to ErrorType (the lambda parameter's type is undeterminable).
                TypeScope inner = scope.With(lambda.Parameter, KoineType.From(element, _index));
                Check(lambda.Body, inner);
                CheckAggregateSelector(op, lambda, inner, call);
            }
            else
            {
                Report(DiagnosticCodes.OperationArgument, $"operation '{op}' expects a single lambda argument", call);
                foreach (Expr arg in call.Args)
                {
                    Check(arg, scope);
                }
            }
        }
        else if (BuiltinOps.StringCallOps.Contains(op) || BuiltinOps.CollectionElementCallOps.Contains(op))
        {
            foreach (Expr arg in call.Args)
            {
                Check(arg, scope);
            }

            var collectionContains = op == "contains" && target is not null && IsIterable(target);
            if (target is not null && target.Name != "String" && !collectionContains)
            {
                Report(DiagnosticCodes.StringOperationOnNonString, $"string operation '{op}' cannot be applied to '{target.Name}'", call);
            }

            if (call.Args.Count != 1)
            {
                Report(DiagnosticCodes.OperationArgument, $"operation '{op}' expects a single argument", call);
            }
            else
            {
                CheckCallArgumentType(op, target, call.Args[0], collectionContains, scope, call);
            }
        }
        else if (call.Args.Count == 0 && _index.IsAnySpec(op))
        {
            // A spec call: `o.IsLarge()` invokes a declared spec on a parameter of the spec's
            // target type, translated to the spec's generated extension method. Valid only when
            // the receiver's static type is the spec's declared target; otherwise the predicate
            // would not apply. (An unresolved receiver is left to its own earlier diagnostic.)
            if (target is not null && !_index.TryGetSpec(target.Name, op, out _))
            {
                var declaredOn = string.Join("/", _index.AllSpecs().Where(s => s.Name == op).Select(s => s.TargetType).Distinct());
                Report(DiagnosticCodes.SpecCallTargetMismatch,
                    $"spec '{op}' applies to '{declaredOn}', not '{target.Name}'", call);
            }
        }
        else
        {
            Report(DiagnosticCodes.UnknownOperation, $"unknown operation '{op}'", call);
            foreach (Expr arg in call.Args)
            {
                Check(arg, scope);
            }
        }
    }

    /// <summary>
    /// Constrains aggregate selector result types: <c>sum</c> needs a numeric or
    /// value-object selector; <c>min</c>/<c>max</c> need a comparable scalar (value
    /// objects/entities are plain records and are not orderable in C#).
    /// </summary>
    private void CheckAggregateSelector(string op, LambdaExpr lambda, TypeScope inner, CallExpr call)
    {
        if (op is not ("sum" or "min" or "max"))
        {
            return;
        }

        TypeRef? selector = _resolver.Infer(lambda.Body, inner);
        if (selector is null)
        {
            return;
        }

        if (op == "sum")
        {
            if (!TypeResolver.IsNumeric(selector) && _index.Classify(selector.Name) != TypeKind.Value)
            {
                Report(DiagnosticCodes.AggregateSelector, $"sum requires a numeric or value-object selector, but got '{selector.Name}'", call);
            }
        }
        else // min / max
        {
            TypeKind kind = _index.Classify(selector.Name);
            if (_resolver.IsValueLike(selector) || kind == TypeKind.Entity)
            {
                Report(DiagnosticCodes.AggregateSelector, $"{op} requires a comparable selector; '{selector.Name}' is not orderable", call);
            }
        }
    }

    /// <summary>Type-checks the argument of a string/collection call op.</summary>
    private void CheckCallArgumentType(string op, TypeRef? target, Expr arg, bool collectionContains, TypeScope scope, CallExpr call)
    {
        TypeRef? argType = _resolver.Infer(arg, scope);
        if (argType is null)
        {
            return;
        }

        if (collectionContains)
        {
            TypeRef? element = TypeResolver.ElementOf(target);
            if (element is not null && !Compatible(argType, element))
            {
                Report(DiagnosticCodes.OperationArgument,
                    $"collection 'contains' expects an argument of type '{element.Name}', but got '{argType.Name}'", call);
            }
        }
        else if (target?.Name == "String" && argType.Name != "String")
        {
            Report(DiagnosticCodes.OperationArgument,
                $"string operation '{op}' expects a string argument, but got '{argType.Name}'", call);
        }
    }

    /// <summary>
    /// Validates a state-transition value against the target field's type: the
    /// value's identifiers/ops are checked, a bare enum member is resolved against
    /// the field's enum, and an incompatible or unsafely-optional value is reported.
    /// </summary>
    public void CheckTransitionValue(Expr value, TypeRef field, string fieldName, TypeScope scope)
    {
        Check(value, scope, field);

        TypeRef? type = ResolveEnumOperand(value, field, scope) ?? _resolver.Infer(value, scope);
        if (type is null)
        {
            return;
        }

        if (type is { IsOptional: true } && !field.IsOptional)
        {
            Report(DiagnosticCodes.OptionalAssignedToNonOptional,
                $"optional value assigned to non-optional field '{fieldName}'; provide a fallback with '??'", value);
        }
        else if (!Assignable(type, field))
        {
            Report(DiagnosticCodes.TransitionTypeMismatch,
                $"cannot assign a value of type '{FullName(type)}' to field '{fieldName}' of type '{FullName(field)}'", value);
        }
    }

    /// <summary>
    /// Validates a factory initialization value (<c>field &lt;- value</c>) against the
    /// target member's declared type: identifiers/ops are checked, a bare enum member
    /// is resolved against the field's enum, and an incompatible or unsafely-optional
    /// value is reported.
    /// </summary>
    public void CheckInitializationValue(Expr value, TypeRef field, string fieldName, TypeScope scope)
    {
        Check(value, scope, field);

        TypeRef? type = ResolveEnumOperand(value, field, scope) ?? _resolver.Infer(value, scope);
        if (type is null)
        {
            return;
        }

        if (type is { IsOptional: true } && !field.IsOptional)
        {
            Report(DiagnosticCodes.OptionalAssignedToNonOptional,
                $"optional value assigned to non-optional field '{fieldName}'; provide a fallback with '??'", value);
        }
        else if (!Assignable(type, field))
        {
            Report(DiagnosticCodes.InitializationTypeMismatch,
                $"cannot initialize field '{fieldName}' of type '{FullName(field)}' with a value of type '{FullName(type)}'", value);
        }
    }

    /// <summary>Validates a domain-service operation body against its declared return type.</summary>
    public void CheckOperationReturn(Expr body, TypeRef returnType, TypeScope scope)
    {
        Check(body, scope, returnType);

        TypeRef? type = ResolveEnumOperand(body, returnType, scope) ?? _resolver.Infer(body, scope);
        if (type is null)
        {
            return;
        }

        if (type is { IsOptional: true } && !returnType.IsOptional)
        {
            Report(DiagnosticCodes.ServiceReturnMismatch,
                $"operation returns an optional value, but its return type '{returnType.Name}' is not optional", body);
        }
        else if (!Assignable(type, returnType))
        {
            Report(DiagnosticCodes.ServiceReturnMismatch,
                $"operation body of type '{FullName(type)}' is not assignable to return type '{FullName(returnType)}'", body);
        }
    }

    /// <summary>Validates a command's <c>result</c> expression against its declared return type.</summary>
    public void CheckCommandResult(Expr value, TypeRef returnType, string commandName, TypeScope scope)
    {
        Check(value, scope, returnType);

        TypeRef? type = ResolveEnumOperand(value, returnType, scope) ?? _resolver.Infer(value, scope);
        if (type is null)
        {
            return;
        }

        if (type is { IsOptional: true } && !returnType.IsOptional)
        {
            Report(DiagnosticCodes.CommandResultMismatch,
                $"command '{commandName}' returns an optional value, but its return type '{returnType.Name}' is not optional", value);
        }
        else if (!Assignable(type, returnType))
        {
            Report(DiagnosticCodes.CommandResultMismatch,
                $"command '{commandName}' result of type '{FullName(type)}' is not assignable to return type '{FullName(returnType)}'", value);
        }
    }

    /// <summary>Validates an emit payload value against the event field's declared type.</summary>
    public void CheckEmitArg(Expr value, TypeRef field, string eventName, string fieldName, TypeScope scope)
    {
        Check(value, scope, field);

        TypeRef? type = ResolveEnumOperand(value, field, scope) ?? _resolver.Infer(value, scope);
        if (type is null)
        {
            return;
        }

        if (type is { IsOptional: true } && !field.IsOptional)
        {
            Report(DiagnosticCodes.EmitPayloadMismatch,
                $"event '{eventName}' field '{fieldName}' is not optional, but the value may be null", value);
        }
        else if (!Assignable(type, field))
        {
            Report(DiagnosticCodes.EmitPayloadMismatch,
                $"event '{eventName}' field '{fieldName}' expects '{FullName(field)}', but got '{FullName(type)}'", value);
        }
    }

    /// <summary>Renders a type reference in Koine source syntax for diagnostics.</summary>
    private static string FullName(TypeRef t)
    {
        var s = t switch
        {
            { Value: not null, Element: not null } => $"{t.Name}<{FullName(t.Element)}, {FullName(t.Value)}>",
            { Element: not null } => $"{t.Name}<{FullName(t.Element)}>",
            _ => t.Name
        };
        return t.IsOptional ? s + "?" : s;
    }

    /// <summary>Symmetric comparability (for ==/!= and conditional branches): same shape or both numeric.</summary>
    private static bool Compatible(TypeRef a, TypeRef b) =>
        SameShape(a, b) || (TypeResolver.IsNumeric(a) && TypeResolver.IsNumeric(b));

    /// <summary>
    /// Directional assignability (value -> field, for transitions/emit payloads):
    /// same shape, or an implicit numeric widening (<c>Int</c> -> <c>Decimal</c>).
    /// Unlike <see cref="Compatible"/> it does NOT allow numeric narrowing.
    /// </summary>
    private static bool Assignable(TypeRef value, TypeRef field) =>
        SameShape(value, field) || (value.Name == "Int" && field.Name == "Decimal");

    /// <summary>Structural type equivalence, recursing into generic arguments (ignores optionality).</summary>
    private static bool SameShape(TypeRef a, TypeRef b)
    {
        if (a.Name != b.Name)
        {
            return false;
        }

        if ((a.Element is null) != (b.Element is null))
        {
            return false;
        }

        if (a.Element is not null && !SameShape(a.Element, b.Element!))
        {
            return false;
        }

        if ((a.Value is null) != (b.Value is null))
        {
            return false;
        }

        if (a.Value is not null && !SameShape(a.Value, b.Value!))
        {
            return false;
        }

        return true;
    }

    private void Report(string code, string message, KoineNode node) =>
        _diagnostics.Add(Diagnostic.FromSpan(code, message, node.Span));

    /// <summary>
    /// Reports a diagnostic that also carries a structured <paramref name="suggestion"/> — the bare
    /// candidate name a "Change to 'X'" code fix replaces <paramref name="node"/>'s span with. Used
    /// for "did you mean" diagnostics whose span is exactly the mistyped identifier, so the suggested
    /// name is available structurally (not scraped from the message prose).
    /// </summary>
    private void Report(string code, string message, KoineNode node, string? suggestion)
    {
        Diagnostic diagnostic = Diagnostic.FromSpan(code, message, node.Span);
        _diagnostics.Add(suggestion is { Length: > 0 } ? diagnostic with { Suggestion = suggestion } : diagnostic);
    }
}
