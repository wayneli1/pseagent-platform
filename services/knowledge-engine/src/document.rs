use std::{path::Path, sync::Arc};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{error::EngineError, project::ProjectKey};

const MAX_DOCUMENT_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiPage {
    pub project: ProjectKey,
    pub path: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub tags: Vec<String>,
    pub related: Vec<String>,
    pub sources: Vec<String>,
    pub body: String,
    pub content_hash: String,
}

#[derive(Debug, Default, Deserialize)]
struct Frontmatter {
    #[serde(rename = "type", default)]
    page_type: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    related: Vec<String>,
    #[serde(default)]
    sources: Vec<String>,
}

pub fn load_page(
    project: ProjectKey,
    root: &Path,
    relative: &str,
) -> Result<Arc<WikiPage>, EngineError> {
    let full_path = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
    let metadata = std::fs::metadata(&full_path).map_err(|_| EngineError::DocumentNotFound)?;
    if !metadata.is_file() {
        return Err(EngineError::DocumentNotFound);
    }
    if metadata.len() > MAX_DOCUMENT_BYTES {
        return Err(EngineError::DocumentTooLarge);
    }
    let bytes = std::fs::read(&full_path).map_err(|_| EngineError::DocumentNotFound)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| EngineError::InvalidDocument)?;
    let (frontmatter, body) = parse_frontmatter(text)?;
    let fallback_title = body
        .lines()
        .find_map(|line| line.strip_prefix("# ").map(str::trim))
        .filter(|value| !value.is_empty())
        .or_else(|| {
            Path::new(relative)
                .file_stem()
                .and_then(|value| value.to_str())
        })
        .unwrap_or("Untitled")
        .to_owned();
    let content_hash = format!("{:x}", Sha256::digest(&bytes));
    Ok(Arc::new(WikiPage {
        project,
        path: relative.to_owned(),
        title: if frontmatter.title.trim().is_empty() {
            fallback_title
        } else {
            frontmatter.title
        },
        page_type: frontmatter.page_type,
        tags: frontmatter.tags,
        related: frontmatter.related,
        sources: frontmatter.sources,
        body: body.to_owned(),
        content_hash,
    }))
}

pub fn is_navigation_path(relative: &str) -> bool {
    let name = relative
        .rsplit_once('/')
        .map_or(relative, |(_parent, name)| name)
        .to_ascii_lowercase();
    matches!(name.as_str(), "index.md" | "overview.md" | "log.md")
}

fn parse_frontmatter(text: &str) -> Result<(Frontmatter, &str), EngineError> {
    let Some(rest) = text.strip_prefix("---\n") else {
        return Ok((Frontmatter::default(), text));
    };
    let Some(end) = rest.find("\n---\n") else {
        return Err(EngineError::InvalidDocument);
    };
    let frontmatter =
        serde_yaml_ng::from_str(&rest[..end]).map_err(|_| EngineError::InvalidDocument)?;
    Ok((frontmatter, &rest[end + 5..]))
}
