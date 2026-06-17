---
title: "Your first model"
description: "Write a tiny .koi file, compile it, and see the generated C#."
---

In five minutes you'll write a real `.koi` model, compile it to C#, and read what comes out.
No DDD theory yet — just the shortest path from a domain idea to compiling code.

If you haven't installed the compiler, do that first: [Installation](/Koine/start/installation/).

<a class="koi-try" href="/Koine/playground/?example=billing">Prefer to try it now? Open the Playground</a>

## Write `hello.koi`

Create a file called `hello.koi` anywhere you like. We'll model a tiny slice of a hiring
domain: a validated email address and the candidate who owns it.

```koine
context Hiring {

  value Email {
    raw: String
    invariant raw.trim.length > 0          "an email cannot be blank"
    invariant raw matches /^[^@]+@[^@]+$/   "invalid email address"
  }

  entity Candidate identified by CandidateId {
    name:  String
    email: Email
  }
}
```

Three constructs, three jobs:

- `context Hiring` — the bounded context. Every type lives inside one, and the context name
  becomes the C# namespace.
- `value Email` — a [value object](/Koine/reference/value-objects/): immutable, compared by
  its contents, and guarded by `invariant`s that run in the constructor. `raw.trim.length`
  and `matches /…/` are part of Koine's small [expression sublanguage](/Koine/reference/expressions/).
- `entity Candidate` — an [entity](/Koine/reference/entities-and-identity/): it has identity. The
  `identified by CandidateId` clause names its ID type; Koine generates that ID value object
  for you (a `Guid` wrapper, by default).

## Compile it

Point the compiler at the file and tell it where to write the C#:

```bash
koine build hello.koi --target csharp --out ./generated
```

You'll see:

```
wrote 6 files to ./generated
```

:::tip
Drop the `--out` flag to only **check** that the model parses and validates without writing
anything: `koine build hello.koi` prints `OK: hello.koi parsed and validated`. That's the fast
inner loop while you're shaping a model.
:::

## What got generated

Koine emits one file per type, organized by namespace, plus a tiny shared runtime:

```
generated/
├── Hiring/
│   ├── Email.cs          # the value object
│   ├── Candidate.cs      # the entity
│   └── CandidateId.cs    # the generated ID value object
└── Koine/
    └── Runtime/
        ├── ValueObject.cs
        ├── DomainInvariantViolationException.cs
        └── IAggregateRoot.cs
```

### The value object — `Email.cs`

The two `invariant`s became constructor guards. Construct an `Email` with a blank or malformed
string and it throws; once built, it can never be invalid. Equality is by value (two `Email`s
with the same `Raw` are equal).

```csharp
public sealed class Email : ValueObject
{
    public string Raw { get; }

    public Email(string raw)
    {
        if (!(raw.Trim().Length > 0))
            throw new DomainInvariantViolationException(
                type: nameof(Email),
                rule: "an email cannot be blank");

        if (!Regex.IsMatch(raw, @"^[^@]+@[^@]+$"))
            throw new DomainInvariantViolationException(
                type: nameof(Email),
                rule: "invalid email address");

        Raw = raw;
    }

    protected override IEnumerable<object?> GetEqualityComponents()
    {
        yield return Raw;
    }
}
```

### The entity — `Candidate.cs`

Notice the difference from the value object: a `Candidate` is compared by its `Id` alone, not
its fields. Two candidates with the same name and email are still *different* people — that's
what "has identity" means.

```csharp
public sealed class Candidate
{
    public CandidateId Id { get; }
    public string Name { get; }
    public Email Email { get; }

    public Candidate(CandidateId id, string name, Email email)
    {
        Id = id;
        Name = name;
        Email = email;
    }

    public bool Equals(Candidate? other) => other is not null && Id.Equals(other.Id);
    public override bool Equals(object? obj) => Equals(obj as Candidate);
    public override int GetHashCode() => Id.GetHashCode();
}
```

### The generated ID — `CandidateId.cs`

You never declared `CandidateId` as a type — `identified by CandidateId` was enough. By
default it's a `Guid` wrapper with a `New()` factory for minting fresh identities:

```csharp
public sealed class CandidateId : ValueObject
{
    public Guid Value { get; }

    public CandidateId(Guid value) => Value = value;

    public static CandidateId New() => new(Guid.NewGuid());

    protected override IEnumerable<object?> GetEqualityComponents()
    {
        yield return Value;
    }
}
```

:::note
`ValueObject` and `DomainInvariantViolationException` live in the emitted `Koine.Runtime`
namespace, so the generated code is self-contained — it has no NuGet dependency on Koine. You
copy it into your project and it just compiles.
:::

## Now make it richer

Two small additions show off two of Koine's most-used features. Replace your `hello.koi` with
this:

```koine
context Hiring {

  enum Stage { Applied, Interviewing, Offered, Hired, Rejected }

  value Email {
    raw: String
    invariant raw.trim.length > 0          "an email cannot be blank"
    invariant raw matches /^[^@]+@[^@]+$/   "invalid email address"
  }

  entity Candidate identified by CandidateId {
    name:  String
    email: Email
    stage: Stage = Applied

    isActive: Bool = stage != Hired && stage != Rejected
  }
}
```

What changed:

- `enum Stage { … }` — a **smart enum**. Koine emits a sealed class with static instances,
  value equality, `Name`/`Value`, `All`, and `FromName`/`FromValue` — far more than a C# `enum`.
- `stage: Stage = Applied` — a field with a **default**. New candidates start at `Applied`
  without the caller passing it.
- `isActive: Bool = stage != Hired && stage != Rejected` — a **derived field**. Because its
  value is computed from other fields, it's *not* a constructor parameter; it becomes a get-only
  computed property.

Rebuild:

```bash
koine build hello.koi --target csharp --out ./generated
```

The entity now carries the default and the derived projection:

```csharp
public sealed class Candidate
{
    public CandidateId Id { get; }
    public string Name { get; }
    public Email Email { get; }
    public Stage Stage { get; }

    public Candidate(CandidateId id, string name, Email email, Stage? stage = null)
    {
        stage ??= Stage.Applied;

        Id = id;
        Name = name;
        Email = email;
        Stage = stage;
    }

    public bool IsActive => (Stage != Stage.Hired) && (Stage != Stage.Rejected);

    public bool Equals(Candidate? other) => other is not null && Id.Equals(other.Id);
    public override bool Equals(object? obj) => Equals(obj as Candidate);
    public override int GetHashCode() => Id.GetHashCode();
}
```

:::tip
`isActive` is read-only and always consistent — there's no way to set it to a value that
disagrees with `stage`. That's the payoff of derived fields: the invariant lives in the model,
not in your service layer.
:::

## Where to go next

- **[Reading the generated C#](/Koine/start/reading-the-output/)** — a guided tour of the
  output: namespaces, the runtime, equality, and how each construct maps to code.
- **[Values & invariants](/Koine/tutorials/values-and-invariants/)** — the first tutorial,
  building a real Shop domain one construct at a time.
- **[Language reference](/Koine/reference/value-objects/)** — every construct, formally, with
  the exact C# it emits.
