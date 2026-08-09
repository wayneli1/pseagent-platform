const EXAMPLE_REQUEST_PATTERN =
  /(?:举(?:一个|个|些)?例|举例|例子|示例|实例|案例|比如|for\s+example|examples?)/iu;
const EXAMPLE_MARKER_PATTERN = /(?:例如|比如|举例(?:来说)?)[：:,，]?/gu;

/**
 * Removes model-added illustrative examples when the user did not ask for
 * one. Ordinary answers have no formal evidence verifier, so optional
 * examples create factual risk without being needed to satisfy the request.
 */
export function stripUnrequestedExamples(
  question: string,
  answer: string,
): string {
  if (EXAMPLE_REQUEST_PATTERN.test(question)) return answer;
  const cleaned = answer.split(/(\r?\n\s*\r?\n+)/u).map((part) => {
    if (/^\r?\n/u.test(part)) return part;
    EXAMPLE_MARKER_PATTERN.lastIndex = 0;
    const match = EXAMPLE_MARKER_PATTERN.exec(part);
    if (match === null) return part;
    const prefix = part.slice(0, match.index).trimEnd();
    if (!prefix) return "";
    return /[。！？!?；;]$/u.test(prefix) ? prefix : `${prefix}。`;
  }).join("").replace(/(?:\r?\n\s*){3,}/gu, "\n\n").trim();
  return cleaned || answer;
}
