import { z } from "zod";
import { InvalidModelPayloadError, type ModelClient } from "./model-client.js";

const questionCorrectionSchema = z.object({
  original: z.string().trim().min(1).max(128),
  normalized: z.string().trim().min(1).max(128),
  confidence: z.enum(["high", "medium"]),
}).strict();

const questionResolutionActionSchema = z.object({
  action: z.literal("resolve"),
  standaloneQuestion: z.string().trim().min(1).max(16_384),
  contextUsed: z.boolean(),
  inheritedSubjects: z.array(z.string().trim().min(1).max(128)).max(16),
  corrections: z.array(questionCorrectionSchema).max(16),
}).strict();

export interface ResolvedQuestion {
  readonly rawQuestion: string;
  readonly standaloneQuestion: string;
  readonly contextUsed: boolean;
  readonly inheritedSubjects: readonly string[];
  readonly corrections: readonly z.infer<typeof questionCorrectionSchema>[];
}

export interface QuestionResolverInput {
  readonly question: string;
  readonly conversationContext?: string;
  readonly signal?: AbortSignal;
}

export interface QuestionResolver {
  resolve(input: QuestionResolverInput): Promise<ResolvedQuestion>;
}

export class InvalidResolvedQuestionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "InvalidResolvedQuestionError";
  }
}

export const QUESTION_RESOLVER_SYSTEM_PROMPT = `你是 PSEAgent 的问题解析器，只输出一个 JSON 对象。
输出格式必须严格为：
{"action":"resolve","standaloneQuestion":"可脱离上下文理解的完整问题","contextUsed":true,"inheritedSubjects":["从上下文继承的主体"],"corrections":[{"original":"当前问题中的原词","normalized":"规范术语","confidence":"high|medium"}]}
只解决当前问题中的指代、省略和高置信度术语误写，不回答问题，不生成引用，不增加用户没有表达的事实。
当前问题明确出现的新主体、对象和限制条件优先于会话上下文；不得让旧主体覆盖新主体。
standaloneQuestion 必须保留当前问题的全部明确交付目标、并列对象和约束。
corrections.original 必须逐字来自当前问题，normalized 必须出现在 standaloneQuestion；不需要纠正时输出空数组。
只有确实使用上下文补全问题时 contextUsed 才能为 true；未使用时 inheritedSubjects 必须为空。
禁止输出 Markdown、解释或额外字段。`;

export function identityResolvedQuestion(question: string): ResolvedQuestion {
  const normalized = question.trim();
  return {
    rawQuestion: normalized,
    standaloneQuestion: normalized,
    contextUsed: false,
    inheritedSubjects: [],
    corrections: [],
  };
}

export class ModelQuestionResolver implements QuestionResolver {
  constructor(private readonly model: ModelClient) {}

  async resolve(input: QuestionResolverInput): Promise<ResolvedQuestion> {
    const question = input.question.trim();
    const context = input.conversationContext?.trim();
    if (!context) return identityResolvedQuestion(question);

    const messages = [
      { role: "system" as const, content: QUESTION_RESOLVER_SYSTEM_PROMPT },
      {
        role: "user" as const,
        content: JSON.stringify({
          currentQuestion: question,
          conversationContext: context,
        }),
      },
    ];
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const action = await this.model.completeJson({
          messages: attempt === 1
            ? messages
            : [
                ...messages,
                {
                  role: "user" as const,
                  content: "上一次输出不符合问题解析契约。只重新输出合法 resolve JSON，不要解释。",
                },
              ],
          schema: questionResolutionActionSchema,
          schemaDescription: "pse_resolved_question",
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        return validateResolvedQuestion(question, context, action);
      } catch (error) {
        lastError = error;
        if (
          !(error instanceof InvalidModelPayloadError) &&
          !(error instanceof InvalidResolvedQuestionError)
        ) {
          throw error;
        }
        if (attempt === 3) throw error;
      }
    }
    throw lastError;
  }
}

function validateResolvedQuestion(
  rawQuestion: string,
  context: string,
  action: z.infer<typeof questionResolutionActionSchema>,
): ResolvedQuestion {
  if (!action.contextUsed && action.inheritedSubjects.length > 0) {
    throw new InvalidResolvedQuestionError("unused_context_has_inherited_subjects");
  }
  for (const subject of action.inheritedSubjects) {
    if (!containsSemanticText(context, subject) &&
        !containsSemanticText(action.standaloneQuestion, subject)) {
      throw new InvalidResolvedQuestionError("inherited_subject_not_traceable");
    }
  }
  for (const correction of action.corrections) {
    if (!rawQuestion.includes(correction.original)) {
      throw new InvalidResolvedQuestionError("correction_original_not_in_question");
    }
    if (!containsSemanticText(action.standaloneQuestion, correction.normalized)) {
      throw new InvalidResolvedQuestionError("correction_not_in_standalone_question");
    }
  }
  return {
    rawQuestion,
    standaloneQuestion: action.standaloneQuestion,
    contextUsed: action.contextUsed,
    inheritedSubjects: action.inheritedSubjects,
    corrections: action.corrections,
  };
}

function containsSemanticText(container: string, value: string): boolean {
  return normalizeSemanticText(container).includes(normalizeSemanticText(value));
}

function normalizeSemanticText(value: string): string {
  return value.toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, "");
}

