# Code-derived tool annotations (experimental)

`mcp-check --repo-dir <path> --code-effects` (also `--repo`) reads each tool's handler from source, works out what it
touches, and compares that with the hints the author declared. It is off by default, adds nothing to the grades, and
does not change the exit code. Nothing is run: the source is read as text.

The standard it grades against is MWS-ANN-1, 2 and 3: `readOnlyHint: true` means the tool changes no state,
`destructiveHint: false` means it deletes nothing and replaces nothing unnamed, `idempotentHint: true` means a repeat
has no further effect. Phase 1 covers the first two.

## Method

1. **Handler.** For each tool the reader found, the handler is looked for in this order: an inline function or arrow
   passed to the registration (`server.tool(...)`, `registerTool(...)`, `addTool(...)`, a `handler`/`execute`/`run`
   key of a tool object), a referenced function, a method of a tool class, a FastMCP-style decorated Python function
   (`@mcp.tool(...)`, also with `name=` and a multi-line decorator), a branch of a switch or an `if name == "x"` chain
   (low-level servers: `setRequestHandler(CallToolRequestSchema, ...)`, `@server.call_tool()`), including a name held
   in a constant or an enum member, and including a dispatch in another file of the same package. As a last resort a
   function named like the tool (`handlers = by-name`); effects found that way are never `definite`.
2. **Calls.** Inside the handler, every call is classified as a sink or resolved to a function of the repository (same
   file, a relative import, `this.method`, `self.method`, a class or an instance built in the file, a module
   namespace) and followed, up to `--code-effects-depth` levels (default 3). Nothing outside the files the reader read
   is followed: no `node_modules`, no `site-packages`.
3. **Sinks.** Matched on the code, with comments and the text of strings blanked, so a comment or a log message that
   names `fs.unlink` is not a sink. Imports decide what `fs`, `child_process`, `axios`, `requests` mean.
4. **Output.** Per tool: `effects` with `read`, `write`, `delete`, `unsafe_http`, `exec`, `unknown_call`, each a list of
   evidence (`file`, `line`, `sink`, `confidence`, the chain of calls `via`); and `derived` hints.

## Sink families

| Family | Sinks |
|---|---|
| `fs` | `fs`/`fs/promises`/`fs-extra` write, append, mkdir, copy, rename, truncate, chmod; unlink, rm, rmdir, remove; file handles opened here; `promisify(fs.x)` and `const { x } = fs` aliases; Deno and Bun. Python `open(path, mode)` with a write mode, `os.remove/rename/mkdir/...`, `shutil.rmtree/move/copy...`, `pathlib` write and unlink. A path that looks temporary (`tmp`, `temp`, `cache`, `os.tmpdir`) is `may`. |
| `sql` | A string handed to a call (not a logger, `print` or an error) that starts with INSERT, UPDATE ... SET, DELETE FROM, DROP, TRUNCATE, ALTER, CREATE, MERGE or REPLACE INTO; a tagged template; a variable assigned such a string in the handler or at module level. SELECT is a read. A write-shaped string that no call receives is `may`. |
| `orm` | prisma create/update/delete/upsert; Mongo `insertOne`, `updateOne`, `deleteMany` and the like; Sequelize `destroy`, `save`; Drizzle and Knex when the file uses them; SQLAlchemy `session.add/delete/merge`, `commit` (`may` alone); Django `objects.create/update/delete`; `.delete()` and `.save()` in a file that uses a known ORM; Redis writes and deletes. |
| `http` | `fetch`, `axios`, `got`, `ky`, `requests`, `httpx`, `aiohttp`, clients made by `axios.create`, `httpx.Client`, `requests.Session`, `aiohttp.ClientSession`, with their method. PUT, PATCH and DELETE are `definite` (DELETE also fills `delete`); GET is a read; a method that is not a literal is `may`; POST is `definite` unless the URL looks like a query (`search`, `query`, `graphql`, `lookup`, ...), then `may`. |
| `exec` | `child_process` exec/spawn/execFile/fork, `execa`; Python `subprocess`, `os.system`, `os.popen`, asyncio subprocesses. A literal command that is known to be read-only (`ls`, `cat`, `git status`, `git log`, `kubectl get`, ...) is a read; anything else, a command built from arguments included, is `exec`. Python `exec` and `eval` are `may`. |
| `sdk` | A method on a client-like object named like a write: `client.issues.create`, `stripe.charges.refund`, `bucket.delete`. Always `may`, because what the remote service does is not visible. Calls to such objects with other names are `unknown_call`. |

