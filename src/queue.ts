// Single-slot FIFO: one generation runs at a time, a bounded number wait behind it.

export class QueueFullError extends Error {
  constructor() {
    super("translation queue is full");
  }
}

export interface Ticket {
  /** Resolves when this ticket owns the slot. */
  ready: Promise<void>;
  /** Give up the slot or the place in line. Safe to call more than once. */
  leave(): void;
}

interface Entry {
  grant: () => void;
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
    if (this.active && this.waiting.length >= this.maxWaiting) throw new QueueFullError();

    let grant!: () => void;
    const ready = new Promise<void>((resolve) => (grant = resolve));
    const entry: Entry = { grant, onPosition };

    if (!this.active) {
      this.active = entry;
      grant();
    } else {
      this.waiting.push(entry);
      onPosition?.(this.waiting.length);
    }

    let left = false;
    return {
      ready,
      leave: () => {
        if (left) return;
        left = true;
        if (this.active === entry) {
          this.active = this.waiting.shift() ?? null;
          this.active?.grant();
        } else {
          const i = this.waiting.indexOf(entry);
          if (i < 0) return;
          this.waiting.splice(i, 1);
        }
        this.waiting.forEach((e, i) => e.onPosition?.(i + 1));
      },
    };
  }
}
