import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HISTORICAL_ANSWER_WARNING } from "./contracts.js";
import { validateHistoricalProbe } from
  "./coremail-historical-probe-contract.js";
import { NOT_COVERED_TEXT } from "./response.js";

const historical = {
  provider: "coremail_mcp",
  verified: false,
  confidence: "medium",
  warning: HISTORICAL_ANSWER_WARNING,
  answer: "历史资料原文",
  references: [{
    sourceType: "jira",
    key: "CMHA-1097",
    title: "测试历史记录",
    versions: ["5.0"],
  }],
} as const;
const pseFixture = {
  scope: "professional",
  status: "not_covered",
  answer: NOT_COVERED_TEXT,
  references: [],
  historicalAnswer: historical,
} as const;
const directFixture = {
  answer: "历史资料原文",
  confidence: "medium",
  sources: [{
    source_type: "jira",
    key: "CMHA-1097",
    title: "测试历史记录",
  }],
} as const;

describe("validateHistoricalProbe", () => {
  it("bounds direct Coremail MCP initialization", () => {
    const probeSource = readFileSync(
      new URL("../../../scripts/probe-coremail-historical.mts", import.meta.url),
      "utf8",
    );

    expect(probeSource).toMatch(
      /directClient\.connect\(directTransport,\s*\{ timeout: 60_000 \}\)/,
    );
    expect(probeSource).toMatch(
      /directClient\.listTools\(\s*undefined,\s*\{ timeout: 60_000 \},?\s*\)/,
    );
  });

  it("isolates the covered-query sentinel from an invalid ancestor package", () => {
    const probeSource = readFileSync(
      new URL("../../../scripts/probe-coremail-historical.mts", import.meta.url),
      "utf8",
    );

    expect(probeSource).toContain(
      'path.join(temporaryRoot, "package.json")',
    );
  });

  it("accepts an unchanged sourced historical answer", () => {
    expect(validateHistoricalProbe(pseFixture, directFixture)).toEqual({
      mainRefs: 0,
      historyRefs: 1,
      confidence: "medium",
      rawEqual: true,
      warning: true,
    });
  });

  it.each([
    [
      "rewritten answer",
      { ...pseFixture, historicalAnswer: { ...historical, answer: "changed" } },
      directFixture,
    ],
    [
      "no historical answer",
      { ...pseFixture, historicalAnswer: undefined },
      directFixture,
    ],
    [
      "primary promoted",
      { ...pseFixture, status: "answered" },
      directFixture,
    ],
    [
      "direct result without Jira/Wiki",
      pseFixture,
      {
        ...directFixture,
        sources: [{ source_type: "local", title: "本地记录" }],
      },
    ],
  ])("rejects %s", (_label, pseValue, directValue) => {
    expect(() => validateHistoricalProbe(pseValue, directValue)).toThrow();
  });
});
