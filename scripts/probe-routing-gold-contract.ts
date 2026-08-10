import { z } from "zod";

const scopeSchema = z.enum(["professional", "general", "normal"]);
const routingCaseSchema = z.object({
  id: z.string().min(1).max(64),
  category: z.string().min(1).max(64),
  question: z.string().min(1),
  expectedScope: scopeSchema,
  conversationContext: z.string().min(1).optional(),
}).strict();
const datasetSchema = z.object({
  schemaVersion: z.literal(1),
  frozenAt: z.string().datetime(),
  minimumPerCategory: z.number().int().min(1).max(100),
  cases: z.array(routingCaseSchema).min(1).superRefine((cases, context) => {
    const ids = cases.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "duplicate_routing_case" });
    }
  }),
}).strict();

export type RoutingScope = z.infer<typeof scopeSchema>;

export interface RoutingGoldCase {
  readonly id: string;
  readonly category: string;
  readonly question: string;
  readonly expectedScope: RoutingScope;
  readonly conversationContext?: string;
}

export interface RoutingGoldDataset {
  readonly schemaVersion: 1;
  readonly frozenAt: string;
  readonly minimumPerCategory: number;
  readonly cases: readonly RoutingGoldCase[];
}

export interface RoutingObservation {
  readonly id: string;
  readonly actualScope?: RoutingScope;
  readonly failure?: string;
}

export interface RoutingMetric {
  readonly support: number;
  readonly correct: number;
  readonly recall: number;
}

export function parseRoutingGoldDataset(value: unknown): RoutingGoldDataset {
  return datasetSchema.parse(value) as RoutingGoldDataset;
}

export function buildRoutingGoldReport(
  dataset: RoutingGoldDataset,
  observations: readonly RoutingObservation[],
): {
  readonly total: number;
  readonly completed: number;
  readonly failures: number;
  readonly correct: number;
  readonly accuracy: number;
  readonly confusionMatrix: Record<RoutingScope, Record<RoutingScope, number>>;
  readonly perScope: Record<RoutingScope, RoutingMetric>;
  readonly perCategory: Readonly<Record<string, RoutingMetric>>;
  readonly insufficientCategories: readonly string[];
  readonly qualified: boolean;
} {
  const caseById = new Map(dataset.cases.map((item) => [item.id, item] as const));
  const observationById = new Map<string, RoutingObservation>();
  let failures = 0;
  for (const observation of observations) {
    if (!caseById.has(observation.id)) {
      throw new Error(`routing_case_unknown:${observation.id}`);
    }
    if (observationById.has(observation.id)) {
      throw new Error(`routing_observation_duplicate:${observation.id}`);
    }
    observationById.set(observation.id, observation);
    if (observation.failure !== undefined || observation.actualScope === undefined) {
      failures += 1;
    }
  }

  const scopes: readonly RoutingScope[] = ["general", "professional", "normal"];
  const confusionMatrix = Object.fromEntries(scopes.map((expected) => [
    expected,
    Object.fromEntries(scopes.map((actual) => [actual, 0])),
  ])) as Record<RoutingScope, Record<RoutingScope, number>>;
  let completed = 0;
  let correct = 0;
  for (const item of dataset.cases) {
    const observation = observationById.get(item.id);
    if (observation?.actualScope === undefined || observation.failure !== undefined) {
      continue;
    }
    completed += 1;
    confusionMatrix[item.expectedScope][observation.actualScope] += 1;
    if (observation.actualScope === item.expectedScope) correct += 1;
  }

  const perScope = Object.fromEntries(scopes.map((scope) => {
    const expected = dataset.cases.filter((item) => item.expectedScope === scope);
    const scopeCorrect = expected.filter((item) =>
      observationById.get(item.id)?.actualScope === scope &&
      observationById.get(item.id)?.failure === undefined).length;
    return [scope, metric(expected.length, scopeCorrect)];
  })) as Record<RoutingScope, RoutingMetric>;
  const categories = [...new Set(dataset.cases.map((item) => item.category))]
    .sort();
  const perCategory = Object.fromEntries(categories.map((category) => {
    const expected = dataset.cases.filter((item) => item.category === category);
    const categoryCorrect = expected.filter((item) =>
      observationById.get(item.id)?.actualScope === item.expectedScope &&
      observationById.get(item.id)?.failure === undefined).length;
    return [category, metric(expected.length, categoryCorrect)];
  }));
  const insufficientCategories = categories.filter((category) =>
    perCategory[category]!.support < dataset.minimumPerCategory);
  const total = dataset.cases.length;
  const accuracy = total === 0 ? 0 : correct / total;
  return {
    total,
    completed,
    failures,
    correct,
    accuracy,
    confusionMatrix,
    perScope,
    perCategory,
    insufficientCategories,
    qualified:
      observations.length === total &&
      completed === total &&
      failures === 0 &&
      accuracy >= 0.98 &&
      insufficientCategories.length === 0 &&
      Object.values(perCategory).every((item) => item.recall >= 0.98),
  };
}

function metric(support: number, correct: number): RoutingMetric {
  return {
    support,
    correct,
    recall: support === 0 ? 0 : correct / support,
  };
}
