from fastapi import APIRouter, status

router = APIRouter()


@router.get(
    "/pricing",
    status_code=status.HTTP_200_OK,
    operation_id="tavily_get_pricing",
    tags=["Pricing"],
)
async def get_pricing():
    """Get tool pricing configuration."""
    return {}


@router.get("/items/{item_id}")
async def read_item(item_id: int, verbose: bool = False):
    return {}
