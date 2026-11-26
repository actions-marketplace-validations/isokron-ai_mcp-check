"""Graph routes."""
from fastapi import APIRouter, Request

from api.auth import token_required, audit
from api.core.models import ChatRequest, Nested

graphs_router = APIRouter(tags=["Graphs"])


@graphs_router.get(
    "",
    operation_id="list_databases",
    tags=["mcp_tool"],
)
@token_required
async def list_graphs(request: Request):
    """
    List the databases of the signed-in user.
    Requires authentication.
    """
    return []


@graphs_router.get("/{graph_id}/data", operation_id="database_schema", tags=["mcp_tool"])
@token_required
async def get_graph_data(
    request: Request, graph_id: str
):  # pylint: disable=too-many-locals
    """Return the schema of one database.
    Requires authentication.

        args:
            graph_id (str): The database name.
    """
    return {}


@graphs_router.post("/{graph_id}", operation_id="query_database", tags=["mcp_tool"])
@token_required
async def query_graph(request: Request, graph_id: str, chat_data: ChatRequest):
    """
    Ask the database a question.

        Args:
            graph_id (str): The database name.
    """
    return {}


@graphs_router.delete("/{graph_id}", operation_id="delete_database")
@token_required
async def delete_graph(request: Request, graph_id: str):
    """Delete a database (not tagged for MCP: excluded by the last route map)."""
    return {}


@graphs_router.get("/{graph_id}/rules", operation_id="get_rules", tags=["mcp_resource"])
async def get_rules(graph_id: str):
    """A resource, not a tool."""
    return {}


@graphs_router.post("/{graph_id}/audit", operation_id="audited_query", tags=["mcp_tool"])
@audit
async def audited_query(graph_id: str):
    """Audited: the decorator does not keep the signature."""
    return {}


@graphs_router.post("/{graph_id}/nested", operation_id="nested_query", tags=["mcp_tool"])
async def nested_query(graph_id: str, body: Nested):
    """A body with a nested model."""
    return {}
