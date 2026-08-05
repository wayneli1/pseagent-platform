import "./styles.css";
import { ApiError, OpsApiClient } from "./api.js";
import { badge, h, json, shortId, time } from "./format.js";
import {issueStatusHelp,label,option} from "./labels.js";
import type {
  Audit,
  AnswerReviewDetail,
  AnswerReviewMeta,
  CardRevision,
  Dashboard,
  FeedbackDetail,
  FeedbackMeta,
  IssueDetail,
  IssuePage,
  IssuePriority,
  IssueStatus,
  OpsJob,
  RegressionRun,
  Release,
  ViewName,
} from "./types.js";

const rootElement = document.querySelector<HTMLDivElement>("#app");
if (!rootElement) throw new Error("app_root_missing");
const root: HTMLDivElement = rootElement;
const nav: { id: ViewName; label: string; icon: string }[] = [
  { id: "dashboard", label: "总览", icon: "⌂" },
  { id: "issues", label: "问题中心", icon: "!" },
  { id: "feedback", label: "原始记录", icon: "◎" },
  { id: "cards", label: "答案卡", icon: "▤" },
  { id: "regressions", label: "回归评测", icon: "✓" },
  { id: "releases", label: "发布与回滚", icon: "↗" },
  { id: "audit", label: "审计日志", icon: "≡" },
];
const TOKEN_KEY = "pse-knowledge-ops-token";
let token = sessionStorage.getItem(TOKEN_KEY) ?? "";
const api = new OpsApiClient(token);
let current: ViewName = viewFromHash();
const ISSUE_PAGE_SIZE=25;
let issueFilters:{status:"actionable"|"all"|IssueStatus;priority:"all"|IssuePriority;offset:number}={status:"actionable",priority:"all",offset:0};

if (token) void showApp();
else showLogin();
window.addEventListener("hashchange", () => {
  current = viewFromHash();
  if (token) void showApp();
});
document.addEventListener("click", (event) => void handleClick(event));
document.addEventListener("submit", (event) => void handleSubmit(event));
document.addEventListener("change", (event)=>void handleChange(event));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeOverlay();
});

