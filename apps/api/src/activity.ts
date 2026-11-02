/**
 * What the interactive work is doing right now, in this process (docs/P2.2.md §5 "One queue"): question generation
 * and the checks after it. A PDF conversion waits until both are idle, so a creator who is generating never shares the
 * vision model's endpoint with a book.
 */
let interactive = 0;
const waiters: (() => void)[] = [];

export async function trackInteractive<T>(fn: () => Promise<T>): Promise<T> {
  interactive++;
  try {
    return await fn();
  } finally {
    interactive--;
    if (interactive === 0) for (const w of waiters.splice(0)) w();
  }
}

export const interactiveBusy = () => interactive > 0;

/** Resolves once nothing interactive is running (at once if that's now). */
export function whenInteractiveIdle(signal?: AbortSignal): Promise<void> {
  if (interactive === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => resolve();
    waiters.push(done);
    signal?.addEventListener("abort", () => {
      const i = waiters.indexOf(done);
      if (i >= 0) waiters.splice(i, 1);
      reject(signal.reason);
    });
  });
}
