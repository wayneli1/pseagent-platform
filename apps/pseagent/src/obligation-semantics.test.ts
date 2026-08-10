import { describe, expect, it } from "vitest";
import {
  analyzeObligationSource,
  createObligationSourceAnalyzer,
  obligationRetrievalVariants,
  type SourceSpan,
} from "./obligation-semantics.js";

describe("obligationRetrievalVariants", () => {
  it.each([
    "Coremail邮件迁移项目通常要考虑哪些产品能力？",
    "替换现有企业邮箱时，邮件迁移范围和评估要点有哪些？",
  ])("expands migration obligations to a source-shaped query: %s", (question) => {
    expect(obligationRetrievalVariants(question)).toContain(
      "第三方邮件系统 迁移方式 对比",
    );
  });

  it("does not add migration vocabulary to an unrelated obligation", () => {
    for (const question of [
      "如何组织一次通用售前访谈？",
      "如何替换邮件安全网关证书？",
    ]) {
      expect(obligationRetrievalVariants(question))
        .not.toContain("第三方邮件系统 迁移方式 对比");
    }
  });
});

function assertPartition(
  sourceText: string,
  span: SourceSpan,
  nodes: readonly { readonly text: string; readonly start: number; readonly end: number }[],
) {
  let cursor = span.start;
  for (const node of nodes) {
    expect(node.start).toBe(cursor);
    expect(node.end).toBeGreaterThan(node.start);
    expect(node.text).toBe(sourceText.slice(node.start, node.end));
    cursor = node.end;
  }
  expect(cursor).toBe(span.end);
}

function expectSourceIntegrity(sourceText: string) {
  const analysis = analyzeObligationSource(sourceText);
  let cursor = 0;
  for (const atom of analysis.atoms) {
    expect(atom.start).toBeGreaterThanOrEqual(cursor);
    expect(atom.end).toBeGreaterThan(atom.start);
    expect(atom.text).toBe(sourceText.slice(atom.start, atom.end));
    cursor = atom.end;
  }
  return analysis;
}

function expectStrictSourceIntegrity(sourceText: string) {
  const analysis = expectSourceIntegrity(sourceText);
  assertPartition(sourceText, analysis.sourceSpan, analysis.tokens);
  assertPartition(sourceText, analysis.sourceSpan, analysis.segments);
  assertPartition(sourceText, analysis.sourceSpan, analysis.constituents);
  for (const constituent of analysis.constituents) {
    assertPartition(sourceText, constituent, constituent.children);
    for (const occurrence of constituent.occurrences) {
      expect(occurrence.start).toBeGreaterThanOrEqual(constituent.start);
      expect(occurrence.end).toBeLessThanOrEqual(constituent.end);
      expect(occurrence.text).toBe(sourceText.slice(occurrence.start, occurrence.end));
    }
  }
  return analysis;
}

const FACTS = [
  "产品型号",
  "部署架构",
  "数据保留周期",
  "产品序列号",
  "当前版本",
  "补丁状态",
  "授权模式",
  "认证状态",
  "协议兼容性",
  "容量上限",
  "产品报价",
  "系统功能",
  "平台能力",
  "所有可升级版本",
  "当前设备型号",
  "未知技术支持",
] as const;

const SYNTHESIS = [
  "优化建议",
  "版本升级计划",
  "授权调整路线图",
  "认证改造工作计划",
  "协议适配实施路径",
  "容量扩容策略",
  "部署优化方案",
  "团队能力提升建议",
  "问题诊断方法",
  "下一步行动",
] as const;

const CONNECTORS = [
  "，",
  "；",
  "并且",
  "同时",
  "然后",
  "随后",
  "继而",
  "还有",
  "以及",
  "和",
  "及",
  "与",
  "跟",
  "并",
] as const;

