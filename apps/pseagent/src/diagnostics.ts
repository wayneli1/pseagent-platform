import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  AnswerStatus,
  Coverage,
  CoverageVerificationReason,
  HistoricalRejectionReason,
  Scope,
} from "./contracts.js";

export type PseStopReason =
  | "seed_unavailable"
  | "routing_or_planning_unavailable"
  | "model_unavailable"
  | "invalid_model_payload"
  | "invalid_final"
  | "turn_budget_exhausted"
  | "evidence_review_unavailable"
  | "coverage_verifier_unavailable"
  | "coverage_verifier_invalid";

export type HistoricalGateReason =
  | "eligible"
  | "question_not_explicit_coremail"
  | "formal_verification_incomplete"
  | "formal_support_present"
  | "structural_fallback";

export type DiagnosticEvent =
  | { readonly event: "route"; readonly scope: Scope }
  | {
      readonly event: "plan";
      readonly requirementCount: number;
      readonly aspectCount: number;
      readonly queryCount: number;
      readonly directOnlyCount: number;
      readonly synthesisAllowedCount: number;
    }
  | {
      readonly event: "search";
      readonly requirementId: string;
      readonly phase: "seed" | "supplemental";
      readonly queryChars: number;
      readonly aspectIds: readonly string[];
    }
  | {
      readonly event: "candidates";
      readonly requirementId: string;
      readonly source: "seed_search_result" | "supplemental_search_result" | "graph_result";
      readonly candidates: readonly {
        readonly path: string;
        readonly rrfScore: number;
        readonly sourceQueryCount: number;
        readonly graphRelations: readonly string[];
        readonly aspectIds: readonly string[];
      }[];
      readonly aspects: readonly {
        readonly id: string;
        readonly candidateCount: number;
        readonly readCandidateCount: number;
      }[];
    }
  | {
      readonly event: "read";
      readonly requirementId: string;
      readonly path: string;
      readonly citation: number;
      readonly sectionHeadings: readonly string[];
      readonly aspectIds: readonly string[];
    }
  | {
      readonly event: "evidence_shared";
      readonly fromRequirementId: string;
      readonly toRequirementId: string;
      readonly path: string;
      readonly citation: number;
    }
  | {
      readonly event: "coverage";
      readonly stage: "draft" | "verified";
      readonly requirements: readonly {
        readonly id: string;
        readonly evidenceMode: "direct_only" | "synthesis_allowed";
        readonly coverage: Coverage;
        readonly citations: readonly number[];
        readonly retainedDirectSegmentCount?: number;
        readonly retainedSynthesizedSegmentCount?: number;
        readonly removedSegmentCount?: number;
        readonly coveredAspectCount?: number;
        readonly missingAspectCount?: number;
      }[];
      readonly reasons?: readonly {
        readonly id: string;
        readonly reason: CoverageVerificationReason;
      }[];
      readonly citations: readonly number[];
      readonly stopReason: "final" | "deadline";
    }
  | {
      readonly event: "validation";
      readonly result: "rejected";
      readonly reason: string;
      readonly repairAttempt: number;
    }
  | {
      readonly event: "model_payload";
      readonly result: "rejected";
      readonly reason: string;
      readonly repairAttempt: number;
      readonly schemaDescription?: string;
      readonly rawPayload?: string;
      readonly rawPayloadLength?: number;
      readonly finishReason?: string;
    }
  | {
      readonly event: "fallback";
      readonly reason:
        | "invalid_model_payload"
        | "invalid_final"
        | "turn_budget_exhausted"
        | "coverage_verifier_invalid";
      readonly outcome: "temporarily_unavailable";
    }
  | {
      readonly event: "historical_gate";
      readonly eligible: boolean;
      readonly reason: HistoricalGateReason;
    }
  | {
      readonly event: "stop";
      readonly reason: PseStopReason;
    }
  | {
      readonly event: "finish";
      readonly scope: Scope;
      readonly status: AnswerStatus;
      readonly citationCount: number;
      readonly elapsedMs: number;
      readonly historicalAttempted: boolean;
      readonly historicalUsed: boolean;
      readonly historicalNoticeShown?: boolean;
      readonly historicalRejectedReason?: HistoricalRejectionReason;
    };

export interface DiagnosticTrace {
  readonly requestId: string;
  record(event: DiagnosticEvent): void;
}

export interface DiagnosticTraceFactory {
  start(): DiagnosticTrace;
}

export const NOOP_DIAGNOSTIC_TRACE: DiagnosticTrace = {
  requestId: "disabled",
  record() {},
};

export class JsonlDiagnosticTraceFactory implements DiagnosticTraceFactory {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true });
  }

  start(): DiagnosticTrace {
    const requestId = randomUUID();
    const filename = `pseagent-${new Date().toISOString().slice(0, 10)}-${requestId}.jsonl`;
    return new JsonlDiagnosticTrace(requestId, join(this.directory, filename));
  }
}

export function recordDiagnostic(
  trace: DiagnosticTrace | undefined,
  event: DiagnosticEvent,
): void {
  try {
    trace?.record(event);
  } catch {
    // Development diagnostics must never change the answer path.
  }
}

class JsonlDiagnosticTrace implements DiagnosticTrace {
  constructor(
    readonly requestId: string,
    private readonly path: string,
  ) {}

  record(event: DiagnosticEvent): void {
    const record = sanitizeRecord({
      timestamp: new Date().toISOString(),
      requestId: this.requestId,
      ...event,
    });
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
  }
}

function sanitizeRecord(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(sanitizeRecord);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeRecord(item)]),
    );
  }
  return value;
}

function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(
      /\b(password|passwd|token|cookie|sid|api[_-]?key)\b(?:\s*[:=：]\s*|\s+)[^\s,，;；]+/giu,
      "$1=[REDACTED]",
    )
    .replace(/(密码|口令|令牌|会话)(?:\s*[:=：]\s*|\s*)[^\s,，;；]+/gu, "$1=[REDACTED]")
    .slice(0, 1_024);
}
