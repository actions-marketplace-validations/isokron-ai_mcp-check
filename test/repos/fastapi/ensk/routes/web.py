"""Web pages (no operation ids)."""
from fastapi import APIRouter, Request

router = APIRouter()


@router.get("/")
async def index(request: Request):
    """The front page."""
    return {}
