use std::path::PathBuf;

use knowledge_engine::{
    catalog::Catalog,
    project::ProjectKey,
    service::{KnowledgeService, ProjectIndexes},
};

#[test]
fn fixed_professional_snapshot_recalls_multi_part_evidence_pages() {
    let Some(professional_root) = configured_root("PSE_REAL_PROFESSIONAL_ROOT") else {
        return;
    };
    let Some(general_root) = configured_root("PSE_REAL_GENERAL_ROOT") else {
        return;
    };
    let revision = "a".repeat(40);
    let service = KnowledgeService::new([
        (
            ProjectKey::CoremailProfessional,
            ProjectIndexes::new(
                Catalog::load(
                    ProjectKey::CoremailProfessional,
                    professional_root,
                    revision.clone(),
                )
                .unwrap(),
                "# professional".to_owned(),
            ),
        ),
        (
            ProjectKey::PresalesGeneral,
            ProjectIndexes::new(
                Catalog::load(ProjectKey::PresalesGeneral, general_root, revision).unwrap(),
                "# general".to_owned(),
            ),
        ),
    ])
    .unwrap();

    for (query, expected_title) in [
        ("网关POC测试要点", "网关POC测试要点"),
        ("安全网关 POC 注意事项", "网关POC测试要点"),
        ("安全网关 POC 售前口径 要点", "安全网关信创POC售前口径要点"),
        ("Domino 迁移环境搭建", "Domino迁移环境搭建"),
        ("Domino 迁移特殊注意事项", "Domino迁移特殊注意事项"),
        ("镜像系统同步机制", "镜像系统同步机制"),
        ("邮件系统多活与容灾设计", "邮件系统多活与容灾设计"),
    ] {
        let result = service
            .search(ProjectKey::CoremailProfessional, query, 10)
            .unwrap();
        assert!(
            result
                .hits
                .iter()
                .any(|hit| compact_title(&hit.title) == compact_title(expected_title)),
            "query {query:?} did not recall {expected_title:?}; got {:?}",
            result
                .hits
                .iter()
                .map(|hit| hit.title.as_str())
                .collect::<Vec<_>>()
        );
    }
}

fn configured_root(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

fn compact_title(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>()
        .to_lowercase()
}
