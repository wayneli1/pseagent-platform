use std::collections::BTreeSet;

use jieba_rs::Jieba;
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

pub fn normalize(value: &str) -> String {
    value.nfkc().collect::<String>().to_lowercase()
}

pub fn tokens(value: &str) -> Vec<String> {
    let normalized = normalize(value);
    let jieba = Jieba::new();
    let mut output = BTreeSet::new();
    for token in jieba.cut(&normalized, false) {
        let token = token.word.trim();
        if !token.is_empty() && token.chars().any(char::is_alphanumeric) {
            output.insert(token.to_owned());
        }
    }
    for word in UnicodeSegmentation::unicode_words(normalized.as_str()) {
        if !word.is_empty() {
            output.insert(word.to_owned());
        }
    }
    let chinese = normalized
        .chars()
        .filter(|value| ('\u{4e00}'..='\u{9fff}').contains(value))
        .collect::<Vec<_>>();
    for value in &chinese {
        output.insert(value.to_string());
    }
    for pair in chinese.windows(2) {
        output.insert(pair.iter().collect());
    }
    output.into_iter().collect()
}
