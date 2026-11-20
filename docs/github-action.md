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

- **Neither (zero-config)**: the Action reads the tool definitions from the source in `working-directory` (default: the repository root), the same way `mcp-check --repo-dir` and `--repo` do, and runs nothing. Best first, it uses a committed tool list (`tools.json`, `tools-list.json`, `mcp-tools.json`, `__toolsnaps__/*.snap`, or an [mcp-catalog-snap](https://github.com/isokron-ai/mcp-catalog-snap) snapshot in `.mcp-catalog/`), an MCPB `manifest.json` with a static `tools/list`, tool objects written as literals, or SDK registrations (TypeScript `registerTool` and `server.tool` with zod, FastMCP `addTool`, Python `@mcp.tool` for the official SDK and the standalone `fastmcp`, and same-file helpers that pass a name and config on to `registerTool`), converted the way the SDK version your manifests pin would list them. The job summary says the list was read from source and how exact it is (`exact`, `literal`, `derived`). When a committed list was used, the summary says so first: it was graded instead of the code and may be stale. The `baseline` file is never used as the list (and `baseline` may be an mcp-catalog-snap snapshot). A manifest that lists only tool names, without schemas, is not graded: the job fails and asks for `command` or `tools-file`. A derived list can differ in detail from what your server sends, for example when the server post-processes its schemas; set `command` or `tools-file` when you want the exact list. When no tool definition is found, the job fails with a message saying to set one of them.

  What it reads: `.ts`, `.js`, `.mjs`, `.cjs`, `.py` sources and the JSON lists above, up to 60 source files (the likeliest tool files first) of at most 1.5 MiB each, plus `package.json`, `package-lock.json`, `pyproject.toml` and `requirements*.txt` for the SDK version (also those at the workspace root when `working-directory` is a subfolder). It never enters `node_modules`, `.git`, virtual environments or caches, and does not follow symlinks. It lists at most 20,000 files: everything under `src`, `lib`, `server`, `servers`, `app`, `packages`, `mcp` and `.mcp-catalog` first, then the rest breadth first; when a folder holds more, the summary says so (set `working-directory` to the server's folder). Tests (`test`, `tests`, `__tests__`), examples, docs, fixtures, `vendor`, and build output (`dist`, `build`, `out`) are skipped; build output and `vendor` are read only when no source file defines a tool. The results folder and any folder an earlier run of this Action made are skipped too. On SARIF, each finding points at the line that registers its tool.
- **`command`**: the command that starts your server over stdio, run in `working-directory`. The Action sends `initialize`, then `tools/list` (following `nextCursor` up to 100 pages), and stops the server. **No tool is called.** The command is split into words without a shell; set `shell: true` to run it through `bash -c` (pipes, `&&`, variables). The captured answer is saved as `tools-list.json` in the results folder.
- **`tools-file`**: a saved `tools/list` answer in the repository, for servers that need credentials or a backend to start, or for remote servers. Produce it with `npx @isokron/mcp-check capture -- <command>` or `npx @modelcontextprotocol/inspector --cli <command> --method tools/list`.

## Inputs

| Input | Default | |
|---|---|---|
| `tools-file` | | Path of a saved `tools/list` answer (JSON-RPC answer, `{"tools": [...]}`, array of tools, or array of pages). |
| `command` | | Command that starts the server over stdio. |
| `shell` | `false` | Run `command` through `bash -c`. |
| `working-directory` | `.` | Folder `command` runs in, or, with neither `command` nor `tools-file`, the folder whose source is read. |
| `timeout` | `60` | One overall time limit, in seconds, for starting the server and reading `initialize` and every `tools/list` page (1 to 600). |
| `min-grade` | | `A` to `F`. The job fails when a section in `sections` grades below it. Empty: report only. |
| `sections` | `spec,anthropic,openai,security` | Sections the gate applies to: `spec`, `anthropic`, `openai`, `security`, `quality`, `surface`. All six are always reported. |
| `baseline` | | Path of an earlier `tools/list` answer. The job fails on a high-risk annotation change: one that lets a client run a tool with less confirmation, such as `readOnlyHint` turning `true` or `destructiveHint` turning `false`. |
| `sarif` | `true` | Write `report.sarif`. Each result points at the tool's `"name"` line in the tool-list file. |
| `upload-sarif` | `false` | Upload `report.sarif` to code scanning (category `mcp-check`). Needs `security-events: write`. |
| `badge` | `false` | Write and commit the badge files (below). Needs `contents: write` and `actions/checkout` with its default `persist-credentials: true`. |
| `badge-dir` | `.github/mcp-check` | Folder of `badge.json` and `report.md`. |
| `results-dir` | `mcp-check-results` | Folder of the reports. |
| `artifact-name` | `mcp-check-results` | Name of the uploaded artifact; empty for none. Give each job of a matrix its own. |
| `publish-hint` | `true` | On a public repository on github.com, one line in the job summary (and the PR comment) linking to the repository's page in the IsoKron MCP registry. No request is made. `false` for no line. |
| `pr-comment` | `off` | `auto` or `always` to comment on pull requests from branches of the same repository (below). Needs `pull-requests: write`. |
| `github-token` | `${{ github.token }}` | Token for the PR comment, used only by the step that writes it. |

Every path must be inside the workspace; a path that leads outside it, directly or through a symlink, is refused. Files are read and written only as regular files: a symlink, folder or device at any input or output path (`tools-file`, `baseline`, the files in `results-dir`, `badge.json` and `report.md` in `badge-dir`) is refused, and outputs are created without following links, so a branch cannot point a write elsewhere. `results-dir` must be new or empty, or a folder an earlier run of this action made (it holds a `.mcp-check-results` marker). A list over 2 MiB of JSON, 64 levels of nesting or 2,000 tools is refused with an error naming the limit.

## Outputs

`passed` (`true` or `false`), `source`, `grade-spec`, `grade-anthropic`, `grade-openai`, `grade-security`, `grade-quality`, `grade-surface` (empty when there is no write tool), `catalog-hash`, `sarif-file`, `results-dir`.

`source` says where the list came from: `repo-static` (read from the source, nothing run), `command` or `tools-file`.

The job status is set by the last step, after the reports, the SARIF upload and the badge commit, so a failing gate still leaves you the full report.

## Examples

Zero-config with a gate, a comment on pull requests that fall below it, and the findings in code scanning:

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

With `publish-hint: true` (the default), on a public repository on github.com, the job summary ends with one line linking to `https://isokron.ai/mcp-check/registry/<owner>/<repo>`, where the repository can be listed in the IsoKron MCP registry for free, with its CI-verified grade and a README badge. The Action makes no request for it: it is a link, built from `GITHUB_REPOSITORY`. Private repositories, GitHub Enterprise Server, and events whose payload does not say the repository is public (for example `schedule`) get no line. Set `publish-hint: false` to leave it out. Listing is your choice: nothing is listed until you submit the repository.

## The pull-request comment

With `pr-comment: auto` or `always`, on `pull_request` runs the Action writes one comment on the pull request and updates that same comment on every later run (it is found by a hidden `<!-- isokron-mcp-check -->` marker). It holds the grade table, the gate result, a high-risk annotation change if the baseline comparison found one, the first five blocking and attention findings with links to their check pages, and the registry line.

- `always`: comment on every pull request run.
- `auto`: comment only when a gated section is below `min-grade` or the baseline comparison finds a high-risk change. If an earlier run left a comment, it is updated when the problem is fixed, so a stale warning does not stay up. Without `min-grade` or `baseline`, `auto` never comments.
- `off` (default): no comment.

The job needs `permissions: pull-requests: write`. Pull requests from forks are skipped, and the job summary says so: their token cannot write comments, and this Action does not support `pull_request_target`. The token is passed only to the step that writes the comment, never to the step that may start your server. That step reads the pull request from the event payload and the comment from the results folder, runs with a clean environment and the `node` found before your code ran, and edits only a comment written by the token's own account (for the default token, `github-actions[bot]`); a marker comment by anyone else is left alone and a new one is made. If commenting fails (for example the permission is missing), the run logs a warning and the job result is unchanged.

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
    "rubric_version": "2.1.0",
    "date": "2026-11-18",
    "grades": { "spec": "A", "anthropic": "A", "openai": "A", "security": "A", "quality": "B", "surface": null },
    "catalog_hash": "…",
    "commit": "…",
    "report": "https://github.com/OWNER/REPO/blob/main/.github/mcp-check/report.md",
    "run": "https://github.com/OWNER/REPO/actions/runs/…"
  }
  ```

  `date` is the day these grades were recorded; a run with the same grades and tool list leaves the file, and its date, unchanged. The badge colour follows the lower of the two directory grades.

- `report.md`: the full report (grades, every finding with its docs link, write-surface rows, definition hashes), headed by the commit and the workflow run, with a link that opens the same list in the web checker. The list travels in that link's fragment, which browsers do not send to any server.

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
