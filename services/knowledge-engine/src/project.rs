use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    process::Command,
};

use serde::{Deserialize, Serialize};

use crate::error::EngineError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectKey {
    CoremailProfessional,
    PresalesGeneral,
}

impl ProjectKey {
    pub const ALL: [Self; 2] = [Self::CoremailProfessional, Self::PresalesGeneral];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CoremailProfessional => "coremail-professional",
            Self::PresalesGeneral => "presales-general",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectConfig {
    root_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct ProjectRegistry {
    roots: HashMap<ProjectKey, PathBuf>,
}

impl ProjectRegistry {
    pub fn from_json(path: impl AsRef<Path>) -> Result<Self, EngineError> {
        let bytes = std::fs::read(path).map_err(|_| EngineError::InvalidConfiguration)?;
        let raw: HashMap<String, ProjectConfig> =
            serde_json::from_slice(&bytes).map_err(|_| EngineError::InvalidConfiguration)?;
        if raw.len() != ProjectKey::ALL.len() {
            return Err(EngineError::InvalidConfiguration);
        }
        let mut roots = HashMap::new();
        for key in ProjectKey::ALL {
            let config = raw
                .get(key.as_str())
                .ok_or(EngineError::InvalidConfiguration)?;
            if !config.root_path.is_absolute() || !config.root_path.is_dir() {
                return Err(EngineError::InvalidConfiguration);
            }
            let root = std::fs::canonicalize(&config.root_path)
                .map_err(|_| EngineError::InvalidConfiguration)?;
            roots.insert(key, root);
        }
        Ok(Self { roots })
    }

    pub fn root(&self, project: ProjectKey) -> Result<&Path, EngineError> {
        self.roots
            .get(&project)
            .map(PathBuf::as_path)
            .ok_or(EngineError::InvalidProject)
    }

    pub fn head_revision(&self, project: ProjectKey) -> Result<String, EngineError> {
        let root = self.root(project)?;
        let knowledge_status = run_git(
            root,
            &[
                "status",
                "--porcelain=v1",
                "--untracked-files=normal",
                "--",
                "wiki",
                "purpose.md",
                "schema.md",
            ],
        )?;
        if !knowledge_status.is_empty() {
            return Err(EngineError::InvalidRevision);
        }
        let revision = run_git(root, &["rev-parse", "HEAD"])?;
        if revision.len() != 40 || !revision.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(EngineError::InvalidRevision);
        }
        Ok(revision)
    }
}

pub fn canonical_relative_path(path: &str) -> Result<String, EngineError> {
    if path.is_empty() || path.contains('\\') || Path::new(path).is_absolute() {
        return Err(EngineError::InvalidRelativePath);
    }
    let parsed = Path::new(path);
    if parsed
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(EngineError::InvalidRelativePath);
    }
    let normalized = parsed
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    if !normalized.starts_with("wiki/") || !normalized.ends_with(".md") {
        return Err(EngineError::InvalidRelativePath);
    }
    Ok(normalized)
}

fn run_git(root: &Path, args: &[&str]) -> Result<String, EngineError> {
    let output = Command::new("git")
        .arg("-c")
        .arg(format!("safe.directory={}", root.display()))
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|_| EngineError::InvalidRevision)?;
    if !output.status.success() {
        return Err(EngineError::InvalidRevision);
    }
    String::from_utf8(output.stdout)
        .map(|value| value.trim().to_owned())
        .map_err(|_| EngineError::InvalidRevision)
}
