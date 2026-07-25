Each prompt below attacks a *different* documentation problem, so the set reads as a map rather than four rephrasings of "write the docs." Paste one at a time and let the model reason through it before it drafts.

**1. README intro — positioning & the first 15 seconds**
> What makes an open-source README intro earn a `brew install` (or a star) in the first fifteen seconds — what must a skimming reader grasp instantly: *what it is*, *which pain it kills*, and *whether it's for them*? Which writing principles apply here — the inverted pyramid (lead with the payoff, not the backstory), jobs-to-be-done, the one-sentence value proposition, the conventional README spine (tagline → why it exists → 30-second quickstart), and the curse of knowledge that makes maintainers over-explain internals?
> Now apply this to `lumen`, a log-parsing CLI: write an intro that opens with the single job it removes for someone drowning in raw log files — before any feature list or architecture talk.

**2. Getting-started page — time to first success**
> What makes a getting-started page deliver a genuine *aha* — a first real win — fast, instead of dragging the reader through a config slog? Which principles separate a great tutorial from a reference dump: Diátaxis (this page is a *tutorial* — learning-oriented and hand-held, not a complete spec), "time to first success / time-to-hello-world," ruthlessly minimizing prerequisites and cognitive load, a single happy path with no forks, and show-don't-tell (every step a copy-pasteable command plus the exact output to expect)?
> Now apply this to `lumen`: design the shortest path from install to the user parsing their first log file and seeing a result they actually care about. What is the single most motivating first example — and what can be cut to reach it sooner?

**3. Error / troubleshooting section — recovery, not restatement**
> What makes a troubleshooting section actually rescue a stuck user rather than restate the manual in a sadder tone? Which principles govern it — organizing entries around the *literal error string the user sees* (symptom-first, Ctrl-F-able headings) rather than around internal causes; the "what happened / why / what to do next" triad for each entry; Nielsen's error heuristics (help users recognize, diagnose, and recover from errors); an empathetic, non-blaming tone; and prioritizing coverage of real failure modes over the happy path?
> Now apply this to `lumen`: enumerate its genuine failure modes — malformed or unparseable log lines, unsupported/unknown formats, encoding mismatches, empty or enormous files, a bad glob or regex, `[other lumen-specific failures]` — and write each entry keyed on the exact message a user would search for.

**4. Command reference — completeness & scannability**
> What makes a CLI command reference *trustworthy and fast to scan* — something a user greps mid-task, not reads cover to cover? Which principles apply: Diátaxis (reference is information-oriented — complete, consistent, austere, zero tutorial); POSIX / `docopt`-style synopsis grammar for the usage line; documenting *every* flag, argument, default, and exit code in a consistent order; one realistic copy-pasteable example per command; and the principle of least surprise (consistent flag naming and behavior across subcommands)?
> Now apply this to `lumen`'s commands and flags `[list the subcommands]`: give each a synopsis line, an exhaustive option table, its exit codes, and a worked example — and flag any inconsistency in flag naming or behavior between subcommands that the reference exposes.

---

**Reuse this skeleton to generate more:**
> *What makes an effective `[type of doc]`?* → *Which named principles / frameworks apply (`[name 2–4 real ones]`)?* → *Now apply them to `[the specific lumen page]`.*

Two notes on grounding: the bracketed bits — `lumen`'s actual subcommands, flags, and real failure modes — are the placeholders to fill in, and they're exactly where the output gets sharp, so don't leave them generic. If you point me at the repo (or paste `lumen --help` and a couple of source files), I can read the real commands and error paths and harden prompts 3 and 4 so the AI works from your actual surface instead of a placeholder.
