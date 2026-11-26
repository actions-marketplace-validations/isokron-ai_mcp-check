// Trimmed from marknorgren/weather-bridge @ 304df32673877bc4bbb6b6527badd257221e260f, src/weather/query.rs (MIT).
use crate::cities::city_query_schema;
use rmcp::schemars;
use serde::Deserialize;

#[derive(Clone, Debug, Default, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WeatherQuery {
    /// Exact city name, optionally qualified with state, e.g. Seattle, WA. Ambiguous names return choices.
    #[schemars(transform = city_query_schema)]
    pub city: Option<String>,
    /// GeoNames city ID from search_cities. Alternative to city or coordinates.
    #[schemars(range(min = 1))]
    pub city_id: Option<u64>,
}
