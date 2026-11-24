from .registry import create_tool


@create_tool("find_notes", "Finds notes whose text matches a query.")
def find_notes(query: str, limit: int = 20) -> list[str]:
    return []


@create_tool("count_notes", "Counts the notes in the notebook.")
def count_notes() -> int:
    return 0
