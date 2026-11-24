use rmcp::{tool_handler, ServerHandler};

use crate::tools::Clock;

#[tool_handler]
impl ServerHandler for Clock {}
