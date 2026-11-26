from fastapi import FastAPI
from fastmcp import FastMCP

from mcp_server_tavily.hybrid_routers import routers as hybrid_routers


def create_app() -> FastAPI:
    mcp_source_app = FastAPI(title="MCP Source")
    for router in hybrid_routers:
        mcp_source_app.include_router(router)

    mcp_server = FastMCP.from_fastapi(app=mcp_source_app, name="MCP")
    mcp_app = mcp_server.http_app(path="/")

    app = FastAPI(title="Hybrid")
    for router in hybrid_routers:
        app.include_router(router, prefix="/hybrid")
    app.mount("/mcp", mcp_app)
    return app
