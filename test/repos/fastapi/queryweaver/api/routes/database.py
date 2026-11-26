"""Database connection routes."""
from fastapi import APIRouter, Request
from pydantic import BaseModel

from api.auth import token_required

database_router = APIRouter(tags=["Database Connection"])

class DatabaseConnectionRequest(BaseModel):
    """Connection request."""

    url: str

@database_router.post("/database", operation_id="connect_database", tags=["mcp_tool"], responses={
    401: {"description": "Unauthorized"}
})
@token_required
async def connect_database(request: Request, db_request: DatabaseConnectionRequest):
    """
    Connect to a database by URL.
    Streams progress.
    """
    return {}


late_router = APIRouter()


@late_router.get("/late", operation_id="late_tool", tags=["mcp_tool"])
async def late():
    """Included after the MCP server was built."""
    return {}
