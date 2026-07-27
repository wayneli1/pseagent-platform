use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    process::Command,
};

use knowledge_engine::{
    catalog::Catalog,
    project::ProjectKey,
    service::{KnowledgeService, ProjectIndexes},
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct EvidenceCorpus {
    revisions: EvidenceRevisions,
    cases: Vec<EvidenceCase>,
}

#[derive(Debug, Deserialize)]
struct EvidenceRevisions {
    #[serde(rename = "coremail-professional")]
    professional: String,
    #[serde(rename = "presales-general")]
    general: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceCase {
    id: String,
    expected_scope: String,
    requirements: Vec<EvidenceRequirement>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceRequirement {
    id: String,
    queries: Vec<String>,
    expected_evidence_pages: Vec<String>,
}

#[test]
fn fixed_professional_snapshot_recalls_multi_part_evidence_pages() {
    let Some(professional_root) = configured_root("PSE_REAL_PROFESSIONAL_ROOT") else {
        return;
    };
    let Some(general_root) = configured_root("PSE_REAL_GENERAL_ROOT") else {
        return;
    };
    let corpus: EvidenceCorpus = serde_json::from_str(include_str!(
        "../../../tests/regression/evidence-coverage.json"
    ))
    .unwrap();
    assert_eq!(
        git_head(&professional_root),
        corpus.revisions.professional,
        "professional knowledge snapshot drifted"
    );
    assert_eq!(
        git_head(&general_root),
        corpus.revisions.general,
        "general knowledge snapshot drifted"
    );
    let service = KnowledgeService::new([
        (
            ProjectKey::CoremailProfessional,
            ProjectIndexes::new(
                Catalog::load(
                    ProjectKey::CoremailProfessional,
                    professional_root,
                    corpus.revisions.professional.clone(),
                )
                .unwrap(),
                "# professional".to_owned(),
            ),
        ),
        (
            ProjectKey::PresalesGeneral,
            ProjectIndexes::new(
                Catalog::load(
                    ProjectKey::PresalesGeneral,
                    general_root,
                    corpus.revisions.general,
                )
                .unwrap(),
                "# general".to_owned(),
            ),
        ),
    ])
    .unwrap();

    for case in corpus
        .cases
        .iter()
        .filter(|case| case.expected_scope == "professional")
    {
        for requirement in &case.requirements {
            let mut recalled = BTreeSet::new();
            for query in &requirement.queries {
                let result = service
                    .search(ProjectKey::CoremailProfessional, query, 10)
                    .unwrap();
                recalled.extend(result.hits.into_iter().map(|hit| hit.path));
            }
            for expected_path in &requirement.expected_evidence_pages {
                assert!(
                    recalled.contains(expected_path),
                    "case {} requirement {} did not recall {:?}; got {:?}",
                    case.id,
                    requirement.id,
                    expected_path,
                    recalled
                );
            }
        }
    }
}

fn configured_root(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

fn git_head(root: &Path) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .args(["rev-parse", "HEAD"])
        .output()
        .unwrap();
    assert!(output.status.success(), "failed to read git revision");
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}
