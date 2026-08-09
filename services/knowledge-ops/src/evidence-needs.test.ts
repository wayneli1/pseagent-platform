import { describe, expect, it } from "vitest";
import { evidenceRequestForProposal } from "./evidence-needs.js";

describe("evidenceRequestForProposal", () => {
  it("does not route every version question to the AIR offline template", () => {
    const request = evidenceRequestForProposal({
      rootCause: "knowledge_gap",
      targetDomain: "coremail-professional",
      title: "产品登录能力",
      canonicalQuestion: "某产品是否支持新的登录能力，启用版本、License 和配置步骤是什么？",
      blockingReason: "正式资料未覆盖该能力。",
    });

    expect(request.requiredMaterials).toEqual(expect.arrayContaining([
      expect.stringContaining("正式产品功能说明"),
      expect.stringContaining("版本—功能支持矩阵"),
      expect.stringContaining("License"),
      expect.stringContaining("管理员配置手册"),
    ]));
    expect(request.requiredMaterials.join(" ")).not.toContain("AIR 客户端");
  });

  it("keeps the AIR-specific template for an AIR capability request", () => {
    const request = evidenceRequestForProposal({
      rootCause: "knowledge_gap",
      targetDomain: "coremail-professional",
      title: "AIR 离线能力",
      canonicalQuestion: "AIR 完全离线环境支持哪些版本？",
      blockingReason: "正式资料未覆盖离线能力。",
    });

    expect(request.requiredMaterials[0]).toContain("AIR 客户端 AI 能力清单");
  });

  it("requests dated vulnerability evidence and legal approval for a security commitment", () => {
    const request = evidenceRequestForProposal({
      rootCause: "knowledge_gap",
      targetDomain: "coremail-professional",
      title: "当前版本安全承诺",
      canonicalQuestion: "能否保证当前版本已修复截至今天的全部高危 CVE，并写入合同？",
      blockingReason: "现有资料不能支持实时、全量和合同级承诺。",
    });

    expect(request.requiredMaterials).toEqual(expect.arrayContaining([
      expect.stringContaining("官方安全公告"),
      expect.stringContaining("CVE 或漏洞清单"),
      expect.stringContaining("正式复测"),
      expect.stringContaining("产品、安全和法务审批"),
    ]));
  });
});
