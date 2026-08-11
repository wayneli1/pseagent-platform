use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use knowledge_engine::{
    catalog::Catalog,
    lexical::{LexicalIndex, SearchFilters, SearchMode},
    project::ProjectKey,
};

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
    write_typed_page(root, name, "concept", title, body);
}

fn write_typed_page(
    root: &Path,
    name: &str,
    page_type: &str,
    title: &str,
    body: &str,
) {
    fs::write(
        root.join("wiki/concepts").join(name),
        format!(
            "---\ntype: {page_type}\ntitle: {title}\ntags: []\nrelated: []\nsources: []\n---\n# {title}\n{body}"
        ),
    )
    .unwrap();
}

fn write_governed_page(
    root: &Path,
    name: &str,
    page_type: &str,
    title: &str,
    aliases: &str,
    review_status: &str,
    card_schema_version: Option<u32>,
) {
    let card_schema = card_schema_version
        .map(|version| format!("card_schema_version: {version}\n"))
        .unwrap_or_default();
    fs::write(
        root.join("wiki/concepts").join(name),
        format!(
            "---\ntype: {page_type}\ntitle: {title}\ntags: [POC]\naliases: [{aliases}]\nquestion_family: poc_scope\nreview_status: {review_status}\napplicable_product: Coremail\napplicable_version: ['*']\n{card_schema}related: []\nsources: []\n---\n# {title}\nPOC 范围治理正文。"
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
fn distinctive_latin_terms_in_the_title_outrank_body_only_mentions() {
    let root = fixture();
    write_page(
        &root,
        "air-outlook-comparison.md",
        "Coremail Air 与 Outlook 功能对比",
        "对比邮件、日历、通讯录和文件能力。",
    );
    for index in 1..=4 {
        write_page(
            &root,
            &format!("air-overview-{index}.md"),
            &format!("Coremail Air 客户端功能总览 {index}"),
            "本文介绍 Air 客户端功能，正文附带 Outlook 调研背景。Air 客户端功能覆盖邮件和日历。",
        );
    }
    let catalog = Catalog::load(ProjectKey::CoremailProfessional, &root, "a".repeat(40)).unwrap();
    let hits = LexicalIndex::build(&catalog)
        .search("Coremail Air 客户端和 Outlook 的功能差异", 10);

    assert_eq!(hits[0].path, "wiki/concepts/air-outlook-comparison.md");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn explicit_comparison_intent_prefers_a_direct_comparison_page() {
    let root = fixture();
    write_typed_page(
        &root,
        "archive-versions.md",
        "comparison",
        "归档版本对比",
        "对比独立版、高级版、基础版和归档 2020 的边界。",
    );
    write_page(
        &root,
        "archive-entity.md",
        "邮件归档系统",
        "邮件归档不同版本包含很多功能。邮件归档版本功能边界需要区分，本文反复说明邮件归档系统。",
    );
    write_typed_page(
        &root,
        "unrelated-comparison.md",
        "comparison",
        "客户端功能版本边界对比",
        "不同客户端功能版本需要区分，但与归档主题无关。",
    );
    let catalog = Catalog::load(ProjectKey::CoremailProfessional, &root, "a".repeat(40)).unwrap();
    assert_eq!(
        catalog
            .read("wiki/concepts/archive-versions.md")
            .unwrap()
            .page_type,
        "comparison"
    );
    let hits = LexicalIndex::build(&catalog)
        .search("邮件归档不同版本的功能边界如何区分", 10);

    assert_eq!(hits[0].path, "wiki/concepts/archive-versions.md");
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

#[test]
fn governed_fields_rank_and_filter_answer_cards_without_hiding_legacy_pages() {
    let root = fixture();
    let query = "POC未采购功能是否测试";
    write_governed_page(
        &root,
        "alias-card.md",
        "query",
        "POC范围控制",
        query,
        "approved",
        Some(1),
    );
    write_governed_page(
        &root,
        "title-card.md",
        "query",
        query,
        "其他问法",
        "approved",
        Some(1),
    );
    write_governed_page(
        &root,
        "draft-card.md",
        "query",
        "未批准答案卡",
        query,
        "draft",
        Some(1),
    );
    write_governed_page(
        &root,
        "legacy-query.md",
        "query",
        "历史 Query 页面",
        "历史 POC 问法",
        "pending",
        None,
    );
    write_governed_page(
        &root,
        "ordinary.md",
        "concept",
        query,
        "普通概念别名",
        "pending",
        None,
    );
    let catalog = Catalog::load(ProjectKey::CoremailProfessional, &root, "a".repeat(40)).unwrap();
    let index = LexicalIndex::build(&catalog);

    let hybrid = index.search(query, 10);
    assert_eq!(hybrid[0].path, "wiki/concepts/alias-card.md");
    assert!(
        hybrid
            .iter()
            .position(|hit| hit.path.ends_with("title-card.md"))
            < hybrid
                .iter()
                .position(|hit| hit.path.ends_with("ordinary.md"))
    );
    assert!(!hybrid.iter().any(|hit| hit.path.ends_with("draft-card.md")));
    assert!(index
        .search("历史 POC 问法", 10)
        .iter()
        .any(|hit| hit.path.ends_with("legacy-query.md")));

    let answer_cards = index.search_with_filters(
        query,
        10,
        &SearchFilters {
            mode: SearchMode::AnswerCards,
            ..SearchFilters::default()
        },
    );
    assert_eq!(answer_cards.len(), 2);
    assert!(answer_cards
        .iter()
        .all(|hit| hit.path.ends_with("-card.md")));
    let standard = index.search_with_filters(
        query,
        10,
        &SearchFilters {
            mode: SearchMode::Standard,
            ..SearchFilters::default()
        },
    );
    assert!(standard.iter().all(|hit| !hit.path.ends_with("-card.md")));
    fs::remove_dir_all(root).unwrap();
}
