export class MessageDedupe {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  accept(messageId: string): boolean {
    const current = this.now();
    const previous = this.seen.get(messageId);
    if (previous !== undefined && current - previous < this.ttlMs) return false;
    this.seen.delete(messageId);
    this.seen.set(messageId, current);
    this.prune(current);
    return true;
  }

  private prune(current: number): void {
    for (const [id, timestamp] of this.seen) {
      if (current - timestamp >= this.ttlMs || this.seen.size > this.maxEntries) {
        this.seen.delete(id);
      } else {
        break;
      }
    }
  }
}
