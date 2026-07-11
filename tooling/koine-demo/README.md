# koine-demo

The [Remotion](https://www.remotion.dev/) source for the animated demo in the repository
[`README.md`](../../README.md): **write the domain, not the boilerplate**.

It's a programmatic video — the same story Koine tells (author declaratively, generate the
artifact), told about itself. Re-render it whenever the language or branding changes; no screen
recording required.

## What it shows

A ~14-second, seamless loop:

1. **Write the domain. Not the boilerplate.** — the hook.
2. An `ordering.koi` model **types itself in** on the left, with Studio's concept colors
   (value = blue, enum = amber, aggregate = indigo, entity = green, event = pink).
3. **The assembly line** — `koine build` fires, a highlight sweep walks the source
   construct by construct, and each one stamps a labeled file card onto the right-hand
   wall (with a peek of its real emitted lines) while a live counter ticks up.
4. **The number** — `25 lines of Koine → 11 files · 365 lines of C# · 0 written by you`.
5. Outro: *The same model. Seven languages.* — target chips fan out, then the
   "try it in your browser" link.

### The numbers are real

`src/snippets.ts` holds the **exact** `.koi` source shown on screen, and every count in the
video (per-file line counts, 11 files, 365 lines) comes from actually compiling that source
with the real CLI:

```bash
dotnet run --project ../../src/Koine.Cli -- build ordering.koi --target csharp --out ./out
```

The peek lines on each card are verbatim lines from the emitted C#. **If you edit the
on-screen source, re-run the compile and update `GEN_FILES` + `KOI_LINE_COUNT`** so the
video never advertises numbers the compiler doesn't produce.

## Develop

```bash
npm install         # run from THIS folder — see "Standalone package" below
npm run studio      # open the Remotion preview at http://localhost:3000
```

Everything is self-contained — no external fonts, images, or network calls — so renders are
deterministic.

> **Standalone package.** Unlike the other `tooling/*` folders, `koine-demo` is deliberately
> **excluded from the root npm workspace** (`"!tooling/koine-demo"` in the root `package.json`).
> Remotion's dependency tree is large and only needed to re-render a video, so keeping it out of the
> root lockfile avoids bloating every contributor's install. Run `npm install` from *inside* this
> folder; it keeps its own `node_modules` and `package-lock.json`.

> **If bundling fails** with an esbuild binary error, your npm may have skipped esbuild's install
> script (npm's `allow-scripts` policy). Run it once: `node node_modules/esbuild/install.js`.

## Render

```bash
npm run render      # out/koine-demo.mp4  (docs site / social cards)
npm run render:gif  # out/koine-demo.gif  (the README embed: 960×540 · 15fps · dither=none — needs ffmpeg)
npm run still       # out/koine-poster.png (a poster frame — "the number" beat)
```

Remotion downloads a headless-Chromium shell on the first render. `render:gif` renders the MP4
and then runs an ffmpeg palette pass (`fps=15,scale=960:540`, 128 colors, `dither=none`) — the
smallest artifact that still reads; the flat panel-and-code palette needs no dithering.

### Updating the README GIF

The repo README embeds `assets/koine-demo.gif`. To refresh it:

```bash
npm run render:gif
cp out/koine-demo.gif ../../assets/koine-demo.gif
```

## Layout

| File | Purpose |
| --- | --- |
| `src/Root.tsx` | Registers the `KoineDemo` composition (1280×720, 30fps, 432 frames). |
| `src/KoineDemo.tsx` | The timeline: hook → type-in → assembly line → the number → polyglot outro. |
| `src/snippets.ts` | The exact on-screen `.koi` source, the real generated-file data, and a tiny token colorizer. |
| `src/components/CodeBlock.tsx` | Renders tokenized code with an optional typewriter reveal. |
| `src/components/BrandMark.tsx` | The κ-in-hexagon brand mark as inline SVG. |
| `src/palette.ts` | Brand + concept-color palette. |
