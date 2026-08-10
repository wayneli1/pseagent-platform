interface AtomicBlock {
  readonly text: string;
  readonly separatorBefore: "\n" | "\n\n";
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/u;
const SOURCE_HEADING = "资料来源：";
const LONG_NOTICE_MAX_CHARS = 100;
const LONG_NOTICE_MAX_TOPICS = 4;
const LONG_NOTICE_TOPIC_MAX_CHARS = 24;
const NON_CONTENT_HEADINGS = new Set([
  "回答",
  "完整回答",
  "问题分析",
  "内容概览",
  "摘要",
  "概述",
  "资料来源",
  "参考资料",
  "参考文献",
]);

export function presentLongAnswerNotice(
  questionId: number,
  question: string,
  answer: string,
): string {
  if (!Number.isSafeInteger(questionId) || questionId <= 0) {
    throw new Error("questionId 必须是正整数");
  }
  const topics = extractAnswerTopics(answer);
  if (topics.length === 0) {
    const subject = truncateDisplayText(
      question.replace(/\s+/gu, " ").trim().replace(/[。！？?!]+$/gu, "") ||
        "本次问题",
      42,
    );
    return [
      `问题 #${questionId} 已处理完成`,
      `本次回答围绕「${subject}」展开，完整内容见附件。`,
    ].join("\n");
  }

  const selected: string[] = [];
  for (const topic of topics) {
    if (selected.length >= LONG_NOTICE_MAX_TOPICS) break;
    const candidate = [...selected, topic];
    if (formatTopicNotice(questionId, candidate).length > LONG_NOTICE_MAX_CHARS) {
      break;
    }
    selected.push(topic);
  }
  return formatTopicNotice(questionId, selected);
}

export function presentAnswer(
  questionId: number,
  answer: string,
  maxChars: number,
): string[] {
  if (!Number.isSafeInteger(questionId) || questionId <= 0) {
    throw new Error("questionId 必须是正整数");
  }
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new Error("maxChars 必须是正整数");
  }
  const normalized = normalizeAnswerText(answer);
  if (normalized === "") return [];
  const shortPrefix = `问题 #${questionId} 的回答：\n\n`;
  if (shortPrefix.length + normalized.length <= maxChars) {
    return [`${shortPrefix}${normalized}`];
  }

  const blocks = atomicBlocks(normalized);
  let expectedTotal = 2;
  let bodies: string[] = [];
  for (let pass = 0; pass < 8; pass += 1) {
    const prefixLength =
      `问题 #${questionId}（${expectedTotal}/${expectedTotal}）\n\n`.length;
    const bodyLimit = maxChars - prefixLength;
    if (bodyLimit <= 0) {
      throw new Error("maxChars 无法容纳问题编号前缀");
    }
    bodies = packBlocks(blocks, bodyLimit);
    if (bodies.length === expectedTotal) break;
    expectedTotal = bodies.length;
  }

  const total = bodies.length;
  const rendered = bodies.map(
    (body, index) => `问题 #${questionId}（${index + 1}/${total}）\n\n${body}`,
  );
  if (rendered.some((chunk) => chunk.length > maxChars)) {
    throw new Error("回答分段超过 Lunkr 字符上限");
  }
  return rendered;
}

export function normalizeAnswerText(text: string): string {
  return plainTextPresentation(normalizeCitationOrder(text))
    .replace(/\r\n?/gu, "\n")
    .trim();
}

function plainTextPresentation(value: string): string {
  return value
    .replace(/^\s{0,3}#{1,6}[ \t]+/gmu, "")
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/gu, "$1")
    .replace(/__(?=\S)([^_\n]*?\S)__/gu, "$1");
}

export function normalizeCitationOrder(text: string): string {
  const citations = text.replace(
    /\[\d+\](?:\s*\[\d+\])+/gu,
    (group) => [...group.matchAll(/\[(\d+)\]/gu)]
      .map((match) => Number(match[1]))
      .filter((value, index, values) => values.indexOf(value) === index)
      .sort((left, right) => left - right)
      .map((value) => `[${value}]`)
      .join(""),
  );
  return sortNumberedSourceLines(citations);
}

