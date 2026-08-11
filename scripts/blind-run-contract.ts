import type { BlindProject } from "./blind-acceptance-contract.js";

export const BLIND_ACCEPTANCE_REQUIRED_MODEL = "deepseek_v4_flash";

const externalWriteVariables = [
  "KNOWLEDGE_OPS_BASE_URL",
  "KNOWLEDGE_OPS_SERVICE_TOKEN",
  "KNOWLEDGE_OPS_FEEDBACK_URL",
  "KNOWLEDGE_OPS_FEEDBACK_TOKEN",
  "PSE_FEEDBACK_PSEUDONYMIZATION_KEY",
  "KNOWLEDGE_OPS_RELEASE_TOKEN",
] as const;

export function validateColdRunEnvironment(env: NodeJS.ProcessEnv): {
  readonly cacheMode: "cold_disabled";
  readonly releaseId: string;
} {
  const cacheEnabled = env.PSE_QUALIFIED_CACHE_ENABLED?.trim();
  if (cacheEnabled !== undefined && cacheEnabled !== "" && cacheEnabled !== "false") {
    throw new Error("blind_acceptance_requires_cache_disabled");
  }
  if (env.PSE_RELIABILITY_CONTROL_PLANE_ENABLED?.trim() !== "true") {
    throw new Error("blind_acceptance_requires_reliability_control_plane");
  }
  const models = [
    env.PSE_MODEL_NAME,
    env.PSE_RESOLVER_MODEL_NAME ?? env.PSE_MODEL_NAME,
    env.PSE_PLANNER_MODEL_NAME ?? env.PSE_MODEL_NAME,
    env.PSE_SYNTHESIZER_MODEL_NAME ?? env.PSE_MODEL_NAME,
    env.PSE_VERIFIER_MODEL_NAME ?? env.PSE_MODEL_NAME,
    env.PSE_CONSENSUS_VERIFIER_MODEL_NAME ??
      env.PSE_VERIFIER_MODEL_NAME ?? env.PSE_MODEL_NAME,
  ];
  if (models.some((model) => model !== BLIND_ACCEPTANCE_REQUIRED_MODEL)) {
    throw new Error(`blind_acceptance_requires_${BLIND_ACCEPTANCE_REQUIRED_MODEL}`);
  }
  if (externalWriteVariables.some((name) => (env[name]?.trim().length ?? 0) > 0)) {
    throw new Error("blind_acceptance_external_writes_must_be_disabled");
  }
  const releaseId = env.PSE_RELEASE_ID?.trim() ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(releaseId)) {
    throw new Error("blind_acceptance_release_id_required");
  }
  return { cacheMode: "cold_disabled", releaseId };
}

export function requirePinnedKnowledgeRevisions(
  env: NodeJS.ProcessEnv,
): Record<BlindProject, string> {
  const professional = env.COREMAIL_PROFESSIONAL_REVISION?.trim() ?? "";
  const general = env.PRESALES_GENERAL_REVISION?.trim() ?? "";
  if (![professional, general].every((revision) => /^[a-f0-9]{40}$/u.test(revision))) {
    throw new Error("blind_acceptance_requires_pinned_knowledge_revisions");
  }
  return {
    "coremail-professional": professional,
    "presales-general": general,
  };
}

export function assertPinnedKnowledgeRevisions(
  expected: Readonly<Record<BlindProject, string>>,
  observed: Readonly<Record<BlindProject, string>>,
): void {
  if (JSON.stringify(expected) !== JSON.stringify(observed)) {
    throw new Error("blind_acceptance_knowledge_revision_drift");
  }
}
