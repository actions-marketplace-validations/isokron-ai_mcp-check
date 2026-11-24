"""An independent oracle client for the live-probe lane (corpus/LIVE-PROBE.md, "Oracles").

The official Python SDK (`mcp`, pinned with hashes in corpus/oracles/requirements.txt), used the way its documentation
shows: `Client(StdioServerParameters(...))` with its default protocol negotiation. It starts the server command (in the
lane, a `docker run -i` of the target's sandbox container: the server never runs here), lists every page of tools/list,
and prints one JSON line. No tool is ever called.

    python py-client.py <time limit ms> -- <command...>
"""

import json
import os
import sys
import time

FORMAT = "isokron-oracle-client/1"
MAX_PAGES = 100


def main(argv):
    if len(argv) < 3 or argv[1] != "--" or not argv[0].isdigit():
        sys.stderr.write("usage: py-client.py <ms> -- <command...>\n")
        return 2
    ms = int(argv[0])
    command = argv[2:]
    out = {"format": FORMAT, "client": "python", "sdk": "mcp", "sdk_version": None, "outcome": None, "stage": None,
           "error": None, "protocol": None, "server_info": None, "pages": 0, "tools": None, "ms": None}
    t0 = time.monotonic()
    try:
        import anyio
        from importlib.metadata import version
        from mcp import Client, StdioServerParameters

        out["sdk_version"] = version("mcp")

        async def run():
            params = StdioServerParameters(command=command[0], args=command[1:], env=dict(os.environ))
            out["stage"] = "connect"
            async with Client(params, cache=None) as client:
                out["protocol"] = client.protocol_version
                info = client.server_info
                if info is not None:
                    out["server_info"] = {"name": str(info.name)[:200], "version": str(info.version)[:64]}
                out["stage"] = "list"
                tools = []
                cursor = None
                while True:
                    r = await client.list_tools(cursor=cursor)
                    out["pages"] += 1
                    tools.extend(t.model_dump(mode="json", by_alias=True, exclude_none=True) for t in r.tools)
                    nxt = r.next_cursor
                    if nxt is None:
                        break
                    if out["pages"] >= MAX_PAGES:
                        raise RuntimeError(f"paging stopped after {MAX_PAGES} pages")
                    if nxt == cursor:
                        raise RuntimeError("the server repeated the same cursor")
                    cursor = nxt
                out["tools"] = tools
                out["outcome"] = "listed"

        anyio.run(_bounded, run, ms / 1000)
    except TimeoutError:
        out["outcome"] = out["outcome"] or "timeout"
        out["error"] = out["error"] or f"time limit ({ms} ms)"
    except BaseException as e:  # noqa: BLE001 - every failure is the observation
        if out["outcome"] is None:
            out["outcome"] = {"list": "list_failed", "connect": "init_failed"}.get(out["stage"], "client_error")
        out["error"] = (type(e).__name__ + ": " + str(_root(e)))[:500]
    out["ms"] = int((time.monotonic() - t0) * 1000)
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
    return 0


def _root(e):
    """The first leaf of an exception group, else the exception itself."""
    while isinstance(e, BaseExceptionGroup) and e.exceptions:
        e = e.exceptions[0]
    return e


async def _bounded(fn, seconds):
    import anyio

    with anyio.fail_after(seconds):
        await fn()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
