//! Expand and Shrink Selection (textDocument/selectionRange): from the
//! token at each position out through the brackets around it to the
//! top-level statement, as `q_lint_rs::selection_ranges` reads them from the
//! text. Nothing here runs the source.
use super::Lines;
use super::navigate::{Sources, range};
use q_lint_rs::selection_ranges;
use serde_json::{Value, json};

/// What the server adds to its capabilities for the request answered here.
pub(super) fn announce(capabilities: &mut Value, on: bool) {
    if on {
        capabilities["selectionRangeProvider"] = json!(true);
    }
}

/// One `SelectionRange` per position asked about, in their order, each
/// with its parents out to the statement. A position with nothing around
/// it, in a document that is not open or past its end, gets the empty range
/// at itself, since the protocol wants one answer per position.
pub(super) fn answer(params: &Value, sources: &Sources) -> Value {
    let document = sources.document(params);
    let positions = params["positions"].as_array().cloned().unwrap_or_default();
    let answers: Vec<Value> = positions
        .iter()
        .map(|position| {
            let empty = json!({"range": {"start": position, "end": position}});
            let Some((_, text)) = document else {
                return empty;
            };
            let (Some(line), Some(character)) =
                (position["line"].as_u64(), position["character"].as_u64())
            else {
                return empty;
            };
            let lines = Lines::new(text);
            let offset = lines.offset(line as usize, character as usize);
            selection_ranges(text, offset)
                .into_iter()
                .rev()
                .fold(None, |parent: Option<Value>, (start, end)| {
                    let mut node = json!({"range": range(&lines, start, end - start)});
                    if let Some(parent) = parent {
                        node["parent"] = parent;
                    }
                    Some(node)
                })
                .unwrap_or(empty)
        })
        .collect();
    json!(answers)
}
