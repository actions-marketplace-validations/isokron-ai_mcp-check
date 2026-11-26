from pydantic import BaseModel, Field


class SearchRequest(BaseModel):
    query: str = Field(
        ...,
        min_length=1,
        max_length=512,
        description="The search query",
    )
    max_results: int | None = Field(
        None,
        ge=1,
        le=50,
        description="Most results to return",
    )
    search_depth: str = Field(
        default="basic",
        pattern="^(basic|advanced)$",
        description="basic or advanced",
    )
