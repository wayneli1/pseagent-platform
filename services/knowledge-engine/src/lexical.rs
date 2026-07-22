use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::{catalog::Catalog, tokenize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    pub score: f32,
    pub matched_terms: Vec<String>,
}

#[derive(Debug)]
struct IndexedPage {
    path: String,
    title: String,
    normalized_title: String,
    normalized_body: String,
    tokens: BTreeSet<String>,
}

#[derive(Debug, Default)]
pub struct LexicalIndex {
    pages: Vec<IndexedPage>,
}

impl LexicalIndex {
    pub fn build(catalog: &Catalog) -> Self {
        let pages = catalog
            .pages()
            .map(|page| {
                let normalized_title = tokenize::normalize(&page.title);
                let normalized_body = tokenize::normalize(&page.body);
                let tokens = tokenize::tokens(&format!("{} {}", page.title, page.body))
                    .into_iter()
                    .collect();
                IndexedPage {
                    path: page.path.clone(),
                    title: page.title.clone(),
                    normalized_title,
                    normalized_body,
                    tokens,
                }
            })
            .collect();
        Self { pages }
    }

    pub fn search(&self, query: &str, top_k: usize) -> Vec<SearchHit> {
        let phrase = tokenize::normalize(query.trim());
        let query_tokens = tokenize::tokens(query);
        let mut hits = self
            .pages
            .iter()
            .filter_map(|page| {
                let mut score = 0.0_f32;
                if page.path.to_lowercase().contains(&phrase) {
                    score += 200.0;
                }
                if !phrase.is_empty() && page.normalized_title.contains(&phrase) {
                    score += 50.0;
                }
                if !phrase.is_empty() && page.normalized_body.contains(&phrase) {
                    score += 20.0;
                }
                let matched_terms = query_tokens
                    .iter()
                    .filter(|token| page.tokens.contains(*token))
                    .cloned()
                    .collect::<BTreeSet<_>>();
                for term in &matched_terms {
                    if page.normalized_title.contains(term) {
                        score += 5.0;
                    }
                    if page.normalized_body.contains(term) {
                        score += 1.0;
                    }
                }
                (score > 0.0).then(|| SearchHit {
                    path: page.path.clone(),
                    title: page.title.clone(),
                    score,
                    matched_terms: matched_terms.into_iter().collect(),
                })
            })
            .collect::<Vec<_>>();
        hits.sort_by(|left, right| {
            right
                .score
                .total_cmp(&left.score)
                .then_with(|| left.path.cmp(&right.path))
        });
        hits.truncate(top_k);
        hits
    }

    pub fn debug_scores(&self, query: &str) -> BTreeMap<String, f32> {
        self.search(query, usize::MAX)
            .into_iter()
            .map(|hit| (hit.path, hit.score))
            .collect()
    }
}
