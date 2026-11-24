use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*, schemars, tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler, ServiceExt,
};

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct SumRequest {
    #[schemars(description = "The numbers to add")]
    pub values: Vec<f64>,
}

#[derive(Clone)]
pub struct Maths {
    tool_router: ToolRouter<Maths>,
}

#[tool_router]
impl Maths {
    pub fn new() -> Self {
        Self { tool_router: Self::tool_router() }
    }

    #[tool(name = "sum_values", description = "Adds a list of numbers.")]
    async fn sum(&self, Parameters(req): Parameters<SumRequest>) -> Result<CallToolResult, McpError> {
        let total: f64 = req.values.iter().sum();
        Ok(CallToolResult::success(vec![Content::text(total.to_string())]))
    }

    #[tool(name = "mean_value", description = "Returns the mean of a list of numbers.")]
    async fn mean(&self, Parameters(req): Parameters<SumRequest>) -> Result<CallToolResult, McpError> {
        let n = req.values.len().max(1) as f64;
        Ok(CallToolResult::success(vec![Content::text((req.values.iter().sum::<f64>() / n).to_string())]))
    }
}

#[tool_handler]
impl ServerHandler for Maths {}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    Maths::new().serve(rmcp::transport::stdio()).await?.waiting().await?;
    Ok(())
}
