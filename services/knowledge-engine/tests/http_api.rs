use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
};
use knowledge_engine::{
    catalog::Catalog,
    http::{router, HttpState},
    project::ProjectKey,
    service::{KnowledgeService, ProjectIndexes},
};
use tower::ServiceExt;

fn project(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "pse-http-{name}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(root.join("wiki/concepts")).unwrap();
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
                "# Schema".to_owned(),
            ),
        ),
        (
            ProjectKey::PresalesGeneral,
            ProjectIndexes::new(
                Catalog::load(ProjectKey::PresalesGeneral, &general, revision).unwrap(),
                "# Schema".to_owned(),
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
            Some(r#"{"project":"coremail-professional","query":"AI","topK":5}"#),
        )
        .await,
        200
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
