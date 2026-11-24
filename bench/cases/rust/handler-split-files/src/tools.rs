use rmcp::{handler::server::router::tool::ToolRouter, model::*, tool, tool_router, ErrorData as McpError};

#[derive(Clone)]
pub struct Clock {
    pub tool_router: ToolRouter<Clock>,
}

#[tool_router]
impl Clock {
    pub fn new() -> Self {
        Self { tool_router: Self::tool_router() }
    }

    #[tool(description = "Returns the current time in UTC.", annotations(read_only_hint = true))]
    async fn utc_now(&self) -> Result<CallToolResult, McpError> {
        Ok(CallToolResult::success(vec![]))
    }

    #[tool(description = "Returns the current Unix time in seconds.", annotations(read_only_hint = true))]
    async fn unix_time(&self) -> Result<CallToolResult, McpError> {
        Ok(CallToolResult::success(vec![]))
    }
}
