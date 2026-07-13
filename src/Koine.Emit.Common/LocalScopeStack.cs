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
    /// <summary>
    /// One binding on a name's shadow stack: its <see cref="TypeRef"/> (see <see cref="PushLocal"/>) and,
    /// optionally, the identifier it RENDERS as in the target source — distinct from the Koine name a
    /// caller looks it up by when a target's lowering must alpha-rename a colliding binding (Java; #1536).
    /// A binding with no rendered name (every target but Java, today) reports its own Koine name from
    /// <see cref="RenderedNameOf"/>.
    /// </summary>
    private readonly record struct Binding(TypeRef? Type, string? RenderedName);

    private readonly Dictionary<string, Stack<Binding>> _stacks = new(StringComparer.Ordinal);

    /// <summary>
    /// Binds <paramref name="name"/> as a local at <paramref name="type"/>, STACKING on top of any
    /// binding that name already has rather than replacing it, so the matching <see cref="PopLocal"/>
    /// can restore it. Pass no <paramref name="type"/> when the binding's type doesn't resolve (see the
    /// class remarks) — the name still shadows, it just contributes no type overlay. Pass
    /// <paramref name="renderedName"/> when the target must spell this binding differently from
    /// <paramref name="name"/> in the emitted source (see <see cref="RenderedNameOf"/>); omit it to have
    /// <see cref="RenderedNameOf"/> fall back to <paramref name="name"/> itself.
    /// </summary>
    public void PushLocal(string name, TypeRef? type = null, string? renderedName = null)
    {
        if (!_stacks.TryGetValue(name, out Stack<Binding>? stack))
        {
            stack = new Stack<Binding>();
            _stacks[name] = stack;
        }

        stack.Push(new Binding(type, renderedName));
    }

    /// <summary>
    /// Unbinds <paramref name="name"/>'s INNERMOST binding, restoring whatever it shadowed — or absence,
    /// if it shadowed nothing. Popping a name that isn't bound is a no-op (translators unwind
    /// defensively).
    /// <para>
    /// <b>Pops exactly one level.</b> Callers must pop as many times as they pushed. In particular the
    /// "pop the command parameters so a same-named one cannot shadow the member a guard must read" idiom
    /// (each emitter's <c>BuildStateMachineConditions</c>) assumes the popped name is bound exactly once
    /// — true on the command path, which pushes only the command's own parameters. Do not reach for it
    /// from a path that has pushed a name twice (the factory path pushes <c>id</c> alongside the factory
    /// parameters): a single pop would leave the outer binding live rather than exposing the member.
    /// </para>
    /// </summary>
    public void PopLocal(string name)
    {
        if (!_stacks.TryGetValue(name, out Stack<Binding>? stack) || stack.Count == 0)
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
        _stacks.TryGetValue(name, out Stack<Binding>? stack) && stack.Count > 0 ? stack.Peek().Type : null;

    /// <summary>
    /// The innermost binding's rendered identifier for <paramref name="name"/> — the string a target
    /// should emit for a reference to this local — or <paramref name="name"/> itself when it isn't bound,
    /// or its innermost binding was pushed with no <c>renderedName</c> (see <see cref="PushLocal"/>).
    /// </summary>
    public string RenderedNameOf(string name) =>
        _stacks.TryGetValue(name, out Stack<Binding>? stack) && stack.Count > 0
            && stack.Peek().RenderedName is { } rendered
            ? rendered
            : name;

    /// <summary>
    /// True when <paramref name="renderedName"/> is the innermost rendered identifier of SOME currently
    /// active binding (any name, not just <paramref name="renderedName"/>'s own Koine name). A target that
    /// alpha-renames a colliding binding (Java; #1536) needs this to pick a fresh identifier that collides
    /// with none of the OTHER locals — including a shadowed OUTER binding of the very name it is
    /// renaming — that are still lexically enclosing at the point of the new binding.
    /// </summary>
    public bool IsRenderedNameInUse(string renderedName)
    {
        foreach (Stack<Binding> stack in _stacks.Values)
        {
            if (stack.Count > 0 && stack.Peek().RenderedName == renderedName)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Layers the currently-bound names, at their innermost known type, over <paramref name="memberScope"/>
    /// — the effective scope a translator resolves an expression in, where a local shadows a same-named
    /// member. Names whose innermost binding has no known type are skipped (there is no type to overlay),
    /// NOT reported at an outer binding's type.
    /// <para>
    /// This is every translator's <c>EffectiveScope()</c>, which each one wrote out identically and calls
    /// on essentially every <c>Infer</c> — so it lives here, iterating the stacks directly rather than
    /// through an allocating <c>IEnumerable</c> on that hot path.
    /// </para>
    /// </summary>
    public TypeScope Overlay(TypeScope memberScope, ModelIndex index)
    {
        TypeScope scope = memberScope;
        foreach (KeyValuePair<string, Stack<Binding>> kv in _stacks)
        {
            if (kv.Value.Count > 0 && kv.Value.Peek().Type is { } type)
            {
                scope = scope.WithRef(kv.Key, type, index);
            }
        }

        return scope;
    }

    /// <summary>
    /// The currently-bound names at their innermost known type. Exposed for tests and for a caller that
    /// needs the bindings themselves rather than a <see cref="TypeScope"/> overlay (<see cref="Overlay"/>
    /// is the hot path).
    /// </summary>
    public IEnumerable<KeyValuePair<string, TypeRef>> ActiveBindings
    {
        get
        {
            foreach (KeyValuePair<string, Stack<Binding>> kv in _stacks)
            {
                if (kv.Value.Count > 0 && kv.Value.Peek().Type is { } type)
                {
                    yield return new KeyValuePair<string, TypeRef>(kv.Key, type);
                }
            }
        }
    }
}
