from fastapi import APIRouter, Depends, Header

from mcp_server_tavily.dependencies import get_tavily_service, get_scoped_service
from mcp_server_tavily.schemas import SearchRequest

router = APIRouter()
API_KEY_HEADER = "Tavily-Api-Key"


@router.post(
    "/search",
    tags=["Search"],
    operation_id="tavily_search",
)
async def tavily_search(
    search: SearchRequest,
    tavily_api_key: str | None = Header(
        default=None,
        alias=API_KEY_HEADER,
        description=(
            "Tavily API key for this request. "
            "Optional: the server's own key is used otherwise."
        ),
    ),
    tavily_client=Depends(get_tavily_service),
):
    return []


@router.post("/scoped", operation_id="tavily_scoped")
async def tavily_scoped(search: SearchRequest, svc=Depends(get_scoped_service)):
    """The dependency takes a parameter of its own: not read."""
    return []
