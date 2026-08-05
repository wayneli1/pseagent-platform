use std::{env, net::SocketAddr, path::PathBuf};

use knowledge_engine::{
    bootstrap::bootstrap_project,
    error::EngineError,
    http::{router, HttpState},
    project::{ProjectKey, ProjectRegistry},
    service::KnowledgeService,
};

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{}", error.code());
        std::process::exit(1);
    }
}

async fn run() -> Result<(), EngineError> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "knowledge_engine=info".into()),
        )
        .with_target(false)
        .init();
    let config = required_path("KNOWLEDGE_PROJECTS_CONFIG")?;
    let index_root = required_path("KNOWLEDGE_INDEX_ROOT")?;
    let professional_revision = required("COREMAIL_PROFESSIONAL_REVISION")?;
    let general_revision = required("PRESALES_GENERAL_REVISION")?;
    let token = required("KNOWLEDGE_ENGINE_TOKEN")?;
    let registry = ProjectRegistry::from_json(config)?;
    let professional = bootstrap_project(
        &registry,
        ProjectKey::CoremailProfessional,
        &professional_revision,
        &index_root,
    )?;
    let general = bootstrap_project(
        &registry,
        ProjectKey::PresalesGeneral,
        &general_revision,
        &index_root,
    )?;
    let service = KnowledgeService::new([
        (ProjectKey::CoremailProfessional, professional),
        (ProjectKey::PresalesGeneral, general),
    ])?;
    let state = HttpState::new(service, token)?;
    let port = optional_port("KNOWLEDGE_ENGINE_PORT", 19_829)?;
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|_| EngineError::ListenerUnavailable)?;
    tracing::info!(address = %address, "knowledge engine ready");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|_| EngineError::RuntimeUnavailable)
}

fn required(name: &str) -> Result<String, EngineError> {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or(EngineError::InvalidConfiguration)
}

fn required_path(name: &str) -> Result<PathBuf, EngineError> {
    let path = PathBuf::from(required(name)?);
    if !path.is_absolute() {
        return Err(EngineError::InvalidConfiguration);
    }
    Ok(path)
}

fn optional_port(name: &str, default: u16) -> Result<u16, EngineError> {
    match env::var(name) {
        Ok(value) => parse_port(Some(&value), default),
        Err(_) => Ok(default),
    }
}

fn parse_port(value: Option<&str>, default: u16) -> Result<u16, EngineError> {
    match value {
        Some(value) => value
            .parse::<u16>()
            .ok()
            .filter(|port| *port > 0)
            .ok_or(EngineError::InvalidConfiguration),
        None => Ok(default),
    }
}

async fn shutdown_signal() {
    let control_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(windows)]
    let terminate = async {
        if let Ok(mut signal) = tokio::signal::windows::ctrl_close() {
            signal.recv().await;
        }
    };
    #[cfg(not(windows))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = control_c => {},
        () = terminate => {},
    }
}

#[cfg(test)]
mod tests {
    use super::parse_port;

    #[test]
    fn port_uses_default_when_unset() {
        assert_eq!(parse_port(None, 19_829).expect("default port"), 19_829);
    }

    #[test]
    fn port_accepts_valid_override() {
        assert_eq!(parse_port(Some("19839"), 19_829).expect("port"), 19_839);
    }

    #[test]
    fn port_rejects_zero_or_invalid_values() {
        assert!(parse_port(Some("0"), 19_829).is_err());
        assert!(parse_port(Some("invalid"), 19_829).is_err());
    }
}
