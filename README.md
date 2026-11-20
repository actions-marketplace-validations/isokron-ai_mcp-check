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

All four run the same file, [`engine/core.js`](engine/core.js), under the published [rubric](RUBRIC.md) (`rubric_version` 2.1.0). It reads only the JSON it is given: no network access, nothing stored.

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
| `--repo` | A GitHub repository, read without running anything: committed tool lists and snapshots, MCPB manifests, tool literals, and TypeScript and Python SDK registrations reproduced as the SDK lists them. The report's `Source:` line names the provenance (`exact`, `literal`, `derived` or `names only`). `--github-token-env NAME` for private repositories or rate limits. |
| `--repo-dir` | A folder on this machine, read the same way as `--repo`, with no network access and nothing run. Skips `node_modules`, `.git`, virtual environments, tests, examples and docs; reads build output (`dist`, `build`, `out`) and `vendor` only when no source file defines a tool; does not follow symlinks; up to 60 source files of at most 1.5 MiB each. Exit code 3 when no tool definition is found. |
| `--registry` | An [MCP Registry](https://registry.modelcontextprotocol.io) entry: its public https remote, else its GitHub source. |

Every report of a fetched list carries a `Source:` line (and `source` in JSON). `--save file` keeps the fetched list for `--compare` or the web checker. `capture -- <command>` prints a stdio server's `tools/list` answer without grading it.

| Option | |
|---|---|
| `--format text\|md\|json\|sarif` | Output format (default `text`). JSON carries `rubric_version`, every finding, the safe-fix list and definition hashes. |
| `--min-grade A-F` | Exit 1 when a gated section grades below this. |
| `--sections a,b` | Sections to gate: `spec`, `anthropic`, `openai`, `security`, `quality`, `surface` (default `spec,anthropic,openai,security`). Every section is reported either way. |
| `--fix out.json` | Write the list with safe fixes applied: invisible characters stripped, root `type: "object"`, explicit hints, titles, `additionalProperties: false`. Inferred changes are listed for review. |
| `--compare old.json` | Diff by SHA-256 definition hash; exit 1 when an annotation change lets a client run a tool with less confirmation (for example `readOnlyHint` flipped to `true`). |
| `--sarif-uri path` | With `--format sarif`, the list's path in the repository, so each result points at the tool's line. |
| `--timeout seconds` | One overall limit for reaching a server and listing its tools (default 60). |
| `-o, --output file` | Write the report to a file. With a format other than `text`, the text summary also goes to stderr. |
| `-v, --version`, `-h, --help` | Print the version, or this list of inputs and options. |

Exit codes: `0` pass, `1` below `--min-grade` or a high-risk change, `2` bad input or usage, `3` a server could not be reached or listed, or no tool definitions were found in the source.

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

The job summary says the list was read from source and how exact it is. For the exact list your server sends, start it with `command` (or give a saved list with `tools-file`):

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

The job summary shows the grade table and the blocking and attention findings with their docs links. The reports (`report.md`, `report.json`, `report.sarif`, and the captured `tools-list.json`) are uploaded as an artifact. Set `upload-sarif: true` (with `permissions: security-events: write`) to send the findings to code scanning, and `baseline:` to a committed tool list to fail on rug-pull annotation changes. With `pr-comment: auto` the Action comments on a pull request (one comment, updated in place, never on pull requests from forks) when a gated section falls below `min-grade`; `always` comments on every run. On a public repository the job summary ends with a link to list the server in the [IsoKron MCP registry](https://isokron.ai/mcp-check/registry?utm_source=mcp-check-readme&utm_medium=readme) for free (`publish-hint: false` to leave it out; no request is made).

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
| Write-surface design | not graded | | | | | Every tool declares readOnlyHint: true or is named as a read, so there is no write surface to grade. |

Rubric 2.1.0, 3 tools, catalog hash `32462a67c35adecf5cbfe5c9e738a8efe69cc87afcc50f497ba2d23fb8de36b7`.

## What it checks

| Section | Graded against |
|---|---|
| MCP spec 2026-07-28 | The rules a tool list can decide: tool shape, `inputSchema` rooted at `type: "object"`, valid JSON Schema 2020-12 (Ajv), no remote `$ref`, composition bounds, name length, charset and uniqueness, every `x-mcp-header` rule, icon schemes, `_meta` keys, the `tools/list` envelope (`resultType`, `ttlMs`, `cacheScope`). Older protocol revisions are detected, and envelope rules become advice for them. |
| Anthropic directory | The connector pre-submission checklist: `title` on every tool, the applicable `readOnlyHint`/`destructiveHint`, names of 64 characters or fewer, read and write in separate tools, API docs for custom-query tools, descriptions, no conversation-data inputs, unsupported use cases. |
| OpenAI directory | The plugin guidelines: `readOnlyHint`, `destructiveHint` and `openWorldHint` as explicit booleans, annotations that match what the tool does, unique and plain names, no generic executors, no credential, OTP, password or precise-location inputs, retry behaviour stated. |
| Poisoning and hidden text | Every string and key of every tool: Unicode tag characters (hidden text decoded), bidi controls, zero-width and control characters, look-alike letters, HTML comments, prompt markup, instruction phrases, cross-tool steering, encoded blocks, outside instructions, secret seeking. |
| Schema and description quality | Argument descriptions, enums, `additionalProperties: false`, pagination, `response_format`, `outputSchema` on reads, specific argument names, "use this when" guidance, near-duplicate descriptions, namespacing. |
| Write-surface design | For write tools: retry keys on creates, version guards on updates and deletes, dry-run on deletes, guarded bulk deletes. Not graded for read-only servers. |

Grades run A to F per section, from severity-weighted deductions with published bands and caps; the directory sections also carry a separate "ready" flag (no blocking item). The full method is in [RUBRIC.md](RUBRIC.md), and each check has a page at `https://isokron.ai/mcp-check/checks/<id>`.

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

## Licence

MIT, Copyright (c) 2026 Stormhaven Enterprises LLC / IsoKron, Joshua Bryan. Third-party notices: [NOTICE](NOTICE).

Built by [IsoKron](https://isokron.ai/?utm_source=mcp-check-readme&utm_medium=readme), which audits and builds write-safe MCP servers.
