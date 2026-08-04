use std::{sync::Arc, time::Duration};

use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tokio::sync::Semaphore;

use crate::{
    error::EngineError,
    lexical::{SearchFilters, SearchMode},
    project::ProjectKey,
    service::{GraphResponse, KnowledgeService, ProjectContext, ReadResponse, SearchResponse},
};

#[derive(Debug, Clone)]
pub struct HttpState {
    service: KnowledgeService,
    token: Arc<str>,
    slots: Arc<Semaphore>,
    timeout: Duration,
}

impl HttpState {
    pub fn new(service: KnowledgeService, token: impl Into<String>) -> Result<Self, EngineError> {
        let token = token.into();
        if token.trim().is_empty() {
            return Err(EngineError::InvalidConfiguration);
        }
        Ok(Self {
            service,
            token: Arc::from(token),
            slots: Arc::new(Semaphore::new(8)),
            timeout: Duration::from_secs(30),
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContextInput {
    project: ProjectKey,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchInput {
    project: ProjectKey,
    query: String,
    top_k: usize,
    #[serde(default)]
    page_type: Option<String>,
    #[serde(default)]
    review_status: Option<String>,
    #[serde(default)]
    search_mode: SearchMode,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadInput {
    project: ProjectKey,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GraphInput {
    project: ProjectKey,
    path: String,
    top_k: usize,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    projects: Vec<crate::service::ProjectSnapshot>,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: &'static str,
}

pub fn router(state: HttpState) -> axum::Router {
    let protected = axum::Router::new()
        .route("/context", axum::routing::post(context))
        .route("/search", axum::routing::post(search))
        .route("/read", axum::routing::post(read))
        .route("/graph", axum::routing::post(graph))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_auth,
        ));

    axum::Router::new()
        .route("/health", axum::routing::get(health))
        .nest("/v1", protected)
        .layer(axum::extract::DefaultBodyLimit::max(1024 * 1024))
        .with_state(state)
}

async fn health(State(state): State<HttpState>) -> Result<Json<HealthResponse>, ApiError> {
    Ok(Json(HealthResponse {
        status: "ready",
        projects: state.service.snapshots().map_err(ApiError)?,
    }))
}

async fn context(
    State(state): State<HttpState>,
    Json(input): Json<ContextInput>,
) -> Result<Json<ProjectContext>, ApiError> {
    run_bounded(state, move |service| service.context(input.project))
        .await
        .map(Json)
        .map_err(ApiError)
}

async fn search(
    State(state): State<HttpState>,
    Json(input): Json<SearchInput>,
) -> Result<Json<SearchResponse>, ApiError> {
    run_bounded(state, move |service| {
        service.search_with_filters(
            input.project,
            &input.query,
            input.top_k,
            &SearchFilters {
                page_type: input.page_type,
                review_status: input.review_status,
                mode: input.search_mode,
            },
        )
    })
    .await
    .map(Json)
    .map_err(ApiError)
}

async fn read(
    State(state): State<HttpState>,
    Json(input): Json<ReadInput>,
) -> Result<Json<ReadResponse>, ApiError> {
    run_bounded(state, move |service| {
        service.read(input.project, &input.path)
    })
    .await
    .map(Json)
    .map_err(ApiError)
}

async fn graph(
    State(state): State<HttpState>,
    Json(input): Json<GraphInput>,
) -> Result<Json<GraphResponse>, ApiError> {
    run_bounded(state, move |service| {
        service.graph(input.project, &input.path, input.top_k)
    })
    .await
    .map(Json)
    .map_err(ApiError)
}

async fn run_bounded<T, F>(state: HttpState, operation: F) -> Result<T, EngineError>
where
    T: Send + 'static,
    F: FnOnce(KnowledgeService) -> Result<T, EngineError> + Send + 'static,
{
    let permit = state
        .slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| EngineError::RateLimited)?;
    let service = state.service.clone();
    let task = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        operation(service)
    });
    match tokio::time::timeout(state.timeout, task).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) | Err(_) => Err(EngineError::RuntimeUnavailable),
    }
}

async fn require_auth(State(state): State<HttpState>, request: Request, next: Next) -> Response {
    let expected = state.token.as_bytes();
    let supplied = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::as_bytes);
    let authorized = supplied
        .filter(|value| value.len() == expected.len())
        .is_some_and(|value| value.ct_eq(expected).into());
    if !authorized {
        return ApiError(EngineError::Unauthorized).into_response();
    }
    next.run(request).await
}

struct ApiError(EngineError);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self.0 {
            EngineError::Unauthorized => StatusCode::UNAUTHORIZED,
            EngineError::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            EngineError::DocumentNotFound => StatusCode::NOT_FOUND,
            EngineError::InvalidProject
            | EngineError::InvalidQuery
            | EngineError::InvalidRelativePath => StatusCode::BAD_REQUEST,
            _ => StatusCode::SERVICE_UNAVAILABLE,
        };
        (
            status,
            Json(ErrorBody {
                code: self.0.code(),
            }),
        )
            .into_response()
    }
}
