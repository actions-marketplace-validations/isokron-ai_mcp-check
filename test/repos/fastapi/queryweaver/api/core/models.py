"""Request bodies."""
from pydantic import BaseModel


class ChatRequest(BaseModel):
    """A question in a conversation.

    Args:
        BaseModel (_type_): _description_
    """
    chat: list[str]
    result: list[str] | None = None
    instructions: str | None = None
    use_memory: bool = True  # a trailing comment


class Nested(BaseModel):
    inner: ChatRequest
