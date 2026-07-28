export type AdmissionKind =
  | "started"
  | "peer_queued"
  | "global_queued"
  | "peer_full";

export interface QuestionStart {
  readonly peerUid: string;
  readonly questionId: number;
  readonly epoch: number;
  readonly signal: AbortSignal;
  readonly startedFromQueue: boolean;
}

export interface AdmissionNotice {
  readonly kind: AdmissionKind;
  readonly questionId: number | undefined;
  readonly epoch: number;
  readonly ahead: number;
}

export interface AdmissionReceipt extends AdmissionNotice {
  readonly completion: Promise<void>;
}

export interface QuestionCallbacks {
  readonly accept: (receipt: AdmissionNotice) => Promise<void>;
  readonly work: (start: QuestionStart) => Promise<void>;
}

export interface PeerResetResult {
  readonly epoch: number;
  readonly activeCancelled: boolean;
  readonly pendingCancelled: number;
}

interface ScheduledQuestion {
  readonly questionId: number;
  readonly epoch: number;
  readonly initialKind: Exclude<AdmissionKind, "peer_full">;
  readonly callbacks: QuestionCallbacks;
  readonly controller: AbortController;
  readonly completion: Deferred<void>;
  accepted: boolean;
  cancelled: boolean;
  running: boolean;
}

interface PeerState {
  nextQuestionId: number;
  epoch: number;
  active: ScheduledQuestion | undefined;
  readonly pending: ScheduledQuestion[];
  readyQueued: boolean;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

export class PeerScheduler {
  private readonly peers = new Map<string, PeerState>();
  private readonly activePeers = new Set<string>();
  private readonly readyPeers: string[] = [];

  constructor(
    private readonly maxActivePeers: number,
    private readonly maxPendingPerPeer: number,
  ) {}

  get activePeerCount(): number {
    return this.activePeers.size;
  }

  submit(peerUid: string, callbacks: QuestionCallbacks): AdmissionReceipt {
    const state = this.peerState(peerUid);
    const ahead = (state.active === undefined ? 0 : 1) + state.pending.length;
    if (state.pending.length >= this.maxPendingPerPeer) {
      const notice: AdmissionNotice = {
        kind: "peer_full",
        questionId: undefined,
        epoch: state.epoch,
        ahead,
      };
      return {
        ...notice,
        completion: callbacks.accept(notice),
      };
    }
    const questionId = state.nextQuestionId;
    state.nextQuestionId += 1;
    const kind: Exclude<AdmissionKind, "peer_full"> = ahead > 0
      ? "peer_queued"
      : this.activePeers.size < this.maxActivePeers
        ? "started"
        : "global_queued";
    const completion = deferred<void>();
    const question: ScheduledQuestion = {
      questionId,
      epoch: state.epoch,
      initialKind: kind,
      callbacks,
      controller: new AbortController(),
      completion,
      accepted: false,
      cancelled: false,
      running: false,
    };
    if (kind === "started") {
      state.active = question;
      this.activePeers.add(peerUid);
    } else {
      state.pending.push(question);
    }
    const notice: AdmissionNotice = {
      kind,
      questionId,
      epoch: state.epoch,
      ahead,
    };
    void this.accept(peerUid, state, question, notice);
    return { ...notice, completion: completion.promise };
  }

  reset(peerUid: string): PeerResetResult {
    const state = this.peerState(peerUid);
    state.epoch += 1;
    state.nextQuestionId = 1;
    const pendingCancelled = state.pending.length;
    for (const question of state.pending.splice(0)) {
      question.cancelled = true;
      question.controller.abort("lunkr_new_session");
      question.completion.resolve();
    }
    this.removeReadyPeer(peerUid, state);
    const active = state.active;
    if (active !== undefined) {
      active.cancelled = true;
      active.controller.abort("lunkr_new_session");
      active.completion.resolve();
      if (!active.running) {
        state.active = undefined;
        this.activePeers.delete(peerUid);
      }
    }
    this.drain();
    return {
      epoch: state.epoch,
      activeCancelled: active !== undefined,
      pendingCancelled,
    };
  }

