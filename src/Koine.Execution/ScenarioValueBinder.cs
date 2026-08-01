using System.Collections;
using System.Globalization;
using System.Reflection;
using Koine.Compiler.Ast;
using Koine.Compiler.Semantics.Scenarios;

namespace Koine.Execution;

/// <summary>
/// The value bridge between a scenario and the emitted assembly (issue #236, Approach A): it converts a
/// target-agnostic <see cref="ScenarioValue"/> into a REAL CLR value built through the generated
/// constructors/factories, and converts a CLR value back into the display string the
/// <see cref="ScenarioResult"/> contract carries.
/// <para>Kept separate from <see cref="ScenarioExecutor"/> so the conversion rules are unit-testable on
/// their own. Every number is formatted with <see cref="CultureInfo.InvariantCulture"/> — a scenario
/// timeline must read the same on every machine.</para>
/// </summary>
internal sealed class ScenarioValueBinder
{
    /// <summary>Rendering for a value that is absent (a <c>T?</c> with no value / a CLR <c>null</c>).</summary>
    private const string AbsentDisplay = "∅";

    /// <summary>Guards the recursive walks against a cyclic object graph or a pathological nesting depth.</summary>
    private const int MaxDepth = 16;

    private readonly ModelIndex _index;

    internal ScenarioValueBinder(ModelIndex index) => _index = index;

    // ------------------------------------------------------------------------
    // ScenarioValue -> CLR
    // ------------------------------------------------------------------------

    /// <summary>
    /// Binds <paramref name="value"/> to a CLR instance assignable to <paramref name="target"/>, going
    /// through the emitted type's own constructor so its invariants really run. Returns <c>false</c> with
    /// a human-readable <paramref name="error"/> rather than guessing — a value the runner cannot drive
    /// must surface as a note, never as a fabricated result.
    /// </summary>
    /// <remarks>A <see cref="DomainInvariantViolationException"/> thrown by an emitted constructor is
    /// NOT caught here: it is a domain outcome the caller classifies, not a binding failure.</remarks>
    public bool TryBind(ScenarioValue value, Type target, out object? bound, out string? error) =>
        TryBindCore(value, target, 0, out bound, out error);

    private bool TryBindCore(ScenarioValue value, Type target, int depth, out object? bound, out string? error)
    {
        bound = null;
        error = null;

        if (depth > MaxDepth)
        {
            error = $"value nesting exceeded {MaxDepth} levels";
            return false;
        }

        Type underlying = Nullable.GetUnderlyingType(target) ?? target;

        switch (value)
        {
            case ScenarioValue.Absent:
                if (target.IsValueType && Nullable.GetUnderlyingType(target) is null)
                {
                    error = $"cannot bind an absent value to the non-nullable '{Describe(target)}'";
                    return false;
                }

                return true; // null

            case ScenarioValue.Unknown unknown:
                error = $"indeterminate value ({unknown.Reason})";
                return false;

            case ScenarioValue.Bool b when underlying == typeof(bool):
                bound = b.Value;
                return true;

            case ScenarioValue.Num num:
                if (TryBindNumber(num, underlying, out bound))
                {
                    return true;
                }

                return TryBindThroughSingleArgConstructor(value, underlying, depth, out bound, out error);

            case ScenarioValue.Text text:
                if (TryBindText(text.Value, underlying, out bound))
                {
                    return true;
                }

                return TryBindThroughSingleArgConstructor(value, underlying, depth, out bound, out error);

            case ScenarioValue.EnumMember member:
                if (TryBindNamedMember(member.Member, underlying, out bound))
                {
                    return true;
                }

                error = $"'{member.Member}' is not a member of '{Describe(underlying)}'";
                return false;

            case ScenarioValue.Instant:
                if (underlying == typeof(DateTimeOffset))
                {
                    bound = DateTimeOffset.UtcNow;
                    return true;
                }

                if (underlying == typeof(DateTime))
                {
                    bound = DateTime.UtcNow;
                    return true;
                }

                error = $"cannot bind the `now` marker to '{Describe(underlying)}'";
                return false;

            case ScenarioValue.List list:
                return TryBindList(list, underlying, depth, out bound, out error);

            case ScenarioValue.Record record:
                return TryBindRecord(record, underlying, depth, out bound, out error);
        }

        error = $"cannot bind {value.GetType().Name.ToLowerInvariant()} value '{value.Display()}' to '{Describe(target)}'";
        return false;
    }

