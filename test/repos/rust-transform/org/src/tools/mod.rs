// Trimmed from szaffarano/org-mcp-server @ 0969f23751e9f567a80293004b6df7fd8481d284, org-mcp-server/src/tools/mod.rs (MIT).
mod org_search;

use rmcp::schemars::Schema;
use serde_json::{Map, Value, json};

const ANNOTATION_KEYS: [&str; 7] = [
    "title",
    "description",
    "default",
    "deprecated",
    "examples",
    "readOnly",
    "writeOnly",
];

/// Rewrites `"type": ["<T>", "null"]` properties as `anyOf: [{"type": "<T>", ...}, {"type": "null"}]`,
/// since several clients only understand a single `type` per schema.
pub(crate) fn nullable_as_any_of(schema: &mut Schema) {
    let Some(properties) = schema.get_mut("properties").and_then(Value::as_object_mut) else {
        return;
    };

    for property in properties.values_mut().filter_map(Value::as_object_mut) {
        split_nullable(property);
    }
}

fn split_nullable(property: &mut Map<String, Value>) {
    let Some(Value::Array(types)) = property.get("type") else {
        return;
    };
    let [Value::String(a), Value::String(b)] = types.as_slice() else {
        return;
    };
    let typed = match (a.as_str(), b.as_str()) {
        ("null", other) | (other, "null") if other != "null" => other.to_string(),
        _ => return,
    };

    let mut branch = Map::new();
    branch.insert("type".to_string(), Value::String(typed));
    property.remove("type");

    let moved: Vec<String> = property
        .keys()
        .filter(|key| !ANNOTATION_KEYS.contains(&key.as_str()))
        .cloned()
        .collect();
    for key in moved {
        if let Some(value) = property.remove(&key) {
            branch.insert(key, value);
        }
    }

    property.insert(
        "anyOf".to_string(),
        json!([Value::Object(branch), {"type": "null"}]),
    );
}
