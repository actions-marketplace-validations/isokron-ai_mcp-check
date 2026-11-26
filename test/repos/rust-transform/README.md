# Rust `#[schemars(transform = …)]` fixtures

Trimmed from public repositories (MIT licensed) at the commits named below; only the parts the reader needs are kept
(argument structs, the transform functions, the `#[tool]` methods). Used by `test/repo-reader-rust-transform.test.mjs`.

| Folder | Repository | Commit | Files |
|---|---|---|---|
| `docling/` | docling-project/docling.rs | 6b1845ce851ff94296a421f8d6e20b91be8b98ff | `crates/docling-cli/src/mcp.rs` |
| `org/` | szaffarano/org-mcp-server | 0969f23751e9f567a80293004b6df7fd8481d284 | `org-mcp-server/src/tools/mod.rs`, `org_search.rs` |
| `weather/` | marknorgren/weather-bridge | 304df32673877bc4bbb6b6527badd257221e260f | `src/mcp.rs`, `src/cities.rs`, `src/weather/query.rs` |
