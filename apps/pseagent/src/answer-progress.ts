import type {
  DiagnosticEvent,
  DiagnosticProgressEvent,
} from "./diagnostics.js";

export type AnswerProgressStage =
  | "understanding"
  | "planning"
  | "retrieving"
  | "reviewing_evidence"
  | "composing"
  | "verifying"
  | "preparing_delivery";

export interface AnswerProgressSnapshot {
  readonly stage: AnswerProgressStage;
  readonly requirementCount?: number;
  readonly retrievalCompletedCount?: number;
  readonly evidenceReadCount?: number;
  readonly coveredRequirementCount?: number;
  readonly coverageRequirementCount?: number;
}

export type AnswerProgressObserver = (
  snapshot: AnswerProgressSnapshot,
) => void;

const STAGE_RANK: Readonly<Record<AnswerProgressStage, number>> = {
  understanding: 0,
  planning: 1,
  retrieving: 2,
  reviewing_evidence: 3,
  composing: 4,
  verifying: 5,
  preparing_delivery: 6,
};

/**
 * Converts the content-free diagnostic contract into a smaller user-visible
 * snapshot. The observer is isolated because task progress is an availability
 * enhancement and must never influence the answer path.
 */
export class AnswerProgressTracker {
  private snapshot: AnswerProgressSnapshot = { stage: "understanding" };

  constructor(private readonly observer: AnswerProgressObserver) {
    this.emit();
  }

  recordProgress(event: DiagnosticProgressEvent): void {
    switch (event.operation) {
      case "route":
      case "resolve":
        this.advance("understanding");
        return;
      case "compile":
      case "plan":
        this.advance("planning");
        return;
      case "normal_answer":
      case "normal_answer_repair":
      case "synthesize":
        this.advance("composing");
        return;
      case "verify":
        this.advance("verifying");
        return;
    }
  }

  record(event: DiagnosticEvent): void {
    switch (event.event) {
      case "route":
        this.advance(event.scope === "normal" ? "composing" : "planning");
        return;
      case "question_resolution":
      case "task_spec_guard":
      case "task_spec_shadow":
      case "answer_card_match":
      case "answer_card_activation":
        this.advance("planning");
        return;
      case "task_spec":
        this.update({ requirementCount: event.coverageUnitCount }, "planning");
        return;
      case "task_spec_activation":
        this.update(
          { requirementCount: event.requirementCount },
          event.activated ? "retrieving" : "planning",
        );
        return;
      case "plan":
        this.update({ requirementCount: event.requirementCount }, "retrieving");
        return;
      case "domain_execution":
        if (event.result === "started" && event.phase === "agent") {
          this.advance("retrieving");
        }
        return;
      case "search":
        this.advance("retrieving");
        return;
      case "candidates":
        this.update({
          retrievalCompletedCount:
            (this.snapshot.retrievalCompletedCount ?? 0) + 1,
        }, "retrieving");
        return;
      case "read":
        this.update({
          evidenceReadCount: (this.snapshot.evidenceReadCount ?? 0) + 1,
        }, "reviewing_evidence");
        return;
      case "coverage":
        if (event.stage === "draft") {
          this.advance("verifying");
          return;
        }
        this.update({
          coveredRequirementCount: event.requirements.filter(
            (requirement) => requirement.coverage !== "none",
          ).length,
          coverageRequirementCount: event.requirements.length,
        }, "verifying");
        return;
      case "finish":
        this.advance("preparing_delivery");
        return;
      default:
        return;
    }
  }

  private advance(stage: AnswerProgressStage): void {
    this.update({}, stage);
  }

  private update(
    fields: Omit<Partial<AnswerProgressSnapshot>, "stage">,
    requestedStage: AnswerProgressStage,
  ): void {
    const stage = STAGE_RANK[requestedStage] > STAGE_RANK[this.snapshot.stage]
      ? requestedStage
      : this.snapshot.stage;
    const next = { ...this.snapshot, ...fields, stage };
    if (sameSnapshot(this.snapshot, next)) return;
    this.snapshot = next;
    this.emit();
  }

  private emit(): void {
    try {
      this.observer({ ...this.snapshot });
    } catch {
      // Progress reporting is deliberately isolated from answer execution.
    }
  }
}

function sameSnapshot(
  left: AnswerProgressSnapshot,
  right: AnswerProgressSnapshot,
): boolean {
  return left.stage === right.stage &&
    left.requirementCount === right.requirementCount &&
    left.retrievalCompletedCount === right.retrievalCompletedCount &&
    left.evidenceReadCount === right.evidenceReadCount &&
    left.coveredRequirementCount === right.coveredRequirementCount &&
    left.coverageRequirementCount === right.coverageRequirementCount;
}
