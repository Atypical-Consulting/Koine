# 4 Socratic prompts for your `lumen` docs

The reason "write the docs" returns mush is that it hands the model a *production* task with no *thinking* task in front of it — so it pattern-matches to the average README it has seen. A Socratic prompt does the opposite: it asks the model questions that force it to surface the quality criteria, model the reader, and reason about *your specific tool* before a single word of prose is written. Then it makes the model grade its own draft against the criteria it just named.

Each prompt below follows the same arc — **theory → framework → application** — and ends by forcing self-critique. Paste one, answer the few questions it asks back (or tell it to assume sensible defaults), and you'll get something sharp instead of generic.

> Before pasting any of these, drop in the facts the model can't guess: what `lumen` actually does, who runs it, the real command surface, and one or two real log formats. Every prompt below assumes you'll paste a few lines of `lumen --help` and a sample log. The questions do the work; your facts make the answers true.

---

## 1. Getting-started page

```
You're going to help me write the getting-started page for `lumen`, a small
command-line log-parsing utility. But don't write anything yet. First, reason
out loud through these questions, then draft, then critique your own draft.

THEORY — what is a getting-started page actually for?
- What is the ONE outcome a reader must reach by the end of this page for it to
  have succeeded? (Name the single "it works!" moment for a log-parsing tool.)
- A getting-started page is not a feature tour and not a reference. What is the
  difference, and what belongs on this page vs. deferred to those?
- What is the reader's emotional and technical state when they land here? What
  do they already have open on their screen? What are they afraid of?

FRAMEWORK — derive the criteria before writing.
- List the 4–6 properties that separate an excellent getting-started page from a
  mediocre one (e.g. time-to-first-success, copy-pasteability, no unexplained
  prerequisites, every command shows its expected output).
- For a log-parsing tool specifically: what's the shortest credible path from
  "installed" to "I just got an insight out of my own logs"? The reader has
  their OWN messy log file — how does the page meet them there instead of using
  a sanitized toy example?
- Where are the three most likely places a first-time user silently gives up?

APPLICATION
- Ask me for: install method, the 1–2 commands that produce the first win, and a
  realistic sample of the log format lumen targets. If I don't answer, state your
  assumptions explicitly and proceed.
- Now write the page. Every command block must show the command AND its expected
  output. Mark the exact line that is the "it works!" moment.

CRITIQUE — grade your own draft against the FRAMEWORK criteria you listed.
Where is it still generic? What did you assume the reader knows that they don't?
Rewrite the weakest section.
```

---

## 2. Error / troubleshooting section

```
Help me write the troubleshooting section for `lumen`, a CLI log parser. Do NOT
start writing prose. Work through this first.

THEORY
- A person reading a troubleshooting page is, by definition, already frustrated
  and probably mid-task. How should that change the writing vs. a tutorial?
- What's the difference between documenting an error and actually unblocking a
  human? What does a reader need beyond "what went wrong"?
- The best troubleshooting entries are organized around the SYMPTOM the user
  sees, not the internal cause they can't see. Why does that matter for a tool
  that fails on malformed/unexpected log input?

FRAMEWORK — build the model before the content.
- Propose a repeatable shape for every entry: e.g. [symptom the user observes] →
  [what it usually means] → [how to confirm] → [the fix] → [how to avoid it].
- Brainstorm the failure surface of a log parser specifically: unparseable
  lines, wrong/auto-detected format, encoding issues, huge files / memory,
  timezone or timestamp ambiguity, empty results that look like a bug but aren't,
  piped vs. file input, exit codes. Which of these produce a CONFUSING failure
  (looks broken but isn't) vs. an OBVIOUS one?
- Rank these by (frequency × how stuck the user gets). The top of the page should
  be the highest-rank items, not an alphabetical dump.

APPLICATION
- Ask me to paste lumen's real error messages / exit codes if I have them; if I
  don't, infer the most probable ones from a log parser's behavior and FLAG each
  as inferred so I can correct them.
- Write the top 6 entries in the shape you defined. Quote the literal error text
  a user would see so they can Ctrl-F to it.

CRITIQUE
- For each entry, ask: could a frustrated user actually self-resolve from this
  alone, or did I hand-wave the fix? Mark any entry that ends in "check your
  configuration" or similar non-answers and rewrite it into a concrete step.
```

