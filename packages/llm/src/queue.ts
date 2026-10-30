/**
 * The per-endpoint queue (SPEC §3B.2, P1.5.md §5): at most `concurrency` calls in flight, round-robin
 * across caller keys, FIFO within a key. Waiting is unbounded but cancellable. In-process: one API instance.
 */

interface Waiter {
  start(): void;
  cancel(reason: unknown): void;
}

export class EndpointQueue {
  private inFlight = 0;
  /** A key is removed when it has nothing waiting. */
  private readonly waiting = new Map<string, Waiter[]>();
  private lastKey: string | undefined;

  constructor(readonly concurrency: number) {}

  /** Runs `fn` when a slot is free for `key`; rejects with the signal's reason if aborted while queued. */
  run<T>(key: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => waiter.cancel(signal?.reason);
      const waiter: Waiter = {
        start: () => {
          signal?.removeEventListener("abort", onAbort);
          this.inFlight++;
          fn()
            .then(resolve, reject)
            .finally(() => {
              this.inFlight--;
              this.pump();
            });
        },
        cancel: (reason) => {
          this.remove(key, waiter);
          reject(reason);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const list = this.waiting.get(key);
      if (list) list.push(waiter);
      else this.waiting.set(key, [waiter]);
      this.pump();
    });
  }

  private remove(key: string, waiter: Waiter) {
    const list = this.waiting.get(key);
    if (!list) return;
    list.splice(list.indexOf(waiter), 1);
    if (list.length === 0) this.waiting.delete(key);
  }

  /** Every key seen since the queue last drained, in arrival order: the round-robin order. */
  private order: string[] = [];

  /** The next key after the last one served that has something waiting, wrapping around. */
  private nextKey(): string | undefined {
    const from = this.lastKey === undefined ? 0 : this.order.indexOf(this.lastKey) + 1;
    return [...this.order.slice(from), ...this.order.slice(0, from)].find((k) => this.waiting.has(k));
  }

  private pump() {
    for (const k of this.waiting.keys()) if (!this.order.includes(k)) this.order.push(k);
    while (this.inFlight < this.concurrency && this.waiting.size > 0) {
      const key = this.nextKey();
      if (key === undefined) return;
      const list = this.waiting.get(key);
      const waiter = list?.[0];
      if (!waiter) return;
      this.remove(key, waiter);
      this.lastKey = key;
      waiter.start();
    }
    if (this.waiting.size === 0 && this.inFlight === 0) {
      this.order = [];
      this.lastKey = undefined;
    }
  }
}

/** One queue per endpoint; a changed `concurrency` builds a new one (calls in the old one still finish). */
export class QueueRegistry {
  private readonly queues = new Map<string, EndpointQueue>();

  for(endpointId: string, concurrency: number): EndpointQueue {
    const existing = this.queues.get(endpointId);
    if (existing?.concurrency === concurrency) return existing;
    const queue = new EndpointQueue(concurrency);
    this.queues.set(endpointId, queue);
    return queue;
  }
}