function extractAnswerTopics(answer: string): string[] {
  const topics: string[] = [];
  const seen = new Set<string>();
  for (const line of answer.replace(/\r\n?/gu, "\n").split("\n")) {
    const heading = headingText(line);
    if (heading === undefined) continue;
    const cleaned = heading
      .replace(/\[\d+\]/gu, "")
      .replace(/[*_`~]/gu, "")
      .replace(/\s+/gu, " ")
      .replace(/[：:]$/u, "")
      .trim();
    const dedupeKey = cleaned.toLocaleLowerCase();
    if (
      cleaned === "" ||
      /[。！？；;]$/u.test(cleaned) ||
      NON_CONTENT_HEADINGS.has(cleaned) ||
      seen.has(dedupeKey)
    ) {
      continue;
    }
    seen.add(dedupeKey);
    topics.push(truncateDisplayText(cleaned, LONG_NOTICE_TOPIC_MAX_CHARS));
  }
  return topics;
}

function headingText(line: string): string | undefined {
  const patterns = [
    /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u,
    /^\s*[一二三四五六七八九十百]+[、.．]\s*(.+?)\s*$/u,
    /^\s*\d{1,2}[、.．]\s*(.+?)\s*$/u,
    /^\s*[（(](?:\d{1,2}|[一二三四五六七八九十百]+)[）)]\s*(.+?)\s*$/u,
    /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/u,
  ];
  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

function formatTopicNotice(
  questionId: number,
  topics: readonly string[],
): string {
  return [
    `问题 #${questionId} 已处理完成`,
    `本次回答涵盖：${topics.join("、")}。完整内容见附件。`,
  ].join("\n");
}

function truncateDisplayText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function sortNumberedSourceLines(text: string): string {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== SOURCE_HEADING) continue;
    let end = index + 1;
    const sources: Array<{ line: string; number: number; order: number }> = [];
    while (end < lines.length) {
      const match = lines[end]?.match(/^\s*\[(\d+)\]\s+\S/u);
      if (match === undefined || match === null) break;
      sources.push({
        line: lines[end]!,
        number: Number(match[1]),
        order: sources.length,
      });
      end += 1;
    }
    if (sources.length > 1) {
      sources.sort((left, right) =>
        left.number - right.number || left.order - right.order);
      lines.splice(
        index + 1,
        sources.length,
        ...sources.map((source) => source.line),
      );
    }
    index = end - 1;
  }
  return lines.join("\n");
}

function atomicBlocks(text: string): AtomicBlock[] {
  const paragraphs = text.split(/\n{2,}/u);
  const blocks: AtomicBlock[] = [];
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const separatorBefore = paragraphIndex === 0 ? "\n\n" : "\n\n";
    const lines = paragraph.split("\n");
    if (!lines.some((line) => LIST_ITEM.test(line))) {
      blocks.push({ text: paragraph, separatorBefore });
      return;
    }
    let current: string[] = [];
    let currentIsList = false;
    const flush = () => {
      if (current.length === 0) return;
      blocks.push({
        text: current.join("\n"),
        separatorBefore: blocks.length === 0 || !currentIsList ? "\n\n" : "\n",
      });
      current = [];
    };
    for (const line of lines) {
      if (LIST_ITEM.test(line)) {
        flush();
        currentIsList = true;
        current = [line];
      } else {
        current.push(line);
      }
    }
    flush();
  });
  return blocks.filter((block) => block.text.trim() !== "");
}

function packBlocks(blocks: readonly AtomicBlock[], limit: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    const pieces = splitReadable(block.text, limit);
    pieces.forEach((piece, pieceIndex) => {
      const separator = pieceIndex === 0 ? block.separatorBefore : "";
      const candidate = current === "" ? piece : `${current}${separator}${piece}`;
      if (candidate.length <= limit) {
        current = candidate;
        return;
      }
      if (current !== "") chunks.push(current);
      current = piece;
    });
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

function splitReadable(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const pieces: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const minimumBoundary = Math.floor(limit * 0.55);
    const newline = window.lastIndexOf("\n", limit);
    const sentence = Math.max(
      ...["。", "！", "？", ".", "!", "?", "；", ";"]
        .map((character) => window.lastIndexOf(character, limit)),
    ) + 1;
    const whitespace = Math.max(
      window.lastIndexOf(" ", limit),
      window.lastIndexOf("\t", limit),
    );
    const boundary = Math.min(
      limit,
      [newline, sentence, whitespace]
        .find((candidate) => candidate >= minimumBoundary) ?? limit,
    );
    const piece = remaining.slice(0, boundary).trim();
    if (piece !== "") pieces.push(piece);
    remaining = remaining.slice(boundary).trimStart();
  }
  if (remaining !== "") pieces.push(remaining);
  return pieces;
}
