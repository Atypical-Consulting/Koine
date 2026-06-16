using System.Reflection;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// R16.4 conformance guard: the semantic model (<c>Koine.Compiler.Ast</c>) must stay
/// TARGET-AGNOSTIC — no type in it may reference any emitter type
/// (<c>Koine.Compiler.Emit.*</c>). This is what lets multiple backends (C#, TypeScript, …)
/// project from the same model. A violation here means a target concept has leaked into the AST.
/// </summary>
public class AstPurityTests
{
    private const string AstNamespace = "Koine.Compiler.Ast";
    private const string EmitNamespace = "Koine.Compiler.Emit";

    [Fact]
    public void Ast_types_do_not_reference_any_emitter_type()
    {
        Assembly compiler = typeof(KoineNode).Assembly;

        var astTypes = compiler.GetTypes()
            .Where(t => (t.Namespace ?? string.Empty).StartsWith(AstNamespace, StringComparison.Ordinal))
            .ToList();
        Assert.NotEmpty(astTypes); // sanity: we actually found the AST

        var violations = new List<string>();
        foreach (Type t in astTypes)
        {
            foreach (Type referenced in ReferencedTypes(t))
            {
                if (IsEmitType(referenced))
                {
                    violations.Add($"{t.FullName} references {referenced.FullName}");
                }
            }
        }

        Assert.True(violations.Count == 0,
            "AST must not reference emitter types:\n" + string.Join("\n", violations.Distinct()));
    }

    /// <summary>
    /// Sanity-check the guard itself: a type that DOES reference an emitter type is detected,
    /// so the test above is a real check rather than a vacuous pass.
    /// </summary>
    [Fact]
    public void Guard_detects_an_emitter_reference()
    {
        Type probe = typeof(EmitReferencingProbe);
        Assert.Contains(ReferencedTypes(probe), IsEmitType);
    }

    private static bool IsEmitType(Type t) =>
        (t.Namespace ?? string.Empty).StartsWith(EmitNamespace, StringComparison.Ordinal);

    /// <summary>Every type a declaration touches: base, interfaces, field/property/method signatures, and their generic args.</summary>
    private static IEnumerable<Type> ReferencedTypes(Type t)
    {
        const BindingFlags All = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
        var seen = new HashSet<Type>();

        if (t.BaseType is { } b) { foreach (var x in Expand(b, seen)) yield return x; }
        foreach (Type i in t.GetInterfaces()) { foreach (var x in Expand(i, seen)) yield return x; }

        foreach (FieldInfo f in Safe(() => t.GetFields(All)))
            foreach (var x in Expand(f.FieldType, seen)) yield return x;

        foreach (PropertyInfo p in Safe(() => t.GetProperties(All)))
            foreach (var x in Expand(p.PropertyType, seen)) yield return x;

        foreach (MethodInfo m in Safe(() => t.GetMethods(All)))
        {
            foreach (var x in Expand(m.ReturnType, seen)) yield return x;
            foreach (ParameterInfo prm in m.GetParameters())
                foreach (var x in Expand(prm.ParameterType, seen)) yield return x;
        }
    }

    private static IEnumerable<Type> Expand(Type t, HashSet<Type> seen)
    {
        if (t.IsByRef || t.IsPointer) { t = t.GetElementType()!; }
        if (t.IsArray) { t = t.GetElementType()!; }
        if (!seen.Add(t)) { yield break; }

        yield return t;
        if (t.IsGenericType)
        {
            foreach (Type arg in t.GetGenericArguments())
                foreach (var x in Expand(arg, seen)) yield return x;
        }
    }

    private static T[] Safe<T>(Func<T[]> get)
    {
        try { return get(); } catch { return Array.Empty<T>(); }
    }

    /// <summary>A deliberate negative fixture for <see cref="Guard_detects_an_emitter_reference"/> — NOT in the Ast namespace.</summary>
    private sealed class EmitReferencingProbe
    {
        public Koine.Compiler.Emit.EmittedFile? Leak { get; init; }
    }
}
