interface Node {
  fn: () => unknown;
  next?: Node;
}

export default class RateLimit {
  private readonly delay_ms: number;
  private head: Option<Node>;
  private priority_tail: Option<Node>;
  private tail: Option<Node>;
  private is_running = false;

  constructor(interval: string);
  constructor(per_interval: number, interval: string);
  constructor(per_interval: string | number, interval: string = 'per minute') {
    if (typeof per_interval === 'string') {
      [per_interval, interval] = per_interval.split(/ +(.*)/);
      per_interval = parseInt(per_interval, 10);
    }

    switch (interval) {
      case 'per second':
        this.delay_ms = 1_000 / per_interval;
        break;
      case 'per minute':
        this.delay_ms = 60_000 / per_interval;
        break;
      case 'per hour':
        this.delay_ms = 3_600_000 / per_interval;
        break;
      case 'per day':
        this.delay_ms = 86_400_000 / per_interval;
        break;
      default:
        throw new Error('Invalid duration');
    }
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
      this.head.fn();
      await new Promise(resolve => setTimeout(resolve, this.delay_ms));
      this.head = this.head.next;
    }

    // clean up any potential memory leaks
    delete this.head;
    delete this.tail;
    delete this.priority_tail;

    this.is_running = false;
  }
}
