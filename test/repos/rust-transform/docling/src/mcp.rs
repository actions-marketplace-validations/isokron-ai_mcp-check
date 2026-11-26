// Trimmed from docling-project/docling.rs @ 6b1845ce851ff94296a421f8d6e20b91be8b98ff, crates/docling-cli/src/mcp.rs (MIT).
use rmcp::{handler::server::wrapper::Parameters, schemars, tool, tool_router, ServerHandler};
use serde::Deserialize;

#[derive(Deserialize, schemars::JsonSchema)]
struct ConvertArgs {
    /// The document to read: a URL, a file: URI, a data: URI, or a file path.
    uri: String,
    /// Output format: md (Markdown, the default), json, html or text.
    // Optional parameters are single-typed in the schema and left out of
    // `required`.
    #[serde(default)]
    #[schemars(transform = drop_null)]
    to: Option<String>,
    /// Pictures in md, html or pandoc output: placeholder or embedded.
    #[serde(default)]
    #[schemars(transform = drop_null)]
    images: Option<String>,
    /// Conversion options, e.g. {"pages": "1-5"}.
    #[serde(default)]
    #[schemars(transform = drop_null)]
    options: Option<serde_json::Map<String, serde_json::Value>>,
}

/// An `Option<T>` field's schema as `T`'s: `"type": ["T", "null"]` → `"T"`,
/// and no `"default": null` — absence already says "not given".
fn drop_null(schema: &mut schemars::Schema) {
    if let Some(serde_json::Value::Array(types)) = schema.get("type").cloned() {
        let kept: Vec<_> = types.into_iter().filter(|t| t != "null").collect();
        if let [single] = kept.as_slice() {
            schema.insert("type".into(), single.clone());
        }
    }
    if schema.get("default") == Some(&serde_json::Value::Null) {
        schema.remove("default");
    }
}

#[derive(Clone)]
struct DoclingMcp;

#[tool_router]
impl DoclingMcp {
    /// Convert a document to a chosen output format. Read-only.
    #[tool(annotations(title = "Convert to a chosen format", read_only_hint = true, open_world_hint = true))]
    async fn convert(&self, Parameters(args): Parameters<ConvertArgs>) -> Result<String, String> {
        Ok(args.uri)
    }
}

impl ServerHandler for DoclingMcp {}
