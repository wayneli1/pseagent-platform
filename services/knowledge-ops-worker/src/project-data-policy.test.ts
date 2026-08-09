import {describe,expect,it} from "vitest";
import {evaluateProjectDataAnswer,inspectAnswerCardRuleConflicts,rewriteBroadProjectDataForbiddenClaims} from "./project-data-policy.js";

const evidence=[
  {title:"东莞节点",path:"wiki/entities/东莞节点.md",content:"# 东莞节点\n### 华为Coremail邮件系统项目\n东莞节点是主生产节点，预测用户基数为10W。\n## 华为项目：服务器配置\n- 代理服务器：2台，安装 nginx\n- 前端服务器：2台，安装 MTA。"},
  {title:"英国节点",path:"wiki/entities/英国节点.md",content:"# 英国节点\n### 华为Coremail邮件系统项目\n英国节点是海外镜像节点，预测用户基数为2W。"},
  {title:"比亚迪股份有限公司",path:"wiki/entities/比亚迪股份有限公司.md",content:"# 比亚迪股份有限公司\n比亚迪项目采用场地授权，总授权约44万用户，部署4套系统。"},
];

describe("项目数据证据边界",()=>{
  it("允许正式证据直接支持的华为项目用户数",()=>{
    const result=evaluateProjectDataAnswer({answer:"**华为项目**\n东莞节点预测10万用户，英国节点预测2万用户；每个节点配置2台代理服务器和2台前端服务器。",evidence});
    expect(result.diagnostics).toEqual([]);
  });

  it("不把项目实时同步机制误判成用户规模实时化",()=>{
    const result=evaluateProjectDataAnswer({answer:"**华为项目**\n东莞节点为主生产节点（预测10万用户），英国节点为海外镜像节点（预测2万用户），通过实时同步、强同步和定时同步传输数据。",evidence});
    expect(result.diagnostics).toEqual([]);
  });

  it("拒绝把项目数据扩大为所有客户通用配置",()=>{
    const result=evaluateProjectDataAnswer({answer:"**华为项目**\n东莞节点预测10万用户，因此所有客户的通用配置都是10万用户。",evidence});
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({stage:"forbidden_claim",suggestedAction:"modify_answer"})]));
  });

  it("拒绝把历史或预测数据描述为当前容量承诺",()=>{
    const result=evaluateProjectDataAnswer({answer:"**华为项目**\n当前产品容量上限承诺为10万用户。",evidence});
    expect(result.diagnostics.some((item)=>item.stage==="forbidden_claim")).toBe(true);
  });

  it("允许答案复述用户问题中给定的客户规模",()=>{
    const result=evaluateProjectDataAnswer({question:"客户有五千用户，需要多活高可用，服务器怎么配？",answer:"对于 5000 用户场景，仍需结合并发量和数据量测算，不能把其他项目配置直接承诺给该客户。",evidence:[]});
    expect(result.diagnostics).toEqual([]);
  });

  it("不把一套方案的枚举量词误判成项目部署套数",()=>{
    const result=evaluateProjectDataAnswer({
      answer:"另一套方案使用每用户邮箱容量 5G、实际占用率 40%。",
      evidence:[{
        title:"存储估算",
        path:"wiki/concepts/capacity.md",
        content:"## 容量案例\n参数包括每用户邮箱容量 5G、实际占用率 40%。\n这些数值是项目案例中的规划值。",
      }],
    });
    expect(result.diagnostics).toEqual([]);
  });

  it("在模型调用前指出必答项与宽泛禁答项的规则冲突",()=>{
    const conflicts=inspectAnswerCardRuleConflicts({answerTemplate:"**华为项目**\n东莞节点预测10万用户。",evidence,obligations:[{id:"O1",label:"项目规模",evidencePolicy:"direct",requiredConcepts:["华为项目规模"],forbiddenClaims:["华为项目具体用户数"],preferredEvidencePaths:["wiki/entities/东莞节点.md"]}]});
    expect(conflicts).toEqual([expect.objectContaining({code:"evidence_supported_project_data_forbidden",obligationId:"O1",field:"forbiddenClaims",suggestedAction:"modify_rule"})]);
  });

  it("在模型调用前把抽象必答概念识别为规则问题",()=>{
    const conflicts=inspectAnswerCardRuleConflicts({answerTemplate:"MTA 接收邮件后交给 deliveragent 完成病毒扫描和反垃圾检查。",evidence:[],obligations:[{id:"O1",label:"区分职责",evidencePolicy:"direct",requiredConcepts:["MTA 双处理队列","deliveragent 核心功能","入信链路"],forbiddenClaims:[],preferredEvidencePaths:["wiki/entities/deliveragent.md"]}]});
    expect(conflicts).toEqual([expect.objectContaining({code:"unverifiable_required_concept",obligationId:"O1",field:"requiredConcepts",triggerText:"deliveragent 核心功能",suggestedAction:"modify_rule",message:expect.stringContaining("抽象、集合或复合陈述")})]);
  });

  it("在模型调用前把带数量的流程集合拆为可验证原子事实",()=>{
    const conflicts=inspectAnswerCardRuleConflicts({answerTemplate:"系统跳转到 AuthorizeUrl，取得授权码后调用 AccessTokenUrl，再通过 UsernameUrl 获取用户标识。",evidence:[],obligations:[{id:"O1",label:"认证流程",evidencePolicy:"direct",requiredConcepts:["OAuth2 授权码模式认证流程 7 个步骤"],forbiddenClaims:[],preferredEvidencePaths:["wiki/concepts/OAuth2统一身份认证对接.md"]}]});
    expect(conflicts).toEqual([expect.objectContaining({code:"unverifiable_required_concept",obligationId:"O1",triggerText:"OAuth2 授权码模式认证流程 7 个步骤",suggestedAction:"modify_rule",message:expect.stringContaining("集合或复合陈述")})]);
  });

  it("把标签加整句说明识别为复合必答概念",()=>{
    const conflicts=inspectAnswerCardRuleConflicts({answerTemplate:"兴业银行项目部署了 6 万 Air 客户端用户，并配合静态通讯录。",evidence:[],obligations:[{id:"O1",label:"项目案例",evidencePolicy:"direct",requiredConcepts:["Air客户端项目案例：兴业银行最终用户数 6 万，使用 Air 客户端，需部署静态通讯录"],forbiddenClaims:[],preferredEvidencePaths:["wiki/entities/Air客户端.md"]}]});
    expect(conflicts).toEqual([expect.objectContaining({code:"unverifiable_required_concept",obligationId:"O1",triggerText:expect.stringContaining("兴业银行最终用户数 6 万"),suggestedAction:"modify_rule",message:expect.stringContaining("复合陈述")})]);
  });

  it("不把约44万误认为超过44万",()=>{
    expect(evaluateProjectDataAnswer({answer:"**比亚迪项目**\n总授权约44万用户。",evidence}).diagnostics).toEqual([]);
    expect(evaluateProjectDataAnswer({answer:"**比亚迪项目**\n总授权超过44万用户。",evidence}).diagnostics).toEqual([expect.objectContaining({stage:"evidence_support",message:expect.stringContaining("数值口径")})]);
  });

  it("没有正式证据支持的项目数字不能通过",()=>{
    const result=evaluateProjectDataAnswer({answer:"**华为项目**\n东莞节点预测12万用户。",evidence});
    expect(result.diagnostics).toEqual([expect.objectContaining({stage:"evidence_support",suggestedAction:"add_evidence"})]);
  });

  it("把宽泛禁答项改写为跨项目、实时化和承诺边界",()=>{
    const result=rewriteBroadProjectDataForbiddenClaims(["工行有多节点架构方案","华为项目具体用户数"]);
    expect(result.claims).toContain("工行有多节点架构方案");
    expect(result.claims).not.toContain("华为项目具体用户数");
    expect(result.claims).toEqual(expect.arrayContaining([expect.stringContaining("产品容量上限"),expect.stringContaining("其他客户"),expect.stringContaining("当前实时数据") ]));
  });
});
