#[test]
fn library_does_not_export_planner_or_vector_modules() {
    let source = std::fs::read_to_string("src/lib.rs").expect("read lib.rs");
    assert!(!source.contains("mod planner"));
    assert!(!source.contains("mod vector"));
}
