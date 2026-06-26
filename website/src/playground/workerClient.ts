// Id-correlated request/response client over a WorkerLike. Each call posts
// `{ id, method, args }` to the worker and waits for a `{ id, ok, result/error }` reply.
// The worker is injectable via a factory so tests can pass a fake WorkerLike instead of a real
// Worker (happy-dom / node envs have no real Worker). Production code passes a factory that
// constructs the real module worker.
//
// NOTE: This is an intentional, plan-sanctioned copy of the Studio worker client design.
// The website/ and tooling/koine-studio/ are separate Vite build roots; cross-package imports
// would cause `new URL('./koine.worker.ts', import.meta.url)` and `import.meta.env.BASE_URL`
// to resolve against the wrong package root. The plan explicitly permits a playground-local copy.
//
// Cancellation modes:
//   cancel(id)          — SUPERSEDE (soft): drop a pending id from the map; its late reply is
//                         ignored. The promise is rejected with a CancelledError.
//   terminateAndRespawn()
//                       — HARD: reject ALL in-flight calls with CancelledError, terminate the
//                         current worker, spawn a fresh one from the factory, and re-establish
//                         ready state. Each generation has its own ready-promise + boot-timer.
//   call(m, args, { signal })
//                       — Additive AbortSignal integration. Existing callers pass no opts.

/** Wire-protocol request the client posts to the worker. */
export interface WorkerRequest {
  id: number;
  method: string;
  args: unknown[];
}

/** Wire-protocol response the worker posts back to the client. */
export type WorkerResponse =
  | { id: number; ok: true; result: string }
  | { id: number; ok: false; error: string };

/** Wire-protocol boot signals the worker posts (no id — they are broadcasts, not call replies). */
export type WorkerSignal = { type: 'ready' } | { type: 'boot-failure'; error: string };

