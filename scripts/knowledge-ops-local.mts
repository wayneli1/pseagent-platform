import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ContentCipher,
  InMemoryKnowledgeOpsStore,
  KnowledgeOpsApi,
  KnowledgeOpsService,
  StaticTokenAuthorizer,
  createKnowledgeOpsHttpServer,
} from "../services/knowledge-ops/src/index.ts";
import {
  IndependentAnswerReviewer,
  KnowledgeOpsWorker,
  SafeGitWorkspace,
  SnapshotManager,
  loadAnswerReviewModelConfig,
} from "../services/knowledge-ops-worker/src/index.ts";
import { OpenAiCompatibleModelClient } from "../apps/pseagent/src/embedded.ts";

const adminToken = required("KNOWLEDGE_OPS_LOCAL_ADMIN_TOKEN");
const serviceToken = required("KNOWLEDGE_OPS_SERVICE_TOKEN");
const professional = required("PROFESSIONAL_KB_ROOT");
const general = required("GENERAL_KB_ROOT");
const staticRoot = path.resolve("apps/knowledge-ops-admin/dist");
const runtimeRoot = path.join(tmpdir(), "pseagent-knowledge-ops-local");
const store = new InMemoryKnowledgeOpsStore();
const cipher = new ContentCipher(randomBytes(32));
const service = new KnowledgeOpsService(store, cipher);
const authorizer = new StaticTokenAuthorizer([
  tokenEntry(adminToken, "local-admin", ["admin"]),
  tokenEntry(serviceToken, "lunkr-local", ["service"]),
]);
const sources = [
  { domain: "coremail-professional" as const, root: professional },
  { domain: "presales-general" as const, root: general },
];
const reviewModel = loadAnswerReviewModelConfig(process.env);
const worker = new KnowledgeOpsWorker("local-worker", {
  store,
  sources,
  snapshots: new SnapshotManager(path.join(runtimeRoot, "snapshots")),
  git: new SafeGitWorkspace([professional, general], path.join(runtimeRoot, "worktrees")),
  cipher,
  answerReviewer: new IndependentAnswerReviewer(
    new OpenAiCompatibleModelClient(reviewModel),
  ),
});
await store.enqueueJob("compile_catalog", { trigger: "local_startup" });
const server = createKnowledgeOpsHttpServer(
  new KnowledgeOpsApi(service, authorizer),
  { staticRoot, readiness: async () => true },
);

let stopping = false;
const workerLoop = (async () => {
  while (!stopping) {
    const worked = await worker.runOnce();
    if (!worked) await new Promise((resolve) => setTimeout(resolve, 500));
  }
})().catch((error: unknown) => {
  process.stderr.write(`knowledge-ops.local.worker.failed ${safeError(error)}\n`);
  process.exitCode = 1;
  stopping = true;
  server.close();
});

server.listen(19830, "127.0.0.1", () => {
  process.stdout.write("knowledge-ops.local.ready http://127.0.0.1:19830\n");
});

const stop = async () => {
  if (stopping) return;
  stopping = true;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await workerLoop;
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}

function tokenEntry(
  token: string,
  actorId: string,
  roles: readonly ("admin" | "service")[],
) {
  return {
    tokenHash: createHash("sha256").update(token, "utf8").digest("hex"),
    actor: { actorId, roles },
  };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 160) : "unknown_error";
}
