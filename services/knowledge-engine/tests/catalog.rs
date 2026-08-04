use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use knowledge_engine::{catalog::Catalog, project::ProjectKey};

static TEMP_DIRECTORY_NONCE: AtomicU64 = AtomicU64::new(0);

fn fixture() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "pse-catalog-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        TEMP_DIRECTORY_NONCE.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(root.join("wiki/concepts")).unwrap();
    fs::write(root.join("wiki/index.md"), "# 导航中的秘密词").unwrap();
    fs::write(root.join("wiki/overview.md"), "# 概览中的秘密词").unwrap();
    fs::write(root.join("wiki/log.md"), "# 日志中的秘密词").unwrap();
    fs::write(
        root.join("wiki/concepts/ai.md"),
        "---\ntype: query\ntitle: Coremail AI 助手\ntags: [AI]\naliases: [AI 邮件助手]\nquestion_family: ai_assistant\nrelated: []\nsources: []\nreview_status: approved\napplicable_product: Coremail\napplicable_version: [XT6, XT7]\ncard_schema_version: 1\nowner: product-owner\nreview_due: 2026-12-31\n---\n# Coremail AI 助手\n支持多语言翻译。",
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
    let page = catalog.read("wiki/concepts/ai.md").unwrap();
    assert_eq!(page.aliases, ["AI 邮件助手"]);
    assert_eq!(page.question_family, "ai_assistant");
    assert_eq!(page.review_status, "approved");
    assert_eq!(page.applicable_product, ["Coremail"]);
    assert_eq!(page.applicable_version, ["XT6", "XT7"]);
    assert_eq!(page.card_schema_version, Some(1));
    assert_eq!(page.owner, "product-owner");
    assert_eq!(page.review_due, "2026-12-31");
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

#[test]
fn parses_governance_frontmatter_with_windows_line_endings() {
    let root = fixture();
    let page_path = root.join("wiki/concepts/windows.md");
    fs::write(
        &page_path,
        "---\r\ntype: query\r\ntitle: Windows answer card\r\ntags: [windows]\r\naliases: [CRLF alias]\r\nquestion_family: windows_line_endings\r\nreview_status: approved\r\ncard_schema_version: 1\r\nrelated: []\r\nsources: []\r\n---\r\n# Windows answer card\r\nGoverned body",
    )
    .unwrap();

    let catalog = Catalog::load(ProjectKey::CoremailProfessional, &root, "a".repeat(40)).unwrap();
    let page = catalog.read("wiki/concepts/windows.md").unwrap();

    assert_eq!(page.page_type, "query");
    assert_eq!(page.aliases, vec!["CRLF alias"]);
    assert_eq!(page.review_status, "approved");
    assert_eq!(page.card_schema_version, Some(1));
    assert!(page.body.starts_with("# Windows answer card\r\n"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn parses_governance_frontmatter_with_mixed_line_endings() {
    let root = fixture();
    fs::write(
        root.join("wiki/concepts/mixed.md"),
        "---\r\ntype: query\r\ntitle: Mixed answer card\naliases: [mixed alias]\nquestion_family: mixed_line_endings\nreview_status: approved\ncard_schema_version: 1\n---\r\n# Mixed answer card\r\nGoverned body",
    )
    .unwrap();

    let catalog = Catalog::load(ProjectKey::CoremailProfessional, &root, "a".repeat(40)).unwrap();
    let page = catalog.read("wiki/concepts/mixed.md").unwrap();

    assert_eq!(page.page_type, "query");
    assert_eq!(page.aliases, vec!["mixed alias"]);
    assert_eq!(page.review_status, "approved");
    assert_eq!(page.card_schema_version, Some(1));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn malformed_legacy_metadata_degrades_but_governed_cards_fail_closed() {
    let root = fixture();
    fs::write(
        root.join("wiki/concepts/legacy-invalid.md"),
        "---\r\ntype: concept\r\ntitle: invalid: legacy\r\n---\r\n# Legacy page\r\nSearchable body",
    )
    .unwrap();
    let catalog = Catalog::load(ProjectKey::CoremailProfessional, &root, "a".repeat(40)).unwrap();
    let legacy = catalog.read("wiki/concepts/legacy-invalid.md").unwrap();
    assert_eq!(legacy.title, "Legacy page");
    assert_eq!(legacy.review_status, "invalid_metadata");

    fs::write(
        root.join("wiki/concepts/governed-invalid.md"),
        "---\r\ntype: query\r\ntitle: invalid: governed\r\ncard_schema_version: 1\r\n---\r\n# Governed page",
    )
    .unwrap();
    assert!(Catalog::load(ProjectKey::CoremailProfessional, &root, "a".repeat(40)).is_err());
    fs::remove_dir_all(root).unwrap();
}
