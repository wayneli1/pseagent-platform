import "./styles.css";
import { ApiError, OpsApiClient } from "./api.js";
import { badge, h, json, shortId, time } from "./format.js";
import {errorMessage,issueStatusHelp,label,option} from "./labels.js";
import {isAnswerReviewActionable} from "./operations-overview.js";
import {conversationPresentation} from "./conversation-view.js";
import {hasCompleteRepairProposal,isRepairEditable,repairEvidenceState,repairPrimaryAction,repairStep,repairSuggestedActionLabel,repairValidationCaseState,repairValidationFieldLabel,repairValidationIsUnchanged,repairValidationStageLabel,shouldShowRepairDiff,standaloneRepairAliases} from "./repair-workflow.js";
import type {
  Audit,
  AnswerReviewDetail,
  AnswerReviewMeta,
  CardRevision,
  ConversationRelation,
  Dashboard,
  FeedbackDetail,
  FeedbackMeta,
  IssueDetail,
  IssuePage,
  IssuePriority,
  IssueStatus,
  OpsJob,
  RegressionRun,
  RepairBatch,
  RepairBatchDetail,
  RepairDraft,
  RepairProposal,
  RepairPublication,
  RepairValidation,
  Release,
  ViewName,
} from "./types.js";

const rootElement = document.querySelector<HTMLDivElement>("#app");
if (!rootElement) throw new Error("app_root_missing");
const root: HTMLDivElement = rootElement;
const nav: { id: ViewName; label: string; icon: string }[] = [
  { id: "dashboard", label: "总览", icon: "⌂" },
  { id: "issues", label: "问题中心", icon: "!" },
  { id: "batches", label: "待发布", icon: "⇧" },
  { id: "feedback", label: "原始记录", icon: "◎" },
  { id: "cards", label: "答案卡", icon: "▤" },
  { id: "regressions", label: "回归评测", icon: "✓" },
  { id: "releases", label: "发布与回滚", icon: "↗" },
  { id: "audit", label: "审计日志", icon: "≡" },
];
const SESSION_KEY = "pse-knowledge-ops-session";
let sessionToken = sessionStorage.getItem(SESSION_KEY) ?? "";
sessionStorage.removeItem("pse-knowledge-ops-token");
const api = new OpsApiClient(sessionToken);
let current: ViewName = viewFromHash();
let repairIssueId=repairIdFromHash();
let activeRepairDraft:RepairDraft|undefined;
let repairSaveTimer:ReturnType<typeof setTimeout>|undefined;
let repairRefreshTimer:ReturnType<typeof setTimeout>|undefined;
const selectedRepairDraftIds=new Set<string>();
const ISSUE_PAGE_SIZE=25;
let issueFilters:{status:"actionable"|"all"|IssueStatus;priority:"all"|IssuePriority;offset:number}={status:"actionable",priority:"all",offset:0};

if (sessionToken) void showApp();
else showLogin();
window.addEventListener("hashchange", () => {
  current = viewFromHash();
  repairIssueId=repairIdFromHash();
  if (sessionToken) void showApp();
});
document.addEventListener("click", (event) => void handleClick(event));
document.addEventListener("submit", (event) => void handleSubmit(event));
document.addEventListener("change", (event)=>void handleChange(event));
document.addEventListener("input", handleInput);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeOverlay();
});

