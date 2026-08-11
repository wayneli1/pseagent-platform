import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  answerResultSchema,
  type AnswerResult,
} from "./contracts.js";
import type { HighRiskConsensusResult } from "./high-risk-consensus.js";
import type { ObligationOutcome } from "./obligation-outcome.js";
import type { KnowledgeDomain } from "./task-spec.js";

export interface QualifiedAnswerCacheKeyInput {
  readonly normalizedQuestion: string;
  readonly conversationContextHash: string;
  readonly releaseId: string;
  readonly knowledgeRevisions: Readonly<Record<KnowledgeDomain, string>>;
  readonly policyVersion: string;
  readonly answerCardCatalogHash: string;
  readonly schemaVersion: 1;
}

export interface QualifiedAnswerCacheRecord {
  readonly key: string;
  readonly result: AnswerResult;
  readonly domainsUsed: readonly KnowledgeDomain[];
  readonly obligationSignature: string;
  readonly qualifiedAt: string;
}

export interface QualifiedAnswerCache {
  get(input: QualifiedAnswerCacheKeyInput): Promise<QualifiedAnswerCacheRecord | undefined>;
  put(
    input: QualifiedAnswerCacheKeyInput,
    record: QualifiedAnswerCacheRecord,
  ): Promise<void>;
}

export interface ReleaseFingerprintProvider {
  current(signal: AbortSignal): Promise<{
    readonly knowledgeRevisions: Readonly<Record<KnowledgeDomain, string>>;
    readonly answerCardCatalogHash: string;
  }>;
}

export interface QualifiedExecution {
  readonly result: AnswerResult;
  readonly outcomes: readonly ObligationOutcome[];
  readonly consensus?: HighRiskConsensusResult;
}

const recordSchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/u),
  result: answerResultSchema,
  domainsUsed: z.array(z.enum(["coremail-professional", "presales-general"]))
    .min(1)
    .max(2)
    .refine((domains) => new Set(domains).size === domains.length),
  obligationSignature: z.string().regex(/^[a-f0-9]{64}$/u),
  qualifiedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((record, context) => {
  if (
    record.result.status !== "answered" ||
    record.result.policyDisposition !== "allowed" ||
    record.result.knowledgeCoverage !== "complete" ||
    record.result.caseAssessability === "insufficient" ||
    record.result.caseAssessability === "conflicting" ||
    record.result.references.length === 0
  ) {
    context.addIssue({
      code: "custom",
      path: ["result"],
      message: "qualified_cache_result_not_qualified",
    });
  }
});

export class FileQualifiedAnswerCache implements QualifiedAnswerCache {
  constructor(private readonly directory: string) {}

  async get(
    input: QualifiedAnswerCacheKeyInput,
  ): Promise<QualifiedAnswerCacheRecord | undefined> {
    const key = cacheKey(input);
    try {
      const raw = await readFile(join(this.directory, `${key}.json`), "utf8");
      const record = recordSchema.parse(JSON.parse(raw));
      if (record.key !== key) return undefined;
      return Object.freeze({
        ...record,
        result: Object.freeze(record.result),
        domainsUsed: Object.freeze(record.domainsUsed),
      });
    } catch {
      return undefined;
    }
  }

  async put(
    input: QualifiedAnswerCacheKeyInput,
    record: QualifiedAnswerCacheRecord,
  ): Promise<void> {
    const key = cacheKey(input);
    if (record.key !== key) throw new Error("qualified_cache_record_key_mismatch");
    const parsed = recordSchema.parse(record);
    await mkdir(this.directory, { recursive: true });
    const target = join(this.directory, `${key}.json`);
    const temporary = join(this.directory, `.${key}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(parsed)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      try {
        await rename(temporary, target);
      } catch (error) {
        if (!isExistingTargetError(error)) throw error;
        await unlink(temporary).catch(() => undefined);
      }
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

export function cacheKey(input: QualifiedAnswerCacheKeyInput): string {
  const canonical = JSON.stringify({
    normalizedQuestion: input.normalizedQuestion,
    conversationContextHash: input.conversationContextHash,
    releaseId: input.releaseId,
    knowledgeRevisions: {
      "coremail-professional": input.knowledgeRevisions["coremail-professional"],
      "presales-general": input.knowledgeRevisions["presales-general"],
    },
    policyVersion: input.policyVersion,
    answerCardCatalogHash: input.answerCardCatalogHash,
    schemaVersion: input.schemaVersion,
  });
  return sha256(canonical);
}

export function hashConversationContext(context: string | undefined): string {
  return sha256(context?.normalize("NFKC").trim() ?? "");
}

export function normalizeCacheQuestion(question: string): string {
  return question.normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/\s+/gu, " ")
    .trim();
}

export function obligationSignature(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function isQualifiedCacheWrite(
  execution: QualifiedExecution,
): boolean {
  return execution.result.status === "answered" &&
    execution.result.policyDisposition === "allowed" &&
    execution.result.knowledgeCoverage === "complete" &&
    execution.result.caseAssessability !== "insufficient" &&
    execution.result.caseAssessability !== "conflicting" &&
    execution.result.references.length > 0 &&
    execution.outcomes.length > 0 &&
    execution.outcomes.every((outcome) =>
      outcome.state === "complete" &&
      (outcome.gapReason === undefined || outcome.gapReason.trim() === "")) &&
    (execution.consensus === undefined || (
      execution.consensus.agreed &&
      execution.consensus.rejectedClaimIds.length === 0
    ));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isExistingTargetError(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error &&
    (error.code === "EEXIST" || error.code === "EPERM");
}