    /// <summary>The numeric CLR types a <see cref="ScenarioValue.Num"/> converts into directly.</summary>
    private static bool TryBindNumber(ScenarioValue.Num num, Type target, out object? bound)
    {
        bound = null;
        if (target == typeof(decimal)) { bound = num.Value; return true; }

        try
        {
            if (target == typeof(int)) { bound = decimal.ToInt32(num.Value); return true; }
            if (target == typeof(long)) { bound = decimal.ToInt64(num.Value); return true; }
            if (target == typeof(short)) { bound = decimal.ToInt16(num.Value); return true; }
            if (target == typeof(byte)) { bound = decimal.ToByte(num.Value); return true; }
            if (target == typeof(sbyte)) { bound = decimal.ToSByte(num.Value); return true; }
            if (target == typeof(uint)) { bound = decimal.ToUInt32(num.Value); return true; }
            if (target == typeof(ulong)) { bound = decimal.ToUInt64(num.Value); return true; }
            if (target == typeof(ushort)) { bound = decimal.ToUInt16(num.Value); return true; }
            if (target == typeof(double)) { bound = decimal.ToDouble(num.Value); return true; }
            if (target == typeof(float)) { bound = decimal.ToSingle(num.Value); return true; }
        }
        catch (OverflowException)
        {
            return false;
        }

        return false;
    }

    /// <summary>A string binds to a string, a parsed <c>Guid</c>/instant, an enum member, or (through the
    /// caller) a single-field wrapper such as a generated identity value object.</summary>
    private static bool TryBindText(string text, Type target, out object? bound)
    {
        bound = null;

        if (target == typeof(string)) { bound = text; return true; }
        if (target == typeof(char) && text.Length == 1) { bound = text[0]; return true; }

        if (target == typeof(Guid))
        {
            if (!Guid.TryParse(text, out Guid guid))
            {
                return false;
            }

            bound = guid;
            return true;
        }

        if (target == typeof(DateTimeOffset))
        {
            if (!DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset stamp))
            {
                return false;
            }

            bound = stamp;
            return true;
        }

        if (target == typeof(DateTime))
        {
            if (!DateTime.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTime stamp))
            {
                return false;
            }

