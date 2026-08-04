use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use crate::{catalog::Catalog, document::WikiPage, tokenize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchMode {
    #[default]
    Hybrid,
    AnswerCards,
    Standard,
}

#[derive(Debug, Clone, Default)]
pub struct SearchFilters {
    pub page_type: Option<String>,
    pub review_status: Option<String>,
    pub mode: SearchMode,
}

impl SearchFilters {
    pub(crate) fn matches_page(&self, page: &WikiPage) -> bool {
        self.matches_metadata(
            &page.page_type,
            &page.review_status,
            page.card_schema_version.is_some(),
        )
    }

    fn matches_metadata(
        &self,
        page_type: &str,
        review_status: &str,
        has_card_schema: bool,
    ) -> bool {
        if self
            .page_type
            .as_deref()
            .is_some_and(|expected| expected != page_type)
            || self
                .review_status
                .as_deref()
                .is_some_and(|expected| expected != review_status)
        {
            return false;
        }
        let answer_card = page_type == "query" && has_card_schema;
        let active_answer_card = answer_card && is_approved_status(review_status);
        match self.mode {
            SearchMode::Hybrid => !answer_card || active_answer_card,
            SearchMode::AnswerCards => active_answer_card,
            SearchMode::Standard => !answer_card,
        }
    }
}

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
    compact_path: String,
    compact_title: String,
    compact_aliases: Vec<String>,
    compact_question_family: String,
    compact_tags: Vec<String>,
    compact_body: String,
    normalized_title: String,
    normalized_body: String,
    normalized_metadata: String,
    title_length: usize,
    body_length: usize,
    metadata_length: usize,
    page_type: String,
    review_status: String,
    has_card_schema: bool,
    tokens: BTreeSet<String>,
}

#[derive(Debug, Default)]
pub struct LexicalIndex {
    pages: Vec<IndexedPage>,
    document_frequency: HashMap<String, usize>,
    average_title_length: f32,
    average_body_length: f32,
    average_metadata_length: f32,
}

impl LexicalIndex {
    pub fn build(catalog: &Catalog) -> Self {
        let pages = catalog
            .pages()
            .map(|page| {
                let normalized_title = tokenize::normalize(&page.title);
                let normalized_body = tokenize::normalize(&page.body);
                let metadata = [
                    page.aliases.join(" "),
                    page.question_family.clone(),
                    page.tags.join(" "),
                    page.applicable_product.join(" "),
                    page.applicable_version.join(" "),
                ]
                .join(" ");
                let normalized_metadata = tokenize::normalize(&metadata);
                let tokens =
                    tokenize::tokens(&format!("{} {} {}", page.title, metadata, page.body))
                        .into_iter()
                        .collect();
                IndexedPage {
                    path: page.path.clone(),
                    title: page.title.clone(),
                    compact_path: compact(&page.path),
                    compact_title: compact(&page.title),
                    compact_aliases: page.aliases.iter().map(|alias| compact(alias)).collect(),
                    compact_question_family: compact(&page.question_family),
                    compact_tags: page.tags.iter().map(|tag| compact(tag)).collect(),
                    compact_body: compact(&page.body),
                    title_length: lexical_length(&normalized_title),
                    body_length: lexical_length(&normalized_body),
                    metadata_length: lexical_length(&normalized_metadata),
                    normalized_title,
                    normalized_body,
                    normalized_metadata,
                    page_type: page.page_type.clone(),
                    review_status: page.review_status.clone(),
                    has_card_schema: page.card_schema_version.is_some(),
                    tokens,
                }
            })
            .collect::<Vec<_>>();
        let mut document_frequency = HashMap::new();
        for page in &pages {
            for token in &page.tokens {
                *document_frequency.entry(token.clone()).or_default() += 1;
            }
        }
        let average_title_length = average_length(&pages, |page| page.title_length);
        let average_body_length = average_length(&pages, |page| page.body_length);
        let average_metadata_length = average_length(&pages, |page| page.metadata_length);
        Self {
            pages,
            document_frequency,
            average_title_length,
            average_body_length,
            average_metadata_length,
        }
    }

    pub fn search(&self, query: &str, top_k: usize) -> Vec<SearchHit> {
        self.search_with_filters(query, top_k, &SearchFilters::default())
    }

