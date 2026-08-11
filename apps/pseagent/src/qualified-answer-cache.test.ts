import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileQualifiedAnswerCache,
  cacheKey,
  isQualifiedCacheWrite,
  type QualifiedAnswerCacheKeyInput,
  type QualifiedAnswerCacheRecord,
  type QualifiedExecution,
} from "./qualified-answer-cache.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function keyInput(): QualifiedAnswerCacheKeyInput {
  return {
    normalizedQuestion: "说明归档能力",
    conversationContextHash: "a".repeat(64),
    releaseId: "release-1",
    knowledgeRevisions: {
      "coremail-professional": "b".repeat(40),
      "presales-general": "c".repeat(40),
    },
    policyVersion: "policy-contract-v1",
    answerCardCatalogHash: "d".repeat(64),
    schemaVersion: 1,
  };
}

function completeExecution(): QualifiedExecution {
  return {
    result: {
      scope: "professional",
      status: "answered",
      policyDisposition: "allowed",
      knowledgeCoverage: "complete",
      caseAssessability: "not_applicable",
      answer: "支持邮件归档。[1]",
      references: [{
        index: 1,
        project: "coremail-professional",
        title: "归档说明",
        path: "wiki/product/archive.md",
        revision: "b".repeat(40),
        contentHash: "e".repeat(64),
      }],
    },
    outcomes: [{ obligationId: "O1", state: "complete", claims: [] }],
    consensus: {
      mode: "independent_models",
      retainedClaimIds: ["CL1"],
      rejectedClaimIds: [],
      agreed: true,
    },
  };
}

describe("qualified production answer cache", () => {
  it.each([
    {
      name: "partial result",
      mutate: (value: QualifiedExecution): QualifiedExecution => ({
        ...value,
        result: { ...value.result, status: "partially_answered", knowledgeCoverage: "partial" },
      }),
    },
    {
      name: "outcome gap",
      mutate: (value: QualifiedExecution): QualifiedExecution => ({
        ...value,
        outcomes: [{ obligationId: "O1", state: "partial", claims: [], gapReason: "资料不足" }],
      }),
    },
    {
      name: "missing input",
      mutate: (value: QualifiedExecution): QualifiedExecution => ({
        ...value,
        outcomes: [{ obligationId: "O1", state: "missing_input", claims: [] }],
      }),
    },
    {
      name: "no consensus",
      mutate: (value: QualifiedExecution): QualifiedExecution => ({
        ...value,
        consensus: { ...value.consensus!, agreed: false, rejectedClaimIds: ["CL1"] },
      }),
    },
  ])("never caches an unqualified execution: $name", ({ mutate }) => {
    expect(isQualifiedCacheWrite(mutate(completeExecution()))).toBe(false);
  });

  it("accepts only a complete evidence-backed execution", () => {
    expect(isQualifiedCacheWrite(completeExecution())).toBe(true);
    expect(isQualifiedCacheWrite({
      ...completeExecution(),
      result: { ...completeExecution().result, references: [] },
    })).toBe(false);
  });

  it("changes the key when release, either knowledge revision, policy, or catalog changes", () => {
    const base = keyInput();
    const keys = [
      cacheKey(base),
      cacheKey({ ...base, releaseId: "release-2" }),
      cacheKey({
        ...base,
        knowledgeRevisions: {
          ...base.knowledgeRevisions,
          "coremail-professional": "f".repeat(40),
        },
      }),
      cacheKey({
        ...base,
        knowledgeRevisions: {
          ...base.knowledgeRevisions,
          "presales-general": "f".repeat(40),
        },
      }),
      cacheKey({ ...base, policyVersion: "policy-contract-v2" }),
      cacheKey({ ...base, answerCardCatalogHash: "f".repeat(64) }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("atomically persists a validated record without raw cache-key inputs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pse-qualified-cache-test-"));
    directories.push(directory);
    const cache = new FileQualifiedAnswerCache(directory);
    const input = keyInput();
    const key = cacheKey(input);
    const record: QualifiedAnswerCacheRecord = {
      key,
      result: completeExecution().result,
      domainsUsed: ["coremail-professional"],
      obligationSignature: "f".repeat(64),
      qualifiedAt: "2026-08-12T00:00:00.000Z",
    };

    await cache.put(input, record);

    expect(await cache.get(input)).toEqual(record);
    expect(readdirSync(directory)).toEqual([`${key}.json`]);
    const stored = readFileSync(join(directory, `${key}.json`), "utf8");
    expect(stored).not.toContain(input.normalizedQuestion);
    expect(stored).not.toContain("conversationContextHash");
    expect(stored).not.toContain(".tmp");
  });

  it("treats an invalid or mismatched record as a cache miss", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pse-qualified-cache-test-"));
    directories.push(directory);
    const cache = new FileQualifiedAnswerCache(directory);
    const input = keyInput();
    const wrongInput = { ...input, releaseId: "release-2" };
    const record: QualifiedAnswerCacheRecord = {
      key: cacheKey(input),
      result: completeExecution().result,
      domainsUsed: ["coremail-professional"],
      obligationSignature: "f".repeat(64),
      qualifiedAt: "2026-08-12T00:00:00.000Z",
    };
    await cache.put(input, record);

    await expect(cache.get(wrongInput)).resolves.toBeUndefined();
  });

  it("refuses to persist a schema-valid but unqualified result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pse-qualified-cache-test-"));
    directories.push(directory);
    const cache = new FileQualifiedAnswerCache(directory);
    const input = keyInput();

    await expect(cache.put(input, {
      key: cacheKey(input),
      result: {
        ...completeExecution().result,
        status: "partially_answered",
        knowledgeCoverage: "partial",
      },
      domainsUsed: ["coremail-professional"],
      obligationSignature: "f".repeat(64),
      qualifiedAt: "2026-08-12T00:00:00.000Z",
    })).rejects.toThrow("qualified_cache_result_not_qualified");
  });
});
