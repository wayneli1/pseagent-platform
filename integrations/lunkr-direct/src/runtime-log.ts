import { createHmac, randomBytes } from "node:crypto";
import type {
  BridgeCoverage,
  BridgeDeliveryMode,
  BridgeHistoricalGateReason,
  BridgeHistoricalRejectionReason,
  BridgeQuestionEvent,
} from "./bridge.js";

export interface LunkrRuntimeLogRecord {
  readonly event: BridgeQuestionEvent["type"];
  readonly peer: string;
  readonly questionId?: number | undefined;
  readonly sessionEpoch?: number | undefined;
  readonly resetReason?: "manual" | "idle" | undefined;
  readonly pendingCount: number;
  readonly activePeerCount: number;
  readonly scope?: string | undefined;
  readonly status?: string | undefined;
  readonly stopReason?: string | undefined;
  readonly elapsedMs?: number | undefined;
  readonly referenceCount?: number | undefined;
  readonly historicalAttempted?: boolean | undefined;
  readonly historicalUsed?: boolean | undefined;
  readonly historicalNoticeShown?: boolean | undefined;
  readonly historicalRejectedReason?: BridgeHistoricalRejectionReason | undefined;
  readonly draftCoverage?: readonly BridgeCoverage[] | undefined;
  readonly verifiedCoverage?: readonly BridgeCoverage[] | undefined;
  readonly retainedDirectSegmentCount?: number | undefined;
  readonly retainedSynthesizedSegmentCount?: number | undefined;
  readonly removedSegmentCount?: number | undefined;
  readonly historicalGateReason?: BridgeHistoricalGateReason | undefined;
  readonly deliveryMode?: BridgeDeliveryMode | undefined;
}

export function createRuntimeLogger(
  write: (line: string) => void,
  salt: Uint8Array = randomBytes(32),
): (event: BridgeQuestionEvent) => void {
  return (event): void => {
    const peer = createHmac("sha256", salt)
      .update(event.peerUid)
      .digest("hex")
      .slice(0, 16);
    const record: LunkrRuntimeLogRecord = {
      event: event.type,
      peer,
      questionId: event.questionId,
      sessionEpoch: event.sessionEpoch,
      resetReason: event.resetReason,
      pendingCount: event.pendingCount,
      activePeerCount: event.activePeerCount,
      scope: event.scope,
      status: event.status,
      stopReason: event.stopReason,
      elapsedMs: event.elapsedMs,
      referenceCount: event.referenceCount,
      historicalAttempted: event.historicalAttempted,
      historicalUsed: event.historicalUsed,
      historicalNoticeShown: event.historicalNoticeShown,
      historicalRejectedReason: event.historicalRejectedReason,
      draftCoverage: event.draftCoverage,
      verifiedCoverage: event.verifiedCoverage,
      retainedDirectSegmentCount: event.retainedDirectSegmentCount,
      retainedSynthesizedSegmentCount:
        event.retainedSynthesizedSegmentCount,
      removedSegmentCount: event.removedSegmentCount,
      historicalGateReason: event.historicalGateReason,
      deliveryMode: event.deliveryMode,
    };
    write(`${JSON.stringify(record)}\n`);
  };
}
