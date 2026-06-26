using System.Reflection;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Emit.Php;
using Koine.Compiler.Emit.Python;
using Koine.Compiler.Emit.Rust;
using Koine.Compiler.Emit.TypeScript;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Epic R8 — a <c>create</c> factory may take the new aggregate's identity as an explicit
/// identity-typed parameter (#324). When it does, the factory must NOT mint an identity (a non-Guid key
/// has no meaningful client-side generator); it binds the synthetic <c>id</c> to that parameter instead.
/// Binding is by parameter TYPE, not the literal name <c>id</c>, so the parameter may be named anything.
/// This suite proves the binding across all five emitters: the C# case real-compiles AND executes
/// (Roslyn), the Rust case real-compiles (cargo), and TypeScript/Python/PHP assert the emitted text and
/// funnel their conformance harness through <see cref="TestSupport.RequireOrSkip"/> (skipped locally).
/// </summary>
public class R8ExplicitIdFactoryTests
{
    /// <summary>
    /// A <c>natural(String)</c> Book aggregate whose <c>register</c> factory takes the identity as an
    /// explicit identity-typed parameter named <paramref name="idParam"/> (e.g. <c>id</c> or <c>bookId</c>).
    /// </summary>
    private static string Model(string idParam) => $$"""
        context Catalog {
          value Isbn {
            code: String
            invariant code.trim.length > 0 "an ISBN cannot be blank"
          }
          entity Book identified by BookId as natural(String) {
            isbn:  Isbn
            title: String
            create register({{idParam}}: BookId, isbn: Isbn, title: String) {
              requires title.trim.length > 0 "a book needs a title"
              title -> title
            }
          }
        }
        """;

    private const string NoCargoNotice =
        "No usable Rust toolchain (cargo, networked) available; cargo check not run. " +
        "Install Rust (or set KOINE_CARGO) — CI runs this for real.";

    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    /// <summary>All emitted files of <paramref name="emitter"/> joined into one blob (asserts compile success).</summary>
    private static string BlobOf(IEmitter emitter, string source)
    {
        var result = new KoineCompiler().Compile(source, emitter);
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return string.Join("\n", result.Files.Select(f => f.Contents));
    }

    // ---- C#: real compile + execute (Roslyn) -------------------------------

