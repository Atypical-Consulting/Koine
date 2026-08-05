using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Koine.Compiler.Tests;

/// <summary>
/// <para>
/// The mechanical half of issue #1942: a containment primitive nobody is <i>required</i> to call is a
/// primitive someone will forget. <c>contained_path</c> (Rust) and
/// <see cref="Koine.Compiler.Extensions.ContainedPath.TryResolve"/> (.NET) exist so a
/// third-party-supplied path cannot leave the root it was promised to stay inside — but that only
/// holds for the sinks that actually route through them. Zed's two advisories are precisely what
/// per-call-site discipline looks like when it lapses: CVE-2026-27800 validated the destination
/// directory an extension passed in and then joined every ZIP entry name onto it unchecked, and
/// CVE-2026-27976 was the same omission one archive format over. Both were fixed in place, at the
/// site, which leaves the next new sink exactly as exposed as the last one was.
/// </para>
/// <para>
/// So this test makes the gate mechanical. It reads the two hosts' source and fails on a filesystem
/// path composed from an untrusted value without going through the primitive, naming the file, the
/// line and the offending text. Both hosts are covered because both carry ambient authority: the
/// Tauri host writes anywhere the user can, and the .NET compiler process does too.
/// </para>
/// <para>
/// <b>The three rules.</b>
/// <list type="number">
/// <item><description>
/// <b>Rust — every <c>.join(</c> outside the test module of
/// <c>tooling/koine-studio/src-tauri/src/lib.rs</c> must be allowlisted.</b> Deliberately blunt at
/// the file level rather than clever: the non-test half of that file contains exactly FOUR joins, so
/// "justify every one" costs a four-row table and catches a new sink whose parameter happens to be
/// named something this test's taint heuristic would not recognise. (The ~90 other <c>.join(</c>
/// hits in the file are all inside <c>mod tests</c>, where a join builds the fixture tree the
/// primitive is being tested against — gating those would be pure noise.)
/// </description></item>
/// <item><description>
/// <b>Rust — every <c>#[tauri::command]</c> declaring a caller-supplied relative-path parameter must
/// call <c>resolve_in</c>.</b> The taint rule is structural: a parameter whose name has a <c>rel</c>,
/// <c>rels</c>, <c>path</c> or <c>paths</c> segment (<c>rel_path</c>, <c>new_rel_path</c>,
/// <c>rel_paths</c>, <c>tracked_paths</c>, …) and whose type mentions <c>String</c>/<c>str</c>/
/// <c>Path</c>. That catches the shape of sink #1942 is about even when the composition is written
/// as something other than a <c>join</c> — a <c>PathBuf::push</c>, a <c>format!</c>, an
/// <c>OsString</c> concatenation — because the obligation is attached to the PARAMETER, not to the
/// operator applied to it.
/// </description></item>
/// <item><description>
/// <b>.NET — no <c>Path.Combine</c> / <c>Path.Join</c> / <c>Path.GetFullPath</c>, and no path built
/// by string concatenation or interpolation, anywhere under
/// <c>src/Koine.Compiler/Extensions/</c>.</b> That directory is the extension layer: everything in
/// it handles paths a third party chose. <c>ContainedPath.cs</c> is the one exempt file — it IS the
/// primitive, and composing paths is its job. This is where #1937's manifest validator, #1938's
/// template-pack emitter and #1941's installer will land, so the rule is in place before the code it
/// governs arrives.
/// </description></item>
/// </list>
/// </para>
/// <para>
/// <b>Why an allowlist, and why it is checked in both directions.</b> Every exception is a named row
/// carrying a written justification, so adding one is a reviewable act rather than a regex tweak
/// nobody sees in a diff. And an entry whose site has DISAPPEARED fails too
/// (<see cref="Every_rust_allowlist_entry_still_matches_a_real_site"/> /
/// <see cref="Every_dotnet_allowlist_entry_still_matches_a_real_site"/>): a table that only ever
/// grows stops being a list of considered exceptions and becomes a rubber stamp. Entries are anchored
/// on (enclosing function, text marker) rather than a line number, so reformatting the file above a
/// site does not manufacture a failure — the same reason the line-number-anchored
/// <see cref="FlatModelIndexLookupGuardTests"/> needs its own stale-entry check.
/// </para>
/// <para>
/// <b>What this does NOT catch.</b> It is a source scan, not a taint analysis. A tainted value
/// laundered through an intermediate local with an unremarkable name
/// (<c>let p = rel_path.clone(); root.join(p)</c>) is invisible to rule 2 — though rule 1 still
/// flags the join. A sink in a NEW Rust module is invisible to rules 1 and 2 entirely, which is why
/// <see cref="The_sibling_tauri_modules_still_have_no_filesystem_sink"/> pins the one fact the
/// #1942 audit rests on for the other two modules that exist today. And on the .NET side the scope
/// is the extension layer only: a plugin-supplied path that reaches a sink somewhere else in
/// <c>src/</c> is out of range, deliberately — widening it to all of <c>src/</c> would flag hundreds
/// of ordinary compiler joins over paths the USER passed on the command line, which are a different
/// trust class (the issue's own Non-goals say so).
/// </para>
/// <para>
/// <b>Why not <c>clippy.toml</c>, which the plan offered as the alternative.</b> Verified rather
/// than assumed: no workflow in <c>.github/workflows/</c> runs <c>cargo clippy</c> at all —
/// <c>studio-build.yml</c> runs <c>cargo build --locked</c> and <c>cargo test --locked</c>, and
/// <c>ci.yml</c>'s only cargo use is the Rust conformance suite's <c>cargo check</c>. A
/// <c>clippy.toml</c> would therefore be a dead file that gates nothing. Independently, clippy's
/// <c>disallowed-methods</c> is the wrong instrument: it keys on a method PATH, so banning
/// <c>Path::join</c> would fire on all ~90 legitimate joins in the file (fixture setup, internal
/// recursion, <c>current_exe()</c>-derived paths) with no way to say "except this one". The
/// counterpart to this test that DOES run on all three OSes is
/// <c>paths::tests::the_host_routes_every_plugin_influenced_path_through_the_primitive</c>, which
/// enforces rules 1 and 2 over <c>include_str!("lib.rs")</c> under <c>cargo test</c>. That twin is
/// not redundancy: <c>ci.yml</c>'s <c>changes</c> gate reports <c>dotnet=false</c> for a PR touching
/// only <c>tooling/koine-studio/**</c>, which skips both .NET jobs — so a Rust-only change to the
/// host is gated by the twin alone, and this test is what gates the two hosts' allowlists against
/// drifting apart.
/// </para>
/// </summary>
public class PathSinkGuardTests
{
    private const string RustHost = "tooling/koine-studio/src-tauri/src/lib.rs";
    private const string NetExtensionLayer = "src/Koine.Compiler/Extensions";

