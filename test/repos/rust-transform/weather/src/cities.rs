// Trimmed from marknorgren/weather-bridge @ 304df32673877bc4bbb6b6527badd257221e260f, src/cities.rs (MIT).
use rmcp::schemars;

/// Fewest characters a city query may have after trimming. REST, CLI and MCP schemas
/// advertise this bound through `city_query_schema`, so change it here only.
pub const CITY_QUERY_MIN_CHARS: usize = 2;
/// Most characters a city query may have after trimming.
pub const CITY_QUERY_MAX_CHARS: usize = 120;
pub(crate) fn city_query_schema(schema: &mut schemars::Schema) {
    const WHITESPACE: &str =
        r"\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000";
    const SCALAR: &str = r"(?:[\uD800-\uDBFF][\uDC00-\uDFFF]|[^\uD800-\uDFFF])";
    let non_whitespace_scalar =
        format!(r"(?:[\uD800-\uDBFF][\uDC00-\uDFFF]|[^\uD800-\uDFFF{WHITESPACE}])");
    let pattern = format!(
        r"^[{WHITESPACE}]*{non_whitespace_scalar}{SCALAR}{{{},{}}}{non_whitespace_scalar}[{WHITESPACE}]*(?![\s\S])",
        CITY_QUERY_MIN_CHARS - 2,
        CITY_QUERY_MAX_CHARS - 2,
    );
    schema.insert("pattern".into(), pattern.into());
}
