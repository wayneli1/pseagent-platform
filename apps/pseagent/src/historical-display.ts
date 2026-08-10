import {
  historicalAnswerSchema,
  type HistoricalAnswer,
  type HistoricalReference,
  type HistoricalRejectionReason,
} from "./contracts.js";
import { sanitizeFormalAnswer } from "./public-answer.js";

export const HISTORICAL_NOTICE_MESSAGES: Record<
  HistoricalRejectionReason,
  string
> = {
  topic_mismatch:
    "补充说明：已检索补充历史资料，但内容与当前问题不匹配，因此未展示。",
  low_confidence:
    "补充说明：已检索补充历史资料，但结果置信度较低，因此未展示。",
  no_reliable_source:
    "补充说明：已检索补充历史资料，但未找到与当前问题可靠匹配的内容。",
};

export const HISTORICAL_BODY_MAX_CHARS = 2_000;
export const HISTORICAL_REFERENCE_LIMIT = 3;
export const HISTORICAL_BLOCK_MAX_CHARS = 3_000;

const URL_PATTERN = /https?:\/\/[^\s)\]}>，。；;]+/giu;
const INTERNAL_OPERATOR_PATTERN =
  /(?:\bUse\s+(?:get|list|search)_[A-Za-z0-9_]+|structuredContent|next_action|list_attachments|get_wiki_page|get_jira_issue)/iu;
const SHELL_PROMPT_PATTERN = /\[[^\]\r\n]{1,80}@[^\]\r\n]{1,80}\]\s*[#$]/u;
const UNC_PATH_PATTERN = /\\\\(?:[^\s\\]+\\){2,}[^\s，。；;]*/gu;
const REDACTED_CONTENT_PATTERN = /\[REDACTED(?:_[A-Z_]+)?\]/u;

export function prepareHistoricalAnswerForDisplay(
  historical: HistoricalAnswer,
): HistoricalAnswer | undefined {
  const answer = sanitizeHistoricalBody(historical.answer);
  if (answer === "") return undefined;
  const references = historical.references
    .slice(0, HISTORICAL_REFERENCE_LIMIT)
    .map(withoutInternalUrl);
  if (references.length === 0) return undefined;
  return historicalAnswerSchema.parse({
    ...historical,
    answer,
    references,
  });
}

export function sanitizeHistoricalBody(value: string): string {
  const withoutUrls = sanitizeFormalAnswer(value)
    .replace(URL_PATTERN, "")
    .replace(UNC_PATH_PATTERN, "[内部路径已省略]");
  const retainedLines = withoutUrls.split(/\r?\n/gu).filter((line) =>
    !/^\s*(?:链接|地址|url|来源链接|内部链接)[：:]?\s*$/iu.test(line) &&
    !INTERNAL_OPERATOR_PATTERN.test(line) &&
    !SHELL_PROMPT_PATTERN.test(line) &&
    !REDACTED_CONTENT_PATTERN.test(line)
  );
  return truncateText(
    retainedLines.join("\n").replace(/\n{3,}/gu, "\n\n").trim(),
    HISTORICAL_BODY_MAX_CHARS,
  );
}

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = "\n\n…（内容已截断）";
  const budget = Math.max(0, maxChars - marker.length);
  const candidate = value.slice(0, budget);
  const paragraphBoundary = candidate.lastIndexOf("\n\n");
  const lineBoundary = candidate.lastIndexOf("\n");
  const sentenceBoundary = Math.max(
    candidate.lastIndexOf("。"),
    candidate.lastIndexOf("；"),
  );
  const preferredBoundary = Math.max(
    paragraphBoundary,
    lineBoundary,
    sentenceBoundary,
  );
  const boundary = preferredBoundary >= Math.floor(budget * 0.6)
    ? preferredBoundary + (candidate[preferredBoundary] === "\n" ? 0 : 1)
    : budget;
  return `${candidate.slice(0, boundary).trimEnd()}${marker}`;
}

function withoutInternalUrl(
  reference: HistoricalReference,
): HistoricalReference {
  const { url: _url, ...safe } = reference;
  return {
    ...safe,
    title: truncateField(safe.title, 160),
    ...(safe.id === undefined ? {} : { id: truncateField(safe.id, 80) }),
    ...(safe.key === undefined ? {} : { key: truncateField(safe.key, 80) }),
    ...(safe.updatedAt === undefined
      ? {}
      : { updatedAt: truncateField(safe.updatedAt, 80) }),
    ...(safe.status === undefined
      ? {}
      : { status: truncateField(safe.status, 80) }),
    ...(safe.versions === undefined
      ? {}
      : {
          versions: safe.versions.map((version) =>
            truncateField(version, 40)
          ),
        }),
  };
}

function truncateField(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}
