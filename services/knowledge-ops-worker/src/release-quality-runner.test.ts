import path from "node:path";
import { describe,expect,it } from "vitest";
import { summaryReportPath } from "./release-quality-runner.js";

describe("release quality process output",()=>{
  it("locates the final report after progress records",()=>{const report=path.resolve("quality.json");expect(summaryReportPath(`${JSON.stringify({type:"progress",caseId:"Q1"})}\n${JSON.stringify({type:"summary",passed:true,reportPath:report})}\n`)).toBe(report);});
  it("rejects output without an auditable report",()=>expect(()=>summaryReportPath('{"type":"summary","passed":false}\n')).toThrow("release_quality_report_path_missing"));
});
