use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use knowledge_engine::{catalog::Catalog, lexical::LexicalIndex, project::ProjectKey};

fn fixture() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "pse-lexical-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(root.join("wiki/concepts")).unwrap();
    fs::write(root.join("wiki/index.md"), "# AI 助手新功能").unwrap();
    fs::write(root.join("wiki/overview.md"), "# AI 助手新功能").unwrap();
    fs::write(root.join("wiki/log.md"), "# AI 助手新功能").unwrap();
    fs::write(
        root.join("wiki/concepts/coremail-ai助手.md"),
        "---\ntype: concept\ntitle: Coremail AI 助手\ntags: [AI]\nrelated: []\nsources: []\n---\n# Coremail AI 助手\n支持邮件总结和多语言翻译。",
    )
    .unwrap();
    root
}

fn write_page(root: &Path, name: &str, title: &str, body: &str) {
    fs::write(
        root.join("wiki/concepts").join(name),
        format!(
            "---\ntype: concept\ntitle: {title}\ntags: []\nrelated: []\nsources: []\n---\n# {title}\n{body}"
        ),
    )
    .unwrap();
}

#[test]
fn chinese_filename_and_title_match_rank_the_expected_page() {
    let root = fixture();
    let catalog = Catalog::load(ProjectKey::CoremailProfessional, &root, "a".repeat(40)).unwrap();
    let index = LexicalIndex::build(&catalog);
    let hits = index.search("Coremail AI 助手 多语言翻译", 5);

    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "wiki/concepts/coremail-ai助手.md");
    assert!(hits[0].matched_terms.iter().any(|term| term == "翻译"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn navigation_pages_never_produce_search_hits() {
    let root = fixture();
    let catalog = Catalog::load(ProjectKey::CoremailProfessional, &root, "a".repeat(40)).unwrap();
    let hits = LexicalIndex::build(&catalog).search("导航日志", 10);
    assert!(hits.is_empty());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn exact_gateway_poc_page_outranks_pages_sharing_generic_characters() {
    let root = fixture();
    write_page(
        &root,
        "gateway-poc.md",
        "网关POC测试要点",
        "包含邮件安全网关样本测试、评分和生产流量验证注意事项。",
    );
    write_page(
        &root,
        "xt6-features.md",
        "XT6 产品新功能清单",
        "这是邮件系统功能清单，与安全网关测试无关。",
    );
    let catalog = Catalog::load(ProjectKey::CoremailProfessional, &root, "a".repeat(40)).unwrap();
    let hits = LexicalIndex::build(&catalog).search("网关 POC 测试要点", 10);

    assert_eq!(hits[0].title, "网关POC测试要点");
    assert!(
        hits.iter().position(|hit| hit.title == "网关POC测试要点")
            < hits
                .iter()
                .position(|hit| hit.title == "XT6 产品新功能清单")
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn multi_character_queries_do_not_report_single_cjk_matches() {
    let root = fixture();
    write_page(&root, "unrelated.md", "网页管理", "功能清单");
    let catalog = Catalog::load(ProjectKey::CoremailProfessional, &root, "a".repeat(40)).unwrap();
    let hits = LexicalIndex::build(&catalog).search("网关 POC", 10);

    for hit in hits {
        assert!(hit
            .matched_terms
            .iter()
            .all(|term| term.chars().count() > 1));
    }
    fs::remove_dir_all(root).unwrap();
}
