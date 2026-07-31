# 3 Socratic prompts for improving `SignupForm.razor`

These are written to be pasted into an AI alongside your component. Each one forces the model to
**reason from principles and inspect your actual markup before suggesting fixes**, rather than
spitting out a generic "add ARIA labels" checklist. To make them work, paste the component first,
then the prompt.

Here's the component they're anchored to, so the references are concrete:

```razor
<div class="signup">
    <div class="title">Sign up</div>

    <input @bind="Email" placeholder="email" />
    <input @bind="Password" type="password" placeholder="password" />
    <input @bind="Confirm" type="password" placeholder="repeat password" />

    @if (HasError)
    {
        <div class="err">Error</div>
    }

    <div class="btn" @onclick="Submit">Go</div>
</div>
```

---

## Prompt 1 — The `<div>`s that are pretending to be a form and a button

> In `SignupForm.razor`, the whole thing is a `<div class="signup">`, the heading is a
> `<div class="title">`, and the submit control is `<div class="btn" @onclick="Submit">Go</div>` —
> there is no `<form>`, no `<h1>`, and no `<button>`.
>
> Before you rewrite anything, reason it through out loud:
> 1. What does a browser and an assistive technology (screen reader, keyboard, voice control)
>    actually *do* with a real `<form>`, `<button type="submit">`, and a heading that it does **not**
>    do with these divs? Name the specific capabilities that are silently lost here — think about
>    Enter-to-submit, focusability and tab order, the Space/Enter activation contract, the accessible
>    role announced, and document landmarks/headings navigation.
> 2. If I insisted on keeping divs, what is the *full* set of attributes and handlers I'd have to add
>    by hand to fake one accessible button (role, tabindex, keydown for Enter **and** Space, etc.)?
>    Walk me through it so I can see why that's a worse deal than just using the native elements.
> 3. Now rewrite this section using semantic HTML (`<form>`, a real heading, `<button>`), wired to
>    Blazor's `EditForm`/`@onsubmit` model. Show the diff and, for each change, tell me which concrete
>    failure from step 1 it fixes.

---

## Prompt 2 — Placeholders are doing the job that labels should do

> Look at the three inputs in `SignupForm.razor`. Each one's only description is a `placeholder`
> (`placeholder="email"`, `placeholder="password"`, `placeholder="repeat password"`), and the email
> field is a plain `<input>` with no `type`, no `autocomplete`, and no `required`.
>
> Don't jump to a fix yet — establish the criteria first:
> 1. Explain *why* a placeholder is not an accessible label. What happens to a user (sighted,
>    low-vision, screen-reader, someone who has started typing, someone using autofill) at each
>    moment of the interaction when the only descriptive text is a placeholder that vanishes on input?
> 2. Define what "this field is correctly described and machine-understood" means as a checklist for a
>    signup form specifically — covering the visible-label-to-input association, programmatic name,
>    the right `type` for email vs password, and the `autocomplete` tokens a password manager and
>    browser actually expect for new-account email / new password / confirm password.
> 3. Apply that checklist to my three fields and rewrite them in Blazor. For each input, state which
>    checklist item it was failing and what the fix gives the user.

---

## Prompt 3 — "Error" tells nobody anything

> The validation in `SignupForm.razor` is: if the email is blank **or** the passwords don't match,
> set `HasError = true`, which renders `<div class="err">Error</div>`. Two different problems collapse
> into one word, and the message just appears in the DOM.
>
> Reason about the feedback design before touching the code:
> 1. Put yourself in the user's seat for each failure path (empty email; mismatched passwords) — what
>    do they need to know, *where* should that information live, and how would they even discover the
>    message exists if they can't see the screen? Consider that a `<div>` quietly appearing is not
>    announced to a screen reader, and a single generic string can't point at the field that's wrong.
> 2. From that, derive the properties a good error-feedback system for this form must have: per-field
>    vs form-level messaging, a specific human-readable message per failure, programmatic association
>    between a message and its field, live-region announcement so it's spoken when it appears, and
>    moving focus to the first problem. Lay these out as your evaluation criteria.
> 3. Now redesign the validation and rendering against those criteria — using Blazor's validation
>    where it fits (`EditContext`, `ValidationMessage`, `role="alert"`/`aria-live`,
>    `aria-describedby`, `aria-invalid`). Show the new code and map each criterion from step 2 to the
>    line that satisfies it. Where my current `Submit` logic has to change, explain why.

---

### How to get the most out of these

- Paste the component **above** the prompt every time — all three deliberately quote your real
  identifiers (`class="btn"`, `placeholder="repeat password"`, `HasError`, `Submit`) so the model
  stays anchored to your code instead of answering in the abstract.
- If the AI skips the reasoning steps and goes straight to a rewrite, push back with: "You skipped
  step 1 — answer it before you show me any code." The reasoning is the point; it's what stops the
  output from being a generic accessibility listicle.
