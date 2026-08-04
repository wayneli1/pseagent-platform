use std::{path::Path, sync::Arc};

use serde::{Deserialize, Deserializer, Serialize};
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
    pub aliases: Vec<String>,
    pub question_family: String,
    pub review_status: String,
    pub applicable_product: Vec<String>,
    pub applicable_version: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card_schema_version: Option<u32>,
    pub owner: String,
    pub review_due: String,
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
    #[serde(default, deserialize_with = "deserialize_string_list")]
    aliases: Vec<String>,
    #[serde(default)]
    question_family: String,
    #[serde(default)]
    review_status: String,
    #[serde(default, deserialize_with = "deserialize_string_list")]
    applicable_product: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_string_list")]
    applicable_version: Vec<String>,
    #[serde(default)]
    card_schema_version: Option<u32>,
    #[serde(default)]
    owner: String,
    #[serde(default)]
    review_due: String,
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
        aliases: frontmatter.aliases,
        question_family: frontmatter.question_family,
        review_status: frontmatter.review_status,
        applicable_product: frontmatter.applicable_product,
        applicable_version: frontmatter.applicable_version,
        card_schema_version: frontmatter.card_schema_version,
        owner: frontmatter.owner,
        review_due: frontmatter.review_due,
        related: frontmatter.related,
        sources: frontmatter.sources,
        body: body.to_owned(),
        content_hash,
    }))
}

#[derive(Deserialize)]
#[serde(untagged)]
enum StringOrList {
    One(String),
    Many(Vec<String>),
}

fn deserialize_string_list<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match Option::<StringOrList>::deserialize(deserializer)? {
        None => Vec::new(),
        Some(StringOrList::One(value)) => vec![value],
        Some(StringOrList::Many(values)) => values,
    })
}

pub fn is_navigation_path(relative: &str) -> bool {
    let name = relative
        .rsplit_once('/')
        .map_or(relative, |(_parent, name)| name)
        .to_ascii_lowercase();
    matches!(name.as_str(), "index.md" | "overview.md" | "log.md")
}

fn parse_frontmatter(text: &str) -> Result<(Frontmatter, &str), EngineError> {
    let Some(rest) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    else {
        return Ok((Frontmatter::default(), text));
    };
    let Some((end, closing_length)) = ["\r\n---\r\n", "\r\n---\n", "\n---\r\n", "\n---\n"]
        .into_iter()
        .filter_map(|closing| rest.find(closing).map(|end| (end, closing.len())))
        .min_by_key(|(end, _)| *end)
    else {
        return Err(EngineError::InvalidDocument);
    };
    let source = &rest[..end];
    let frontmatter = match serde_yaml_ng::from_str(source) {
        Ok(frontmatter) => frontmatter,
        Err(_) if !declares_governed_answer_card(source) => Frontmatter {
            review_status: "invalid_metadata".to_owned(),
            ..Frontmatter::default()
        },
        Err(_) => return Err(EngineError::InvalidDocument),
    };
    Ok((frontmatter, &rest[end + closing_length..]))
}

fn declares_governed_answer_card(frontmatter: &str) -> bool {
    frontmatter.lines().any(|line| {
        line.trim_start()
            .strip_prefix("card_schema_version:")
            .is_some()
    })
}
