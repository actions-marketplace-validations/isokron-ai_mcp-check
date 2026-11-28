# IsoKron MCP check

[![npm](https://img.shields.io/npm/v/@isokron/mcp-check)](https://www.npmjs.com/package/@isokron/mcp-check)
[![ci](https://github.com/isokron-ai/mcp-check/actions/workflows/ci.yml/badge.svg)](https://github.com/isokron-ai/mcp-check/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Grades an MCP server's `tools/list` against the MCP specification 2026-07-28, the Claude (Anthropic) and ChatGPT (OpenAI) directory rules, hidden-instruction patterns, schema quality and write-surface design. Every finding has a stable check ID, the source rule quoted verbatim, and a fix.

One engine, four ways to run it:

| | |
|---|---|
| **Web** | [isokron.ai/mcp-check](https://isokron.ai/mcp-check?utm_source=mcp-check-readme&utm_medium=readme): paste a tool list; it is graded in your browser and never uploaded. |
| **CLI** | `npx @isokron/mcp-check tools.json` with text, Markdown, JSON or SARIF output and a minimum-grade gate. |
| **GitHub Action** | `uses: isokron-ai/mcp-check@v1`: zero-config (reads your source, runs nothing), job summary, SARIF for code scanning, a gate, a README badge and an optional PR comment. |
| **MCP server** | `npx @isokron/mcp-check serve`: coding agents grade the server they are building. |

All four run the same file, [`engine/core.js`](engine/core.js), under the published [rubric](RUBRIC.md) (`rubric_version` 2.2.0). It reads only the JSON it is given: no network access, nothing stored.

## Command line

Requires Node.js 20 or later.

```sh
npx @isokron/mcp-check tools.json                      # grade a saved tools/list answer
npx @isokron/mcp-check tools.json --min-grade B        # exit 1 if a gated section is below B
npx @isokron/mcp-check tools.json --format sarif -o mcp-check.sarif
cat tools.json | npx @isokron/mcp-check --stdin --format md
```

Or point it at a server, a client config, a repository or a registry entry. A server is sent `initialize` and `tools/list` (every page) and nothing else; no tool is ever called.

```sh
npx @isokron/mcp-check --url https://mcp.example.com/mcp --header "Authorization: Bearer $TOKEN"
npx @isokron/mcp-check -- npx -y @modelcontextprotocol/server-everything
npx @isokron/mcp-check --command "uvx mcp-server-time" --env TZ=UTC
npx @isokron/mcp-check --config auto                     # every server your MCP clients run
npx @isokron/mcp-check --config .vscode/mcp.json --server github --min-grade B
npx @isokron/mcp-check --repo github.com/owner/repo      # reads the source, runs nothing
npx @isokron/mcp-check --repo-dir .                      # the same, from a local checkout (no network)
npx @isokron/mcp-check --registry io.github.owner/name --save tools.json
```

| Input | |
|---|---|
| `tools.json`, `-`, `--stdin` | A saved `tools/list` answer: a JSON-RPC answer, `{"tools": [...]}`, a bare array of tools, or an array of pages. |
| `--url` | A remote server over Streamable HTTP. Speaks both protocol eras: the 2026-07-28 stateless `tools/list` (no `initialize`) and the earlier `initialize` handshake with or without a session, JSON or SSE answers, with paging. `--header "Name: value"` (repeatable) may name environment variables (`$TOKEN`), so secrets stay out of shell history; header values are never printed, and with headers set a redirect is refused. `--protocol auto\|modern\|legacy`. |
| `-- <command>`, `--command` | A local server over stdio, started and stopped by the checker. `--env KEY=VALUE` adds environment variables. |
| `--config auto\|<file>` | Every server in an MCP client config: Claude Desktop, Claude Code (`.mcp.json`), Cursor, Windsurf, VS Code (`.vscode/mcp.json` with JSONC, `${env:X}` resolved, `${input:x}` reported), VS Code settings and Zed. `auto` reads the usual locations. `--server name` picks one. |
| `--repo` | A GitHub repository, read without running anything: committed tool lists and snapshots, MCPB manifests, tool literals, and TypeScript, Python, Go, Rust and C# SDK registrations reproduced as the SDK lists them (tool names held in constants, imports and enums, tool factories and classes, Python decorators, registries and low-level `Tool(...)`, FastMCP mount prefixes; Go: mark3labs/mcp-go `NewTool` and its options, the official go-sdk `AddTool` with schemas inferred from the handler's input struct and its `json` / `jsonschema` tags, mcp-golang `RegisterTool`, and helpers of the repository that build them; Rust: rmcp `#[tool]` methods and `ToolBase` impls with `Parameters<T>` schemas as schemars derives them, rust-mcp-sdk `#[mcp_tool]` structs, pmcp builders, and `Tool::new` or `json!` tool lists built by hand; C#: the official C# SDK's `[McpServerTool]` methods of `[McpServerToolType]` classes (or classes given to `WithTools<T>()`), with names, descriptions, titles, hints and input schemas built from the method's parameters as the SDK builds them; Go, Rust and C# schemas are exact for the current SDK versions and approximate for older ones, see the changelog). The report's `Source:` line names the provenance (`exact`, `literal`, `derived`). A schema, description or annotations the reader cannot work out statically (built at run time) are marked not readable and their checks are skipped, never graded as empty; the report counts them, and registrations whose name cannot be resolved (their text is still scanned for hidden instructions), and text the reader cannot place in a tool (a computed or very deeply nested value) is scanned as part of that tool. This applies only to a list read from source in the same run: the `x-mcp-check-unknown` marker that `--save` writes is not trusted on input, so a saved or live list is graded as given. A `--repo` scan that GitHub rate-limits or fails part of is not graded (exit 3). Grades of a list read from source (`literal`, `derived`) are **approximate**: the report says so, and `--command` or a saved list gives exact ones. A manifest with tool names only is not graded, and neither is a repository whose tools belong to more than one server (a monorepo): both exit 3 and name what to do (for a monorepo, the package folders to point at, `github.com/owner/repo/tree/<ref>/<folder>`). Go is read from its `.go` files (not `_test.go`, `testdata`, `vendor`, or `examples` at a module's root; a `//go:build` tag the default build does not set leaves a file out) and Rust from its `.rs` files (not `#[cfg(test)]` code or `tests`, `benches`, `examples`, `target`; a tool behind a Cargo feature that is not on by default is left out), and several servers in one Go module (`main` packages that each construct a server) or one crate (modules that each implement `ServerHandler`) are refused like a monorepo. C# is read from its `.cs` files (not `bin`, `obj` or test projects such as `*.Tests`); each `.csproj` folder is a package, so a repository of several C# servers is refused like a monorepo. With a subfolder (`…/tree/<ref>/<folder>`) only that folder's tree is listed, so a large repository's listing limit does not hide it. `--github-token-env NAME` for private repositories or rate limits. |
| `--repo-dir` | A folder on this machine, read the same way as `--repo`, with no network access and nothing run. Skips `node_modules`, `.git`, virtual environments, tests, examples, docs, evaluation harnesses, benchmarks, playgrounds and web sites; reads build output (`dist`, `build`, `out`) and `vendor` only when no source file defines a tool; does not follow symlinks; reads up to 1,500 source files of at most 1.5 MiB each, of which the first 400 whose text may define a tool are read for tools (the rest only lend their constants). Exit code 3 when it finds no list to grade (no tool definition, names only, or more than one server; point it at one package's folder). |
| `--registry` | An [MCP Registry](https://registry.modelcontextprotocol.io) entry: its public https remote, else its GitHub source. |

Every report of a fetched list carries a `Source:` line (and `source` in JSON). `--save file` keeps the fetched list for `--compare` or the web checker. `capture -- <command>` prints a stdio server's `tools/list` answer without grading it.

| Option | |
|---|---|
| `--format text\|md\|json\|sarif` | Output format (default `text`). JSON carries `rubric_version`, every finding, the safe-fix list and definition hashes. |
| `--min-grade A-F` | Exit 1 when a gated section grades below this. |
| `--sections a,b` | Sections to gate: `spec`, `anthropic`, `openai`, `security`, `quality`, `surface` (default `spec,anthropic,openai,security`). Every graded section is reported either way. `surface` has no grade and is never gated; selecting it adds its guard-coverage line to the text report. |
| `--code-effects`, `--code-effects-depth 0-6` | Experimental, with `--repo` or `--repo-dir`, off by default. Follows each tool's handler through the source (inline function, referenced function, class method, decorator, name switch; TypeScript, JavaScript and Python) and lists what it writes, deletes, sends over HTTP or runs, with file and line. Compares that with the declared hints in its own `code_effects` block: `annot-code-writes-marked-readonly`, `annot-code-deletes-marked-safe` and `annot-code-unmarked-write`. Never changes a grade or the exit code. A definite sink is attention at most; a client call whose effect is not visible is advice ("may write"). Method and limits: [docs/code-effects.md](docs/code-effects.md). |
| `--fix out.json` | Write the list with safe fixes applied: invisible characters stripped, root `type: "object"`, explicit hints, titles, `additionalProperties: false`. Inferred changes are listed for review. |
| `--compare old.json` | Diff by SHA-256 definition hash; exit 1 when an annotation change lets a client run a tool with less confirmation (for example `readOnlyHint` flipped to `true`). |
| `--sarif-uri path` | With `--format sarif`, the list's path in the repository, so each result points at the tool's line. |
| `--timeout seconds` | One overall limit for reaching a server and listing its tools (default 60). |
| `-o, --output file` | Write the report to a file. With a format other than `text`, the text summary also goes to stderr. |
| `-v, --version`, `-h, --help` | Print the version, or this list of inputs and options. |

Exit codes: `0` pass, `1` below `--min-grade` or a high-risk change, `2` bad input or usage, `3` a server could not be reached or listed, or the source gave no list to grade (no tool definitions, names only, or more than one server).

## GitHub Action

Zero-config: with no inputs, the Action reads the tool definitions from your repository's code, the same way `--repo-dir` does, and runs nothing.

```yaml
# .github/workflows/mcp-check.yml
name: MCP check
on:
  push:
  pull_request:
permissions:
  contents: read
jobs:
  mcp-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: isokron-ai/mcp-check@v1
```

> **Behaviour change in 1.1.1.** With neither `command` nor `tools-file`, a repository that gives nothing to grade (no tool definitions, names only, or more than one server) no longer fails the job: it ends with a warning, the `passed` output is empty, and with `pr-comment` on the comment says "not graded on this run". If your workflow relied on that red job, set `fail-on-no-tools: true`.

The job summary says the list was read from source and that its grades are **approximate**: the reader reproduces what your SDK registrations would list, and can miss or misread tools. It never fails the job on grades unless you set `min-grade` (a gate on approximate grades is at your own risk). When the source gives nothing to grade (for example a Swift server, which is not read yet, a manifest with names only, or a monorepo with several servers), the job ends with a warning and the fix, not red (`fail-on-no-tools: true` to fail it). For exact grades of the list your server sends, start it with `command` (or give a saved list with `tools-file`):

```yaml
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - run: npm ci && npm run build
      - uses: isokron-ai/mcp-check@v1
        with:
          command: node dist/index.js     # or: tools-file: tools.json
          min-grade: B
          pr-comment: auto                # needs permissions: pull-requests: write
```

The job summary shows the grade table and the blocking and attention findings with their docs links. The reports (`report.md`, `report.json`, `report.sarif`, and the captured `tools-list.json`) are uploaded as an artifact. Set `upload-sarif: true` (with `permissions: security-events: write`) to send the findings to code scanning, and `baseline:` to a committed tool list to fail on rug-pull annotation changes. With `pr-comment: auto` the Action comments on a pull request (one comment, updated in place, never on pull requests from forks) when a gated section falls below `min-grade`; `always` comments on every run. On a public repository the job summary ends with a link to get the server listed in the [IsoKron MCP registry (beta)](https://isokron.ai/mcp-check/registry?utm_source=mcp-check-readme&utm_medium=readme) for free (`publish-hint: false` to leave it out; no request is made).

### README badge

With `badge: true` the Action writes a [shields.io endpoint](https://shields.io/badges/endpoint-badge) file, `.github/mcp-check/badge.json`, and the full `report.md` beside it, and commits both on runs of the default branch when the grades or the tool list changed. The badge is served from your own repository; nothing is stored by IsoKron.

```yaml
permissions:
  contents: write
# ...
      - uses: isokron-ai/mcp-check@v1
        with:
          command: node dist/index.js
          badge: true
```

```markdown
[![MCP check](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/OWNER/REPO/main/.github/mcp-check/badge.json)](https://github.com/OWNER/REPO/blob/main/.github/mcp-check/report.md)
```

The badge reads, for example, `MCP check | Claude A · ChatGPT A · spec A`. The job summary prints the snippet with your owner, repository and branch filled in. `badge.json` also records the grades of every section, `rubric_version`, the date the grades were recorded, the catalog hash, the commit and the workflow run.

All inputs, outputs, permissions and security notes: [docs/github-action.md](docs/github-action.md).

## MCP server

Three read-only tools for agents that build or review MCP servers. The server speaks MCP over stdio.

**Claude Code**

```sh
claude mcp add mcp-check -- npx -y @isokron/mcp-check serve
```

**Claude Desktop** (`claude_desktop_config.json`), **Cursor** (`.cursor/mcp.json`) and other clients:

```json
{
  "mcpServers": {
    "mcp-check": { "command": "npx", "args": ["-y", "@isokron/mcp-check", "serve"] }
  }
}
```

| Tool | What it does |
|---|---|
| `check_tools_list` | Grades a `tools/list` answer. Arguments: `tools_list` (JSON text or value), optional `sections`, `min_grade`, `limit` (findings returned, default 100, max 500), `include_fixed_list` (default true). Returns a grade per section, the rubric version, findings (check ID, severity, tool, message, docs URL, fix, fix snippet), the list with safe fixes applied, and a SHA-256 hash per tool. |
| `explain_check` | Documentation for one check ID: severity, the source rule quoted verbatim, what it means, how to fix it, an example. |
| `compare_tools_lists` | Diffs two `tools/list` answers by definition hash and flags high-risk annotation changes. |

Every tool declares an `outputSchema` and returns `structuredContent` plus a short text summary. Annotations on all three: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`. Each list may be up to 2 MiB of JSON, 64 levels of nesting and 2,000 tools (the same limits apply in the CLI and the Action); larger inputs get an error naming the limit before anything is parsed. The server is also published to the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.isokron-ai/mcp-check`.

### Graded by itself

Output of `npm run dogfood`, which lists this server's own tools over MCP and grades them (`npm test` fails if this section goes stale):

| Section | Grade | Score | Blocking | Attention | Advice | Note |
|---|---|---|---|---|---|---|
| MCP spec 2026-07-28 | A | 100 | 0 | 0 | 0 | |
| Anthropic directory | A | 100 | 0 | 0 | 0 | |
| OpenAI directory | A | 100 | 0 | 0 | 0 | |
| Poisoning and hidden text | A | 100 | 0 | 0 | 0 | |
| Schema and description quality | A | 100 | 0 | 0 | 0 | |
| Write-surface design | no grade | | | | | Advice only, not graded. Every tool declares readOnlyHint: true or is named as a read, so there is no write surface. |

Rubric 2.2.0, 3 tools, catalog hash `3b6986dcdac856b5a8baaf4836be4c726f8076da7bca547fe4e186931cf02919`.

## What it checks

| Section | Graded against |
|---|---|
| MCP spec 2026-07-28 | The rules a tool list can decide: tool shape, `inputSchema` rooted at `type: "object"`, valid JSON Schema 2020-12 (Ajv), no remote `$ref`, composition bounds, name length, charset and uniqueness, every `x-mcp-header` rule, icon schemes, `_meta` keys, the `tools/list` envelope (`resultType`, `ttlMs`, `cacheScope`). Older protocol revisions are detected, and envelope rules become advice for them. |
| Anthropic directory | The connector pre-submission checklist: `title` on every tool, the applicable `readOnlyHint`/`destructiveHint`, names of 64 characters or fewer, read and write in separate tools, API docs for custom-query tools, descriptions, no conversation-data inputs, unsupported use cases. |
| OpenAI directory | The plugin guidelines: `readOnlyHint`, `destructiveHint` and `openWorldHint` as explicit booleans, annotations that match what the tool does, unique and plain names, no generic executors, no credential, OTP, password or precise-location inputs, retry behaviour stated. |
| Poisoning and hidden text | Every string and key of every tool: Unicode tag characters (hidden text decoded), bidi controls, zero-width and control characters, look-alike letters, HTML comments, prompt markup, instruction phrases, cross-tool steering, encoded blocks, outside instructions, secret seeking. |
| Schema and description quality | Argument descriptions, enums, `additionalProperties: false`, pagination, `response_format`, `outputSchema` on reads, specific argument names, "use this when" guidance, near-duplicate descriptions, namespacing. |
| Write-surface design | Guard coverage, not a grade: how many of the guards the write tools could offer they do offer (retry keys on creates, preconditions on updates and deletes, dry-run or confirm on deletes), plus advice on full replacements and bulk deletes. Below 3 guard opportunities it says there is not enough to judge. Left out of the text report's grade lines, badges and PR comments. |

Grades run A to F per graded section, from severity-weighted deductions with published bands and caps; the directory sections also carry a separate "ready" flag (no blocking item). The full method is in [RUBRIC.md](RUBRIC.md), and each check has a page at `https://isokron.ai/mcp-check/checks/<id>`.

Annotations are hints a client may rely on, not enforcement. A grade reports what the list declares; it does not test what the server does when a tool is called. For that, see the [MCP Write-Safety Requirements](https://github.com/isokron-ai/mcp-write-safety) and the [mcp-writecheck Action](https://github.com/isokron-ai/mcp-writecheck-action).

## Library

```js
import { analyse, parseInput, toMarkdown } from '@isokron/mcp-check';
const report = analyse(parseInput(jsonText));
console.log(report.sections.anthropic.grade, report.rubric_version);
```

CommonJS: `const M = require('@isokron/mcp-check')` loads the same engine. Also exported: `@isokron/mcp-check/capture` (read `tools/list` from a stdio server), `/tools` (the MCP tool handlers as plain functions), `/report` (SARIF locations, job-summary Markdown, badge file) and `/server` (`createServer()`).

## Versions

The package follows semantic versioning. The rubric has its own version, `rubric_version`, carried in every report, export and badge: a change to a weight, band, cap or severity bumps it, and grades from different rubric versions are not comparable. Release notes: [CHANGELOG.md](CHANGELOG.md).

## Privacy

The CLI, the library, the Action and the MCP server run on your machine or runner. They read the JSON they are given, or fetch the tool list themselves from the server, repository or registry you name (directly, from your machine: GitHub, jsDelivr or the MCP Registry for `--repo` and `--registry`; `--repo-dir` and the zero-config Action read local files only). Nothing is sent to IsoKron. The Action keeps its results on GitHub, in your repository and run: it uploads the reports as a workflow artifact, uploads SARIF to code scanning when `upload-sarif` is on, commits the badge files when `badge` is on, and writes a pull-request comment when `pr-comment` is on. The docs URLs in findings are links for you to open. Links to isokron.ai that the tools print (in `--help` and the text report, the job summary, the PR comment, SARIF help links, the badge's `report.md` and the MCP server's `websiteUrl`) carry a fixed channel tag, for example `utm_source=mcp-check-cli&utm_medium=cli`, so the site can count visits per channel. The tag names the place the link was printed and nothing about you, your server or the run; the `docs` values in JSON reports and in the MCP server's tool results carry no tag.

## Development

```sh
npm ci
npm test              # engine checks, catalogs, CLI, capture, MCP server over stdio, Action script, corpus grader
npm run dogfood       # grade this server's own tools/list
npm run vendor:verify # engine/ matches engine/VENDORED.json
```

The engine is the same file as the web checker; `engine/VENDORED.json` records its SHA-256. See [CONTRIBUTING.md](CONTRIBUTING.md) (contributions are accepted under the DCO) and [SECURITY.md](SECURITY.md).

### Reader QA on real repositories

The `--repo` source reader is checked against 95 public MCP server repositories at pinned commits (TypeScript, Python, Go, Rust and a few others), with the tool lists each server registers as ground truth. The targets, commits and tool names are in [`qa/`](qa/) (`targets.json`, `truth/`, `servers.json`); nothing else of a server is stored. A further 18 targets are held out: they measure whether the reader generalises, so they, their commits and their truth stay in a private harness and are not published (run the gate on the 95 only; a reader change is not to be fitted to a repository because it is in this list). The reader is static, so nothing of a target is cloned, installed, built or run.

The [`reader-qa`](.github/workflows/reader-qa.yml) workflow runs the build under test and the base build (the pull request's base commit, or `base_ref` on a manual dispatch, `main` by default) over the target set in four shards, scores the first against the truth and compares the two. It runs on `workflow_dispatch`, on pull requests that carry the label `reader-change`, and automatically on any pull request that changes `src/inputs/`, `qa/` or the workflow itself. It reads with the job's `GITHUB_TOKEN` (permissions `contents: read`, no secrets, `pull_request`, never `pull_request_target`) and retries a rate limit or a GitHub-side failure with a growing wait. One run at a time: a concurrency group keeps two runs from sharing the token's API budget. When the GitHub API refuses a listing the reader falls back to jsDelivr; the summary counts those targets and names them next to any byte difference.

The job summary shows precision and recall per language, the number of targets whose output is byte-identical to the base build, and every change. The run fails when:

- recall of default tools is below 0.8 for TypeScript, Python, Go or Rust;
- a graded list merges several servers of one repository, or silently picks one on a multi-server root;
- a names-only list is graded on schema or annotation checks;
- a run ends in an error or does not finish;
- a target regresses against the base build: a default tool lost, a phantom or wrong-server tool gained, or a graded list lost.

The reader's numbers on these 95 targets at `main`, for comparison, are in [`qa/reference.json`](qa/reference.json). To change the truth of one target, edit `qa/truth/<id>.json` and give the reason in the pull request. To run it locally, see the header of [`qa/run.mjs`](qa/run.mjs) and [`qa/score.mjs`](qa/score.mjs).

## Licence

MIT, Copyright (c) 2026 Stormhaven Enterprises LLC / IsoKron, Joshua Bryan. Third-party notices: [NOTICE](NOTICE).

Built by [IsoKron](https://isokron.ai/?utm_source=mcp-check-readme&utm_medium=readme), which audits and builds write-safe MCP servers.
