import type { LunkrSession } from "./contracts.js";
import { SessionStore } from "./session-store.js";

export interface LunkrSessionStatus {
  readonly configured: boolean;
  readonly valid: boolean;
  readonly email?: string;
  readonly selfUid?: string;
  readonly lastVerifiedAt?: string;
}

export async function getLunkrSessionStatus(
  store: Pick<SessionStore, "load">,
  verify: (session: LunkrSession) => Promise<boolean>,
): Promise<LunkrSessionStatus> {
  const session = await store.load();
  if (session === undefined) return { configured: false, valid: false };
  const valid = await verify(session);
  return {
    configured: true,
    valid,
    email: session.email,
    selfUid: session.selfUid,
    lastVerifiedAt: session.lastVerifiedAt,
  };
}
