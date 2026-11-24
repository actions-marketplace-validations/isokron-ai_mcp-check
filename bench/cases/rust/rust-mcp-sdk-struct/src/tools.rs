use rust_mcp_sdk::macros::{mcp_tool, JsonSchema};
use serde::{Deserialize, Serialize};

#[mcp_tool(name = "list_directory", description = "Lists the entries of a directory inside the allowed root.", read_only_hint = true)]
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct ListDirectory {
    /// Directory path inside the allowed root
    pub path: String,
}

#[mcp_tool(name = "file_size", description = "Returns the size of a file in bytes.", read_only_hint = true)]
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct FileSize {
    /// File path inside the allowed root
    pub path: String,
}
