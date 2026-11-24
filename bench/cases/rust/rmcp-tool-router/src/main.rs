use rmcp::{
    handler::server::router::tool::ToolRouter, model::*, tool, tool_handler, tool_router, ErrorData as McpError,
    ServerHandler, ServiceExt,
};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct Counter {
    value: Arc<Mutex<i64>>,
    tool_router: ToolRouter<Counter>,
}

#[tool_router]
impl Counter {
    pub fn new() -> Self {
        Self { value: Arc::new(Mutex::new(0)), tool_router: Self::tool_router() }
    }

    #[tool(description = "Adds one to the counter and returns the new value.")]
    async fn increment(&self) -> Result<CallToolResult, McpError> {
        let mut v = self.value.lock().unwrap();
        *v += 1;
        Ok(CallToolResult::success(vec![Content::text(v.to_string())]))
    }

    #[tool(description = "Returns the counter value.", annotations(read_only_hint = true))]
    async fn get_value(&self) -> Result<CallToolResult, McpError> {
        let v = self.value.lock().unwrap();
        Ok(CallToolResult::success(vec![Content::text(v.to_string())]))
    }
}

#[tool_handler]
impl ServerHandler for Counter {}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let service = Counter::new().serve(rmcp::transport::stdio()).await?;
    service.waiting().await?;
    Ok(())
}