---

## 3. Command reference

```
Help me write the command reference for `lumen`, a log-parsing CLI. Reason
through the following BEFORE producing any reference entries.

THEORY
- A reference is read in lookup mode, not reading mode. Nobody reads it top to
  bottom — they scan for one thing. How should that govern structure, density,
  and consistency?
- What is the contract a reference makes with the reader? (Hint: completeness and
  precision — every flag, exact types, exact defaults — and the cost of getting
  one default wrong.)
- Where is the line between a reference (exhaustive, terse, predictable) and a
  guide (selective, narrative, opinionated)? What must NOT leak in from the guide?

FRAMEWORK
- Define the exact, repeated template for documenting one command/flag: name,
  one-line purpose, syntax/usage, each option with type + default + whether
  required, and ONE realistic example with its output. Lock this template so all
  entries are scannable and identical in shape.
- For a log parser, which dimensions recur across commands and must be described
  identically every time (input source: file vs stdin; output format; filtering/
  pattern syntax; how multiple inputs combine)? Factor these into a shared
  "common options / concepts" section so you're not re-explaining them per flag.
- What does the reader most often need that references usually omit — the exact
  pattern/regex dialect, precedence when flags conflict, what happens with no
  args, the meaning of each exit code?

APPLICATION
- Ask me to paste `lumen --help` (and subcommand help) as the source of truth. Do
  not invent flags. If something in the help text is ambiguous, ask rather than
  guess.
- Generate the reference using your locked template. Keep prose to a minimum;
  every example must be runnable and show real output.

CRITIQUE
- Check the result for the three reference killers: (1) inconsistent entry shape,
  (2) a default or type stated vaguely ("optional", "a value") instead of exactly,
  (3) an example that wouldn't actually run. Fix every instance you find.
```

---

## 4. README intro

```
Help me write the opening of the `lumen` README — the part above the fold, before
installation. Think first; write second.

THEORY
- A reader spends seconds deciding whether to keep reading or close the tab. What
  decision are they trying to make, and what do they need from the first 3
  sentences to make it?
- The hardest job of a README intro is positioning: what lumen IS, who it's FOR,
  and crucially what it is NOT / when to reach for something else (grep, jq, awk,
  a full log platform). Why does naming the alternative make the pitch stronger,
  not weaker?
- "Generic mush" in an intro usually means it could describe any tool in the
  category. What is the specific, falsifiable claim that only lumen can make?

FRAMEWORK
- Draft the criteria for a strong intro: concrete (not "powerful/flexible/easy"),
  shows rather than tells, names the exact pain it removes, and earns the reader's
  next 30 seconds. Add a hard rule: ban the adjectives "powerful", "simple",
  "flexible", "lightweight", "modern" unless immediately backed by a concrete fact.
- Identify lumen's wedge: what's the one moment of pain (staring at a wall of
  unstructured log lines) and the one before/after it removes? An intro for a CLI
  tool is strongest when it can SHOW a tiny before→after — what would that be for
  lumen?

APPLICATION
- Ask me for: the one-sentence "what it does", the single most compelling use
  case, and one real input→output pair small enough to fit above the fold.
- Produce three different intros: (a) lead with the one-liner + before/after
  snippet, (b) lead with the pain/problem, (c) lead with the concrete example
  first. Each ≤ 6 lines.

CRITIQUE
- For each version, run the "could this describe any log tool?" test. Strike every
  sentence that survives that test unchanged and replace it with something only
  true of lumen. Then tell me which version is strongest and why.
```

---

### How to get the most out of these

- **Answer the questions it asks back.** Each prompt deliberately stops to ask for `--help` output, real error text, or a sample log. That handoff is where "generic" becomes "about *your* tool." If you skip it, you get a better-structured version of the same mush.
- **Keep the CRITIQUE step.** The self-grading at the end is doing half the work — it's what catches "check your configuration" non-answers and adjective-soup intros before you ever see them.
- **Reuse the locked templates.** Prompts 2 and 3 make the model define a repeated entry shape. Save that shape; it keeps your troubleshooting and reference sections consistent across future edits.