    pub fn search_with_filters(
        &self,
        query: &str,
        top_k: usize,
        filters: &SearchFilters,
    ) -> Vec<SearchHit> {
        let phrase = compact(query);
        let query_tokens = tokenize::query_tokens(query);
        let total_query_weight = query_tokens
            .iter()
            .map(|term| query_term_weight(term))
            .sum::<f32>()
            .max(1.0);
        let document_count = self.pages.len();
        let mut hits = self
            .pages
            .iter()
            .filter(|page| {
                filters.matches_metadata(&page.page_type, &page.review_status, page.has_card_schema)
            })
            .filter_map(|page| {
                let mut score = 0.0_f32;
                if !phrase.is_empty() && page.compact_path.contains(&phrase) {
                    score += 120.0;
                }
                if !phrase.is_empty() && page.compact_aliases.iter().any(|alias| alias == &phrase) {
                    score += 360.0;
                } else if !phrase.is_empty()
                    && page
                        .compact_aliases
                        .iter()
                        .any(|alias| alias.contains(&phrase))
                {
                    score += 140.0;
                }
                let approved_query = page.page_type == "query"
                    && page.has_card_schema
                    && is_approved_status(&page.review_status);
                if !phrase.is_empty() && page.compact_title == phrase {
                    score += if approved_query { 300.0 } else { 180.0 };
                } else if !phrase.is_empty() && page.compact_title.contains(&phrase) {
                    score += if approved_query { 140.0 } else { 80.0 };
                }
                if !phrase.is_empty() && page.compact_question_family == phrase {
                    score += 100.0;
                } else if !phrase.is_empty() && page.compact_question_family.contains(&phrase) {
                    score += 60.0;
                }
                if !phrase.is_empty() && page.compact_tags.iter().any(|tag| tag == &phrase) {
                    score += 70.0;
                } else if !phrase.is_empty()
                    && page.compact_tags.iter().any(|tag| tag.contains(&phrase))
                {
                    score += 30.0;
                }
                if !phrase.is_empty() && page.compact_body.contains(&phrase) {
                    score += 20.0;
                }
                let matched_terms = query_tokens
                    .iter()
                    .filter(|token| page.tokens.contains(*token))
                    .cloned()
                    .collect::<BTreeSet<_>>();
                let mut matched_query_weight = 0.0_f32;
                for term in &matched_terms {
                    let term_weight = query_term_weight(term);
                    matched_query_weight += term_weight;
                    let document_frequency = self
                        .document_frequency
                        .get(term)
                        .copied()
                        .unwrap_or_default();
                    let idf = inverse_document_frequency(document_count, document_frequency);
                    let title_frequency = count_occurrences(&page.normalized_title, term);
                    let body_frequency = count_occurrences(&page.normalized_body, term);
                    let metadata_frequency = count_occurrences(&page.normalized_metadata, term);
                    score += term_weight
                        * idf
                        * (5.0
                            * bm25_term_score(
                                title_frequency,
                                page.title_length,
                                self.average_title_length,
                            )
                            + bm25_term_score(
                                body_frequency,
                                page.body_length,
                                self.average_body_length,
                            )
                            + 3.0
                                * bm25_term_score(
                                    metadata_frequency,
                                    page.metadata_length,
                                    self.average_metadata_length,
                                ));
                }
                let coverage = matched_query_weight / total_query_weight;
                score += 30.0 * coverage * coverage;
                if coverage < 0.2 {
                    score *= 0.25;
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

fn is_approved_status(status: &str) -> bool {
    matches!(status, "approved" | "release_ready" | "released")
}

fn compact(value: &str) -> String {
    tokenize::normalize(value)
        .chars()
        .filter(|value| value.is_alphanumeric())
        .collect()
}

fn lexical_length(value: &str) -> usize {
    value
        .chars()
        .filter(|value| value.is_alphanumeric())
        .count()
        .max(1)
}

fn average_length(pages: &[IndexedPage], length: impl Fn(&IndexedPage) -> usize) -> f32 {
    if pages.is_empty() {
        return 1.0;
    }
    pages.iter().map(|page| length(page) as f32).sum::<f32>() / pages.len() as f32
}

fn query_term_weight(term: &str) -> f32 {
    match term.chars().count() {
        0 => 0.0,
        1 => 0.1,
        2 => 1.0,
        _ => 1.5,
    }
}

fn inverse_document_frequency(document_count: usize, document_frequency: usize) -> f32 {
    if document_count == 0 || document_frequency == 0 {
        return 0.0;
    }
    (1.0 + (document_count as f32 - document_frequency as f32 + 0.5)
        / (document_frequency as f32 + 0.5))
        .ln()
}

fn bm25_term_score(term_frequency: usize, field_length: usize, average_length: f32) -> f32 {
    if term_frequency == 0 {
        return 0.0;
    }
    const K1: f32 = 1.2;
    const B: f32 = 0.75;
    let frequency = term_frequency as f32;
    frequency * (K1 + 1.0)
        / (frequency + K1 * (1.0 - B + B * field_length as f32 / average_length.max(1.0)))
}

fn count_occurrences(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    haystack.match_indices(needle).count()
}
