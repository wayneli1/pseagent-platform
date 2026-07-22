use thiserror::Error;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("catalog changed")]
    CatalogChanged,
    #[error("catalog unavailable")]
    CatalogUnavailable,
    #[error("document not found")]
    DocumentNotFound,
    #[error("document too large")]
    DocumentTooLarge,
    #[error("invalid configuration")]
    InvalidConfiguration,
    #[error("index unavailable")]
    IndexUnavailable,
    #[error("invalid document")]
    InvalidDocument,
    #[error("invalid project")]
    InvalidProject,
    #[error("invalid query")]
    InvalidQuery,
    #[error("invalid relative path")]
    InvalidRelativePath,
    #[error("invalid revision")]
    InvalidRevision,
    #[error("rate limited")]
    RateLimited,
    #[error("project unavailable")]
    ProjectUnavailable,
    #[error("listener unavailable")]
    ListenerUnavailable,
    #[error("runtime unavailable")]
    RuntimeUnavailable,
    #[error("unauthorized")]
    Unauthorized,
}

impl EngineError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::CatalogChanged => "catalog_changed",
            Self::CatalogUnavailable => "catalog_unavailable",
            Self::DocumentNotFound => "document_not_found",
            Self::DocumentTooLarge => "document_too_large",
            Self::InvalidConfiguration => "invalid_configuration",
            Self::IndexUnavailable => "index_unavailable",
            Self::InvalidDocument => "invalid_document",
            Self::InvalidProject => "invalid_project",
            Self::InvalidQuery => "invalid_query",
            Self::InvalidRelativePath => "invalid_relative_path",
            Self::InvalidRevision => "invalid_revision",
            Self::RateLimited => "rate_limited",
            Self::ProjectUnavailable => "project_unavailable",
            Self::ListenerUnavailable => "listener_unavailable",
            Self::RuntimeUnavailable => "runtime_unavailable",
            Self::Unauthorized => "unauthorized",
        }
    }
}
