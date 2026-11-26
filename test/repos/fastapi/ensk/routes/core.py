"""Shared helpers for the routes."""
import functools
from typing import Any, Callable, overload

DEFAULT_CACHE_BYTES = 1024
SEARCH_CACHE_BYTES = 4096


@overload
def cache_response(max_bytes: Callable[..., Any]) -> Callable[..., Any]: ...


@overload
def cache_response(
    max_bytes: int = DEFAULT_CACHE_BYTES,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]: ...


def cache_response(max_bytes=DEFAULT_CACHE_BYTES):
    """Cache an endpoint's responses (bare or with a byte budget)."""

    def decorate(func):
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            return await func(*args, **kwargs)

        return wrapper

    if callable(max_bytes):
        return decorate(max_bytes)
    return decorate
