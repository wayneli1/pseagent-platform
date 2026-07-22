use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use knowledge_engine::{catalog::Catalog, project::ProjectKey};

fn fixture() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "pse-catalog-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(root.join("wiki/concepts")).unwrap();
    fs::write(root.join("wiki/index.md"), "# 导航中的秘密词").unwrap();
    fs::write(root.join("wiki/overview.md"), "# 概览中的秘密词").unwrap();
    fs::write(root.join("wiki/log.md"), "# 日志中的秘密词").unwrap();
    fs::write(
        root.join("wiki/concepts/ai.md"),
        "---\ntype: concept\ntitle: Coremail AI 助手\ntags: [AI]\nrelated: []\nsources: []\n---\n# Coremail AI 助手\n支持多语言翻译。",
    )
    .unwrap();
    root
}

#[test]
fn excludes_all_navigation_pages_but_loads_normal_pages() {
    let root = fixture();
    let catalog = Catalog::load(ProjectKey::CoremailProfessional, &root, "a".repeat(40)).unwrap();

    assert_eq!(catalog.len(), 1);
    assert_eq!(
        catalog.read("wiki/concepts/ai.md").unwrap().title,
        "Coremail AI 助手"
    );
    assert!(catalog.read("wiki/index.md").is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn rejects_path_traversal() {
    let root = fixture();
    let catalog = Catalog::load(ProjectKey::CoremailProfessional, &root, "a".repeat(40)).unwrap();
    assert!(catalog.read("../purpose.md").is_err());
    fs::remove_dir_all(root).unwrap();
}