  isCurrent(peerUid: string, epoch: number): boolean {
    return (this.peers.get(peerUid)?.epoch ?? 0) === epoch;
  }

  private async accept(
    peerUid: string,
    state: PeerState,
    question: ScheduledQuestion,
    notice: AdmissionNotice,
  ): Promise<void> {
    try {
      await question.callbacks.accept(notice);
      if (
        question.cancelled ||
        state.epoch !== question.epoch ||
        (state.active !== question && !state.pending.includes(question))
      ) {
        return;
      }
      question.accepted = true;
      if (state.active === question) {
        this.start(peerUid, state, question);
      } else if (state.active === undefined && state.pending[0] === question) {
        this.enqueueReady(peerUid, state);
        this.drain();
      }
    } catch (error) {
      if (question.cancelled) return;
      this.removeQuestion(peerUid, state, question);
      question.completion.reject(error);
    }
  }

  private start(
    peerUid: string,
    state: PeerState,
    question: ScheduledQuestion,
  ): void {
    question.running = true;
    void this.run(peerUid, state, question);
  }

  private async run(
    peerUid: string,
    state: PeerState,
    question: ScheduledQuestion,
  ): Promise<void> {
    let failed = false;
    let failure: unknown;
    try {
      await question.callbacks.work({
        peerUid,
        questionId: question.questionId,
        epoch: question.epoch,
        signal: question.controller.signal,
        startedFromQueue: question.initialKind !== "started",
      });
    } catch (error) {
      failed = true;
      failure = error;
    }
    question.running = false;
    if (state.active === question) state.active = undefined;
    this.activePeers.delete(peerUid);
    if (state.pending[0]?.accepted === true) this.enqueueReady(peerUid, state);
    this.drain();
    if (question.cancelled) return;
    if (!failed) {
      question.completion.resolve();
    } else {
      question.completion.reject(failure);
    }
  }

  private drain(): void {
    while (
      this.activePeers.size < this.maxActivePeers &&
      this.readyPeers.length > 0
    ) {
      const peerUid = this.readyPeers.shift()!;
      const state = this.peers.get(peerUid);
      if (state === undefined) continue;
      state.readyQueued = false;
      if (state.active !== undefined || state.pending[0]?.accepted !== true) {
        continue;
      }
      const question = state.pending.shift()!;
      state.active = question;
      this.activePeers.add(peerUid);
      this.start(peerUid, state, question);
    }
  }

  private enqueueReady(peerUid: string, state: PeerState): void {
    if (state.readyQueued) return;
    state.readyQueued = true;
    this.readyPeers.push(peerUid);
  }

  private removeReadyPeer(peerUid: string, state: PeerState): void {
    state.readyQueued = false;
    for (let index = this.readyPeers.length - 1; index >= 0; index -= 1) {
      if (this.readyPeers[index] === peerUid) this.readyPeers.splice(index, 1);
    }
  }

  private removeQuestion(
    peerUid: string,
    state: PeerState,
    question: ScheduledQuestion,
  ): void {
    if (state.active === question) {
      state.active = undefined;
      this.activePeers.delete(peerUid);
    } else {
      const index = state.pending.indexOf(question);
      if (index >= 0) state.pending.splice(index, 1);
    }
    if (state.pending[0]?.accepted === true) this.enqueueReady(peerUid, state);
    this.drain();
  }

  private peerState(peerUid: string): PeerState {
    const existing = this.peers.get(peerUid);
    if (existing !== undefined) return existing;
    const state: PeerState = {
      nextQuestionId: 1,
      epoch: 0,
      active: undefined,
      pending: [],
      readyQueued: false,
    };
    this.peers.set(peerUid, state);
    return state;
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
