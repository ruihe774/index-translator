// Single-slot FIFO: one generation runs at a time, a bounded number wait behind it.

export class QueueFullError extends Error {
  override name = "QueueFullError";
  constructor() {
    super("translation queue is full");
  }
}

export interface Ticket {
  /**
   * Settles once: `true` when this ticket owns the slot, `false` when it left while still waiting.
   * Never rejects, so nobody has to handle it when they stop waiting.
   */
  ready: Promise<boolean>;
  /** Give up the slot or the place in line. Safe to call more than once. */
  leave(): void;
}

interface Entry {
  settle: (granted: boolean) => void;
  onPosition?: (position: number) => void;
}

export class SlotQueue {
  private active: Entry | null = null;
  private waiting: Entry[] = [];

  constructor(private maxWaiting: number) {}

  get running(): boolean {
    return this.active !== null;
  }

  get depth(): number {
    return this.waiting.length;
  }

  /** `onPosition` receives the number of requests ahead, each time it changes while waiting. */
  enter(onPosition?: (position: number) => void): Ticket {
    if (this.active && this.waiting.length >= this.maxWaiting) {
      throw new QueueFullError();
    }

    let settle!: (granted: boolean) => void;
    const ready = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const entry: Entry = { settle, onPosition };

    if (this.active) {
      this.waiting.push(entry);
      try {
        onPosition?.(this.waiting.length);
      } catch (error) {
        // The caller gets no ticket, so nothing could ever remove this entry; it would hold the slot once promoted.
        this.waiting.splice(this.waiting.indexOf(entry), 1);
        throw error;
      }
    } else {
      this.active = entry;
      settle(true);
    }

    let left = false;
    return {
      ready,
      leave: () => {
        if (left) {
          return;
        }
        left = true;
        if (this.active === entry) {
          this.active = this.waiting.shift() ?? null;
          this.active?.settle(true);
        } else {
          const i = this.waiting.indexOf(entry);
          if (i === -1) {
            return;
          }
          this.waiting.splice(i, 1);
          entry.settle(false);
        }
        this.waiting.forEach((e, i) => {
          e.onPosition?.(i + 1);
        });
      },
    };
  }
}
