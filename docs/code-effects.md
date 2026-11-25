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
| `fs` | `fs`/`fs/promises`/`fs-extra` write, append, mkdir, copy, rename, truncate, chmod; unlink, rm, rmdir, remove; file handles opened here; `promisify(fs.x)` and `const { x } = fs` aliases; Deno and Bun. Python `open(path, mode)` with a write mode, `os.remove/rename/mkdir/...`, `shutil.rmtree/move/copy...`, `pathlib` write and unlink. Housekeeping is `may`: any directory creation; a path with a log, audit, metrics, state, cache, lock, pid, history, journal, telemetry, trace, tmp or temp word in it (snake_case, dotted or camelCase; "status" is not "state"); an append to a file the tool's arguments do not name. |
| `sql` | A string handed to a call (not a logger, `print` or an error) that starts with INSERT, UPDATE ... SET, DELETE FROM, DROP, TRUNCATE, ALTER, CREATE, MERGE or REPLACE INTO; a tagged template; a variable assigned such a string in the handler or at module level. SELECT is a read. A write-shaped string that no call receives is `may`. |
| `orm` | prisma create/update/delete/upsert; Mongo `insertOne`, `updateOne`, `deleteMany` and the like; Sequelize `destroy`, `save`; Drizzle and Knex when the file uses them; SQLAlchemy `session.add/delete/merge`, `commit` (`may` alone); Django `objects.create/update/delete`; `.delete()` and `.save()` in a file that uses a known ORM; Redis writes and deletes. |
| `http` | `fetch`, `axios`, `got`, `ky`, `requests`, `httpx`, `aiohttp`, clients made by `axios.create`, `httpx.Client`, `requests.Session`, `aiohttp.ClientSession`, with their method. GET is a read. DELETE is `definite` (and fills `delete`). POST, PUT and PATCH are `may` on their own, because GraphQL, JSON-RPC, search, login and many vendor APIs send reads that way; they are `definite` only when the call itself shows a write: a GraphQL `mutation` written in it, or a URL ending in `/create`, `/delete`, `/remove`, `/destroy`, `/send`, `/publish`, `/upload`, `/refund`, `/cancel`, `/revoke` or `/purge`. A method that is not a literal is `may`. |
| `exec` | `child_process` exec/spawn/execFile/fork, `execa`; Python `subprocess`, `os.system`, `os.popen`, asyncio subprocesses. A literal command that is known to be read-only (`ls`, `cat`, `git status`, `git log`, `kubectl get`, ...) is a read; anything else, a command built from arguments included, is `exec`. Python `exec` and `eval` are `may`. |
| `sdk` | A method on a client-like object named like a write: `client.issues.create`, `stripe.charges.refund`, `bucket.delete`. Always `may`, because what the remote service does is not visible. Calls to such objects with other names are `unknown_call`. |

## Confidence tiers

- **definite**: the write is certain on the handler's unconditional path, and its target comes from the tool's
  arguments (see below): a sink call on the straight-line path of the
  handler or of a resolved callee that is itself called on that path, with the kind visible in the code (a method, a
  path, a SQL string). Reachability is not modelled, so a sink inside an `if`/`else`, a loop, a `switch`, a `catch` or
  `finally` (Python: `if`/`elif`/`else`/`for`/`while`/`except`/`finally`/`match`), a callback, a ternary or the right
  side of `&&`/`||`/`??`/`and`/`or` is `may`, and so is everything below a call made there. A plain `try` body, a
  `with` block and the executor of `new Promise(...)` are on the path.
- **may**: an opaque client call, a method that is not a literal, a POST, PUT or PATCH without a visible write, a
  housekeeping file or directory, a sink on a conditional path, a SQL string that no call receives, a handler found only
  by its function name, an import that could not be resolved. Messages for a `may` say "reaches a possible write (HTTP
  POST at file:line)"; the definite wording ("reaches ...") is used for `definite` only.

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

## Where the target comes from

A file or HTTP sink is `definite` only when its target (the path, the URL or the body, or the id in them) is derived
from the tool's arguments by data flow: a handler parameter, a variable assigned from an expression that uses one,
a destructured parameter, a loop variable over one, a parameter of a repository function that is called with one
(positionally or by keyword). A constant or server-internal target (a string literal, a path built from `__dirname`,
`cwd` or a module-level constant, a fixed URL) is `may`, with the note "the target does not come from the tool's
arguments". That covers a server evicting its own session, rewriting its own cache or clearing a fixed folder. A
SQL or ORM write follows the same rule: definite only when an argument reaches the statement (a bound parameter, a
`where` value, a chained `.run(id)`); a write on a fixed table with constants only is `may`. The flow is by name and
within one function and its callees: it does not model aliasing, objects stored and read later, or values returned
from other functions.

## Annotations the reader could not read

A tool whose annotations the reader could not read (a call that builds them, a spread of something unknown) is marked
`annotations: unreadable` in the block and gets no finding: unknown is not "not declared". A constant in the same file
that holds the annotations is read.

## Time budget

The analysis stops after 20 seconds per repository (`timeBudgetMs`); tools not reached have `status: time_budget`, the
one in progress is marked `truncated` and gets no "no sink found", and the summary says `time_budget_hit`.

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
  sink on the unconditional path, and the guesses (housekeeping files, POST/PUT/PATCH, conditional paths, by-name handlers, client verbs) are `may`.

## Scores

`node bench/effects.mjs` scores the two checks against hand labels in `bench/effects/truth.json` on the servers in
`bench/effects/cases`: Wilson 95% intervals, the name-based checks on the same tools beside them, and every positive
the code check missed. The cases and the analyser were written together, so the score shows what the check does on the
idioms it was built for and on the traps in the cases; it does not estimate how often it is right on servers in the
wild. The main benchmark's `misleading-annotations` cases have stub handlers (`return "deleted"`), so they can show
that the analyser stays quiet there, not that it finds anything.

## In the loop

`corpus/scan-static.mjs` writes `raw/subject/code-effects.json` (the same block) only when the environment variable
`SCAN_STATIC_CODE_EFFECTS=1` is set for the run. It is not set by any workflow. Until real-repository QA is done, every
finding in that file is capped at `advice` (`max_severity: advice`): attention exists only on the CLI flag path. `results/` and the grades are the same
with it on or off.