/** Minimal worker surface required by the client (injectable for tests). */
export interface WorkerLike {
  postMessage(msg: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  terminate(): void;
}

interface PendingCall {
  resolve(result: string): void;
  reject(err: Error): void;
}

/** Options for `WorkerClient.call()`. Additive — existing callers omit entirely. */
export interface CallOptions {
  signal?: AbortSignal;
}

/**
 * A compiler surface booted on the MAIN THREAD, used as the graceful-degradation fallback (#510).
 * Dispatches `call(method, args)` directly — no worker hop. Mirrors the worker's RPC shape so the
 * client can route calls to it transparently once the worker boot has failed.
 */
export type FallbackCall = (method: string, args: unknown[]) => Promise<string>;

/** Options for `createWorkerClient` / `createKoineWorkerClient`. Additive — existing callers omit entirely. */
export interface WorkerClientOptions {
  /**
   * Boot the compiler on the main thread when the worker never reaches `ready` (it hangs past the
   * boot timeout, or posts a `boot-failure`). Resolves to a {@link FallbackCall} the client routes all
   * subsequent `call()`s to. The worker fast-path stays FIRST; this fires only as the safety net, so
   * the common case keeps the UI thread free. When omitted, a failed boot rejects `whenReady()` as before.
   */
  fallbackBoot?: () => Promise<FallbackCall>;
}

/** The public surface of an id-correlated worker client. */
export interface WorkerClient {
  /** Call a named method on the remote runtime, passing positional args. Resolves/rejects with the reply. */
  call(method: string, args: unknown[], opts?: CallOptions): Promise<string>;
  /** Resolves when the worker posts a `ready` signal; rejects on boot-failure or load timeout. */
  whenReady(): Promise<void>;
  /**
   * Supersede (soft cancel): drop `id` from the pending map so its late reply is ignored.
   * The call's promise is rejected with a CancelledError.
   */
  cancel(id: number): void;
  /**
   * Hard cancel: reject ALL in-flight calls with CancelledError, terminate the current worker,
   * spawn a fresh worker from the factory, and re-establish the ready state.
   * `whenReady()` will resolve on the new worker's `ready` signal.
   */
  terminateAndRespawn(): void;
  /** Terminate the underlying worker. */
  dispose(): void;
}

/** Boot-wait timeout (ms). */
const BOOT_TIMEOUT_MS = 30_000;

/** Error thrown when a call is superseded via `cancel()` or `terminateAndRespawn()`. */
export class CancelledError extends Error {
  constructor(message = 'Koine worker call cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

/** The error an aborted call rejects with — the signal's own reason if it carries one, else a generic AbortError. */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('AbortError: The operation was aborted.');
}

/**
 * Create a `WorkerClient` backed by a worker produced by `workerFactory`. The client installs a
 * single `onmessage` handler that demultiplexes replies by `id` and routes `ready`/`boot-failure`
 * signals to the ready promise.
 *
 * @param workerFactory - Called once at construction and again on each `terminateAndRespawn()`.
 * @param options - Additive; `options.fallbackBoot` enables the main-thread fallback (#510).
 */
export function createWorkerClient(
  workerFactory: () => WorkerLike,
  options: WorkerClientOptions = {},
): WorkerClient {
  let nextId = 1;
  const pending = new Map<number, PendingCall>();

  // Set once the main-thread fallback has booted (#510): all subsequent calls route here instead of
  // to the dead worker. Reset at the start of each generation so a `terminateAndRespawn()` re-attempts
  // the worker fast-path.
  let fallbackCall: FallbackCall | null = null;

  // Per-generation ready state. Each respawn resets these.
  let readyResolve!: () => void;
  let readyReject!: (err: Error) => void;
  let readyPromise!: Promise<void>;
  let bootTimer!: ReturnType<typeof setTimeout>;
  let currentWorker!: WorkerLike;
  // Generation counter guards against late messages from terminated workers.
  let generation = 0;

  function startWorkerGeneration(): void {
    const myGeneration = ++generation;
    const worker = workerFactory();
    currentWorker = worker;
    // A fresh generation always re-attempts the worker fast-path: clear any fallback a previous
    // generation installed so calls don't keep routing to a stale main-thread surface (#510).
    fallbackCall = null;
    // The first boot outcome (ready / fallback / reject) wins — guards against the host timeout and a
    // late worker signal both firing for the same generation.
    let bootSettled = false;

    let resolve!: () => void;
    let reject!: (err: Error) => void;
    readyPromise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    readyResolve = resolve;
    readyReject = reject;
    // A respawn (terminateAndRespawn) rejects the OUTGOING generation's readyPromise. After the initial
    // boot, no one is awaiting whenReady(), so that rejection would surface as an unhandled rejection.
    // Attach a no-op catch so an unawaited rejection is swallowed; an external `await client.whenReady()`
    // still observes resolve/reject because whenReady() returns this same `readyPromise`.
    readyPromise.catch(() => {});

    // The worker never reached `ready` (it hung past the boot budget, or posted `boot-failure`). With a
    // `fallbackBoot`, boot the compiler on the main thread and route subsequent calls there so the
    // Playground still works (#510); otherwise reject as before. First outcome wins (idempotent).
    const handleBootFailure = (err: Error): void => {
      if (myGeneration !== generation || bootSettled) return;
      bootSettled = true;
      clearTimeout(bootTimer);
      if (!options.fallbackBoot) {
        reject(err);
        return;
      }
      console.warn(
        `Koine playground: worker compiler boot failed (${err.message}); falling back to the main thread.`,
      );
      // The worker is dead weight now — detach + terminate it so its hung runtime is freed.
      worker.onmessage = null;
      worker.terminate();
      options.fallbackBoot().then(
        (call) => {
          if (myGeneration !== generation) return;
          fallbackCall = call;
          resolve();
        },
        (fallbackErr: unknown) => {
          if (myGeneration !== generation) return;
          reject(fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr)));
        },
      );
    };

