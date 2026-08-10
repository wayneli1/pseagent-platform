import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ModelClient } from "../apps/pseagent/src/model-client.ts";
import { ScopeRouter } from "../apps/pseagent/src/router.ts";
import {
  buildRoutingGoldReport,
  parseRoutingGoldDataset,
  type RoutingObservation,
} from "./probe-routing-gold-contract.ts";

const datasetPath = resolve(
  process.env.PSE_ROUTING_GOLD_PATH ??
    new URL("../tests/regression/routing-gold.json", import.meta.url)
      .pathname.slice(process.platform === "win32" ? 1 : 0),
);
const dataset = parseRoutingGoldDataset(JSON.parse(readFileSync(
  datasetPath,
  "utf8",
)));
const model = {
  completeJson: async () => {
    throw new Error("routing_gold_requires_deterministic_decision");
  },
  completeText: async () => {
    throw new Error("routing_gold_text_model_forbidden");
  },
} as unknown as ModelClient;
const router = new ScopeRouter(model);
const observations: RoutingObservation[] = [];

for (const item of dataset.cases) {
  let observation: RoutingObservation;
  try {
    observation = {
      id: item.id,
      actualScope: await router.route(
        item.question,
        item.conversationContext,
      ),
    };
  } catch (error) {
    observation = {
      id: item.id,
      failure: error instanceof Error ? error.message : "unexpected_error",
    };
  }
  observations.push(observation);
  process.stdout.write(`${JSON.stringify({ type: "result", ...observation })}\n`);
}

const metrics = buildRoutingGoldReport(dataset, observations);
const report = {
  type: "summary",
  generatedAt: new Date().toISOString(),
  datasetPath,
  frozenAt: dataset.frozenAt,
  observations,
  ...metrics,
};
const outputPath = resolve(
  process.env.PSE_ROUTING_GOLD_OUTPUT ??
    join(tmpdir(), "pseagent-routing-gold", `routing-gold-${Date.now()}.json`),
);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ...report, observations: undefined, outputPath })}\n`);
if (!metrics.qualified) process.exitCode = 1;
