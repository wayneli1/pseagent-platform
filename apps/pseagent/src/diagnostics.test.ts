import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JsonlDiagnosticTraceFactory,
  recordDiagnostic,
  type DiagnosticTrace,
} from "./diagnostics.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (directory.startsWith(tmpdir())) rmSync(directory, { recursive: true, force: true });
  }
});

describe("development diagnostic trace", () => {
  it("writes only structured, bounded, redacted JSONL events under a temporary directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "pseagent-diagnostics-test-"));
    temporaryDirectories.push(directory);
    const trace = new JsonlDiagnosticTraceFactory(directory).start();

    trace.record({ event: "route", scope: "professional" });
    trace.record({
      event: "plan",
      subject: "Coremail password=secret-value",
      requirements: [{
        id: "R1",
        question: "Cookie: session-value，密码demo-pass-2026",
        queries: ["Bearer live-token", `安全网关${"长".repeat(2_000)}`],
      }],
    });
    trace.record({
      event: "model_payload",
      result: "rejected",
      reason: "invalid_schema:citations:invalid_type(expected=array)",
      repairAttempt: 1,
      schemaDescription: "pse_final_action",
      rawPayload: "{\"citations\":\"Bearer live-token\"}",
      rawPayloadLength: 37,
      finishReason: "length",
    });
    trace.record({
      event: "finish",
      scope: "professional",
      status: "answered",
      citationCount: 2,
      elapsedMs: 123,
      historicalAttempted: false,
      historicalUsed: false,
    });

    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    const content = readFileSync(join(directory, files[0] ?? ""), "utf8");
    expect(content).not.toContain("secret-value");
    expect(content).not.toContain("session-value");
    expect(content).not.toContain("live-token");
    expect(content).not.toContain("demo-pass-2026");
    expect(content).toContain("[REDACTED]");
    const records = content.trim().split("\n").map((line) => JSON.parse(line) as {
      requestId: string;
      event: string;
      answer?: string;
    });
    expect(records.map((record) => record.event)).toEqual([
      "route",
      "plan",
      "model_payload",
      "finish",
    ]);
    expect(new Set(records.map((record) => record.requestId))).toEqual(new Set([trace.requestId]));
    expect(records.every((record) => record.answer === undefined)).toBe(true);
    expect(content.length).toBeLessThan(10_000);
  });

  it("never lets a diagnostic sink failure change the answer path", () => {
    const trace = {
      requestId: "test",
      record: vi.fn(() => {
        throw new Error("disk full");
      }),
    } satisfies DiagnosticTrace;

    expect(() => recordDiagnostic(trace, { event: "route", scope: "normal" })).not.toThrow();
  });
});
