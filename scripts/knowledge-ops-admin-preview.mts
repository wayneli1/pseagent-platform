import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import {
  ContentCipher,
  InMemoryKnowledgeOpsStore,
  KnowledgeOpsApi,
  KnowledgeOpsAuthorizer,
  KnowledgeOpsService,
  createAdminPasswordHash,
  createKnowledgeOpsHttpServer,
} from "../services/knowledge-ops/src/index.ts";

const previewUsername="admin",previewPassword=randomBytes(9).toString("base64url");
const store = new InMemoryKnowledgeOpsStore();
const cipher = new ContentCipher(randomBytes(32));
const service = new KnowledgeOpsService(store, cipher);
const now = new Date().toISOString();
const serviceActor = { actorId: "lunkr-preview", roles: ["service"] as const };

const samples = [
  { classification: "incorrect", status: "new", comment: "版本边界说明不准确", user: "Wayne 黎政良", scope: "coremail" },
  { classification: "missing", status: "triaged", comment: "没有回答归档数据迁移", user: "Luna 陈", scope: "general" },
  { classification: "useful", status: "resolved", comment: "回答完整，可以直接使用", user: "Alex 王", scope: "coremail" },
  { classification: "evidence", status: "in_review", comment: "需要补充原始资料链接", user: "Mia 林", scope: "general" },
] as const;

for (const [offset, sample] of samples.entries()) {
  const index = offset + 1;
  const item = await service.ingestFeedback(serviceActor, {
    caseId: randomUUID(),
    requestId: randomUUID(),
    pseudonymousUserId: String(index).repeat(64),
    userDisplayName: sample.user,
    questionId: index,
    classification: sample.classification,
    comment: sample.comment,
    question: `示例用户问题 ${index}`,
    answer: `这是用于视觉检查的示例回答 ${index}。`,
    answerStatus: "answered",
    scope: sample.scope,
    referenceCount: index,
    answeredAt: now,
    submittedAt: now,
    source: "lunkr_direct",
  });
  await store.updateFeedback(item.caseId, { status: sample.status });
}

const previewIssue = (await store.listIssues({ limit: 1, offset: 0 })).items[0];
if (previewIssue !== undefined) {
  const draftId = randomUUID();
  await store.createRepairDraft({
    draftId,
    issueId: previewIssue.issueId,
    status: "draft_ready",
    model: "deepseek_v4_flash",
    targetKind: "answer_card",
    targetDomain: "coremail-professional",
    targetPath: "governance/question-families/migration.json",
    baseGitRevision: "a".repeat(40),
    encryptedPayload: cipher.encrypt({
      proposal: {
        rootCause: "user_incorrect",
        targetKind: "answer_card",
        targetDomain: "coremail-professional",
        targetPath: "governance/question-families/migration.json",
        cardId: "PRO-PREVIEW-MIGRATION",
        title: "迁移前准备",
        canonicalQuestion: "迁移前需要确认哪些设置？",
        aliases: ["迁移要准备什么？"],
        answerTemplate: "迁移前先确认域名、账号、路由和归档范围，再根据已核实的环境信息制定迁移计划。",
        obligations: [
          {
            id: "O1",
            label: "列出迁移前设置",
            evidencePolicy: "direct",
            requiredConcepts: ["域名", "账号", "路由", "归档"],
            forbiddenClaims: ["承诺所有环境可直接迁移"],
            preferredEvidencePaths: ["wiki/concepts/迁移.md"],
          },
        ],
        regressionQuestions: [
          { kind: "canonical", question: "迁移前需要确认哪些设置？" },
          { kind: "alias", question: "迁移要准备什么？" },
          { kind: "colloquial", question: "迁移这事儿要先整啥？" },
          { kind: "follow_up", question: "那路由应该怎么确认？" },
          { kind: "negative", question: "今天天气怎么样？" },
        ],
        generationSummary: "补足迁移前置条件，并覆盖同义问法和连续追问。",
        publishable: true,
      },
    }),
    createdBy: "preview-admin",
    createdAt: now,
    updatedAt: now,
  });
  await store.updateIssue(previewIssue.issueId, "in_progress");
}

for (let index = 1; index <= 6; index += 1) {
  await store.createCardRevision({
    revisionId: randomUUID(),
    cardId: `PRO-PREVIEW-${index}`,
    domain: index % 2 ? "coremail-professional" : "presales-general",
    revision: 1,
    status: index < 5 ? "approved" : "in_review",
    content: { title: `示例答案卡 ${index}`, canonicalQuestion: `示例问题 ${index}` },
    createdBy: index < 5 ? "knowledge-editor" : "pending-editor",
    baseGitRevision: String(index).repeat(40),
    createdAt: now,
    updatedAt: now,
  });
}

await store.enqueueJob("regression_run", { suite: "all" });
const running = await store.enqueueJob("compile_catalog", {});
await store.claimJob("preview-worker");
await store.completeJob(running.jobId, { ok: true }).catch(() => undefined);
await store.appendAudit({
  auditId: randomUUID(),
  actorId: "knowledge-editor",
  action: "card.revision.create",
  resourceType: "card_revision",
  resourceId: randomUUID(),
  metadata: { domain: "coremail-professional" },
  createdAt: now,
});

const authorizer = new KnowledgeOpsAuthorizer([],{username:previewUsername,passwordHash:await createAdminPasswordHash(previewPassword),sessionTtlMs:3_600_000});
const server = createKnowledgeOpsHttpServer(new KnowledgeOpsApi(service, authorizer), {
  staticRoot: path.resolve(import.meta.dirname, "../apps/knowledge-ops-admin/dist"),
});

server.listen(19832, "127.0.0.1", () => {
  process.stdout.write(`preview.ready http://127.0.0.1:19832 username=${previewUsername} password=${previewPassword}\n`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close());
}
