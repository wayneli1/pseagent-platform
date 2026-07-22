use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use knowledge_engine::project::{ProjectKey, ProjectRegistry};

struct Fixture {
    root: PathBuf,
    professional: PathBuf,
    general: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "pse-projects-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let professional = root.join("professional");
        let general = root.join("general");
        for project in [&professional, &general] {
            fs::create_dir_all(project.join("wiki")).unwrap();
            fs::write(project.join("wiki/index.md"), "# Index").unwrap();
        }
        fs::write(professional.join("purpose.md"), "# Professional purpose").unwrap();
        fs::write(professional.join("schema.md"), "# Professional schema").unwrap();
        fs::write(general.join("purpose.md"), "# General purpose").unwrap();
        fs::write(general.join("schema.md"), "# General schema").unwrap();
        initialize_git_repository(&professional);
        initialize_git_repository(&general);
        Self {
            root,
            professional,
            general,
        }
    }

    fn config_path(&self) -> PathBuf {
        let path = self.root.join("projects.json");
        let value = serde_json::json!({
            "coremail-professional": { "rootPath": self.professional },
            "presales-general": { "rootPath": self.general },
        });
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn git(root: &Path, args: &[&str]) {
    let status = Command::new("git")
        .current_dir(root)
        .args(args)
        .status()
        .unwrap();
    assert!(status.success());
}

fn initialize_git_repository(root: &Path) {
    git(root, &["init", "-q"]);
    git(root, &["config", "user.email", "tests@example.invalid"]);
    git(root, &["config", "user.name", "Tests"]);
    git(root, &["add", "wiki", "purpose.md", "schema.md"]);
    git(root, &["commit", "-q", "-m", "fixture"]);
}

#[test]
fn resolves_clean_fixed_revisions() {
    let fixture = Fixture::new();
    let registry = ProjectRegistry::from_json(fixture.config_path()).unwrap();
    assert_eq!(
        registry
            .head_revision(ProjectKey::CoremailProfessional)
            .unwrap()
            .len(),
        40
    );
}

#[test]
fn rejects_a_dirty_schema_even_when_wiki_is_clean() {
    let fixture = Fixture::new();
    fs::write(fixture.professional.join("schema.md"), "changed schema").unwrap();

    let registry = ProjectRegistry::from_json(fixture.config_path()).expect("valid registry");
    let error = registry
        .head_revision(ProjectKey::CoremailProfessional)
        .expect_err("dirty schema must invalidate a revision");

    assert_eq!(error.code(), "invalid_revision");
}

#[test]
fn rejects_a_dirty_purpose_or_untracked_wiki_page() {
    let fixture = Fixture::new();
    let registry = ProjectRegistry::from_json(fixture.config_path()).unwrap();
    fs::write(fixture.general.join("purpose.md"), "changed purpose").unwrap();
    assert_eq!(
        registry
            .head_revision(ProjectKey::PresalesGeneral)
            .unwrap_err()
            .code(),
        "invalid_revision"
    );
}
