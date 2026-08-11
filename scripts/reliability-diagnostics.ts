import { randomUUID } from "node:crypto";
import type {
  Coverage,
  CoverageVerificationReason,
} from "../apps/pseagent/src/contracts.ts";
import type {
  DiagnosticEvent,
  DiagnosticTrace,
  DiagnosticTraceFactory,
  PseStopReason,
} from "../apps/pseagent/src/diagnostics.ts";

type KnowledgeDomain = "coremail-professional" | "presales-general";

export interface ReliabilityDiagnosticSummary {
  readonly stages: readonly {
    readonly stage: string;
    readonly result: "completed" | "degraded" | "timeout" | "cancelled";
    readonly elapsedMs: number;
    readonly remainingMs: number;
  }[];
  readonly rootStopReason?: PseStopReason;
  readonly finalStopReason?: PseStopReason;
  readonly stopReasons: readonly PseStopReason[];
  readonly domains: readonly {
    readonly domain?: KnowledgeDomain;
    readonly phase: "session" | "agent";
    readonly result: "started" | "completed" | "verified" | "unavailable";
    readonly reason?: string;
    readonly rootReason?: PseStopReason;
  }[];
  readonly task: {
    readonly domainCount?: number;
    readonly coverageUnitCount?: number;
    readonly guardOk?: boolean;
    readonly guardIssueCodes: readonly string[];
    readonly activation?: {
      readonly activated: boolean;
      readonly reason: string;
      readonly requirementCount: number;
    };
  };
  readonly model: {
    readonly callCount: number;
    readonly failedCallCount: number;
    readonly attemptCount: number;
    readonly queueElapsedMs: number;
    readonly executionElapsedMs: number;
    readonly callBudget?: {
      readonly maximumOpenEndedCalls: number;
      readonly usedOpenEndedCalls: number;
      readonly usedStructuredCalls: number;
    };
    readonly calls: readonly {
      readonly role: string;
      readonly operation: string;
      readonly outcome: "completed" | "failed";
      readonly elapsedMs: number;
      readonly attemptCount: number;
      readonly queueElapsedMs: number;
      readonly executionElapsedMs: number;
      readonly errorClass?: string;
    }[];
  };
  readonly retrieval: {
    readonly seedSearchCount: number;
    readonly supplementalSearchCount: number;
    readonly candidateEventCount: number;
    readonly candidateCount: number;
    readonly readCount: number;
    readonly unreadCandidateCount: number;
    readonly remainingReads: number;
  };
  readonly coverage: {
    readonly draftRequirementCount: number;
    readonly verifiedRequirementCount: number;
    readonly incompleteVerifiedRequirementCount: number;
    readonly requirements: readonly {
      readonly id: string;
      readonly coverage: Coverage;
      readonly reason?: CoverageVerificationReason;
      readonly candidateCount: number;
      readonly readCandidateCount: number;
      readonly unreadCandidateCount: number;
      readonly remainingReads: number;
      readonly seedSearchStatus?: "success" | "empty" | "unavailable";
      readonly retainedDirectSegmentCount: number;
      readonly retainedSynthesizedSegmentCount: number;
      readonly removedSegmentCount: number;
      readonly coveredAspectCount: number;
      readonly missingAspectCount: number;
    }[];
    readonly gapCount: number;
    readonly gaps: readonly {
      readonly domain: KnowledgeDomain;
      readonly gapClass: string;
      readonly reason: string;
      readonly affectsConclusion: boolean;
    }[];
    readonly gates: readonly {
      readonly disposition: string;
      readonly risk: string;
      readonly reasons: readonly string[];
      readonly missingInputCount: number;
      readonly knowledgeMissingCount: number;
    }[];
  };
  readonly validation: {
    readonly rejectedCount: number;
    readonly payloadRejectedCount: number;
    readonly fallbackCount: number;
    readonly finalGuardRejectedCount: number;
    readonly rejected: readonly {
      readonly reason: string;
      readonly detail?: string;
      readonly repairAttempt: number;
    }[];
    readonly payloadRejected: readonly {
      readonly reason: string;
      readonly repairAttempt: number;
      readonly finishReason?: string;
    }[];
    readonly finalGuardRejected: readonly {
      readonly reason: string;
      readonly repairAttempt: number;
    }[];
  };
}

export class ReliabilityDiagnosticCollector implements DiagnosticTraceFactory {
  private readonly events = new Map<string, DiagnosticEvent[]>();

  start(): DiagnosticTrace {
    const requestId = randomUUID();
    const events: DiagnosticEvent[] = [];
    this.events.set(requestId, events);
    return {
      requestId,
      record(event) {
        events.push(event);
      },
    };
  }