function showLogin(error = "") {
  root.innerHTML = `<main class="login"><form class="login-card" id="login-form"><div class="brand-mark">P</div><h1>PSE 知识运营台</h1><p>集中处理用户反馈、答案卡审核、回归评测和知识发布。访问令牌仅保存在当前浏览器标签会话中。</p>${error ? `<div class="notice error" role="alert">${h(error)}</div>` : ""}<div class="field"><label for="token">访问令牌</label><input id="token" name="token" type="password" minlength="24" required autocomplete="current-password" placeholder="输入管理员或运营令牌"></div><button class="button primary" type="submit">进入运营台</button></form></main>`;
}
async function showApp() {
  root.innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><div class="brand-mark">P</div><div><strong>PSE 知识运营</strong><small>Knowledge Ops</small></div></div><nav class="nav" aria-label="主导航">${nav.map((item) => `<button data-nav="${item.id}" class="${item.id === current ? "active" : ""}" aria-current="${item.id === current ? "page" : "false"}"><span aria-hidden="true">${item.icon}</span><span class="label">${item.label}</span></button>`).join("")}</nav><div class="sidebar-foot"><div class="connection"><i class="dot"></i><span>管理服务已连接</span></div><button class="button small" data-action="logout">退出会话</button></div></aside><main class="main"><header class="topbar"><h1>${h(nav.find((x) => x.id === current)?.label)}</h1><div class="top-actions"><button class="button" data-action="refresh">刷新</button>${current === "cards" ? '<button class="button" data-action="sync-cards">同步知识库答案卡</button><button class="button primary" data-action="new-card">新建修订</button>' : ""}</div></header><section id="content" class="content" aria-live="polite">${loading()}</section></main></div><div id="overlay"></div><div id="toast" aria-live="assertive"></div>`;
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
    `<div class="page-intro"><div><h2>今天需要处理什么</h2><p>正常回答由系统收敛；管理员只关注高风险、超时和无人负责的问题组。</p></div><button class="button primary" data-nav="issues">进入问题中心</button></div><div class="grid metrics operations-metrics">${metric("紧急问题",summary.issues.urgent,"P0 / P1 优先处理",summary.issues.urgent?"danger":"neutral")}${metric("已经超时",summary.issues.overdue,"超过处理时限",summary.issues.overdue?"danger":"neutral")}${metric("无人负责",summary.issues.unassigned,"需要分派负责人",summary.issues.unassigned?"warning":"neutral")}${metric("待处理问题",summary.issues.actionable,"已合并重复反馈","warning")}${metric("自动复查通过",summary.answerReviews.passed,`自动处理率 ${automated}%`,"success")}</div><section class="panel"><div class="panel-head"><div><h2>优先处理</h2><span class="muted">${issues.total} 个问题组，已按风险和最近发生时间排序</span></div><button class="button small" data-nav="issues">查看全部</button></div>${actionRows.length?table(["优先级","问题类型","状态","影响","负责人","处理时限","下一步"],actionRows):empty("当前没有需要人工处理的异常")}</section><div class="grid two-col mt-16"><section class="panel"><div class="panel-head"><div><h2>问题优先级</h2><span class="muted">一个问题组可包含多位用户的重复反馈</span></div></div><div class="panel-body stack">${bars(summary.issues.byPriority)}</div></section><section class="panel"><div class="panel-head"><h2>系统与发布状态</h2></div><div class="panel-body stack"><div><span class="muted">当前活动版本</span><div class="mono mt-6">${h(summary.activeReleaseId ?? "尚未发布")}</div></div><div><span class="muted">最近发布</span><div class="mt-6">${releases[0] ? `${badge(releases[0].status)} ${h(releases[0].releaseId)}` : "—"}</div></div><div><span class="muted">后台作业</span><div class="mt-6">${
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
    <div class="notice workflow-note"><strong>管理员负责：</strong>确认优先级与问题类型、分派负责人、跟踪修订和回归验证。系统不会因为用户点了“答案错误”就直接改写线上知识。</div>
    <section class="panel mt-16"><div class="panel-head"><div><h2>问题队列</h2><span class="muted">共 ${page.total} 个问题组</span></div></div>
    <div class="toolbar issue-toolbar"><select id="issue-status" class="button" aria-label="按处理阶段筛选"><option value="actionable"${issueFilters.status==="actionable"?" selected":""}>只看待处理</option><option value="all"${issueFilters.status==="all"?" selected":""}>全部阶段</option>${(["open","assigned","in_progress","validating","resolved","dismissed"] as IssueStatus[]).map((value)=>option(value,issueFilters.status)).join("")}</select><select id="issue-priority" class="button" aria-label="按优先级筛选"><option value="all"${issueFilters.priority==="all"?" selected":""}>全部优先级</option>${(["p0","p1","p2","p3"] as IssuePriority[]).map((value)=>option(value,issueFilters.priority)).join("")}</select><span class="muted">P0 2小时 · P1 8小时 · P2 24小时 · P3 72小时</span></div>
    ${page.items.length?table(["优先级","问题类型","状态","影响","负责人","处理时限","最近发生","下一步"],page.items.map((item)=>issueRow(item,false))):empty("当前筛选条件下没有问题")}
    <div class="pagination"><span class="muted">显示 ${start}–${end} / ${page.total}</span><div><button class="button small" data-action="issue-page-prev"${issueFilters.offset===0?" disabled":""}>上一页</button> <button class="button small" data-action="issue-page-next"${issueFilters.offset+ISSUE_PAGE_SIZE>=page.total?" disabled":""}>下一页</button></div></div></section>`);
}
async function renderFeedback() {
  const [values,reviews] = await Promise.all([api.get<FeedbackMeta[]>("/v1/feedback"),api.get<AnswerReviewMeta[]>("/v1/answer-reviews")]);
  const reviewByRequest=new Map(reviews.map((review)=>[review.requestId,review]));
  const reviewNeedsAction=reviews.filter((item)=>item.processingStatus==="errored"||item.verdict==="fail"||item.verdict==="needs_review"||item.workflowStatus==="open"||item.workflowStatus==="in_review").length;
  const feedbackNeedsAction=values.filter((item)=>item.status!=="resolved"&&item.status!=="rejected"&&item.classification!=="useful").length;
  content(
    `<div class="notice workflow-note"><strong>管理原则：</strong>默认只显示需要人工介入的记录。复查通过和“回答有帮助”由系统自动收敛；只有人工审核后的答案卡或知识修订才会影响后续回答。</div><section class="panel mt-16"><div class="panel-head"><div><h2>自动复查异常</h2><span class="muted">只处理未通过、需要人工复核和执行异常</span></div></div><div class="toolbar"><select id="review-verdict" class="button" aria-label="按复查结论筛选"><option value="actionable" selected>只看需要处理</option><option value="all">全部复查记录</option>${["pending","pass","needs_review","fail"].map((x)=>option(x)).join("")}</select><span class="muted">待处理 ${reviewNeedsAction} 条 · 全部 ${reviews.length} 条</span></div>${reviews.length?table(["论客聊天名","问题摘要","执行状态","复查结论","分数","缺陷","时间"],reviews.map((x)=>{const actionable=x.processingStatus==="errored"||x.verdict==="fail"||x.verdict==="needs_review"||x.workflowStatus==="open"||x.workflowStatus==="in_review";return`<tr data-action="answer-review-detail" data-id="${h(x.reviewId)}" data-verdict="${h(x.verdict)}" data-actionable="${actionable}"${actionable?"":" hidden"}><td>${h(x.userDisplayName??"未获取到聊天名")}</td><td>${h(x.questionPreview)}</td><td>${badge(x.processingStatus)}</td><td>${badge(x.verdict)}</td><td>${h(x.score??"—")}</td><td>${x.defectCount}</td><td>${time(x.createdAt)}</td></tr>`;})):empty("尚无自动复查记录")}</section><section class="panel mt-16"><div class="panel-head"><div><h2>用户负面反馈</h2><span class="muted">默认隐藏“回答有帮助”和已关闭记录</span></div></div><div class="toolbar"><select id="feedback-status" class="button" aria-label="按反馈状态筛选"><option value="actionable" selected>只看需要处理</option><option value="all">全部反馈记录</option>${["new", "triaged", "in_review", "resolved", "rejected"].map((x) => option(x)).join("")}</select><span class="muted">待处理 ${feedbackNeedsAction} 条 · 全部 ${values.length} 条；原问原答仅在详情中解密</span></div>${
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
    `<div class="notice">发布前必须绑定一次通过的回归运行，并由非发起人完成批准。发布生成不可变目录快照；回滚只切换活动指针。</div><div class="toolbar mt-14"><button class="button primary" data-action="new-release">创建发布</button></div>${
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
      sessionStorage.removeItem(TOKEN_KEY);
      token = "";
      showLogin();
      break;
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
      await issueDrawer(target.dataset.id!);
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
      token = String(data.get("token") ?? "").trim();
      api.setToken(token);
      await api.get("/v1/dashboard");
      sessionStorage.setItem(TOKEN_KEY, token);
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
    } else if(form.id==="issue-form"){
      const ownerId=String(data.get("ownerId")??"").trim();
      await api.patch(`/v1/issues/${form.dataset.id}`,{status:data.get("status"),...(ownerId?{ownerId}:{})});
      toast("问题处理进度已更新");
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
      token = "";
      showLogin(message(error));
    } else toast(message(error), true);
  }
}

async function handleChange(event: Event) {
  const select = event.target;
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

async function issueDrawer(id:string){
  const item=await api.get<IssueDetail>(`/v1/issues/${id}`);
  const occurrenceRows=item.occurrences.map((occurrence)=>`<tr><td>${badge(occurrence.sourceType)}</td><td>${time(occurrence.createdAt)}</td><td class="mono">${shortId(occurrence.requestId,16)}</td><td><button class="button small" data-action="${occurrence.sourceType==="feedback"?"feedback-detail":"answer-review-detail"}" data-id="${h(occurrence.sourceId)}">查看原始记录</button></td></tr>`);
  const allowed=nextIssueStatuses(item.status);
  overlay(`<div class="drawer-head"><div><strong>${h(label(item.category))}</strong> ${badge(item.priority)} ${badge(item.status)}</div><button class="button" data-action="close-overlay">关闭</button></div>
    <div class="drawer-body"><div class="notice"><strong>当前下一步：</strong>${h(nextIssueAction(item))}。关闭问题不会自动修改答案；只有审核、回归并发布后的答案卡或知识修订才会影响用户。</div>
    <div class="issue-facts"><div><span>影响用户</span><strong>${item.affectedUserCount}</strong></div><div><span>重复发生</span><strong>${item.occurrenceCount}</strong></div><div><span>处理时限</span><strong class="${isOverdue(item.slaDueAt)&&isActionableStatus(item.status)?"danger-text":""}">${h(slaText(item.slaDueAt,item.status))}</strong></div></div>
    <div class="detail-section"><h3>问题范围</h3><div class="content-box">${h(label(item.scope??"未分类"))}${item.answerCardKey?`<br><span class="muted">关联答案卡标识：</span><span class="mono">${shortId(item.answerCardKey,16)}</span>`:""}</div></div>
    <form id="issue-form" data-id="${h(id)}"><div class="field"><label for="issue-owner">负责人</label><input id="issue-owner" name="ownerId" maxlength="128" value="${h(item.ownerId??"")}" placeholder="填写知识负责人账号"><div class="field-help">进入“已分派、修订中、待验证、已解决”前必须有负责人。</div></div><div class="field"><label for="issue-workflow-status">处理阶段</label><select id="issue-workflow-status" name="status">${allowed.map((value)=>option(value,item.status)).join("")}</select><div class="field-help">${h(issueStatusHelp(item.status))}。修订后必须进入“待验证”，通过回归验证后才能标记“已解决”。</div></div><button class="button primary" type="submit">保存处理进度</button></form>
    <div class="detail-section mt-16"><h3>合并的证据记录</h3>${occurrenceRows.length?table(["来源","发生时间","请求标识","操作"],occurrenceRows):empty("暂无关联记录")}</div></div>`);
}

async function answerReviewDrawer(id:string){
  const item=await api.get<AnswerReviewDetail>(`/v1/answer-reviews/${id}`);
  const defects=item.result?.defects??[];
  const obligations=item.result?.obligationChecks??[];
  overlay(
    `<div class="drawer-head"><div><strong>自动复查 #${item.questionId}</strong> ${badge(item.processingStatus)} ${badge(item.verdict)}</div><button class="button" data-action="close-overlay">关闭</button></div>
    <div class="drawer-body">
      <div class="detail-section"><h3>用户与复查状态</h3><div class="content-box">${h(item.userDisplayName??"未获取到聊天名")}</div><div class="muted mt-6">模型：${h(item.model)} · 分数：${h(item.score??"—")} · 缺陷：${item.defectCount}</div></div>
      ${item.errorCode?`<div class="notice error">复查执行异常：${h(item.errorCode)}。该记录不会被当作通过，请安排人工检查或重试。</div>`:""}
      <div class="detail-section"><h3>复查结论</h3><div class="content-box">${h(item.result?.summary??"复查尚未完成")}</div></div>
      ${obligations.length?`<div class="detail-section"><h3>必答项检查</h3>${table(["必答项","覆盖情况","说明"],obligations.map((x)=>`<tr><td class="mono">${h(x.obligationId)}</td><td>${badge(x.covered?"covered":"missing")}</td><td>${h(x.explanation)}</td></tr>`))}</div>`:""}
      ${defects.length?`<div class="detail-section"><h3>发现的问题</h3>${table(["严重程度","问题分类","问题","依据"],defects.map((x)=>`<tr><td>${badge(x.severity)}</td><td>${badge(x.category)}</td><td>${h(x.summary)}</td><td>${h(x.evidence||"—")}</td></tr>`))}</div>`:""}
      <div class="detail-section"><h3>原始问题</h3><div class="content-box">${h(item.question)}</div></div>
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
      <div class="detail-section"><h3>原始问题</h3><div class="content-box">${h(item.question)}</div></div>
      <div class="detail-section"><h3>原始回答</h3><div class="content-box">${h(item.answer)}</div></div>
      <div class="detail-section"><h3>答案卡匹配摘要</h3><pre class="content-box mono">${json(item.answerCardMatch ?? {})}</pre></div>
      <form id="triage-form" data-id="${h(id)}">
        <div class="notice">如果用户误点了反馈类型，可在这里纠正。修改只影响工单分类，不会直接改写线上答案。</div>
        <div class="field"><label for="feedback-classification">反馈类型</label><select id="feedback-classification" name="classification">${classifications.map((x) => option(x,item.classification)).join("")}</select></div>
        <div class="field"><label for="feedback-workflow-status">处理状态</label><select id="feedback-workflow-status" name="status">${["new", "triaged", "in_review", "resolved", "rejected"].map((x) => option(x,item.status)).join("")}</select><div class="field-help">待处理：尚未判断；已分类：已确认问题类型；处理中：已有负责人；已解决：修复并验证完成；已关闭：无效或重复反馈。</div></div>
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
    `<div class="drawer-head"><strong>审核答案卡修订</strong><button class="button" data-action="close-overlay">关闭</button></div><form class="drawer-body" id="review-form" data-id="${h(id)}"><div class="notice">创建人不能审核自己创建的修订。批准后会生成独立批准记录。</div><div class="field"><label>审核结论</label><select name="decision" aria-label="审核结论"><option value="approved">批准</option><option value="changes_requested">要求修改</option><option value="rejected">拒绝</option></select></div><div class="field"><label>审核意见</label><textarea name="comment" aria-label="审核意见" maxlength="4000" required></textarea></div><button class="button primary" type="submit">提交审核</button></form>`,
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
  overlay(`<div class="drawer-head"><strong>创建知识发布</strong><button class="button" data-action="close-overlay">关闭</button></div><form class="drawer-body" id="release-form"><div class="notice">请粘贴通过 Schema 校验的发布清单。系统还会校验回归运行必须通过、双知识库提交未漂移、发起人与批准人分离。</div><div class="field"><label>发布清单 JSON</label><textarea name="manifest" aria-label="发布清单 JSON" class="textarea-tall" required>{
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
  const deadline=slaText(item.slaDueAt,item.status),overdue=isOverdue(item.slaDueAt)&&isActionableStatus(item.status);
  return `<tr data-action="issue-detail" data-id="${h(item.issueId)}"><td>${badge(item.priority)}</td><td><strong>${h(label(item.category))}</strong>${item.answerCardKey?`<br><span class="muted">答案卡 ${shortId(item.answerCardKey,10)}</span>`:""}</td><td>${badge(item.status)}${compact?"":`<br><span class="muted">${h(issueStatusHelp(item.status))}</span>`}</td><td>${h(impact)}</td><td>${h(item.ownerId??"待分派")}</td><td><span class="${overdue?"danger-text":""}">${h(deadline)}</span></td>${compact?"":`<td>${time(item.lastSeenAt)}</td>`}<td><span class="action-link">${h(nextIssueAction(item))}</span></td></tr>`;
}
function isActionableStatus(value:IssueStatus){return value!=="resolved"&&value!=="dismissed";}
function isOverdue(value:string){return new Date(value).valueOf()<Date.now();}
function slaText(value:string,status:IssueStatus){if(!isActionableStatus(status))return"已结束";const milliseconds=new Date(value).valueOf()-Date.now(),absolute=Math.abs(milliseconds),hours=Math.max(1,Math.ceil(absolute/3_600_000));return milliseconds<0?`已超时 ${hours} 小时`:`剩余 ${hours} 小时`;}
function nextIssueAction(item:IssuePage["items"][number]){if(item.status==="open")return"分派负责人";if(item.status==="assigned")return"开始修订";if(item.status==="in_progress")return"提交验证";if(item.status==="validating")return"完成回归验证";return"查看记录";}
function nextIssueStatuses(currentStatus:IssueStatus):IssueStatus[]{const next:Record<IssueStatus,IssueStatus[]>={open:["open","assigned","dismissed"],assigned:["assigned","in_progress","open","dismissed"],in_progress:["in_progress","validating","assigned","dismissed"],validating:["validating","resolved","in_progress","dismissed"],resolved:["resolved","open"],dismissed:["dismissed","open"]};return next[currentStatus];}

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
  const value = location.hash.slice(1) as ViewName;
  return nav.some((x) => x.id === value) ? value : "dashboard";
}
function message(error: unknown) {
  return error instanceof ApiError
    ? `${error.status} · ${error.code}`
    : error instanceof Error
      ? error.message
      : "操作失败";
}
function handleApiError(error: unknown) {
  if (error instanceof ApiError && error.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    token = "";
    showLogin("访问令牌无效或已失效");
    return;
  }
  content(`<div class="notice error">加载失败：${h(message(error))}</div>`);
}
