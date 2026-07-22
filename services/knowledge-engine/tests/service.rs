use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use knowledge_engine::{
    catalog::Catalog,
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
        "# 专业 schema".to_owned(),
    );
    let general_indexes = ProjectIndexes::new(
        Catalog::load(ProjectKey::PresalesGeneral, &general, revision).unwrap(),
        "# 通用 schema".to_owned(),
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
fn project_context_returns_schema_and_overview_from_same_revision() {
    let (service, professional, general) = service(None);
    let context = service.context(ProjectKey::CoremailProfessional).unwrap();

    assert!(context.schema.contains("专业"));
    assert!(context.overview.contains("概览"));
    assert!(!context.revision.is_empty());
    fs::remove_dir_all(professional).unwrap();
    fs::remove_dir_all(general).unwrap();
}
