# koine-demo

The [Remotion](https://www.remotion.dev/) source for the animated demo in the repository
[`README.md`](../../README.md): **one `.koi` model compiling to many targets**.

It's a programmatic video — the same story Koine tells (author declaratively, generate the
artifact), told about itself. Re-render it whenever the language or branding changes; no screen
recording required.

## What it shows

A ~12-second, seamless loop:

1. **Write your domain once** — the Koine mark and tagline.
2. A `Billing.koi` model **types itself in** on the left, with Studio's concept colors
   (value = blue, enum = amber, aggregate = indigo, entity = green).
3. `koine build →` and a compile flash.
4. The **emitted output** lands on the right, and the target chip cycles
   **C# → TypeScript → Python → Rust** over the *same* model.
5. Outro: *One model. Seven languages.* + the "try it in your browser" link.

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
npm run render:gif  # out/koine-demo.gif  (the README embed; halved frame-rate for size)
npm run still       # out/koine-poster.png (a poster frame)
```

Remotion downloads a headless-Chromium shell on the first render.

### Updating the README GIF

The repo README embeds `assets/koine-demo.gif`. To refresh it:

```bash
npm run render:gif
# optionally shrink for the web, then copy into place:
cp out/koine-demo.gif ../../assets/koine-demo.gif
```

Then point the hero `<img>` in the root README at `assets/koine-demo.gif` (it currently falls back
to `assets/koine-studio.png` until the GIF is committed).

## Layout

| File | Purpose |
| --- | --- |
| `src/Root.tsx` | Registers the `KoineDemo` composition (1280×720, 30fps, 360 frames). |
| `src/KoineDemo.tsx` | The timeline: intro → split editor → target cycling → outro. |
| `src/snippets.ts` | The `.koi` source, the per-target output, and a tiny token colorizer. |
| `src/components/CodeBlock.tsx` | Renders tokenized code with an optional typewriter reveal. |
| `src/components/BrandMark.tsx` | The κ-in-hexagon brand mark as inline SVG. |
| `src/palette.ts` | Brand + concept-color palette. |
