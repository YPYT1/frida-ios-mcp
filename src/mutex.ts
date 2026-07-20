import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Async mutex with re-entrancy via AsyncLocalStorage.
 * App and SpringBoard each get their own lock so RPCs on different
 * processes can run truly in parallel (Promise.all).
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  private readonly als = new AsyncLocalStorage<boolean>();

  /** Run fn under this mutex; nested withApp/withSb on same lock won't deadlock. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.als.getStore()) {
      return fn();
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.tail;
    this.tail = prev.then(() => gate);
    return prev.then(() =>
      this.als.run(true, async () => {
        try {
          return await fn();
        } finally {
          release();
        }
      }),
    );
  }
}