    [Fact]
    public void CSharp_explicit_id_param_named_id_binds_without_minting()
    {
        var src = Model("id");
        Diagnose(src).ShouldBeEmpty();

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var book = result.Files.Single(f => f.RelativePath.EndsWith("Entities/Book.cs", StringComparison.Ordinal)).Contents;

        // The explicit-id factory must NOT mint: no `BookId.New()` (there is none to call for a natural
        // key) and no synthetic `var id =` — the `id` parameter already provides the local.
        book.ShouldNotContain("BookId.New()");
        book.ShouldNotContain("var id =");
        book.ShouldContain("new Book(id,"); // the parameter is threaded into construction

        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));

        var bookType = asm!.GetType("Catalog.Book")!;
        var bookIdType = asm.GetType("Catalog.BookId")!;
        var isbnType = asm.GetType("Catalog.Isbn")!;
        var register = bookType.GetMethod("Register")!;

        var key = Activator.CreateInstance(bookIdType, "9780306406157")!;
        var isbn = Activator.CreateInstance(isbnType, "9780306406157")!;
        var instance = register.Invoke(null, new[] { key, isbn, (object)"Domain-Driven Design" })!;

        // The aggregate's Id equals the passed key (by value) — proving the parameter was threaded,
        // not replaced by a freshly minted random identity.
        var expected = Activator.CreateInstance(bookIdType, "9780306406157")!;
        bookType.GetProperty("Id")!.GetValue(instance).ShouldBe(expected);

        // The factory's `requires` invariant still runs: a blank title is rejected before construction.
        var ex = Should.Throw<TargetInvocationException>(() =>
            register.Invoke(null, new[] { key, isbn, (object)"   " }));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
    }

    [Fact]
    public void CSharp_explicit_id_param_named_differently_binds_by_type()
    {
        // Binding is by parameter TYPE, not the literal name `id`: a `bookId: BookId` param serves as
        // the explicit identity, aliased onto the synthetic `id` local.
        var src = Model("bookId");
        Diagnose(src).ShouldBeEmpty();

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var book = result.Files.Single(f => f.RelativePath.EndsWith("Entities/Book.cs", StringComparison.Ordinal)).Contents;

        book.ShouldContain("var id = bookId;"); // alias, not a generator call
        book.ShouldNotContain("BookId.New()");
        book.ShouldContain("new Book(id,");

        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));

        var bookType = asm!.GetType("Catalog.Book")!;
        var bookIdType = asm.GetType("Catalog.BookId")!;
        var isbnType = asm.GetType("Catalog.Isbn")!;

        var key = Activator.CreateInstance(bookIdType, "0201633612")!;
        var isbn = Activator.CreateInstance(isbnType, "0201633612")!;
        var instance = bookType.GetMethod("Register")!.Invoke(null, new[] { key, isbn, (object)"Refactoring" })!;

        var expected = Activator.CreateInstance(bookIdType, "0201633612")!;
        bookType.GetProperty("Id")!.GetValue(instance).ShouldBe(expected);
    }

    [Fact]
    public void CSharp_guid_factory_with_self_typed_reference_param_still_mints_distinct_ids()
    {
        // Regression (#324 review): explicit-id binding is by TYPE but applies ONLY to non-Guid keys.
        // A Guid factory whose parameter happens to be its OWN identity type is an ordinary reference
        // (reply-to-parent), NOT the new id — it must still mint a fresh `CommentId.New()`, or every
        // reply would silently inherit its parent's identity. Proven by executing the factory twice and
        // asserting the two aggregates get DISTINCT ids.
        const string src = """
            context Forum {
              entity Comment identified by CommentId {
                body: String
                create reply(parent: CommentId, body: String) { body -> body }
              }
            }
            """;
        Diagnose(src).ShouldBeEmpty();

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var comment = result.Files.Single(f => f.RelativePath.EndsWith("Entities/Comment.cs", StringComparison.Ordinal)).Contents;

        // The id is minted, not aliased from the `parent` reference.
        comment.ShouldContain("var id = CommentId.New();");
        comment.ShouldNotContain("var id = parent;");

        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));

        var commentType = asm!.GetType("Forum.Comment")!;
        var commentIdType = asm.GetType("Forum.CommentId")!;
        var reply = commentType.GetMethod("Reply")!;
        var parent = commentIdType.GetMethod("New")!.Invoke(null, null);

        var a = commentType.GetProperty("Id")!.GetValue(reply.Invoke(null, new[] { parent, (object)"first" }));
        var b = commentType.GetProperty("Id")!.GetValue(reply.Invoke(null, new[] { parent, (object)"second" }));
        a.ShouldNotBe(b);          // two replies → two distinct minted ids
        a.ShouldNotBe(parent);     // and neither inherits the `parent` reference's id
    }

    // ---- Rust: real compile (cargo) ----------------------------------------

    [Fact]
    public void Rust_explicit_id_param_named_id_binds_and_compiles()
    {
        var result = new KoineCompiler().Compile(Model("id"), new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var crate = string.Join("\n", result.Files.Select(f => f.Contents));

        // No mint: neither a `::generate()` call nor a `pub fn generate()` definition for the id type.
        crate.ShouldNotContain("BookId::generate()");
        crate.ShouldNotContain("pub fn generate()");
        crate.ShouldContain("Self::new(id,"); // parameter threaded into the smart constructor

        // The MintsUuidIdentity fix also keeps the `uuid` crate out of the manifest.
        result.Files.Single(f => f.RelativePath == "Cargo.toml").Contents.ShouldNotContain("uuid");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoCargoNotice);
        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    [Fact]
    public void Rust_explicit_id_param_named_differently_clones_and_compiles()
    {
        var result = new KoineCompiler().Compile(Model("bookId"), new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var crate = string.Join("\n", result.Files.Select(f => f.Contents));

        // The differently-named id param aliases `id` via `.clone()` — avoiding a move so the param
        // stays usable; cargo proves there is no borrow/move error.
        crate.ShouldContain("let id = book_id.clone();");
        crate.ShouldNotContain("BookId::generate()");
        crate.ShouldContain("Self::new(id,");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoCargoNotice);
        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    // ---- TypeScript / Python / PHP: emitted text + skipped conformance -----

    [Fact]
    public void TypeScript_explicit_id_param_binds_without_generating()
    {
        var result = new KoineCompiler().Compile(Model("id"), new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var blob = string.Join("\n", result.Files.Select(f => f.Contents));

        blob.ShouldNotContain("BookIdNew()"); // no client-side generate
        blob.ShouldNotContain("const id =");  // the `id` parameter provides the local directly
        blob.ShouldContain("new Book(id,");   // parameter threaded into construction

        var ts = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(ts.ToolchainAvailable,
            "No tsc toolchain available; TypeScript type-check skipped (CI runs it for real).");
        ts.Ok.ShouldBeTrue(string.Join("\n", ts.Errors));
    }

    [Fact]
    public void Python_explicit_id_param_binds_without_generating()
    {
        var result = new KoineCompiler().Compile(Model("id"), new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var blob = string.Join("\n", result.Files.Select(f => f.Contents));

        blob.ShouldNotContain("BookId.new()"); // no client-side generate
        blob.ShouldContain("cls(id=id,");       // parameter threaded into construction

        var py = TestSupport.TypeCheckPython(result.Files);
        TestSupport.RequireOrSkip(py.ToolchainAvailable,
            "No mypy toolchain available; Python type-check skipped (CI runs it for real).");
        py.Ok.ShouldBeTrue(string.Join("\n", py.Errors));
    }

    [Fact]
    public void Php_explicit_id_param_binds_without_generating()
    {
        var result = new KoineCompiler().Compile(Model("id"), new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var blob = string.Join("\n", result.Files.Select(f => f.Contents));

        blob.ShouldNotContain("BookId::generate()"); // no client-side generate
        blob.ShouldContain("new self($id,");          // parameter threaded into construction

        var php = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(php.ToolchainAvailable,
            "No phpstan toolchain available; PHP analysis skipped (CI runs it for real).");
        php.Ok.ShouldBeTrue(string.Join("\n", php.Errors));
    }

    // ---- the alias rendering, across every target (text-only) --------------

    [Fact]
    public void Differently_named_id_param_aliases_the_synthetic_id_in_every_target()
    {
        var src = Model("bookId");
        BlobOf(new CSharpEmitter(), src).ShouldContain("var id = bookId;");
        BlobOf(new RustEmitter(), src).ShouldContain("let id = book_id.clone();");
        BlobOf(new TypeScriptEmitter(), src).ShouldContain("const id = bookId;");
        BlobOf(new PythonEmitter(), src).ShouldContain("id = book_id");
        BlobOf(new PhpEmitter(), src).ShouldContain("$id = $bookId;");
    }
}
