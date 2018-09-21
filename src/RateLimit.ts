interface Node {
  fn: () => unknown;
  next?: Node;
}

// only rate limit requests after we hit half of our limit
const limit_after_percent = 0.5;

export default class RateLimit {
  private readonly delay_ms: number;
  private head: Option<Node>;
  private priority_tail: Option<Node>;
  private tail: Option<Node>;
  private is_running = false;

  private requests_made = 0;
  private readonly requests_allowed: number;

  constructor(interval: string);
  constructor(per_interval: number, interval: string);
  constructor(per_interval: string | number, interval: string = 'per minute') {
    if (typeof per_interval === 'string') {
      [per_interval, interval] = per_interval.split(/ +(.*)/);
      per_interval = parseInt(per_interval, 10);
    }

    let interval_ms;
    switch (interval) {
      case 'per second':
        interval_ms = 1_000;
        break;
      case 'per minute':
        interval_ms = 60_000;
        break;
      case 'per hour':
        interval_ms = 3_600_000;
        break;
      case 'per day':
        interval_ms = 86_400_000;
        break;
      default:
        throw new Error('Invalid duration');
    }

    this.delay_ms = interval_ms / per_interval / (1 - limit_after_percent);

    this.requests_allowed = per_interval;
    setInterval(() => (this.requests_made = 0), interval_ms);
  }

  public push(fn: () => unknown, priority = false): this {
    if (priority && this.head === undefined) {
      this.head = this.tail = this.priority_tail = { fn };
    } else if (priority && this.priority_tail !== undefined) {
      this.priority_tail = this.priority_tail.next = {
        fn,
        next: this.priority_tail.next,
      };
    } else if (priority) {
      this.head = this.priority_tail = { fn, next: this.head };
    } else if (this.head === undefined) {
      this.head = this.tail = { fn };
    } else {
      this.tail = this.tail!.next = { fn };
    }

    if (!this.is_running) {
      this.run();
    }

    return this;
  }

  private async run(): Promise<void> {
    this.is_running = true;

    while (this.head !== undefined) {
      this.requests_made++;
      this.head.fn();

      if (this.requests_made / this.requests_allowed >= limit_after_percent) {
        await new Promise(resolve => setTimeout(resolve, this.delay_ms));
      }

      this.head = this.head.next;
    }

    // clean up any potential memory leaks
    delete this.head;
    delete this.tail;
    delete this.priority_tail;

    this.is_running = false;
  }
}
