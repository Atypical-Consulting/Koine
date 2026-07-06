using System.Reflection;
using Koine.Compiler.Diagnostics;

namespace Koine.Compiler.Tests;

/// <summary>
/// Locks the <see cref="DiagnosticCodes.Catalogue"/> descriptor table: every code constant has
/// exactly one descriptor, descriptors are well-formed, and each descriptor's
/// <see cref="DiagnosticDescriptor.DefaultSeverity"/> matches the severity the code is raised with
/// today (the regression lock — see the Warning set below).
/// </summary>
public class DiagnosticDescriptorTests
{
    private static List<string> AllCodeConstants() =>
        typeof(DiagnosticCodes)
            .GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(f => f is { IsLiteral: true, IsInitOnly: false } && f.FieldType == typeof(string))
            .Select(f => (string)f.GetRawConstantValue()!)
            .ToList();

    /// <summary>
    /// The set of codes raised today via <c>Diagnostic.Warning(...)</c>. Everything else is raised
    /// as an Error (or is catalogue-only — the KOI15xx versioning codes surface as breaking
    /// <c>CompatibilityChange</c>s, never as <c>Diagnostic.Warning</c>, so they default to Error).
    /// </summary>
    private static readonly string[] WarningCodes =
    {
        DiagnosticCodes.ContradictoryInvariant,        // SatisfiabilityChecker.cs:58
        DiagnosticCodes.InvertedBound,                 // SatisfiabilityChecker.cs:79
        DiagnosticCodes.UnsatisfiableInvariantPair,    // SatisfiabilityChecker.cs:81
        DiagnosticCodes.BoundOutsideConstraint,        // SatisfiabilityChecker.cs:109
        DiagnosticCodes.UninitializedFactoryField,     // EntityBehaviorValidator.cs:290
        DiagnosticCodes.AclDirectUpstreamReference,    // SemanticValidator.cs:226
        DiagnosticCodes.AnnotationVersionAboveContext, // SemanticValidator.cs:86,96
        DiagnosticCodes.AggregateNameMatchesRoot,      // SemanticValidator.cs (AggregateDecl case)
        DiagnosticCodes.AmbiguousMultiOwnerReference,  // CrossContextTypeValidator.cs
    };

    [Fact]
    public void Every_code_constant_has_exactly_one_descriptor()
    {
        var constants = AllCodeConstants();

        constants.ShouldAllBe(c => DiagnosticCodes.Catalogue.ContainsKey(c));
        DiagnosticCodes.Catalogue.Count.ShouldBe(constants.Count); // no stray descriptors
    }

    [Fact]
    public void Descriptor_ids_are_unique_and_equal_their_dictionary_key()
    {
        foreach (var (key, descriptor) in DiagnosticCodes.Catalogue)
        {
            descriptor.Id.ShouldBe(key);
        }

        var ids = DiagnosticCodes.Catalogue.Values.Select(d => d.Id).ToList();
        ids.Distinct().Count().ShouldBe(ids.Count);
    }

    [Fact]
    public void Every_descriptor_has_a_non_empty_title_and_message_format()
    {
        foreach (var descriptor in DiagnosticCodes.Catalogue.Values)
        {
            descriptor.Title.ShouldNotBeNullOrWhiteSpace();
            descriptor.MessageFormat.ShouldNotBeNullOrWhiteSpace();
        }
    }

    [Fact]
    public void Warning_codes_default_to_Warning_severity()
    {
        foreach (var code in WarningCodes)
        {
            DiagnosticCodes.Catalogue[code].DefaultSeverity.ShouldBe(DiagnosticSeverity.Warning);
        }
    }

    [Fact]
    public void All_other_codes_default_to_Error_severity()
    {
        var warningSet = WarningCodes.ToHashSet();

        foreach (var (code, descriptor) in DiagnosticCodes.Catalogue)
        {
            if (warningSet.Contains(code))
            {
                continue;
            }

            descriptor.DefaultSeverity.ShouldBe(
                DiagnosticSeverity.Error,
                $"{code} is not in the known Warning set and must default to Error.");
        }
    }
}
