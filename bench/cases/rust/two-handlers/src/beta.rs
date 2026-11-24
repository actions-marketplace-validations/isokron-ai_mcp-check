use rmcp::{handler::server::router::tool::ToolRouter, model::*, tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler};

#[derive(Clone)]
pub struct Beta {
    tool_router: ToolRouter<Beta>,
}

#[tool_router]
impl Beta {
    pub fn new() -> Self {
        Self { tool_router: Self::tool_router() }
    }

    #[tool(description = "Returns the status of the beta service.", annotations(read_only_hint = true))]
    async fn beta_status(&self) -> Result<CallToolResult, McpError> {
        Ok(CallToolResult::success(vec![]))
    }
}

#[tool_handler]
impl ServerHandler for Beta {}
