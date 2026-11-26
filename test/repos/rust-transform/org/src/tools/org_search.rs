// Trimmed from szaffarano/org-mcp-server @ 0969f23751e9f567a80293004b6df7fd8481d284, org-mcp-server/src/tools/org_search.rs (MIT).
use rmcp::{handler::server::wrapper::Parameters, model::CallToolResult, schemars, tool, tool_router, ErrorData as McpError};

use crate::core::OrgModeRouter;

#[derive(Debug, schemars::JsonSchema, serde::Deserialize)]
#[schemars(transform = crate::tools::nullable_as_any_of)]
pub struct SearchRequest {
    #[schemars(description = "Search query string to find in org file content")]
    pub query: String,
    #[schemars(description = "Maximum number of search results to return (optional)")]
    #[serde(
        default,
        deserialize_with = "crate::utils::deserialize_string_or_number"
    )]
    pub limit: Option<usize>,
    #[schemars(
        description = "Filter results by tags (optional, matches any of the provided tags)"
    )]
    pub tags: Option<Vec<String>>,
}

#[tool_router(router = "tool_router_search", vis = "pub(crate)")]
impl OrgModeRouter {
    #[tool(
        name = "org-search",
        description = "Search for text content across all org files using fuzzy matching. You can optionally specify a limit to the number of results returned.",
        annotations(title = "org-search tool")
    )]
    async fn tool_search(&self, Parameters(SearchRequest { query, limit, tags }): Parameters<SearchRequest>) -> Result<CallToolResult, McpError> {
        todo!()
    }
}
