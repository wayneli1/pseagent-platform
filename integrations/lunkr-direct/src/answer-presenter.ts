interface AtomicBlock {
  readonly text: string;
  readonly separatorBefore: "\n" | "\n\n";
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/u;
const SOURCE_HEADING = "资料来源：";

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
  return normalizeCitationOrder(text)
    .replace(/\r\n?/gu, "\n")
    .trim();
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
