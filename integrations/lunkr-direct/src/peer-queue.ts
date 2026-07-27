export class PeerQueue {
  private readonly queues = new Map<string, Promise<void>>();

  enqueue(peerUid: string, work: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(peerUid) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    this.queues.set(peerUid, current);
    void current.finally(() => {
      if (this.queues.get(peerUid) === current) this.queues.delete(peerUid);
    }).catch(() => undefined);
    return current;
  }
}
