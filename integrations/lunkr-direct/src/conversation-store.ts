export interface ConversationTurn {
  readonly question: string;
}

interface SerializedConversationContext {
  readonly version: 2;
  readonly recentUserQuestions: readonly string[];
}

export class ConversationStore {
  private readonly conversations = new Map<string, ConversationTurn[]>();

  constructor(
    private readonly maxTurns: number,
    private readonly maxChars: number,
  ) {}

  context(peerUid: string, currentQuestion?: string): string | undefined {
    const turns = this.conversations.get(peerUid);
    if (turns === undefined || turns.length === 0) return undefined;
    const latestQuestion = turns.at(-1)?.question;
    if (
      currentQuestion !== undefined &&
      latestQuestion !== undefined &&
      normalizeQuestion(latestQuestion) === normalizeQuestion(currentQuestion)
    ) {
      return undefined;
    }
    const selected: string[] = [];
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index]!;
      const candidate = [turn.question.trim(), ...selected];
      if (serializeContext(candidate).length > this.maxChars) break;
      selected.unshift(turn.question.trim());
    }
    if (selected.length > 0) return serializeContext(selected);

    const latest = turns.at(-1)?.question.trim();
    if (!latest) return undefined;
    const characters = [...latest];
    while (characters.length > 0) {
      const serialized = serializeContext([characters.join("")]);
      if (serialized.length <= this.maxChars) return serialized;
      characters.pop();
    }
    return serializeContext([]).length <= this.maxChars
      ? serializeContext([])
      : undefined;
  }

  append(peerUid: string, turn: ConversationTurn): void {
    const turns = [...(this.conversations.get(peerUid) ?? []), turn];
    if (turns.length > this.maxTurns) {
      turns.splice(0, turns.length - this.maxTurns);
    }
    this.conversations.set(peerUid, turns);
  }

  clear(peerUid: string): void {
    this.conversations.delete(peerUid);
  }
}

function serializeContext(questions: readonly string[]): string {
  const payload: SerializedConversationContext = {
    version: 2,
    recentUserQuestions: questions,
  };
  return JSON.stringify(payload);
}

function normalizeQuestion(question: string): string {
  return question
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}
