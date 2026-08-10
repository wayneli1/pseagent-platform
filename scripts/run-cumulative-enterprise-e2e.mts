import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const caseIds = (process.env.E2E_CUMULATIVE_CASE_IDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (caseIds.length === 0 || new Set(caseIds).size !== caseIds.length) {
  throw new Error("cumulative_enterprise_e2e_case_ids_invalid");
}

const rounds: Record<string, unknown>[] = [];
for (let roundIndex = 0; roundIndex < caseIds.length; roundIndex += 1) {
  const roundCaseIds = caseIds.slice(0, roundIndex + 1);
  const records: Record<string, unknown>[] = [];
  process.stdout.write(`${JSON.stringify({
    type: "cumulative_round_started",
    round: roundIndex + 1,
    caseIds: roundCaseIds,
  })}\n`);
  for (const caseId of roundCaseIds) {
    const reportPath = await runCase(caseId, roundIndex + 1);
    const report = JSON.parse(await readFile(reportPath, "utf8")) as {
      records?: Record<string, unknown>[];
    };
    const record = report.records?.[0];
    if (record === undefined) throw new Error(`cumulative_case_record_missing:${caseId}`);
    records.push(record);
    const checks = Array.isArray(record.deterministicChecks)
      ? record.deterministicChecks as Array<{ passed?: boolean }>
      : [];
    const passed = checks.length > 0 && checks.every((check) => check.passed === true);
    process.stdout.write(`${JSON.stringify({
      type: "cumulative_case_completed",
      round: roundIndex + 1,
      caseId,
      requestId: record.requestId,
      scope: record.actualScope,
      status: record.answerStatus,
      deterministicPassed: passed,
      reportPath,
    })}\n`);
    if (!passed) {
      throw new Error(`cumulative_regression_failed:round_${roundIndex + 1}:${caseId}`);
    }
  }
  rounds.push({ round: roundIndex + 1, caseIds: roundCaseIds, passed: true, records });
  process.stdout.write(`${JSON.stringify({
    type: "cumulative_round_completed",
    round: roundIndex + 1,
    caseIds: roundCaseIds,
    passed: true,
  })}\n`);
}

process.stdout.write(`${JSON.stringify({
  type: "cumulative_summary",
  roundCount: rounds.length,
  invocationCount: rounds.reduce((sum, round) =>
    sum + (Array.isArray(round.records) ? round.records.length : 0), 0),
  passed: true,
})}\n`);

async function runCase(caseId: string, round: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/run-enterprise-e2e.mts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          E2E_CASE_ID: caseId,
          E2E_CUMULATIVE_ROUND: String(round),
        },
        stdio: ["ignore", "pipe", "inherit"],
        windowsHide: true,
      },
    );
    let reportPath: string | undefined;
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      process.stdout.write(chunk);
      buffered += chunk;
      const lines = buffered.split(/\r?\n/u);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as { type?: string; reportPath?: string };
          if (event.type === "phase_summary") reportPath = event.reportPath;
        } catch {
          // Child output is intentionally streamed; only JSON events are inspected.
        }
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`cumulative_case_process_failed:${caseId}:${code ?? "signal"}`));
      } else if (reportPath === undefined) {
        reject(new Error(`cumulative_case_report_missing:${caseId}`));
      } else {
        resolve(reportPath);
      }
    });
  });
}