function showLogin(error = "",username="admin",busy=false) {
  root.innerHTML = `<main class="login"><form class="login-card" id="login-form"><div class="brand-mark">P</div><h1>PSE 知识运营台</h1><p id="login-help">登录后集中处理异常问题、知识修订、回归验证和安全发布。</p><div class="field"><label for="username">账号</label><input id="username" name="username" type="text" value="${h(username)}" maxlength="64" required autocomplete="username" spellcheck="false" aria-describedby="login-help" placeholder="输入管理员账号"${busy?" disabled":""}></div><div class="field"><label for="password">密码</label><div class="password-control"><input id="password" name="password" type="password" maxlength="256" required autocomplete="current-password" placeholder="输入管理员密码"${busy?" disabled":""}><button class="password-toggle" type="button" data-action="toggle-password" aria-controls="password" aria-pressed="false"${busy?" disabled":""}>显示</button></div>${error ? `<div class="field-error" role="alert">${h(error)}</div>` : ""}</div><button id="login-submit" class="button primary login-submit" type="submit"${busy?" disabled aria-busy=\"true\"":""}>${busy?"正在登录…":"登录"}</button></form></main>`;
  if(error)queueMicrotask(()=>document.querySelector<HTMLInputElement>("#password")?.focus());
}
async function showApp() {
  if(repairRefreshTimer!==undefined)clearTimeout(repairRefreshTimer);
  const pageTitle=current==="repair"?"知识修订工作台":nav.find((x) => x.id === current)?.label;
  root.innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><div class="brand-mark">P</div><div><strong>PSE 知识运营</strong><small>Knowledge Ops</small></div></div><nav class="nav" aria-label="主导航">${nav.map((item) => `<button data-nav="${item.id}" class="${item.id === current ? "active" : ""}" aria-current="${item.id === current ? "page" : "false"}"><span aria-hidden="true">${item.icon}</span><span class="label">${item.label}</span></button>`).join("")}</nav><div class="sidebar-foot"><div class="connection"><i class="dot"></i><span>管理服务已连接</span></div><button class="button small" data-action="logout">退出会话</button></div></aside><main class="main"><header class="topbar"><h1>${h(pageTitle)}</h1><div class="top-actions">${current==="repair"?'<button class="button" data-nav="issues">返回问题中心</button>':""}<button class="button" data-action="refresh">刷新</button>${current === "cards" ? '<button class="button" data-action="sync-cards">同步知识库答案卡</button><button class="button primary" data-action="new-card">新建修订</button>' : ""}</div></header><section id="content" class="content" aria-live="polite">${loading()}</section></main></div><div id="overlay"></div><div id="toast" aria-live="assertive"></div>`;
  await loadCurrent();
}
async function loadCurrent() {
  try {
    switch (current) {
      case "dashboard":
        await renderDashboard();
        break;
      case "issues":
        await renderIssues();
        break;
      case "repair":
        await renderRepairWorkbench();
        break;
      case "batches":
        await renderRepairBatches();
        break;
      case "feedback":
        await renderFeedback();
        break;
      case "cards":
        await renderCards();
        break;
      case "regressions":
        await renderRegressions();
        break;
      case "releases":
        await renderReleases();
        break;
      case "audit":
        await renderAudit();
        break;
    }
  } catch (error) {
    handleApiError(error);
  }
}

async function renderDashboard() {
  const [summary, issues, releases, jobs] = await Promise.all([
    api.get<Dashboard>("/v1/dashboard"),
    api.get<IssuePage>("/v1/issues?actionable=true&limit=12&offset=0"),
    api.get<Release[]>("/v1/releases"),
    api.get<OpsJob[]>("/v1/jobs"),
  ]);
  const automated=summary.answerReviews.total===0?0:Math.round((summary.answerReviews.passed/summary.answerReviews.total)*100);
  const actionRows=issues.items.map((item)=>issueRow(item,true));
  content(
    `<div class="page-intro"><div><h2>今天需要处理什么</h2><p>正常回答由系统自动收敛；管理员重点确认高风险问题、修订质量和待发布批次。</p></div><div><button class="button" data-nav="issues">进入问题中心</button> <button class="button primary" data-nav="batches">查看待发布</button></div></div><div class="grid metrics operations-metrics">${metric("紧急问题",summary.issues.urgent,"P0 / P1 优先处理",summary.issues.urgent?"danger":"neutral")}${metric("待发布修订",summary.issues.readyToPublish,"已验证，可组成批次",summary.issues.readyToPublish?"warning":"neutral")}${metric("正在验证",summary.issues.validating,"可同时处理其他修订",summary.issues.validating?"warning":"neutral")}${metric("发布失败批次",summary.repairBatches.failed,"需要检查 Git 或回归结果",summary.repairBatches.failed?"danger":"neutral")}${metric("自动复查通过",summary.answerReviews.passed,`自动处理率 ${automated}%`,"success")}</div><section class="panel"><div class="panel-head"><div><h2>优先处理</h2><span class="muted">${issues.total} 个问题组，已按风险和最近发生时间排序</span></div><button class="button small" data-nav="issues">查看全部</button></div>${actionRows.length?table(["优先级","问题类型","状态","影响","下一步"],actionRows):empty("当前没有需要人工处理的异常")}</section><div class="grid two-col mt-16"><section class="panel"><div class="panel-head"><div><h2>问题优先级</h2><span class="muted">一个问题组可包含多位用户的重复反馈</span></div></div><div class="panel-body stack">${bars(summary.issues.byPriority)}</div></section><section class="panel"><div class="panel-head"><h2>系统与发布状态</h2></div><div class="panel-body stack"><div><span class="muted">当前活动版本</span><div class="mono mt-6">${h(summary.activeReleaseId ?? "尚未发布")}</div></div><div><span class="muted">最近发布</span><div class="mt-6">${releases[0] ? `${badge(releases[0].status)} ${h(releases[0].releaseId)}` : "—"}</div></div><div><span class="muted">后台作业</span><div class="mt-6">${
      jobs
        .slice(0, 3)
        .map((x) => `${badge(x.status)} ${h(label(x.type))}`)
        .join("<br>") || "—"
    }</div></div></div></section></div>`,
  );
}

async function renderIssues(){
  const parameters=new URLSearchParams({limit:String(ISSUE_PAGE_SIZE),offset:String(issueFilters.offset)});
  if(issueFilters.status==="actionable")parameters.set("actionable","true");
  else if(issueFilters.status!=="all")parameters.set("status",issueFilters.status);
  if(issueFilters.priority!=="all")parameters.set("priority",issueFilters.priority);
  const page=await api.get<IssuePage>(`/v1/issues?${parameters}`);
  const start=page.total===0?0:issueFilters.offset+1,end=Math.min(page.total,issueFilters.offset+page.items.length);
  content(`<div class="page-intro"><div><h2>只管理需要行动的问题</h2><p>系统自动合并重复反馈和复查异常；原始问答仅在证据记录中按需查看。</p></div></div>
    <div class="notice workflow-note"><strong>后台管理员负责：</strong>确认问题类型、完成修订、执行回归验证并关闭问题。系统不会因为用户点了“答案错误”就直接改写线上知识。</div>
    <section class="panel mt-16"><div class="panel-head"><div><h2>问题队列</h2><span class="muted">共 ${page.total} 个问题组</span></div></div>
    <div class="toolbar issue-toolbar"><select id="issue-status" class="button" aria-label="按处理阶段筛选"><option value="actionable"${issueFilters.status==="actionable"?" selected":""}>只看待处理</option><option value="all"${issueFilters.status==="all"?" selected":""}>全部阶段</option>${(["open","in_progress","validating","resolved","dismissed"] as IssueStatus[]).map((value)=>option(value,issueFilters.status)).join("")}</select><select id="issue-priority" class="button" aria-label="按优先级筛选"><option value="all"${issueFilters.priority==="all"?" selected":""}>全部优先级</option>${(["p0","p1","p2","p3"] as IssuePriority[]).map((value)=>option(value,issueFilters.priority)).join("")}</select><span class="muted">重复反馈已自动合并；优先看影响用户多、风险高的问题</span></div>
    ${page.items.length?table(["优先级","问题类型","状态","影响","最近发生","下一步"],page.items.map((item)=>issueRow(item,false))):empty("当前筛选条件下没有问题")}
    <div class="pagination"><span class="muted">显示 ${start}–${end} / ${page.total}</span><div><button class="button small" data-action="issue-page-prev"${issueFilters.offset===0?" disabled":""}>上一页</button> <button class="button small" data-action="issue-page-next"${issueFilters.offset+ISSUE_PAGE_SIZE>=page.total?" disabled":""}>下一页</button></div></div></section>`);
}
async function renderRepairBatches(){
  const [ready,batches]=await Promise.all([api.get<RepairDraft[]>("/v1/repair-drafts/ready"),api.get<RepairBatch[]>("/v1/repair-batches")]),readyIds=new Set(ready.map((item)=>item.draftId));
  for(const id of selectedRepairDraftIds)if(!readyIds.has(id))selectedRepairDraftIds.delete(id);
  const rows=ready.map((draft)=>`<tr><td><input type="checkbox" data-batch-draft="${h(draft.draftId)}" aria-label="选择 ${h(draft.proposal?.title??draft.draftId)}"${selectedRepairDraftIds.has(draft.draftId)?" checked":""}></td><td><strong>${h(draft.proposal?.title??"未命名修订")}</strong><br><span class="muted">${h(draft.proposal?.canonicalQuestion??"—")}</span></td><td>${h(domainName(draft.targetDomain??draft.proposal?.targetDomain??"—"))}</td><td class="mono">${h(draft.targetPath??draft.proposal?.targetPath??"—")}</td><td>${time(draft.updatedAt)}</td><td><button class="button small" data-action="open-repair" data-id="${h(draft.issueId)}">查看修订</button></td></tr>`);
  const batchRows=batches.map((batch)=>`<tr data-action="repair-batch-detail" data-id="${h(batch.batchId)}"><td class="mono">${shortId(batch.batchId,12)}</td><td>${badge(batch.status)}</td><td>${batch.itemCount} 项</td><td>${batch.domains.map(domainName).map(h).join("<br>")}</td><td>${batch.errorCode?`<span class="danger-text">${h(errorMessage(batch.errorCode))}</span>`:batch.status==="published"?"已写入并同步 GitHub":"—"}</td><td>${time(batch.createdAt)}</td></tr>`);
  content(`<div class="page-intro"><div><h2>把已验证修订组成一次发布</h2><p>草稿生成和验证可以并行；这里只汇总已经通过验证、等待管理员最终发布的内容。</p></div><button class="button" data-nav="issues">继续处理问题</button></div>
    <div class="notice workflow-note"><strong>发布规则：</strong>同一知识库的多项修订会合并成一个 Git 提交并一次推送到 GitHub；两个知识库分别提交。任何回归或推送失败都会阻止整批生效，已推送部分会自动补偿回滚。</div>
    <section class="panel mt-16"><div class="panel-head"><div><h2>待发布池</h2><span class="muted">已选择 <strong id="batch-selected-count">${selectedRepairDraftIds.size}</strong> / ${ready.length} 项</span></div><button class="button primary" data-action="publish-repair-batch"${selectedRepairDraftIds.size===0?" disabled":""}>发布所选并同步 GitHub</button></div>${rows.length?table(["选择","标准答案","知识库","写入页面","验证完成","操作"],rows):empty("暂无待发布修订；先在问题中心完成草稿生成和自动验证")}</section>
    <section class="panel mt-16"><div class="panel-head"><div><h2>最近发布批次</h2><span class="muted">点击一行查看每个知识库的同步结果</span></div></div>${batchRows.length?table(["批次","状态","修订数","知识库","结果","创建时间"],batchRows):empty("尚无发布批次")}</section>`);
  if(batches.some((batch)=>batch.status==="queued"||batch.status==="publishing"))repairRefreshTimer=setTimeout(()=>{if(current==="batches")void renderRepairBatches().catch(handleApiError);},1_800);
}
async function renderRepairWorkbench(){
  if(!repairIssueId){location.hash="issues";return;}
  const issue=await api.get<IssueDetail>(`/v1/issues/${encodeURIComponent(repairIssueId)}`),drafts=await api.get<RepairDraft[]>(`/v1/issues/${encodeURIComponent(repairIssueId)}/repair-drafts`),draft=drafts[0];activeRepairDraft=draft;
  const [validations,publications,evidenceRecords]=await Promise.all([
    draft?api.get<RepairValidation[]>(`/v1/repair-drafts/${encodeURIComponent(draft.draftId)}/validations`):Promise.resolve([]),
    draft?api.get<RepairPublication[]>(`/v1/repair-drafts/${encodeURIComponent(draft.draftId)}/publications`):Promise.resolve([]),
    Promise.all(issue.occurrences.slice(0,8).map(async(occurrence)=>occurrence.sourceType==="feedback"?{kind:"feedback" as const,value:await api.get<FeedbackDetail>(`/v1/feedback/${encodeURIComponent(occurrence.sourceId)}`)}:{kind:"answer_review" as const,value:await api.get<AnswerReviewDetail>(`/v1/answer-reviews/${encodeURIComponent(occurrence.sourceId)}`)})),
  ]);
  const latestValidation=validations[0],latestPublication=publications[0],action=repairPrimaryAction(draft),step=repairStep(draft?.status),published=draft?.status==="published";
  const primaryAction=action.id==="generate"||action.id==="retry"?"repair-generate":action.id==="validate"?"repair-validate":action.id==="batch"?"repair-add-to-batch":"";
  const evidenceHtml=evidenceRecords.map((record)=>{const value=record.value,user=value.userDisplayName??"未获取到聊天名";if(record.kind==="feedback"){const feedback=value as FeedbackDetail;return`<article class="evidence-card"><div class="evidence-head"><strong>${h(user)}</strong>${badge(feedback.classification)}</div>${conversationContextHtml(feedback.question,feedback.conversation)}<h4>原始回答</h4><div class="content-box">${h(feedback.answer)}</div>${feedback.comment?`<h4>用户补充</h4><div class="content-box">${h(feedback.comment)}</div>`:""}</article>`;}const review=value as AnswerReviewDetail;return`<article class="evidence-card"><div class="evidence-head"><strong>${h(user)}</strong>${badge(review.verdict)}</div>${conversationContextHtml(review.question,review.conversation)}<h4>自动复查结论</h4><div class="content-box">${h(review.result?.summary??"复查尚未完成")}</div>${review.result?.defects.length?table(["程度","问题","依据"],review.result.defects.map((item)=>`<tr><td>${badge(item.severity)}</td><td>${h(item.summary)}</td><td>${h(item.evidence)}</td></tr>`)):""}</article>`;}).join("");
  const validationHtml=renderRepairValidation(latestValidation),proposalHtml=draft?.proposal?renderRepairProposal(draft):renderRepairState(draft),originalAnswer=evidenceRecords[0]?.value.answer,diffHtml=shouldShowRepairDiff(draft,originalAnswer)?`<section class="panel mt-16"><div class="panel-head"><h2>回答变化预览</h2></div><div class="panel-body"><div class="repair-diff"><div><span>用户当时收到的回答</span><div class="content-box">${h(originalAnswer!)}</div></div><div><span>修订后标准答案</span><div class="content-box repair-answer-preview">${h(draft!.proposal!.answerTemplate)}</div></div></div></div></section>`:"";
  content(`<div class="repair-header"><div><h2>${h(label(issue.category))}</h2><p>${badge(issue.priority)} ${badge(issue.status)} · ${issue.affectedUserCount} 位用户 · ${issue.occurrenceCount} 次重复</p></div><div class="repair-header-status"><span>当前下一步</span><strong>${h(action.label)}</strong></div></div>
    ${repairStepper(step,published)}
    ${draft?.errorCode?`<div class="notice error mt-16"><strong>执行未完成：</strong>${h(errorMessage(draft.errorCode))}<br>你可以按当前主要操作重新生成或修改后再验证。</div>`:""}
    ${draft?.proposal?.blockingReason?`<div class="notice warning mt-16"><strong>当前不能发布：</strong>${h(draft.proposal.blockingReason)}</div>`:""}
    <div class="repair-layout mt-16"><aside class="repair-evidence"><section class="panel"><div class="panel-head"><div><h2>问题与证据</h2><span class="muted">最多显示最近 8 条合并记录</span></div></div><div class="panel-body stack">${evidenceHtml||empty("暂无可读取的证据记录")}</div></section><section class="panel mt-16"><div class="panel-head"><h2>验证结果</h2></div><div class="panel-body">${validationHtml}</div></section></aside><section class="repair-editor"><section class="panel"><div class="panel-head"><div><h2>修订草稿</h2><span id="repair-save-state" class="muted">${draft&&hasCompleteRepairProposal(draft)&&isRepairEditable(draft.status)?"修改后自动保存":"由流程锁定"}</span></div>${draft?badge(draft.status):""}</div><div class="panel-body">${proposalHtml}</div></section>${diffHtml}</section></div>
    <div class="repair-actionbar"><div><strong>${h(action.label)}</strong><span>${h(repairActionHelp(draft,latestValidation))}</span></div><div>${issue.status!=="resolved"&&issue.status!=="dismissed"?'<button class="button" data-action="repair-dismiss">无需处理</button>':""}${latestPublication?.status==="published"?`<button class="button danger" data-action="repair-rollback" data-id="${h(latestPublication.publicationId)}">回滚本次修订</button>`:""}${primaryAction?`<button class="button primary" data-action="${primaryAction}"${action.disabled?" disabled":""}>${h(action.label)}</button>`:`<button class="button primary" disabled>${h(action.label)}</button>`}</div></div>`);
  if(draft&&["generating","validating","publishing"].includes(draft.status))scheduleRepairRefresh();
}

function repairStepper(currentStep:number,published:boolean){const steps=["确认问题","编辑修订","自动验证","批次发布"];return`<ol class="repair-stepper" aria-label="知识修订进度">${steps.map((title,index)=>{const number=index+1,state=published||number<currentStep?"done":number===currentStep?"active":"pending";return`<li class="${state}"${state==="active"?' aria-current="step"':""}><i>${state==="done"?"✓":number}</i><span>${h(title)}</span></li>`;}).join("")}</ol>`;}
function renderRepairState(draft:RepairDraft|undefined){if(draft===undefined)return`<div class="empty action-empty"><strong>尚未生成修订草稿</strong><span>Agent 将只使用已校验正式资料，生成客户中立的答案卡建议。</span></div>`;if(draft.status==="generating")return`<div class="repair-progress"><div class="spinner" aria-hidden="true"></div><strong>正在读取问题、复查缺陷和正式证据</strong><span>模型固定为 ${h(draft.model)}，草稿不会影响线上回答。</span></div>`;return`<div class="empty action-empty"><strong>${h(label(draft.status))}</strong><span>${h(errorMessage(draft.errorCode??"repair_draft_unavailable"))}</span></div>`;}
function renderRepairProposal(draft:RepairDraft){const evidence=renderRepairEvidenceState(draft);if(!hasCompleteRepairProposal(draft)){const proposal=draft.proposal!;return`${evidence}<div class="repair-blocked" role="alert"><strong>当前无法生成标准答案</strong><p>${h(proposal.blockingReason??proposal.generationSummary)}</p><span>系统不会把空内容写入知识库。使用下方“重新校验正式证据并生成”读取当前知识版本；如果正式资料没有变化，结果仍会保持阻塞。</span></div>`;}return`${evidence}${renderRepairProposalForm(draft)}`;}
function renderRepairEvidenceState(draft:RepairDraft){const state=repairEvidenceState(draft);return`<section class="repair-evidence-state ${h(state.tone)}" aria-label="正式证据校验状态"><div><strong>${h(state.title)}</strong><span>${h(state.summary)}</span></div>${state.details.length?`<ul>${state.details.map((item)=>`<li>${h(item)}</li>`).join("")}</ul>`:""}</section>`;}
function renderRepairProposalForm(draft:RepairDraft){const proposal=draft.proposal!,editable=isRepairEditable(draft.status),disabled=editable?"":" disabled",aliases=standaloneRepairAliases(proposal);return`<form id="repair-proposal-form" data-id="${h(draft.draftId)}"><div class="repair-target"><div><span>根因</span><strong>${h(label(proposal.rootCause))}</strong></div><div><span>修订对象</span><strong>${h(label(proposal.targetKind))}</strong></div><div><span>写入位置</span><strong>${h(domainName(proposal.targetDomain??"—"))}</strong></div></div><div class="field"><label for="repair-title">答案卡标题</label><input id="repair-title" name="title" value="${h(proposal.title)}" maxlength="500" required${disabled}></div><div class="field"><label for="repair-question">标准问题</label><textarea id="repair-question" name="canonicalQuestion" required${disabled}>${h(proposal.canonicalQuestion)}</textarea></div><div class="field"><label for="repair-aliases">同义问法与口语问法</label><textarea id="repair-aliases" name="aliases"${disabled}>${h(aliases.join("\n"))}</textarea><div class="field-help">每行一个可独立理解的问法；上下文追问只用于多轮验证，不会写入知识卡。</div></div><div class="field"><label for="repair-answer">修订后的标准答案</label><textarea id="repair-answer" class="repair-answer" name="answerTemplate" required${disabled}>${h(proposal.answerTemplate)}</textarea></div><div class="repair-section-title"><h3>必答项和证据边界</h3><span>不能删除正式答案卡已有的安全约束</span></div>${proposal.obligations.map((item)=>`<fieldset class="obligation-card" data-obligation data-id="${h(item.id)}"><legend>${h(item.id)} · ${h(item.label)}</legend><div class="field"><label>必答项名称</label><input aria-label="${h(item.id)} 必答项名称" data-field="label" value="${h(item.label)}" required${disabled}></div><div class="grid two-col"><div class="field"><label>必须覆盖的概念</label><textarea aria-label="${h(item.id)} 必须覆盖的概念" data-field="requiredConcepts"${disabled}>${h(item.requiredConcepts.join("\n"))}</textarea></div><div class="field"><label>禁止出现的承诺</label><textarea aria-label="${h(item.id)} 禁止出现的承诺" data-field="forbiddenClaims"${disabled}>${h(item.forbiddenClaims.join("\n"))}</textarea></div></div><div class="field"><label>正式证据路径</label><textarea aria-label="${h(item.id)} 正式证据路径" data-field="preferredEvidencePaths"${disabled}>${h(item.preferredEvidencePaths.join("\n"))}</textarea></div><input type="hidden" data-field="evidencePolicy" value="${h(item.evidencePolicy)}"></fieldset>`).join("")}<div class="repair-section-title"><h3>五类验证问题</h3><span>标准、同义、口语、追问和边界负例各一条</span></div><div class="regression-grid">${proposal.regressionQuestions.map((item)=>`<label><span>${h(label(item.kind))}</span><textarea data-regression-kind="${h(item.kind)}" required${disabled}>${h(item.question)}</textarea></label>`).join("")}</div><div class="field"><label for="repair-summary">修订说明</label><textarea id="repair-summary" name="generationSummary"${disabled}>${h(proposal.generationSummary)}</textarea></div></form>`;}
function renderRepairValidation(validation:RepairValidation|undefined){
  if(validation===undefined)return empty("提交草稿后，系统会在隔离环境执行五类验证");
  if(validation.status==="queued"||validation.status==="running")return`<div class="repair-progress compact"><div class="spinner" aria-hidden="true"></div><strong>${h(label(validation.status))}</strong><span>正在检查 Schema、证据、命中、必答项和禁答主张。</span></div>`;
  const conflicts=validation.result?.ruleConflicts??[],rows=validation.result?.targeted??[],reused=validation.result?.reused===true?'<span class="validation-reused">草稿和证据未变化，已复用上次结果</span>':"";
  if(conflicts.length>0)return`<div class="validation-summary failed" role="alert"><strong>规则冲突，需要调整</strong><span>${conflicts.length} 处冲突</span></div>${reused}<div class="validation-conflicts">${conflicts.map((item)=>`<article class="validation-conflict"><div class="validation-conflict-head"><strong>${h(item.obligationId)} · ${h(repairValidationFieldLabel(item.field))}</strong><span>${h(repairValidationStageLabel("rule_conflict"))}</span></div><p>${h(item.message)}</p><dl><div><dt>触发原文</dt><dd>${h(item.triggerText)}</dd></div><div><dt>冲突规则</dt><dd>${h(item.rule)}</dd></div>${item.evidencePaths.length?`<div><dt>正式证据</dt><dd>${item.evidencePaths.map(h).join("<br>")}</dd></div>`:""}</dl><button class="button small" data-action="focus-repair-field" data-obligation="${h(item.obligationId)}" data-field="${h(item.field)}">${h(repairSuggestedActionLabel(item.suggestedAction))}并定位字段</button></article>`).join("")}</div>`;
  return`<div class="validation-summary ${validation.status}"${validation.status==="failed"?' role="alert"':""}><strong>${validation.status==="passed"?"五类问题全部通过":"验证未通过，已退回修订"}</strong><span>${validation.passedCases} / ${validation.totalCases} 项通过</span></div>${reused}${rows.length?table(["问题类型","验证问题","失败阶段","最终结论","原因与处理"],rows.map((item)=>{const state=repairValidationCaseState(item),diagnostic=state.diagnostic,location=diagnostic?.obligationId?`${diagnostic.obligationId} · ${repairValidationFieldLabel(diagnostic.field)}`:diagnostic?repairValidationFieldLabel(diagnostic.field):"—",action=diagnostic?`<div class="validation-action"><span>${h(repairSuggestedActionLabel(diagnostic.suggestedAction))}</span>${diagnostic.obligationId||diagnostic.field?`<button class="link-button" data-action="focus-repair-field" data-obligation="${h(diagnostic.obligationId??"")}" data-field="${h(diagnostic.field??"answerTemplate")}">定位</button>`:""}</div>`:"";return`<tr><td>${badge(item.kind)}</td><td>${h(item.question)}</td><td>${h(diagnostic?`${repairValidationStageLabel(diagnostic.stage)} · ${location}`:"—")}</td><td>${badge(state.badge)}</td><td><div>${h(state.explanation)}</div>${diagnostic?.triggerText?`<div class="validation-trigger">原文：${h(diagnostic.triggerText)}</div>`:""}${diagnostic?.rule?`<div class="validation-rule">规则：${h(diagnostic.rule)}</div>`:""}${action}</td></tr>`;})):""}${validation.errorCode?`<div class="notice error mt-16">${h(errorMessage(validation.errorCode))}</div>`:""}`;
}
function repairActionHelp(draft:RepairDraft|undefined,validation?:RepairValidation){if(!draft)return"只生成运营草稿，不会直接改写知识库";if((draft.status==="draft_ready"||draft.status==="validation_failed")&&draft.proposal?.publishable===false)return draft.evidenceSummary?.loadedCount?"重新校验证据并再次调用修订 Agent，不会写入正式知识库":"重新读取当前知识版本；正式资料没有变化时仍会保持阻塞";if(repairValidationIsUnchanged(draft,validation))return"草稿自上次验证后未修改；再次验证会复用原结果，不会自动修复答案或规则冲突";if(draft.status==="draft_ready"||draft.status==="validation_failed")return"修改会自动保存；验证期间可离开页面继续处理其他问题";if(draft.status==="ready_to_publish")return"先进入待发布池，可与其他已验证修订合并后一次推送 GitHub";if(draft.status==="published")return"本次修订已写入正式知识库、同步 GitHub 并切换活动快照";return"后台作业执行中，可离开页面后再回来查看";}
async function renderFeedback() {
  const [values,reviews] = await Promise.all([api.get<FeedbackMeta[]>("/v1/feedback"),api.get<AnswerReviewMeta[]>("/v1/answer-reviews")]);
  const reviewByRequest=new Map(reviews.map((review)=>[review.requestId,review]));
  const reviewNeedsAction=reviews.filter(isAnswerReviewActionable).length;
  const feedbackNeedsAction=values.filter((item)=>item.status!=="resolved"&&item.status!=="rejected"&&item.classification!=="useful").length;
  content(
    `<div class="notice workflow-note"><strong>反馈仍然有用：</strong>系统用它合并重复问题、判断影响人数、发现“用户反馈与自动复查冲突”，并作为修订 Agent 的问题证据。反馈本身不会直接改写答案，也不要求管理员逐条办理。</div><section class="panel mt-16"><div class="panel-head"><div><h2>自动复查异常</h2><span class="muted">只处理未通过、需要人工复核和执行异常</span></div></div><div class="toolbar"><select id="review-verdict" class="button" aria-label="按复查结论筛选"><option value="actionable" selected>只看需要处理</option><option value="all">全部复查记录</option>${["pending","pass","needs_review","fail"].map((x)=>option(x)).join("")}</select><span class="muted">待处理 ${reviewNeedsAction} 条 · 全部 ${reviews.length} 条</span></div>${reviews.length?table(["论客聊天名","问题摘要","执行状态","复查结论","人工状态","分数","缺陷","时间"],reviews.map((x)=>{const actionable=isAnswerReviewActionable(x);return`<tr data-action="answer-review-detail" data-id="${h(x.reviewId)}" data-verdict="${h(x.verdict)}" data-actionable="${actionable}"${actionable?"":" hidden"}><td>${h(x.userDisplayName??"未获取到聊天名")}</td><td>${reviewQuestionSummary(x)}</td><td>${badge(x.processingStatus)}</td><td>${badge(x.verdict)}</td><td>${badge(x.workflowStatus)}</td><td>${h(x.score??"—")}</td><td>${x.defectCount}</td><td>${time(x.createdAt)}</td></tr>`;})):empty("尚无自动复查记录")}</section><section class="panel mt-16"><div class="panel-head"><div><h2>用户负面反馈</h2><span class="muted">默认隐藏“回答有帮助”和已关闭记录</span></div></div><div class="toolbar"><select id="feedback-status" class="button" aria-label="按反馈状态筛选"><option value="actionable" selected>只看需要处理</option><option value="all">全部反馈记录</option>${["new", "triaged", "in_review", "resolved", "rejected"].map((x) => option(x)).join("")}</select><span class="muted">待处理 ${feedbackNeedsAction} 条 · 全部 ${values.length} 条；原问原答仅在详情中解密</span></div>${
      values.length
        ? table(
            [
              "反馈类型",
              "处理状态",
              "关联复查",
              "回答状态",
              "范围",
              "引用",
              "论客聊天名",
              "提交时间",
            ],
            values.map(
              (x) => {
                const linked=reviewByRequest.get(x.requestId);
                const actionable=x.status!=="resolved"&&x.status!=="rejected"&&x.classification!=="useful";
                return `<tr data-action="feedback-detail" data-id="${h(x.caseId)}" data-status="${h(x.status)}" data-actionable="${actionable}"${actionable?"":" hidden"}><td>${badge(x.classification)}</td><td>${badge(x.status)}</td><td>${linked?badge(linked.verdict):'<span class="muted">尚无关联复查</span>'}</td><td>${badge(x.answerStatus)}</td><td>${h(label(x.scope ?? "—"))}</td><td>${x.referenceCount}</td><td>${h(x.userDisplayName ?? "未获取到聊天名")}</td><td>${time(x.createdAt)}</td></tr>`;
              },
            ),
          )
        : empty("尚未收到用户反馈")
    }</section>`,
  );
}
async function renderCards() {
  const cards = await api.get<CardRevision[]>("/v1/cards");
  const catalogCount=cards.filter((card)=>card.createdBy==="catalog-sync").length;
  const operatorCount=cards.length-catalogCount;
  content(
    `<div class="notice workflow-note"><strong>数据来源：</strong>两套 Git/Obsidian 知识库是已批准答案卡的事实来源，后台同步为只读目录镜像；人工新建的内容是运营修订，必须经过审核、回归和发布才会影响用户回答。当前：${catalogCount} 条目录镜像，${operatorCount} 条运营修订。</div><div class="mt-16">${cards.length
      ? table(
          [
            "答案卡",
            "知识域",
            "来源",
            "修订",
            "状态",
            "创建人",
            "基线提交",
            "更新时间",
            "操作",
          ],
          cards.map(
            (card) =>
              `<tr><td><strong>${h(card.cardId)}</strong><br><span class="muted">${h(String(card.content.title ?? ""))}</span></td><td>${h(domainName(card.domain))}</td><td>${card.createdBy==="catalog-sync"?'<span class="source-tag">知识库目录</span>':'<span class="source-tag operator">运营修订</span>'}</td><td>r${card.revision}</td><td>${badge(card.status)}</td><td>${h(card.createdBy==="catalog-sync"?"系统同步":card.createdBy)}</td><td class="mono">${shortId(card.baseGitRevision)}</td><td>${time(card.updatedAt)}</td><td><button class="button small" data-action="card-detail" data-id="${h(card.revisionId)}">查看</button> ${card.status !== "approved" && card.createdBy!=="catalog-sync" ? `<button class="button small primary" data-action="review-card" data-id="${h(card.revisionId)}">审核</button>` : ""}</td></tr>`,
          ),
        )
      : `<div class="empty action-empty"><strong>还没有同步答案卡目录</strong><span>线上知识库可能已有答案卡，但后台需要 Worker 完成首次目录同步。</span><button class="button primary" data-action="sync-cards">立即同步两套知识库</button></div>`}</div>`,
  );
}
async function renderRegressions() {
  const [cases, jobs, qualityRuns] = await Promise.all([
    api.get<Array<Record<string, unknown>>>("/v1/regressions"),
    api.get<OpsJob[]>("/v1/jobs"),
    api.get<RegressionRun[]>("/v1/regression-runs"),
  ]);
  const runs = jobs.filter((x) => x.type === "regression_run");
  const latestQuality = qualityRuns[0];
  const gateBanner = latestQuality === undefined
    ? '<div class="notice">尚无发布质量报告；发布前必须完成 4 组 × 5 类问题的 deepseek_v4_flash 门禁。</div>'
    : `<div class="notice ${latestQuality.status === "passed" ? "" : "error"}">最新发布门禁：${badge(latestQuality.status)} · ${latestQuality.passedCases}/${latestQuality.totalCases} 题通过 · 模型 ${h(latestQuality.report?.model ?? "未记录")} · P95 ${h(latestQuality.report?.summary?.p95LatencyMs ?? "—")} ms</div>`;
  content(
    gateBanner + `<div class="toolbar mt-14"><button class="button primary" data-action="run-regression">运行全量回归</button><span class="muted">回归在独立 Worker 执行，不阻塞在线问答</span></div><div class="grid two-col"><section class="panel"><div class="panel-head"><h2>测试用例</h2><span class="muted">${cases.length} 条</span></div>${
      cases.length
        ? table(
            ["用例", "知识域", "类型", "预期答案卡", "状态"],
            cases.map(
              (item) =>
                `<tr><td class="mono">${h(item.caseId)}</td><td>${h(domainName(String(item.domain)))}</td><td>${h(item.kind)}</td><td>${h(item.expectedCardId ?? "—")}</td><td>${item.enabled === false ? badge("disabled") : badge("enabled")}</td></tr>`,
            ),
          )
        : empty("还没有回归用例")
    }</section><section class="panel"><div class="panel-head"><h2>运行队列</h2></div>${
      runs.length
        ? table(
            ["作业", "状态", "尝试", "更新时间"],
            runs.map(
              (x) =>
                `<tr><td class="mono">${shortId(x.jobId)}</td><td>${badge(x.status)}</td><td>${x.attempts}</td><td>${time(x.updatedAt)}</td></tr>`,
            ),
          )
        : empty("暂无回归运行")
    }</section></div>`,
  );
}
async function renderReleases() {
  const releases = await api.get<Release[]>("/v1/releases");
  content(
    `<div class="notice">管理员确认后仍必须通过自动回归。发布会生成不可变目录快照，所有写入和回滚都有审计记录。</div><div class="toolbar mt-14"><button class="button primary" data-action="new-release">创建发布</button></div>${
      releases.length
        ? table(
            [
              "发布版本",
              "状态",
              "专业库提交",
              "通用库提交",
              "批准人",
              "创建时间",
              "操作",
            ],
            releases.map(
              (x) =>
                `<tr><td><strong>${h(x.releaseId)}</strong></td><td>${badge(x.status)}</td><td class="mono">${shortId(x.professionalRevision)}</td><td class="mono">${shortId(x.generalRevision)}</td><td>${h(x.approvedBy.join("、"))}</td><td>${time(x.createdAt)}</td><td>${x.status !== "active" ? `<button class="button small danger" data-action="rollback" data-id="${h(x.releaseId)}">回滚到此版本</button>` : "当前版本"}</td></tr>`,
            ),
          )
        : empty("尚无发布记录")
    }`,
  );
}
async function renderAudit() {
  const events = await api.get<Audit[]>("/v1/audit");
  content(
    events.length
      ? table(
          ["时间", "操作者", "动作", "资源", "资源 ID", "元数据"],
          events.map(
            (x) =>
              `<tr><td>${time(x.createdAt)}</td><td>${h(x.actorId)}</td><td class="mono">${h(x.action)}</td><td>${h(x.resourceType)}</td><td class="mono">${shortId(x.resourceId, 18)}</td><td><button class="button small" data-action="show-json" data-json="${h(JSON.stringify(x.metadata))}">查看</button></td></tr>`,
          ),
        )
      : empty("暂无审计事件"),
  );
}

async function handleClick(event: MouseEvent) {
  const target = (event.target as HTMLElement).closest<HTMLElement>(
    "[data-nav],[data-action]",
  );
  if (!target) return;
  const navTarget = target.dataset.nav as ViewName | undefined;
  if (navTarget) {
    location.hash = navTarget;
    return;
  }
  switch (target.dataset.action) {
    case "logout":
      try{await api.logout();}catch{/* 会话已失效时仍完成本地退出。 */}
      clearSession();showLogin();
      break;
    case "toggle-password": {
      const input=document.querySelector<HTMLInputElement>("#password");if(!input)return;
      const visible=input.type==="text";input.type=visible?"password":"text";target.textContent=visible?"显示":"隐藏";target.setAttribute("aria-pressed",String(!visible));input.focus();
      break;
    }
    case "refresh":
      await showApp();
      break;
    case "close-overlay":
      closeOverlay();
      break;
    case "feedback-detail":
      await feedbackDrawer(target.dataset.id!);
      break;
    case "answer-review-detail":
      await answerReviewDrawer(target.dataset.id!);
      break;
    case "issue-detail":
      location.hash=`repair/${encodeURIComponent(target.dataset.id!)}`;
      break;
    case "open-repair":
      location.hash=`repair/${encodeURIComponent(target.dataset.id!)}`;
      break;
    case "repair-generate":
      await runRepairAction(target,()=>api.post(`/v1/issues/${encodeURIComponent(repairIssueId!)}/repair-drafts`,{}),"修订 Agent 已开始生成草稿");
      break;
    case "repair-validate":
      try{await saveRepairDraftNow();await runRepairAction(target,()=>api.post(`/v1/repair-drafts/${encodeURIComponent(activeRepairDraft!.draftId)}/validate`,{}),"自动验证已开始");}catch(error){toast(message(error),true);}
      break;
    case "repair-add-to-batch":
      if(activeRepairDraft){selectedRepairDraftIds.add(activeRepairDraft.draftId);location.hash="batches";}
      break;
    case "focus-repair-field": {
      const field=target.dataset.field??"answerTemplate",obligation=target.dataset.obligation??"";
      const element=field==="answerTemplate"?document.querySelector<HTMLElement>("#repair-answer"):document.querySelector<HTMLElement>(`[data-obligation][data-id="${CSS.escape(obligation)}"] [data-field="${CSS.escape(field)}"]`);
      if(element===null){toast("未找到对应编辑字段，请刷新草稿后重试",true);break;}
      element.scrollIntoView({behavior:"smooth",block:"center"});element.focus();element.classList.add("validation-field-focus");window.setTimeout(()=>element.classList.remove("validation-field-focus"),2_400);
      break;
    }
    case "publish-repair-batch": {
      const draftIds=[...selectedRepairDraftIds];if(draftIds.length===0)break;
      if(!window.confirm(`确认发布所选 ${draftIds.length} 项修订？系统会写入正式知识库、推送 GitHub，并在整批验证通过后应用到后续回答。`))break;
      target.setAttribute("disabled","");
      try{await api.post("/v1/repair-batches",{draftIds});selectedRepairDraftIds.clear();toast("发布批次已创建，系统正在合并提交、回归验证并同步 GitHub");await renderRepairBatches();}catch(error){target.removeAttribute("disabled");toast(message(error),true);}
      break;
    }
    case "repair-batch-detail":
      await repairBatchDrawer(target.dataset.id!);
      break;
    case "repair-dismiss":
      if(window.confirm("确认该问题无需处理？这不会修改线上知识。")){await api.patch(`/v1/issues/${encodeURIComponent(repairIssueId!)}`,{status:"dismissed"});toast("问题已标记为无需处理");location.hash="issues";}
      break;
    case "repair-rollback":
      if(window.confirm("确认回滚本次知识修订？系统会恢复上一活动版本并重新打开问题。"))await runRepairAction(target,()=>api.post(`/v1/repair-publications/${encodeURIComponent(target.dataset.id!)}/rollback`,{}),"回滚作业已开始");
      break;
    case "issue-page-prev":
      issueFilters={...issueFilters,offset:Math.max(0,issueFilters.offset-ISSUE_PAGE_SIZE)};
      await renderIssues();
      break;
    case "issue-page-next":
      issueFilters={...issueFilters,offset:issueFilters.offset+ISSUE_PAGE_SIZE};
      await renderIssues();
      break;
    case "card-detail":
      await cardDrawer(target.dataset.id!);
      break;
    case "review-card":
      reviewDrawer(target.dataset.id!);
      break;
    case "new-card":
      newCardDrawer();
      break;
    case "sync-cards":
      await syncCatalog(target);
      break;
    case "run-regression":
      await runRegression();
      break;
    case "new-release":
      releaseDrawer();
      break;
    case "rollback":
      await rollback(target.dataset.id!);
      break;
    case "show-json":
      jsonDrawer(JSON.parse(target.dataset.json ?? "{}"));
      break;
  }
}
async function handleSubmit(event: SubmitEvent) {
  const form = event.target as HTMLFormElement;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  const data = new FormData(form);
  try {
    if (form.id === "login-form") {
      const username=String(data.get("username")??"").trim(),password=String(data.get("password")??"");
      showLogin("",username,true);
      const session=await api.login(username,password);
      sessionToken=session.sessionToken;api.setSessionToken(sessionToken);
      sessionStorage.setItem(SESSION_KEY,sessionToken);
      await showApp();
    } else if (form.id === "triage-form") {
      await api.patch(`/v1/feedback/${form.dataset.id}`, {
        status: data.get("status"),
        classification: data.get("classification"),
      });
      toast("反馈状态已更新");
      closeOverlay();
      await loadCurrent();
    } else if (form.id === "answer-review-triage-form") {
      await api.patch(`/v1/answer-reviews/${form.dataset.id}`, {
        workflowStatus: data.get("workflowStatus"),
      });
      toast("复查处理状态已更新");
      closeOverlay();
      await loadCurrent();
    } else if (form.id === "review-form") {
      await api.post(`/v1/revisions/${form.dataset.id}/reviews`, {
        decision: data.get("decision"),
        comment: data.get("comment"),
      });
      toast("审核意见已提交");
      closeOverlay();
      await loadCurrent();
    } else if (form.id === "card-form") {
      await api.post(
        `/v1/cards/${encodeURIComponent(String(data.get("cardId")))}/revisions`,
        {
          domain: data.get("domain"),
          baseGitRevision: data.get("baseGitRevision"),
          content: JSON.parse(String(data.get("content"))),
        },
      );
      toast("答案卡修订已创建");
      closeOverlay();
      await loadCurrent();
    } else if (form.id === "release-form") {
      await api.post("/v1/releases", JSON.parse(String(data.get("manifest"))));
      toast("发布作业已进入队列");
      closeOverlay();
      await loadCurrent();
    }
  } catch (error) {
    if (form.id === "login-form") {
      const username=String(data.get("username")??"admin").trim();clearSession();showLogin(message(error),username);
    } else toast(message(error), true);
  }
}

async function handleChange(event: Event) {
  const select = event.target;
  if(select instanceof HTMLInputElement&&select.dataset.batchDraft){if(select.checked)selectedRepairDraftIds.add(select.dataset.batchDraft);else selectedRepairDraftIds.delete(select.dataset.batchDraft);const count=document.querySelector("#batch-selected-count"),publish=document.querySelector<HTMLButtonElement>('[data-action="publish-repair-batch"]');if(count)count.textContent=String(selectedRepairDraftIds.size);if(publish)publish.disabled=selectedRepairDraftIds.size===0;return;}
  if (!(select instanceof HTMLSelectElement)) return;
  if(select.id==="feedback-status"){
    for (const row of document.querySelectorAll<HTMLTableRowElement>('tr[data-action="feedback-detail"]')) row.hidden=select.value==="actionable"?row.dataset.actionable!=="true":select.value!=="all"&&row.dataset.status!==select.value;
  }
  if(select.id==="review-verdict"){
    for (const row of document.querySelectorAll<HTMLTableRowElement>('tr[data-action="answer-review-detail"]')) row.hidden=select.value==="actionable"?row.dataset.actionable!=="true":select.value!=="all"&&row.dataset.verdict!==select.value;
  }
  if(select.id==="issue-status"){
    issueFilters={...issueFilters,status:select.value as typeof issueFilters.status,offset:0};
    await renderIssues();
  }
  if(select.id==="issue-priority"){
    issueFilters={...issueFilters,priority:select.value as typeof issueFilters.priority,offset:0};
    await renderIssues();
  }
}

function handleInput(event:Event){const target=event.target;if(!(target instanceof HTMLElement)||target.closest("#repair-proposal-form")===null||activeRepairDraft===undefined||!isRepairEditable(activeRepairDraft.status))return;const state=document.querySelector("#repair-save-state");if(state)state.textContent="有修改，正在等待自动保存…";if(repairSaveTimer!==undefined)clearTimeout(repairSaveTimer);repairSaveTimer=setTimeout(()=>void saveRepairDraftNow().catch((error)=>toast(message(error),true)),700);}
async function saveRepairDraftNow(){
  if(repairSaveTimer!==undefined){clearTimeout(repairSaveTimer);repairSaveTimer=undefined;}const draft=activeRepairDraft,form=document.querySelector<HTMLFormElement>("#repair-proposal-form");if(draft===undefined||draft.proposal===undefined||form===null||!isRepairEditable(draft.status))return;
  const proposal=collectRepairProposal(form,draft.proposal),state=document.querySelector("#repair-save-state");if(state)state.textContent="正在保存…";
  try{activeRepairDraft=await api.patch<RepairDraft>(`/v1/repair-drafts/${encodeURIComponent(draft.draftId)}`,{proposal});if(state)state.textContent=`已自动保存 ${new Date().toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"})}`;}
  catch(error){if(state){state.textContent="自动保存失败，请检查内容";state.classList.add("danger-text");}throw error;}
}
function collectRepairProposal(form:HTMLFormElement,base:RepairProposal):RepairProposal{
  const value=(name:string)=>String(new FormData(form).get(name)??"").trim(),lines=(source:string)=>source.split(/\r?\n/gu).map((item)=>item.trim()).filter(Boolean);
  const obligations=[...form.querySelectorAll<HTMLElement>("[data-obligation]")].map((element)=>{const get=(field:string)=>String(element.querySelector<HTMLInputElement|HTMLTextAreaElement>(`[data-field="${field}"]`)?.value??"");return{id:element.dataset.id!,label:get("label").trim(),evidencePolicy:get("evidencePolicy") as "direct"|"synthesis"|"customer_input",requiredConcepts:lines(get("requiredConcepts")),forbiddenClaims:lines(get("forbiddenClaims")),preferredEvidencePaths:lines(get("preferredEvidencePaths"))};});
  const regressionByKind=new Map([...form.querySelectorAll<HTMLTextAreaElement>("[data-regression-kind]")].map((element)=>[element.dataset.regressionKind!,element.value.trim()] as const));
  return{...base,title:value("title"),canonicalQuestion:value("canonicalQuestion"),aliases:lines(value("aliases")),answerTemplate:value("answerTemplate"),obligations,regressionQuestions:base.regressionQuestions.map((item)=>({...item,question:regressionByKind.get(item.kind)??item.question})),generationSummary:value("generationSummary")};
}
async function runRepairAction(button:HTMLElement,operation:()=>Promise<unknown>,notice:string){const control=button instanceof HTMLButtonElement?button:undefined;if(control){control.disabled=true;control.setAttribute("aria-busy","true");}try{await operation();toast(notice);await renderRepairWorkbench();scheduleRepairRefresh(true);}catch(error){toast(message(error),true);}finally{if(control){control.disabled=false;control.removeAttribute("aria-busy");}}}
function scheduleRepairRefresh(force=false){if(repairRefreshTimer!==undefined)clearTimeout(repairRefreshTimer);repairRefreshTimer=setTimeout(()=>{if(current==="repair"&&(force||activeRepairDraft&&["generating","validating","publishing"].includes(activeRepairDraft.status)))void renderRepairWorkbench().catch(handleApiError);},1_800);}

async function repairBatchDrawer(id:string){
  const item=await api.get<RepairBatchDetail>(`/v1/repair-batches/${encodeURIComponent(id)}`),synced=item.publications.filter((publication)=>publication.remoteSyncStatus==="synced").length,compensated=item.publications.filter((publication)=>publication.remoteSyncStatus==="compensated").length;
  overlay(`<div class="drawer-head"><div><strong>发布批次 ${shortId(item.batchId,12)}</strong> ${badge(item.status)}</div><button class="button" data-action="close-overlay">关闭</button></div><div class="drawer-body"><div class="notice"><strong>批次结果：</strong>${item.status==="published"?`${synced} 项修订已写入知识库并同步 GitHub，新的活动快照已生效。`:item.status==="failed"?`整批未生效；${compensated} 项已完成远端补偿回滚。请按错误提示修复后重新验证。`:"系统正在按知识库合并提交、执行完整回归并同步 GitHub。"}</div>${item.errorCode?`<div class="notice error mt-16"><strong>失败原因：</strong>${h(errorMessage(item.errorCode))}</div>`:""}<div class="detail-section"><h3>批次信息</h3><div class="repair-target"><div><span>修订数量</span><strong>${item.itemCount} 项</strong></div><div><span>涉及知识库</span><strong>${item.domains.map(domainName).map(h).join("、")}</strong></div><div><span>创建时间</span><strong>${time(item.createdAt)}</strong></div></div></div><div class="detail-section"><h3>知识写入与 GitHub 同步</h3>${table(["知识库","知识页面","发布状态","GitHub 状态","提交版本"],item.publications.map((publication)=>`<tr><td>${h(domainName(publication.targetDomain))}</td><td class="mono">${h(publication.targetPath)}</td><td>${badge(publication.status)}</td><td>${badge(publication.remoteSyncStatus)}</td><td class="mono">${publication.resultingGitRevision?shortId(publication.resultingGitRevision,12):"—"}</td></tr>`))}</div></div>`);
}

async function answerReviewDrawer(id:string){
  const item=await api.get<AnswerReviewDetail>(`/v1/answer-reviews/${id}`);
  const defects=item.result?.defects??[];
  const obligations=item.result?.obligationChecks??[];
  overlay(
    `<div class="drawer-head"><div><strong>自动复查 #${item.questionId}</strong> <span class="muted">执行</span> ${badge(item.processingStatus)} <span class="muted">结论</span> ${badge(item.verdict)} <span class="muted">人工</span> ${badge(item.workflowStatus)}</div><button class="button" data-action="close-overlay">关闭</button></div>
    <div class="drawer-body">
      <div class="detail-section"><h3>用户与复查状态</h3><div class="content-box">${h(item.userDisplayName??"未获取到聊天名")}</div><div class="muted mt-6">模型：${h(item.model)} · 分数：${h(item.score??"—")} · 缺陷：${item.defectCount}</div></div>
      ${item.errorCode?`<div class="notice error">复查执行异常：${h(item.errorCode)}。该记录不会被当作通过，请安排人工检查或重试。</div>`:""}
      <div class="detail-section"><h3>复查结论</h3><div class="content-box">${h(item.result?.summary??"复查尚未完成")}</div></div>
      ${obligations.length?`<div class="detail-section"><h3>必答项检查</h3>${table(["必答项","覆盖情况","说明"],obligations.map((x)=>`<tr><td class="mono">${h(x.obligationId)}</td><td>${badge(x.covered?"covered":"missing")}</td><td>${h(x.explanation)}</td></tr>`))}</div>`:""}
      ${defects.length?`<div class="detail-section"><h3>发现的问题</h3>${table(["严重程度","问题分类","问题","依据"],defects.map((x)=>`<tr><td>${badge(x.severity)}</td><td>${badge(x.category)}</td><td>${h(x.summary)}</td><td>${h(x.evidence||"—")}</td></tr>`))}</div>`:""}
      <div class="detail-section"><h3>问题上下文</h3>${conversationContextHtml(item.question,item.conversation)}</div>
      <div class="detail-section"><h3>原始回答</h3><div class="content-box">${h(item.answer)}</div></div>
      <div class="detail-section"><h3>正式引用</h3><pre class="content-box mono">${json(item.references)}</pre></div>
      <div class="detail-section"><h3>答案卡激活摘要</h3><pre class="content-box mono">${json({match:item.answerCardMatch??{},activation:item.answerCardActivation??{}})}</pre></div>
      <form id="answer-review-triage-form" data-id="${h(id)}"><div class="field"><label for="answer-review-workflow-status">人工处理状态</label><select id="answer-review-workflow-status" name="workflowStatus">${["open","in_review","resolved","dismissed"].map((x)=>option(x,item.workflowStatus)).join("")}</select><div class="field-help">确认开始处理后选择“处理中”；问题已修复选择“已解决”；确认属于误报或无需处理选择“无需处理”。</div></div><button class="button primary" type="submit">保存处理状态</button></form>
    </div>`,
  );
}

async function feedbackDrawer(id: string) {
  const [item,reviews] = await Promise.all([api.get<FeedbackDetail>(`/v1/feedback/${id}`),api.get<AnswerReviewMeta[]>("/v1/answer-reviews")]);
  const linkedReview=reviews.find((review)=>review.requestId===item.requestId);
  const classifications = [
    "useful",
    "incorrect",
    "missing",
    "review_requested",
    "evidence",
    "correction",
  ];
  overlay(
    `<div class="drawer-head"><div><strong>反馈 #${item.questionId}</strong> ${badge(item.classification)} ${badge(item.status)}</div><button class="button" data-action="close-overlay">关闭</button></div>
    <div class="drawer-body">
      <div class="notice"><strong>运营处理建议：</strong>先核对同一回答的自动复查，再判断是知识缺口、检索问题还是表达问题。用户反馈不会自动改写答案。${linkedReview?` <button class="button small" data-action="answer-review-detail" data-id="${h(linkedReview.reviewId)}">查看关联自动复查 ${badge(linkedReview.verdict)}</button>`:" 当前请求尚无自动复查记录，请人工核对原问原答。"}</div>
      <div class="detail-section"><h3>反馈用户</h3><div class="content-box">${h(item.userDisplayName ?? "未获取到聊天名")}</div><div class="muted mt-6">技术关联标识：<span class="mono">${shortId(item.pseudonymousUserId, 16)}</span></div></div>
      ${item.proposedAnswer ? `<div class="detail-section"><h3>用户提交的候选答案</h3><div class="notice">该内容仅供人工审核，不会自动进入线上知识。</div><div class="content-box mt-6">${h(item.proposedAnswer)}</div></div>` : ""}
      <div class="detail-section"><h3>用户补充</h3><div class="content-box">${h(item.comment || "（未填写补充说明）")}</div></div>
      <div class="detail-section"><h3>问题上下文</h3>${conversationContextHtml(item.question,item.conversation)}</div>
      <div class="detail-section"><h3>原始回答</h3><div class="content-box">${h(item.answer)}</div></div>
      <div class="detail-section"><h3>答案卡匹配摘要</h3><pre class="content-box mono">${json(item.answerCardMatch ?? {})}</pre></div>
      <form id="triage-form" data-id="${h(id)}">
        <div class="notice">如果用户误点了反馈类型，可在这里纠正。修改只影响工单分类，不会直接改写线上答案。</div>
        <div class="field"><label for="feedback-classification">反馈类型</label><select id="feedback-classification" name="classification">${classifications.map((x) => option(x,item.classification)).join("")}</select></div>
        <div class="field"><label for="feedback-workflow-status">处理状态</label><select id="feedback-workflow-status" name="status">${["new", "triaged", "in_review", "resolved", "rejected"].map((x) => option(x,item.status)).join("")}</select><div class="field-help">待处理：尚未判断；已分类：已确认问题类型；处理中：后台管理员正在核查；已解决：修复并验证完成；已关闭：无效或重复反馈。</div></div>
        <button class="button primary" type="submit">保存反馈处理结果</button>
      </form>
    </div>`,
  );
}
async function cardDrawer(id: string) {
  const cards = await api.get<CardRevision[]>("/v1/cards");
  const item = cards.find((x) => x.revisionId === id);
  if (!item) return;
  overlay(
    `<div class="drawer-head"><strong>${h(item.cardId)} · r${item.revision}</strong><button class="button" data-action="close-overlay">关闭</button></div><div class="drawer-body"><div class="toolbar">${badge(item.status)} ${badge(domainName(item.domain))}</div><pre class="content-box mono">${json(item.content)}</pre></div>`,
  );
}
function reviewDrawer(id: string) {
  overlay(
    `<div class="drawer-head"><strong>审核答案卡修订</strong><button class="button" data-action="close-overlay">关闭</button></div><form class="drawer-body" id="review-form" data-id="${h(id)}"><div class="notice">当前后台管理员可以完成确认；批准仍会生成独立审计记录，并且不能跳过自动回归直接发布。</div><div class="field"><label>审核结论</label><select name="decision" aria-label="审核结论"><option value="approved">批准</option><option value="changes_requested">要求修改</option><option value="rejected">拒绝</option></select></div><div class="field"><label>审核意见</label><textarea name="comment" aria-label="审核意见" maxlength="4000" required></textarea></div><button class="button primary" type="submit">提交审核</button></form>`,
  );
}
function newCardDrawer() {
  const template = {
    cardSchemaVersion: 1,
    title: "",
    canonicalQuestion: "",
    questionFamily: "",
    aliases: [],
    applicability: {
      products: [],
      versions: ["*"],
      scenarios: [],
      excludeWhen: [],
    },
    obligations: [
      {
        id: "O1",
        label: "",
        required: true,
        domains: ["coremail-professional"],
        evidencePolicy: "direct",
        requiredConcepts: [],
        forbiddenClaims: [],
        preferredEvidencePaths: [],
      },
    ],
    answerTemplate: "",
    owner: "",
    reviewers: [],
    regressionCaseIds: [],
  };
  overlay(
    `<div class="drawer-head"><strong>新建答案卡修订</strong><button class="button" data-action="close-overlay">关闭</button></div><form class="drawer-body" id="card-form"><div class="field"><label>答案卡 ID</label><input name="cardId" aria-label="答案卡 ID" required pattern="[A-Z][A-Z0-9-]{2,63}" placeholder="PRO-EXAMPLE-CARD"></div><div class="field"><label>知识域</label><select name="domain" aria-label="知识域"><option value="coremail-professional">Coremail 专业库</option><option value="presales-general">售前通用库</option></select></div><div class="field"><label>基线 Git 提交</label><input name="baseGitRevision" aria-label="基线 Git 提交" required pattern="[a-f0-9]{40}" placeholder="40 位提交 SHA"></div><div class="field"><label>答案卡 JSON</label><textarea name="content" aria-label="答案卡 JSON" class="textarea-tall" required>${json(template).replaceAll("&quot;", '"')}</textarea></div><button class="button primary" type="submit">创建草稿修订</button></form>`,
  );
}
function releaseDrawer() {
  overlay(`<div class="drawer-head"><strong>创建知识发布</strong><button class="button" data-action="close-overlay">关闭</button></div><form class="drawer-body" id="release-form"><div class="notice">请粘贴通过 Schema 校验的发布清单。系统会校验回归运行和双知识库版本，当前后台管理员可以完成确认。</div><div class="field"><label>发布清单 JSON</label><textarea name="manifest" aria-label="发布清单 JSON" class="textarea-tall" required>{
  "schemaVersion": 1,
  "releaseId": "KR-2026-08-001",
  "professionalRevision": "",
  "generalRevision": "",
  "answerContractRevision": "",
  "cardCatalogHash": "",
  "regressionRunId": "",
  "approvedBy": [],
  "createdAt": "${new Date().toISOString()}"
}</textarea></div><button class="button primary" type="submit">创建并进入发布队列</button></form>`);
}
async function runRegression() {
  await api.post("/v1/regressions/run", {});
  toast("全量回归已进入独立队列");
  await loadCurrent();
}
async function syncCatalog(button:HTMLElement){
  const control=button instanceof HTMLButtonElement?button:undefined;
  if(control){control.disabled=true;control.setAttribute("aria-busy","true");}
  try{
    const job=await api.post<OpsJob>("/v1/cards/sync",{});
    toast("答案卡同步作业已进入队列");
    for(let attempt=0;attempt<20;attempt+=1){
      await new Promise((resolve)=>setTimeout(resolve,500));
      const jobs=await api.get<OpsJob[]>("/v1/jobs");
      const currentJob=jobs.find((item)=>item.jobId===job.jobId);
      if(currentJob?.status==="completed"){toast("两套知识库答案卡已同步");await loadCurrent();return;}
      if(currentJob?.status==="failed")throw new Error(`catalog_sync_failed:${currentJob.errorCode??"unknown"}`);
    }
    toast("同步仍在后台运行，稍后刷新即可查看");
  }finally{
    if(control){control.disabled=false;control.removeAttribute("aria-busy");}
  }
}
async function rollback(id: string) {
  if (
    !window.confirm(
      `确认将活动知识版本回滚到 ${id}？在线服务会在新快照就绪后切换。`,
    )
  )
    return;
  await api.post(`/v1/releases/${encodeURIComponent(id)}/rollback`, {});
  toast("回滚作业已进入队列");
  await loadCurrent();
}
function jsonDrawer(value: unknown) {
  overlay(
    `<div class="drawer-head"><strong>审计元数据</strong><button class="button" data-action="close-overlay">关闭</button></div><div class="drawer-body"><pre class="content-box mono">${json(value)}</pre></div>`,
  );
}

function issueRow(item:IssuePage["items"][number],compact:boolean){
  const impact=`${item.affectedUserCount} 位用户 · ${item.occurrenceCount} 次`;
  return `<tr data-action="issue-detail" data-id="${h(item.issueId)}"><td>${badge(item.priority)}</td><td><strong>${h(label(item.category))}</strong>${item.answerCardKey?`<br><span class="muted">答案卡 ${shortId(item.answerCardKey,10)}</span>`:""}</td><td>${badge(item.status)}${compact?"":`<br><span class="muted">${h(issueStatusHelp(item.status))}</span>`}</td><td>${h(impact)}</td>${compact?"":`<td>${time(item.lastSeenAt)}</td>`}<td><span class="action-link">${h(nextIssueAction(item))}</span></td></tr>`;
}
function nextIssueAction(item:IssuePage["items"][number]){if(item.status==="open")return"打开修订工作台";if(item.status==="in_progress")return"继续修订";if(item.status==="validating")return"查看验证或待发布";if(item.status==="resolved")return"查看已发布记录";return"查看记录";}

function reviewQuestionSummary(item:AnswerReviewMeta){return`<div class="question-summary">${item.contextUsed?'<span class="context-kind follow_up">上下文追问</span>':""}${item.rawQuestionPreview?`<span class="question-raw">${h(item.rawQuestionPreview)}</span><small>补全为：${h(item.questionPreview)}</small>`:`<span>${h(item.questionPreview)}</span>`}</div>`;}
function conversationContextHtml(question:string,conversation?:ConversationRelation){const view=conversationPresentation(question,conversation),changed=view.rawQuestion.trim()!==view.resolvedQuestion.trim();if(view.kind==="history")return`<div class="context-card history"><div class="context-head"><strong>用户原始问题</strong><span class="context-kind history">${h(view.label)}</span></div><div class="context-question">${h(view.rawQuestion)}</div><p>历史记录没有持久化上下文关系，按原问题处理。</p></div>`;if(view.kind==="independent")return`<div class="context-card independent"><div class="context-head"><strong>本轮问题</strong><span class="context-kind independent">${h(view.label)}</span></div><div class="context-question">${h(view.rawQuestion)}</div>${changed?`<div class="context-resolved"><span>系统用于检索、复查和归并的问题</span><strong>${h(view.resolvedQuestion)}</strong></div>`:""}</div>`;return`<div class="context-card follow-up"><div class="context-head"><strong>已绑定上一轮上下文</strong><span class="context-kind follow_up">${h(view.label)}</span></div>${view.parentQuestion?`<div class="context-node parent"><span>上一问</span><strong>${h(view.parentQuestion)}</strong>${view.parentAnswerOutline?`<small>上一答提纲：${h(view.parentAnswerOutline)}</small>`:""}</div><div class="context-connector" aria-hidden="true">↓</div>`:""}<div class="context-node current"><span>用户本轮原话</span><strong>${h(view.rawQuestion)}</strong></div><div class="context-resolved"><span>补全后用于检索、复查、修订和问题归并</span><strong>${h(view.resolvedQuestion)}</strong>${view.inheritedSubjects.length?`<small>继承主题：${view.inheritedSubjects.map(h).join("、")}</small>`:""}</div></div>`;}

function content(value: string) {
  const element = document.querySelector("#content");
  if (element) element.innerHTML = value;
}
function overlay(value: string) {
  const element = document.querySelector("#overlay");
  if (element) {
    element.innerHTML = `<div class="drawer-backdrop"><section class="drawer" role="dialog" aria-modal="true">${value}</section></div>`;
    element
      .querySelector<HTMLButtonElement>('[data-action="close-overlay"]')
      ?.focus();
  }
}
function closeOverlay() {
  const element = document.querySelector("#overlay");
  if (element) element.innerHTML = "";
}
function toast(value: string, error = false) {
  const element = document.querySelector("#toast");
  if (!element) return;
  element.innerHTML = `<div class="toast ${error ? "error" : ""}">${h(value)}</div>`;
  setTimeout(() => {
    element.innerHTML = "";
  }, 3_500);
}
function table(headings: string[], rows: string[]) {
  return `<div class="table-wrap"><table><thead><tr>${headings.map((x) => `<th>${h(x)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}
function empty(value: string) {
  return `<div class="empty">${h(value)}</div>`;
}
function loading() {
  return `<div class="grid gap-12">${Array.from({ length: 8 }, () => '<div class="skeleton"></div>').join("")}</div>`;
}
function metric(title: string, value: string | number, note: string,tone="neutral") {
  return `<article class="metric metric-${h(tone)}"><div class="metric-label">${h(title)}</div><div class="metric-value">${h(value)}<span class="metric-note">${h(note)}</span></div></article>`;
}
function bars(values: Record<string, number>) {
  const entries = Object.entries(values);
  const max = Math.max(1, ...entries.map((x) => x[1]));
  return (
    entries
      .map(
        ([status, value]) =>
          `<div class="bar-row"><span>${h(label(status))}</span><progress class="bar-progress" max="${max}" value="${value}" aria-label="${h(label(status))}：${value}"></progress><strong>${value}</strong></div>`,
      )
      .join("") || empty("暂无数据")
  );
}
function domainName(value: string) {
  return value === "coremail-professional"
    ? "Coremail 专业库"
    : value === "presales-general"
      ? "售前通用库"
      : value;
}
function viewFromHash(): ViewName {
  if(location.hash.startsWith("#repair/"))return"repair";
  const value = location.hash.slice(1) as ViewName;
  return nav.some((x) => x.id === value) ? value : "dashboard";
}
function repairIdFromHash():string|undefined{if(!location.hash.startsWith("#repair/"))return undefined;const value=decodeURIComponent(location.hash.slice("#repair/".length));return value||undefined;}
function message(error: unknown) {
  return error instanceof ApiError
    ? errorMessage(error.code)
    : error instanceof Error
      ? error.message
      : "操作失败";
}
function handleApiError(error: unknown) {
  if (error instanceof ApiError && error.status === 401) {
    clearSession();showLogin("登录已失效，请重新登录");
    return;
  }
  content(`<div class="notice error">加载失败：${h(message(error))}</div>`);
}
function clearSession(){sessionStorage.removeItem(SESSION_KEY);sessionToken="";api.setSessionToken("");}