## Confidence tiers

- **definite**: a sink call in the handler's own resolved call chain, with the sink's kind visible in the code (a
  method, a path, a SQL string).
- **may**: an opaque client call, a method that is not a literal, a path that looks temporary, a POST to a URL that
  looks like a query, a SQL string that no call receives, a handler found only by its function name, an import that
  could not be resolved.

## Checks

All three are separate from the name-based checks (`annot-write-marked-readonly`, `annot-delete-marked-safe`), live in
the report's `code_effects` block, and are capped at `attention`. They never block, never change a section grade and
never change the exit code. Only `definite` evidence gives `attention`; `may` gives `advice`, worded "may write" or
"may delete".

| Check | Fires when |
|---|---|
| `annot-code-writes-marked-readonly` | `readOnlyHint: true` and a definite write, delete, state-changing HTTP call or exec (attention); or only `may` evidence (advice). |
| `annot-code-deletes-marked-safe` | `destructiveHint: false`, `readOnlyHint` not true, and a definite delete (attention); or a `may` delete (advice). |
| `annot-code-unmarked-write` | No `readOnlyHint` declared and a definite write, delete, state-changing HTTP call or exec (advice). MWS-ANN-4 asks for explicit hints. |

`derived.readOnlyHint` is `false` (definite) when a definite write-like sink is reached, null (may) when only `may`
evidence exists, and `true` with confidence `no_sink_found` otherwise. The last one is the absence of a sink within the
depth and the files read: it is not proof, and no check uses it. `idempotentHint` is not derived in phase 1.

## Limits

- Static reading only. A call through a variable, a plugin, a generated client, reflection or a table of functions
  (`ops[name](x)`) is not followed.
- What a remote API does behind an HTTP call or an SDK method cannot be seen: such calls are `may`.
- Depth: a sink more than `--code-effects-depth` calls below the handler is not seen (default 3). Real servers wrap
  file access in several layers; the first score shows what depth 3 and 5 find.
- Go, Rust, C# and other languages: `status: unsupported_language`.
- Handlers the reader found but this one could not place (`handler_not_found`) get no effects and no finding.
- The call budget per tool is 3000; a tool that hits it is cut and the report says `truncated`.
- Precision matters more than recall: a wrong "this server lies" costs more than a miss, so a definite needs a direct
  sink, and the guesses (temporary paths, query-like POSTs, by-name handlers, client verbs) are `may`.

## Scores

`node bench/effects.mjs` scores the two checks against hand labels in `bench/effects/truth.json` on the servers in
`bench/effects/cases`: Wilson 95% intervals, the name-based checks on the same tools beside them, and every positive
the code check missed. The cases and the analyser were written together, so the score shows what the check does on the
idioms it was built for and on the traps in the cases; it does not estimate how often it is right on servers in the
wild. The main benchmark's `misleading-annotations` cases have stub handlers (`return "deleted"`), so they can show
that the analyser stays quiet there, not that it finds anything.

## In the loop

`corpus/scan-static.mjs` writes `raw/subject/code-effects.json` (the same block) only when the environment variable
`SCAN_STATIC_CODE_EFFECTS=1` is set for the run. It is not set by any workflow. `results/` and the grades are the same
with it on or off.