    /// <summary>The one .NET file allowed to compose paths with the raw BCL helpers: it is the primitive.</summary>
    private const string NetPrimitive = "ContainedPath.cs";

    private const string RawJoin = "raw-join";
    private const string UnroutedCommand = "unrouted-command";

    /// <summary>
    /// A parameter is caller-supplied-relative-path-shaped when one of its underscore-separated name
    /// segments is one of these. Segment-wise rather than substring, so <c>relay</c> (the collab
    /// broker's URL) is not swept in by the <c>rel</c> in its first three letters.
    /// </summary>
    private static readonly string[] PathParameterSegments = ["rel", "rels", "path", "paths"];

    private static readonly Regex RustFunctionDeclaration = new(
        @"^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+""[^""]*""\s+)?fn\s+([A-Za-z_]\w*)",
        RegexOptions.Compiled);

    /// <summary>Walks up from the test assembly to the directory containing <c>Koine.slnx</c>.</summary>
    /// <remarks>
    /// The same mechanism <see cref="ContainedPathTests"/> uses to locate the shared corpus and
    /// <see cref="FlatModelIndexLookupGuardTests"/> uses to locate <c>src/</c> — one way of finding
    /// the repo root, not a third invented one.
    /// </remarks>
    private static string RepoRoot()
    {
        for (DirectoryInfo? dir = new(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "Koine.slnx")))
            {
                return dir.FullName;
            }
        }

        throw new DirectoryNotFoundException(
            $"could not locate the repo root (a directory containing Koine.slnx) walking up from {AppContext.BaseDirectory}");
    }

    private static string AbsolutePath(string repoRelative)
        => Path.Combine(RepoRoot(), repoRelative.Replace('/', Path.DirectorySeparatorChar));

    // ------------------------------------------------------------------------------------------
    // The Tauri host
    // ------------------------------------------------------------------------------------------

    /// <summary>One place in the Rust host where a path could be composed from an untrusted value.</summary>
    private sealed record RustSite(int Line, string Kind, string Function, string Text)
    {
        public override string ToString() => $"{RustHost}:{Line} [{Kind}] in `{Function}` — {Text}";
    }

    /// <summary>
    /// Every allowlisted Rust site: the enclosing function, the rule it answers to, a text marker
    /// that must appear in the offending line (so the entry survives a reformat but still pins WHICH
    /// site is excused), and why it is safe.
    /// </summary>
    /// <remarks>
    /// These rows are the same set of sites the #1942 audit enumerated by hand
    /// (issue comment 5190620013). The audit is the prose; this table is the part that fails a build.
    /// </remarks>
    private static readonly (string Function, string Kind, string Marker, string Reason)[] RustAllowlist =
    [
        // --- Rule 1: joins that compose no caller-supplied string ---------------------------------
        ("bundled_koine_path", RawJoin, ".join(format!(\"koine{}\"",
            "joins a fixed executable name onto std::env::current_exe()'s directory — the host's own layout, no caller input reaches it"),
        ("git_clone", RawJoin, ".join(&dest_name)",
            "computes the RETURN value only (git itself created the directory, inside parent_dir), and dest_name is already reduced by clone_dest_name to one non-empty segment free of `/`, `\\` and `..`"),
        ("rename_entry", RawJoin, "parent.join(&new_name)",
            "new_name is screened by is_safe_name (a single separator-free segment, never `.`/`..`) and joined onto the token's OWN parent, so the result cannot leave the directory the entry already lives in"),
        ("copy_recursive", RawJoin, "dst.join(entry.file_name())",
            "an internal recursion helper: it joins a file_name() read off the SOURCE tree onto a destination whose root move_entry already resolved through resolve_in — no caller string reaches it"),

        // --- Rule 2: commands whose path parameter is not a contained relative path ---------------
        //
        // The issue's Non-goals draw this line explicitly: "the scope is paths a third party can
        // influence. User-chosen paths from the file dialog are a different trust class." These take
        // an ABSOLUTE path the user themselves picked in the OS dialog. There is no root to contain
        // them against — the user's choice IS the root — so routing them through resolve_in would
        // reject every legitimate call while protecting nothing.
        ("read_text_file", UnroutedCommand, "path: String",
            "an absolute path the user picked in the OS file dialog (or an explorer token minted from it), not a plugin-influenced relative path"),
        ("write_text_file", UnroutedCommand, "path: String",
            "same user-chosen absolute path as read_text_file — the save side of the same dialog"),
        ("write_bytes", UnroutedCommand, "path: String",
            "the absolute save-zip target the user chose in the OS dialog; write_text_file cannot carry binary"),

        // Every git_* command routes through run_git, which execs `git -C <dir> <args…>`. The
        // caller's strings are PATHSPECS handed to the git binary — git resolves them itself,
        // relative to the repo it was pointed at, and every mutating call is scoped by an explicit
        // `--`. The host never joins them onto anything, so there is no join for the primitive to
        // guard. (Containment of what git then touches is git's own `-C` scoping, not a path join.)
        ("git_diff", UnroutedCommand, "rel_path: String",
            "a pathspec passed to `git -C <dir> diff -- <pathspec>`, never joined onto a path by the host"),
        ("git_stage", UnroutedCommand, "rel_paths: Vec<String>",
            "pathspecs passed to `git -C <dir> add -- <pathspecs>`, never joined onto a path by the host"),
        ("git_unstage", UnroutedCommand, "rel_paths: Vec<String>",
            "pathspecs passed to `git -C <dir> restore --staged -- <pathspecs>`, never joined onto a path by the host"),
        ("git_discard", UnroutedCommand, "tracked_paths: Vec<String>",
            "pathspecs passed to git; the untracked_paths half is deleted through the same git plumbing, never a host-side join"),
        ("git_log", UnroutedCommand, "rel_path: Option<String>",
            "an optional pathspec narrowing `git -C <dir> log -- <pathspec>`, never joined onto a path by the host"),
    ];

    /// <summary>
    /// Blanks out string literals and strips a trailing line comment, so a <c>//</c> inside a string
    /// is not mistaken for a comment and a <c>.join(</c> inside a doc comment is not mistaken for
    /// code. Rust's <c>resolve_in</c> doc comment contains the literal text
    /// <c>folder.join(rel_path)</c> — as a warning against writing it — and a scan that flagged that
    /// would be teaching people to delete the warning.
    /// </summary>
    /// <remarks>
    /// Line-at-a-time and deliberately simple: it understands <c>"…"</c> with backslash escapes and
    /// <c>//</c>. A multi-line or raw (<c>r#"…"#</c>) string containing a stray quote could desync
    /// it; the host has none today, and the failure mode is a spurious report a human reads, not a
    /// silent miss of a real join.
    /// </remarks>
    private static string StripStringsAndComments(string line)
    {
        var result = new System.Text.StringBuilder(line.Length);
        bool inString = false;

        for (int i = 0; i < line.Length; i++)
        {
            char c = line[i];

            if (inString)
            {
                if (c == '\\' && i + 1 < line.Length)
                {
                    i++;
                    result.Append(' ');
                    result.Append(' ');
                    continue;
                }

                if (c == '"')
                {
                    inString = false;
                    result.Append('"');
                    continue;
                }

                result.Append(' ');
                continue;
            }

            if (c == '"')
            {
                inString = true;
                result.Append('"');
                continue;
            }

            if (c == '/' && i + 1 < line.Length && line[i + 1] == '/')
            {
                break;
            }

            result.Append(c);
        }

        return result.ToString();
    }

    /// <summary>
    /// The index of the <c>#[cfg(test)] mod tests</c> line that opens the host's test module —
    /// everything below it is fixture scaffolding rather than a sink.
    /// </summary>
    /// <remarks>
    /// Matched as the attribute IMMEDIATELY followed by <c>mod tests</c>, not merely the first
    /// <c>#[cfg(test)]</c> in the file: <c>collab.rs</c> carries a test-only <c>use</c> under that
    /// same attribute 1,400 lines above its test module, and a scan that stopped there would go
    /// blind to almost the whole file.
    /// </remarks>
    private static int TestModuleStart(string[] lines, string relativePath)
    {
        for (int i = 0; i + 1 < lines.Length; i++)
        {
            if (lines[i].Trim() == "#[cfg(test)]" && lines[i + 1].TrimStart().StartsWith("mod tests", StringComparison.Ordinal))
            {
                return i;
            }
        }

        throw new InvalidDataException(
            $"{relativePath} has no `#[cfg(test)] mod tests` module — this guard scans the file ABOVE that "
            + "boundary, so it cannot tell host code from fixture code without it. If the module was renamed, "
            + "update this test rather than removing the boundary.");
    }

    private static IReadOnlyList<RustSite> FindRustSites()
    {
        string[] lines = File.ReadAllLines(AbsolutePath(RustHost));
        int limit = TestModuleStart(lines, RustHost);

        var sites = new List<RustSite>();
        string function = "<file scope>";

        for (int i = 0; i < limit; i++)
        {
            string code = StripStringsAndComments(lines[i]);

            Match declaration = RustFunctionDeclaration.Match(code);
            if (declaration.Success)
            {
                function = declaration.Groups[1].Value;
            }

            if (code.Contains(".join(", StringComparison.Ordinal))
            {
                sites.Add(new RustSite(i + 1, RawJoin, function, lines[i].Trim()));
            }

            if (lines[i].TrimStart().StartsWith("#[tauri::command", StringComparison.Ordinal))
            {
                RustSite? unrouted = InspectCommand(lines, i, limit);
                if (unrouted is not null)
                {
                    sites.Add(unrouted);
                }
            }
        }

        return sites;
    }

    /// <summary>
    /// Reads the <c>#[tauri::command]</c> starting at <paramref name="attributeIndex"/> and reports
    /// it when it declares a caller-supplied relative-path parameter without calling
    /// <c>resolve_in</c>.
    /// </summary>
    private static RustSite? InspectCommand(string[] lines, int attributeIndex, int limit)
    {
        // --- the signature: from `fn` until the parameter list's parens balance ---
        int i = attributeIndex + 1;
        while (i < limit && !RustFunctionDeclaration.IsMatch(StripStringsAndComments(lines[i])))
        {
            i++;
        }

        if (i >= limit)
        {
            return null;
        }

        int declarationLine = i;
        string name = RustFunctionDeclaration.Match(StripStringsAndComments(lines[i])).Groups[1].Value;

        var parameters = new System.Text.StringBuilder();
        int depth = 0;
        bool started = false;
        for (; i < limit; i++)
        {
            foreach (char c in StripStringsAndComments(lines[i]))
            {
                if (c == '(')
                {
                    depth++;
                    started = true;
                    if (depth == 1)
                    {
                        continue;
                    }
                }
                else if (c == ')')
                {
                    depth--;
                    if (depth == 0)
                    {
                        break;
                    }
                }

                if (started && depth >= 1)
                {
                    parameters.Append(c);
                }
            }

            if (started && depth == 0)
            {
                break;
            }

            parameters.Append(' ');
        }

        string[] tainted = SplitParameters(parameters.ToString())
            .Where(IsCallerSuppliedRelativePath)
            .ToArray();

        if (tainted.Length == 0)
        {
            return null;
        }

        // --- the body: from the opening brace until the braces balance again ---
        var body = new System.Text.StringBuilder();
        depth = 0;
        started = false;
        for (; i < limit; i++)
        {
            string code = StripStringsAndComments(lines[i]);
            body.Append(code).Append('\n');
            foreach (char c in code)
            {
                if (c == '{')
                {
                    depth++;
                    started = true;
                }
                else if (c == '}')
                {
                    depth--;
                }
            }

            if (started && depth == 0)
            {
                break;
            }
        }

        if (body.ToString().Contains("resolve_in(", StringComparison.Ordinal))
        {
            return null;
        }

        return new RustSite(
            declarationLine + 1,
            UnroutedCommand,
            name,
            $"fn {name}({string.Join(", ", tainted)}) never calls resolve_in");
    }

    /// <summary>Splits a Rust parameter list on top-level commas (so <c>HashMap&lt;K, V&gt;</c> stays whole).</summary>
    private static IEnumerable<string> SplitParameters(string parameters)
    {
        var current = new System.Text.StringBuilder();
        int depth = 0;

        foreach (char c in parameters)
        {
            switch (c)
            {
                case '<' or '(' or '[':
                    depth++;
                    break;
                case '>' or ')' or ']':
                    depth--;
                    break;
                case ',' when depth == 0:
                    yield return current.ToString().Trim();
                    current.Clear();
                    continue;
            }

            current.Append(c);
        }

        if (current.ToString().Trim().Length > 0)
        {
            yield return current.ToString().Trim();
        }
    }

    /// <summary>
    /// True for a parameter that carries a relative path chosen by whoever called the command: a
    /// <c>rel</c>/<c>path</c>-segmented name over a string-or-path type. Both halves matter — the
    /// name alone would sweep in <c>&amp;AppHandle</c>-shaped state, and the type alone would sweep
    /// in every <c>String</c> parameter in the file.
    /// </summary>
    private static bool IsCallerSuppliedRelativePath(string parameter)
    {
        int colon = parameter.IndexOf(':', StringComparison.Ordinal);
        if (colon < 0)
        {
            return false;
        }

        string name = parameter[..colon].Replace("mut ", string.Empty).Trim();
        string type = parameter[(colon + 1)..];

        bool named = name.Split('_').Any(segment => PathParameterSegments.Contains(segment, StringComparer.Ordinal));
        bool typed = type.Contains("String", StringComparison.Ordinal)
            || type.Contains("str", StringComparison.Ordinal)
            || type.Contains("Path", StringComparison.Ordinal);

        return named && typed;
    }

    [Fact]
    public void No_unguarded_path_sink_appears_in_the_tauri_host()
    {
        IReadOnlyList<RustSite> sites = FindRustSites();

        List<RustSite> unlisted = sites
            .Where(s => !RustAllowlist.Any(a =>
                a.Function == s.Function && a.Kind == s.Kind && s.Text.Contains(a.Marker, StringComparison.Ordinal)))
            .ToList();

        unlisted.ShouldBeEmpty(
            "Unguarded filesystem path site(s) in the Koine Studio Tauri host. A `[raw-join]` composes a "
            + "path with `Path::join` outside the containment primitive; an `[unrouted-command]` takes a "
            + "caller-supplied relative-path parameter and never calls `resolve_in`. Either is how "
            + "CVE-2026-27800 and CVE-2026-27976 happened: a path validated lexically (or not at all) and "
            + "then handed to a filesystem that resolves symlinks.\n\n"
            + "Route it through `resolve_in(folder, rel_path)` (src/lib.rs) and USE THE PATH IT RETURNS — "
            + "re-deriving `folder.join(rel_path)` afterwards throws away exactly the symlink resolution "
            + "that makes it safe. If the site is genuinely a different trust class (a user-chosen absolute "
            + "path from the OS dialog, a git pathspec, a host-internal join with no caller input), add a "
            + "row to this test's RustAllowlist with a real justification — and to the twin table in "
            + "`paths.rs`'s `the_host_routes_every_plugin_influenced_path_through_the_primitive`.\n\n"
            + string.Join("\n", unlisted));
    }

    [Fact]
    public void Every_rust_allowlist_entry_still_matches_a_real_site()
    {
        IReadOnlyList<RustSite> sites = FindRustSites();

        var stale = RustAllowlist
            .Where(a => !sites.Any(s =>
                s.Function == a.Function && s.Kind == a.Kind && s.Text.Contains(a.Marker, StringComparison.Ordinal)))
            .ToList();

        stale.ShouldBeEmpty(
            "Allowlist entries that no longer match a real site in " + RustHost + " (the code was removed, "
            + "renamed, or already routed through the primitive). An allowlist that only ever grows stops "
            + "being a list of considered exceptions — delete the entry:\n"
            + string.Join("\n", stale.Select(s => $"`{s.Function}` [{s.Kind}] marker \"{s.Marker}\" — {s.Reason}")));
    }

    [Fact]
    public void The_sibling_tauri_modules_still_have_no_filesystem_sink()
    {
        // The #1942 audit's claim that `collab.rs` and `noise.rs` carry no filesystem sinks is what
        // makes scanning lib.rs alone sufficient. Pin it, so the day one of them grows a `std::fs`
        // call the guard's scope is revisited deliberately instead of silently going stale.
        var offenders = new List<string>();

        foreach (string module in new[]
        {
            "tooling/koine-studio/src-tauri/src/collab.rs",
            "tooling/koine-studio/src-tauri/src/noise.rs",
        })
        {
            string[] lines = File.ReadAllLines(AbsolutePath(module));
            int limit = TestModuleStart(lines, module);

            for (int i = 0; i < limit; i++)
            {
                if (StripStringsAndComments(lines[i]).Contains("std::fs", StringComparison.Ordinal))
                {
                    offenders.Add($"{module}:{i + 1} — {lines[i].Trim()}");
                }
            }
        }

        offenders.ShouldBeEmpty(
            "A Tauri host module outside lib.rs has grown a filesystem call. That module is NOT scanned by "
            + "No_unguarded_path_sink_appears_in_the_tauri_host, so either route the new sink through "
            + "`resolve_in`/`contained_path` and extend this guard's scope to cover the module, or explain "
            + "here why the call takes no third-party-influenced path:\n"
            + string.Join("\n", offenders));
    }

    // ------------------------------------------------------------------------------------------
    // The .NET extension layer
    // ------------------------------------------------------------------------------------------

    /// <summary>One place in the .NET extension layer where a path is composed without the primitive.</summary>
    private sealed record NetSite(string RelativePath, int Line, string Text)
    {
        public override string ToString() => $"{RelativePath}:{Line} — {Text}";
    }

    /// <summary>
    /// Allowlisted .NET compositions, anchored on (file, exact expression text) with a written
    /// justification.
    /// </summary>
    private static readonly (string RelativePath, string Marker, string Reason)[] NetAllowlist =
    [
        ($"{NetExtensionLayer}/SafeArchiveExtractor.cs", "Path.GetFullPath(destinationRoot)",
            "absolutizes the CALLER'S OWN destination root — the trusted half of the pair — before the "
            + "per-level directory creation walks it; no archive member name is composed here (every member "
            + "goes through ContainedPath.TryResolve, and the walk only re-creates levels of this root)"),
    ];

    private static IReadOnlyList<NetSite> FindNetPathCompositions()
    {
        string repoRoot = RepoRoot();
        string layer = AbsolutePath(NetExtensionLayer);
        var sites = new List<NetSite>();

        foreach (string file in Directory
            .EnumerateFiles(layer, "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                && !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                && Path.GetFileName(f) != NetPrimitive)
            .OrderBy(f => f, StringComparer.Ordinal))
        {
            SyntaxTree tree = CSharpSyntaxTree.ParseText(File.ReadAllText(file), path: file);
            string relativePath = Path.GetRelativePath(repoRoot, file).Replace(Path.DirectorySeparatorChar, '/');

            foreach (SyntaxNode node in tree.GetRoot().DescendantNodes())
            {
                if (!IsPathComposition(node))
                {
                    continue;
                }

                int line = node.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
                sites.Add(new NetSite(relativePath, line, Condense(node.ToString())));
            }
        }

        return sites;
    }

    /// <summary>
    /// True for the three shapes that compose a filesystem path out of parts: a
    /// <c>Path.Combine</c>/<c>Path.Join</c>/<c>Path.GetFullPath</c> call, a <c>+</c> with a
    /// separator-bearing string literal, or an interpolated string whose literal text carries a
    /// separator.
    /// </summary>
    /// <remarks>
    /// <c>Path.GetFullPath</c> is in the list because it looks like canonicalization and is not: it
    /// normalizes LEXICALLY and does not resolve symlinks, which is precisely the hole
    /// CVE-2026-27976 went through. Decomposition (<c>Path.GetDirectoryName</c>,
    /// <c>Path.GetFileName</c>, <c>Path.GetPathRoot</c>) is not flagged — it takes a path apart
    /// rather than building one, and cannot make a contained path escape.
    /// </remarks>
    private static bool IsPathComposition(SyntaxNode node)
    {
        if (node is InvocationExpressionSyntax
            {
                Expression: MemberAccessExpressionSyntax
                {
                    Expression: IdentifierNameSyntax { Identifier.Text: "Path" },
                    Name.Identifier.Text: "Combine" or "Join" or "GetFullPath",
                }
            })
        {
            return true;
        }

        if (node is BinaryExpressionSyntax add && add.IsKind(SyntaxKind.AddExpression))
        {
            return HasSeparator(add.Left) || HasSeparator(add.Right);
        }

        if (node is InterpolatedStringExpressionSyntax interpolated)
        {
            return interpolated.Contents.OfType<InterpolationSyntax>().Any()
                && interpolated.Contents.OfType<InterpolatedStringTextSyntax>()
                    .Any(t => t.TextToken.ValueText.AsSpan().IndexOfAny('/', '\\') >= 0);
        }

        return false;
    }

    private static bool HasSeparator(ExpressionSyntax expression)
        => expression is LiteralExpressionSyntax literal
            && literal.IsKind(SyntaxKind.StringLiteralExpression)
            && literal.Token.ValueText.AsSpan().IndexOfAny('/', '\\') >= 0;

    /// <summary>Collapses an expression onto one line so a wrapped call still reads in a failure message.</summary>
    private static string Condense(string text)
        => Regex.Replace(text, @"\s+", " ").Trim();

    [Fact]
    public void No_raw_path_composition_appears_in_the_extension_layer()
    {
        IReadOnlyList<NetSite> sites = FindNetPathCompositions();

        List<NetSite> unlisted = sites
            .Where(s => !NetAllowlist.Any(a =>
                a.RelativePath == s.RelativePath && s.Text.Contains(a.Marker, StringComparison.Ordinal)))
            .ToList();

        unlisted.ShouldBeEmpty(
            $"Raw filesystem path composition under {NetExtensionLayer}/ — the layer that handles paths a "
            + "third party chose (extension manifests, template-pack layouts, archive members). "
            + "Path.Combine/Path.Join compose without checking where the result lands, and Path.GetFullPath "
            + "normalizes LEXICALLY without resolving symlinks, which is the exact hole CVE-2026-27976 went "
            + "through.\n\n"
            + "Route the untrusted part through ContainedPath.TryResolve(root, candidate, out string "
            + "resolved, out PathEscapeReason reason) and use `resolved` — it walks to the nearest existing "
            + "ancestor, canonicalizes, and proves containment component-wise. If the composition genuinely "
            + "takes no untrusted input, add a row to this test's NetAllowlist with a real justification.\n\n"
            + string.Join("\n", unlisted));
    }

    [Fact]
    public void Every_dotnet_allowlist_entry_still_matches_a_real_site()
    {
        IReadOnlyList<NetSite> sites = FindNetPathCompositions();

        var stale = NetAllowlist
            .Where(a => !sites.Any(s => s.RelativePath == a.RelativePath && s.Text.Contains(a.Marker, StringComparison.Ordinal)))
            .ToList();

        stale.ShouldBeEmpty(
            "Allowlist entries that no longer match a real composition (the code was removed, rewritten, or "
            + "already routed through ContainedPath). Delete the entry:\n"
            + string.Join("\n", stale.Select(s => $"{s.RelativePath} marker \"{s.Marker}\" — {s.Reason}")));
    }

    [Fact]
    public void The_extension_layer_is_scanned_at_all()
    {
        // A scan over an empty (or moved) directory passes vacuously — the failure mode that turns a
        // gate into decoration. Assert the layer is where this test thinks it is, and that the file
        // exempted by name is actually there to be exempted.
        Directory.Exists(AbsolutePath(NetExtensionLayer)).ShouldBeTrue(
            $"{NetExtensionLayer}/ does not exist — this guard scans nothing. Point it at the layer's new home.");

        File.Exists(Path.Combine(AbsolutePath(NetExtensionLayer), NetPrimitive)).ShouldBeTrue(
            $"{NetExtensionLayer}/{NetPrimitive} is missing — the exemption above now excuses a file that "
            + "does not exist, and the primitive every other file must route through is gone.");

        File.Exists(AbsolutePath(RustHost)).ShouldBeTrue(
            $"{RustHost} does not exist — the Rust half of this guard scans nothing.");
    }
}
