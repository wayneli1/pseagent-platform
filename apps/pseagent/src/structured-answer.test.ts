import { describe, expect, it } from "vitest";
import type { FinalAction } from "./contracts.js";
import {
  buildStructuredAnswer,
  renderStructuredAnswer,
} from "./structured-answer.js";

describe("structured answer", () => {
  it("deduplicates repeated supported statements across obligations", () => {
    const action: FinalAction = {
      action: "final",
      requirements: [
        {
          id: "R1",
          coverage: "complete",
          answer: "支持标准 IMAP 协议 [1]。",
          citations: [1],
        },
        {
          id: "R2",
          coverage: "complete",
          answer: "支持标准 IMAP 协议 [1]。\n此外，可按项目范围验证并发指标 [2]。",
          citations: [1, 2],
        },
      ],
      citations: [1, 2],
    };

    const structured = buildStructuredAnswer(action);
    const rendered = renderStructuredAnswer(structured);

    expect(structured.sections[1]?.segments).toHaveLength(2);
    expect(rendered.match(/支持标准 IMAP 协议/gu)).toHaveLength(1);
    expect(rendered).toContain("可按项目范围验证并发指标 [2]。");
    expect(structured.coverage).toBe("complete");
  });

  it("does not split a URL query into separate answer bullets", () => {
    const structured = buildStructuredAnswer({
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "应用首页通过 sso.do?orgId=acme 进入邮箱 [1]。",
        citations: [1],
      }],
      citations: [1],
    });

    expect(renderStructuredAnswer(structured)).toBe(
      "应用首页通过 sso.do?orgId=acme 进入邮箱 [1]。",
    );
  });

  it("replaces model numbering with stable bullets and removes dangling connectors", () => {
    const structured = buildStructuredAnswer({
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "1. 首先核对版本 [1]。\n2. 此外，确认适用范围 [1]。",
        citations: [1],
      }],
      citations: [1],
    });

    expect(renderStructuredAnswer(structured)).toBe(
      "- 首先核对版本 [1]。\n- 确认适用范围 [1]。",
    );
  });

  it("drops an orphaned later step after earlier steps were removed", () => {
    const structured = buildStructuredAnswer({
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "接入前需确认接收格式和协议 [2]。\n3）重启 deliveragent 服务生效 [1]。\n归档邮箱必须是外站地址 [1]。",
        citations: [2, 1],
      }],
      citations: [2, 1],
    });

    expect(renderStructuredAnswer(structured)).toBe(
      "- 接入前需确认接收格式和协议 [2]。\n- 归档邮箱必须是外站地址 [1]。",
    );
  });

  it("keeps and normalizes a complete full-width ordered sequence", () => {
    const structured = buildStructuredAnswer({
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer: "1）添加配置文件 [1]。\n2）添加投递规则 [1]。\n3）重启服务 [1]。",
        citations: [1],
      }],
      citations: [1],
    });

    expect(renderStructuredAnswer(structured)).toBe(
      "- 添加配置文件 [1]。\n- 添加投递规则 [1]。\n- 重启服务 [1]。",
    );
  });

  it("keeps an ordered sequence whose first step follows a list introduction", () => {
    const structured = buildStructuredAnswer({
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer:
          "操作步骤为：1. 说明期待；2. 确认可行性；3. 邀请复述；4. 讨论障碍；5. 约定检查点 [1]。",
        citations: [1],
      }],
      citations: [1],
    });

    const rendered = renderStructuredAnswer(structured);
    expect(rendered).toContain("说明期待");
    expect(rendered).toContain("确认可行性");
    expect(rendered).toContain("邀请复述");
    expect(rendered).toContain("讨论障碍");
    expect(rendered).toContain("约定检查点");
  });

  it("keeps later items when a sequence is introduced as confirmation items", () => {
    const structured = buildStructuredAnswer({
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer:
          "实施前需确认以下事项：1）确认用户所属组织 [1]；2）确认产品版本 [1]；3）确认实际组织配置 [1]。",
        citations: [1],
      }],
      citations: [1],
    });

    const rendered = renderStructuredAnswer(structured);
    expect(rendered).toContain("确认用户所属组织");
    expect(rendered).toContain("确认产品版本");
    expect(rendered).toContain("确认实际组织配置");
  });

  it("keeps an ordered sequence introduced as a concrete method", () => {
    const structured = buildStructuredAnswer({
      action: "final",
      requirements: [{
        id: "R1",
        coverage: "complete",
        answer:
          "具体做法：1. 识别角色 [1]；2. 判断关系状态 [1]；3. 提供相应价值 [1]；4. 验证信息 [1]；5. 扩大覆盖 [1]；6. 定期更新 [1]。",
        citations: [1],
      }],
      citations: [1],
    });

    const rendered = renderStructuredAnswer(structured);
    expect(rendered).toContain("识别角色");
    expect(rendered).toContain("判断关系状态");
    expect(rendered).toContain("提供相应价值");
    expect(rendered).toContain("验证信息");
    expect(rendered).toContain("扩大覆盖");
    expect(rendered).toContain("定期更新");
  });

  it("keeps obligation order, citations and verifier support kind", () => {
    const action: FinalAction = {
      action: "final",
      requirements: [
        { id: "R1", coverage: "complete", answer: "第一项 [2]。", citations: [2] },
        { id: "R2", coverage: "complete", answer: "第二项 [1]。", citations: [1] },
      ],
      citations: [2, 1],
    };
    const structured = buildStructuredAnswer(action, {
      bindings: [
        {
          globalRequirementId: "R1",
          deliverableId: "D1",
          obligationId: "O1",
          domain: "coremail-professional",
        },
        {
          globalRequirementId: "R2",
          deliverableId: "D2",
          obligationId: "O2",
          domain: "presales-general",
        },
      ],
      verification: {
        coveredRequirementIds: ["R1", "R2"],
        missingRequirementIds: [],
        summaries: [
          {
            id: "R1",
            reason: "direct_support",
            retainedDirectSegmentCount: 1,
            retainedSynthesizedSegmentCount: 0,
            removedSegmentCount: 0,
            coveredAspectIds: ["A1"],
            missingAspectIds: [],
            claimDecisions: [{
              claimIndex: 0,
              status: "retained_direct",
              citations: [2],
              coveredAspectIds: ["A1"],
            }],
          },
          {
            id: "R2",
            reason: "synthesized_support",
            retainedDirectSegmentCount: 0,
            retainedSynthesizedSegmentCount: 1,
            removedSegmentCount: 0,
            coveredAspectIds: ["A1"],
            missingAspectIds: [],
            claimDecisions: [{
              claimIndex: 0,
              status: "retained_synthesized",
              citations: [1],
              coveredAspectIds: ["A1"],
            }],
          },
        ],
      },
    });

    expect(structured.sections.map((section) => section.obligationId)).toEqual(["O1", "O2"]);
    expect(structured.sections[0]?.segments[0]).toMatchObject({
      citations: [2],
      supportKind: "direct",
      domain: "coremail-professional",
    });
    expect(structured.sections[1]?.segments[0]).toMatchObject({
      citations: [1],
      supportKind: "synthesized",
      domain: "presales-general",
    });
    expect(renderStructuredAnswer(structured)).toContain("第一项 [2]。\n- 第二项 [1]。");
  });

  it("aggregates coverage from required obligations only", () => {
    const structured = buildStructuredAnswer({
      action: "final",
      requirements: [
        { id: "R1", coverage: "complete", answer: "已覆盖 [1]。", citations: [1] },
        { id: "R2", coverage: "none", answer: "未覆盖。", citations: [] },
        { id: "R3", coverage: "none", answer: "可选项未覆盖。", citations: [] },
      ],
      citations: [1],
    }, {
      bindings: [
        {
          globalRequirementId: "R1",
          deliverableId: "D1",
          obligationId: "O1",
          domain: "coremail-professional",
        },
        {
          globalRequirementId: "R2",
          deliverableId: "D1",
          obligationId: "O2",
          domain: "coremail-professional",
        },
        {
          globalRequirementId: "R3",
          deliverableId: "D2",
          obligationId: "O3",
          domain: "presales-general",
          required: false,
        },
      ],
    });

    expect(structured.coverage).toBe("partial");
  });
});
