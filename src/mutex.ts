import { AsyncLocalStorage } from "node:async_hooks";
import { ProbeError } from "./errors.js";

export type MutexStatus = {
  busy: boolean;
  waiters: number;
  busyOp: string | null;
  busySinceMs: number;
};

export type MutexRunOpts = {
  /** Max time waiting to acquire the lock (not time holding it). */
  waitTimeoutMs?: number;
  /**
   * Max time holding the lock while fn runs. On expiry: reject with
   * APP_LOCK_HOLD_TIMEOUT and release the lock (fn may still run in background).
   * This is what makes session_open recover when Frida detach/spawn never settles
   * but the Node event loop is still alive (other MCP tools still respond).
   */
  holdTimeoutMs?: number;
  /** Label for status.busyOp / error messages */
  op?: string;
};

/**
 * Async mutex with re-entrancy via AsyncLocalStorage.
 * App and SpringBoard each get their own lock so RPCs on different
 * processes can run truly in parallel (Promise.all).
 *
 * Supports waitTimeout (no silent infinite queue) and forceReset for recovery.
 */
export class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();
  private readonly als = new AsyncLocalStorage<boolean>();
  private _busy = false;
  private _busyOp: string | null = null;
  private _busySince = 0;
  private _waiters = 0;
  /** Bumped on forceReset — waiters/holders with old gen skip work and exit. */
  private _gen = 0;
  /** All open slot release fns (holder + waiters); forceReset wakes them. */
  private readonly pendingReleases = new Set<() => void>();

  status(): MutexStatus {
    return {
      busy: this._busy,
      waiters: this._waiters,
      busyOp: this._busyOp,
      busySinceMs: this._busy ? Date.now() - this._busySince : 0,
    };
  }

  /**
   * Emergency unlock: wake every waiter/holder slot, drop busy, bump generation
   * so orphaned holders' later finally is a no-op for busy flags.
   */
  forceReset(): {
    generation: number;
    wasBusy: boolean;
    waitersDropped: number;
    busyOp: string | null;
  } {
    const wasBusy = this._busy;
    const waitersDropped = this._waiters;
    const busyOp = this._busyOp;
    this._gen += 1;
    this._busy = false;
    this._busyOp = null;
    this._busySince = 0;
    this._waiters = 0;
    this.chain = Promise.resolve();
    const releases = [...this.pendingReleases];
    this.pendingReleases.clear();
    for (const release of releases) {
      try {
        release();
      } catch {
        /* ignore */
      }
    }
    return {
      generation: this._gen,
      wasBusy,
      waitersDropped,
      busyOp,
    };
  }

  /**
   * Run fn under this mutex; nested run on same lock (ALS) won't deadlock.
   * If waitTimeoutMs elapses before acquire → APP_LOCK_TIMEOUT (does not run fn).
   */
  run<T>(fn: () => Promise<T>, opts?: MutexRunOpts): Promise<T> {
    if (this.als.getStore()) {
      return fn();
    }

    const op = opts?.op ?? "op";
    const waitTimeoutMs = opts?.waitTimeoutMs;
    const holdTimeoutMs = opts?.holdTimeoutMs;
    const myGen = this._gen;
    this._waiters += 1;

    let settled = false;
    const releaseSlot = () => {
      if (settled) return;
      settled = true;
      this.pendingReleases.delete(releaseSlot);
      resolveSlot();
    };
    let resolveSlot!: () => void;
    const slot = new Promise<void>((resolve) => {
      resolveSlot = resolve;
    });
    this.pendingReleases.add(releaseSlot);

    const prev = this.chain;
    this.chain = prev.then(
      () => slot,
      () => slot,
    );

    const finishWaiterCount = () => {
      this._waiters = Math.max(0, this._waiters - 1);
    };

    return (async () => {
      const turn = prev.then(
        () => undefined,
        () => undefined,
      );

      try {
        if (waitTimeoutMs != null && waitTimeoutMs >= 0) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              turn,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                  reject(
                    new ProbeError(
                      "APP_LOCK_TIMEOUT",
                      `Lock wait timed out after ${waitTimeoutMs}ms (op=${op}, holder=${this._busyOp ?? "unknown"}, busySinceMs=${this._busy ? Date.now() - this._busySince : 0})`,
                      [
                        "session_status",
                        "session_force_unlock",
                        "retry session_open after unlock, or restart MCP process",
                      ],
                    ),
                  );
                }, waitTimeoutMs);
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        } else {
          await turn;
        }
      } catch (e) {
        // Timed out or interrupted: when our turn eventually arrives, free the slot
        // without running fn (unless forceReset already woke everyone).
        void turn.then(() => {
          finishWaiterCount();
          releaseSlot();
        });
        throw e;
      }

      finishWaiterCount();

      if (this._gen !== myGen) {
        releaseSlot();
        throw new ProbeError(
          "APP_LOCK_RESET",
          `Lock was force-reset while waiting (op=${op})`,
          ["session_status", "session_force_unlock", "session_open"],
        );
      }

      this._busy = true;
      this._busyOp = op;
      this._busySince = Date.now();

      let holdTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (this._gen !== myGen) {
          throw new ProbeError(
            "APP_LOCK_RESET",
            `Lock was force-reset before op started (op=${op})`,
            ["session_status", "session_open"],
          );
        }
        const work = this.als.run(true, fn);
        if (holdTimeoutMs == null || holdTimeoutMs < 0) {
          return await work;
        }
        return await Promise.race([
          work,
          new Promise<never>((_resolve, reject) => {
            holdTimer = setTimeout(() => {
              reject(
                new ProbeError(
                  "APP_LOCK_HOLD_TIMEOUT",
                  `Lock hold timed out after ${holdTimeoutMs}ms (op=${op}). Lock will release; background Frida may still run (orphanFridaOpPossible).`,
                  [
                    "session_status",
                    "session_force_unlock",
                    "retry session_open, or restart MCP process",
                  ],
                ),
              );
            }, holdTimeoutMs);
          }),
        ]);
      } finally {
        if (holdTimer) clearTimeout(holdTimer);
        if (this._gen === myGen) {
          this._busy = false;
          this._busyOp = null;
          this._busySince = 0;
        }
        releaseSlot();
      }
    })();
  }
}
