# FastMCP.from_fastapi fixtures

Small servers written for `test/repo-reader-py-fastapi.test.mjs` in the shape of three public repositories at the
commits named below: the same app factory, router layout, route decorators, route maps or route_map_fn, parameter
kinds and Pydantic bodies, with the text written anew (operation ids, paths and field names kept).

| Folder | Shape of | Commit | FastMCP pinned |
|---|---|---|---|
| `queryweaver/` | FalkorDB/QueryWeaver (`api/app_factory.py`, `api/routes/graphs.py`, `api/routes/database.py`) | cdfabfeebc1eedf9eba07c1f2db2b5cf17fcc0db | 4.1.6 (uv.lock) |
| `ensk/` | sveinbjornt/ensk.is (`app.py`, `routes/api.py`, `routes/core.py`) | 966b0a6c30a5344073c1aa7d3bf36ba65f99bdc3 | 4.1.7 (requirements.txt) |
| `tavily/` | Xyber-Labs/mcp-servers, `mcp-server-tavily/` (`app.py`, `hybrid_routers/`, `schemas.py`) | 9d6e81b57c846e7747df1f1c13a3ed867b2472f8 | 2.14.5 (uv.lock) |