    const timer = setTimeout(
      () => handleBootFailure(new Error(`Koine worker timed out after ${BOOT_TIMEOUT_MS / 1000}s`)),
      BOOT_TIMEOUT_MS,
    );
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as NodeJS.Timeout).unref();
    }
    bootTimer = timer;

    worker.onmessage = (ev: { data: unknown }) => {
      if (myGeneration !== generation) return;

      const data = ev.data as WorkerResponse | WorkerSignal;

      if (data && typeof data === 'object' && 'type' in data) {
        const signal = data as WorkerSignal;
        if (signal.type === 'ready') {
          if (bootSettled) return;
          bootSettled = true;
          clearTimeout(bootTimer);
          readyResolve();
        } else if (signal.type === 'boot-failure') {
          // Route through the watchdog/fallback handler so a boot-failure degrades to the main thread
          // when a `fallbackBoot` is supplied, instead of rejecting outright (#510).
          handleBootFailure(new Error(signal.error));
        }
        return;
      }

      const reply = data as WorkerResponse;
      const entry = pending.get(reply.id);
      if (!entry) return;
      pending.delete(reply.id);
      if (reply.ok) {
        entry.resolve(reply.result);
      } else {
        entry.reject(new Error(reply.error));
      }
    };
  }

  startWorkerGeneration();

  function rejectPending(id: number, err: Error): void {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    entry.reject(err);
  }

  function rejectAll(err: Error): void {
    for (const entry of pending.values()) {
      entry.reject(err);
    }
    pending.clear();
  }

  return {
    call(method: string, args: unknown[], opts?: CallOptions): Promise<string> {
      const signal = opts?.signal;

      // Main-thread fallback mode (#510): the worker boot failed, so dispatch directly to the
      // main-thread compiler — no worker hop. Honour an abort so a superseded call still drops its
      // (now-stale) result, mirroring the worker path; the synchronous main-thread compile itself
      // can't be interrupted, but its result is discarded once the signal fires.
      if (fallbackCall) {
        if (signal?.aborted) return Promise.reject(abortReason(signal));
        const result = fallbackCall(method, args);
        if (!signal) return result;
        return new Promise<string>((resolve, reject) => {
          const onAbort = () => reject(abortReason(signal));
          signal.addEventListener('abort', onAbort, { once: true });
          const settle = () => signal.removeEventListener('abort', onAbort);
          result.then(
            (value) => {
              settle();
              resolve(value);
            },
            (err: unknown) => {
              settle();
              reject(err instanceof Error ? err : new Error(String(err)));
            },
          );
        });
      }

      return new Promise<string>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        const req: WorkerRequest = { id, method, args };
        currentWorker.postMessage(req);

        if (signal) {
          if (signal.aborted) {
            rejectPending(id, abortReason(signal));
          } else {
            const onAbort = () => rejectPending(id, abortReason(signal));
            signal.addEventListener('abort', onAbort, { once: true });
          }
        }
      });
    },

    whenReady(): Promise<void> {
      return readyPromise;
    },

    cancel(id: number): void {
      rejectPending(id, new CancelledError());
    },

    terminateAndRespawn(): void {
      clearTimeout(bootTimer);
      rejectAll(new CancelledError('Koine worker call cancelled — worker restarted'));
      // Settle the OUTGOING generation's ready-promise so a caller awaiting whenReady() across a respawn
      // (e.g. a Stop pressed during boot) rejects instead of hanging forever. Must happen BEFORE
      // startWorkerGeneration() reassigns readyReject to the new generation. A no-op if the generation
      // already signalled ready (the common post-boot case — rejecting a settled promise does nothing).
      readyReject(new CancelledError('Koine worker restarted'));
      if (currentWorker) {
        currentWorker.onmessage = null;
        currentWorker.terminate();
      }
      startWorkerGeneration();
    },

    dispose(): void {
      clearTimeout(bootTimer);
      currentWorker.terminate();
    },
  };
}

/**
 * Create a production `WorkerClient` backed by a real module worker at `./koine.worker.ts`.
 * This is the entry point for application code; the injectable form is `createWorkerClient`.
 *
 * @param options - Additive; pass `{ fallbackBoot }` to enable a main-thread fallback when the worker
 *   never boots (#510). Existing no-arg callers are unaffected.
 */
export function createKoineWorkerClient(options: WorkerClientOptions = {}): WorkerClient {
  return createWorkerClient(() => {
    const worker = new Worker(new URL('./koine.worker.ts', import.meta.url), { type: 'module' });
    // A real Worker satisfies WorkerLike at runtime (postMessage / onmessage receiving `{data}` /
    // terminate); the cast bridges the DOM lib's over-specified `MessageEvent`-typed `onmessage`, which
    // structural variance otherwise rejects against our minimal `{ data: unknown }` shape.
    return worker as unknown as WorkerLike;
  }, options);
}
