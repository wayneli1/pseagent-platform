import { describe, expect, it } from "vitest";
import { identityResolvedQuestion } from "./question-resolver.js";
import {
  compileDeterministicTaskSpecFallback,
  taskSpecSchema,
} from "./task-spec.js";
import {
  compileAtomicObligationContract,
  compileGovernedAtomicObligationContract,
  materializeGuardedTaskSpec,
  validateAtomicObligationContract,
  type AtomicObligationContract,
} from "./atomic-obligation.js";

describe("atomic obligation contract", () => {
  it.each([
    "客户把 Coremail 与彩讯放在同一场演示中时，哪些 Coremail 展示点已有证据，哪些竞品结论必须留作客户确认？",
    "从 Coremail 云服务迁回自建环境时，资产盘点、全量同步、增量追赶、切换和回退应如何分阶段验收？",
    "POC 现场临时要求验证未采购模块时，如何记录范围外项、变更审批和后续验证条件？",
    "客户已有第三方邮件网关时，评估 CAC 和反病毒采购应怎样区分现有覆盖、缺口与授权边界？",
  ])("keeps a professional-only reliability question in one knowledge domain: %s", (question) => {
    const resolvedQuestion = identityResolvedQuestion(question);
    const taskSpec = compileDeterministicTaskSpecFallback({
      resolvedQuestion,
      scopeHint: "professional",
      knowledgeContext: { purpose: "", schema: "", planningOverview: "" },
    });
    const contract = compileAtomicObligationContract({ resolvedQuestion, taskSpec });

    expect(new Set(contract.obligations.flatMap((item) => item.domains))).toEqual(
      new Set(["coremail-professional"]),
    );
  });

  it.each([
    "5000 用户多活架构评估中，怎样用价值工程把服务器角色、容量假设、投入和业务连续性收益对应起来？",
    "重复发信故障引发客户指责时，怎样一边核对 Message-ID 和投递日志，一边用 NVC 提出共同取证请求？",
    "POC 临时增加未采购功能时，怎样用有条件让步明确测试范围、额外投入、审批和交换条件？",
    "非多活信创系统的恢复方案怎样用三个 Why 说明为什么要建设恢复能力、为什么现在演练以及为什么采用当前路径？",
    "已有第三方网关的客户质疑 CAC 价格时，怎样把现有覆盖和授权缺口转成价值讨论而不是只做折扣？",
  ])("preserves both domains for an explicit cross-domain method: %s", (question) => {
    const resolvedQuestion = identityResolvedQuestion(question);
    const taskSpec = compileDeterministicTaskSpecFallback({
      resolvedQuestion,
      scopeHint: "professional",
      knowledgeContext: { purpose: "", schema: "", planningOverview: "" },
    });
    const contract = compileAtomicObligationContract({ resolvedQuestion, taskSpec });

    expect(new Set(contract.obligations.flatMap((item) => item.domains))).toEqual(
      new Set(["coremail-professional", "presales-general"]),
    );
  });

  it("keeps the explicit action and state-transition evidence in a contextual follow-up", () => {
    const question = "刚才把预算标成黄灯，现在给出一个减速核验动作和转绿或转红的证据。";
    const resolvedQuestion = identityResolvedQuestion(question);
    const taskSpec = compileDeterministicTaskSpecFallback({
      resolvedQuestion,
      scopeHint: "general",
      knowledgeContext: { purpose: "", schema: "", planningOverview: "" },
    });

    const contract = compileAtomicObligationContract({ resolvedQuestion, taskSpec });
    const source = contract.obligations.map((item) => item.sourceText).join(" ");

    expect(contract.obligations).toHaveLength(2);
    expect(source).toContain("减速核验动作");
    expect(source).toContain("转绿或转红的证据");
  });

  it("does not let a boundary fragment replace an authoritative parallel item", () => {
    const question =
      "Exchange 与 Coremail 双轨并行时，邮件路由已经验证；当前追问：双轨图里跨系统日程不可用，只说明这项限制、用户替代动作和回退时如何通知。";
    const resolvedQuestion = identityResolvedQuestion(question);
    const taskSpec = compileDeterministicTaskSpecFallback({
      resolvedQuestion,
      scopeHint: "professional",
      knowledgeContext: { purpose: "", schema: "", planningOverview: "" },
    });

    const contract = compileAtomicObligationContract({ resolvedQuestion, taskSpec });

    expect(contract.obligations.map((item) => item.sourceText)).toEqual([
      "当前追问：双轨图里跨系统日程不可用",
      "用户替代动作",
      "回退时如何通知",
    ]);
  });

  it("treats RFP evidence admission as a synthesis judgement in the general domain", () => {
    const question = "用 XT v6 审计材料回应 RFP 时，怎样同时限定报告版本与范围，并判断该证据是否足以支持参与？";
    const resolvedQuestion = identityResolvedQuestion(question);
    const taskSpec = compileDeterministicTaskSpecFallback({
      resolvedQuestion,
      scopeHint: "professional",
      knowledgeContext: { purpose: "", schema: "", planningOverview: "" },
    });

    const contract = compileAtomicObligationContract({ resolvedQuestion, taskSpec });
    const judgement = contract.obligations.find((item) =>
      item.sourceText.includes("是否足以支持参与"));

    expect(judgement).toMatchObject({
      kind: "risk_assessment",
      evidencePolicy: "synthesis",
      domains: ["presales-general"],
    });
  });

  it("preserves every governed card obligation when one source question has multiple policies", () => {
    const question = "没买的功能可以先放到POC里测吗？";
    const taskSpec = taskSpecSchema.parse({
      subject: question,
      entities: [{ id: "E1", label: question, role: "subject", sourceText: question }],
      deliverables: [{
        id: "D1",
        label: "受治理答案",
        kind: "recommendation",
        required: true,
        sourceText: question,
        obligations: [{
          id: "O1",
          label: "默认不纳入未购买功能",
          targetEntityIds: ["E1"],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: question,
        }, {
          id: "O2",
          label: "结合合同和客户现状人工确认",
          targetEntityIds: ["E1"],
          evidencePolicy: "customer_input",
          domains: ["presales-general"],
          required: true,
          sourceText: question,
        }],
      }],
    });

    const contract = compileGovernedAtomicObligationContract({
      resolvedQuestion: identityResolvedQuestion(question),
      taskSpec,
    });

    expect(contract.obligations).toHaveLength(2);
    expect(contract.obligations.map((item) => ({
      id: item.id,
      evidencePolicy: item.evidencePolicy,
      domains: item.domains,
      provenance: item.provenance,
    }))).toEqual([{
      id: "O1",
      evidencePolicy: "direct",
      domains: ["coremail-professional"],
      provenance: "governed",
    }, {
      id: "O2",
      evidencePolicy: "customer_input",
      domains: ["presales-general"],
      provenance: "governed",
    }]);
    expect(contract.obligations.every((item) =>
      question.slice(item.sourceSpan.start, item.sourceSpan.end) === item.sourceText
    )).toBe(true);
    expect(validateAtomicObligationContract(contract).ok).toBe(true);
  });

  it("restores a source-backed case judgement omitted by the model task spec", () => {
    const question = "说明如何评估当前商机，并判断这个项目现在是否值得推进。";
    const taskSpec = taskSpecSchema.parse({
      subject: "当前商机评估",
      entities: [{
        id: "E1",
        label: "当前商机",
        role: "subject",
        sourceText: "当前商机",
      }],
      deliverables: [{
        id: "D1",
        label: "评估当前商机的方法",
        kind: "procedure",
        required: true,
        sourceText: "说明如何评估当前商机",
        obligations: [{
          id: "O1",
          label: "评估当前商机的方法",
          targetEntityIds: ["E1"],
          evidencePolicy: "synthesis",
          domains: ["presales-general"],
          required: true,
          sourceText: "说明如何评估当前商机",
        }],
      }],
    });

    const contract = compileAtomicObligationContract({
      resolvedQuestion: identityResolvedQuestion(question),
      taskSpec,
    });

    expect(contract.obligations.map((item) => item.kind)).toEqual([
      "procedure",
      "case_judgement",
    ]);
    expect(contract.obligations.map((item) => item.evidencePolicy)).toEqual([
      "synthesis",
      "customer_input",
    ]);
    expect(contract.obligations.every((item) =>
      question.slice(item.sourceSpan.start, item.sourceSpan.end) === item.sourceText
    )).toBe(true);
    expect(validateAtomicObligationContract(contract)).toEqual({
      ok: true,
      issueCodes: [],
    });
  });

  it("classifies independent technical and governance obligations into different domains", () => {
    const question = "请说明 Coremail 归档能力，并给出 POC 验收流程。";
    const taskSpec = taskSpecSchema.parse({
      subject: "Coremail 归档 POC",
      entities: [{
        id: "E1",
        label: "Coremail",
        role: "product",
        sourceText: "Coremail",
      }],
      deliverables: [{
        id: "D1",
        label: "Coremail 归档能力",
        kind: "fact",
        required: true,
        sourceText: "请说明 Coremail 归档能力",
        obligations: [{
          id: "O1",
          label: "Coremail 归档能力",
          targetEntityIds: ["E1"],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: "请说明 Coremail 归档能力",
        }],
      }],
    });

    const contract = compileAtomicObligationContract({
      resolvedQuestion: identityResolvedQuestion(question),
      taskSpec,
    });

    expect(contract.obligations.map((item) => item.domains)).toEqual([
      ["coremail-professional"],
      ["presales-general"],
    ]);
    expect(contract.obligations.map((item) => item.evidenceTypes)).toEqual([
      ["formal_page"],
      ["method"],
    ]);
  });

  it("upgrades protected technical boundary explanations to direct evidence", () => {
    const question = "排查应怎样串联 Coremail 首次连接？";
    const taskSpec = taskSpecSchema.parse({
      subject: "共用存储边界",
      entities: [{
        id: "E1",
        label: "Coremail 首次连接",
        role: "subject",
        sourceText: "Coremail 首次连接",
      }],
      deliverables: [{
        id: "D1",
        label: "排查投递延迟",
        kind: "procedure",
        required: true,
        sourceText: question,
        obligations: [{
          id: "O1",
          label: "排查投递延迟",
          targetEntityIds: ["E1"],
          evidencePolicy: "synthesis",
          domains: ["coremail-professional"],
          required: true,
          sourceText: question,
        }],
      }],
    });

    const contract = compileAtomicObligationContract({
      resolvedQuestion: identityResolvedQuestion(question),
      taskSpec,
    });

    expect(contract.obligations).toHaveLength(1);
    expect(contract.obligations[0]).toMatchObject({
      evidencePolicy: "direct",
      evidenceTypes: ["formal_page"],
      domains: ["coremail-professional"],
    });
  });

  it("adds a non-overlapping explicit request omitted by semantic atomization", () => {
    const question = "资源尚未定型时，售前原型怎样展示部署角色又明确规格不是交付承诺？";
    const taskSpec = taskSpecSchema.parse({
      subject: question,
      entities: [{ id: "E1", label: question, role: "subject", sourceText: question }],
      deliverables: [{
        id: "D1",
        label: question,
        kind: "recommendation",
        required: true,
        sourceText: question,
        obligations: [{
          id: "O1",
          label: question,
          targetEntityIds: ["E1"],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: question,
        }],
      }],
    });

    const contract = compileAtomicObligationContract({
      resolvedQuestion: identityResolvedQuestion(question),
      taskSpec,
    });

    expect(contract.obligations.map((item) => item.sourceText)).toContain(
      "售前原型怎样展示部署角色又明确规格不是交付承诺",
    );
    expect(validateAtomicObligationContract(contract).ok).toBe(true);
  });

  it("preserves the recovered question-level domain contract during atomization", () => {
    const cases = [
      {
        question: "集团分批切换计划如何用四 B 向高层说明背景、组织障碍、批次收益和购买决策？",
        expected: ["coremail-professional", "presales-general"],
      },
      {
        question: "设计旧邮箱只读入口前，怎样用 Mom Test 追问用户过去查阅历史邮件的真实频率和场景？",
        expected: ["coremail-professional", "presales-general"],
      },
      {
        question: "切换后总量一致但抽样正文不同，沿前面的验收框架说明如何暂停和复核。",
        expected: ["coremail-professional"],
      },
    ] as const;

    for (const { question, expected } of cases) {
      const resolvedQuestion = identityResolvedQuestion(question);
      const taskSpec = compileDeterministicTaskSpecFallback({
        resolvedQuestion,
        scopeHint: "professional",
        knowledgeContext: { purpose: "", schema: "", planningOverview: "" },
      });
      const contract = compileAtomicObligationContract({ resolvedQuestion, taskSpec });
      expect(new Set(contract.obligations.flatMap((item) => item.domains)))
        .toEqual(new Set(expected));
    }
  });

  it("restores both mixed domains even when the model task spec omitted one domain", () => {
    const question = "个人配置不能全部随邮件迁移时，怎样在售前向交付结构化移交可迁项、用户动作、风险和责任人？";
    const resolvedQuestion = identityResolvedQuestion(question);
    const deterministic = compileDeterministicTaskSpecFallback({
      resolvedQuestion,
      scopeHint: "professional",
      knowledgeContext: { purpose: "", schema: "", planningOverview: "" },
    });
    const professionalOnly = taskSpecSchema.parse({
      ...deterministic,
      deliverables: deterministic.deliverables.map((deliverable) => ({
        ...deliverable,
        obligations: deliverable.obligations.map((obligation) => ({
          ...obligation,
          domains: ["coremail-professional"],
        })),
      })),
    });

    const contract = compileAtomicObligationContract({
      resolvedQuestion,
      taskSpec: professionalOnly,
    });

    expect(new Set(contract.obligations.flatMap((item) => item.domains))).toEqual(
      new Set(["coremail-professional", "presales-general"]),
    );
    expect(contract.obligations.reduce((sum, item) => sum + item.domains.length, 0))
      .toBeLessThanOrEqual(contract.obligations.length + 1);
    expect(contract.obligations).toEqual([
      expect.objectContaining({
        risk: "low",
        completionCriteria: ["claim_supported", "all_required_aspects_covered"],
      }),
    ]);
  });

  it.each([
    "合同违约责任应如何划分？",
    "请确认数据泄露的法律责任归属。",
    "项目失败后由谁承担赔偿责任？",
  ])("keeps contractual or legal responsibility questions high-risk: %s", (question) => {
    const resolvedQuestion = identityResolvedQuestion(question);
    const taskSpec = compileDeterministicTaskSpecFallback({
      resolvedQuestion,
      scopeHint: "general",
      knowledgeContext: { purpose: "", schema: "", planningOverview: "" },
    });

    const contract = compileAtomicObligationContract({ resolvedQuestion, taskSpec });

    expect(contract.obligations.some((item) => item.risk === "high")).toBe(true);
  });

  it("keeps one shared phased-acceptance request instead of splitting its stage dimensions", () => {
    const question = "从 Coremail 云服务迁回自建环境时，资产盘点、全量同步、增量追赶、切换和回退应如何分阶段验收？";
    const resolvedQuestion = identityResolvedQuestion(question);
    const taskSpec = compileDeterministicTaskSpecFallback({
      resolvedQuestion,
      scopeHint: "professional",
      knowledgeContext: { purpose: "", schema: "", planningOverview: "" },
    });

    const contract = compileAtomicObligationContract({ resolvedQuestion, taskSpec });

    expect(contract.obligations).toHaveLength(1);
    expect(contract.obligations[0]).toMatchObject({
      sourceText: "资产盘点、全量同步、增量追赶、切换和回退应如何分阶段验收",
      kind: "procedure",
      evidencePolicy: "synthesis",
    });
    expect(new Set(contract.obligations.flatMap((item) => item.domains))).toEqual(
      new Set(["coremail-professional"]),
    );
    expect(contract.obligations.reduce((sum, item) => sum + item.domains.length, 0))
      .toBe(1);
  });

  it.each([
    [
      "大客户项目只覆盖一个联系人时，怎样按业务、技术、采购和高层关系分层制定补位动作？",
      "怎样按业务、技术、采购和高层关系分层制定补位动作",
    ],
    [
      "客户把讨论压到单价时，售前如何把对话转回业务影响、选择标准和可验证价值，而不是回避价格？",
      "售前如何把对话转回业务影响、选择标准和可验证价值",
    ],
    [
      "制作价值主张画布时，怎样把客户任务、痛点和收益与方案能力逐项对应并标记待验证假设？",
      "怎样把客户任务、痛点和收益与方案能力逐项对应并标记待验证假设",
    ],
  ] as const)(
    "coalesces shared-action dimensions without creating premise or constraint obligations: %s",
    (question, sourceText) => {
      const resolvedQuestion = identityResolvedQuestion(question);
      const taskSpec = compileDeterministicTaskSpecFallback({
        resolvedQuestion,
        scopeHint: "general",
        knowledgeContext: { purpose: "", schema: "", planningOverview: "" },
      });

      const contract = compileAtomicObligationContract({ resolvedQuestion, taskSpec });

      expect(contract.obligations).toHaveLength(1);
      expect(contract.obligations[0]).toMatchObject({
        sourceText,
        kind: "procedure",
        evidencePolicy: "synthesis",
        domains: ["presales-general"],
      });
    },
  );

  it("keeps ordered continuation actions while excluding their scenario premise", () => {
    const question = "渠道与直销同时联系同一客户时，怎样先统一客户窗口，再按证据重新分工并保留升级路径？";
    const resolvedQuestion = identityResolvedQuestion(question);
    const taskSpec = compileDeterministicTaskSpecFallback({
      resolvedQuestion,
      scopeHint: "general",
      knowledgeContext: { purpose: "", schema: "", planningOverview: "" },
    });

    const contract = compileAtomicObligationContract({ resolvedQuestion, taskSpec });

    expect(contract.obligations.map((item) => item.sourceText)).toEqual([
      "怎样先统一客户窗口",
      "再按证据重新分工",
      "保留升级路径",
    ]);
    expect(contract.obligations.every((item) =>
      item.kind === "procedure" && item.evidencePolicy === "synthesis"
    )).toBe(true);
  });

  it("keeps semantic request atoms when no explicit request clause was extracted", () => {
    const question = "没有 AIR 客户端版本和网络策略，请确认所有 AI 写信功能都能永久离线使用。";
    const resolvedQuestion = identityResolvedQuestion(question);
    const taskSpec = compileDeterministicTaskSpecFallback({
      resolvedQuestion,
      scopeHint: "professional",
      knowledgeContext: { purpose: "", schema: "", planningOverview: "" },
    });

    const contract = compileAtomicObligationContract({ resolvedQuestion, taskSpec });

    expect(contract.obligations.map((item) => item.sourceText)).toEqual([
      "请确认所有 AI 写信功能都能永久离线使用",
    ]);
  });

  it("reports overlapping and untraceable source spans", () => {
    const contract: AtomicObligationContract = {
      subject: "测试",
      sourceQuestion: "先核验版本，再说明流程。",
      obligations: [
        obligation({ id: "O1", start: 0, end: 5, sourceText: "先核验版本" }),
        obligation({ id: "O2", start: 4, end: 10, sourceText: "错误原文" }),
      ],
    };

    const validation = validateAtomicObligationContract(contract);

    expect(validation.ok).toBe(false);
    expect(validation.issueCodes).toContain("obligation_source_span_overlap");
    expect(validation.issueCodes).toContain("obligation_source_text_mismatch");
  });

  it("materializes one required deliverable per atomic obligation", () => {
    const question = "请说明 Coremail 归档能力，并给出 POC 验收流程。";
    const original = taskSpecSchema.parse({
      subject: "Coremail 归档 POC",
      entities: [{
        id: "E1",
        label: "Coremail",
        role: "product",
        sourceText: "Coremail",
      }],
      deliverables: [{
        id: "D1",
        label: question,
        kind: "fact",
        required: true,
        sourceText: question,
        obligations: [{
          id: "O1",
          label: question,
          targetEntityIds: ["E1"],
          evidencePolicy: "direct",
          domains: ["coremail-professional"],
          required: true,
          sourceText: question,
        }],
      }],
    });
    const contract = compileAtomicObligationContract({
      resolvedQuestion: identityResolvedQuestion(question),
      taskSpec: original,
    });

    const guarded = materializeGuardedTaskSpec({ original, contract });

    expect(guarded.deliverables).toHaveLength(2);
    expect(guarded.deliverables.map((item) => item.id)).toEqual(["D1", "D2"]);
    expect(guarded.deliverables.flatMap((item) => item.obligations)
      .map((item) => item.id)).toEqual(["O1", "O2"]);
    expect(guarded.deliverables.flatMap((item) => item.obligations)
      .map((item) => item.sourceText)).toEqual(contract.obligations
        .map((item) => item.sourceText));
  });
});

function obligation(input: {
  readonly id: `O${number}`;
  readonly start: number;
  readonly end: number;
  readonly sourceText: string;
}): AtomicObligationContract["obligations"][number] {
  return {
    id: input.id,
    sourceSpan: { start: input.start, end: input.end },
    sourceText: input.sourceText,
    kind: "fact",
    targetEntityIds: [],
    domains: ["coremail-professional"],
    evidencePolicy: "direct",
    evidenceTypes: ["formal_page"],
    risk: "low",
    completionCriteria: ["claim_supported", "all_required_aspects_covered"],
    required: true,
  };
}
