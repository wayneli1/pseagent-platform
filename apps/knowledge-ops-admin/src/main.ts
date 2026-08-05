import "./styles.css";
import { ApiError, OpsApiClient } from "./api.js";
import { badge, h, json, shortId, time } from "./format.js";
import type {
  Audit,
  AnswerReviewDetail,
  AnswerReviewMeta,
  CardRevision,
  Dashboard,
  FeedbackDetail,
  FeedbackMeta,
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
  { id: "feedback", label: "反馈与复查", icon: "◎" },
  { id: "cards", label: "答案卡", icon: "▤" },
  { id: "regressions", label: "回归评测", icon: "✓" },
  { id: "releases", label: "发布与回滚", icon: "↗" },
  { id: "audit", label: "审计日志", icon: "≡" },
];
const TOKEN_KEY = "pse-knowledge-ops-token";
let token = sessionStorage.getItem(TOKEN_KEY) ?? "";
const api = new OpsApiClient(token);
let current: ViewName = viewFromHash();

if (token) void showApp();
else showLogin();
window.addEventListener("hashchange", () => {
  current = viewFromHash();
  if (token) void showApp();
});
document.addEventListener("click", (event) => void handleClick(event));
document.addEventListener("submit", (event) => void handleSubmit(event));
document.addEventListener("change", handleChange);
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
  const [summary, feedback, reviews, releases, jobs] = await Promise.all([
    api.get<Dashboard>("/v1/dashboard"),
    api.get<FeedbackMeta[]>("/v1/feedback"),
    api.get<AnswerReviewMeta[]>("/v1/answer-reviews"),
    api.get<Release[]>("/v1/releases"),
    api.get<OpsJob[]>("/v1/jobs"),
  ]);
  const pending =
      (summary.feedback.new ?? 0) +
      (summary.feedback.triaged ?? 0) +
      (summary.feedback.in_review ?? 0),
    latestRows=[
      ...reviews.slice(0,5).map((x)=>({createdAt:x.createdAt,html:`<tr data-action="answer-review-detail" data-id="${h(x.reviewId)}"><td>自动复查</td><td>${h(x.userDisplayName??"未获取到聊天名")}</td><td>${badge(x.verdict)}</td><td>${badge(x.workflowStatus)}</td><td>${time(x.createdAt)}</td></tr>`})),
      ...feedback.slice(0,5).map((x)=>({createdAt:x.createdAt,html:`<tr data-action="feedback-detail" data-id="${h(x.caseId)}"><td>用户反馈</td><td>${h(x.userDisplayName??"未获取到聊天名")}</td><td>${badge(x.classification)}</td><td>${badge(x.status)}</td><td>${time(x.createdAt)}</td></tr>`})),
    ].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,8).map((item)=>item.html);
  content(
    `<div class="grid metrics">${metric("待处理反馈", pending, "用户主动反馈")}${metric("待人工复查", summary.answerReviews.pendingHuman, "自动复查发现")}${metric("自动复查通过", summary.answerReviews.passed, `共 ${summary.answerReviews.total} 条`)}${metric("复查执行异常", summary.answerReviews.errored, summary.answerReviews.errored ? "需要排查" : "运行正常")}</div><div class="grid two-col"><section class="panel"><div class="panel-head"><h2>反馈分类分布</h2><button class="button small" data-nav="feedback">进入工作台</button></div><div class="panel-body stack">${bars(summary.feedback)}</div></section><section class="panel"><div class="panel-head"><h2>发布状态</h2></div><div class="panel-body stack"><div><span class="muted">当前活动版本</span><div class="mono mt-6">${h(summary.activeReleaseId ?? "尚未发布")}</div></div><div><span class="muted">最近发布</span><div class="mt-6">${releases[0] ? `${badge(releases[0].status)} ${h(releases[0].releaseId)}` : "—"}</div></div><div><span class="muted">后台作业</span><div class="mt-6">${
      jobs
        .slice(0, 3)
        .map((x) => `${badge(x.status)} ${h(x.type)}`)
        .join("<br>") || "—"
    }</div></div></div></section></div><section class="panel mt-16"><div class="panel-head"><h2>最新待办</h2></div>${
      reviews.length || feedback.length
        ? table(
            ["来源", "用户", "结论/类型", "状态", "时间"],
            latestRows,
          )
        : empty("暂无反馈")
    }</section>`,
  );
}
async function renderFeedback() {
  const [values,reviews] = await Promise.all([api.get<FeedbackMeta[]>("/v1/feedback"),api.get<AnswerReviewMeta[]>("/v1/answer-reviews")]);
  const reviewByRequest=new Map(reviews.map((review)=>[review.requestId,review]));
  content(
    `<div class="notice workflow-note"><strong>这里有两种不同信号：</strong>自动复查是系统对每条回答的独立判断；用户反馈是用户通过 /q 表达的体验。两者按同一请求关联，只有人工审核后的答案卡或知识修订才会影响后续回答，反馈不会自动写入知识库。</div><section class="panel mt-16"><div class="panel-head"><div><h2>自动复查</h2><span class="muted">每条知识回答自动进入；默认优先处理未通过和执行异常</span></div></div><div class="toolbar"><select id="review-verdict" class="button" aria-label="按复查结论筛选"><option value="">全部结论</option>${["pending","pass","needs_review","fail"].map((x)=>`<option>${x}</option>`).join("")}</select><span class="muted">共 ${reviews.length} 条</span></div>${reviews.length?table(["论客聊天名","问题摘要","处理状态","复查结论","分数","缺陷","时间"],reviews.map((x)=>`<tr data-action="answer-review-detail" data-id="${h(x.reviewId)}" data-verdict="${h(x.verdict)}"><td>${h(x.userDisplayName??"未获取到聊天名")}</td><td>${h(x.questionPreview)}</td><td>${badge(x.processingStatus)}</td><td>${badge(x.verdict)}</td><td>${h(x.score??"—")}</td><td>${x.defectCount}</td><td>${time(x.createdAt)}</td></tr>`)):empty("尚无自动复查记录")}</section><section class="panel mt-16"><div class="panel-head"><div><h2>用户反馈</h2><span class="muted">用户只表达体验；详情可联查同一回答的自动复查</span></div></div><div class="toolbar"><select id="feedback-status" class="button" aria-label="按状态筛选"><option value="">全部状态</option>${["new", "triaged", "in_review", "resolved", "rejected"].map((x) => `<option>${x}</option>`).join("")}</select><span class="muted">共 ${values.length} 条；原问与原答仅在打开详情时解密</span></div>${
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
                return `<tr data-action="feedback-detail" data-id="${h(x.caseId)}" data-status="${h(x.status)}"><td>${badge(x.classification)}</td><td>${badge(x.status)}</td><td>${linked?badge(linked.verdict):'<span class="muted">未生成</span>'}</td><td>${h(x.answerStatus)}</td><td>${h(x.scope ?? "—")}</td><td>${x.referenceCount}</td><td>${h(x.userDisplayName ?? "未获取到聊天名")}</td><td>${time(x.createdAt)}</td></tr>`;
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

function handleChange(event: Event) {
  const select = event.target;
  if (!(select instanceof HTMLSelectElement)) return;
  if(select.id==="feedback-status"){
    for (const row of document.querySelectorAll<HTMLTableRowElement>('tr[data-action="feedback-detail"]')) row.hidden=select.value!==""&&row.dataset.status!==select.value;
  }
  if(select.id==="review-verdict"){
    for (const row of document.querySelectorAll<HTMLTableRowElement>('tr[data-action="answer-review-detail"]')) row.hidden=select.value!==""&&row.dataset.verdict!==select.value;
  }
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
      ${obligations.length?`<div class="detail-section"><h3>必答项检查</h3>${table(["必答项","覆盖","说明"],obligations.map((x)=>`<tr><td class="mono">${h(x.obligationId)}</td><td>${badge(x.covered?"covered":"missing")}</td><td>${h(x.explanation)}</td></tr>`))}</div>`:""}
      ${defects.length?`<div class="detail-section"><h3>发现的问题</h3>${table(["严重度","分类","问题","依据"],defects.map((x)=>`<tr><td>${badge(x.severity)}</td><td>${h(x.category)}</td><td>${h(x.summary)}</td><td>${h(x.evidence||"—")}</td></tr>`))}</div>`:""}
      <div class="detail-section"><h3>原始问题</h3><div class="content-box">${h(item.question)}</div></div>
      <div class="detail-section"><h3>原始回答</h3><div class="content-box">${h(item.answer)}</div></div>
      <div class="detail-section"><h3>正式引用</h3><pre class="content-box mono">${json(item.references)}</pre></div>
      <div class="detail-section"><h3>答案卡激活摘要</h3><pre class="content-box mono">${json({match:item.answerCardMatch??{},activation:item.answerCardActivation??{}})}</pre></div>
      <form id="answer-review-triage-form" data-id="${h(id)}"><div class="field"><label for="answer-review-workflow-status">人工处理状态</label><select id="answer-review-workflow-status" name="workflowStatus">${["open","in_review","resolved","dismissed"].map((x)=>`<option ${x===item.workflowStatus?"selected":""}>${x}</option>`).join("")}</select><div class="field-help">只有人工确认后再标记 resolved；dismissed 表示确认无需处理。</div></div><button class="button primary" type="submit">保存人工处理状态</button></form>
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
        <div class="field"><label for="feedback-classification">反馈类型</label><select id="feedback-classification" name="classification">${classifications.map((x) => `<option ${x === item.classification ? "selected" : ""}>${x}</option>`).join("")}</select></div>
        <div class="field"><label for="feedback-workflow-status">处理状态</label><select id="feedback-workflow-status" name="status">${["new", "triaged", "in_review", "resolved", "rejected"].map((x) => `<option ${x === item.status ? "selected" : ""}>${x}</option>`).join("")}</select></div>
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
function metric(label: string, value: string | number, note: string) {
  return `<article class="metric"><div class="metric-label">${h(label)}</div><div class="metric-value">${h(value)}<span class="metric-note">${h(note)}</span></div></article>`;
}
function bars(values: Record<string, number>) {
  const entries = Object.entries(values);
  const max = Math.max(1, ...entries.map((x) => x[1]));
  return (
    entries
      .map(
        ([label, value]) =>
          `<div class="bar-row"><span>${h(label)}</span><progress class="bar-progress" max="${max}" value="${value}" aria-label="${h(label)}：${value}"></progress><strong>${value}</strong></div>`,
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
