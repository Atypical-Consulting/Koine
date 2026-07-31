Here's your instruction rewritten as a Socratic prompt. Instead of handing the model a task, it forces the model to first reason about *what makes a cold email actually work*, surface its own quality bar, gather the specifics it's missing, and only then write — followed by a self-critique pass. That sequence is what kills the slop.

---

## The Socratic prompt (paste this)

> You're going to help me write a cold outreach email for my B2B SaaS product — but **do not write any email yet.** Work through these stages in order, showing your reasoning at each one.
>
> **1. Theory — why most cold emails fail.**
> Before anything else, reason from first principles: what actually determines whether a busy decision-maker reads, trusts, and replies to a cold email versus deleting it in two seconds? List the 4–6 underlying forces at play (e.g. relevance/timing, perceived effort, credibility, asymmetric effort of the ask, what makes a stranger's claim believable). For each, state the principle in one sentence. Don't give me email tips yet — give me the *mechanics of attention and trust* that any good cold email has to satisfy.
>
> **2. Framework — turn that theory into decisions.**
> Convert those forces into the concrete decisions this specific email has to get right. At minimum: who exactly is the recipient and what is their job pain (not my product's features); what single, specific outcome am I promising; what evidence makes that promise credible to a skeptic; what is the *one* low-friction next step I'm asking for; and what subject line earns the open. State the rule of thumb for each decision (e.g. "one claim, not a feature list," "the CTA should cost the reader under 30 seconds").
>
> **3. Gather what you're missing.**
> You can't write a non-generic email without specifics. List every input you need from me and where you'd otherwise guess — product, the exact buyer persona and seniority, the trigger/reason I'm reaching out *now*, the quantified result we deliver, one proof point (logo, metric, case study), and the desired action. For anything I haven't given you, either ask me or state the explicit assumption you're making and flag it as a placeholder. **Do not invent fake metrics or customers.**
>
> **4. Write — constrained by everything above.**
> Now write the email. Hard constraints: under 120 words, one clear value claim tied to the recipient's pain, a single specific CTA, no buzzwords ("revolutionize," "seamless," "game-changer," "I hope this email finds you well"), and a subject line under 6 words. Give me 2 variants that differ in *angle* (e.g. pain-led vs. proof-led), not just wording.
>
> **5. Critique your own draft.**
> Score each variant against the framework from step 2. Where is it still generic, presumptuous, or unbelievable? What would make a real buyer ignore it? Then give me the single highest-impact edit for each.

---

## Why this version beats the original

- **It separates thinking from writing.** Steps 1–3 must happen before a single sentence of email exists, so the model commits to *criteria* before it commits to *prose* — the opposite of pattern-matching a template.
- **It makes the model surface its own quality bar** (the "theory" and "framework" stages) instead of you having to supply one. The email is then judged against a standard the model itself articulated.
- **It exposes the missing information** rather than papering over it with confident-sounding filler. The single biggest source of cold-email slop is the model not knowing your buyer, product, or proof — step 3 makes that gap explicit and bans invented proof.
- **The self-critique loop** catches the generic phrasing the first draft will still contain.

**One thing to add before running it:** the prompt is reusable, but it'll produce far better output if you front-load the specifics from step 3 — product, exact buyer, the "why now" trigger, your one real metric, and one proof point. Give it those and the reasoning stages sharpen the email instead of just exposing the unknowns.
