use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use knowledge_engine::{
    catalog::Catalog,
    lexical::{SearchFilters, SearchMode},
    planning_context::load_planning_context,
    project::ProjectKey,
    service::{KnowledgeService, ProjectIndexes},
};

fn root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "pse-service-{name}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(root.join("wiki/concepts")).unwrap();
    fs::write(root.join("schema.md"), format!("# {name} 专业规范")).unwrap();
    fs::write(root.join("purpose.md"), format!("# {name} 知识库目标")).unwrap();
    fs::write(root.join("wiki/overview.md"), format!("# {name} 概览")).unwrap();
    root
}

fn service(professional_page: Option<(&str, &str)>) -> (KnowledgeService, PathBuf, PathBuf) {
    let professional = root("professional");
    let general = root("general");
    if let Some((path, body)) = professional_page {
        let full = professional.join(path.replace('/', std::path::MAIN_SEPARATOR_STR));
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(
            full,
            format!(
                "---\ntype: concept\ntitle: Coremail AI 助手\ntags: [AI]\nrelated: []\nsources: []\n---\n{body}"
            ),
        )
        .unwrap();
    }
    let revision = "a".repeat(40);
    let professional_indexes = ProjectIndexes::new(
        Catalog::load(
            ProjectKey::CoremailProfessional,
            &professional,
            revision.clone(),
        )
        .unwrap(),
        load_planning_context(&professional).unwrap(),
    );
    let general_indexes = ProjectIndexes::new(
        Catalog::load(ProjectKey::PresalesGeneral, &general, revision).unwrap(),
        load_planning_context(&general).unwrap(),
    );
    (
        KnowledgeService::new([
            (ProjectKey::CoremailProfessional, professional_indexes),
            (ProjectKey::PresalesGeneral, general_indexes),
        ])
        .unwrap(),
        professional,
        general,
    )
}

#[test]
fn healthy_navigation_only_project_returns_an_empty_search() {
    let (service, professional, general) = service(None);
    let result = service
        .search(ProjectKey::PresalesGeneral, "需求访谈", 5)
        .unwrap();

    assert_eq!(result.project, ProjectKey::PresalesGeneral);
    assert!(!result.revision.is_empty());
    assert!(result.hits.is_empty());
    fs::remove_dir_all(professional).unwrap();
    fs::remove_dir_all(general).unwrap();
}

#[test]
fn search_hit_contains_a_bounded_snippet_and_revision() {
    let (service, professional, general) = service(Some((
        "wiki/concepts/coremail-ai助手.md",
        "Coremail AI 助手支持邮件总结和多语言翻译。",
    )));
    let result = service
        .search(ProjectKey::CoremailProfessional, "AI 助手 翻译", 5)
        .unwrap();

    assert_eq!(result.hits.len(), 1);
    assert!(result.hits[0].snippet.contains("多语言翻译"));
    assert!(result.hits[0].snippet.chars().count() <= 500);
    fs::remove_dir_all(professional).unwrap();
    fs::remove_dir_all(general).unwrap();
}

#[test]
fn project_context_returns_snapshot_fixed_planning_context() {
    let (service, professional, general) = service(None);
    let context = service.context(ProjectKey::CoremailProfessional).unwrap();

    assert!(context.schema.contains("专业"));
    assert!(context.purpose.contains("知识库目标"));
    assert!(context.planning_overview.contains("概览"));
    assert_eq!(
        context.planning_overview_meta.status,
        knowledge_engine::planning_context::PlanningOverviewStatus::Ready
    );
    assert!(!context.revision.is_empty());

    fs::write(
        professional.join("wiki/overview.md"),
        "# 运行期间不应进入当前快照",
    )
    .unwrap();
    let unchanged = service.context(ProjectKey::CoremailProfessional).unwrap();
    assert_eq!(unchanged.planning_overview, context.planning_overview);
    fs::remove_dir_all(professional).unwrap();
    fs::remove_dir_all(general).unwrap();
}

