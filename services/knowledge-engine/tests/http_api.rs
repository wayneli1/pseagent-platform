use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
};
use http_body_util::BodyExt;
use knowledge_engine::{
    catalog::Catalog,
    http::{router, HttpState},
    planning_context::load_planning_context,
    project::{ProjectKey, ProjectRegistry},
    service::{KnowledgeService, ProjectIndexes},
};
use std::process::Command;
use tower::ServiceExt;

static TEMP_DIRECTORY_NONCE: AtomicU64 = AtomicU64::new(0);

fn project(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "pse-http-{name}-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        TEMP_DIRECTORY_NONCE.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(root.join("wiki/concepts")).unwrap();
    fs::write(root.join("purpose.md"), "# Purpose").unwrap();
    fs::write(root.join("schema.md"), "# Schema").unwrap();
    fs::write(root.join("wiki/overview.md"), "# Overview").unwrap();
    fs::write(
        root.join("wiki/concepts/page.md"),
        "---\ntype: concept\ntitle: Page\ntags: []\nrelated: []\nsources: []\n---\n# Page\nCoremail AI",
    )
    .unwrap();
    root
}

fn fixture_router() -> (axum::Router, Vec<PathBuf>) {
    let professional = project("professional");
    let general = project("general");
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
    (
        router(HttpState::new(service, "secret-token").unwrap()),
        vec![professional, general],
    )
}

async fn request(app: &axum::Router, method: Method, path: &str, body: Option<&str>) -> StatusCode {
    let mut builder = Request::builder().method(method).uri(path);
    if path != "/health" {
        builder = builder
            .header(header::AUTHORIZATION, "Bearer secret-token")
            .header(header::CONTENT_TYPE, "application/json");
    }
    app.clone()
        .oneshot(
            builder
                .body(Body::from(body.unwrap_or_default().to_owned()))
                .unwrap(),
        )
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn exposes_only_health_context_search_read_and_graph() {
    let (app, roots) = fixture_router();
    assert_eq!(request(&app, Method::GET, "/health", None).await, 200);
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/v1/context",
            Some(r#"{"project":"coremail-professional"}"#),
        )
        .await,
        200
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/v1/search",
            Some(r#"{"project":"coremail-professional","query":"AI","topK":20}"#),
        )
        .await,
        200
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/v1/search",
            Some(r#"{"project":"coremail-professional","query":"AI","topK":21}"#),
        )
        .await,
        400
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/v1/search",
            Some(r#"{"project":"coremail-professional","query":"AI","topK":20,"pageType":"query","reviewStatus":"approved","searchMode":"answer_cards"}"#),
        )
        .await,
        200
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/v1/search",
            Some(
                r#"{"project":"coremail-professional","query":"AI","topK":20,"pageType":"unknown"}"#
            ),
        )
        .await,
        400
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/v1/read",
            Some(r#"{"project":"coremail-professional","path":"wiki/concepts/page.md"}"#),
        )
        .await,
        200
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/v1/graph",
            Some(r#"{"project":"coremail-professional","path":"wiki/concepts/page.md","topK":5}"#),
        )
        .await,
        200
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/v1/query",
            Some(r#"{"project":"coremail-professional","query":"AI","topK":5}"#),
        )
        .await,
        404
    );
    for root in roots {
        fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn rejects_missing_or_wrong_bearer_token() {
    let (app, roots) = fixture_router();
    let response = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/v1/context")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"project":"coremail-professional"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    for root in roots {
        fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn atomically_reloads_both_projects_and_keeps_the_previous_version_on_failure() {
    let professional = project("reload-professional");
    let general = project("reload-general");
    for root in [&professional, &general] {
        git(root, &["init", "-b", "main"]);
        git(root, &["config", "user.email", "test@example.com"]);
        git(root, &["config", "user.name", "Test"]);
        git(root, &["add", "."]);
        git(root, &["commit", "-m", "initial"]);
    }
    let initial_professional = git(&professional, &["rev-parse", "HEAD"]);
    let general_revision = git(&general, &["rev-parse", "HEAD"]);
    let configuration = professional.parent().unwrap().join(format!(
        "projects-{}.json",
        TEMP_DIRECTORY_NONCE.fetch_add(1, Ordering::Relaxed)
    ));
    let indexes = professional.parent().unwrap().join(format!(
        "indexes-{}",
        TEMP_DIRECTORY_NONCE.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(
        &configuration,
        serde_json::to_vec(&serde_json::json!({
            "coremail-professional":{"rootPath":professional},
            "presales-general":{"rootPath":general}
        }))
        .unwrap(),
    )
    .unwrap();
    let registry = ProjectRegistry::from_json(&configuration).unwrap();
    let service = KnowledgeService::new([
        (
            ProjectKey::CoremailProfessional,
            ProjectIndexes::new(
                Catalog::load(
                    ProjectKey::CoremailProfessional,
                    &professional,
                    initial_professional.clone(),
                )
                .unwrap(),
                load_planning_context(&professional).unwrap(),
            ),
        ),
        (
            ProjectKey::PresalesGeneral,
            ProjectIndexes::new(
                Catalog::load(
                    ProjectKey::PresalesGeneral,
                    &general,
                    general_revision.clone(),
                )
                .unwrap(),
                load_planning_context(&general).unwrap(),
            ),
        ),
    ])
    .unwrap();
    let app = router(
        HttpState::new_reloadable(service, "secret-token", registry, indexes.clone()).unwrap(),
    );
    fs::write(
        professional.join("wiki/concepts/page.md"),
        "---\ntype: concept\ntitle: Page\ntags: []\nrelated: []\nsources: []\n---\n# Page\nCoremail AI hot reload",
    )
    .unwrap();
    git(&professional, &["add", "."]);
    git(&professional, &["commit", "-m", "update"]);
    let professional_revision = git(&professional, &["rev-parse", "HEAD"]);
    git(
        &professional,
        &["checkout", "--detach", &initial_professional],
    );
    let body = serde_json::json!({
        "releaseId":"KR-2026-08-RELOAD",
        "professionalRevision":professional_revision,
        "generalRevision":general_revision
    })
    .to_string();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/v1/reload")
                .header(header::AUTHORIZATION, "Bearer secret-token")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let payload: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(payload["oldVersionServedDuringReload"], true);
    assert_eq!(
        git(&professional, &["rev-parse", "HEAD"]),
        professional_revision
    );
    let failed = serde_json::json!({
        "releaseId":"KR-2026-08-BAD",
        "professionalRevision":initial_professional,
        "generalRevision":"f".repeat(40)
    })
    .to_string();
    assert_ne!(
        request(&app, Method::POST, "/v1/reload", Some(&failed)).await,
        StatusCode::OK
    );
    let health = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let payload: serde_json::Value =
        serde_json::from_slice(&health.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(payload["projects"][0]["revision"], professional_revision);
    assert_eq!(payload["deployment"]["servingPreviousVersion"], true);
    assert_eq!(
        git(&professional, &["rev-parse", "HEAD"]),
        professional_revision
    );
    for root in [professional, general, indexes, configuration] {
        if root.exists() {
            if root.is_dir() {
                fs::remove_dir_all(root).unwrap();
            } else {
                fs::remove_file(root).unwrap();
            }
        }
    }
}

fn git(root: &std::path::Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-c")
        .arg(format!("safe.directory={}", root.display()))
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}
