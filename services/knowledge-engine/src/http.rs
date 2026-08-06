use std::{path::PathBuf, sync::Arc, time::Duration};

use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tokio::sync::{RwLock, Semaphore};

use crate::{
    bootstrap::bootstrap_project,
    error::EngineError,
    lexical::{SearchFilters, SearchMode},
    project::{ProjectKey, ProjectRegistry},
    service::{
        GraphResponse, KnowledgeService, ProjectContext, ProjectSnapshot, ReadResponse,
        SearchResponse,
    },
};

#[derive(Debug, Clone)]
pub struct HttpState {
    service: Arc<RwLock<KnowledgeService>>,
    token: Arc<str>,
    slots: Arc<Semaphore>,
    reload: Option<Arc<ReloadContext>>,
    deployment: Arc<RwLock<DeploymentState>>,
    timeout: Duration,
}

#[derive(Debug)]
struct ReloadContext {
    registry: ProjectRegistry,
    index_root: PathBuf,
    slot: Arc<Semaphore>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeploymentState {
    status: &'static str,
    serving_previous_version: bool,
    release_id: Option<String>,
    professional_revision: Option<String>,
    general_revision: Option<String>,
    error_code: Option<&'static str>,
}

impl HttpState {
    pub fn new(service: KnowledgeService, token: impl Into<String>) -> Result<Self, EngineError> {
        let token = token.into();
        if token.trim().is_empty() {
            return Err(EngineError::InvalidConfiguration);
        }
        Ok(Self {
            service: Arc::new(RwLock::new(service)),
            token: Arc::from(token),
            slots: Arc::new(Semaphore::new(8)),
            reload: None,
            deployment: Arc::new(RwLock::new(DeploymentState::ready())),
            timeout: Duration::from_secs(30),
        })
    }

    pub fn new_reloadable(
        service: KnowledgeService,
        token: impl Into<String>,
        registry: ProjectRegistry,
        index_root: PathBuf,
    ) -> Result<Self, EngineError> {
        let mut state = Self::new(service, token)?;
        state.reload = Some(Arc::new(ReloadContext {
            registry,
            index_root,
            slot: Arc::new(Semaphore::new(1)),
        }));
        Ok(state)
    }
}

impl DeploymentState {
    fn ready() -> Self {
        Self {
            status: "ready",
            serving_previous_version: false,
            release_id: None,
            professional_revision: None,
            general_revision: None,
            error_code: None,
        }
    }

    fn reloading(input: &ReloadInput) -> Self {
        Self {
            status: "reloading",
            serving_previous_version: true,
            release_id: Some(input.release_id.clone()),
            professional_revision: Some(input.professional_revision.clone()),
            general_revision: Some(input.general_revision.clone()),
            error_code: None,
        }
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReloadInput {
    release_id: String,
    professional_revision: String,
    general_revision: String,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    projects: Vec<ProjectSnapshot>,
    deployment: DeploymentState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReloadResponse {
    release_id: String,
    previous_projects: Vec<ProjectSnapshot>,
    projects: Vec<ProjectSnapshot>,
    old_version_served_during_reload: bool,
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
        .route("/reload", axum::routing::post(reload))
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
    let service = state.service.read().await.clone();
    Ok(Json(HealthResponse {
        status: "ready",
        projects: service.snapshots().map_err(ApiError)?,
        deployment: state.deployment.read().await.clone(),
    }))
}

async fn reload(
    State(state): State<HttpState>,
    Json(input): Json<ReloadInput>,
) -> Result<Json<ReloadResponse>, ApiError> {
    validate_reload_input(&input).map_err(ApiError)?;
    let context = state
        .reload
        .clone()
        .ok_or(ApiError(EngineError::InvalidConfiguration))?;
    let permit = context
        .slot
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError(EngineError::RateLimited))?;
    *state.deployment.write().await = DeploymentState::reloading(&input);
    let registry = context.registry.clone();
    let index_root = context.index_root.clone();
    let build_input = input.clone();
    let task = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let professional = bootstrap_project(
            &registry,
            ProjectKey::CoremailProfessional,
            &build_input.professional_revision,
            &index_root,
        )?;
        let general = bootstrap_project(
            &registry,
            ProjectKey::PresalesGeneral,
            &build_input.general_revision,
            &index_root,
        )?;
        KnowledgeService::new([
            (ProjectKey::CoremailProfessional, professional),
            (ProjectKey::PresalesGeneral, general),
        ])
    });
    let next = match tokio::time::timeout(Duration::from_secs(900), task).await {
        Ok(Ok(Ok(service))) => service,
        Ok(Ok(Err(error))) => {
            mark_reload_failed(&state, &input, error.code()).await;
            return Err(ApiError(error));
        }
        Ok(Err(_)) | Err(_) => {
            mark_reload_failed(&state, &input, EngineError::RuntimeUnavailable.code()).await;
            return Err(ApiError(EngineError::RuntimeUnavailable));
        }
    };
    let previous_projects = state.service.read().await.snapshots().map_err(ApiError)?;
    let projects = next.snapshots().map_err(ApiError)?;
    *state.service.write().await = next;
    *state.deployment.write().await = DeploymentState {
        status: "ready",
        serving_previous_version: false,
        release_id: Some(input.release_id.clone()),
        professional_revision: Some(input.professional_revision.clone()),
        general_revision: Some(input.general_revision.clone()),
        error_code: None,
    };
    Ok(Json(ReloadResponse {
        release_id: input.release_id,
        previous_projects,
        projects,
        old_version_served_during_reload: true,
    }))
}

async fn mark_reload_failed(state: &HttpState, input: &ReloadInput, code: &'static str) {
    *state.deployment.write().await = DeploymentState {
        status: "failed",
        serving_previous_version: true,
        release_id: Some(input.release_id.clone()),
        professional_revision: Some(input.professional_revision.clone()),
        general_revision: Some(input.general_revision.clone()),
        error_code: Some(code),
    };
}

fn validate_reload_input(input: &ReloadInput) -> Result<(), EngineError> {
    let release_valid = input.release_id.starts_with("KR-")
        && input.release_id.len() <= 64
        && input
            .release_id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || value == b'-');
    if !release_valid
        || !valid_revision(&input.professional_revision)
        || !valid_revision(&input.general_revision)
    {
        return Err(EngineError::InvalidRevision);
    }
    Ok(())
}

fn valid_revision(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
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
    let service = state.service.read().await.clone();
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
