export interface ConversationTurn {
  readonly question: string;
  readonly answer?: string;
  readonly answerOutline?: string;
}

interface StoredConversationTurn {
  readonly question: string;
  readonly answerOutline?: string;
}

interface SerializedConversationContext {
  readonly version: 3;
  readonly recentTurns: readonly StoredConversationTurn[];
}

const OUTLINE_MAX_LINES = 8;
const OUTLINE_MAX_LINE_CHARS = 180;
const OUTLINE_MAX_CHARS = 1_200;
const SOURCES_HEADING = /^\s*(?:#{1,6}\s*)?(?:资料来源|参考资料|参考来源|references?)\s*[:：]?\s*$/iu;
const SOURCE_PATH = /(?:\bwiki\/|[a-z]:\\|file:\/\/)/iu;

export class ConversationStore {
  private readonly conversations = new Map<string, StoredConversationTurn[]>();

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
    const selected: StoredConversationTurn[] = [];
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const candidate = [turns[index]!, ...selected];
      if (serializeContext(candidate).length > this.maxChars) break;
      selected.unshift(turns[index]!);
    }
    if (selected.length > 0) return serializeContext(selected);

    const latest = turns.at(-1);
    if (latest === undefined) return undefined;
    return fitLatestTurn(latest, this.maxChars);
  }

  has(peerUid:string):boolean{return (this.conversations.get(peerUid)?.length??0)>0;}

  replace(peerUid:string,turns:readonly ConversationTurn[]):void{
    this.conversations.delete(peerUid);
    for(const turn of turns)this.append(peerUid,turn);
  }

  append(peerUid: string, turn: ConversationTurn): void {
    const question = turn.question.trim();
    if (question === "") return;
    const answerOutline = turn.answerOutline?.trim() || buildAnswerOutline(turn.answer);
    const stored: StoredConversationTurn = {
      question,
      ...(answerOutline === undefined ? {} : { answerOutline }),
    };
    const turns = [...(this.conversations.get(peerUid) ?? []), stored];
    if (turns.length > this.maxTurns) {
      turns.splice(0, turns.length - this.maxTurns);
    }
    this.conversations.set(peerUid, turns);
  }

  clear(peerUid: string): void {
    this.conversations.delete(peerUid);
  }
}

export function buildAnswerOutline(answer: string | undefined): string | undefined {
  if (answer === undefined) return undefined;
  const normalized = answer.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  if (normalized === "") return undefined;
  const selected: string[] = [];
  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "").trim();
    if (SOURCES_HEADING.test(line) || /^资料来源\s*[:：]/u.test(line)) break;
    if (line === "" || line === "```" || SOURCE_PATH.test(line)) continue;
    const clipped = [...line].slice(0, OUTLINE_MAX_LINE_CHARS).join("");
    selected.push(clipped.length < [...line].length ? `${clipped}…` : clipped);
    if (selected.length >= OUTLINE_MAX_LINES) break;
  }
  if (selected.length === 0) return undefined;
  const outline = [...selected.join("\n")].slice(0, OUTLINE_MAX_CHARS).join("");
  return outline.length < selected.join("\n").length ? `${outline}…` : outline;
}

function serializeContext(turns: readonly StoredConversationTurn[]): string {
  const payload: SerializedConversationContext = {
    version: 3,
    recentTurns: turns,
  };
  return JSON.stringify(payload);
}

function fitLatestTurn(turn: StoredConversationTurn, maxChars: number): string | undefined {
  const question = [...turn.question];
  const outline = [...(turn.answerOutline ?? "")];
  while (question.length > 0 || outline.length > 0) {
    const candidate: StoredConversationTurn = {
      question: question.join(""),
      ...(outline.length === 0 ? {} : { answerOutline: outline.join("") }),
    };
    const serialized = serializeContext([candidate]);
    if (serialized.length <= maxChars) return serialized;
    if (outline.length > question.length / 2) outline.pop();
    else question.pop();
  }
  const empty = serializeContext([]);
  return empty.length <= maxChars ? empty : undefined;
}

function normalizeQuestion(question: string): string {
  return question
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}
