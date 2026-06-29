---
name: socratic-prompts
description: >-
  Turn a task or instruction into Socratic prompts — questions structured as
  theory → framework → application that make the model surface its own quality
  criteria and reason before producing output, instead of jumping straight to a
  generic answer. Use whenever the user wants to write, design, or upgrade a
  prompt this way, and especially when they mention "Socratic prompt(s)",
  "Socratic prompting/method", turning an instruction into questions, making a
  prompt "think/reason first", or getting sharper, less generic LLM output —
  including loose phrasings like "rewrite this prompt so the AI reasons first",
  "give me N Socratic prompts about X", "make this prompt sharper", or pasting an
  instruction-style prompt and asking to upgrade it. Does NOT cover actually
  executing the underlying task — only crafting the prompt(s).
---

# Socratic prompts

## Why this works (the mental model)

A flat instruction — "Write a value proposition for my analytics tool" — invites the
model to jump straight to producing text. It never pauses to decide what *good* looks
like, so it regresses to the blandest, most average version of the thing: slop.

A Socratic prompt withholds the instruction and asks **questions first**. "What makes a
value proposition convincing for B2B buyers? Which emotional and logical levers must it
pull? Now apply that to an AI analytics tool." Before writing a single word of output,
the model has to surface the *quality criteria*, choose a *framework*, and only then
*apply* it. The answer is reasoned, not reflexive.

The mechanism is simple: **a question makes the model articulate the rubric it will then
grade its own output against.** An instruction skips that step. You are not adding
politeness or padding — you are forcing the reasoning that separates a 9/10 answer from a
6/10 one.

So your job with this skill is **not** to do the underlying task. It is to craft the
prompt(s) — the questions — that will make some later model do the task well.

## The shape: theory → framework → application

Every Socratic prompt is three moves, in order. Each does a specific job:

1. **Theory question** — targets the *quality criteria* of the output.
   "What makes an effective `[type of output]`?" / "What separates a great `[X]` from a
   forgettable one?" This forces the model to define success before chasing it.

2. **Framework question** — pulls in *named, real* principles or frameworks for the
   domain. "Which principles or frameworks apply here — `[name 2–4 real ones]`?" This is
   where your domain knowledge earns its keep: a good framework question names the actual
   levers (heuristics, laws, models) so the model reasons with tools, not vibes.

3. **Application question** — grounds it in the user's *specific* task.
   "Now apply this to `[the concrete thing]`." This is where abstraction becomes a
   deliverable.

Optionally, a fourth move sharpens hard tasks:

4. **Tradeoff / critique question** — "Where does this approach fail, and what would you
   deliberately sacrifice?" Use it when the task has real tension (speed vs. rigor,
   breadth vs. depth). Skip it when it would just pad the prompt.

The reusable skeleton:

> *What makes an effective `[type of output]`?* → *Which principles / frameworks apply?* →
> *Now apply them to `[the user's specific task]`.*

## How to build one

1. **Name the output type and domain.** "A value proposition" / "an onboarding flow" /
   "an IDE panel layout." This is what the theory question will interrogate.

2. **Write the theory question so it constrains quality**, not just "what is an X." Ask
   what makes one *effective / convincing / intuitive / safe* — an adjective that implies
   a bar to clear. "What makes an onboarding flow create an *aha moment*?" beats "What is
   onboarding?"

3. **Write the framework question with real, specific levers.** Name 2–4 genuine
   principles for the domain — this is the highest-value part of the prompt. Don't write
   "what are best practices"; write "Hick's Law, information scent, progressive
   disclosure." If you're unsure of the right frameworks for a domain, that's a cue to
   look them up rather than hand-wave. Generic framework questions produce generic answers.

4. **Write the application question against the user's actual task.** The more concrete,
   the better the output.

5. **Decide whether the tradeoff move earns its place.** Add it only when the task has
   genuine tension worth forcing the model to confront.

## Auto-anchoring (default behavior)

The application question is far more powerful when it points at something **real** rather
than a `[placeholder]`. So by default:

