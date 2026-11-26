"""The application factory."""
import os

from fastapi import FastAPI
from fastmcp import FastMCP
from fastmcp.server.openapi import RouteMap, MCPType

from api.routes.graphs import graphs_router
from api.routes.database import database_router


def create_app():
    app = FastAPI(title="QueryWeaver")
    app.include_router(graphs_router, prefix="/graphs")
    app.include_router(database_router)

    disable_mcp = os.getenv("DISABLE_MCP", "false").lower() in ("1", "true")
    if not disable_mcp:
        mcp = FastMCP.from_fastapi(
            app=app,
            name="queryweaver",
            route_maps=[
                RouteMap(tags={"mcp_resource"}, mcp_type=MCPType.RESOURCE),
                RouteMap(tags={"mcp_tool"}, mcp_type=MCPType.TOOL),
                RouteMap(mcp_type=MCPType.EXCLUDE),
            ],
        )
        mcp_app = mcp.http_app(path="/mcp")

    app = FastAPI(title="QueryWeaver (combined)")
    return app
