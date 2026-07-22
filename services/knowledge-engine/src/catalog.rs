use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use walkdir::WalkDir;

use crate::{
    document::{is_navigation_path, load_page, WikiPage},
    error::EngineError,
    project::{canonical_relative_path, ProjectKey},
};

#[derive(Debug)]
pub struct Catalog {
    project: ProjectKey,
    root: PathBuf,
    revision: String,
    pages: BTreeMap<String, Arc<WikiPage>>,
}

impl Catalog {
    pub fn load(
        project: ProjectKey,
        root: impl AsRef<Path>,
        revision: impl Into<String>,
    ) -> Result<Self, EngineError> {
        let root = std::fs::canonicalize(root).map_err(|_| EngineError::CatalogUnavailable)?;
        let wiki = root.join("wiki");
        if !wiki.is_dir() {
            return Err(EngineError::CatalogUnavailable);
        }
        let mut pages = BTreeMap::new();
        for entry in WalkDir::new(&wiki).follow_links(false) {
            let entry = entry.map_err(|_| EngineError::CatalogUnavailable)?;
            if !entry.file_type().is_file()
                || entry.path().extension().and_then(|value| value.to_str()) != Some("md")
            {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(&root)
                .map_err(|_| EngineError::InvalidRelativePath)?
                .to_string_lossy()
                .replace('\\', "/");
            if is_navigation_path(&relative) {
                continue;
            }
            let relative = canonical_relative_path(&relative)?;
            let page = load_page(project, &root, &relative)?;
            pages.insert(relative, page);
        }
        Ok(Self {
            project,
            root,
            revision: revision.into(),
            pages,
        })
    }

    pub fn project(&self) -> ProjectKey {
        self.project
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn revision(&self) -> &str {
        &self.revision
    }

    pub fn len(&self) -> usize {
        self.pages.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pages.is_empty()
    }

    pub fn pages(&self) -> impl Iterator<Item = &Arc<WikiPage>> {
        self.pages.values()
    }

    pub fn read(&self, path: &str) -> Result<Arc<WikiPage>, EngineError> {
        let path = canonical_relative_path(path)?;
        self.pages
            .get(&path)
            .cloned()
            .ok_or(EngineError::DocumentNotFound)
    }
}
