# Examples

Starter templates and focused fixtures — the gentle on-ramp before the full
[six-context demo](../demo/README.md).

## Starter templates

Compilable `.koi` models for every introductory use-case now live in [`templates/starters/`](../templates/starters/).
Open any template folder in Koine Studio or point the CLI at it:

```bash
# Generate C# from the billing starter:
dotnet run --project ../src/Koine.Cli -- build ../templates/starters/billing/billing.koi --target csharp --out /tmp/billing

# Or point at the folder — directory mode compiles every .koi inside as one model:
dotnet run --project ../src/Koine.Cli -- build ../templates/starters/billing --target csharp --out /tmp/billing
```

## Versioning fixture

| Path | What it is |
| --- | --- |
| [`versioning/`](versioning) | A before/after pair (`v1/` → `v2/`) for `koine check`: v2 drops a published field, demonstrating a breaking change. |

The `versioning/` directory is a `koine check` fixture — **not** a starter template.

```bash
# Flag the breaking change between the two versioned models:
dotnet run --project ../src/Koine.Cli -- check versioning/v2 --baseline versioning/v1
```