#[test]
fn search_reserves_a_candidate_for_one_hop_graph_context() {
    let professional = root("professional-graph");
    let general = root("general-graph");
    fs::write(
        professional.join("wiki/concepts/gateway.md"),
        "---\ntype: concept\ntitle: 安全网关\ntags: []\nrelated: [网关POC测试要点]\nsources: []\n---\n# 安全网关\n安全网关功能。",
    )
    .unwrap();
    fs::write(
        professional.join("wiki/concepts/gateway-poc.md"),
        "---\ntype: concept\ntitle: 网关POC测试要点\ntags: []\nrelated: []\nsources: []\n---\n# 网关POC测试要点\n样本准备和评分要求。",
    )
    .unwrap();
    let revision = "a".repeat(40);
    let service = KnowledgeService::new([
        (
            ProjectKey::CoremailProfessional,
            ProjectIndexes::new(
                Catalog::load(
                    ProjectKey::CoremailProfessional,
                    &professional,
                    revision.clone(),
                )
                .unwrap(),
                load_planning_context(&professional).unwrap(),
            ),
        ),
        (
            ProjectKey::PresalesGeneral,
            ProjectIndexes::new(
                Catalog::load(ProjectKey::PresalesGeneral, &general, revision).unwrap(),
                load_planning_context(&general).unwrap(),
            ),
        ),
    ])
    .unwrap();

    let result = service
        .search(ProjectKey::CoremailProfessional, "安全网关功能", 5)
        .unwrap();
    assert!(result.hits.iter().any(|hit| hit.title == "网关POC测试要点"));
    fs::remove_dir_all(professional).unwrap();
    fs::remove_dir_all(general).unwrap();
}

#[test]
fn governed_search_filters_are_enforced_at_the_service_boundary() {
    let professional = root("professional-governed-search");
    let general = root("general-governed-search");
    fs::create_dir_all(professional.join("wiki/queries")).unwrap();
    fs::write(
        professional.join("wiki/queries/mail-assistant.md"),
        "---\ntype: query\ntitle: Mail assistant support\ntags: [mail, assistant]\naliases: [What can Mail Assistant do?]\nquestion_family: mail assistant capabilities\nreview_status: approved\napplicable_product: [Coremail]\napplicable_version: ['*']\ncard_schema_version: 1\nowner: product-ops\nreview_due: 2026-12-31\nrelated: []\nsources: [wiki/concepts/mail-assistant.md]\n---\nApproved governed answer.",
    )
    .unwrap();
    fs::write(
        professional.join("wiki/queries/mail-assistant-draft.md"),
        "---\ntype: query\ntitle: Mail assistant draft\ntags: [mail, assistant]\naliases: [What can Mail Assistant do?]\nquestion_family: mail assistant capabilities\nreview_status: draft\ncard_schema_version: 1\nrelated: []\nsources: []\n---\nDraft governed answer.",
    )
    .unwrap();
    let revision = "a".repeat(40);
    let service = KnowledgeService::new([
        (
            ProjectKey::CoremailProfessional,
            ProjectIndexes::new(
                Catalog::load(
                    ProjectKey::CoremailProfessional,
                    &professional,
                    revision.clone(),
                )
                .unwrap(),
                load_planning_context(&professional).unwrap(),
            ),
        ),
        (
            ProjectKey::PresalesGeneral,
            ProjectIndexes::new(
                Catalog::load(ProjectKey::PresalesGeneral, &general, revision).unwrap(),
                load_planning_context(&general).unwrap(),
            ),
        ),
    ])
    .unwrap();
    let filters = SearchFilters {
        page_type: Some("query".to_owned()),
        review_status: Some("approved".to_owned()),
        mode: SearchMode::AnswerCards,
    };

    let result = service
        .search_with_filters(
            ProjectKey::CoremailProfessional,
            "What can Mail Assistant do?",
            5,
            &filters,
        )
        .unwrap();

    assert_eq!(result.hits.len(), 1);
    assert_eq!(result.hits[0].path, "wiki/queries/mail-assistant.md");
    assert_eq!(result.hits[0].page_type, "query");
    assert_eq!(result.hits[0].review_status, "approved");

    let invalid = SearchFilters {
        page_type: Some("unknown".to_owned()),
        ..SearchFilters::default()
    };
    assert!(service
        .search_with_filters(
            ProjectKey::CoremailProfessional,
            "Mail assistant",
            5,
            &invalid,
        )
        .is_err());
    fs::remove_dir_all(professional).unwrap();
    fs::remove_dir_all(general).unwrap();
}
