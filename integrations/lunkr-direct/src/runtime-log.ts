import { createHmac, randomBytes } from "node:crypto";
import type { BridgeQuestionEvent } from "./bridge.js";

export interface LunkrRuntimeLogRecord {
  readonly event: BridgeQuestionEvent["type"];
  readonly peer: string;
  readonly questionId?: number | undefined;
  readonly pendingCount: number;
  readonly activePeerCount: number;
  readonly scope?: string | undefined;
  readonly status?: string | undefined;
  readonly stopReason?: string | undefined;
  readonly elapsedMs?: number | undefined;
  readonly referenceCount?: number | undefined;
}

export function createRuntimeLogger(
  write: (line: string) => void,
  salt: Uint8Array = randomBytes(32),
): (event: BridgeQuestionEvent) => void {
  return (event): void => {
    const { peerUid, type, ...fields } = event;
    const peer = createHmac("sha256", salt)
      .update(peerUid)
      .digest("hex")
      .slice(0, 16);
    const record: LunkrRuntimeLogRecord = {
      event: type,
      peer,
      ...fields,
    };
    write(`${JSON.stringify(record)}\n`);
  };
}
