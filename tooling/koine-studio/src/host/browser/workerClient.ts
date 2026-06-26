// Id-correlated request/response client over a WorkerLike. Each call posts
// `{ id, method, args }` to the worker and waits for a `{ id, ok, result/error }` reply.
// The worker is injectable via a factory so tests can pass a fake WorkerLike instead of a real
// Worker (happy-dom has no real Worker). Production code passes a factory that constructs the
// real module worker (`new Worker(new URL('./koine.worker.ts', import.meta.url), { type: 'module' })`).
//
// Cancellation modes:
//   cancel(id)          — SUPERSEDE (soft): drop a pending id from the map; its late reply is
//                         ignored. The promise is rejected with a CancelledError. No worker respawn.
//   terminateAndRespawn()
//                       — HARD: reject ALL in-flight pending ids with CancelledError, terminate()
//                         the current worker, build a FRESH worker from the factory, and re-establish
//                         the ready state. Each worker generation has its own ready-promise + boot-
//                         timer so stale timers never fire on the wrong generation.
//   call(m, args, { signal })
//                       — Additive AbortSignal integration: if the signal aborts, the call is
//                         superseded (cancel(id)) and its promise rejects with an abort error.
//                         Existing callers pass no opts — unchanged.

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

/** Boot-wait timeout (ms) — mirrors the 30 s safety-net in wasm.ts. */
const BOOT_TIMEOUT_MS = 30_000;

/** Error thrown when a call is superseded via `cancel()` or `terminateAndRespawn()`. */
export class CancelledError extends Error {
  constructor(message = 'Koine worker call cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

/**
 * Create a `WorkerClient` backed by a worker produced by `workerFactory`. The client installs a
 * single `onmessage` handler that demultiplexes replies by `id` and routes `ready`/`boot-failure`
 * signals to the ready promise.
 *
 * @param workerFactory - Called once at construction and again on each `terminateAndRespawn()`.
 *   Production: `() => new Worker(new URL('./koine.worker.ts', import.meta.url), { type: 'module' })`
 *   Tests: `() => makeFakeWorker()`
 */
export function createWorkerClient(workerFactory: () => WorkerLike): WorkerClient {
  let nextId = 1;
  const pending = new Map<number, PendingCall>();

  // ---- Per-generation ready state ----
  // Each worker generation (initial + each respawn) has its own ready-promise and boot-timer.
  // On respawn the old timer is cleared before the new one is started.
  let readyResolve!: () => void;
  let readyReject!: (err: Error) => void;
  let readyPromise!: Promise<void>;
  let bootTimer!: ReturnType<typeof setTimeout>;
  let currentWorker!: WorkerLike;
  // Track which worker generation owns the current onmessage handler so late messages from a
  // terminated generation are ignored (the old worker's onmessage is nulled on respawn).
  let generation = 0;

  function startWorkerGeneration(): void {
    const myGeneration = ++generation;
    const worker = workerFactory();
    currentWorker = worker;

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

    // Safety-net: if the worker never signals ready, reject after the timeout.
    const timer = setTimeout(() => {
      reject(new Error(`Koine worker timed out after ${BOOT_TIMEOUT_MS / 1000}s`));
    }, BOOT_TIMEOUT_MS);
    // Prevent Node.js from keeping the process alive during tests.
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as NodeJS.Timeout).unref();
    }
    bootTimer = timer;

    worker.onmessage = (ev: { data: unknown }) => {
      // Guard: ignore messages from a superseded generation.
      if (myGeneration !== generation) return;

      const data = ev.data as WorkerResponse | WorkerSignal;

      // Boot signals (no `id` field).
      if (data && typeof data === 'object' && 'type' in data) {
        const signal = data as WorkerSignal;
        clearTimeout(bootTimer);
        if (signal.type === 'ready') {
          readyResolve();
        } else if (signal.type === 'boot-failure') {
          readyReject(new Error(signal.error));
        }
        return;
      }

      // Call replies (have `id` field).
      const reply = data as WorkerResponse;
      const entry = pending.get(reply.id);
      if (!entry) return; // stale / unknown id — ignore (includes superseded calls)
      pending.delete(reply.id);
      if (reply.ok) {
        entry.resolve(reply.result);
      } else {
        entry.reject(new Error(reply.error));
      }
    };
  }

  // Boot the initial worker generation.
  startWorkerGeneration();

  // ---- Internal helpers ----

  /** Reject and remove one pending entry. */
  function rejectPending(id: number, err: Error): void {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    entry.reject(err);
  }

  /** Reject ALL pending entries with `err` and clear the map. */
  function rejectAll(err: Error): void {
    for (const entry of pending.values()) {
      entry.reject(err);
    }
    pending.clear();
  }

  // ---- Public API ----

  return {
    call(method: string, args: unknown[], opts?: CallOptions): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        const req: WorkerRequest = { id, method, args };
        currentWorker.postMessage(req);

        // AbortSignal integration — additive; existing callers pass no opts.
        const signal = opts?.signal;
        if (signal) {
          if (signal.aborted) {
            // Already aborted: supersede immediately.
            rejectPending(id, signal.reason instanceof Error ? signal.reason : new Error('AbortError: The operation was aborted.'));
          } else {
            const onAbort = () => {
              rejectPending(id, signal.reason instanceof Error ? signal.reason : new Error('AbortError: The operation was aborted.'));
            };
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
      // Clear the current boot-timer so it doesn't fire on the old ready-promise.
      clearTimeout(bootTimer);

      // Reject all in-flight calls.
      rejectAll(new CancelledError('Koine worker call cancelled — worker restarted'));

      // Settle the OUTGOING generation's ready-promise so a caller awaiting whenReady() across a respawn
      // (e.g. a Stop pressed during boot) rejects instead of hanging forever. Must happen BEFORE
      // startWorkerGeneration() reassigns readyReject to the new generation. A no-op if the generation
      // already signalled ready (the common post-boot case — rejecting a settled promise does nothing).
      readyReject(new CancelledError('Koine worker restarted'));

      // Null out the old worker's message handler to prevent late messages from being processed
      // after the generation guard would catch them. Belt-and-suspenders: the generation counter
      // in the closure already guards this, but nulling is cheaper than the runtime check.
      if (currentWorker) {
        currentWorker.onmessage = null;
        currentWorker.terminate();
      }

      // Boot a fresh worker generation. This resets readyPromise, readyResolve, readyReject,
      // bootTimer, currentWorker, and increments `generation`.
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
 */
export function createKoineWorkerClient(): WorkerClient {
  return createWorkerClient(() => {
    const worker = new Worker(new URL('./koine.worker.ts', import.meta.url), { type: 'module' });
    // A real Worker satisfies WorkerLike at runtime (postMessage / onmessage receiving `{data}` /
    // terminate); the cast bridges the DOM lib's over-specified `MessageEvent`-typed `onmessage`, which
    // structural variance otherwise rejects against our minimal `{ data: unknown }` shape.
    return worker as unknown as WorkerLike;
  });
}
