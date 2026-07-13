using Koine.Compiler.Ast;

namespace Koine.Compiler;

/// <summary>
/// Tracks which names an expression translator currently has bound as LOCALS — a command/factory
/// parameter, a <c>let</c> binding, a lambda parameter — and at what <see cref="TypeRef"/>, so a
/// reference to one resolves to the local rather than a same-named member, and so the type overlay a
/// translator hands <see cref="TypeResolver"/> reflects the binding actually in scope.
///
/// <para><b>Why a stack per name.</b> A binding can SHADOW a same-named outer one
/// (<c>let n = amount in (let n = rate in n == rate) &amp;&amp; n == rate</c>; a lambda parameter over an
/// enclosing <c>let</c>). Backed by a flat name-set + type-map — as all six code emitters once were —
/// <c>PopLocal</c> can only EVICT a name, so popping the inner binding destroyed the outer one for the
/// rest of its scope and the translator went on emitting against a type it no longer knew. That is a
/// real, target-typechecker-visible defect, not a cosmetic one: #1370 hit it in Rust as a
/// <c>cargo check</c> E0308 (the second <c>n == rate</c> above lost <c>n</c>'s <c>Int?</c> and stopped
/// widening against <c>Decimal</c>), and #1497 found the identical shape in the five siblings.</para>
///
/// <para>So each name owns a stack: <see cref="PushLocal"/> stacks a binding on top of whatever was
/// there, <see cref="PopLocal"/> pops it and hands back what it shadowed — presence AND exact
/// <see cref="TypeRef"/>?. That makes push/pop properly symmetric, which in turn retires the partial
/// <c>wasPresent</c>/<c>hadType</c> save-and-restore dances the lambda paths had grown around the flat
/// state (each of which still leaked the inner parameter's type, or the outer type when the inner push
/// carried none).</para>
///
/// <para>A binding may be pushed with a <see langword="null"/> type (a lambda parameter whose element
/// type doesn't resolve). Such a name IS a local — <see cref="IsLocal"/> is true, so it still shadows a
/// member — but contributes no entry to <see cref="ActiveBindings"/>, leaving the resolver to infer
/// rather than handing it a type nobody knows. Crucially the null still shadows: it must not let an
/// outer binding's type leak into the inner scope.</para>
///
/// <para>Shared by every code emitter's <c>*ExpressionTranslator</c> (Rust, TypeScript, Python, PHP,
/// Java, Kotlin), following the precedent <see cref="BranchReconciliation"/> and
/// <c>OperatorNeedsAnalyzer</c> set in <c>Koine.Emit.Common</c>: the emitter-agnostic bookkeeping lives
/// here and is unit-tested once, instead of being hand-rolled — and independently mis-implemented — per
/// target.</para>
/// </summary>
internal sealed class LocalScopeStack
{
    private readonly Dictionary<string, Stack<TypeRef?>> _stacks = new(StringComparer.Ordinal);

    /// <summary>
    /// Binds <paramref name="name"/> as a local at <paramref name="type"/>, STACKING on top of any
    /// binding that name already has rather than replacing it, so the matching <see cref="PopLocal"/>
    /// can restore it. Pass no <paramref name="type"/> when the binding's type doesn't resolve (see the
    /// class remarks) — the name still shadows, it just contributes no type overlay.
    /// </summary>
    public void PushLocal(string name, TypeRef? type = null)
    {
        if (!_stacks.TryGetValue(name, out Stack<TypeRef?>? stack))
        {
            stack = new Stack<TypeRef?>();
            _stacks[name] = stack;
        }

        stack.Push(type);
    }

    /// <summary>
    /// Unbinds <paramref name="name"/>'s INNERMOST binding, restoring whatever it shadowed — or absence,
    /// if it shadowed nothing. Popping a name that isn't bound is a no-op (translators unwind
    /// defensively).
    /// </summary>
    public void PopLocal(string name)
    {
        if (!_stacks.TryGetValue(name, out Stack<TypeRef?>? stack) || stack.Count == 0)
        {
            return;
        }

        stack.Pop();
        if (stack.Count == 0)
        {
            _stacks.Remove(name);
        }
    }

    /// <summary>
    /// True while <paramref name="name"/> has at least one active binding — i.e. it is currently a local
    /// and therefore SHADOWS any same-named member or enum.
    /// </summary>
    public bool IsLocal(string name) => _stacks.ContainsKey(name);

    /// <summary>
    /// The innermost binding's <see cref="TypeRef"/> for <paramref name="name"/>, or
    /// <see langword="null"/> when it isn't bound OR its innermost binding carries no known type.
    /// </summary>
    public TypeRef? TypeOf(string name) =>
        _stacks.TryGetValue(name, out Stack<TypeRef?>? stack) && stack.Count > 0 ? stack.Peek() : null;

    /// <summary>
    /// The currently-bound names at their innermost known type — the overlay a translator layers onto its
    /// member <c>TypeScope</c>. Names whose innermost binding has no known type are omitted (there is no
    /// type to overlay), NOT reported at an outer binding's type.
    /// </summary>
    public IEnumerable<KeyValuePair<string, TypeRef>> ActiveBindings
    {
        get
        {
            foreach (KeyValuePair<string, Stack<TypeRef?>> kv in _stacks)
            {
                if (kv.Value.Count > 0 && kv.Value.Peek() is { } type)
                {
                    yield return new KeyValuePair<string, TypeRef>(kv.Key, type);
                }
            }
        }
    }
}
