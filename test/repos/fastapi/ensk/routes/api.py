"""API routes."""
from fastapi import APIRouter, Request

from .core import SEARCH_CACHE_BYTES, cache_response

router = APIRouter(prefix="/api")


@router.get("/metadata", operation_id="get_metadata")
@cache_response
async def api_metadata(request: Request):
    """Return metadata about the dictionary."""
    return {}


DEFAULT_SUGGESTION_LIMIT = 10


@router.get("/suggest/{q}", operation_id="get_suggestions")  # pyright: ignore[reportArgumentType]
@cache_response(SEARCH_CACHE_BYTES)
async def api_suggest(request: Request, q: str, limit: int = DEFAULT_SUGGESTION_LIMIT):
    """Autosuggest (not in MCP_OPERATIONS: excluded)."""
    return []


@router.get("/search/{q}", operation_id="search_for_word")
@cache_response(SEARCH_CACHE_BYTES)
async def api_search(request: Request, q: str):
    """Return search results for a word."""
    return {}


@router.get("/item/parsed/many/", operation_id="lookup_many_words_parsed")
def api_item_parsed_many(
    request: Request, q: str, strip_parentheses: int = 0
):
    """Return several entries with
    parsed definitions. The q parameter is a comma-separated list.
    Optionally, strip text within parentheses."""
    return {}


@router.get("/grounding/{w}", operation_id="get_page_grounding", include_in_schema=False)
async def api_grounding(request: Request, w: str):
    """Not in the OpenAPI schema."""
    return {}
