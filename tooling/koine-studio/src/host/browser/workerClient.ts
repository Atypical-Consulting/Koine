// Id-correlated request/response client over a WorkerLike. Each call posts
// `{ id, method, args }` to the worker and waits for a `{ id, ok, result/error }` reply.
// The worker is injectable so tests can pass a fake WorkerLike instead of a real Worker
// (happy-dom has no real Worker). Production code constructs the real module worker
// (`new Worker(new URL('./koine.worker.ts', import.meta.url), { type: 'module' })`)
// and passes it into `createWorkerClient`.

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

/** The public surface of an id-correlated worker client. */
export interface WorkerClient {
  /** Call a named method on the remote runtime, passing positional args. Resolves/rejects with the reply. */
  call(method: string, args: unknown[]): Promise<string>;
  /** Resolves when the worker posts a `ready` signal; rejects on boot-failure or load timeout. */
  whenReady(): Promise<void>;
  /** Terminate the underlying worker. */
  dispose(): void;
}

/** Boot-wait timeout (ms) — mirrors the 30 s safety-net in wasm.ts. */
const BOOT_TIMEOUT_MS = 30_000;

/**
 * Create a `WorkerClient` backed by `worker`. The client installs a single `onmessage` handler
 * that demultiplexes replies by `id` and routes `ready`/`boot-failure` signals to the ready promise.
 *
 * @param worker - A real `Worker` (production) or a fake `WorkerLike` (tests).
 */
export function createWorkerClient(worker: WorkerLike): WorkerClient {
  let nextId = 1;
  const pending = new Map<number, PendingCall>();

  let readyResolve!: () => void;
  let readyReject!: (err: Error) => void;
  const readyPromise = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });

  // Safety-net: if the worker never signals ready, reject after the timeout.
  const bootTimer = setTimeout(() => {
    readyReject(new Error(`Koine worker timed out after ${BOOT_TIMEOUT_MS / 1000}s`));
  }, BOOT_TIMEOUT_MS);
  // Prevent Node.js from keeping the process alive during tests.
  if (typeof bootTimer === 'object' && bootTimer !== null && 'unref' in bootTimer) {
    (bootTimer as NodeJS.Timeout).unref();
  }

  worker.onmessage = (ev: { data: unknown }) => {
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
    if (!entry) return; // stale / unknown id — ignore
    pending.delete(reply.id);
    if (reply.ok) {
      entry.resolve(reply.result);
    } else {
      entry.reject(new Error(reply.error));
    }
  };

  return {
    call(method: string, args: unknown[]): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        const req: WorkerRequest = { id, method, args };
        worker.postMessage(req);
      });
    },

    whenReady(): Promise<void> {
      return readyPromise;
    },

    dispose(): void {
      worker.terminate();
    },
  };
}

/**
 * Create a production `WorkerClient` backed by a real module worker at `./koine.worker.ts`.
 * This is the entry point for application code; the injectable form is `createWorkerClient`.
 */
export function createKoineWorkerClient(): WorkerClient {
  const worker = new Worker(new URL('./koine.worker.ts', import.meta.url), { type: 'module' });
  return createWorkerClient(worker);
}
