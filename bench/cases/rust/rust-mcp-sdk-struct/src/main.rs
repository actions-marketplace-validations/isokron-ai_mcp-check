mod tools;

use rust_mcp_sdk::schema::{ListToolsResult, Tool};
use tools::{FileSize, ListDirectory};

pub fn tool_list() -> ListToolsResult {
    let tools: Vec<Tool> = vec![ListDirectory::tool(), FileSize::tool()];
    ListToolsResult { tools, meta: None, next_cursor: None }
}

fn main() {
    let _ = tool_list();
}
