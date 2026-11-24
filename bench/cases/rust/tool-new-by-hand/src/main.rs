use std::sync::Arc;

use rmcp::model::{ListToolsResult, Tool};
use serde_json::json;

fn schema() -> Arc<serde_json::Map<String, serde_json::Value>> {
    let v = json!({ "type": "object", "properties": { "text": { "type": "string", "description": "Text to return" } }, "required": ["text"] });
    Arc::new(v.as_object().unwrap().clone())
}

pub fn tools() -> ListToolsResult {
    ListToolsResult {
        tools: vec![
            Tool::new("echo", "Returns the text it is given.", schema()),
            Tool::new("reverse_text", "Returns the text reversed.", schema()),
        ],
        next_cursor: None,
        meta: None,
    }
}

fn main() {
    let _ = tools();
}
