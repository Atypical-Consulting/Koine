# Starlight Starter Kit: Basics

[![Built with Starlight](https://astro.badg.es/v2/built-with-starlight/tiny.svg)](https://starlight.astro.build)

```
npm create astro@latest -- --template starlight
```

> 🧑‍🚀 **Seasoned astronaut?** Delete this file. Have fun!

## ⚠️ Playground wasm worker — never assign `self.onmessage` at top level

The landing-page **Playground** runs the Koine compiler as a `Koine.Wasm` .NET WebAssembly module
inside a dedicated **Web Worker** (`src/playground/koine.worker.ts`, booted by `workerClient.ts`).
There is **one hard rule** for that worker:

> The worker MUST install its message loop via `self.addEventListener('message', …)` **after**
> `dotnet.create()` resolves — **never** as a top-level `self.onmessage = …`.

Assigning `self.onmessage` synchronously at worker startup **clobbers the `message` channel the .NET
WebAssembly runtime installs while `dotnet.create()` boots inside a Worker**. The boot then deadlocks:
`import(dotnet.js)` resolves but `dotnet.create()` never settles (no `ready`, no `boot-failure`), so
the host waits out its 30 s timer and the Playground reports **`Koine worker timed out after 30s`**.

This is the exact Studio bug **#357 / #358** (see
`tooling/koine-studio/src/host/browser/koine.worker.ts`), and it was re-introduced on this website
copy as **#492** because the worker was copied from the pre-fix Studio design. The rule is enforced two
ways so it can't silently regress again:

- **`src/playground/worker-handler.test.ts`** — a source guard that fails the unit build if the worker
  ever installs a top-level `self.onmessage =` or stops using `addEventListener('message', …)`.
- **`scripts/smoke-boot.mjs`** (`npm run test:browser`) — a headless-Chromium boot test that loads the
  **built** landing page and asserts the compiler worker reaches `ready` and round-trips a compile.
  It is wired into `.github/workflows/deploy-docs.yml` as a gate, so a non-booting worker can never
  ship to GitHub Pages. (The Playground's vitest unit tests mock the worker, so they cannot catch a
  boot hang on their own — this browser gate is what does.)

## 🚀 Project Structure

Inside of your Astro + Starlight project, you'll see the following folders and files:

```
.
├── public/
├── src/
│   ├── assets/
│   ├── content/
│   │   └── docs/
│   └── content.config.ts
├── astro.config.mjs
├── package.json
└── tsconfig.json
```

Starlight looks for `.md` or `.mdx` files in the `src/content/docs/` directory. Each file is exposed as a route based on its file name.

Images can be added to `src/assets/` and embedded in Markdown with a relative link.

Static assets, like favicons, can be placed in the `public/` directory.

## 🧞 Commands

All commands are run from the root of the project, from a terminal:

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `npm install`             | Installs dependencies                            |
| `npm run dev`             | Starts local dev server at `localhost:4321`      |
| `npm run build`           | Build your production site to `./dist/`          |
| `npm run preview`         | Preview your build locally, before deploying     |
| `npm run astro ...`       | Run CLI commands like `astro add`, `astro check` |
| `npm run astro -- --help` | Get help using the Astro CLI                     |

## 👀 Want to learn more?

Check out [Starlight’s docs](https://starlight.astro.build/), read [the Astro documentation](https://docs.astro.build), or jump into the [Astro Discord server](https://astro.build/chat).
