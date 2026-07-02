using System.Text;
using System.Text.RegularExpressions;
using Koine.Compiler.Ast;

namespace Koine.Compiler;

/// <summary>
/// State-machine slice of <see cref="DocsEmitter"/>: renders each entity state machine as a Mermaid
/// <c>stateDiagram-v2</c> followed by a transition table. The initial state is detected from the bound
/// field's <see cref="Member.Initializer"/> (a bare enum-member identifier), never guessed; terminal
/// states (no outgoing rules) get a <c>--&gt; [*]</c> edge; per-rule guards render as edge labels.
/// </summary>
public sealed partial class DocsEmitter
{
    /// <summary>Writes a Mermaid diagram + transition table for every state machine on the entity.</summary>
    private static void EmitStateMachines(StringBuilder sb, EntityDecl entity)
    {
        foreach (StatesDecl states in entity.States)
        {
            sb.Append("\n```mermaid\n");
            EmitStateDiagram(sb, entity, states);
            sb.Append("```\n");

            EmitTransitionTable(sb, states);
        }
    }

    /// <summary>Emits the <c>stateDiagram-v2</c> body: initial arrow, transitions (with guards), terminals.</summary>
    private static void EmitStateDiagram(StringBuilder sb, EntityDecl entity, StatesDecl states)
    {
        sb.Append("stateDiagram-v2\n");

        // Initial state: read the bound field's initializer; only a bare identifier (enum member)
        // yields a [*] arrow — anything else is omitted rather than guessed.
        if (DetectInitialState(entity, states.Field) is IdentifierExpr { Name: var initial })
        {
            sb.Append("    [*] --> ").Append(Sanitize(initial)).Append('\n');
        }

        foreach (StateRule rule in states.Rules)
        {
            var from = Sanitize(rule.From);
            if (rule.To.Count == 0)
            {
                // A state with no outgoing transitions is terminal.
                sb.Append("    ").Append(from).Append(" --> [*]\n");
                continue;
            }

            var guard = rule.Guard is not null ? SanitizeLabel(Describe(rule.Guard)) : null;
            foreach (string to in rule.To)
            {
                sb.Append("    ").Append(from).Append(" --> ").Append(Sanitize(to));
                if (guard is not null)
                {
                    sb.Append(": when ").Append(guard);
                }

                sb.Append('\n');
            }
        }
    }

    /// <summary>Emits a Markdown transition table (From | To | Guard) in declaration order.</summary>
    private static void EmitTransitionTable(StringBuilder sb, StatesDecl states)
    {
        sb.Append("\n| From | To | Guard |\n| --- | --- | --- |\n");
        foreach (StateRule rule in states.Rules)
        {
            if (rule.To.Count == 0)
            {
                sb.Append("| `").Append(rule.From).Append("` | _(terminal)_ | |\n");
                continue;
            }

            var guard = rule.Guard is not null ? "`" + Prose(Describe(rule.Guard)) + "`" : string.Empty;
            foreach (string to in rule.To)
            {
                sb.Append("| `").Append(rule.From).Append("` | `").Append(to).Append("` | ")
                  .Append(guard).Append(" |\n");
            }
        }
    }

    /// <summary>The initializer of the member bound to the state field, or <c>null</c> when none.</summary>
    private static Expr? DetectInitialState(EntityDecl entity, string stateField) =>
        entity.Members.FirstOrDefault(m => m.Name == stateField)?.Initializer;

    /// <summary>Sanitizes a state name to a Mermaid-safe token (alphanumeric + underscore).</summary>
    private static string Sanitize(string state)
    {
        var cleaned = Regex.Replace(state.Replace(' ', '_').Replace('-', '_'), @"[^\w]", string.Empty);
        return cleaned.Length == 0 ? "State" : cleaned;
    }

    /// <summary>
    /// Escapes a guard expression for use as a <c>stateDiagram-v2</c> transition label. Mermaid renders
    /// these labels as HTML, so the comparison/logical operators in a guard (<c>&lt;</c>, <c>&gt;</c>,
    /// <c>&amp;</c>) would be parsed as markup and corrupt or break the diagram. Replacing them with HTML
    /// entities keeps the operators visible and the diagram valid. The transition TABLE renders the same
    /// guard inside backticks (Markdown code), so it needs no escaping.
    /// </summary>
    private static string SanitizeLabel(string guard) =>
        guard.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");
}
