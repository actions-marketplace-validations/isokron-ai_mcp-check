// Trimmed from marknorgren/weather-bridge @ 304df32673877bc4bbb6b6527badd257221e260f, src/mcp.rs (MIT).
use crate::{cities::city_query_schema, weather::query::WeatherQuery};
use rmcp::{handler::server::wrapper::Parameters, model::CallToolResult, schemars, tool, tool_router, ServerHandler};
use serde::Deserialize;

#[derive(Clone)]
pub struct WeatherMcp;
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Search {
    /// City name or prefix, optionally qualified by state, e.g. Springfield, IL.
    #[schemars(transform = city_query_schema)]
    pub query: String,
}
#[tool_router]
impl WeatherMcp {
    #[tool(
        annotations(read_only_hint = true, destructive_hint = false, open_world_hint = true),
        description = "Search US cities and territories by name or prefix. Returns city IDs, states and coordinates."
    )]
    async fn search_cities(&self, Parameters(p): Parameters<Search>) -> CallToolResult {
        todo!()
    }
    #[tool(
        annotations(read_only_hint = true, destructive_hint = false, open_world_hint = true),
        description = "Get US weather by city name, cityId, or coordinates."
    )]
    async fn get_weather(&self, Parameters(p): Parameters<WeatherQuery>) -> CallToolResult {
        todo!()
    }
}
impl ServerHandler for WeatherMcp {}
