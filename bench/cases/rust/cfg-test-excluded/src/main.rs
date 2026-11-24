use rmcp::{handler::server::router::tool::ToolRouter, model::*, tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler};

#[derive(Clone)]
pub struct Ledger {
    tool_router: ToolRouter<Ledger>,
}

#[tool_router]
impl Ledger {
    pub fn new() -> Self {
        Self { tool_router: Self::tool_router() }
    }

    #[tool(description = "Returns the ledger balance.", annotations(read_only_hint = true))]
    async fn balance(&self) -> Result<CallToolResult, McpError> {
        Ok(CallToolResult::success(vec![]))
    }
}

#[tool_handler]
impl ServerHandler for Ledger {}

fn main() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    pub struct FakeLedger {
        tool_router: ToolRouter<FakeLedger>,
    }

    #[tool_router]
    impl FakeLedger {
        #[tool(description = "Test-only helper that clears the ledger.")]
        async fn wipe_ledger(&self) -> Result<CallToolResult, McpError> {
            Ok(CallToolResult::success(vec![]))
        }
    }
}