            bound = stamp;
            return true;
        }

        return TryBindNamedMember(text, target, out bound);
    }

    /// <summary>
    /// Binds a member NAME to an enum member: a CLR <c>enum</c> member for a bare-name Koine enum, or the
    /// static singleton field of a generated smart enum (an enum with associated data, emitted as a class).
    /// </summary>
    private static bool TryBindNamedMember(string name, Type target, out object? bound)
    {
        bound = null;

        if (target.IsEnum)
        {
            if (!Enum.TryParse(target, name, ignoreCase: false, out object? parsed))
            {
                return false;
            }

            bound = parsed;
            return true;
        }

        FieldInfo? field = target
            .GetFields(BindingFlags.Public | BindingFlags.Static)
            .FirstOrDefault(f => f.FieldType == target && string.Equals(f.Name, name, StringComparison.Ordinal));
        if (field is not null)
        {
            bound = field.GetValue(null);
            return true;
        }

        PropertyInfo? property = target
            .GetProperties(BindingFlags.Public | BindingFlags.Static)
            .FirstOrDefault(p => p.PropertyType == target && string.Equals(p.Name, name, StringComparison.Ordinal));
        if (property is not null)
        {
            bound = property.GetValue(null);
            return true;
        }

        return false;
    }

    /// <summary>A scalar binding to a generated single-field wrapper (an identity value object, a
    /// one-field value): recurse into the wrapper's single constructor parameter so the wrapper's own
    /// validation really runs.</summary>
    private bool TryBindThroughSingleArgConstructor(
        ScenarioValue value, Type target, int depth, out object? bound, out string? error)
    {
        bound = null;
        error = null;

        ConstructorInfo? ctor = target
            .GetConstructors(BindingFlags.Public | BindingFlags.Instance)
            .FirstOrDefault(c => c.GetParameters().Length == 1);
        if (ctor is null)
        {
            error = $"cannot bind '{value.Display()}' to '{Describe(target)}'";
            return false;
        }

        if (!TryBindCore(value, ctor.GetParameters()[0].ParameterType, depth + 1, out object? inner, out error))
        {
            return false;
        }

        bound = ctor.Invoke([inner]);
        return true;
    }

    private bool TryBindList(ScenarioValue.List list, Type target, int depth, out object? bound, out string? error)
    {
        bound = null;
        error = null;

        Type? element = ElementTypeOf(target);
        if (element is null)
        {
            error = $"'{Describe(target)}' is not a collection the runner can populate";
            return false;
        }

        var typed = (IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(element))!;
        foreach (ScenarioValue item in list.Items)
        {
            if (!TryBindCore(item, element, depth + 1, out object? boundItem, out error))
            {
                return false;
            }

            typed.Add(boundItem);
        }

        if (!target.IsInstanceOfType(typed) && target != typeof(object))
        {
            // e.g. an array-typed parameter: the emitted code uses IReadOnlyList<T>/List<T>, but stay honest
            // rather than silently handing over a shape the member cannot accept.
            if (!target.IsArray)
            {
                error = $"cannot bind a list to '{Describe(target)}'";
                return false;
            }

            Array array = Array.CreateInstance(element, typed.Count);
            typed.CopyTo(array, 0);
            bound = array;
            return true;
        }

        bound = typed;
        return true;
    }

    /// <summary>The element type of a collection-shaped target (<c>T[]</c>, <c>List&lt;T&gt;</c>,
    /// <c>IReadOnlyList&lt;T&gt;</c>, <c>IEnumerable&lt;T&gt;</c>, …), or <c>null</c>.</summary>
    private static Type? ElementTypeOf(Type target)
    {
        if (target.IsArray)
        {
            return target.GetElementType();
        }

        if (target.IsGenericType && target.GetGenericArguments().Length == 1)
        {
            return target.GetGenericArguments()[0];
        }

        return target.GetInterfaces()
            .FirstOrDefault(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IEnumerable<>))
            ?.GetGenericArguments()[0];
    }

    /// <summary>
    /// Builds a composite (a value object / nested record) through the generated type's widest PUBLIC
    /// constructor, matching each parameter to a record field by name. Going through the constructor is
    /// the point: that is where the emitted invariants live (issue #236, gap #2).
    /// </summary>
    private bool TryBindRecord(ScenarioValue.Record record, Type target, int depth, out object? bound, out string? error)
    {
        bound = null;
        error = null;

        ConstructorInfo? ctor = target
            .GetConstructors(BindingFlags.Public | BindingFlags.Instance)
            .OrderByDescending(c => c.GetParameters().Length)
            .FirstOrDefault(c => c.GetParameters().Length > 0);
        if (ctor is null)
        {
            error = $"'{Describe(target)}' has no public constructor to build a composite value with";
            return false;
        }

        ParameterInfo[] parameters = ctor.GetParameters();
        var args = new object?[parameters.Length];
        for (int i = 0; i < parameters.Length; i++)
        {
            ParameterInfo p = parameters[i];
            ScenarioValue? field = record.Fields
                .FirstOrDefault(f => string.Equals(f.Key, p.Name, StringComparison.OrdinalIgnoreCase)).Value;

            if (field is null)
            {
                if (p.HasDefaultValue)
                {
                    args[i] = p.DefaultValue;
                    continue;
                }

                error = $"no value for '{p.Name}' when building '{Describe(target)}'";
                return false;
            }

            if (!TryBindCore(field, p.ParameterType, depth + 1, out args[i], out error))
            {
                return false;
            }
        }

        bound = ctor.Invoke(args);
        return true;
    }

    // ------------------------------------------------------------------------
    // CLR -> display
    // ------------------------------------------------------------------------

    /// <summary>
    /// Renders a CLR value the way <see cref="ScenarioValue.Display"/> renders its model-level twin, so the
    /// same timeline UI reads either runner's output: numbers in the invariant culture, <c>true</c>/
    /// <c>false</c>, an enum by member name, <c>[a, b]</c> for a collection, <c>{field: value}</c> for a
    /// composite (using the KOINE field names, not the emitted PascalCase ones), and <c>∅</c> for null.
    /// </summary>
    public string Display(object? value) => DisplayCore(value, 0);

    private string DisplayCore(object? value, int depth)
    {
        if (value is null)
        {
            return AbsentDisplay;
        }

        if (depth > MaxDepth)
        {
            return "…";
        }

        switch (value)
        {
            case bool b:
                return b ? "true" : "false";
            case string s:
                return s;
            case char c:
                return c.ToString();
            case Enum e:
                return e.ToString();
            case decimal d:
                return d.ToString(CultureInfo.InvariantCulture);
            case double or float or int or long or short or byte or sbyte or uint or ulong or ushort:
                return Convert.ToString(value, CultureInfo.InvariantCulture) ?? "?";
            case Guid g:
                return g.ToString();
            case DateTimeOffset dto:
                return dto.ToString("O", CultureInfo.InvariantCulture);
            case DateTime dt:
                return dt.ToString("O", CultureInfo.InvariantCulture);
            case TimeSpan ts:
                return ts.ToString(null, CultureInfo.InvariantCulture);
        }

        Type type = value.GetType();

        if (value is IEnumerable sequence)
        {
            return "[" + string.Join(", ", sequence.Cast<object?>().Select(i => DisplayCore(i, depth + 1))) + "]";
        }

        if (_index.TryGetDecl(type.Name, out TypeDecl decl))
        {
            // A smart enum (an enum with associated data) is emitted as a class; its ToString() is the
            // member name, which is exactly what ScenarioValue.EnumMember displays.
            if (decl is EnumDecl)
            {
                return value.ToString() ?? "?";
            }

            IReadOnlyList<Member>? members = decl switch
            {
                ValueObjectDecl vo => vo.Members,
                EventDecl ev => ev.Members,
                IntegrationEventDecl ie => ie.Members,
                EntityDecl entity => entity.Members,
                _ => null
            };

            if (members is not null && members.Count > 0)
            {
                var names = members.Select(m => m.Name).ToHashSet(StringComparer.Ordinal);
                IEnumerable<Member> stored = members.Where(m => !MemberAnalysis.IsDerived(m, names));
                return "{" + string.Join(", ", stored.Select(m =>
                    $"{m.Name}: {DisplayCore(ReadProperty(value, Pascal(m.Name)), depth + 1)}")) + "}";
            }
        }

        // A generated single-field wrapper (an identity value object) has no declaration of its own:
        // render the value it wraps rather than a useless type name.
        PropertyInfo[] readable = type
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.CanRead && p.GetIndexParameters().Length == 0)
            .ToArray();
        if (readable.Length == 1)
        {
            return DisplayCore(ReadProperty(value, readable[0].Name), depth + 1);
        }

        return value.ToString() ?? "?";
    }

    /// <summary>Reads a public instance property, returning <c>null</c> when it is absent. A getter that
    /// THROWS (a derived member whose own invariant rejects the current state) is rethrown for the caller
    /// to classify.</summary>
    internal static object? ReadProperty(object instance, string name) =>
        instance.GetType()
            .GetProperty(name, BindingFlags.Public | BindingFlags.Instance)
            ?.GetValue(instance);

    /// <summary>The emitted PascalCase spelling of a Koine member/operation name.</summary>
    internal static string Pascal(string name) =>
        string.IsNullOrEmpty(name) || char.IsUpper(name[0])
            ? name
            : char.ToUpperInvariant(name[0]) + name[1..];

    /// <summary>A short, readable type name for a note (no assembly-qualified noise).</summary>
    internal static string Describe(Type type)
    {
        if (Nullable.GetUnderlyingType(type) is { } underlying)
        {
            return Describe(underlying) + "?";
        }

        if (!type.IsGenericType)
        {
            return type.Name;
        }

        string name = type.Name[..type.Name.IndexOf('`')];
        return $"{name}<{string.Join(", ", type.GetGenericArguments().Select(Describe))}>";
    }
}
