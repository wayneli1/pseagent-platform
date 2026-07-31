use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::Arc,
};

use serde::Serialize;

use crate::{
    catalog::Catalog,
    document::WikiPage,
    error::EngineError,
    graph::{GraphHit, KnowledgeGraph},
    lexical::{LexicalIndex, SearchHit},
    planning_context::{PlanningContext, PlanningOverviewMeta},
    project::ProjectKey,
};

const MAX_TOP_K: usize = 20;
const MAX_QUERY_BYTES: usize = 16 * 1024;
const MAX_SNIPPET_CHARS: usize = 500;

#[derive(Debug)]
pub struct ProjectIndexes {
    catalog: Arc<Catalog>,
    lexical: LexicalIndex,
    graph: KnowledgeGraph,
    purpose: Arc<str>,
    schema: Arc<str>,
    planning_overview: Arc<str>,
    planning_overview_meta: PlanningOverviewMeta,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub project: ProjectKey,
    pub revision: String,
    pub lexical_status: &'static str,
    pub graph_status: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectContext {
    pub project: ProjectKey,
    pub revision: String,
    pub purpose: String,
    pub schema: String,
    pub planning_overview: String,
    pub planning_overview_meta: PlanningOverviewMeta,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchObservation {
    pub path: String,
    pub title: String,
    pub score: f32,
    pub matched_terms: Vec<String>,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub project: ProjectKey,
    pub revision: String,
    pub hits: Vec<SearchObservation>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResponse {
    pub project: ProjectKey,
    pub revision: String,
    pub page: Arc<WikiPage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphResponse {
    pub project: ProjectKey,
    pub revision: String,
    pub hits: Vec<GraphHit>,
}

#[derive(Debug, Clone)]
pub struct KnowledgeService {
    projects: Arc<HashMap<ProjectKey, Arc<ProjectIndexes>>>,
}

impl ProjectIndexes {
    pub fn new(catalog: Catalog, context: PlanningContext) -> Self {
        let lexical = LexicalIndex::build(&catalog);
        let graph = KnowledgeGraph::build(&catalog);
        Self {
            catalog: Arc::new(catalog),
            lexical,
            graph,
            purpose: Arc::from(context.purpose),
            schema: Arc::from(context.schema),
            planning_overview: Arc::from(context.planning_overview),
            planning_overview_meta: context.planning_overview_meta,
        }
    }
}

impl KnowledgeService {
    pub fn new(
        projects: impl IntoIterator<Item = (ProjectKey, ProjectIndexes)>,
    ) -> Result<Self, EngineError> {
        let mut configured = HashMap::new();
        for (project, indexes) in projects {
            if indexes.catalog.project() != project
                || configured.insert(project, Arc::new(indexes)).is_some()
            {
                return Err(EngineError::InvalidProject);
            }
        }
        if configured.len() != 2 {
            return Err(EngineError::InvalidConfiguration);
        }
        Ok(Self {
            projects: Arc::new(configured),
        })
    }

    pub fn project_count(&self) -> usize {
        self.projects.len()
    }

    pub fn snapshots(&self) -> Result<Vec<ProjectSnapshot>, EngineError> {
        ProjectKey::ALL
            .into_iter()
            .map(|project| {
                let indexes = self.indexes(project)?;
                Ok(ProjectSnapshot {
                    project,
                    revision: indexes.catalog.revision().to_owned(),
                    lexical_status: "ready",
                    graph_status: "ready",
                })
            })
            .collect()
    }

    pub fn context(&self, project: ProjectKey) -> Result<ProjectContext, EngineError> {
        let indexes = self.indexes(project)?;
        Ok(ProjectContext {
            project,
            revision: indexes.catalog.revision().to_owned(),
            purpose: indexes.purpose.to_string(),
            schema: indexes.schema.to_string(),
            planning_overview: indexes.planning_overview.to_string(),
            planning_overview_meta: indexes.planning_overview_meta.clone(),
        })
    }

    pub fn search(
        &self,
        project: ProjectKey,
        query: &str,
        top_k: usize,
    ) -> Result<SearchResponse, EngineError> {
        validate_query(query, top_k)?;
        let indexes = self.indexes(project)?;
        let lexical_hits = indexes
            .lexical
            .search(query, top_k.saturating_mul(3).max(top_k));
        let hits = blend_search_with_graph(indexes, lexical_hits, top_k)?;
        Ok(SearchResponse {
            project,
            revision: indexes.catalog.revision().to_owned(),
            hits,
        })
    }

    pub fn read(&self, project: ProjectKey, path: &str) -> Result<ReadResponse, EngineError> {
        let indexes = self.indexes(project)?;
        Ok(ReadResponse {
            project,
            revision: indexes.catalog.revision().to_owned(),
            page: indexes.catalog.read(path)?,
        })
    }

    pub fn graph(
        &self,
        project: ProjectKey,
        path: &str,
        top_k: usize,
    ) -> Result<GraphResponse, EngineError> {
        if !(1..=MAX_TOP_K).contains(&top_k) {
            return Err(EngineError::InvalidQuery);
        }
        let indexes = self.indexes(project)?;
        Ok(GraphResponse {
            project,
            revision: indexes.catalog.revision().to_owned(),
            hits: indexes.graph.neighbors(path, top_k)?,
        })
    }

    fn indexes(&self, project: ProjectKey) -> Result<&ProjectIndexes, EngineError> {
        self.projects
            .get(&project)
            .map(Arc::as_ref)
            .ok_or(EngineError::ProjectUnavailable)
    }
}

fn blend_search_with_graph(
    indexes: &ProjectIndexes,
    lexical_hits: Vec<SearchHit>,
    top_k: usize,
) -> Result<Vec<SearchObservation>, EngineError> {
    if lexical_hits.is_empty() {
        return Ok(Vec::new());
    }
    let lexical_paths = lexical_hits
        .iter()
        .map(|hit| hit.path.clone())
        .collect::<BTreeSet<_>>();
    let mut graph_candidates = BTreeMap::<String, (String, f32, usize)>::new();
    for (rank, seed) in lexical_hits.iter().take(5).enumerate() {
        for neighbor in indexes.graph.neighbors(&seed.path, MAX_TOP_K)? {
            if lexical_paths.contains(&neighbor.path) {
                continue;
            }
            let candidate_score = seed.score / (rank as f32 + 1.0);
            let entry = graph_candidates
                .entry(neighbor.path)
                .or_insert((neighbor.title, 0.0, 0));
            entry.1 += candidate_score;
            entry.2 += 1;
        }
    }
    let graph_quota = if top_k < 2 {
        0
    } else {
        ((top_k as f32 * 0.25).ceil() as usize).clamp(1, top_k - 1)
    };
    let mut ranked_graph = graph_candidates.into_iter().collect::<Vec<_>>();
    ranked_graph.sort_by(
        |(left_path, (_, left_score, left_seeds)), (right_path, (_, right_score, right_seeds))| {
            right_seeds
                .cmp(left_seeds)
                .then_with(|| right_score.total_cmp(left_score))
                .then_with(|| left_path.cmp(right_path))
        },
    );
    ranked_graph.truncate(graph_quota);

    let lexical_quota = top_k.saturating_sub(ranked_graph.len());
    let mut observations = lexical_hits
        .into_iter()
        .take(lexical_quota)
        .map(|hit| search_observation(indexes, hit))
        .collect::<Result<Vec<_>, _>>()?;
    for (path, (title, score, _seed_count)) in ranked_graph {
        observations.push(search_observation(
            indexes,
            SearchHit {
                path,
                title,
                score: score * 0.05,
                matched_terms: Vec::new(),
            },
        )?);
    }
    Ok(observations)
}

fn validate_query(query: &str, top_k: usize) -> Result<(), EngineError> {
    if query.trim().is_empty() || query.len() > MAX_QUERY_BYTES || !(1..=MAX_TOP_K).contains(&top_k)
    {
        return Err(EngineError::InvalidQuery);
    }
    Ok(())
}

fn search_observation(
    indexes: &ProjectIndexes,
    hit: SearchHit,
) -> Result<SearchObservation, EngineError> {
    let page = indexes.catalog.read(&hit.path)?;
    Ok(SearchObservation {
        path: hit.path,
        title: hit.title,
        score: hit.score,
        snippet: bounded_snippet(&page.body, &hit.matched_terms),
        matched_terms: hit.matched_terms,
    })
}

fn bounded_snippet(body: &str, matched_terms: &[String]) -> String {
    let chars = body.chars().collect::<Vec<_>>();
    if chars.len() <= MAX_SNIPPET_CHARS {
        return body.to_owned();
    }
    let earliest = matched_terms
        .iter()
        .filter_map(|term| {
            body.find(term)
                .map(|byte_offset| body[..byte_offset].chars().count())
        })
        .min()
        .unwrap_or(0);
    let half = MAX_SNIPPET_CHARS / 2;
    let start = earliest
        .saturating_sub(half)
        .min(chars.len() - MAX_SNIPPET_CHARS);
    chars[start..start + MAX_SNIPPET_CHARS].iter().collect()
}

#[cfg(test)]
mod tests {
    use super::{bounded_snippet, validate_query, MAX_QUERY_BYTES};

    #[test]
    fn validates_query_limits() {
        assert!(validate_query("", 5).is_err());
        assert!(validate_query("query", 0).is_err());
        assert!(validate_query("query", 20).is_ok());
        assert!(validate_query("query", 21).is_err());
        assert!(validate_query(&"x".repeat(MAX_QUERY_BYTES + 1), 5).is_err());
    }

    #[test]
    fn snippet_is_unicode_safe_and_exactly_bounded() {
        let body = format!("{}目标词{}", "前".repeat(600), "后".repeat(600));
        let snippet = bounded_snippet(&body, &["目标词".to_owned()]);
        assert_eq!(snippet.chars().count(), 500);
        assert!(snippet.contains("目标词"));
    }
}
