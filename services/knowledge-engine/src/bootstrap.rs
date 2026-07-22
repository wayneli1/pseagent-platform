use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::{
    catalog::Catalog,
    error::EngineError,
    project::{ProjectKey, ProjectRegistry},
    service::ProjectIndexes,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexManifest {
    project: ProjectKey,
    revision: String,
    pages: BTreeMap<String, String>,
}

pub fn bootstrap_project(
    registry: &ProjectRegistry,
    project: ProjectKey,
    expected_revision: &str,
    index_root: &Path,
) -> Result<ProjectIndexes, EngineError> {
    bootstrap_project_with_hook(registry, project, expected_revision, index_root, || {})
}

fn bootstrap_project_with_hook<F>(
    registry: &ProjectRegistry,
    project: ProjectKey,
    expected_revision: &str,
    index_root: &Path,
    after_first_head: F,
) -> Result<ProjectIndexes, EngineError>
where
    F: FnOnce(),
{
    let first_revision = registry.head_revision(project)?;
    if expected_revision != first_revision {
        return Err(EngineError::InvalidRevision);
    }
    let root = registry.root(project)?;
    let catalog = Catalog::load(project, root, first_revision.clone())?;
    let schema = load_schema(root)?;
    after_first_head();
    let second_revision = registry.head_revision(project)?;
    if first_revision != second_revision {
        return Err(EngineError::InvalidRevision);
    }
    let manifest = IndexManifest {
        project,
        revision: first_revision,
        pages: catalog
            .pages()
            .map(|page| (page.path.clone(), page.content_hash.clone()))
            .collect(),
    };
    persist_manifest(index_root, &manifest)?;
    Ok(ProjectIndexes::new(catalog, schema))
}

fn load_schema(root: &Path) -> Result<String, EngineError> {
    let path = root.join("schema.md");
    let metadata = std::fs::metadata(&path).map_err(|_| EngineError::CatalogUnavailable)?;
    if !metadata.is_file() || metadata.len() > 256 * 1024 {
        return Err(EngineError::InvalidDocument);
    }
    std::fs::read_to_string(path).map_err(|_| EngineError::InvalidDocument)
}

fn persist_manifest(index_root: &Path, manifest: &IndexManifest) -> Result<(), EngineError> {
    std::fs::create_dir_all(index_root).map_err(|_| EngineError::IndexUnavailable)?;
    let path = manifest_path(index_root, manifest.project);
    if let Ok(bytes) = std::fs::read(&path) {
        if serde_json::from_slice::<IndexManifest>(&bytes)
            .ok()
            .as_ref()
            == Some(manifest)
        {
            return Ok(());
        }
    }
    let temporary = path.with_extension(format!("json.tmp-{}", std::process::id()));
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|_| EngineError::IndexUnavailable)?;
    std::fs::write(&temporary, bytes).map_err(|_| EngineError::IndexUnavailable)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|_| EngineError::IndexUnavailable)?;
    }
    std::fs::rename(&temporary, &path).map_err(|_| EngineError::IndexUnavailable)
}

fn manifest_path(root: &Path, project: ProjectKey) -> PathBuf {
    root.join(format!("{}.json", project.as_str()))
}

#[cfg(test)]
mod tests {
    use super::{bootstrap_project, bootstrap_project_with_hook, load_schema, manifest_path};
    use crate::project::{ProjectKey, ProjectRegistry};
    use std::{
        fs,
        path::{Path, PathBuf},
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct Fixture {
        root: PathBuf,
        professional: PathBuf,
        config: PathBuf,
        indexes: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = temporary("pse-bootstrap");
            let professional = root.join("professional");
            let general = root.join("general");
            for project in [&professional, &general] {
                fs::create_dir_all(project.join("wiki")).unwrap();
                fs::write(project.join("purpose.md"), "# Purpose").unwrap();
                fs::write(project.join("schema.md"), "# Schema").unwrap();
                fs::write(project.join("wiki/overview.md"), "# Overview").unwrap();
                initialize_git(project);
            }
            let config = root.join("projects.json");
            fs::write(
                &config,
                serde_json::to_vec(&serde_json::json!({
                    "coremail-professional": { "rootPath": professional },
                    "presales-general": { "rootPath": general },
                }))
                .unwrap(),
            )
            .unwrap();
            let indexes = root.join("indexes");
            Self {
                root,
                professional,
                config,
                indexes,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn rejects_an_oversized_schema() {
        let root = temporary("pse-schema");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("schema.md"), vec![b'x'; 256 * 1024 + 1]).unwrap();
        assert!(load_schema(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_expected_revision_mismatch() {
        let fixture = Fixture::new();
        let registry = ProjectRegistry::from_json(&fixture.config).unwrap();
        let error = bootstrap_project(
            &registry,
            ProjectKey::CoremailProfessional,
            &"b".repeat(40),
            &fixture.indexes,
        )
        .unwrap_err();
        assert_eq!(error.code(), "invalid_revision");
    }

    #[test]
    fn bootstraps_a_healthy_empty_project_and_reuses_matching_manifest() {
        let fixture = Fixture::new();
        let registry = ProjectRegistry::from_json(&fixture.config).unwrap();
        let revision = registry
            .head_revision(ProjectKey::CoremailProfessional)
            .unwrap();
        bootstrap_project(
            &registry,
            ProjectKey::CoremailProfessional,
            &revision,
            &fixture.indexes,
        )
        .unwrap();
        let path = manifest_path(&fixture.indexes, ProjectKey::CoremailProfessional);
        let bytes = fs::read(&path).unwrap();
        let manifest: super::IndexManifest = serde_json::from_slice(&bytes).unwrap();
        assert!(manifest.pages.is_empty());
        bootstrap_project(
            &registry,
            ProjectKey::CoremailProfessional,
            &revision,
            &fixture.indexes,
        )
        .unwrap();
        assert_eq!(fs::read(path).unwrap(), bytes);
    }

    #[test]
    fn second_revision_check_rejects_a_startup_race() {
        let fixture = Fixture::new();
        let registry = ProjectRegistry::from_json(&fixture.config).unwrap();
        let revision = registry
            .head_revision(ProjectKey::CoremailProfessional)
            .unwrap();
        let target = fixture.professional.join("wiki/overview.md");
        let error = bootstrap_project_with_hook(
            &registry,
            ProjectKey::CoremailProfessional,
            &revision,
            &fixture.indexes,
            || fs::write(target, "# Changed").unwrap(),
        )
        .unwrap_err();
        assert_eq!(error.code(), "invalid_revision");
    }

    fn temporary(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn initialize_git(root: &Path) {
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "tests@example.invalid"],
            vec!["config", "user.name", "Tests"],
            vec!["add", "wiki", "purpose.md", "schema.md"],
            vec!["commit", "-q", "-m", "fixture"],
        ] {
            assert!(Command::new("git")
                .current_dir(root)
                .args(args)
                .status()
                .unwrap()
                .success());
        }
    }
}
