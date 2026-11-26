"""The app, with an MCP endpoint built from its routes."""
from fastapi import FastAPI
from fastmcp import FastMCP
from fastmcp.server.openapi import HTTPRoute, MCPType

from routes.api import router as api_router
from routes.web import router as web_router

app = FastAPI(
    title="Dictionary",
    contact={
        "name": "Editor",
    },
)

app.include_router(web_router)
app.include_router(api_router)

MCP_OPERATIONS = [
    "get_metadata",
    "search_for_word",
    "lookup_many_words_parsed",
    "get_page_grounding",
]


def mcp_route_map(route: HTTPRoute, mcp_type: MCPType) -> MCPType:
    """Expose only the listed API operations as MCP tools."""
    return MCPType.TOOL if route.operation_id in MCP_OPERATIONS else MCPType.EXCLUDE


mcp = FastMCP.from_fastapi(
    app,
    name="dictionary",
    route_map_fn=mcp_route_map,
)
