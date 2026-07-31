use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::EngineError;

const MAX_REQUIRED_CONTEXT_BYTES: u64 = 256 * 1024;
const MAX_OVERVIEW_BYTES: u64 = 1024 * 1024;
const MAX_PLANNING_OVERVIEW_CHARS: usize = 12_000;
pub const PLANNING_OVERVIEW_RENDERER_VERSION: &str = "planning-overview-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanningOverviewStatus {
    Ready,
    Missing,
    Truncated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanningOverviewMeta {
    pub status: PlanningOverviewStatus,
    pub content_hash: String,
    pub renderer_version: &'static str,
    pub original_chars: usize,
    pub exposed_chars: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanningContext {
    pub purpose: String,
    pub schema: String,
    pub planning_overview: String,
    pub planning_overview_meta: PlanningOverviewMeta,
}

pub fn load_planning_context(root: &Path) -> Result<PlanningContext, EngineError> {
    let purpose = load_required_text(&root.join("purpose.md"))?;
    let schema = load_required_text(&root.join("schema.md"))?;
    let (planning_overview, planning_overview_meta) =
        load_planning_overview(&root.join("wiki").join("overview.md"))?;
    Ok(PlanningContext {
        purpose,
        schema,
        planning_overview,
        planning_overview_meta,
    })
}

fn load_required_text(path: &Path) -> Result<String, EngineError> {
    let metadata = std::fs::metadata(path).map_err(|_| EngineError::CatalogUnavailable)?;
    if !metadata.is_file() || metadata.len() > MAX_REQUIRED_CONTEXT_BYTES {
        return Err(EngineError::InvalidDocument);
    }
    std::fs::read_to_string(path).map_err(|_| EngineError::InvalidDocument)
}

fn load_planning_overview(path: &Path) -> Result<(String, PlanningOverviewMeta), EngineError> {
    let raw = match std::fs::metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.len() > MAX_OVERVIEW_BYTES {
                return Err(EngineError::InvalidDocument);
            }
            std::fs::read_to_string(path).map_err(|_| EngineError::InvalidDocument)?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((
                String::new(),
                PlanningOverviewMeta {
                    status: PlanningOverviewStatus::Missing,
                    content_hash: sha256_hex(b""),
                    renderer_version: PLANNING_OVERVIEW_RENDERER_VERSION,
                    original_chars: 0,
                    exposed_chars: 0,
                    truncated: false,
                },
            ));
        }
        Err(_) => return Err(EngineError::CatalogUnavailable),
    };
    render_planning_overview(&raw)
}

fn render_planning_overview(raw: &str) -> Result<(String, PlanningOverviewMeta), EngineError> {
    let raw_without_bom = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let body = strip_yaml_frontmatter(raw_without_bom)?;
    let body = body.trim_start_matches(['\r', '\n']);
    let original_chars = body.chars().count();
    let planning_overview = body
        .chars()
        .take(MAX_PLANNING_OVERVIEW_CHARS)
        .collect::<String>();
    let exposed_chars = planning_overview.chars().count();
    let truncated = exposed_chars < original_chars;
    Ok((
        planning_overview,
        PlanningOverviewMeta {
            status: if truncated {
                PlanningOverviewStatus::Truncated
            } else {
                PlanningOverviewStatus::Ready
            },
            content_hash: sha256_hex(raw.as_bytes()),
            renderer_version: PLANNING_OVERVIEW_RENDERER_VERSION,
            original_chars,
            exposed_chars,
            truncated,
        },
    ))
}

fn strip_yaml_frontmatter(raw: &str) -> Result<&str, EngineError> {
    let mut lines = raw.split_inclusive('\n');
    let Some(first) = lines.next() else {
        return Ok(raw);
    };
    if trim_line_ending(first) != "---" {
        return Ok(raw);
    }

    let mut consumed = first.len();
    for line in lines {
        consumed += line.len();
        if trim_line_ending(line) == "---" {
            return Ok(&raw[consumed..]);
        }
    }
    Err(EngineError::InvalidDocument)
}

fn trim_line_ending(line: &str) -> &str {
    line.trim_end_matches(['\r', '\n'])
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::{
        load_planning_context, render_planning_overview, PlanningOverviewStatus,
        MAX_PLANNING_OVERVIEW_CHARS, PLANNING_OVERVIEW_RENDERER_VERSION,
    };
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temporary(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("{name}-{}-{nonce}", std::process::id()))
    }

    #[test]
    fn strips_frontmatter_and_preserves_unicode_body() {
        let raw = "---\r\ntype: overview\r\ntitle: 概览\r\n---\r\n\r\n# 知识地图\r\n正文";
        let (overview, meta) = render_planning_overview(raw).unwrap();
        assert_eq!(overview, "# 知识地图\r\n正文");
        assert_eq!(meta.status, PlanningOverviewStatus::Ready);
        assert_eq!(meta.original_chars, overview.chars().count());
        assert_eq!(meta.exposed_chars, overview.chars().count());
        assert!(!meta.truncated);
        assert_eq!(meta.renderer_version, PLANNING_OVERVIEW_RENDERER_VERSION);
        assert_eq!(meta.content_hash.len(), 64);
    }

    #[test]
    fn keeps_plain_markdown_without_frontmatter() {
        let (overview, meta) = render_planning_overview("# Overview\nBody").unwrap();
        assert_eq!(overview, "# Overview\nBody");
        assert_eq!(meta.status, PlanningOverviewStatus::Ready);
    }

    #[test]
    fn rejects_unclosed_frontmatter() {
        assert!(render_planning_overview("---\ntype: overview\n# Body").is_err());
    }

    #[test]
    fn degrades_to_empty_navigation_when_overview_is_missing() {
        let root = temporary("pse-planning-overview-missing");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("purpose.md"), "# Purpose").unwrap();
        fs::write(root.join("schema.md"), "# Schema").unwrap();

        let context = load_planning_context(&root).unwrap();

        assert!(context.planning_overview.is_empty());
        assert_eq!(
            context.planning_overview_meta.status,
            PlanningOverviewStatus::Missing
        );
        assert_eq!(context.planning_overview_meta.original_chars, 0);
        assert_eq!(context.planning_overview_meta.exposed_chars, 0);
        assert!(!context.planning_overview_meta.truncated);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn truncates_by_unicode_characters() {
        let raw = "中".repeat(MAX_PLANNING_OVERVIEW_CHARS + 3);
        let (overview, meta) = render_planning_overview(&raw).unwrap();
        assert_eq!(overview.chars().count(), MAX_PLANNING_OVERVIEW_CHARS);
        assert_eq!(meta.original_chars, MAX_PLANNING_OVERVIEW_CHARS + 3);
        assert_eq!(meta.status, PlanningOverviewStatus::Truncated);
        assert!(meta.truncated);
    }
}
