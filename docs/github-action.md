# The mcp-check GitHub Action

`uses: isokron-ai/mcp-check@v1` grades your MCP server's `tools/list` in CI: a grade table in the job summary, the reports as an artifact, optional SARIF upload to code scanning, a minimum-grade gate, a rug-pull check against a committed baseline, an optional README badge served from your own repository, and an optional comment on pull requests.

With no inputs at all it reads the tool definitions from your repository's code and runs nothing:

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

To pin both actions, replace each tag with the full commit SHA it points to (see [Security](#security)).

It is a composite action that runs the same engine as the CLI and the web checker, with the runner's Node.js (20 or later; GitHub-hosted runners have it, otherwise add `actions/setup-node` first). It installs nothing.

## Where the tool list comes from

Set one of these, or neither:

- **Neither (zero-config)**: the Action reads the tool definitions from the source in `working-directory` (default: the repository root), the same way `mcp-check --repo-dir` and `--repo` do, and runs nothing. **Grades of a list read from source are approximate**: the heading, the summary and the PR comment say "approximate: read from source, not the server's live list", and the output `approximate` is `true`. The job does not fail on grades unless you set `min-grade`; a gate on approximate grades is at your own risk, and the summary and log say so. For exact grades, set `command` or `tools-file`. Best first, it uses a committed tool list (`tools.json`, `tools-list.json`, `mcp-tools.json`, `__toolsnaps__/*.snap`, or an [mcp-catalog-snap](https://github.com/isokron-ai/mcp-catalog-snap) snapshot in `.mcp-catalog/`), an MCPB `manifest.json` with a static `tools/list`, tool objects written as literals, or SDK registrations (TypeScript `registerTool` and `server.tool` with zod, FastMCP `addTool`, helpers named like a tool call such as `scopedTool` or `defineTool`, tool factories, keyed tool tables and classes whose base class registers them, and same-file helpers that pass a name and config on to `registerTool`; Python `@mcp.tool` for the official SDK and the standalone `fastmcp`, project decorators and registry methods that register a tool, `mcp.tool(fn, name=…)`, and the low-level `Tool(name=…, inputSchema=…)`), converted the way the SDK version your manifests pin would list them. Tool names are read from literals, constants (also imported ones), enum members and `X.name`; tools of a FastMCP server mounted under a prefix carry it (`issues_get_issue`). A schema, description or annotations that cannot be worked out statically are marked not readable, and their checks are skipped rather than graded as empty; the summary and the PR comment count them. This applies only to the list read from source in this run, never to `tools-file` or `command` (a marker in such a list is ignored), and a schema that has properties is always graded. The job summary says the list was read from source and how exact it is (`exact`, `literal`, `derived`). When a committed list was used, the summary says so first: it was graded instead of the code and may be stale. The `baseline` file is never used as the list (and `baseline` may be an mcp-catalog-snap snapshot). An mcp-catalog-snap snapshot counts as this repository's list only when its `server.name` is this repository's server name (from `new McpServer({ name })`, `FastMCP("name")`, or the `package.json` / `pyproject.toml` name; compared without case, npm scope, or an `mcp-` / `-mcp` affix). A snapshot of another server is used only when the source defines no tool and it is the only snapshot, and the summary says so. A derived list can differ in detail from what your server sends, for example when the server post-processes its schemas or registers tools in a way the reader does not follow; set `command` or `tools-file` when you want the exact list.

  **When the source gives nothing to grade, the job ends neutral, not red**: a `::warning::` in the log, and a job summary headed "not graded" that says why and how to fix it, with exit status 0 (the `passed` output is empty). Set `fail-on-no-tools: true` to fail the job instead. That happens when:
  - no tool definition is found, for example in a C# server (the summary names the language: its source is not read yet);
  - the source is Go or Rust: the tool names and descriptions are read (mcp-go `NewTool`, the go-sdk's `mcp.Tool{Name: …}`, `MustTool`, rmcp `#[tool]`) and listed in the summary, but their schemas are not read yet, so nothing is graded;
  - a manifest lists only tool names, without schemas;
  - the tools belong to **more than one server**: two or more packages of a monorepo (folders with their own `package.json`, `pyproject.toml` or `setup.py`) that each construct a server (`new McpServer`, `new Server` from the SDK, `FastMCP(...)`) and have tools, or several committed tool lists at the same depth with none inside the server's package. Nothing is merged and nothing is picked: the summary lists the folders, server constructors first, and asks you to set `working-directory` to one of them (one job or matrix leg per server).

  A monorepo with one server is graded: a package with a constructor and no tools (a test stub) is dropped, a single package that only holds SDK registrations (its tool library) is graded with the one server (two or more such packages may be other servers, so nothing is graded), and packages with only bare tool literals and no server (a client's tool table) are set aside. Folders named `admin`, `console`, `docs`, `evals`, `examples`, `fixtures`, `tests`, `bench`, `benchmarks`, `e2e`, `playground`, `demo`, `samples`, `mocks`, `site` or `website`, and folders with such a word in their name (`docs-mcp`, `admin-mcp`) when another package constructs a server, are set aside and their tools listed as left out; point `working-directory` at one to grade it. Of several committed lists, the one nearest the root (or the only one inside the server's package) is used, and the summary names the others.

  What it reads: `.ts`, `.js`, `.mjs`, `.cjs`, `.py` sources and the JSON lists above, up to 1,500 source files (the likeliest tool files first) of at most 1.5 MiB each, of which the first 400 whose text may define a tool are read for tools and the rest only lend their constants, plus `package.json`, `package-lock.json`, `pyproject.toml` and `requirements*.txt` for the SDK version (also those at the workspace root when `working-directory` is a subfolder). It never enters `node_modules`, `.git`, virtual environments or caches, and does not follow symlinks. It lists at most 20,000 files: everything under `src`, `lib`, `server`, `servers`, `app`, `packages`, `mcp` and `.mcp-catalog` first, then the rest breadth first; when a folder holds more, the summary says so (set `working-directory` to the server's folder). Tests (`test`, `tests`, `__tests__`, `e2e`, `__mocks__`), examples, docs, fixtures, evaluation harnesses (`eval`, `evals`), benchmarks (`bench`, `benches`, `benchmark`, `benchmarks`), `playground`, `website`, `vendor`, and build output (`dist`, `build`, `out`) are skipped; build output and `vendor` are read only when no source file defines a tool. The results folder and any folder an earlier run of this Action made are skipped too. On SARIF, each finding points at the line that registers its tool.
- **`command`**: the command that starts your server over stdio, run in `working-directory`. The Action sends `initialize`, then `tools/list` (following `nextCursor` up to 100 pages), and stops the server. **No tool is called.** The command is split into words without a shell; set `shell: true` to run it through `bash -c` (pipes, `&&`, variables). The captured answer is saved as `tools-list.json` in the results folder.
- **`tools-file`**: a saved `tools/list` answer in the repository, for servers that need credentials or a backend to start, or for remote servers. Produce it with `npx @isokron/mcp-check capture -- <command>` or `npx @modelcontextprotocol/inspector --cli <command> --method tools/list`.

> **Behaviour change in 1.1.1.** With neither `command` nor `tools-file`, a repository that gives nothing to grade (no tool definitions, names only, or more than one server) no longer fails the job: it ends with a warning, the `passed` output is empty, and with `pr-comment` on the comment says "not graded on this run". If your workflow relied on that red job, set `fail-on-no-tools: true`.

## Inputs

| Input | Default | |
|---|---|---|
| `tools-file` | | Path of a saved `tools/list` answer (JSON-RPC answer, `{"tools": [...]}`, array of tools, or array of pages). |
| `command` | | Command that starts the server over stdio. |
| `shell` | `false` | Run `command` through `bash -c`. |
| `working-directory` | `.` | Folder `command` runs in, or, with neither `command` nor `tools-file`, the folder whose source is read. |
| `timeout` | `60` | One overall time limit, in seconds, for starting the server and reading `initialize` and every `tools/list` page (1 to 600). |
| `min-grade` | | `A` to `F`. The job fails when a section in `sections` grades below it. Empty: report only. With neither `command` nor `tools-file` the grades are approximate, and a gate on them is at your own risk. |
| `fail-on-no-tools` | `false` | With neither `command` nor `tools-file`: fail the job when the source gives nothing to grade (no tool definitions, names only, or more than one server). Default: a warning, an empty `passed`, and the job is not failed. |
| `sections` | `spec,anthropic,openai,security` | Sections the gate applies to: `spec`, `anthropic`, `openai`, `security`, `quality`, `surface`. The five graded sections are always reported. `surface` has no grade (rubric 2.2.0) and is never gated; selecting it adds its guard-coverage line under the grade table. |
| `baseline` | | Path of an earlier `tools/list` answer. The job fails on a high-risk annotation change: one that lets a client run a tool with less confirmation, such as `readOnlyHint` turning `true` or `destructiveHint` turning `false`. |
| `sarif` | `true` | Write `report.sarif`. Each result points at the tool's `"name"` line in the tool-list file. |
| `upload-sarif` | `false` | Upload `report.sarif` to code scanning (category `mcp-check`). Needs `security-events: write`. |
| `badge` | `false` | Write and commit the badge files (below). Needs `contents: write` and `actions/checkout` with its default `persist-credentials: true`. |
| `badge-dir` | `.github/mcp-check` | Folder of `badge.json` and `report.md`. |
| `results-dir` | `mcp-check-results` | Folder of the reports. |
| `artifact-name` | `mcp-check-results` | Name of the uploaded artifact; empty for none. Give each job of a matrix its own. |
| `publish-hint` | `true` | On a public repository on github.com, one line in the job summary (and the PR comment) linking to the repository's page in the IsoKron MCP registry. No request is made. `false` for no line. |
| `pr-comment` | `off` | `auto` or `always` to comment on pull requests from branches of the same repository (below). Needs `pull-requests: write`. |
| `pr-comment-key` | | When more than one job or matrix leg comments on the same pull request, give each its own key (for example `${{ matrix.server }}`); each key keeps its own comment. Empty: one comment per pull request. |
| `github-token` | `${{ github.token }}` | Token for the PR comment, used only by the step that writes it. |

Every path must be inside the workspace; a path that leads outside it, directly or through a symlink, is refused. Files are read and written only as regular files: a symlink, folder or device at any input or output path (`tools-file`, `baseline`, the files in `results-dir`, `badge.json` and `report.md` in `badge-dir`) is refused, and outputs are created without following links, so a branch cannot point a write elsewhere. `results-dir` must be new or empty, or a folder an earlier run of this action made (it holds a `.mcp-check-results` marker). A list over 2 MiB of JSON, 64 levels of nesting or 2,000 tools is refused with an error naming the limit.

## Outputs

`passed` (`true` or `false`; empty when nothing was graded), `source`, `approximate`, `grade-spec`, `grade-anthropic`, `grade-openai`, `grade-security`, `grade-quality`, `grade-surface` (always empty since rubric 2.2.0: the write surface is reported as guard coverage, not a grade), `catalog-hash`, `sarif-file`, `results-dir`.

`source` says where the list came from: `repo-static` (read from the source, nothing run), `command` or `tools-file`. `approximate` is `true` when the list was read from source code (`literal` or `derived`), `false` for a server, a saved list or an exact committed list.

The job status is set by the last step, after the reports, the SARIF upload and the badge commit, so a failing gate still leaves you the full report.

## Examples

Zero-config with a gate (on approximate grades read from source: at your own risk), a comment on pull requests that fall below it, and the findings in code scanning:

```yaml
permissions:
  contents: read
  pull-requests: write
  security-events: write
steps:
  - uses: actions/checkout@v7
    with:
      persist-credentials: false
  - uses: isokron-ai/mcp-check@v1
    with:
      min-grade: B
      pr-comment: auto
      upload-sarif: true
```

A server in a subfolder of a monorepo:

```yaml
  - uses: isokron-ai/mcp-check@v1
    with:
      working-directory: packages/mcp-server
```

Gate a pull request on the live list of a server your build produces, and keep the findings in code scanning:

```yaml
permissions:
  contents: read
  security-events: write
steps:
  - uses: actions/checkout@v7
  - uses: actions/setup-node@v7
    with:
      node-version: 22
  - run: npm ci && npm run build
  - uses: isokron-ai/mcp-check@v1
    with:
      command: node dist/index.js
      min-grade: B
      upload-sarif: true
```

A server that needs a backend or credentials to start: commit its tool list and grade the file, and fail when an annotation is loosened compared with the released list:

```yaml
  - uses: isokron-ai/mcp-check@v1
    with:
      tools-file: tools.json
      baseline: release/tools.json
      min-grade: A
      sections: spec,anthropic,openai,security,quality
```

A Python server:

```yaml
  - uses: astral-sh/setup-uv@v7
  - uses: isokron-ai/mcp-check@v1
    with:
      command: uv run my-mcp-server
```

## The registry line

With `publish-hint: true` (the default), on a public repository on github.com, the job summary ends with one line linking to `https://isokron.ai/mcp-check/registry/<owner>/<repo>`, where the repository can be listed in the IsoKron MCP registry (beta) for free, with a public page of its grades and a README badge. The Action makes no request for it: it is a link, built from `GITHUB_REPOSITORY`. Private repositories, GitHub Enterprise Server, and events whose payload does not say the repository is public (for example `schedule`) get no line. Set `publish-hint: false` to leave it out. Listing is your choice: nothing is listed until you submit the repository.

## The pull-request comment

With `pr-comment: auto` or `always`, on `pull_request` runs the Action writes one comment on the pull request and updates that same comment on every later run (it is found by a hidden `<!-- isokron-mcp-check -->` marker). It holds the grade table, the gate result, a high-risk annotation change if the baseline comparison found one, the first five blocking and attention findings with links to their check pages, and the registry line.

- `always`: comment on every pull request run.
- `auto`: comment only when a gated section is below `min-grade` or the baseline comparison finds a high-risk change. If an earlier run left a comment, it is updated when the problem is fixed, so a stale warning does not stay up. Without `min-grade` or `baseline`, `auto` never comments.
- `off` (default): no comment.

Several jobs, or the legs of a matrix, that comment on the same pull request each need their own `pr-comment-key` (for example `pr-comment-key: ${{ matrix.server }}`); otherwise they share, and overwrite, one comment.

The job needs `permissions: pull-requests: write`. Pull requests from forks are skipped, and the job summary says so: their token cannot write comments, and this Action does not support `pull_request_target`. The token is passed only to the step that writes the comment, never to the step that may start your server. That step reads the pull request from the event payload and the comment from the results folder, runs with a clean environment and the `node` found before your code ran, posts only a body written by the grading step of the same run and attempt, and edits only a comment written by the token's own account (for the default token, `github-actions[bot]`); a marker comment by anyone else is left alone and a new one is made. If commenting fails (for example the permission is missing), the run logs a warning and the job result is unchanged.

## The README badge

With `badge: true`, on `push`, `schedule` and `workflow_dispatch` runs of the default branch, the Action writes two files into `badge-dir` and commits them as `github-actions[bot]` with `[skip ci]`, only when the grades, the rubric version or the tool list changed:

- `badge.json`: a [shields.io endpoint](https://shields.io/badges/endpoint-badge) file. shields.io reads `label`, `message` and `color`; the other keys record what the badge stands for:

  ```json
  {
    "schemaVersion": 1,
    "label": "MCP check",
    "message": "Claude A · ChatGPT A · spec A",
    "color": "brightgreen",
    "cacheSeconds": 3600,
    "rubric_version": "2.2.0",
    "date": "2026-11-18",
    "grades": { "spec": "A", "anthropic": "A", "openai": "A", "security": "A", "quality": "B" },
    "catalog_hash": "…",
    "commit": "…",
    "report": "https://github.com/OWNER/REPO/blob/main/.github/mcp-check/report.md",
    "run": "https://github.com/OWNER/REPO/actions/runs/…"
  }
  ```

  `date` is the day these grades were recorded; a run with the same grades and tool list leaves the file, and its date, unchanged. The badge colour follows the lower of the two directory grades.

- `report.md`: the full report (grades, every finding with its docs link, write-surface guard coverage and rows, definition hashes), headed by the commit and the workflow run, with a link that opens the same list in the web checker. The list travels in that link's fragment, which browsers do not send to any server.

Add the badge to your README (the job summary prints this with your names filled in):

```markdown
[![MCP check](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/OWNER/REPO/main/.github/mcp-check/badge.json)](https://github.com/OWNER/REPO/blob/main/.github/mcp-check/report.md)
```

The badge and the report live in your repository, so nothing depends on storage at IsoKron, and anyone can see from the commit history when a grade changed.

If the default branch is protected against pushes from Actions, the commit step fails with a clear error. Either allow `github-actions[bot]` to push to it, or run the badge job on a schedule and let a pull-request bot of your choice carry the change.

## Security

- The server's stderr is shown in the log inside a `::stop-commands::` fence, so workflow commands it prints are not run.
- The Action needs no secret. Give the job only the permissions the features you turn on need: `contents: read` by default, `contents: write` for `badge`, `security-events: write` for `upload-sarif`, `pull-requests: write` for `pr-comment`.
- With neither `command` nor `tools-file`, nothing from the repository is run: the source is read as text.
- `command` runs your server's code on the runner with the job's environment, minus the files that set later steps' environment, PATH, outputs and summary (`GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_OUTPUT`, `GITHUB_STATE`, `GITHUB_STEP_SUMMARY`). Code that runs on the runner can still affect the rest of the job, so the comment step's precautions above narrow what it can do with the token; they are not a sandbox. It is the same code your tests run, but do not run this Action on `pull_request_target` or `workflow_run` with a server built from an untrusted pull request.
- Inputs reach the script as environment variables, never by interpolation into a shell command. The third-party actions it uses (`actions/upload-artifact`, `github/codeql-action/upload-sarif`) are pinned by commit SHA.
- To pin this Action itself, use a full commit SHA instead of `@v1`.
- The Action sends nothing to IsoKron. The links to isokron.ai it writes carry a fixed channel tag in their query (`utm_source=mcp-check-action` in the job summary, `mcp-check-pr-comment` in the PR comment, `mcp-check-badge` in the committed `report.md`, `mcp-check-sarif` in SARIF help links), which says where the link was shown and nothing about your repository, server or run. The registry line names your repository in its path, because that is the address of its page. The reports in the artifact (`report.md`, `report.json`) carry no tag.
