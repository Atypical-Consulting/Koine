---
id: 10
title: Adopt MADR 4.0 for architecture decision records
status: proposed
date: 2026-07-09
links:
  - type: relates-to
    target: 1
---

# Adopt MADR 4.0 for architecture decision records

## Context and Problem Statement

We wired up [AdrMcp](https://atypical-consulting.github.io/AdrMcp/) — an MCP server that lets an
agent navigate, author, validate, link, and analyze ADRs on disk — against Koine's own `/adr/`
corpus, and found it recognized **zero** of the 9 files. AdrMcp requires a YAML frontmatter block to
recognize a file as an ADR at all; the classic Nygard convention [ADR 0001](0001-record-architecture-decisions.md)
chose has no frontmatter, so the whole corpus was invisible to it, not merely flagged as
non-conformant.

We contributed a fix upstream (`Atypical-Consulting/AdrMcp` PR #8, released as `AdrMcp` v0.2.0, with a
follow-up fix released as v0.2.1) so AdrMcp also reads frontmatter-less classic Nygard files, gated on
the `NNNN-slug.md` filename convention. That fix means AdrMcp can *read* Koine's ADRs as they already
are — this decision is not required to unblock that. But staying on pure Nygard format means our
corpus can only ever use that best-effort fallback path: no `tags`, no `deciders`, no structured
`links`, no `code_refs`, and therefore no tag-based coverage tracking — all of which are frontmatter
fields the fallback path has nothing to read them from.

## Considered Options

* Keep the classic Nygard format chosen in ADR 0001, relying on the AdrMcp compatibility fallback we
  contributed upstream.
* Adopt MADR 4.0 frontmatter and section structure natively for every ADR in `/adr/`.

## Decision Outcome

Chosen option: "Adopt MADR 4.0 natively", because relying on the fallback path means the corpus never
carries tags, deciders, or structured links, and MADR 4.0 is the native, fully-supported format of the
ADR tooling (AdrMcp, and the broader MADR ecosystem) we now use to query and validate these records.

We will convert every ADR under `/adr/` to MADR 4.0: a YAML frontmatter block (`id`, `title`, `status`,
`date`, and optionally `deciders`/`tags`/`links`/`code_refs`), with `## Context and Problem Statement`,
`## Considered Options`, `## Decision Outcome`, and `## Consequences` as the body sections.
`adr/template.md` and `adr/README.md`'s "Adding a new ADR" instructions are updated to the same shape.

This supersedes [ADR 0001](0001-record-architecture-decisions.md)'s specific choice of "the
lightweight format described at adr.github.io (Michael Nygard's original convention) … each with
Context, Decision, and Consequences sections." The rest of ADR 0001 — recording architecturally
significant decisions as versioned Markdown files under `/adr/`, immutability once accepted,
`template.md`/`README.md` as the contributor entry points — stands.

## Consequences

- All 9 existing ADRs (0001–0009) were reformatted in place: frontmatter added, sections renamed, and
  a `## Considered Options` list reconstructed from alternatives each ADR's original prose already
  discussed — no new alternatives invented, no Decision/Consequences content removed. The standalone
  `## Status` heading and `Date:` line are gone from the body; that data now lives only in frontmatter.
- New ADRs can carry `tags`, `deciders`, and structured `links` (`supersedes` / `superseded-by` /
  `relates-to` / `conflicts-with`) that AdrMcp's tooling (`coverage_report`, `get_adr_graph`,
  `detect_conflicts`, `validate_adr`) can act on — a frontmatter-less file cannot carry any of this.
- The already-documented partial-supersession relationship between [ADR 0002](0002-conventional-commits-and-automated-semver.md)
  and [ADR 0008](0008-release-assets-in-release-please-run.md) is now also a structured `relates-to`
  link in both files' frontmatter, alongside the prose that already explained it — the same treatment
  this ADR gets with ADR 0001.
- AdrMcp's own frontmatter-less-Nygard fallback (contributed upstream, released as `AdrMcp`
  v0.2.0/v0.2.1) remains available for any *other* repo it's pointed at — this decision only changes
  what Koine's own `/adr/` chooses to author, not AdrMcp's read capability.
- `adr/README.md`'s "Adding a new ADR" steps change: a new ADR now starts from the MADR-shaped
  `template.md`, and status lives in frontmatter — no separate `## Status` heading to keep in sync.
