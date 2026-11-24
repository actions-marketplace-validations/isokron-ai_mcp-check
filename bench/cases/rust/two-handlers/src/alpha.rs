use rmcp::{handler::server::router::tool::ToolRouter, model::*, tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler};

#[derive(Clone)]
pub struct Alpha {
    tool_router: ToolRouter<Alpha>,
}

#[tool_router]
impl Alpha {
    pub fn new() -> Self {
        Self { tool_router: Self::tool_router() }
    }

    #[tool(description = "Returns the status of the alpha service.", annotations(read_only_hint = true))]
    async fn alpha_status(&self) -> Result<CallToolResult, McpError> {
        Ok(CallToolResult::success(vec![]))
    }
}

#[tool_handler]
impl ServerHandler for Alpha {}
