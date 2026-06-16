# Examples

Small, focused `.koi` models — the gentle on-ramp before the full
[six-context demo](../demo/README.md).

| Path | What it is |
| --- | --- |
| [`billing.koi`](billing.koi) | The smallest end-to-end model — one context with a value object, enum, entity, and an aggregate. Start here for the quick start (`docs/start/your-first-model.md`). |
| [`versioning/`](versioning) | A before/after pair (`v1/` → `v2/`) for `koine check`: v2 drops a published field, demonstrating a breaking change. |

## Try them

```bash
# Generate C# from the quick-start model:
dotnet run --project ../src/Koine.Cli -- build billing.koi --out /tmp/billing

# Flag the breaking change between the two versioned models:
dotnet run --project ../src/Koine.Cli -- check versioning/v2 --baseline versioning/v1
```
