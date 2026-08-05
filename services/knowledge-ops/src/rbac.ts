import { createHash, timingSafeEqual } from "node:crypto";
import type { KnowledgeDomain } from "@pseagent/knowledge-governance-contracts";
import type { OpsActor, OpsRole } from "./types.js";

export type OpsAction =
  | "dashboard:read"
  | "answer_review:ingest"
  | "answer_review:read"
  | "answer_review:triage"
  | "feedback:ingest"
  | "feedback:read"
  | "feedback:triage"
  | "card:read"
  | "card:edit"
  | "card:review"
  | "regression:read"
  | "regression:run"
  | "release:read"
  | "release:publish"
  | "release:rollback"
  | "audit:read"
  | "job:read";

const GLOBAL_ACTIONS: Partial<Record<OpsRole, readonly OpsAction[]>> = {
  viewer: ["dashboard:read", "answer_review:read", "feedback:read", "card:read", "regression:read", "release:read"],
  operator: ["dashboard:read", "answer_review:read", "answer_review:triage", "feedback:read", "feedback:triage", "card:read", "regression:read", "job:read"],
  release_manager: ["dashboard:read", "card:read", "regression:read", "regression:run", "release:read", "release:publish", "release:rollback", "job:read", "audit:read"],
  admin: ["dashboard:read", "answer_review:read", "answer_review:triage", "feedback:read", "feedback:triage", "card:read", "card:edit", "card:review", "regression:read", "regression:run", "release:read", "release:publish", "release:rollback", "audit:read", "job:read"],
  service: ["answer_review:ingest", "feedback:ingest"],
};

export function assertAuthorized(
  actor: OpsActor,
  action: OpsAction,
  domain?: KnowledgeDomain,
): void {
  if (actor.actorId.trim() === "" || actor.roles.length === 0) {
    throw new OpsAuthorizationError("authentication_required");
  }
  if (actor.roles.some((role) => GLOBAL_ACTIONS[role]?.includes(action))) return;
  if (domain !== undefined && domainRoleAllows(actor.roles, action, domain)) return;
  throw new OpsAuthorizationError("permission_denied");
}

export function assertSeparationOfDuties(
  actor: OpsActor,
  createdBy: string,
): void {
  if (actor.actorId === createdBy) {
    throw new OpsAuthorizationError("creator_cannot_self_approve");
  }
}

export class OpsAuthorizationError extends Error {
  constructor(readonly code: "authentication_required" | "permission_denied" | "creator_cannot_self_approve") {
    super(code);
    this.name = "OpsAuthorizationError";
  }
}

export interface TokenActorEntry {
  readonly tokenHash: string;
  readonly actor: OpsActor;
}

export class StaticTokenAuthorizer {
  constructor(private readonly entries: readonly TokenActorEntry[]) {}

  authenticate(token: string | undefined): OpsActor | undefined {
    if (token === undefined || token.trim() === "") return undefined;
    const actual = Buffer.from(createHash("sha256").update(token, "utf8").digest("hex"));
    for (const entry of this.entries) {
      const expected = Buffer.from(entry.tokenHash);
      if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
        return entry.actor;
      }
    }
    return undefined;
  }
}

function domainRoleAllows(
  roles: readonly OpsRole[],
  action: OpsAction,
  domain: KnowledgeDomain,
): boolean {
  const prefix = domain === "coremail-professional" ? "professional" : "general";
  if (action === "card:edit") return roles.includes(`${prefix}_editor` as OpsRole);
  if (action === "card:review") return roles.includes(`${prefix}_reviewer` as OpsRole);
  return false;
}
