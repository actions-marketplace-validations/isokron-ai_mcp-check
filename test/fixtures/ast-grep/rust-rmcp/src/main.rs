use rmcp::{tool, tool_router, ServerHandler};

#[derive(Clone)]
pub struct Counter;

#[tool_router]
impl Counter {
    #[tool(description = "Increment the counter")]
    async fn increment(&self) -> String { String::new() }

    /// Doc comment
    #[tool(name = "get_value", description = "Get the value")]
    #[allow(dead_code)]
    fn value_fn(&self) -> String { String::new() }

    fn helper(&self) {}
}
