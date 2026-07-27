export interface ConversationTurn {
  readonly question: string;
  readonly answer: string;
}

export class ConversationStore {
  private readonly conversations = new Map<string, ConversationTurn[]>();

  constructor(
    private readonly maxTurns: number,
    private readonly maxChars: number,
  ) {}

  context(peerUid: string): string | undefined {
    const turns = this.conversations.get(peerUid);
    if (turns === undefined || turns.length === 0) return undefined;
    const selected: string[] = [];
    let characters = 0;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index]!;
      const formatted = `用户：${turn.question}\n助手：${turn.answer}`;
      if (selected.length > 0 && characters + formatted.length > this.maxChars) break;
      selected.unshift(formatted.slice(-this.maxChars));
      characters += formatted.length;
    }
    return selected.join("\n\n");
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