describe("analyzeObligationSource", () => {
  it.each([
    "，",
    ",",
    "；",
    ";",
    "。",
    "、",
    "：",
    ":",
    "\n",
    "\r\n",
  ])("keeps every hard boundary as a lossless fact/synthesis partition: %j", (boundary) => {
    const sourceText = `玄枢状态${boundary}韧性优化建议`;
    const analysis = expectStrictSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
    expect(analysis.boundaries.some((candidate) => candidate.text.includes(boundary))).toBe(true);
  });

  it.each([
    "（“版本升级计划”）",
    "“（容量扩容策略）”",
  ])("recursively accepts balanced nested synthesis: %s", (sourceText) => {
    const analysis = expectStrictSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(false);
    expect(analysis.unresolved).toBe(false);
  });

  it.each([
    "（“玄枢状态、韧性优化建议”）",
    "“（玄枢状态与韧性优化建议）”",
    "（“版本升级计划”",
    "“（容量扩容策略”）",
  ])("fails closed for nested mixed or damaged delimiters: %s", (sourceText) => {
    const analysis = expectStrictSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
  });

  it.each([
    "如何优化销售能力（并确认当前版本）",
    "如何优化销售能力（同时说明部署架构）",
    "如何提升团队能力（另需核实产品报价）",
    "如何优化推进方式（还要列出接口清单）",
    "如何优化销售能力（查询当前版本）",
    "如何优化销售能力(查询当前版本)",
    "如何优化销售能力“查询当前版本”",
    "如何优化销售能力（“查询当前版本”）",
    "如何优化销售能力（系统支持IPv6）",
    "如何优化部署（支持10万用户）",
    "双活部署优化方案（异地容灾）",
    "团队能力提升建议（售前场景）",
    "如何优化销售能力（查询版本）",
    "如何提升团队能力（探知部署架构）",
    "如何改造流程（丈量产品报价）",
    "确认当前版本（并给出升级建议）",
    "升级建议（并确认当前版本）",
  ])("propagates an embedded delimited fact child to the parent result: %s", (sourceText) => {
    const analysis = expectStrictSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
    expect(analysis.atoms.some((atom) =>
      atom.kind === "protected_fact" || atom.kind === "unresolved",
    )).toBe(true);
  });

  it.each([
    "如何提升销售能力（并给出推进建议）",
    "分析成败因素“并给出推进建议”",
    "（优化建议）与（推进策略）",
    "Coremail（邮件系统）升级建议",
    "华为（鲲鹏架构）部署优化方案",
    "如何优化（跨域）部署能力",
    "当前方案（一期）的风险评估",
  ])("keeps embedded delimited synthesis children eligible: %s", (sourceText) => {
    const analysis = expectStrictSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(false);
    expect(analysis.atoms.every((atom) => atom.kind === "synthesis")).toBe(true);
  });

  it.each([
    "分析“成败因素”",
    "评估“现有方案的可行性”",
    "诊断“系统瓶颈”",
    "如何分析（客户需求）",
    "给出“优化建议”",
    "提出（优化方案）",
    "制定“迁移计划”",
    "形成（改进措施）",
    "输出“实施路径”",
    "分析：成败因素",
    "评估：现有方案的可行性",
    "诊断：系统瓶颈",
    "给出：优化建议",
    "提出：优化方案",
    "制定：迁移计划",
    "输出：实施路径",
    "给出\n优化建议",
    "分析\n成败因素",
  ])("composes an incomplete governor with a compatible object across a container or hard boundary: %s", (sourceText) => {
    const analysis = expectStrictSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(false);
    expect(analysis.atoms.every((atom) => atom.kind === "synthesis")).toBe(true);
  });

  it.each([
    "分析“当前版本”",
    "提出“当前版本”",
    "分析：当前版本",
    "给出：当前版本",
  ])("does not let a composed governor suppress a protected state object: %s", (sourceText) => {
    expect(expectStrictSourceIntegrity(sourceText).requiresDirectEvidence).toBe(true);
  });

  it.each([
    "给出：所有升级建议",
    "给出：“当前升级建议”",
    "分析：所有成败因素",
    "如何确认：当前版本",
  ])("keeps governor-object composition consistent when a modifier belongs to a synthesis object: %s", (sourceText) => {
    expect(expectStrictSourceIntegrity(sourceText).requiresDirectEvidence).toBe(false);
  });

  it.each([
    "分析：所有版本",
    "给出：当前版本",
    "分析：“当前版本与风险”",
    "分析：“当前版本和成败因素”",
    "分析：“当前版本、风险”",
    "分析：“当前版本\n风险”",
    "分析：“所有版本的风险”",
  ])("keeps the same modifier direct when its governed object is factual: %s", (sourceText) => {
    expect(expectStrictSourceIntegrity(sourceText).requiresDirectEvidence).toBe(true);
  });

  it("keeps one complete abstract diagnostic object composable", () => {
    expect(
      expectStrictSourceIntegrity("分析：“现有方案的可行性”").requiresDirectEvidence,
    ).toBe(false);
  });

  it.each([
    "分析：成败因素；诊断：系统瓶颈",
    "给出：优化建议；制定：迁移计划",
  ])("composes every governor-object pair in a hard-boundary sequence: %s", (sourceText) => {
    const analysis = expectStrictSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(false);
    expect(analysis.atoms).toHaveLength(2);
    expect(analysis.atoms.every((atom) => atom.kind === "synthesis")).toBe(true);
  });

  it("composes every organizational relationship pair in a hard-boundary sequence", () => {
    const analysis = expectStrictSourceIntegrity("识别：支持团队；争取：管理层支持");
    expect(analysis.requiresDirectEvidence).toBe(false);
    expect(analysis.atoms).toHaveLength(2);
    expect(analysis.atoms.every((atom) => atom.kind === "relationship_support")).toBe(true);
  });

  it.each([
    "分析：成败因素；给出：当前版本",
    "识别：支持团队；系统：支持IPv6",
  ])("keeps a later incompatible hard-boundary pair direct: %s", (sourceText) => {
    expect(expectStrictSourceIntegrity(sourceText).requiresDirectEvidence).toBe(true);
  });

  it("keeps repeated hard-boundary composition linear", () => {
    const sourceText = Array.from({ length: 100 }, () => "分析：成败因素").join("；");
    const analysis = analyzeObligationSource(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(false);
    expect(analysis.atoms).toHaveLength(100);
    expect(analysis.diagnostics.rangeEvaluations).toBeLessThanOrEqual(250);
  });

  it.each([
    "识别（支持团队）",
    "联系“客户支持者”",
    "争取（管理层支持）",
    "协调（支持团队）推进项目",
    "争取 管理层支持",
    "争取（客户管理层支持）",
  ])("composes a complete organizational relationship across delimiters or whitespace: %s", (sourceText) => {
    const analysis = expectStrictSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(false);
    expect(analysis.atoms.every((atom) => atom.kind === "relationship_support")).toBe(true);
  });

  it.each([
    "系统（支持IPv6）",
    "支持团队（支持S/MIME）",
    "争取（系统支持IPv6）",
    "识别（支持团队支持IPv6）",
  ])("keeps technical support direct across the same delimiter structure: %s", (sourceText) => {
    expect(expectStrictSourceIntegrity(sourceText).requiresDirectEvidence).toBe(true);
  });

  it("fails closed when word-boundary candidates are unavailable", () => {
    const analyze = createObligationSourceAnalyzer(() => undefined);
    const analysis = analyze("系统功能和优化建议");
    expect(analysis.requiresDirectEvidence).toBe(true);
    expect(analysis.unresolved).toBe(true);
    assertPartition("系统功能和优化建议", analysis.sourceSpan, analysis.segments);
  });

  it("fails closed when a candidate provider returns no usable words", () => {
    for (const analyze of [
      createObligationSourceAnalyzer(() => []),
      createObligationSourceAnalyzer(() => [{
        text: "错误切片",
        start: 99,
        end: 103,
      }]),
    ]) {
      const analysis = analyze("版本升级计划");
      expect(analysis.requiresDirectEvidence).toBe(true);
      expect(analysis.unresolved).toBe(true);
    }
  });

  it("fails closed for partial, mixed-invalid, or overlapping word candidates", () => {
    const sourceText = "如何优化销售能力和系统功能";
    const partial = { text: "如何", start: 0, end: 2 };
    for (const provider of [
      () => [partial],
      () => [partial, { text: "越界", start: 99, end: 101 }],
      () => [
        { text: "版本升级计划", start: 0, end: 6 },
        { text: "版本", start: 0, end: 2 },
      ],
    ]) {
      const value = provider().some((candidate) => candidate.text === "版本升级计划")
        ? "版本升级计划"
        : sourceText;
      const analysis = createObligationSourceAnalyzer(provider)(value);
      expect(analysis.requiresDirectEvidence).toBe(true);
      expect(analysis.unresolved).toBe(true);
    }
  });

  it("fails closed when a coarse candidate hides a possible weak boundary", () => {
    const analyze = createObligationSourceAnalyzer((sourceText) => [{
      text: sourceText,
      start: 0,
      end: sourceText.length,
    }]);
    const analysis = analyze("系统功能和优化建议");
    expect(analysis.requiresDirectEvidence).toBe(true);
    expect(analysis.unresolved).toBe(true);
  });

  it("treats per-character candidates only as proposals and still validates constituents", () => {
    const analyze = createObligationSourceAnalyzer((sourceText) =>
      Array.from({ length: sourceText.length }, (_, index) => ({
        text: sourceText[index]!,
        start: index,
        end: index + 1,
    })));
    expect(analyze("系统功能和优化建议").requiresDirectEvidence).toBe(true);
    expect(analyze("跨域并网改造计划").requiresDirectEvidence).toBe(true);
  });

  it("keeps generated unknown stems order-invariant without adding vocabulary exceptions", () => {
    const stems = ["玄枢", "星瀚", "云岫", "霁川", "砺衡"];
    const themes = ["韧性", "协同", "演进", "治理"];
    for (const stem of stems) {
      for (const theme of themes) {
        const fact = `${stem}状态`;
        const synthesis = `${theme}优化建议`;
        for (const sourceText of [
          `${fact}与${synthesis}`,
          `${synthesis}与${fact}`,
          `${fact}：${synthesis}`,
          `${synthesis}：${fact}`,
        ]) {
          expect(expectStrictSourceIntegrity(sourceText).requiresDirectEvidence, sourceText).toBe(true);
        }
        expect(expectStrictSourceIntegrity(`${stem}${theme}优化建议`).requiresDirectEvidence).toBe(false);
      }
    }
  });

  it("keeps generated technical support objects local and direct", () => {
    for (const object of ["玄枢协议", "星瀚归档", "霁川认证", "砺衡互联"]) {
      for (const sourceText of [
        `支持${object}`,
        `安全团队支持${object}`,
        `支持团队支持项目推进和系统支持${object}`,
      ]) {
        const analysis = expectStrictSourceIntegrity(sourceText);
        expect(analysis.requiresDirectEvidence, sourceText).toBe(true);
        expect(analysis.atoms.some((atom) =>
          atom.occurrences.some((occurrence) => occurrence.kind === "technical_support"),
        )).toBe(true);
      }
    }
  });

  it("memoizes repeated weak-connector interval analysis", () => {
    for (const length of [20, 50, 100]) {
      const sourceText = Array.from(
        { length },
        (_, index) => `主题${index + 1}优化建议`,
      ).join("和");
      const analysis = analyzeObligationSource(sourceText);
      expect(analysis.requiresDirectEvidence).toBe(false);
      expect(analysis.atoms).toHaveLength(length);
      expect(analysis.diagnostics.rangeEvaluations).toBeLessThanOrEqual(length * 2);
      expect(analysis.diagnostics.cacheHits).toBeGreaterThan(0);
    }
  });

  it("exposes a lossless ordered token-boundary-constituent tree", () => {
    const sourceText = "  “版本升级计划”，并确认当前版本  ";
    const trimmed = sourceText.trim();
    const trimStart = sourceText.indexOf(trimmed);
    const analysis = analyzeObligationSource(sourceText);

    expect(analysis.sourceSpan).toEqual({
      start: trimStart,
      end: trimStart + trimmed.length,
    });
    expect(analysis.segments.map((segment) => segment.text).join("")).toBe(trimmed);
    expect(analysis.tokens.map((token) => token.text).join("")).toBe(trimmed);
    expect(analysis.constituents.length).toBeGreaterThan(0);

    let cursor = trimStart;
    for (const segment of analysis.segments) {
      expect(segment.start).toBe(cursor);
      expect(segment.end).toBeGreaterThan(segment.start);
      expect(segment.text).toBe(sourceText.slice(segment.start, segment.end));
      cursor = segment.end;
    }
    expect(cursor).toBe(trimStart + trimmed.length);
  });

  it.each([
    "确认当前版本后升级计划",
    "核实接口之后适配方案",
    "既要核实当前版本又要给出升级建议",
    "产品版本、优化建议",
    "当前版本：升级建议",
    "系统支持IPv6后升级方案",
    "10万用户容量对应扩容策略",
    "支持10万用户的部署方案",
  ])("fails closed for a protected occurrence outside a synthesis governor: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
    expect(analysis.atoms.some((atom) =>
      atom.kind === "protected_fact" || atom.kind === "unresolved",
    )).toBe(true);
  });

  it.each([
    "评估机会质量",
    "诊断系统瓶颈",
    "分析成败因素",
    "风险识别与应对策略",
    "需求澄清与客户沟通计划",
    "高并发场景优化建议",
    "新旧系统并行迁移路线图",
    "跨域并网改造计划",
    "饱和度优化建议",
    "“版本升级计划”",
    "（容量扩容策略）",
  ])("accepts a fully governed synthesis constituent: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(false);
    expect(analysis.unresolved).toBe(false);
    expect(analysis.atoms.every((atom) =>
      atom.kind === "synthesis" || atom.kind === "relationship_support",
    )).toBe(true);
  });

  it("protects a state-fact complement under an assessment speech act in either order", () => {
    const cases = [
      ["分析当前版本", "给出升级建议"],
      ["评估现有部署架构", "制定优化方案"],
      ["判断当前产品型号", "形成替换方案"],
      ["预测当前容量上限", "制定扩容策略"],
      ["分析当前玄枢状态", "给出韧性建议"],
    ] as const;
    for (const [fact, synthesis] of cases) {
      for (const connector of ["并", "和", "与", "，", "\n"]) {
        for (const sourceText of [
          `${fact}${connector}${synthesis}`,
          `${synthesis}${connector}${fact}`,
          `${fact} ${connector} ${synthesis}`,
        ]) {
          const analysis = expectStrictSourceIntegrity(sourceText);
          expect(analysis.requiresDirectEvidence, sourceText).toBe(true);
        }
      }
    }
  });

  it("protects quantified fact complements without blocking synthesis collections", () => {
    const facts = [
      "分析所有可升级版本",
      "评估全部灾备模式",
      "判断完整审计机制",
    ];
    const synthesis = ["给出升级建议", "制定优化方案", "提出整改建议"];
    for (let index = 0; index < facts.length; index += 1) {
      for (const connector of ["并", "和", "与", "，", "\n"]) {
        for (const sourceText of [
          `${facts[index]}${connector}${synthesis[index]}`,
          `${synthesis[index]}${connector}${facts[index]}`,
        ]) {
          expect(
            expectStrictSourceIntegrity(sourceText).requiresDirectEvidence,
            sourceText,
          ).toBe(true);
        }
      }
    }

    for (const sourceText of ["分析所有升级建议", "完整迁移方案评估"]) {
      expect(expectStrictSourceIntegrity(sourceText).requiresDirectEvidence, sourceText).toBe(false);
    }
  });

  it.each([
    "如果客户暂时无法提供信息，如何提升赢率",
    "在POC阶段，怎样推进项目",
    "当接口暂不可用时，怎么制定迁移计划",
    "若当前方案风险较高，应如何优化推进策略",
    "假如玄枢条件成立；如何提升协同能力",
    "在未知场景期间\n怎么制定推进方案",
    "如果客户暂时无法提供信息, 如何提升赢率",
  ])("treats a grammatical condition or time premise as scope for a later synthesis task: %s", (sourceText) => {
    const analysis = expectStrictSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(false);
    expect(analysis.atoms.some((atom) => atom.reason === "context_premise")).toBe(true);
  });

  it.each([
    "如果客户信息缺失，如何提升赢率，并确认当前产品版本",
    "如果客户信息缺失，当前产品版本是什么",
    "客户信息缺失，如何提升赢率",
    "如果，如何提升赢率",
    "如果客户信息缺失，",
  ])("does not let an incomplete premise or later synthesis task mask an independent fact: %s", (sourceText) => {
    const analysis = expectStrictSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
  });

  it.each([
    "分析成败因素并给出推进建议",
    "当前方案的风险评估",
    "分析当前方案的风险",
    "评估现有方案的可行性",
    "诊断系统瓶颈",
  ])("does not turn a nominal synthesis task into a state fact: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(false);
  });

  it("keeps state-fact assessment deterministic across repetition and call order", () => {
    const direct = "分析当前版本并给出升级建议";
    const synthesis = "分析当前方案的风险";
    const expected = [true, false, true, true, false, true];
    const sourceTexts = [direct, synthesis, direct, direct, synthesis, direct];

    for (let round = 0; round < 10; round += 1) {
      expect(sourceTexts.map((sourceText) =>
        analyzeObligationSource(sourceText).requiresDirectEvidence,
      )).toEqual(expected);
    }
  });

  it("keeps a pure opportunity assessment customer-input eligible but rejects mixtures", () => {
    for (const sourceText of [
      "评估当前商机赢率",
      "判断当前机会赢率",
      "评估 当前 商机 赢率",
      "这个商机的赢率如何",
      "我们的赢率如何",
      "该项目的成交概率怎么样",
      "在这种情况下我们的赢率如何",
      "基于这些信息当前项目的赢率如何",
      "根据上述情况该项目的成交概率怎么样",
    ]) {
      const pure = analyzeObligationSource(sourceText);
      expect(pure.requiresDirectEvidence, sourceText).toBe(true);
      expect(pure.customerInputEligible, sourceText).toBe(true);
    }

    for (const sourceText of [
      "评估当前商机赢率并确认产品版本",
      "评估 当前 商机 赢率 并确认当前版本",
      "这个商机的赢率与产品报价",
      "我们的赢率如何，同时核实报价",
    ]) {
      const mixed = analyzeObligationSource(sourceText);
      expect(mixed.requiresDirectEvidence, sourceText).toBe(true);
      expect(mixed.customerInputEligible, sourceText).toBe(false);
    }
  });

  it.each([
    "要怎样做才能提升赢率",
    "应该如何建立决策链",
    "应当怎么控制 POC 范围",
    "售前应该怎样控制范围又不伤害关系",
  ])("recognizes modal procedure questions as synthesis: %s", (sourceText) => {
    const analysis = analyzeObligationSource(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(false);
    expect(analysis.unresolved).toBe(false);
    expect(analysis.atoms.every((atom) => atom.kind === "synthesis")).toBe(true);
  });

  it.each([
    "识别支持团队并联系管理层",
    "争取管理层支持",
    "如何争取客户支持",
    "协调支持团队推进项目",
    "支持团队支持项目推进和客户推进",
  ])("recognizes only a complete organizational relationship occurrence: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(false);
    expect(analysis.unresolved).toBe(false);
  });

  it.each([
    "支持团队",
    "客户支持者",
    "多少支持者",
    "所有支持团队",
    "当前管理层支持状态",
  ])("keeps bare or quantified supporter facts direct: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
  });

  it.each(["", " ", "\r\n\t"])("fails closed for blank source text", (sourceText) => {
    const analysis = analyzeObligationSource(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
    expect(analysis.unresolved).toBe(true);
  });

  it("keeps fact plus synthesis direct in every connector and order", () => {
    let cases = 0;
    for (const fact of FACTS) {
      for (const synthesis of SYNTHESIS) {
        for (const connector of CONNECTORS) {
          for (const sourceText of [
            `${fact}${connector}${synthesis}`,
            `${synthesis}${connector}${fact}`,
          ]) {
            const analysis = expectSourceIntegrity(sourceText);
            expect(analysis.requiresDirectEvidence, sourceText).toBe(true);
            expect(analysis.atoms.some((atom) =>
              atom.kind === "protected_fact" || atom.kind === "unresolved",
            )).toBe(true);
            cases += 1;
          }
        }
      }
    }
    expect(cases).toBe(FACTS.length * SYNTHESIS.length * CONNECTORS.length * 2);
  }, 10_000);

  it("keeps explicit synthesis collections eligible across connectors", () => {
    let cases = 0;
    for (const left of SYNTHESIS) {
      for (const right of SYNTHESIS) {
        for (const connector of CONNECTORS) {
          const analysis = expectSourceIntegrity(`${left}${connector}${right}`);
          expect(analysis.requiresDirectEvidence, `${left}/${connector}/${right}`).toBe(false);
          expect(analysis.unresolved).toBe(false);
          expect(analysis.atoms.every((atom) => atom.kind === "synthesis")).toBe(true);
          cases += 1;
        }
      }
    }
    expect(cases).toBe(SYNTHESIS.length * SYNTHESIS.length * CONNECTORS.length);
  });

  it.each(FACTS)("protects bare and unknown factual atoms: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
    expect(analysis.atoms).toEqual([expect.objectContaining({
      kind: "protected_fact",
      text: sourceText,
      start: 0,
      end: sourceText.length,
    })]);
  });

  it.each([
    "所有升级建议",
    "完整迁移方案",
    "版本升级计划",
    "授权优化方案",
    "认证改造工作计划",
    "协议适配实施路径",
    "容量扩容策略",
    "并行部署优化建议",
    "团队能力提升建议",
    "销售能力优化策略",
  ])("does not mistake a fact word inside an explicit deliverable for a fact: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(false);
    expect(analysis.unresolved).toBe(false);
    expect(analysis.atoms).toEqual([expect.objectContaining({ kind: "synthesis" })]);
  });

  it.each([
    "所有加密算法",
    "全部灾备模式",
    "完整审计机制",
    "当前产品型号",
    "现有设备型号",
    "实际部署版本",
    "支持升级的版本",
    "所有可升级版本",
    "裸露未知属性",
  ])("fails closed for quantified, state, or unknown facts: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
  });

  it.each([
    "回答效果不理想的原因是什么",
    "检索不稳定的根因",
    "当前方案的风险评估",
    "与目标架构的差距分析",
    "性能瓶颈诊断",
    "如何配置双活",
    "怎样安装客户端",
    "怎么执行迁移",
  ])("recognizes generic diagnosis and procedure deliverables: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(false);
    expect(analysis.unresolved).toBe(false);
    expect(analysis.atoms).toEqual([expect.objectContaining({ kind: "synthesis" })]);
  });

  it.each([
    "如何确认产品版本",
    "如何 核实接口状态",
  ])("keeps an explicit how-to governor over a verification procedure: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(false);
    expect(analysis.atoms.every((atom) => atom.kind === "synthesis")).toBe(true);
  });

  it.each([
    "确认产品版本",
    "核实接口状态",
  ])("protects the same verification wording without a how-to governor: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
  });

  it.each([
    "兼容性如何",
    "当前风险",
    "配置版本是什么",
  ])("does not mistake factual state for a diagnostic or procedure: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
  });

  it.each([
    "如何优化销售能力和确认系统功能",
    "如何提升团队能力与说明当前版本",
    "如何改进推进方式及核实接口状态",
    "如何优化销售能力和系统有哪些功能",
    "如何提升团队能力与当前版本状态",
    "如何优化销售能力和陌生叙事系统功能",
    "如何优化销售能力和查询当前版本",
    "如何提升团队能力与展示部署架构",
    "如何改造售前流程及披露产品报价",
    "客户暂无信息时如何提升赢率与核对当前报价",
    "（如何优化销售能力和查询当前版本）",
    "如何优化销售能力和查询版本",
    "如何提升团队能力与展示架构",
    "如何改造售前流程及披露报价",
    "客户暂无信息时如何提升赢率与核对报价",
  ])("ends a change governor before an independently governed fact clause: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
    expect(analysis.atoms.some((atom) =>
      atom.kind === "protected_fact" || atom.kind === "unresolved",
    )).toBe(true);
  });

  it.each([
    "并发规格",
    "当前并发上限",
    "系统并发能力",
    "提升系统功能并梳理系统功能边界",
  ])("does not let a single 并 compound or parallel clause bypass fact protection: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
  });

  it.each([
    "技术团队支持高可用",
    "支持项目部署",
    "支持机会管理模块",
    "支持客户身份认证",
    "支持团队支持S/MIME",
    "安全团队支持SAML单点登录",
    "未知技术支持",
  ])("keeps technical support as a protected local occurrence: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
    expect(analysis.atoms.some((atom) => atom.kind === "protected_fact")).toBe(true);
  });

  it.each([
    "识别支持团队",
    "支持团队支持项目推进",
    "管理层支持机会推进",
  ])("keeps organizational support separate from product support: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(false);
    expect(analysis.unresolved).toBe(false);
    expect(analysis.atoms.every((atom) =>
      atom.kind === "relationship_support" || atom.kind === "synthesis",
    )).toBe(true);
  });

  it.each([
    "支持团队支持项目推进，并确认系统支持IPv6",
    "系统支持IPv6，同时管理层支持机会推进",
    "技术团队支持高可用和支持团队支持项目推进",
    "支持团队支持项目推进与安全团队支持SAML单点登录",
  ])("never lets a relationship support occurrence mask a technical one: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
    expect(analysis.atoms.some((atom) => atom.kind === "protected_fact")).toBe(true);
  });

  it.each([
    "并发部署优化方案",
    "并行迁移路线图",
    "并网改造计划",
    "并列方案优化建议",
  ])("does not split lexical compounds: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(false);
    expect(analysis.atoms).toHaveLength(1);
  });

  it.each([
    "产品版本与公司优化建议",
    "数据保留周期和集团改进策略",
    "报价跟中心推进方案",
    "研发与创新中心能力提升建议",
    "天地和科技部署优化方案",
  ])("fails closed instead of assuming an entity-internal weak connector: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
    expect(analysis.unresolved).toBe(true);
    expect(analysis.atoms.some((atom) => atom.kind === "unresolved")).toBe(true);
  });

  it.each([
    "系统功能和优化建议",
    "优化建议和系统功能",
    "版本与升级计划",
    "产品型号跟下一步行动",
  ])("treats weak connector fact mixtures as direct: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
  });

  it.each([
    "版本升级计划和容量扩容策略",
    "优化建议与下一步行动",
    "部署优化方案并认证改造工作计划",
  ])("allows weak connector synthesis pairs when both sides are complete: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(false);
    expect(analysis.unresolved).toBe(false);
  });

  it.each([
    "陌生叙事动作系统功能和优化建议",
    "优化建议随后陌生叙事动作系统功能",
    "客户团队跟未知技术支持",
  ])("does not let unseen narrative wording suppress a local fact: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
  });

  it.each([
    "（系统功能与优化建议",
    "“系统功能与优化建议",
    "系统功能优化",
    "版本升级计划系统功能",
  ])("marks unbalanced or governor-ambiguous text unresolved and direct: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.unresolved).toBe(true);
    expect(analysis.requiresDirectEvidence).toBe(true);
    expect(analysis.atoms.some((atom) => atom.kind === "unresolved")).toBe(true);
  });

  it("fails closed for a single-character 并 candidate that lacks a proven compound scope", () => {
    const analysis = expectSourceIntegrity("跨域并优化建议");
    expect(analysis.requiresDirectEvidence).toBe(true);
    expect(analysis.atoms.some((atom) =>
      atom.kind === "protected_fact" || atom.kind === "unresolved",
    )).toBe(true);
  });

  it.each([
    "“系统功能和优化建议”及部署优化方案",
    "（产品版本与升级计划）并给出迁移方案",
  ])("does not create atoms across balanced quote or parenthesis layers: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
    expect(analysis.atoms.some((atom) =>
      atom.kind === "protected_fact" || atom.kind === "unresolved",
    )).toBe(true);
    expect(analysis.atoms.every((atom) =>
      atom.start >= analysis.sourceSpan.start && atom.end <= analysis.sourceSpan.end,
    )).toBe(true);
  });

  it.each([
    "陌生动词产品版本和优化建议",
    "罕见叙事数据保留周期及升级计划",
    "任意动作报价与迁移路线图",
  ])("keeps unknown narrative verbs from reducing bare-fact protection: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
  });

  it.each([
    "确认系统版本后给出升级建议",
    "核实未知属性任意叙事提出优化方案",
    "说明配置状态接着制定迁移路线图",
    "核实系统版本之后再提出升级建议",
  ])("does not let a trailing deliverable head suppress a local fact request: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
    expect(analysis.atoms.some((atom) =>
      atom.kind === "protected_fact" || atom.kind === "unresolved",
    )).toBe(true);
  });

  it.each([
    "了解产品现状",
    "了解当前版本现状",
  ])("keeps neutral inquiry about a state as a direct fact request: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
  });

  it.each([
    "系统版本\n升级建议",
    "升级建议\n系统版本",
  ])("keeps newline-separated fact and synthesis atoms direct: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
  });

  it.each([
    "盘点系统版本后给出升级建议",
    "梳理产品型号之后提出优化方案",
    "未知叙事阶段接着制定迁移路线图",
  ])("fails closed for a narrative phase before a later deliverable: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
    expect(analysis.atoms.some((atom) =>
      atom.kind === "protected_fact" || atom.kind === "unresolved",
    )).toBe(true);
  });

  it.each([
    "围绕系统版本给出升级建议",
    "制定确认流程优化建议",
  ])("keeps a single governed deliverable eligible without a phase boundary: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(false);
    expect(analysis.unresolved).toBe(false);
  });

  it.each([
    "当前技术支持团队",
    "现有客户支持者",
  ])("treats a state-modified supporter noun as a protected fact: %s", (sourceText) => {
    const analysis = expectSourceIntegrity(sourceText);
    expect(analysis.requiresDirectEvidence).toBe(true);
  });
});
