import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  answerStatusSchema,
  knowledgeRequirementIdSchema,
  scopeSchema,
} from "./contracts.js";

const safePageSchema = z.string().refine((path) =>
  path.startsWith("wiki/") &&
  path.endsWith(".md") &&
  !path.includes("\\") &&
  !path.split("/").includes(".."));
const factExpectationSchema = z.union([
  z.string().trim().min(1),
  z.array(z.string().trim().min(1)).min(2).max(6),
]);
const evidenceRequirementSchema = z.object({
  id: knowledgeRequirementIdSchema,
  question: z.string().trim().min(1),
  queries: z.array(z.string().trim().min(1)).min(1).max(3),
  expectedEvidencePages: z.array(safePageSchema).min(1).max(3),
  requiredFacts: z.array(factExpectationSchema).min(1),
}).strict();
const evidenceCaseSchema = z.object({
  id: z.string().regex(/^EC0[1-5]$/u),
  variants: z.array(z.object({
    question: z.string().trim().min(1),
    requiredFacts: z.array(factExpectationSchema).min(1),
  }).strict()).length(2),
  expectedScope: scopeSchema,
  expectedStatus: answerStatusSchema,
  requirements: z.array(evidenceRequirementSchema).max(6),
  requiredFacts: z.array(factExpectationSchema).min(1),
  forbiddenFacts: z.array(z.string().trim().min(1)).min(1),
  maxElapsedMs: z.literal(300_000),
}).strict().superRefine((item, context) => {
  if (item.expectedScope === "normal" && item.requirements.length !== 0) {
    context.addIssue({
      code: "custom",
      path: ["requirements"],
      message: "normal_case_must_not_retrieve",
    });
  }
  if (item.expectedScope !== "normal" && item.requirements.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["requirements"],
      message: "knowledge_case_requires_requirements",
    });
  }
  item.requirements.forEach((requirement, index) => {
    if (requirement.id !== `R${index + 1}`) {
      context.addIssue({
        code: "custom",
        path: ["requirements", index, "id"],
        message: "requirement_ids_must_be_sequential",
      });
    }
  });
});
const corpusSchema = z.object({
  version: z.literal(1),
  revisions: z.object({
    "coremail-professional": z.string().regex(/^[a-f0-9]{40}$/u),
    "presales-general": z.string().regex(/^[a-f0-9]{40}$/u),
  }).strict(),
  cases: z.array(evidenceCaseSchema).length(5),
}).strict();

const corpusPath = fileURLToPath(
  new URL("../../../tests/regression/evidence-coverage.json", import.meta.url),
);
const corpus = corpusSchema.parse(JSON.parse(readFileSync(corpusPath, "utf8")));

describe("five-question evidence coverage golden set", () => {
  it("pins both knowledge snapshots and contains five stable cases", () => {
    expect(corpus.cases.map((item) => item.id)).toEqual([
      "EC01",
      "EC02",
      "EC03",
      "EC04",
      "EC05",
    ]);
    expect(corpus.revisions["coremail-professional"]).toHaveLength(40);
    expect(corpus.revisions["presales-general"]).toHaveLength(40);
  });

  it("contains one paraphrase and complete acceptance evidence for every case", () => {
    const questions = corpus.cases.flatMap(
      (item) => item.variants.map((variant) => variant.question),
    );
    expect(new Set(questions).size).toBe(10);
    for (const item of corpus.cases) {
      expect(item.variants).toHaveLength(2);
      expect(item.variants.every((variant) => variant.requiredFacts.length > 0)).toBe(true);
      expect(item.maxElapsedMs).toBe(300_000);
      expect(item.requiredFacts.length).toBeGreaterThan(0);
      expect(item.forbiddenFacts.length).toBeGreaterThan(0);
      for (const requirement of item.requirements) {
        expect(requirement.expectedEvidencePages.length).toBeGreaterThan(0);
        expect(requirement.requiredFacts.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the PSEAgent self case normal and gives composite cases separate requirements", () => {
    expect(corpus.cases[0]).toMatchObject({
      id: "EC01",
      expectedScope: "normal",
      expectedStatus: "answered",
      requirements: [],
    });
    expect(corpus.cases.find((item) => item.id === "EC03")?.requirements.map((item) => item.id))
      .toEqual(["R1", "R2", "R3"]);
    expect(corpus.cases.find((item) => item.id === "EC04")?.requirements.map((item) => item.id))
      .toEqual(["R1", "R2", "R3"]);
    expect(corpus.cases.find((item) => item.id === "EC05")?.requirements.map((item) => item.id))
      .toEqual(["R1", "R2"]);
  });

  it("allows bounded wording alternatives without weakening per-fact acceptance", () => {
    const ec03 = corpus.cases.find((item) => item.id === "EC03");
    expect(ec03?.requiredFacts).toContainEqual([
      "约30台服务器",
      "30台左右服务器",
      "共30台服务器",
      "30台服务器",
      "约32台服务器",
      "32台服务器",
    ]);
    expect(ec03?.requiredFacts).toContainEqual([
      "两副本",
      "双副本",
      "两机互备",
      "两两互备",
      "双机互备",
      "双机多活",
    ]);
    const ec05 = corpus.cases.find((item) => item.id === "EC05");
    const ec04 = corpus.cases.find((item) => item.id === "EC04");
    expect(ec04?.requiredFacts).toContainEqual(["migrateX", "DTS", "domino-migrate.jar"]);
    expect(ec04?.requiredFacts).toContainEqual([
      "32位JDK",
      "JDK必须使用32位",
      "32位版本",
    ]);
    expect(ec05?.requiredFacts).toContainEqual(["反垃圾", "垃圾邮件过滤", "垃圾邮件检测"]);
    expect(ec05?.requiredFacts).toContainEqual(["反钓鱼", "钓鱼邮件", "钓鱼检测"]);
    expect(ec05?.requiredFacts).toContainEqual(["信创合规", "全栈信创", "全栈国产化"]);
  });
});
