use rmcp::{handler::server::router::tool::ToolRouter, model::*, tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler};

#[derive(Clone)]
pub struct Audit {
    tool_router: ToolRouter<Audit>,
}

#[tool_router]
impl Audit {
    pub fn new() -> Self {
        Self { tool_router: Self::tool_router() }
    }

    #[tool(description = "Lists recent audit events.", annotations(read_only_hint = true))]
    async fn list_events(&self) -> Result<CallToolResult, McpError> {
        Ok(CallToolResult::success(vec![]))
    }

    #[cfg(feature = "admin")]
    #[tool(description = "Deletes all audit events older than a day.")]
    async fn purge_events(&self) -> Result<CallToolResult, McpError> {
        Ok(CallToolResult::success(vec![]))
    }
}

#[tool_handler]
impl ServerHandler for Audit {}

fn main() {}
