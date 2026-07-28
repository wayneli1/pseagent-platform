import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const formalReference = {
  index: 1,
  project: "coremail-professional",
  title: "邮件系统协议基础",
  path: "wiki/concepts/邮件系统协议基础.md",
  revision: "a".repeat(40),
  contentHash: "b".repeat(64),
} as const;
const pseFixture = {
  scope: "professional",
  status: "not_covered",
  answer: [
    "正式知识库相关信息：",
    "正文明确列出 SMTP、POP3、IMAP 和 HTTP/HTTPS 协议能力 [1]。",
    "覆盖结论：",
    "正式知识库未提及目标协议，无法根据正式知识库确认是否支持。",
    "正式知识库资料来源：",
    "[1] 邮件系统协议基础 — coremail-professional/wiki/concepts/邮件系统协议基础.md",
  ].join("\n\n"),
  references: [formalReference],
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

  it("accepts separately cited formal related context and an unchanged historical answer", () => {
    expect(validateHistoricalProbe(pseFixture, directFixture)).toEqual({
      mainRefs: 1,
      historyRefs: 1,
      confidence: "medium",
      rawEqual: true,
      warning: true,
    });
  });

  it("preserves the existing fixed uncovered primary answer for the Jira history probe", () => {
    expect(validateHistoricalProbe(
      {
        ...pseFixture,
        answer: NOT_COVERED_TEXT,
        references: [],
      },
      directFixture,
    )).toMatchObject({
      mainRefs: 0,
      historyRefs: 1,
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
      "uncited formal reference",
      {
        ...pseFixture,
        answer: pseFixture.answer.replace("协议能力 [1]", "协议能力"),
      },
      directFixture,
    ],
    [
      "formal citation without a reference",
      { ...pseFixture, references: [] },
      directFixture,
    ],
    [
      "historical source admitted as a formal reference",
      {
        ...pseFixture,
        references: [historical.references[0]],
      },
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

describe("related-context acceptance probe", () => {
  const supportedRelatedFacts = ["SMTP", "POP3", "IMAP", "HTTP/HTTPS"] as const;
  const allowedSourcePages = ["wiki/concepts/邮件系统协议基础.md"] as const;

  async function loadProbeAcceptance() {
    const probeModuleUrl = new URL(
      "../../../scripts/probe-related-context.mts",
      import.meta.url,
    );
    return await import(probeModuleUrl.href);
  }

  const finishFixture = {
    event: "finish",
    scope: "professional",
    status: "not_covered",
    citationCount: 1,
    elapsedMs: 123,
    historicalAttempted: true,
    historicalUsed: true,
  } as const;

  it("accepts partitioned formal related context with a diagnostics-confirmed history attempt", async () => {
    const { validateRelatedContextAcceptance } = await loadProbeAcceptance();

    expect(validateRelatedContextAcceptance(
      pseFixture,
      finishFixture,
      supportedRelatedFacts,
      allowedSourcePages,
    )).toEqual({
      formalRefs: 1,
      historyRefs: 1,
      historicalAttempted: true,
      historicalUsed: true,
    });
  });

  it.each([
    [
      "unsupported positive target claim",
      {
        ...pseFixture,
        answer: pseFixture.answer.replace(
          "无法根据正式知识库确认是否支持",
          "已经支持目标协议",
        ),
      },
      finishFixture,
    ],
    [
      "unsupported negative target claim",
      {
        ...pseFixture,
        answer: pseFixture.answer.replace(
          "无法根据正式知识库确认是否支持",
          "尚未支持目标协议",
        ),
      },
      finishFixture,
    ],
    [
      "protocol absent from the formal fixture body",
      {
        ...pseFixture,
        answer: pseFixture.answer.replace(
          "SMTP、POP3、IMAP 和 HTTP/HTTPS",
          "SMTP、QUANTUM-MAIL",
        ),
      },
      finishFixture,
    ],
    [
      "negative relation attached to all allowed protocol tokens",
      {
        ...pseFixture,
        answer: pseFixture.answer.replace(
          "正文明确列出 SMTP、POP3、IMAP 和 HTTP/HTTPS 协议能力 [1]。",
          "SMTP、POP3、IMAP 和 HTTP/HTTPS 都不受支持 [1]。",
        ),
      },
      finishFixture,
    ],
    [
      "uncertain relation attached to all allowed protocol tokens",
      {
        ...pseFixture,
        answer: pseFixture.answer.replace(
          "正文明确列出 SMTP、POP3、IMAP 和 HTTP/HTTPS 协议能力 [1]。",
          "是否支持 SMTP、POP3、IMAP 和 HTTP/HTTPS，正式知识库无法确认 [1]。",
        ),
      },
      finishFixture,
    ],
    [
      "negated support relation hidden behind positive keywords",
      {
        ...pseFixture,
        answer: pseFixture.answer.replace(
          "正文明确列出 SMTP、POP3、IMAP 和 HTTP/HTTPS 协议能力 [1]。",
          "系统并非支持 SMTP、POP3、IMAP 和 HTTP/HTTPS 的全部协议能力 [1]。",
        ),
      },
      finishFixture,
    ],
    [
      "valid protocol fact followed by an unsupported related fact",
      {
        ...pseFixture,
        answer: pseFixture.answer.replace(
          "正文明确列出 SMTP、POP3、IMAP 和 HTTP/HTTPS 协议能力 [1]。",
          [
            "正文明确列出 SMTP、POP3、IMAP 和 HTTP/HTTPS 协议能力 [1]。",
            "系统具备量子加密能力。",
          ].join("\n\n"),
        ),
      },
      finishFixture,
    ],
    [
      "allowed protocol tokens cited to an unrelated professional page",
      {
        ...pseFixture,
        answer: pseFixture.answer.replace(
          "[1] 邮件系统协议基础 — coremail-professional/wiki/concepts/邮件系统协议基础.md",
          "[1] Coremail AI 助手 — coremail-professional/wiki/concepts/coremail-ai助手.md",
        ),
        references: [{
          ...formalReference,
          title: "Coremail AI 助手",
          path: "wiki/concepts/coremail-ai助手.md",
        }],
      },
      finishFixture,
    ],
    [
      "incomplete formal related protocol facts",
      {
        ...pseFixture,
        answer: pseFixture.answer.replace(
          "SMTP、POP3、IMAP 和 HTTP/HTTPS",
          "SMTP",
        ),
      },
      finishFixture,
    ],
    [
      "direct unsupported positive target claim",
      {
        ...pseFixture,
        answer: `${pseFixture.answer}\n\n支持目标协议。`,
      },
      finishFixture,
    ],
    [
      "direct unsupported negative target claim",
      {
        ...pseFixture,
        answer: `${pseFixture.answer}\n\n不支持目标协议。`,
      },
      finishFixture,
    ],
    [
      "passive unsupported positive target claim",
      {
        ...pseFixture,
        answer: `${pseFixture.answer}\n\n目标协议受支持。`,
      },
      finishFixture,
    ],
    [
      "unsupported target availability claim",
      {
        ...pseFixture,
        answer: `${pseFixture.answer}\n\n目标协议不可用。`,
      },
      finishFixture,
    ],
    [
      "unsupported target communication claim",
      {
        ...pseFixture,
        answer: `${pseFixture.answer}\n\n量子卫星邮件协议能够正常通信。`,
      },
      finishFixture,
    ],
    [
      "unsupported target claim mixed into an uncertainty sentence",
      {
        ...pseFixture,
        answer: pseFixture.answer.replace(
          "正式知识库未提及目标协议，无法根据正式知识库确认是否支持。",
          "正式知识库未提及目标协议，无法根据正式知识库确认，但目标协议能够正常通信。",
        ),
      },
      finishFixture,
    ],
    [
      "unsupported target claim appended with only a comma",
      {
        ...pseFixture,
        answer: pseFixture.answer.replace(
          "正式知识库未提及目标协议，无法根据正式知识库确认是否支持。",
          "正式知识库无法确认目标协议是否支持，目标协议能够正常通信。",
        ),
      },
      finishFixture,
    ],
    [
      "implicit positive target claim appended without repeating the target",
      {
        ...pseFixture,
        answer: pseFixture.answer.replace(
          "正式知识库未提及目标协议，无法根据正式知识库确认是否支持。",
          "正式知识库无法确认目标协议是否支持，系统运行正常。",
        ),
      },
      finishFixture,
    ],
    [
      "extra target assertion hidden in the same uncertainty clause",
      {
        ...pseFixture,
        answer: pseFixture.answer.replace(
          "正式知识库未提及目标协议，无法根据正式知识库确认是否支持。",
          "正式知识库无法确认目标协议是否支持却已证实该协议能够正常通信。",
        ),
      },
      finishFixture,
    ],
    [
      "positive target modifier hidden inside an uncertainty clause",
      {
        ...pseFixture,
        answer: pseFixture.answer.replace(
          "正式知识库未提及目标协议，无法根据正式知识库确认是否支持。",
          "正式知识库无法确认正常工作的目标协议是否支持。",
        ),
      },
      finishFixture,
    ],
    [
      "target uncertainty appears only in the related-information section",
      {
        ...pseFixture,
        answer: pseFixture.answer
          .replace(
            "正文明确列出 SMTP、POP3、IMAP 和 HTTP/HTTPS 协议能力 [1]。",
            [
              "正文明确列出 SMTP、POP3、IMAP 和 HTTP/HTTPS 协议能力 [1]。",
              "正式知识库未提及目标协议，无法根据正式知识库确认是否支持。",
            ].join("\n"),
          )
          .replace(
            [
              "覆盖结论：",
              "正式知识库未提及目标协议，无法根据正式知识库确认是否支持。",
            ].join("\n\n"),
            ["覆盖结论：", "正式知识库没有更多结论。"].join("\n\n"),
          ),
      },
      finishFixture,
    ],
    [
      "positive target assertion before the related-information heading",
      {
        ...pseFixture,
        answer: `目标协议已受支持。\n\n${pseFixture.answer}`,
      },
      finishFixture,
    ],
    [
      "negative target assertion before the related-information heading",
      {
        ...pseFixture,
        answer: `目标协议不受支持。\n\n${pseFixture.answer}`,
      },
      finishFixture,
    ],
    [
      "missing formal reference",
      { ...pseFixture, references: [] },
      { ...finishFixture, citationCount: 0 },
    ],
    [
      "history attempt not confirmed",
      pseFixture,
      { ...finishFixture, historicalAttempted: false },
    ],
    [
      "diagnostics and public result disagree about historical use",
      pseFixture,
      { ...finishFixture, historicalUsed: false },
    ],
  ])("rejects %s", async (_label, result, finish) => {
    const { validateRelatedContextAcceptance } = await loadProbeAcceptance();
    expect(() => validateRelatedContextAcceptance(
      result,
      finish,
      supportedRelatedFacts,
      allowedSourcePages,
    )).toThrow();
  });

  it.each([
    "对于 2035 年量子卫星邮件协议是否受支持，无法依据正式知识库作出确认。",
    "目标协议的支持情况，现有正式知识库无法确认。",
    "正式知识库不足以判断目标协议能否获得支持。",
    "正式知识库无法确认是否支持目标协议。",
  ])("accepts target-oriented uncertainty wording: %s", async (conclusion) => {
    const { validateRelatedContextAcceptance } = await loadProbeAcceptance();
    const answer = pseFixture.answer.replace(
      "正式知识库未提及目标协议，无法根据正式知识库确认是否支持。",
      conclusion,
    );

    expect(validateRelatedContextAcceptance(
      { ...pseFixture, answer },
      finishFixture,
      supportedRelatedFacts,
      allowedSourcePages,
    )).toMatchObject({
      formalRefs: 1,
      historicalAttempted: true,
    });
  });

  it("accepts an attempted historical lookup that returned no historical answer", async () => {
    const { validateRelatedContextAcceptance } = await loadProbeAcceptance();
    expect(validateRelatedContextAcceptance(
      { ...pseFixture, historicalAnswer: undefined },
      { ...finishFixture, historicalUsed: false },
      supportedRelatedFacts,
      allowedSourcePages,
    )).toMatchObject({
      historyRefs: 0,
      historicalAttempted: true,
      historicalUsed: false,
    });
  });

  it("reads only content-free finish records from its probe-owned diagnostics directory", async () => {
    const {
      createProbeDiagnosticsDirectory,
      readProbeFinishEvents,
      removeProbeDiagnosticsDirectory,
    } = await loadProbeAcceptance();
    const { directory, ownershipToken } = createProbeDiagnosticsDirectory();
    try {
      writeFileSync(
        join(directory, "pseagent-2026-07-28-request.jsonl"),
        [
          JSON.stringify({
            event: "plan",
            requestId: "request-1",
            subject: "must-not-be-returned",
          }),
          JSON.stringify({
            event: "finish",
            requestId: "request-1",
            scope: "professional",
            status: "not_covered",
            citationCount: 1,
            elapsedMs: 123,
            historicalAttempted: true,
            historicalUsed: false,
          }),
        ].join("\n"),
        "utf8",
      );

      expect(readProbeFinishEvents(directory)).toEqual([
        expect.objectContaining({
          event: "finish",
          requestId: "request-1",
          historicalAttempted: true,
          historicalUsed: false,
        }),
      ]);
      expect(JSON.stringify(readProbeFinishEvents(directory)))
        .not.toContain("must-not-be-returned");
    } finally {
      removeProbeDiagnosticsDirectory(directory, ownershipToken);
    }
    expect(existsSync(directory)).toBe(false);
  });

  it("rejects a finish record containing content fields", async () => {
    const {
      createProbeDiagnosticsDirectory,
      readProbeFinishEvents,
      removeProbeDiagnosticsDirectory,
    } = await loadProbeAcceptance();
    const { directory, ownershipToken } = createProbeDiagnosticsDirectory();
    try {
      writeFileSync(
        join(directory, "pseagent-2026-07-28-content.jsonl"),
        `${JSON.stringify({
          event: "finish",
          requestId: "request-content",
          timestamp: "2026-07-28T00:00:00.000Z",
          scope: "professional",
          status: "not_covered",
          citationCount: 1,
          elapsedMs: 123,
          historicalAttempted: true,
          historicalUsed: false,
          subject: "must-not-be-admitted",
        })}\n`,
        "utf8",
      );
      expect(() => readProbeFinishEvents(directory))
        .toThrow("invalid_diagnostic_record");
    } finally {
      removeProbeDiagnosticsDirectory(directory, ownershipToken);
    }
  });

  it("refuses cleanup outside a verified probe-owned temporary directory", async () => {
    const { removeProbeDiagnosticsDirectory } = await loadProbeAcceptance();
    expect(() => removeProbeDiagnosticsDirectory(tmpdir(), "not-an-owner"))
      .toThrow("refusing_probe_temp_cleanup");
    expect(existsSync(tmpdir())).toBe(true);

    const unownedDirectory = mkdtempSync(
      join(tmpdir(), "pse-related-context-probe-"),
    );
    try {
      expect(() => removeProbeDiagnosticsDirectory(
        unownedDirectory,
        "not-an-owner",
      )).toThrow("refusing_probe_temp_cleanup");
    } finally {
      rmSync(unownedDirectory, { recursive: true, force: true });
    }
  });

  it("runs exactly three model attempts sequentially with a 300-second budget each", async () => {
    const { runRelatedContextAttempts } = await loadProbeAcceptance();
    const events: string[] = [];
    let active = 0;

    await runRelatedContextAttempts(async (run: number, budgetMs: number) => {
      expect(active).toBe(0);
      active += 1;
      events.push(`start:${run}:${budgetMs}`);
      await Promise.resolve();
      events.push(`finish:${run}`);
      active -= 1;
    });

    expect(events).toEqual([
      "start:1:300000",
      "finish:1",
      "start:2:300000",
      "finish:2",
      "start:3:300000",
      "finish:3",
    ]);
  });
});
