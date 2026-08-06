export interface PersistedConversationTurn {
  readonly requestId: string;
  readonly resolvedQuestion: string;
  readonly answerOutline?: string;
}

export interface PersistedConversationContext {
  readonly session?: { readonly sessionId: string };
  readonly recentTurns: readonly PersistedConversationTurn[];
}

export interface BridgeConversationTurnSubmission {
  readonly turnId: string;
  readonly requestId: string;
  readonly pseudonymousUserId: string;
  readonly questionId: number;
  readonly rawQuestion: string;
  readonly resolvedQuestion: string;
  readonly contextUsed: boolean;
  readonly inheritedSubjects: readonly string[];
  readonly answerOutline?: string;
  readonly answerStatus: string;
  readonly scope?: string;
  readonly answerCardMatch?: Record<string, unknown>;
  readonly answeredAt: string;
  readonly expiresAt: string;
  readonly source: "lunkr_direct";
  readonly forceNewSession?: boolean;
}

export interface BridgeConversationDependencies {
  readonly pseudonymizationKey: string;
  readonly load: (pseudonymousUserId:string,maxTurns:number) => Promise<PersistedConversationContext>;
  readonly append: (submission:BridgeConversationTurnSubmission) => Promise<void>;
  readonly end: (pseudonymousUserId:string,reason:"manual"|"idle",endedAt:string) => Promise<void>;
}