- **If a real codebase, product, document, or screen is in context** (the user is working
  in a repo, has pasted a file, named a product), ground the application question in it —
  name the actual files, screens, components, or modules. A prompt that says "apply this
  to Studio's three-zone shell (left rail · center editor · right rail)" is immediately
  actionable; one that says "apply this to `[my product]`" is not. When you do this, say
  so, and offer to read the real artifacts to anchor even harder ("I can read the actual
  layout code and turn these into grounded prompts").

- **If no concrete context exists**, use `[bracketed placeholders]` and tell the user to
  fill them in. Keep the prompt portable.

Never invent specifics you can't see. Anchor to what's genuinely in context; otherwise
leave an honest placeholder.

## Producing a set

Users often ask for several prompts at once ("give me 5 Socratic prompts about UX"). The
value is **coverage, not repetition**: each prompt should attack a *distinct facet* of the
subject, not rephrase the same question.

- Decompose the subject into non-overlapping sub-areas first (for UX: information
  architecture, onboarding, visual hierarchy, error states, accessibility…), then write
  one prompt per facet.
- Give each prompt a short bold label naming its facet, so the set reads as a map of the
  territory.
- If the user later asks "which should I run first?", order them by altitude: the
  prompt that *frames* the others (the highest-leverage, most foundational decision)
  goes first, because its answer changes the others.

## Quality bar — avoid these

- **Instruction-with-a-question-mark.** "Can you write a value prop?" is not Socratic —
  it's an instruction wearing a costume. A real Socratic question opens a space of
  reasoning the model must work through.
- **Vacuous theory questions.** "What is a good X?" with no quality adjective lets the
  model answer trivially. Make the bar explicit.
- **Framework name-dropping.** Listing frameworks that don't actually apply is worse than
  naming none — it sends the reasoning down a wrong path. Name levers that are real for
  the domain.
- **Chains too long.** Five stacked questions exhaust the model's attention before it
  answers. Three focused moves (plus an optional fourth) is the sweet spot.
- **Doing the task instead of writing the prompt.** This skill produces *prompts*. Unless
  the user explicitly asks you to also answer them, stop at the questions.

## Examples

**Example 1 — single prompt, generic (no real context)**
Input: "Help me prompt for a value proposition for my AI analytics tool."
Output:
> What makes a value proposition genuinely convincing for B2B buyers — which emotional
> levers (risk, status, relief from pain) and logical levers (ROI, time saved,
> defensibility) must it pull? Which frameworks apply (jobs-to-be-done, the value-prop
> canvas, before/after/bridge)?
> Now apply that to an AI analytics tool aimed at `[your buyer]`, leading with the single
> pain it removes.

**Example 2 — one facet of a set, auto-anchored to a real product**
Input (user is working in the Koine Studio repo): "Give me a Socratic prompt about the
IDE's panel layout."
Output:
> **Three-zone shell & spatial stability** — What makes a multi-pane IDE layout feel calm
> and predictable rather than busy? Which principles govern where the eye expects tools to
> live — spatial memory, the F-pattern, the primacy of the center work surface, the cost
> of permanent chrome — and how do progressive disclosure and "content over chrome" apply
> to a desktop IDE?
> Now apply this to Studio's three-zone shell (left rail · center editor/canvas · right
> rail): which zone is earning its permanent real estate, and which should collapse or
> merge?

**Example 3 — turning a flat instruction the user pasted into a Socratic version**
Input: "Rewrite this so the AI reasons first: 'Write error messages for my app.'"
Output:
> What makes an error message *helpful* rather than frustrating? Which principles separate
> a good one from a wall of jargon — Nielsen's heuristics on visibility of status and
> error recovery, an empathetic tone, a single clear corrective action?
> Now apply these to rewrite `[my app]`'s error messages so each states *what happened*,
> *why*, and *what to do next*.

## How to present the result

- Open with one line of framing only if it adds something; don't pad.
- Render each prompt as a labeled item; put the question chain in a blockquote so it's
  copy-pasteable.
- For a set, end with the reusable skeleton so the user can generate more themselves.
- If you anchored to real context, offer to go deeper (read the real files and harden the
  prompts). If you used placeholders, point out which ones to fill in.
