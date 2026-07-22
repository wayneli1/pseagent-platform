use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use knowledge_engine::{catalog::Catalog, graph::KnowledgeGraph, project::ProjectKey};

fn fixture() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "pse-graph-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(root.join("wiki/concepts")).unwrap();
    fs::write(
        root.join("wiki/concepts/assistant.md"),
        "---\ntype: concept\ntitle: AI 助手\ntags: []\nrelated: [翻译能力]\nsources: []\n---\n# AI 助手\n参见 [[翻译能力]]。",
    )
    .unwrap();
    fs::write(
        root.join("wiki/concepts/translation.md"),
        "---\ntype: concept\ntitle: 翻译能力\ntags: []\nrelated: []\nsources: []\n---\n# 翻译能力",
    )
    .unwrap();
    root
}

#[test]
fn returns_deterministic_one_hop_neighbors() {
    let root = fixture();
    let catalog = Catalog::load(ProjectKey::CoremailProfessional, &root, "a".repeat(40)).unwrap();
    let graph = KnowledgeGraph::build(&catalog);
    let hits = graph.neighbors("wiki/concepts/assistant.md", 5).unwrap();

    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "wiki/concepts/translation.md");
    fs::remove_dir_all(root).unwrap();
}