  take(requestId: string): ReliabilityDiagnosticSummary {
    const events = this.events.get(requestId) ?? [];
    this.events.delete(requestId);
    return summarizeReliabilityDiagnostics(events);
  }

  pendingCount(): number {
    return this.events.size;
  }
}

export function summarizeReliabilityDiagnostics(
  events: readonly DiagnosticEvent[],
): ReliabilityDiagnosticSummary {
  const stops = events.flatMap((event) =>
    event.event === "stop" ? [event.reason] : []);
  const domains = events.flatMap((event) =>
    event.event === "domain_execution"
      ? [{
          ...(event.domain === undefined ? {} : { domain: event.domain }),
          phase: event.phase,
          result: event.result,
          ...(event.reason === undefined ? {} : { reason: event.reason }),
          ...(event.rootReason === undefined
            ? {}
            : { rootReason: event.rootReason }),
        }]
      : []);
  const stages = events.flatMap((event) => event.event === "stage_budget"
    ? [{
        stage: event.stage,
        result: event.result,
        elapsedMs: event.elapsedMs,
        remainingMs: event.remainingMs,
      }]
    : []);
  const taskSpec = [...events].reverse().find((event) =>
    event.event === "task_spec");
  const taskGuard = [...events].reverse().find((event) =>
    event.event === "task_spec_guard");
  const taskActivation = [...events].reverse().find((event) =>
    event.event === "task_spec_activation");
  const modelCalls = events.flatMap((event) =>
    event.event === "model_call"
      ? [{
          role: event.role,
          operation: event.operation,
          outcome: event.outcome,
          elapsedMs: event.elapsedMs,
          attemptCount: event.attemptCount ?? 0,
          queueElapsedMs: event.queueElapsedMs ?? 0,
          executionElapsedMs: event.executionElapsedMs ?? 0,
          ...(event.errorClass === undefined
            ? {}
            : { errorClass: event.errorClass }),
        }]
      : []);
  const modelCallBudget = [...events].reverse().find((event) =>
    event.event === "model_call_budget");
  const searches = events.filter((event) => event.event === "search");
  const candidates = events.filter((event) => event.event === "candidates");
  const reads = events.filter((event) => event.event === "read");
  const verifiedCoverage = [...events].reverse().find((event) =>
    event.event === "coverage" && event.stage === "verified");
  const draftCoverage = [...events].reverse().find((event) =>
    event.event === "coverage" && event.stage === "draft");
  const latestGapEvent = [...events].reverse().find((event) =>
    event.event === "coverage_gaps");
  const gaps = latestGapEvent?.event === "coverage_gaps"
    ? latestGapEvent.gaps.map((gap) => ({ ...gap }))
    : [];
  const gates = events.flatMap((event) => event.event === "coverage_gate"
    ? [{
        disposition: event.disposition,
        risk: event.risk,
        reasons: [...event.reasons],
        missingInputCount: event.missingInputCount,
        knowledgeMissingCount: event.knowledgeMissingCount,
      }]
    : []);
  const rejected = events.flatMap((event) => event.event === "validation"
    ? [{
        reason: safeDiagnosticCode(event.reason),
        ...(safeDiagnosticDetail(event.reason) === undefined
          ? {}
          : { detail: safeDiagnosticDetail(event.reason) }),
        repairAttempt: event.repairAttempt,
      }]
    : []);
  const payloadRejected = events.flatMap((event) => event.event === "model_payload"
    ? [{
        reason: safeDiagnosticCode(event.reason),
        repairAttempt: event.repairAttempt,
        ...(event.finishReason === undefined
          ? {}
          : { finishReason: safeDiagnosticCode(event.finishReason) }),
      }]
    : []);
  const finalGuardRejected = events.flatMap((event) => event.event === "final_guard"
    ? [{ reason: event.reason, repairAttempt: event.repairAttempt }]
    : []);
  const verifiedRequirements = verifiedCoverage?.event === "coverage"
    ? verifiedCoverage.requirements
    : [];
  const verifiedReasonById = new Map(
    verifiedCoverage?.event === "coverage"
      ? verifiedCoverage.reasons?.map(({ id, reason }) => [id, reason] as const)
      : undefined,
  );
  const draftRequirements = draftCoverage?.event === "coverage"
    ? draftCoverage.requirements
    : [];
  const domainRoot = [...domains].reverse().find((event) =>
    event.result === "unavailable" && event.rootReason !== undefined)?.rootReason;
  const fallbackRoot = [...stops].reverse().find((reason) =>
    reason !== "domain_execution_unavailable" && reason !== "domain_merge_invalid");
  return {
    ...((domainRoot ?? fallbackRoot) === undefined
      ? {}
      : { rootStopReason: domainRoot ?? fallbackRoot }),
    ...(stops.at(-1) === undefined ? {} : { finalStopReason: stops.at(-1) }),
    stopReasons: stops,
    stages,
    domains,
    task: {
      ...(taskSpec?.event !== "task_spec"
        ? {}
        : {
            domainCount: taskSpec.domainCount,
            coverageUnitCount: taskSpec.coverageUnitCount,
          }),
      ...(taskGuard?.event !== "task_spec_guard"
        ? { guardIssueCodes: [] }
        : {
            guardOk: taskGuard.ok,
            guardIssueCodes: taskGuard.issueCodes,
          }),
      ...(taskActivation?.event !== "task_spec_activation"
        ? {}
        : {
            activation: {
              activated: taskActivation.activated,
              reason: taskActivation.reason,
              requirementCount: taskActivation.requirementCount,
            },
          }),
    },
    model: {
      callCount: modelCalls.length,
      failedCallCount: modelCalls.filter((call) => call.outcome === "failed").length,
      attemptCount: sum(modelCalls.map((call) => call.attemptCount)),
      queueElapsedMs: sum(modelCalls.map((call) => call.queueElapsedMs)),
      executionElapsedMs: sum(modelCalls.map((call) => call.executionElapsedMs)),
      calls: modelCalls,
      ...(modelCallBudget?.event !== "model_call_budget"
        ? {}
        : {
            callBudget: {
              maximumOpenEndedCalls: modelCallBudget.maximumOpenEndedCalls,
              usedOpenEndedCalls: modelCallBudget.usedOpenEndedCalls,
              usedStructuredCalls: modelCallBudget.usedStructuredCalls,
            },
          }),
    },
    retrieval: {
      seedSearchCount: searches.filter((event) =>
        event.event === "search" && event.phase === "seed").length,
      supplementalSearchCount: searches.filter((event) =>
        event.event === "search" && event.phase === "supplemental").length,
      candidateEventCount: candidates.length,
      candidateCount: sum(candidates.map((event) =>
        event.event === "candidates" ? event.candidateCount : 0)),
      readCount: reads.length,
      unreadCandidateCount: sum(verifiedRequirements.map((item) =>
        item.unreadCandidateCount ?? 0)),
      remainingReads: sum(verifiedRequirements.map((item) =>
        item.remainingReads ?? 0)),
    },
    coverage: {
      draftRequirementCount: draftRequirements.length,
      verifiedRequirementCount: verifiedRequirements.length,
      incompleteVerifiedRequirementCount: verifiedRequirements.filter((item) =>
        item.coverage !== "complete").length,
      requirements: verifiedRequirements.map((item) => ({
        id: item.id,
        coverage: item.coverage,
        ...(verifiedReasonById.get(item.id) === undefined
          ? {}
          : { reason: verifiedReasonById.get(item.id)! }),
        candidateCount: item.candidateCount ?? 0,
        readCandidateCount: item.readCandidateCount ?? 0,
        unreadCandidateCount: item.unreadCandidateCount ?? 0,
        remainingReads: item.remainingReads ?? 0,
        ...(item.seedSearchStatus === undefined
          ? {}
          : { seedSearchStatus: item.seedSearchStatus }),
        retainedDirectSegmentCount: item.retainedDirectSegmentCount ?? 0,
        retainedSynthesizedSegmentCount:
          item.retainedSynthesizedSegmentCount ?? 0,
        removedSegmentCount: item.removedSegmentCount ?? 0,
        coveredAspectCount: item.coveredAspectCount ?? 0,
        missingAspectCount: item.missingAspectCount ?? 0,
      })),
      gapCount: gaps.length,
      gaps,
      gates,
    },
    validation: {
      rejectedCount: rejected.length,
      payloadRejectedCount: payloadRejected.length,
      fallbackCount: events.filter((event) => event.event === "fallback").length,
      finalGuardRejectedCount: finalGuardRejected.length,
      rejected,
      payloadRejected,
      finalGuardRejected,
    },
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function safeDiagnosticCode(value: string): string {
  const code = value.split(":", 1)[0]?.trim() ?? "";
  return /^[a-z][a-z0-9_-]{0,95}$/u.test(code) ? code : "unknown";
}

function safeDiagnosticDetail(value: string): string | undefined {
  const detail = value.split(":", 2)[1]?.trim() ?? "";
  return /^[a-z][a-z0-9_-]{0,95}$/u.test(detail) ? detail : undefined;
}
