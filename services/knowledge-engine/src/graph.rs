use std::collections::{BTreeMap, BTreeSet, HashMap};

use regex::Regex;
use serde::Serialize;

use crate::{catalog::Catalog, error::EngineError};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphHit {
    pub path: String,
    pub title: String,
    pub relation: String,
}

#[derive(Debug, Default)]
pub struct KnowledgeGraph {
    titles: HashMap<String, (String, String)>,
    edges: BTreeMap<String, BTreeSet<String>>,
}

impl KnowledgeGraph {
    pub fn build(catalog: &Catalog) -> Self {
        let mut graph = Self::default();
        for page in catalog.pages() {
            let stem = std::path::Path::new(&page.path)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or(&page.title)
                .to_lowercase();
            graph
                .titles
                .insert(stem, (page.path.clone(), page.title.clone()));
            graph.titles.insert(
                page.title.to_lowercase(),
                (page.path.clone(), page.title.clone()),
            );
        }
        let wikilink = Regex::new(r"\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]").expect("valid regex");
        for page in catalog.pages() {
            let mut targets = page
                .related
                .iter()
                .chain(page.sources.iter())
                .map(|value| value.to_lowercase())
                .collect::<Vec<_>>();
            targets.extend(
                wikilink
                    .captures_iter(&page.body)
                    .filter_map(|capture| capture.get(1))
                    .map(|value| value.as_str().trim().to_lowercase()),
            );
            for target in targets {
                if let Some((path, _)) = graph.titles.get(&target) {
                    if path != &page.path {
                        graph
                            .edges
                            .entry(page.path.clone())
                            .or_default()
                            .insert(path.clone());
                        graph
                            .edges
                            .entry(path.clone())
                            .or_default()
                            .insert(page.path.clone());
                    }
                }
            }
        }
        graph
    }

    pub fn neighbors(&self, path: &str, top_k: usize) -> Result<Vec<GraphHit>, EngineError> {
        let Some(paths) = self.edges.get(path) else {
            if self.titles.values().any(|(candidate, _)| candidate == path) {
                return Ok(Vec::new());
            }
            return Err(EngineError::DocumentNotFound);
        };
        Ok(paths
            .iter()
            .take(top_k)
            .filter_map(|path| {
                self.titles
                    .values()
                    .find(|(candidate, _)| candidate == path)
                    .map(|(_, title)| GraphHit {
                        path: path.clone(),
                        title: title.clone(),
                        relation: "related".to_owned(),
                    })
            })
            .collect())
    }
}
